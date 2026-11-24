const { effectiveTaskAssignments } = require('./taskAssignments');
const { taskFlowProgress } = require('./taskFlowProgress');
const parse = (value, fallback = {}) => { try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; } };
const responsibilityRoles = { filler: 'subsidiary_filler', submitter: 'subsidiary_submitter', department_reviewer: 'department_reviewer', finalizer: 'report_finalizer', approver: 'management', scorer: 'score_editor' };
const labels = { draft: '草稿', validated: '待激活', pending: '待审批', pending_review: '待审批', in_review: '待审批', published: '已完成', approved: '已完成', superseded: '已完成', rejected: '已退回', submitted: '待审核', reviewing: '审核中', finalized: '已完成', cancelled: '已取消', canceled: '已取消', active: '进行中', closed: '已结束' };

// This is a projection of existing business state, not a second workflow engine.
// It never advances a task or grants access to its handling endpoint.
function createWorkflowCenter(connection) {
  const all = (sql, args = []) => new Promise((resolve, reject) => connection.all(sql, args, (e, r) => e ? reject(e) : resolve(r)));
  async function list(actor) {
    const users = await all(`SELECT u.id,u.name,u.username,u.account_status,u.organization_id,o.code AS departmentCode,o.organization_type AS organizationType
      FROM users u LEFT JOIN organizations o ON o.id=u.organization_id`);
    const roles = await all(`SELECT user_id,role_code,organization_id FROM effective_user_roles
      WHERE effective_from<=CURRENT_TIMESTAMP AND (effective_to IS NULL OR effective_to>CURRENT_TIMESTAMP)`);
    const userMap = new Map(users.map(u => [u.id, { ...u, roles: roles.filter(r => r.user_id === u.id) }]));
    const has = (id, role, org) => userMap.get(id)?.account_status === 'active' && userMap.get(id).roles.some(r => r.role_code === role && (org === undefined || r.organization_id == null || Number(r.organization_id) === Number(org)));
    const admin = has(actor.id, 'system_admin');
    const manager = admin || has(actor.id, 'management');
    const name = id => userMap.get(Number(id))?.name || userMap.get(Number(id))?.username || '—';
    const admins = users.filter(u => has(u.id, 'system_admin')).map(u => u.id);
    const rows = [];
    const governance = (kind, records, target) => {
      for (const r of records) {
        if (!admin && r.created_by !== actor.id) continue;
        const pending = ['pending', 'pending_review', 'in_review'].includes(r.status);
        const completed = ['approved', 'published', 'superseded'].includes(r.status);
        rows.push({ id: `${kind}:${r.id}`, kind, name: r.name, version: r.version,
          period: '—', organization: '—', initiator: name(r.created_by), stage: pending ? '系统管理员审批' : completed ? '已完成' : r.status === 'rejected' ? '退回修改' : '草稿编制',
          assignees: pending ? admins.map(name).join('、') || '未配置系统管理员' : !completed ? name(r.created_by) : '—',
          deadline: null, status: r.status, statusLabel: labels[r.status] || r.status, createdAt: r.created_at,
          todo: pending && admin, initiated: r.created_by === actor.id,
          handled: r.reviewed_by === actor.id || completed && r.created_by === actor.id,
          manageable: admin, target: target(r), approval: pending && admin });
      }
    };
    governance('field', (await all('SELECT * FROM field_drafts')).map(r => ({ ...r, name: parse(r.proposal_json).displayName || r.proposed_code })), r => `/portal/field-catalog?draftId=${r.id}`);
    governance('rule', await all(`SELECT v.*,d.display_name AS name FROM rule_versions v JOIN rule_definitions d ON d.id=v.rule_id WHERE v.seeded=0`), r => `/portal/rule-catalog?notificationVersionId=${r.id}`);
    governance('component', (await all(`SELECT v.*,v.workflow_status AS status,c.code AS name FROM template_component_versions v JOIN template_components c ON c.id=v.component_id`)).map(r => ({ ...r, name: parse(r.metadata_json).name || r.name })), r => `/portal/template?section=components&notificationVersionId=${r.id}`);
    governance('template', await all(`SELECT v.*,t.name FROM template_versions v JOIN templates t ON t.id=v.template_id`), r => `/portal/template?section=templates&notificationVersionId=${r.id}`);
    if ((await all("SELECT name FROM sqlite_master WHERE type='table' AND name='report_studio_templates'")).length) {
      governance('report_template', await all('SELECT * FROM report_studio_templates'), r => `/portal/report-studio?section=templates&notificationVersionId=${r.id}`);
    }

    if (manager) {
      const drafts = await all('SELECT * FROM period_package_drafts');
      const types = new Map((await all('SELECT * FROM report_types')).map(r => [r.id, r.display_name]));
      for (const d of drafts) {
        if (!admin && d.created_by !== actor.id) continue;
        const input = parse(d.input_json);
        rows.push({ id: `package-draft:${d.id}`, kind: 'period', name: types.get(Number(input.reportTypeId)) || '周期填报草稿',
          period: input.periodCode || '未选周期', organization: '配置中', initiator: name(d.created_by), stage: '配置与激活', assignees: name(d.created_by),
          status: 'draft', statusLabel: '草稿', createdAt: d.created_at, todo: false, initiated: d.created_by === actor.id, handled: false,
          manageable: true, target: `/portal/period-configuration?packageId=draft-${d.id}` });
      }
      for (const p of await all(`SELECT p.*,rt.display_name AS name FROM period_packages p JOIN report_types rt ON rt.id=p.report_type_id
        WHERE p.status IN ('draft','validated') AND NOT EXISTS (SELECT 1 FROM period_package_drafts d WHERE d.package_id=p.id)`)) {
        if (!admin && p.created_by !== actor.id) continue;
        rows.push({ id: `package:${p.id}`, kind: 'period', name: p.name, period: p.period_code, organization: '配置中', initiator: name(p.created_by),
          stage: '配置与激活', assignees: name(p.created_by), status: p.status, statusLabel: labels[p.status], createdAt: p.created_at,
          todo: false, initiated: p.created_by === actor.id, handled: false, manageable: true, target: `/portal/period-configuration?packageId=${p.id}` });
      }
    }
    const tasks = await all(`SELECT t.*,rt.cadence,rt.display_name AS name,o.name AS organization,o.code AS organizationCode,p.created_by,
      r.submitted_by,r.revision_status AS revisionStatus FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id JOIN organizations o ON o.id=t.organization_id
      JOIN period_packages p ON p.id=t.package_id LEFT JOIN business_revisions r ON r.id=t.current_revision_id ORDER BY t.id DESC`);
    const auditTasks = new Set((await all(`SELECT DISTINCT COALESCE(
      CASE WHEN e.object_type='report_task' THEN CAST(e.object_id AS INTEGER) END,
      r.task_id, a.task_id, qr.task_id, ar.task_id, pt.id) AS taskId FROM business_audit_events e
      LEFT JOIN business_revisions r ON e.object_type='business_revision' AND r.id=e.object_id
      LEFT JOIN adjustment_requests a ON e.object_type='adjustment_request' AND a.id=e.object_id
      LEFT JOIN business_revisions qr ON e.object_type IN ('quarterly_review_item','quarterly_indicator_score') AND qr.id=CAST(e.object_id AS INTEGER)
      LEFT JOIN quarterly_adjustment_requests qa ON e.object_type='quarterly_adjustment_request' AND qa.id=e.object_id
      LEFT JOIN business_revisions ar ON ar.id=qa.revision_id
      LEFT JOIN report_tasks pt ON e.object_type='period_package' AND e.action='quarterly_package.ranked_and_finalized' AND pt.package_id=e.object_id
      WHERE e.actor_user_id=? AND e.outcome='success' AND (e.action LIKE 'business_revision.%' OR e.action LIKE 'quarterly_%' OR e.action LIKE 'monthly_adjustment.%')`, [actor.id])).map(r => r.taskId));
    for (const t of tasks) {
      const assignments = await effectiveTaskAssignments(connection, t);
      const qualified = assignments.filter(a => {
        if (has(a.userId, 'system_admin', t.organization_id)) return true;
        if (has(a.userId, responsibilityRoles[a.responsibility], t.organization_id)) return true;
        const u = userMap.get(a.userId);
        return a.responsibility === 'department_reviewer' && u?.organizationType === 'department' && has(a.userId, 'department_reviewer', u.organization_id);
      });
      const mine = qualified.filter(a => a.userId === actor.id);
      const manageable = admin || has(actor.id, 'management', t.organization_id);
      if (!mine.length && !manageable) continue;
      const adjustmentRecord = (await all(`SELECT * FROM adjustment_requests WHERE task_id=? AND proposed_revision_id=? AND status!='rejected'`, [t.id, t.current_revision_id]))[0];
      const quarterAdjustments = t.cadence === 'quarterly' ? await all("SELECT status FROM quarterly_adjustment_requests WHERE revision_id=?", [t.current_revision_id]) : [];
      let pending = [], stage = '填报与提交';
      const terminal = ['finalized', 'cancelled', 'canceled', 'closed'].includes(t.task_status);
      if (terminal) stage = t.task_status === 'finalized' ? '已完成' : '已结束';
      else if (['draft', 'filling', 'returned', 'withdrawn'].includes(t.task_status)) pending = qualified.filter(a => ['filler', 'submitter'].includes(a.responsibility));
      else if (['submitted', 'reviewing'].includes(t.task_status)) {
        const adjustment = adjustmentRecord?.status === 'applied' ? null : adjustmentRecord;
        if (adjustment?.status === 'management_approval') {
          stage = '数据调整审批'; pending = qualified.filter(a => a.responsibility === 'approver');
        } else if (t.cadence === 'monthly') {
          const opinions = await all(`SELECT department_code FROM review_opinion_items WHERE revision_id=? AND review_item_key='monthly:submission' AND disposition IN ('accept','comment')`, [t.current_revision_id]);
          const completed = new Set(opinions.map(o => o.department_code));
          const required = adjustment ? parse(adjustment.required_departments_json, []) : null;
          const missing = assignments.filter(a => {
            const u = userMap.get(a.userId), code = u?.organizationType === 'department' ? u.departmentCode : t.organizationCode;
            return a.responsibility === 'department_reviewer' && (!required || required.includes(code)) && !completed.has(code);
          });
          pending = qualified.filter(a => missing.some(m => m.userId === a.userId && m.responsibility === a.responsibility));
          stage = '部门审核';
          if (!missing.length) { stage = '月报定稿'; pending = qualified.filter(a => a.responsibility === 'finalizer'); }
        } else {
          const indicators = await all(`SELECT i.*,r.status AS reviewStatus,s.score_decimal AS score FROM task_indicators i
            LEFT JOIN quarterly_review_items r ON r.indicator_id=i.id AND r.revision_id=?
            LEFT JOIN quarterly_indicator_scores s ON s.indicator_id=i.id AND s.revision_id=? WHERE i.task_id=?`, [t.current_revision_id, t.current_revision_id, t.id]);
          const missing = indicators.filter(i => i.reviewStatus !== 'approved');
          if (missing.length) {
            stage = '季度指标审核';
            pending = qualified.filter(a => a.responsibility === 'department_reviewer' && missing.some(i => has(a.userId, 'system_admin') || has(a.userId, 'department_reviewer', parse(i.configuration_json).ownerOrganizationId)));
          } else if (indicators.some(i => { const c = parse(i.configuration_json); return i.score == null && !c.exempt && !c.isExempt && !c.scoreFormulaVersionId && !c.formulaVersionId; })) {
            stage = '季度评分'; pending = qualified.filter(a => a.responsibility === 'scorer');
          } else if (quarterAdjustments.some(a => a.status === 'pending')) {
            stage = '季度奖惩审批'; pending = qualified.filter(a => a.responsibility === 'approver');
          } else { stage = '季度定稿'; pending = qualified.filter(a => a.responsibility === 'finalizer'); }
        }
      }
      const todo = pending.some(a => a.userId === actor.id);
      const filling = ['draft','filling','returned','withdrawn'].includes(t.task_status);
      // Management readers without a handling responsibility use the existing progress page.
      const canReadReview = mine.some(a => ['department_reviewer','finalizer','approver', ...(t.cadence === 'quarterly' ? ['scorer'] : [])].includes(a.responsibility));
      const target = filling
        ? mine.some(a => ['filler','submitter'].includes(a.responsibility)) ? `/portal/monthly-filling?taskId=${t.id}` : manageable ? '/portal/task-progress' : null
        : canReadReview ? `/portal/${t.cadence === 'quarterly' ? 'quarterly' : 'monthly'}-review/${t.id}`
          : manageable ? '/portal/task-progress' : mine.some(a => ['filler','submitter'].includes(a.responsibility)) ? `/portal/monthly-filling?taskId=${t.id}` : null;
      rows.push({ id: `task:${t.id}`, taskId: t.id, kind: t.cadence, name: t.name, period: t.period_code, organization: t.organization,
        flow: taskFlowProgress({ cadence: t.cadence, status: t.task_status, revisionStatus: t.revisionStatus, stage,
          hasReview: assignments.some(a => a.responsibility === 'department_reviewer'), hasAdjustment: Boolean(adjustmentRecord),
          hasQuarterAdjustment: quarterAdjustments.some(a => a.status !== 'rejected') }),
        initiator: name(t.created_by), stage, assignees: [...new Set(pending.map(a => name(a.userId)))].join('、') || (terminal ? '—' : '暂无有效责任人'),
        deadline: t.deadline_at, status: t.task_status, statusLabel: filling ? '待填报' : stage.endsWith('定稿') ? '待定稿' : stage === '季度评分' ? '待评分' : stage.endsWith('审批') ? '待审批' : labels[t.task_status] || t.task_status,
        createdAt: t.created_at, todo, initiated: t.created_by === actor.id, handled: auditTasks.has(t.id) || t.submitted_by === actor.id,
        manageable, target });
    }
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id));
    return { items: rows, counts: { todo: rows.filter(r => r.todo).length, initiated: rows.filter(r => r.initiated).length, handled: rows.filter(r => r.handled).length, manage: rows.filter(r => r.manageable).length }, canManage: manager };
  }
  return { list };
}
module.exports = { createWorkflowCenter };
