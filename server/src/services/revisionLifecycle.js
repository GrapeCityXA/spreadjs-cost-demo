const fs = require('node:fs/promises');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const db = require('../config/database');
const storage = require('../config/storage');
const { recordBusinessAudit } = require('./businessAudit');
const { copyRevisionAttachments } = require('./evidenceAttachments');
const { hasTaskAssignment } = require('./taskAssignments');

const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const run = (connection, sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const fail = (message, status) => Object.assign(new Error(message), { status });

function roleInScope(actor, roleCode, organizationId) {
  return (actor.roles || []).some(role => role.code === roleCode
    && (role.organizationId == null || Number(role.organizationId) === Number(organizationId)));
}

function normalizeShanghaiDeadline(value) {
  const input = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(input)) return null;
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) return null;
  return `${new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 19)}+08:00`;
}

async function beginConnection() {
  await db.ready;
  const connection = new sqlite3.Database(storage.getDatabasePath());
  connection.configure('busyTimeout', 10000);
  await run(connection, 'PRAGMA foreign_keys = ON');
  await run(connection, 'PRAGMA busy_timeout = 10000');
  await run(connection, 'ATTACH DATABASE ? AS lifecycle_collab', [storage.getCollaborationDatabasePath()]);
  await run(connection, 'BEGIN IMMEDIATE');
  return connection;
}

async function currentTask(connection, taskId) {
  const task = await get(connection, `SELECT t.*, p.template_version_id, cr.id AS room_id,
      cr.collaboration_room_key, cr.room_status, cr.latest_version
    FROM report_tasks t JOIN period_packages p ON p.id = t.package_id
    JOIN collaboration_rooms cr ON cr.task_id = t.id
      AND cr.revision_number = (SELECT MAX(next.revision_number) FROM collaboration_rooms next WHERE next.task_id = t.id)
    WHERE t.id = ?`, [taskId]);
  if (!task) throw fail('填报任务不存在', 404);
  const revision = task.current_revision_id == null ? null : await get(connection,
    'SELECT * FROM business_revisions WHERE id = ? AND task_id = ?', [task.current_revision_id, task.id]);
  if (!revision || revision.revision_status !== 'submitted') throw fail('当前任务没有可处理的已提交修订', 409);
  return { task, revision };
}

async function assertAssignment(connection, task, actor, responsibility, roleCode) {
  const assignment = await hasTaskAssignment(connection, task, actor.id, responsibility);
  const reviewerRole = responsibility === 'department_reviewer' ? await get(connection, `SELECT 1 AS allowed
    FROM effective_user_roles ur LEFT JOIN organizations scoped_org ON scoped_org.id = ur.organization_id
    JOIN users u ON u.id = ur.user_id
    WHERE ur.user_id = ? AND ur.role_code = ? AND ur.effective_from <= CURRENT_TIMESTAMP
      AND (ur.effective_to IS NULL OR ur.effective_to > CURRENT_TIMESTAMP)
      AND (ur.organization_id IS NULL OR ur.organization_id = ?
        OR (scoped_org.organization_type = 'department' AND scoped_org.id = u.organization_id)) LIMIT 1`,
  [actor.id, roleCode, task.organization_id]) : roleInScope(actor, roleCode, task.organization_id);
  if (!assignment || !reviewerRole) {
    throw fail(responsibility === 'submitter' ? '当前用户没有此任务的提交责任' : '当前用户没有此任务的部门审核责任', 403);
  }
}

async function reviewDepartmentCode(connection, actor, task) {
  const department = await get(connection, `SELECT department.code FROM users
    JOIN organizations department ON department.id = users.organization_id
    WHERE users.id = ? AND department.organization_type = 'department' AND department.status = 'active'`, [actor.id]);
  if (department) return department.code;
  const organization = await get(connection, 'SELECT code FROM organizations WHERE id = ?', [task.organization_id]);
  return organization?.code || '';
}

async function loadSeedWorkbook(connection, sourceRevisionId) {
  const artifact = await get(connection, `SELECT a.storage_key FROM official_artifacts a
    JOIN business_revisions r ON r.id = a.revision_id
    WHERE r.id = ? AND a.artifact_type = 'spreadjs_workbook_json'`, [sourceRevisionId]);
  if (!artifact?.storage_key) throw fail('原提交修订缺少静态工作簿，无法创建更正草稿', 409);
  const absolutePath = path.resolve(artifact.storage_key);
  const workbook = JSON.parse(await fs.readFile(absolutePath, 'utf8'));
  if (!workbook || typeof workbook !== 'object') throw fail('原提交工作簿格式无效', 409);
  return { workbook, storageKey: absolutePath };
}

async function createDraftRevision(connection, task, sourceRevision, actor, eventType, reason, deadline) {
  const { workbook } = await loadSeedWorkbook(connection, sourceRevision.id);
  const nextBusinessNumber = Number((await get(connection, `SELECT COALESCE(MAX(revision_number), 0) AS number
    FROM business_revisions WHERE task_id = ?`, [task.id])).number) + 1;
  const nextRoomNumber = Number((await get(connection, `SELECT COALESCE(MAX(revision_number), 0) AS number
    FROM collaboration_rooms WHERE task_id = ?`, [task.id])).number) + 1;
  const roomKey = `report-task-${task.id}-revision-${nextRoomNumber}`;
  const room = await run(connection, `INSERT INTO collaboration_rooms
    (task_id, revision_number, collaboration_room_key, collaboration_db, room_status, latest_version, snapshot_reference)
    VALUES (?, ?, ?, ?, 'open', 0, ?)`, [task.id, nextRoomNumber, roomKey,
    storage.getCollaborationDatabasePath(), `${roomKey}@0`]);
  await run(connection, `INSERT INTO lifecycle_collab.collaboration_rooms
    (room_key, task_id, revision_number, room_status, current_version) VALUES (?, ?, ?, 'open', 0)`,
  [roomKey, task.id, nextRoomNumber]);
  const collabRoom = await get(connection, 'SELECT id FROM lifecycle_collab.collaboration_rooms WHERE room_key = ?', [roomKey]);
  await run(connection, `INSERT INTO lifecycle_collab.collaboration_snapshots (room_id, version, snapshot_json)
    VALUES (?, 0, ?)`, [collabRoom.id, JSON.stringify(workbook)]);
  const draft = await run(connection, `INSERT INTO business_revisions
    (task_id, revision_number, revision_status, collaboration_room_id, source_revision_id)
  VALUES (?, ?, 'draft', ?, ?)`, [task.id, nextBusinessNumber, room.lastID, sourceRevision.id]);

  if (eventType === 'returned') {
    await run(connection, `UPDATE adjustment_requests SET proposed_revision_id = ?, status = 'draft'
      WHERE task_id = ? AND proposed_revision_id = ? AND status = 'department_review'`,
    [draft.lastID, task.id, sourceRevision.id]);
  }

  await run(connection, `UPDATE collaboration_rooms SET room_status = 'closed', closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP)
    WHERE id = ?`, [task.room_id]);
  await run(connection, `UPDATE lifecycle_collab.collaboration_rooms SET room_status = 'closed' WHERE room_key = ?`, [task.collaboration_room_key]);
  await run(connection, `UPDATE report_tasks SET task_status = 'draft', current_revision_id = ? WHERE id = ?`, [draft.lastID, task.id]);
  await run(connection, `INSERT INTO report_task_events
    (task_id, revision_id, event_type, actor_user_id, reason, remediation_deadline, from_status, to_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`, [task.id, sourceRevision.id, eventType, actor.id, reason, deadline,
    task.task_status]);
  await run(connection, `INSERT INTO report_task_events
    (task_id, revision_id, event_type, actor_user_id, reason, remediation_deadline, from_status, to_status)
    VALUES (?, ?, 'draft_created', ?, ?, ?, ?, 'draft')`, [task.id, draft.lastID, actor.id, reason, deadline,
    eventType === 'withdrawn' ? 'withdrawn' : 'returned']);
  await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
    action: `business_revision.${eventType}`, objectType: 'business_revision', objectId: sourceRevision.id,
    businessVersion: String(sourceRevision.revision_number), before: { taskStatus: task.task_status },
    after: { taskId: task.id, draftRevisionId: draft.lastID, draftRevisionNumber: nextBusinessNumber, roomKey },
    reason, requestId: null });
  const copiedAttachmentPaths = await copyRevisionAttachments(connection, task.id, sourceRevision.id, draft.lastID);
  return { taskId: Number(task.id), sourceRevisionId: Number(sourceRevision.id), revisionId: draft.lastID,
    revisionNumber: nextBusinessNumber, roomId: room.lastID, roomKey, status: 'draft', copiedAttachmentPaths };
}

async function runLifecycle({ taskId, actor, reason, remediationDeadline, action, disposition, expectedVersion, reviewItemKey = 'monthly:submission' }) {
  if (!Number.isSafeInteger(Number(taskId)) || Number(taskId) < 1) throw fail('任务编号无效', 400);
  const cleanReason = String(reason || '').trim();
  if (action === 'withdraw' && (!cleanReason || cleanReason.length > 1000)) throw fail('撤回原因不能为空且不能超过 1000 个字符', 400);
  if (action === 'review' && !cleanReason) throw fail('审核意见不能为空', 400);
  if (action === 'review' && !['accept', 'comment', 'return'].includes(disposition)) throw fail('审核处理类型无效', 400);
  if (action === 'review' && (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 0)) {
    throw fail('审核版本无效，请刷新审核资料后重试', 400);
  }
  if (action === 'review' && (typeof reviewItemKey !== 'string' || !/^[a-z0-9:_-]{1,80}$/i.test(reviewItemKey))) {
    throw fail('审核事项编号无效', 400);
  }
  let deadline = null;
  if (action === 'review' && disposition === 'return') {
    deadline = normalizeShanghaiDeadline(remediationDeadline);
    if (!deadline || String(remediationDeadline).length > 80) throw fail('退回必须填写有效的上海时区整改期限', 400);
  }
  const connection = await beginConnection();
  let copiedAttachmentPaths = [];
  try {
    const { task, revision } = await currentTask(connection, Number(taskId));
    if (action === 'withdraw') {
      await assertAssignment(connection, task, actor, 'submitter', 'subsidiary_submitter');
      if (!['submitted', 'reviewing'].includes(task.task_status)) throw fail('仅在审核意见保存前可以撤回', 409);
      const opinions = await get(connection, 'SELECT COUNT(*) AS count FROM review_opinions WHERE revision_id = ?', [revision.id]);
      if (Number(opinions.count) > 0) throw fail('已有审核意见，不能撤回', 409);
      const result = await createDraftRevision(connection, task, revision, actor, 'withdrawn', cleanReason, null);
      copiedAttachmentPaths = result.copiedAttachmentPaths || [];
      await run(connection, 'COMMIT');
      delete result.copiedAttachmentPaths;
      return result;
    }

    await assertAssignment(connection, task, actor, 'department_reviewer', 'department_reviewer');
    if (!['submitted', 'reviewing'].includes(task.task_status)) throw fail('当前任务不处于可审核状态', 409);
    const departmentCode = await reviewDepartmentCode(connection, actor, task);
    const adjustmentState = await get(connection, `SELECT id, required_departments_json, status FROM adjustment_requests
      WHERE task_id = ? AND proposed_revision_id = ?`, [task.id, revision.id]);
    if (adjustmentState && adjustmentState.status !== 'department_review') {
      throw fail('此调整已进入管理审批或已结束，部门审核意见已锁定', 409);
    }
    const adjustment = adjustmentState;
    if (adjustment && !JSON.parse(adjustment.required_departments_json || '[]').includes(departmentCode)) {
      throw fail('当前部门不属于本次调整的必需审核范围', 403);
    }
    const existingItem = await get(connection, `SELECT version FROM review_opinion_items
      WHERE revision_id = ? AND review_item_key = ? AND department_code = ?`, [revision.id, reviewItemKey, departmentCode]);
    const currentVersion = Number(existingItem?.version || 0);
    if (currentVersion !== Number(expectedVersion)) throw fail('该审核事项已被更新，请刷新后再提交意见', 409);
    const nextVersion = currentVersion + 1;
    if (existingItem) {
      const changed = await run(connection, `UPDATE review_opinion_items SET reviewer_id = ?, opinion = ?,
        disposition = ?, version = ?, updated_at = CURRENT_TIMESTAMP
        WHERE revision_id = ? AND review_item_key = ? AND department_code = ? AND version = ?`,
      [actor.id, cleanReason.slice(0, 2000), disposition, nextVersion, revision.id, reviewItemKey, departmentCode, currentVersion]);
      if (changed.changes !== 1) throw fail('该审核事项已被更新，请刷新后再提交意见', 409);
    } else {
      await run(connection, `INSERT INTO review_opinion_items
        (revision_id, review_item_key, department_code, reviewer_id, opinion, disposition, version)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [revision.id, reviewItemKey, departmentCode, actor.id, cleanReason.slice(0, 2000), disposition, nextVersion]);
    }
    await run(connection, `INSERT INTO review_opinions
      (revision_id, reviewer_id, department_code, opinion, disposition, remediation_deadline)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(revision_id, reviewer_id, department_code) DO UPDATE SET opinion = excluded.opinion,
        disposition = excluded.disposition, remediation_deadline = excluded.remediation_deadline`,
    [revision.id, actor.id, departmentCode, cleanReason.slice(0, 2000), disposition, deadline]);
    if (adjustment && disposition !== 'return') {
      const requiredDepartments = JSON.parse(adjustment.required_departments_json || '[]');
      const completed = await all(connection, `SELECT DISTINCT department_code AS code FROM review_opinion_items
        WHERE revision_id = ? AND review_item_key = 'monthly:submission' AND disposition IN ('accept','comment')`, [revision.id]);
      const completedCodes = new Set(completed.map(row => row.code));
      if (requiredDepartments.every(code => completedCodes.has(code))) {
        await run(connection, `UPDATE adjustment_requests SET status = 'management_approval'
          WHERE id = ? AND status = 'department_review'`, [adjustment.id]);
      }
    }
    if (disposition === 'return') {
      const result = await createDraftRevision(connection, task, revision, actor, 'returned', cleanReason, deadline);
      copiedAttachmentPaths = result.copiedAttachmentPaths || [];
      await run(connection, 'COMMIT');
      delete result.copiedAttachmentPaths;
      return { ...result, disposition, remediationDeadline: deadline, reviewItemKey, reviewVersion: nextVersion, departmentCode };
    }
    await run(connection, `UPDATE report_tasks SET task_status = 'reviewing' WHERE id = ?`, [task.id]);
    await run(connection, `INSERT INTO report_task_events
      (task_id, revision_id, event_type, actor_user_id, reason, from_status, to_status)
      VALUES (?, ?, 'reviewing', ?, ?, ?, 'reviewing')`, [task.id, revision.id, actor.id, cleanReason, task.task_status]);
    await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
      action: 'business_revision.review_opinion', objectType: 'business_revision', objectId: revision.id,
      businessVersion: String(revision.revision_number), before: { taskStatus: task.task_status },
      after: { disposition }, reason: cleanReason });
    await run(connection, 'COMMIT');
    return { taskId: Number(task.id), revisionId: Number(revision.id), revisionNumber: Number(revision.revision_number),
      status: 'reviewing', disposition, reviewItemKey, reviewVersion: nextVersion, departmentCode };
  } catch (error) {
    await run(connection, 'ROLLBACK').catch(() => {});
    await Promise.all(copiedAttachmentPaths.map(file => fs.rm(file, { force: true }).catch(() => {})));
    throw error;
  } finally {
    await new Promise(resolve => connection.close(() => resolve()));
  }
}

async function saveAnomalyDisposition({ taskId, anomalyId, actor, disposition }) {
  if (!Number.isSafeInteger(Number(taskId)) || Number(taskId) < 1
    || !Number.isSafeInteger(Number(anomalyId)) || Number(anomalyId) < 1) throw fail('任务或异常编号无效', 400);
  if (!['accepted', 'correction_requested'].includes(disposition)) throw fail('异常处理类型无效', 400);
  const connection = await beginConnection();
  try {
    const { task, revision } = await currentTask(connection, Number(taskId));
    if (!['submitted', 'reviewing'].includes(task.task_status)) throw fail('当前任务不处于可审核状态', 409);
    await assertAssignment(connection, task, actor, 'department_reviewer', 'department_reviewer');
    const anomaly = await get(connection, `SELECT id, explanation, disposition FROM anomaly_snapshots
      WHERE id = ? AND revision_id = ? AND severity = 'warning'`, [Number(anomalyId), revision.id]);
    if (!anomaly) throw fail('异常记录不存在或不属于当前提交修订', 404);
    if (!String(anomaly.explanation || '').trim()) throw fail('异常缺少填报说明，不能进行审核处置', 409);
    await run(connection, `UPDATE anomaly_snapshots SET disposition = ?, reviewer_id = ? WHERE id = ? AND revision_id = ?`,
      [disposition, actor.id, anomaly.id, revision.id]);
    await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
      action: 'anomaly_snapshot.disposition', objectType: 'anomaly_snapshot', objectId: anomaly.id,
      businessVersion: String(revision.revision_number), before: { disposition: anomaly.disposition },
      after: { disposition, revisionId: revision.id }, reason: disposition });
    await run(connection, 'COMMIT');
    return { taskId: Number(task.id), revisionId: Number(revision.id), anomalyId: Number(anomaly.id), disposition };
  } catch (error) {
    await run(connection, 'ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await new Promise(resolve => connection.close(() => resolve()));
  }
}

module.exports = {
  withdrawBusinessRevision: options => runLifecycle({ ...options, action: 'withdraw' }),
  saveReviewOpinion: options => runLifecycle({ ...options, action: 'review' }),
  saveAnomalyDisposition
};
