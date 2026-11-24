const db = require('../config/database');

const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

async function recordBusinessAudit({ connection = db, actor = null, organizationId = null, action, objectType, objectId = null,
  businessVersion = null, before = null, after = null, reason = null, outcome = 'success', requestId = null }) {
  await new Promise((resolve, reject) => connection.run(`INSERT INTO business_audit_events
    (actor_user_id, actor_organization_id, organization_id, action, object_type, object_id,
     business_version, before_summary_json, after_summary_json, reason, outcome, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    actor?.id ?? null, actor?.organizationId ?? null, organizationId ?? null, action, objectType,
    objectId == null ? null : String(objectId), businessVersion, json(before), json(after), reason || null,
    outcome, requestId
  ], error => error ? reject(error) : resolve()));
}

function actionForRequest(req) {
  const parts = (req.originalUrl || `${req.baseUrl || ''}${req.path}`).split('?')[0].split('/').filter(Boolean);
  const adminIndex = parts.lastIndexOf('admin');
  const collection = parts[adminIndex + 1] || 'admin';
  const objectType = collection === 'organizations' ? 'organization' : collection === 'users' ? 'user'
    : collection === 'fields' ? 'field_definition' : collection === 'drafts' ? 'field_draft' : collection === 'roles' ? 'role' : 'admin';
  const resourceAction = parts[adminIndex + 3];
  const objectId = parts[adminIndex + 2] || null;
  if (collection === 'users' && resourceAction === 'reset-password') return { action: 'user.password.reset', objectType, objectId };
  if (collection === 'users' && resourceAction === 'roles') return { action: 'user.roles.replace', objectType, objectId };
  if (collection === 'drafts' && ['approve', 'reject'].includes(resourceAction)) return { action: `field_draft.${resourceAction}`, objectType, objectId };
  if (collection === 'fields' && resourceAction === 'supersede') return { action: 'field_definition.supersede', objectType, objectId };
  const suffix = resourceAction ? `.${resourceAction.replace(/-/g, '.')}` : '';
  const verb = ({ GET: 'read', POST: 'create', PATCH: 'update', PUT: 'update', DELETE: 'delete' })[req.method] || 'request';
  return { action: `${objectType}.${verb}${suffix}`, objectType, objectId };
}

function recordRejectedAdminRequest(req, res, next) {
  const sendJson = res.json.bind(res);
  let auditStarted = false;
  res.json = payload => {
    if (res.statusCode < 400 || auditStarted) return sendJson(payload);
    auditStarted = true;
    const { action, objectType, objectId } = actionForRequest(req);
    const outcome = res.statusCode === 401 || res.statusCode === 403 ? 'denied' : 'failed';
    const persistThenRespond = async () => {
      const current = objectId == null ? null : await get(`SELECT MAX(CAST(business_version AS INTEGER)) AS version
        FROM business_audit_events WHERE object_type = ? AND object_id = ? AND outcome = 'success'`, [objectType, objectId]);
      await recordBusinessAudit({
        actor: req.user || null,
        organizationId: req.user?.organizationId ?? null,
        action,
        objectType,
        objectId,
        businessVersion: current?.version == null ? null : String(current.version),
        before: { stateChanged: false },
        after: { httpStatus: res.statusCode },
        reason: res.statusCode === 401 ? 'authentication_required' : outcome === 'denied' ? 'authorization_denied' : 'request_failed',
        outcome,
        requestId: req.get('x-request-id') || null
      });
      sendJson(payload);
    };
    persistThenRespond().catch(error => {
      console.error('Failed to record rejected administration request', error);
      sendJson(payload);
    });
    return res;
  };
  next();
}

function validDate(value) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function buildFilters(query) {
  const clauses = [];
  const params = [];
  if (query.actorId) {
    if (!/^\d+$/.test(query.actorId)) throw new Error('操作人筛选无效');
    clauses.push('e.actor_user_id = ?'); params.push(Number(query.actorId));
  }
  if (query.organizationId) {
    if (!/^\d+$/.test(query.organizationId)) throw new Error('组织筛选无效');
    clauses.push('e.organization_id = ?'); params.push(Number(query.organizationId));
  }
  if (query.outcome) {
    if (!['success', 'denied', 'failed'].includes(query.outcome)) throw new Error('操作结果筛选无效');
    clauses.push('e.outcome = ?'); params.push(query.outcome);
  }
  for (const [key, column, message] of [
    ['objectType', 'e.object_type', '对象类型筛选无效'], ['objectId', 'e.object_id', '对象编号筛选无效'],
    ['action', 'e.action', '操作筛选无效']
  ]) {
    const value = query[key]?.trim();
    if (value) {
      if (value.length > 120) throw new Error(message);
      clauses.push(`${column} LIKE ?`); params.push(`%${value}%`);
    }
  }
  if (query.from) {
    if (!validDate(query.from)) throw new Error('开始日期无效');
    clauses.push("e.occurred_at >= ?"); params.push(`${query.from} 00:00:00`);
  }
  if (query.to) {
    if (!validDate(query.to) || (query.from && query.to < query.from)) throw new Error('结束日期无效');
    clauses.push("e.occurred_at < datetime(?, '+1 day')"); params.push(`${query.to} 00:00:00`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

async function queryBusinessAudit(query = {}, limit = 100) {
  const { where, params } = buildFilters(query);
  const safeLimit = limit == null ? null : Math.min(Math.max(Number(limit) || 100, 1), 5000);
  const rows = await all(`SELECT e.id, e.actor_user_id AS actorId, actor.username AS actorUsername,
      actor.name AS actorName, e.actor_organization_id AS actorOrganizationId,
      actor_org.name AS actorOrganizationName, e.organization_id AS organizationId, org.name AS organizationName,
      e.occurred_at AS occurredAt, e.action, e.object_type AS objectType, e.object_id AS objectId,
      e.business_version AS businessVersion, e.before_summary_json AS beforeSummaryJson,
      e.after_summary_json AS afterSummaryJson, e.reason, e.outcome
    FROM business_audit_events e
    LEFT JOIN users actor ON actor.id = e.actor_user_id
    LEFT JOIN organizations actor_org ON actor_org.id = e.actor_organization_id
    LEFT JOIN organizations org ON org.id = e.organization_id
    ${where} ORDER BY e.occurred_at DESC, e.id DESC${safeLimit == null ? '' : ' LIMIT ?'}`,
  safeLimit == null ? params : [...params, safeLimit]);
  return rows.map(row => ({
    ...row,
    beforeSummary: row.beforeSummaryJson ? JSON.parse(row.beforeSummaryJson) : null,
    afterSummary: row.afterSummaryJson ? JSON.parse(row.afterSummaryJson) : null
  }));
}

function csvCell(value) {
  let text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  const columns = [
    ['发生时间', 'occurredAt'], ['操作人', 'actorName'], ['操作人账号', 'actorUsername'],
    ['所属组织', 'organizationName'], ['操作', 'action'], ['对象类型', 'objectType'], ['对象编号', 'objectId'],
    ['业务版本', 'businessVersion'], ['变更前摘要', 'beforeSummary'], ['变更后摘要', 'afterSummary'],
    ['原因', 'reason'], ['结果', 'outcome']
  ];
  return `\uFEFF${[columns.map(([label]) => csvCell(label)).join(','), ...rows.map(row => columns.map(([, key]) => csvCell(row[key])).join(','))].join('\r\n')}`;
}

module.exports = { recordBusinessAudit, recordRejectedAdminRequest, queryBusinessAudit, toCsv };
