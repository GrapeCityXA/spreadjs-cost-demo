const { readLocalSpreadjsLicense } = require('../config/localSpreadjsLicense.cjs');
const { withBasePath } = require('../config/basePath');
const jwt = require('jsonwebtoken');
const { touchActivity } = require('./showcaseActivity');
const db = require('../config/database');
const { JWT_SECRET } = require('../middleware/auth');
const { Server } = require('@grapecity-software/js-collaboration');
const OT = require('@grapecity-software/js-collaboration-ot');
const { SqliteDb } = require('@grapecity-software/js-collaboration-ot-sqlite');
const { type } = require('@grapecity-software/spread-sheets-collaboration');
const { authorizeChangeSet } = require('./changeSetAuthorization');
const { departmentCodesFor } = require('./permissionIdentity');
const { compilePermissionIndex } = require('./permissionIndex');
const { loadQuarterlyDependencies, quarterlyConfiguration } = require('./quarterlyDependencies');
const { buildQuarterlyWorkbook, scopeQuarterlySpreadJsonWorkbook, isQuarterlyReferenceTemplate } = require('./quarterlyWorkbook');
const { taskResponsibilitiesForUser, hasTaskAssignment } = require('./taskAssignments');

const COLLABORATION_VERSION = '19.2.0';
const MILESTONE_INTERVAL = 100;
// The 19.1.4 MessageActions enum assigns 2 to fetchHistorySnapshot.
const FETCH_HISTORY_SNAPSHOT_ACTION = 2;
const assignmentRoles = {
  filler: ['subsidiary_filler'],
  submitter: ['subsidiary_submitter'],
  department_reviewer: ['department_reviewer'],
  scorer: ['score_editor'],
  approver: ['management'],
  finalizer: ['report_finalizer']
};

const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const run = (connection, sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));

class SqliteMilestoneDb {
  constructor(connection) {
    this.connection = connection;
    this.interval = MILESTONE_INTERVAL;
  }

  async saveMilestoneSnapshot(snapshot) {
    await run(this.connection, `INSERT INTO collaboration_milestones (doc_id, version, snapshot_json)
      VALUES (?, ?, ?) ON CONFLICT(doc_id, version) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
    [snapshot.id, snapshot.v, JSON.stringify(snapshot)]);
    return true;
  }

  async getMilestoneSnapshot(id, version) {
    const row = await get(this.connection, `SELECT snapshot_json FROM collaboration_milestones
      WHERE doc_id = ? AND version <= ? ORDER BY version DESC LIMIT 1`, [id, version]);
    return row ? JSON.parse(row.snapshot_json) : null;
  }
}

async function activeUser(userId) {
  const user = await get(db, `SELECT id, username, name, organization_id, account_status, permissions
    FROM users WHERE id = ?`, [userId]);
  if (!user || user.account_status !== 'active') return null;
  const roles = await all(db, `SELECT role_code AS code, organization_id AS organizationId FROM effective_user_roles
    WHERE user_id = ? AND effective_from <= CURRENT_TIMESTAMP
      AND (effective_to IS NULL OR effective_to > CURRENT_TIMESTAMP)`, [userId]);
  return { ...user, roles, departmentCodes: await departmentCodesFor({ ...user, roles }),
    permissions: JSON.parse(user.permissions || '[]') };
}

async function roomForKey(roomKey) {
  return get(db, `SELECT cr.*, t.organization_id, t.package_id, t.task_status, t.template_version_id, t.current_revision_id,
      t.period_code, t.configuration_snapshot_json, rt.cadence
    FROM collaboration_rooms cr JOIN report_tasks t ON t.id = cr.task_id JOIN report_types rt ON rt.id = t.report_type_id
    WHERE cr.collaboration_room_key = ?`, [roomKey]);
}

function roleInScope(user, codes, organizationId) {
  return user.roles.some(role => codes.includes(role.code)
    && (role.organizationId == null || Number(role.organizationId) === Number(organizationId)));
}

async function canAccessRoom(user, room) {
  if (!room || !user) return false;
  if (roleInScope(user, ['system_admin', 'management'], room.organization_id)) return true;
  if (!roleInScope(user, ['subsidiary_filler', 'subsidiary_submitter', 'department_reviewer', 'score_editor', 'report_finalizer'], room.organization_id)) return false;
  const assignments = await taskResponsibilitiesForUser(db, room.task_id ?? room.id, user.id);
  return assignments.some(assignment => roleInScope(user, assignmentRoles[assignment.responsibility] || [], room.organization_id));
}

function tokenUser(connection) {
  const token = connection?.auth?.token;
  if (typeof token !== 'string' || token.length > 8192) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return Number.isInteger(Number(payload.id)) ? Number(payload.id) : null;
  } catch {
    return null;
  }
}

let runtime;
const activeConnections = new Map();

async function attach(httpServer) {
  if (runtime) return runtime;
  await db.ready;
  OT.TypesManager.register(type);
  const adapter = new SqliteDb(db.collaborationDb);
  const documentServices = new OT.DocumentServices({
    db: adapter,
    milestoneDb: new SqliteMilestoneDb(db.collaborationDb),
    submitSnapshotBatchSize: MILESTONE_INTERVAL
  });
  const server = new Server({
    httpServer,
    path: withBasePath('/collaboration/'),
    cors: { origin: process.env.COST_REPORT_COLLAB_ORIGINS?.split(',').map(origin => origin.trim()) || true },
    maxHttpBufferSize: 10 * 1024 * 1024,
    maxDecompressedMessageSize: 10 * 1024 * 1024
  });
  server.on('connect', ({ connection, roomId }) => {
    touchActivity();
    const userId = connection?.tags.get('user')?.id;
    // Track every live room connection, including one whose user tag is not
    // available yet, so an idle cleanup cannot reset an open editing session.
    activeConnections.set(connection.id, { roomId, userId: userId == null ? null : Number(userId) });
  });
  server.on('disconnect', ({ connection }) => { activeConnections.delete(connection?.id); touchActivity(); });
  const keys = readLocalSpreadjsLicense();
  if (!keys.spreadjsLICENSE || !keys.serverLICENSE) {
    throw new Error('缺少 SPREADJS_LICENSE / SERVER_LICENSE 环境变量，协同服务无法启动');
  }
  server.licenseKey = keys.spreadjsLICENSE;
  server.serverLicenseKey = keys.serverLICENSE;

  server.use('connect', async ({ connection, roomId }, next) => {
    try {
      const userId = tokenUser(connection);
      const user = userId == null ? null : await activeUser(userId);
      const room = await roomForKey(roomId);
      if (!user || !room || room.room_status === 'closed' || !(await canAccessRoom(user, room))) {
        return next('无权加入此协作房间');
      }
      if (room.cadence === 'quarterly') {
        const template = await get(db, 'SELECT manifest_json, workbook_json FROM template_versions WHERE id = ?', [room.template_version_id]);
        const manifest = JSON.parse(template?.manifest_json || '{}');
        if (isQuarterlyReferenceTemplate(manifest)) {
          const configuration = quarterlyConfiguration(JSON.parse(room.configuration_snapshot_json || '{}'));
          const liveDocument = await documentServices.fetch(room.collaboration_room_key);
          if (liveDocument?.data) {
            const scopedData = scopeQuarterlySpreadJsonWorkbook(liveDocument.data, JSON.parse(template.workbook_json || '{}'),
              room.organization_id, configuration.referenceCompanySheets, true);
            if (JSON.stringify(scopedData) !== JSON.stringify(liveDocument.data)) {
              return next('协作房间包含超出组织映射的历史数据，请重新生成业务修订');
            }
          }
        }
      }
      connection.tags.set('user', { id: user.id, username: user.username, name: user.name,
        organizationId: user.organization_id, roles: user.roles, permissions: user.permissions });
      await next();
    } catch {
      await next('协作身份验证失败');
    }
  });

  documentServices.use('receive', async ({ request, connection }, next) => {
    const requestsHistoricalData = request.a === FETCH_HISTORY_SNAPSHOT_ACTION;
    if (!request.restore && !requestsHistoricalData) return next();
    if (request.restore) return next('历史恢复必须创建新的业务修订，不能覆盖当前协作房间');
    try {
      const room = await roomForKey(connection?.roomId);
      const userId = connection?.tags.get('user')?.id;
      const user = userId == null ? null : await activeUser(userId);
      if (!room || !user || !(await canAccessRoom(user, room))) return next('无权访问此协作房间');
      if (!roleInScope(user, ['system_admin'], room.organization_id)) {
        return next('只有系统管理员可以查看协作历史');
      }
      return next();
    } catch {
      return next('协作历史请求授权失败');
    }
  });

  documentServices.use('submit', async ({ request, connection }, next) => {
    try {
      const room = await roomForKey(request.id);
      const userId = connection?.tags.get('user')?.id;
      const user = userId == null ? null : await activeUser(userId);
      if (!room || !user || !(await canAccessRoom(user, room))) return next('无权编辑此协作房间');
      if (room.room_status !== 'open') return next('协作房间已冻结或关闭');
      if (room.task_status !== 'draft') return next('当前任务状态不允许填报');
      if (request.restore) return next('历史恢复必须创建新的业务修订，不能覆盖当前协作房间');
      const template = await get(db, 'SELECT manifest_json, workbook_json FROM template_versions WHERE id = ?', [room.template_version_id]);
      if (!template) return next('已发布模板不可用');
      const manifest = JSON.parse(template.manifest_json || '{}');
      const requiresReferenceCompanyScope = isQuarterlyReferenceTemplate(manifest);
      let workbook = JSON.parse(template.workbook_json || '{}');
      const operation = request.op;
      if (room.cadence === 'quarterly') {
        const configuration = quarterlyConfiguration(JSON.parse(room.configuration_snapshot_json || '{}'));
        const dependencies = operation?.create ? await loadQuarterlyDependencies({ taskId: room.task_id,
          organizationId: room.organization_id, periodCode: room.period_code, configuration }) : null;
        workbook = buildQuarterlyWorkbook(workbook, configuration.indicators || [], dependencies, {
          organizationId: room.organization_id, referenceCompanySheets: configuration.referenceCompanySheets,
          requiresReferenceCompanyScope
        });
        manifest.permissionIndex = compilePermissionIndex(workbook);
      }
      if (manifest.permissionIndex?.version !== 1 || !Array.isArray(manifest.permissionIndex.sheets)) {
        return next('已发布模板缺少权限索引');
      }
      if (!operation || operation.del) return next('删除协作文档未获授权');
      if (!roleInScope(user, ['system_admin', 'subsidiary_filler'], room.organization_id)
        || !(await hasTaskAssignment(db, room.task_id, user.id, 'filler'))) return next('当前用户没有填报编辑责任');
      if (operation.create) {
        // This demo accepts the client-generated initial snapshot as-is. The
        // browser's SpreadJS snapshot can legitimately serialize rich-text
        // values as objects ({ value, richText, text }) while the published
        // contract stores the same cell as a scalar value. Running the strict
        // publication comparison here would reject equivalent workbooks before
        // the collaboration room is created. Subsequent change-set and submit
        // authorization remains enabled.
      } else {
        const snapshot = await documentServices.fetch(request.id);
        const error = authorizeChangeSet(operation.op, snapshot?.data, manifest.permissionIndex, user, room.organization_id);
        if (error) return next(error);
      }
      await next();
    } catch {
      await next('协作操作授权失败');
    }
  });

  documentServices.use('afterWrite', async (context, next) => {
    await next();
    const request = context.request;
    const room = await roomForKey(request.id);
    if (!room) return;
    const document = await get(db.collaborationDb, 'SELECT version, snapshot_version FROM documents WHERE id = ?', [request.id]);
    if (!document) return;
    const actorId = context.connection?.tags.get('user')?.id;
    if (actorId != null && request.op?.v != null) {
      const collabRoom = await get(db.collaborationDb, 'SELECT id FROM collaboration_rooms WHERE room_key = ?', [request.id]);
      if (collabRoom) await run(db.collaborationDb, `INSERT INTO collaboration_operations (room_id, version, actor_user_id, operation_json)
        VALUES (?, ?, ?, ?) ON CONFLICT(room_id, version) DO UPDATE SET actor_user_id = excluded.actor_user_id,
          operation_json = excluded.operation_json`, [collabRoom.id, request.op.v, actorId, JSON.stringify(request.op)]);
    }
    const snapshotReference = `${request.id}@${document.snapshot_version}`;
    await run(db, `UPDATE collaboration_rooms SET latest_version = ?, snapshot_reference = ? WHERE id = ?`,
      [document.version, snapshotReference, room.id]);
    await run(db.collaborationDb, `UPDATE collaboration_rooms SET current_version = ? WHERE room_key = ?`,
      [document.version, request.id]);
    if (request.op?.create || document.snapshot_version > 0 && document.snapshot_version === document.version) {
      const snapshot = await documentServices.fetch(request.id);
      const collabRoom = await get(db.collaborationDb, 'SELECT id FROM collaboration_rooms WHERE room_key = ?', [request.id]);
      if (snapshot) await documentServices.milestoneDb.saveMilestoneSnapshot({ ...snapshot, v: document.snapshot_version });
      if (collabRoom && snapshot) await run(db.collaborationDb, `INSERT INTO collaboration_snapshots (room_id, version, snapshot_json)
        VALUES (?, ?, ?) ON CONFLICT(room_id, version) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
      [collabRoom.id, document.snapshot_version, JSON.stringify(snapshot)]);
    }
  });

  server.useFeature(OT.documentFeature(documentServices));
  server.useFeature(require('@grapecity-software/js-collaboration-presence').presenceFeature());
  runtime = { server, documentServices, adapter, collaborationVersion: COLLABORATION_VERSION };
  return runtime;
}

async function getRuntime() {
  if (!runtime) throw new Error('协作服务尚未启动');
  return runtime;
}

function isUserConnected(roomKey, userId) {
  return [...activeConnections.values()].some(connection => connection.roomId === roomKey && connection.userId === Number(userId));
}

function activeConnectionCount() {
  return activeConnections.size;
}

module.exports = { attach, getRuntime, canAccessRoom, activeUser, roomForKey, isUserConnected, activeConnectionCount,
  collaborationVersion: COLLABORATION_VERSION };
