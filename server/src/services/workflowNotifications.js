const { effectiveTaskAssignments } = require('./taskAssignments');
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const roleCodes = { filler: ['subsidiary_filler'], submitter: ['subsidiary_submitter'],
  department_reviewer: ['department_reviewer'], approver: ['management'], finalizer: ['report_finalizer'], scorer: ['score_editor'] };
const labels = {
  'report_template.submit': '报表模板已提交', 'report_template.approve': '报表模板已批准发布', 'report_template.reject': '报表模板已退回',
  'period_package.activate': '填报任务已发起', 'report_task.assign': '任务责任人已增加',
  'report_task.reassign': '任务责任人已调整', 'report_task.deadline.extend': '任务截止时间已调整', 'report_task.cancel': '任务已取消',
  'business_revision.submit': '报表已提交，等待审核', 'business_revision.resubmit': '报表已重新提交',
  'business_revision.returned': '报表已退回，请修改', 'business_revision.withdrawn': '报表已撤回',
  'business_revision.review_opinion': '报表审核意见已更新', 'business_revision.finalized': '报表已定稿',
  'template.submit': '模板待审核', 'template.approve': '模板已批准发布', 'template.reject': '模板审核未通过',
  'template_component.submit': '组件待审核', 'template_component.approve': '组件已批准发布', 'template_component.reject': '组件审核未通过',
  'rule_version.submit': '规则待复核', 'rule_version.publish': '规则已复核发布', 'rule_version.reject': '规则复核未通过',
  'field_draft.create': '字段提案待审批', 'field_draft.correct': '字段提案已重新提交',
  'field_draft.approve': '字段提案已批准', 'field_definition.supersede': '字段新版本已批准', 'field_draft.reject': '字段提案已驳回'
};
Object.assign(labels, { 'quarterly_review_item.updated': '季度审核意见已更新', 'quarterly_indicator_score.updated': '季度评分已更新',
  'quarterly_adjustment.proposed': '季度加减分申请待处理', 'quarterly_adjustment.decided': '季度加减分申请已处理',
  'quarterly_package.ranked_and_finalized': '季度报表已定稿' });
for (const cadence of ['monthly', 'quarterly']) for (const [action, label] of Object.entries({ started: '数据调整流程已发起', submitted: '数据调整已提交审核', approved: '数据调整已批准', rejected: '数据调整已退回', applied: '数据调整已生效', department_review_completed: '数据调整已完成部门审核' })) labels[`${cadence}_adjustment.${action}`] = label;

// A dedicated connection only observes committed business transactions. Its cursor
// and inbox writes commit together, so retries/restarts cannot duplicate delivery.
function createWorkflowNotifications(connection) {
  const get = (sql, args = []) => new Promise((resolve, reject) => connection.get(sql, args, (e, r) => e ? reject(e) : resolve(r)));
  const all = (sql, args = []) => new Promise((resolve, reject) => connection.all(sql, args, (e, r) => e ? reject(e) : resolve(r)));
  const run = (sql, args = []) => new Promise((resolve, reject) => connection.run(sql, args, function(e) { e ? reject(e) : resolve(this); }));
  async function user(id) {
    const row = await get("SELECT id, permissions FROM users WHERE id=? AND account_status='active'", [id]);
    if (!row) return null;
    row.permissions = parse(row.permissions);
    row.roles = await all(`SELECT role_code AS code, organization_id AS organizationId FROM effective_user_roles
      WHERE user_id=? AND effective_from<=CURRENT_TIMESTAMP AND (effective_to IS NULL OR effective_to>CURRENT_TIMESTAMP)`, [id]);
    return row;
  }
  const has = (u, codes, org) => u?.roles.some(r => codes.includes(r.code) && (org === undefined || r.organizationId == null || Number(r.organizationId) === Number(org)));
  async function task(id) {
    return get(`SELECT t.*, rt.cadence, rt.display_name AS reportType, o.name AS organization FROM report_tasks t
      JOIN report_types rt ON rt.id=t.report_type_id JOIN organizations o ON o.id=t.organization_id WHERE t.id=?`, [id]);
  }
  async function taskTarget(u, t) {
    if (!t) return null;
    const assigned = (await effectiveTaskAssignments(connection, t)).filter(a => a.userId === u.id);
    const admin = has(u, ['system_admin'], t.organization_id);
    const qualified = assigned.filter(a => admin || has(u, roleCodes[a.responsibility] || [], t.organization_id));
    if (!admin && !has(u, ['management'], t.organization_id) && !qualified.length) return null;
    const review = ['submitted', 'reviewing', 'finalized'].includes(t.task_status);
    if (t.cadence === 'quarterly' && (admin || has(u, ['department_reviewer', 'score_editor', 'management', 'report_finalizer'], t.organization_id))) return `/portal/quarterly-review/${t.id}`;
    if (review && (admin || has(u, ['department_reviewer', 'report_finalizer'], t.organization_id))) return `/portal/monthly-review/${t.id}`;
    if (admin || has(u, ['subsidiary_filler', 'subsidiary_submitter', 'department_reviewer', 'management'], t.organization_id)) return `/portal/monthly-filling?taskId=${t.id}`;
    return `/portal/monthly-review/${t.id}`;
  }
  async function governance(event) {
    const id = Number(event.object_id), action = event.action;
    if (action.startsWith('report_template.')) {
      const row = await get('SELECT * FROM report_studio_templates WHERE id=?', [id]);
      return row && { ...row, owner: row.created_by, kind: 'template', roles: ['template_designer'], target: `/portal/report-studio?section=templates&notificationVersionId=${row.id}`, pending: row.status === 'in_review' };
    }
    if (action.startsWith('template_component.')) {
      const row = await get(`SELECT v.id, v.created_by, v.submitted_by, v.workflow_status AS status, c.code AS name
        FROM template_component_versions v JOIN template_components c ON c.id=v.component_id WHERE v.component_id=? AND v.version=?`, [id, Number(event.business_version)]);
      return row && { ...row, owner: row.submitted_by || row.created_by, kind: 'template', roles: ['template_designer'],
        target: `/portal/template?section=components&notificationVersionId=${row.id}`, pending: row.status === 'in_review' };
    }
    if (action.startsWith('template.')) {
      const row = await get(`SELECT v.id,v.created_by,v.status,t.name FROM template_versions v JOIN templates t ON t.id=v.template_id WHERE v.template_id=? AND v.version=?`, [id, Number(event.business_version)]);
      return row && { ...row, owner: row.created_by, kind: 'template', roles: ['template_designer'],
        target: `/portal/template?section=templates&notificationVersionId=${row.id}`, pending: row.status === 'in_review' };
    }
    if (action.startsWith('rule_version.')) {
      const row = await get(`SELECT v.id,v.created_by,v.status,d.display_name AS name FROM rule_versions v JOIN rule_definitions d ON d.id=v.rule_id WHERE v.id=?`, [id]);
      return row && { ...row, owner: row.created_by, kind: 'rule', roles: ['business_rule_reviewer'],
        target: `/portal/rule-catalog?notificationVersionId=${row.id}`, pending: row.status === 'pending_review' };
    }
    if (event.object_type === 'field_definition') {
      const row = await get(`SELECT d.id,d.created_by,d.status,f.display_name AS name FROM field_definition_versions v
        JOIN field_drafts d ON d.id=v.source_draft_id JOIN field_definitions f ON f.id=v.field_definition_id
        WHERE v.field_definition_id=? AND v.version=?`, [id, Number(event.business_version)]);
      return row && { ...row, owner: row.created_by, kind: 'field', roles: ['data_administrator'], target: `/portal/field-catalog?draftId=${row.id}`, pending: false };
    }
    if (action.startsWith('field_draft.')) {
      const row = await get('SELECT * FROM field_drafts WHERE id=?', [id]);
      return row && { ...row, name: parse(row.proposal_json).displayName, owner: row.created_by, kind: 'field', roles: ['data_administrator'],
        target: `/portal/field-catalog?draftId=${row.id}`, pending: row.status === 'pending' };
    }
    return null;
  }
  function canReadGovernance(u, item) {
    if (item.kind === 'template') return has(u, ['system_admin']) || u.permissions?.includes('template') || has(u, ['template_designer']);
    if (item.kind === 'rule') return has(u, ['system_admin', 'business_rule_administrator', 'business_rule_reviewer']);
    return has(u, ['system_admin', 'data_administrator']) || u.id === item.owner && has(u, ['template_designer']);
  }
  async function deliveries(event) {
    const label = labels[event.action];
    if (!label) return [];
    let tasks = [];
    if (event.object_type === 'period_package') tasks = await all('SELECT id FROM report_tasks WHERE package_id=?', [event.object_id]);
    else if (event.object_type === 'report_task') tasks = [{ id: Number(event.object_id) }];
    else if (event.object_type === 'business_revision') tasks = await all('SELECT task_id AS id FROM business_revisions WHERE id=?', [event.object_id]);
    else if (event.object_type === 'adjustment_request') tasks = await all('SELECT task_id AS id FROM adjustment_requests WHERE id=?', [event.object_id]);
    else if (['quarterly_review_item', 'quarterly_indicator_score'].includes(event.object_type)) tasks = await all('SELECT task_id AS id FROM business_revisions WHERE id=?', [Number(String(event.object_id).split(':')[0])]);
    else if (event.object_type === 'quarterly_adjustment_request') tasks = await all('SELECT task_id AS id FROM business_revisions WHERE id=(SELECT revision_id FROM quarterly_adjustment_requests WHERE id=?)', [event.object_id]);
    const result = [];
    for (const ref of tasks) {
      const t = await task(ref.id);
      if (!t) continue;
      const assignments = await effectiveTaskAssignments(connection, t);
      // Notify actual participants, never every user with the same global role.
      for (const id of new Set(assignments.map(a => a.userId))) {
        const u = await user(id); const target = u && await taskTarget(u, t);
        if (target) result.push({ userId: id, taskId: t.id, payload: { label, organization: t.organization, reportType: t.reportType,
          periodCode: t.period_code, deadlineAt: t.deadline_at, target, action: event.action, auditId: event.id } });
      }
    }
    const item = await governance(event);
    if (item) {
      const submission = /\.(submit|create|correct)$/.test(event.action);
      if (submission && !item.pending) return result; // Direct admin approval creates no spurious pending approval.
      const candidates = submission ? await all("SELECT id FROM users WHERE account_status='active'") : [{ id: item.owner }];
      for (const { id } of candidates) {
        const u = await user(id);
        if (!u || !canReadGovernance(u, item)) continue;
        if (submission && (id === item.owner || !has(u, ['system_admin']))) continue;
        result.push({ userId: id, taskId: null, payload: { label, description: item.name, target: `${item.target}&workflowFrom=todo`,
          action: event.action, auditId: event.id, governance: { kind: item.kind, owner: item.owner } } });
      }
    }
    return result;
  }
  async function processEvents() {
    await run('BEGIN IMMEDIATE');
    try {
      const cursor = await get('SELECT audit_id FROM workflow_notification_cursor WHERE id=1');
      const events = await all('SELECT * FROM business_audit_events WHERE id>? ORDER BY id LIMIT 100', [cursor.audit_id]);
      for (const event of events) {
        if (event.outcome !== 'success') continue;
        for (const delivery of await deliveries(event)) {
          if (await get('SELECT 1 FROM workflow_notification_deliveries WHERE audit_id=? AND user_id=? AND task_key=?', [event.id, delivery.userId, delivery.taskId || 0])) continue;
          const saved = await run(`INSERT INTO notifications(user_id,task_id,notification_type,payload_json,sent_at,status)
            VALUES(?,?,'workflow',?,CURRENT_TIMESTAMP,'sent')`, [delivery.userId, delivery.taskId, JSON.stringify(delivery.payload)]);
          await run('INSERT INTO workflow_notification_deliveries(audit_id,user_id,notification_id,task_key) VALUES(?,?,?,?)', [event.id, delivery.userId, saved.lastID, delivery.taskId || 0]);
        }
      }
      if (events.length) await run('UPDATE workflow_notification_cursor SET audit_id=? WHERE id=1', [events.at(-1).id]);
      await run('COMMIT');
      return events.length;
    } catch (error) { await run('ROLLBACK').catch(() => {}); throw error; }
  }
  async function list(userId) {
    const u = await user(userId);
    if (!u) throw Object.assign(new Error('账户不存在或已停用'), { status: 401 });
    const rows = await all(`SELECT id,task_id AS taskId,notification_type AS type,payload_json,created_at AS createdAt,status
      FROM notifications WHERE user_id=? AND notification_type IN ('workflow','task_reminder') ORDER BY id DESC`, [userId]);
    const visible = [];
    for (const row of rows) {
      const payload = parse(row.payload_json);
      if (row.taskId) {
        const target = await taskTarget(u, await task(row.taskId));
        if (!target) continue;
        payload.target = target + (target.includes('?') ? '&' : '?') + 'workflowFrom=todo';
      } else {
        if (!payload.governance || !canReadGovernance(u, payload.governance)) continue;
        if (/\.(submit|create|correct)$/.test(payload.action || '') && !has(u, ['system_admin'])) continue;
        if (!payload.target.includes('workflowFrom=')) payload.target += '&workflowFrom=todo';
      }
      const { payload_json, ...item } = row;
      visible.push({ ...item, payload });
    }
    visible.sort((a, b) => Number(a.status === 'read') - Number(b.status === 'read') || b.id - a.id);
    return { notifications: visible.slice(0, 100), unreadCount: visible.filter(n => n.status !== 'read').length };
  }
  async function read(id, userId) {
    const row = await get("SELECT id FROM notifications WHERE id=? AND user_id=? AND notification_type IN ('workflow','task_reminder')", [id, userId]);
    if (!row) throw Object.assign(new Error('通知不存在'), { status: 404 });
    await run("UPDATE notifications SET status='read' WHERE id=? AND user_id=?", [id, userId]);
  }
  return { processEvents, list, read, deliveries, taskTarget };
}
module.exports = { createWorkflowNotifications };
