const fs = require('node:fs/promises');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const db = require('../config/database');
const storage = require('../config/storage');
const { recordBusinessAudit } = require('./businessAudit');
const { hasTaskAssignment, taskReviewDepartments } = require('./taskAssignments');

const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const run = (connection, sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const fail = (message, status) => Object.assign(new Error(message), { status });

function roleInScope(actor, codes, organizationId) {
  return (actor.roles || []).some(role => codes.includes(role.code)
    && (role.organizationId == null || Number(role.organizationId) === Number(organizationId)));
}

async function begin() {
  await db.ready;
  const connection = new sqlite3.Database(storage.getDatabasePath());
  connection.configure('busyTimeout', 10000);
  await run(connection, 'PRAGMA foreign_keys = ON');
  await run(connection, 'PRAGMA busy_timeout = 10000');
  await run(connection, 'ATTACH DATABASE ? AS adjustment_collab', [storage.getCollaborationDatabasePath()]);
  await run(connection, 'BEGIN IMMEDIATE');
  return connection;
}

async function assertAssignment(connection, task, actor, responsibilities, roles) {
  if (!roleInScope(actor, roles, task.organization_id)) throw fail('当前用户没有此组织的报告调整权限', 403);
  const assignment = await Promise.all(responsibilities.map(responsibility =>
    hasTaskAssignment(connection, task, actor.id, responsibility))).then(results => results.some(Boolean));
  if (!assignment) throw fail('当前用户未被分配此月报调整责任', 403);
}

async function startMonthlyAdjustment({ taskId, actor, fieldCodes, reason }) {
  if (!Number.isSafeInteger(Number(taskId)) || Number(taskId) < 1) throw fail('任务编号无效', 400);
  const cleanReason = String(reason || '').trim();
  const selectedCodes = [...new Set((Array.isArray(fieldCodes) ? fieldCodes : []).map(code => String(code).trim()).filter(Boolean))];
  if (!cleanReason || cleanReason.length > 1000) throw fail('调整原因不能为空且不能超过 1000 个字符', 400);
  if (!selectedCodes.length || selectedCodes.length > 200 || selectedCodes.some(code => code.length > 100)) {
    throw fail('请选择 1 至 200 个需要调整的字段', 400);
  }
  const connection = await begin();
  try {
    const task = await get(connection, `SELECT t.*, rt.cadence, cr.id AS room_id, cr.collaboration_room_key,
        cr.room_status, p.template_version_id AS package_template_version
      FROM report_tasks t JOIN report_types rt ON rt.id = t.report_type_id
      JOIN period_packages p ON p.id = t.package_id
      JOIN collaboration_rooms cr ON cr.task_id = t.id AND cr.revision_number =
        (SELECT MAX(latest.revision_number) FROM collaboration_rooms latest WHERE latest.task_id = t.id)
      WHERE t.id = ?`, [Number(taskId)]);
    if (!task) throw fail('填报任务不存在', 404);
    if (!['monthly', 'quarterly'].includes(task.cadence)) throw fail('此报表类型暂不支持调整', 409);
    if (task.task_status !== 'finalized') throw fail('只能基于已定稿报告发起调整', 409);
    await assertAssignment(connection, task, actor, ['filler', 'submitter'], ['subsidiary_filler', 'subsidiary_submitter']);
    const source = await get(connection, `SELECT * FROM business_revisions WHERE id = ? AND task_id = ?
      AND revision_status = 'finalized' AND is_current_effective = 1`, [task.current_revision_id, task.id]);
    if (!source) throw fail('当前有效报告修订不存在', 409);
    const fields = await all(connection, `SELECT f.id, f.code FROM business_values v
      JOIN field_definitions f ON f.id = v.field_definition_id
      WHERE v.revision_id = ? AND f.editable = 1 GROUP BY f.id, f.code`, [source.id]);
    const available = new Set(fields.map(field => field.code));
    const unavailable = selectedCodes.filter(code => !available.has(code));
    if (unavailable.length) throw fail(`所选字段不属于当前定稿：${unavailable.join('、')}`, 400);

    const indicators = await all(connection, `SELECT field_definition_id, configuration_json FROM task_indicators WHERE task_id = ?`, [task.id]);
    const fieldIds = new Set(fields.filter(field => selectedCodes.includes(field.code)).map(field => Number(field.id)));
    const declaredDepartments = new Set();
    const indicatorsWithoutDepartments = [];
    for (const indicator of indicators) {
      if (!fieldIds.has(Number(indicator.field_definition_id))) continue;
      let config = {};
      try { config = JSON.parse(indicator.configuration_json || '{}'); } catch { /* ignore malformed optional configuration */ }
      const indicatorDepartments = new Set();
      for (const value of [config.departmentCode,
        ...(Array.isArray(config.departmentCodes) ? config.departmentCodes : []),
        ...(Array.isArray(config.reviewDepartments) ? config.reviewDepartments : [])]) {
        if (typeof value === 'string' && value.trim()) indicatorDepartments.add(value.trim());
      }
      if (Number.isSafeInteger(Number(config.ownerOrganizationId))) {
        const owner = await get(connection, `SELECT code FROM organizations WHERE id=? AND organization_type='department' AND status='active'`,
          [Number(config.ownerOrganizationId)]);
        if (owner?.code) indicatorDepartments.add(owner.code);
      }
      if (!indicatorDepartments.size) indicatorsWithoutDepartments.push(indicator.field_definition_id);
      for (const department of indicatorDepartments) declaredDepartments.add(department);
    }
    const reviewers = await taskReviewDepartments(connection, task);
    const assignedDepartments = new Set(reviewers.map(item => item.code).filter(Boolean));
    if (indicatorsWithoutDepartments.length) throw fail('所选指标未配置对应审核部门，无法确定必需审核范围', 409);
    const unassignedDepartments = [...declaredDepartments].filter(code => !assignedDepartments.has(code));
    if (unassignedDepartments.length) throw fail(`所选指标要求的部门尚未指派审核人：${unassignedDepartments.join('、')}`, 409);
    const requiredDepartments = [...declaredDepartments].sort();
    if (!requiredDepartments.length) throw fail('所选字段未配置关联审核指标', 409);
    const artifact = await get(connection, `SELECT storage_key FROM official_artifacts
      WHERE revision_id = ? AND artifact_type = 'spreadjs_workbook_json'`, [source.id]);
    if (!artifact?.storage_key) throw fail('当前定稿缺少工作簿快照', 409);
    const workbook = JSON.parse(await fs.readFile(path.resolve(artifact.storage_key), 'utf8'));
    const nextRevision = Number((await get(connection, `SELECT COALESCE(MAX(revision_number), 0) AS number
      FROM business_revisions WHERE task_id = ?`, [task.id])).number) + 1;
    const nextRoom = Number((await get(connection, `SELECT COALESCE(MAX(revision_number), 0) AS number
      FROM collaboration_rooms WHERE task_id = ?`, [task.id])).number) + 1;
    const roomKey = `report-task-${task.id}-revision-${nextRoom}`;
    const room = await run(connection, `INSERT INTO collaboration_rooms
      (task_id, revision_number, collaboration_room_key, collaboration_db, room_status, latest_version, snapshot_reference)
      VALUES (?, ?, ?, ?, 'open', 0, ?)`, [task.id, nextRoom, roomKey,
      storage.getCollaborationDatabasePath(), `${roomKey}@0`]);
    await run(connection, `INSERT INTO adjustment_collab.collaboration_rooms
      (room_key, task_id, revision_number, room_status, current_version) VALUES (?, ?, ?, 'open', 0)`, [roomKey, task.id, nextRoom]);
    const collabRoom = await get(connection, 'SELECT id FROM adjustment_collab.collaboration_rooms WHERE room_key = ?', [roomKey]);
    await run(connection, `INSERT INTO adjustment_collab.collaboration_snapshots (room_id, version, snapshot_json) VALUES (?, 0, ?)`,
      [collabRoom.id, JSON.stringify(workbook)]);
    const draft = await run(connection, `INSERT INTO business_revisions
      (task_id, revision_number, revision_status, collaboration_room_id, source_revision_id)
      VALUES (?, ?, 'draft', ?, ?)`, [task.id, nextRevision, room.lastID, source.id]);
    if (task.cadence === 'quarterly') {
      const priorReviews = await all(connection, `SELECT indicator_id, reviewer_id, status, opinion,
          remediation_deadline, version FROM quarterly_review_items WHERE revision_id=?`, [source.id]);
      for (const review of priorReviews) {
        await run(connection, `INSERT INTO quarterly_review_items
          (revision_id, indicator_id, reviewer_id, status, opinion, remediation_deadline, version)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [draft.lastID, review.indicator_id, review.reviewer_id, review.status,
          review.opinion, review.remediation_deadline, review.version]);
      }
      const priorScores = await all(connection, `SELECT indicator_id, scorer_id, score_decimal, score_source,
          formula_version_id, comment, version FROM quarterly_indicator_scores WHERE revision_id=?`, [source.id]);
      for (const score of priorScores) {
        await run(connection, `INSERT INTO quarterly_indicator_scores
          (revision_id, indicator_id, scorer_id, score_decimal, score_source, formula_version_id, comment, version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [draft.lastID, score.indicator_id, score.scorer_id, score.score_decimal,
          score.score_source, score.formula_version_id, score.comment, score.version]);
      }
      const priorAdjustments = await all(connection, `SELECT adjustment_type, amount_decimal, reason, status, requested_by,
          decided_by, decision_note, created_at, decided_at FROM quarterly_adjustment_requests WHERE revision_id=?`, [source.id]);
      for (const item of priorAdjustments) {
        await run(connection, `INSERT INTO quarterly_adjustment_requests
          (revision_id, adjustment_type, amount_decimal, reason, status, requested_by, decided_by, decision_note, created_at, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [draft.lastID, item.adjustment_type, item.amount_decimal, item.reason,
          item.status, item.requested_by, item.decided_by, item.decision_note, item.created_at, item.decided_at]);
      }
    }
    const request = await run(connection, `INSERT INTO adjustment_requests
      (task_id, source_revision_id, proposed_revision_id, status, reason, requested_by,
        changed_fields_json, required_departments_json, impact_json)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, '{}')`, [task.id, source.id, draft.lastID, cleanReason,
      actor.id, JSON.stringify(selectedCodes), JSON.stringify(requiredDepartments)]);
    await run(connection, `UPDATE collaboration_rooms SET room_status = 'closed', closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP)
      WHERE id = ?`, [task.room_id]);
    await run(connection, `UPDATE adjustment_collab.collaboration_rooms SET room_status = 'closed' WHERE room_key = ?`, [task.collaboration_room_key]);
    await run(connection, `UPDATE report_tasks SET task_status = 'draft', current_revision_id = ? WHERE id = ?`, [draft.lastID, task.id]);
    await run(connection, `INSERT INTO report_task_events
      (task_id, revision_id, event_type, actor_user_id, reason, from_status, to_status)
      VALUES (?, ?, 'draft_created', ?, ?, 'finalized', 'draft')`, [task.id, draft.lastID, actor.id, cleanReason]);
    await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
      action: `${task.cadence}_adjustment.started`, objectType: 'adjustment_request', objectId: request.lastID,
      businessVersion: String(nextRevision), before: { sourceRevisionId: source.id, status: 'finalized' },
      after: { proposedRevisionId: draft.lastID, fields: selectedCodes, requiredDepartments }, reason: cleanReason });
    await run(connection, 'COMMIT');
    return { taskId: Number(task.id), adjustmentRequestId: request.lastID, sourceRevisionId: Number(source.id),
      revisionId: draft.lastID, revisionNumber: nextRevision, status: 'draft', requiredDepartments };
  } catch (error) {
    await run(connection, 'ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await new Promise(resolve => connection.close(() => resolve()));
  }
}

async function getAdjustmentFields(taskId, actor) {
  if (!Number.isSafeInteger(Number(taskId)) || Number(taskId) < 1) throw fail('任务编号无效', 400);
  const task = await get(db, `SELECT t.*, rt.cadence FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id WHERE t.id=?`, [Number(taskId)]);
  if (!task) throw fail('填报任务不存在', 404);
  if (!['monthly', 'quarterly'].includes(task.cadence) || task.task_status !== 'finalized') throw fail('只能基于已定稿报告发起调整', 409);
  if (!roleInScope(actor, ['subsidiary_filler', 'subsidiary_submitter'], task.organization_id)) throw fail('当前用户没有此组织的报告调整权限', 403);
  const assignment = await Promise.all(['filler', 'submitter'].map(responsibility =>
    hasTaskAssignment(db, task, actor.id, responsibility))).then(results => results.some(Boolean));
  if (!assignment) throw fail('当前用户未被分配此月报调整责任', 403);
  return all(db, `SELECT f.code AS fieldCode, f.display_name AS displayName FROM business_values v
    JOIN field_definitions f ON f.id=v.field_definition_id WHERE v.revision_id=? AND f.editable=1 GROUP BY f.id, f.code, f.display_name
    ORDER BY f.code`, [task.current_revision_id]);
}

async function approveOrRejectMonthlyAdjustment({ taskId, actor, decision, note }) {
  if (!['approve', 'reject'].includes(decision)) throw fail('调整决定无效', 400);
  const cleanNote = String(note || '').trim();
  if (!cleanNote || cleanNote.length > 2000) throw fail('审批意见不能为空且不能超过 2000 个字符', 400);
  const connection = await begin();
  try {
    const task = await get(connection, `SELECT t.*, rt.cadence FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id WHERE t.id=?`, [Number(taskId)]);
    if (!task) throw fail('填报任务不存在', 404);
    if (!['monthly', 'quarterly'].includes(task.cadence)) throw fail('此报表类型暂不支持调整审批', 409);
    const systemAdmin = (actor.roles || []).some(role => role.code === 'system_admin');
    const management = (actor.roles || []).some(role => role.code === 'management');
    const approverAssignment = management && await hasTaskAssignment(connection, task, actor.id, 'approver');
    if (!systemAdmin && (!management || !approverAssignment)) throw fail('需要此配置包的管理审批指派', 403);
    const request = await get(connection, `SELECT * FROM adjustment_requests WHERE task_id=? AND proposed_revision_id=?
      AND status='management_approval'`, [task.id, task.current_revision_id]);
    if (!request) throw fail('当前修订没有待管理审批的调整申请', 409);
    if (decision === 'approve') {
      const impact = JSON.parse(request.impact_json || '{}');
      await run(connection, `UPDATE adjustment_requests SET status='approved', approved_by=?, impact_json=? WHERE id=? AND status='management_approval'`,
        [actor.id, JSON.stringify({ ...impact, note: cleanNote }), request.id]);
    } else {
      const impact = JSON.parse(request.impact_json || '{}');
      await run(connection, `UPDATE adjustment_requests SET status='rejected', approved_by=?, rejected_at=CURRENT_TIMESTAMP,
        impact_json=? WHERE id=? AND status='management_approval'`, [actor.id, JSON.stringify({ ...impact, note: cleanNote }), request.id]);
      await run(connection, `UPDATE business_revisions SET revision_status='rejected' WHERE id=? AND revision_status IN ('draft','submitted')`, [request.proposed_revision_id]);
      await run(connection, `UPDATE business_revisions SET is_current_effective=1 WHERE id=? AND revision_status='finalized'`, [request.source_revision_id]);
      await run(connection, `UPDATE report_tasks SET task_status='finalized', current_revision_id=? WHERE id=?`, [request.source_revision_id, task.id]);
      await run(connection, `UPDATE collaboration_rooms SET room_status='closed', closed_at=CURRENT_TIMESTAMP
        WHERE task_id=? AND revision_number=(SELECT MAX(revision_number) FROM collaboration_rooms WHERE task_id=?)`, [task.id, task.id]);
      await run(connection, `UPDATE adjustment_collab.collaboration_rooms SET room_status='closed' WHERE task_id=?
        AND revision_number=(SELECT MAX(revision_number) FROM adjustment_collab.collaboration_rooms WHERE task_id=?)`, [task.id, task.id]);
    }
    await run(connection, `INSERT INTO report_task_events
      (task_id, revision_id, event_type, actor_user_id, reason, from_status, to_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [task.id, request.proposed_revision_id, decision === 'approve' ? 'reviewing' : 'returned', actor.id,
      cleanNote, task.task_status, decision === 'approve' ? 'submitted' : 'finalized']);
    await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
      action: `${task.cadence}_adjustment.${decision === 'approve' ? 'approved' : 'rejected'}`, objectType: 'adjustment_request', objectId: request.id,
      businessVersion: String(request.proposed_revision_id), before: { status: request.status },
      after: { status: decision === 'approve' ? 'approved' : 'rejected', sourceRevisionId: request.source_revision_id }, reason: cleanNote });
    await run(connection, 'COMMIT');
    return { taskId: Number(task.id), adjustmentRequestId: Number(request.id), status: decision === 'approve' ? 'approved' : 'rejected' };
  } catch (error) {
    await run(connection, 'ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await new Promise(resolve => connection.close(() => resolve()));
  }
}

async function markAdjustmentSubmitted(connection, task, revisionId) {
  const request = await get(connection, `SELECT * FROM adjustment_requests WHERE task_id=? AND proposed_revision_id=? AND status='draft'`, [task.id, revisionId]);
  if (!request) return null;
  const selected = JSON.parse(request.changed_fields_json || '[]');
  if (!selected.length) throw fail('调整申请未指定字段', 409);
  const sourceValues = await all(connection, `SELECT f.code AS fieldCode, v.record_key AS recordKey,
      v.text_value, v.decimal_value, v.integer_value, v.boolean_value, v.date_value, v.json_value
    FROM business_values v JOIN field_definitions f ON f.id=v.field_definition_id
    WHERE v.revision_id=? AND f.editable=1`, [request.source_revision_id]);
  const proposedValues = await all(connection, `SELECT f.code AS fieldCode, v.record_key AS recordKey,
      v.text_value, v.decimal_value, v.integer_value, v.boolean_value, v.date_value, v.json_value
    FROM business_values v JOIN field_definitions f ON f.id=v.field_definition_id
    WHERE v.revision_id=? AND f.editable=1`, [revisionId]);
  const typedValue = row => ({ text: row.text_value, decimal: row.decimal_value, integer: row.integer_value,
    boolean: row.boolean_value, date: row.date_value, json: row.json_value });
  const encode = row => JSON.stringify(typedValue(row));
  const compositeKey = row => `${row.fieldCode}\u0000${row.recordKey}`;
  const sourceMap = new Map(sourceValues.map(row => [compositeKey(row), row]));
  const proposedMap = new Map(proposedValues.map(row => [compositeKey(row), row]));
  const changedCodes = new Set();
  const changedValues = [];
  for (const key of new Set([...sourceMap.keys(), ...proposedMap.keys()])) {
    const beforeRow = sourceMap.get(key);
    const afterRow = proposedMap.get(key);
    if ((beforeRow ? encode(beforeRow) : null) === (afterRow ? encode(afterRow) : null)) continue;
    const fieldCode = (afterRow || beforeRow).fieldCode;
    changedCodes.add(fieldCode);
    changedValues.push({ fieldCode, recordKey: (afterRow || beforeRow).recordKey,
      before: beforeRow ? typedValue(beforeRow) : null, after: afterRow ? typedValue(afterRow) : null });
  }
  const changedFieldCodes = [...changedCodes].sort();
  if (!changedFieldCodes.length) throw fail('调整修订没有修改已申报字段', 422);
  const unrequestedChanges = changedFieldCodes.filter(code => !selected.includes(code));
  if (unrequestedChanges.length) throw fail(`调整修改了未申报字段：${unrequestedChanges.join('、')}`, 422);
  const changedFieldRows = await all(connection, `SELECT id FROM field_definitions WHERE code IN (${changedFieldCodes.map(() => '?').join(',')})`, changedFieldCodes);
  const changedFieldIds = changedFieldRows.map(item => Number(item.id));
  const affectedIndicators = changedFieldIds.length ? await all(connection, `SELECT configuration_json FROM task_indicators
    WHERE task_id=? AND field_definition_id IN (${changedFieldIds.map(() => '?').join(',')})`, [task.id, ...changedFieldIds]) : [];
  const changedDepartmentCodes = new Set();
  for (const indicator of affectedIndicators) {
    let config = {};
    try { config = JSON.parse(indicator.configuration_json || '{}'); } catch { /* malformed configuration was rejected at draft creation */ }
    for (const code of [config.departmentCode,
      ...(Array.isArray(config.departmentCodes) ? config.departmentCodes : []),
      ...(Array.isArray(config.reviewDepartments) ? config.reviewDepartments : [])]) {
      if (typeof code === 'string' && code.trim()) changedDepartmentCodes.add(code.trim());
    }
    if (Number.isSafeInteger(Number(config.ownerOrganizationId))) {
      const owner = await get(connection, `SELECT code FROM organizations WHERE id=? AND organization_type='department' AND status='active'`,
        [Number(config.ownerOrganizationId)]);
      if (owner?.code) changedDepartmentCodes.add(owner.code);
    }
  }
  const departments = [...changedDepartmentCodes].sort();
  if (!departments.length) throw fail('实际修改的指标未配置审核部门', 409);
  const taskDetails = await get(connection, `SELECT rt.cadence FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id WHERE t.id=?`, [task.id]);
  if (taskDetails?.cadence === 'quarterly') {
    if (changedFieldIds.length) {
      const indicatorIds = await all(connection, `SELECT id FROM task_indicators WHERE task_id=?
        AND field_definition_id IN (${changedFieldIds.map(() => '?').join(',')})`, [task.id, ...changedFieldIds]);
      for (const indicator of indicatorIds) {
        await run(connection, 'DELETE FROM quarterly_review_items WHERE revision_id=? AND indicator_id=?', [revisionId, indicator.id]);
        await run(connection, 'DELETE FROM quarterly_indicator_scores WHERE revision_id=? AND indicator_id=?', [revisionId, indicator.id]);
      }
    }
  }
  await run(connection, `UPDATE adjustment_requests SET status='department_review', submitted_at=CURRENT_TIMESTAMP,
    changed_fields_json=?, required_departments_json=?, impact_json=? WHERE id=? AND status='draft'`,
  [JSON.stringify(changedFieldCodes), JSON.stringify(departments), JSON.stringify({ changedValues }), request.id]);
  return { adjustmentRequestId: Number(request.id), changedFields: changedFieldCodes, requiredDepartments: departments, changedValues };
}

async function recordQuarterlyImpacts(connection, request, monthlyTask, newRevisionId) {
  const [year, month] = String(monthlyTask.period_code).split('-').map(Number);
  if (!Number.isInteger(year) || month < 1 || month > 12) return;
  const firstAffectedQuarter = Math.ceil(month / 3);
  const consumers = await all(connection, `SELECT t.id, t.period_code, t.current_revision_id, t.task_status, r.revision_status
    FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id
    LEFT JOIN business_revisions r ON r.id=t.current_revision_id
    WHERE rt.cadence='quarterly' AND t.organization_id=? AND t.period_code LIKE ?`,
  [monthlyTask.organization_id, `${year}-Q%`]);
  for (const consumer of consumers) {
    const consumerQuarter = Number(String(consumer.period_code || '').match(/^\d{4}-Q([1-4])$/)?.[1]);
    if (consumerQuarter < firstAffectedQuarter) continue;
    const finalized = consumer.task_status === 'finalized' || consumer.revision_status === 'finalized';
    await run(connection, `INSERT OR IGNORE INTO monthly_adjustment_impacts
      (adjustment_request_id, monthly_task_id, quarterly_task_id, quarterly_revision_id, status, before_json, after_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [request.id, monthlyTask.id, consumer.id, consumer.current_revision_id,
      finalized ? 'requires_adjustment' : 'pending_confirmation',
      JSON.stringify({ monthlyRevisionId: request.source_revision_id }), JSON.stringify({ monthlyRevisionId: newRevisionId })]);
  }
}

async function confirmQuarterlyImpact({ taskId, impactId, actor }) {
  const connection = await begin();
  try {
    const task = await get(connection, `SELECT t.*, rt.cadence FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id WHERE t.id=?`, [Number(taskId)]);
    if (!task || task.cadence !== 'quarterly') throw fail('季度任务不存在', 404);
    await assertAssignment(connection, task, actor, ['filler', 'submitter'], ['subsidiary_filler', 'subsidiary_submitter']);
    const impact = await get(connection, `SELECT * FROM monthly_adjustment_impacts WHERE id=? AND quarterly_task_id=?`, [Number(impactId), task.id]);
    if (!impact) throw fail('月报调整影响记录不存在', 404);
    if (impact.status === 'requires_adjustment') throw fail('季度报告已定稿，必须另行发起季度调整', 409);
    if (impact.status !== 'pending_confirmation') throw fail('此月报调整影响已确认', 409);
    await run(connection, `UPDATE monthly_adjustment_impacts SET status='confirmed', confirmed_by=?, confirmed_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='pending_confirmation'`, [actor.id, impact.id]);
    await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
      action: 'monthly_adjustment.quarterly_impact_confirmed', objectType: 'monthly_adjustment_impact', objectId: impact.id,
      after: { quarterlyTaskId: task.id, monthlyTaskId: impact.monthly_task_id }, reason: '确认月报调整后的季度差异' });
    await run(connection, 'COMMIT');
    return { impactId: Number(impact.id), status: 'confirmed' };
  } catch (error) {
    await run(connection, 'ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await new Promise(resolve => connection.close(() => resolve()));
  }
}

module.exports = { startMonthlyAdjustment, approveOrRejectMonthlyAdjustment, markAdjustmentSubmitted,
  recordQuarterlyImpacts, confirmQuarterlyImpact, getAdjustmentFields };
