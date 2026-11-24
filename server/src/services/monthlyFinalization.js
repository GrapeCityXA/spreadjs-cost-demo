const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const db = require('../config/database');
const storage = require('../config/storage');
const { recordBusinessAudit } = require('./businessAudit');
const { hasTaskAssignment, taskReviewDepartments } = require('./taskAssignments');
const { loadQuarterlyDependencies } = require('./quarterlyDependencies');
const monthlyAdjustments = require('./monthlyAdjustments');
const checkpointBackups = require('./checkpointBackups');
const { readRevisionWorkbook } = require('./staticWorkbookFile');

const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const run = (connection, sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const fail = (message, status) => Object.assign(new Error(message), { status });

function hasWorkbookPayload(workbook) {
  return Boolean(workbook && typeof workbook === 'object' && (
    workbook.collaborationInfo && workbook.sheets && Object.keys(workbook.sheets).length
    || workbook.activeSheetId && workbook.sheets && Object.keys(workbook.sheets).length
    || workbook.sheets && (Array.isArray(workbook.sheets) ? workbook.sheets.length : Object.keys(workbook.sheets).length)
  ));
}

function templateSnapshotFallback(templateJson) {
  const template = typeof templateJson === 'string' ? JSON.parse(templateJson || '{}') : (templateJson || {});
  return hasWorkbookPayload(template.templateSnapshot) ? template.templateSnapshot : null;
}

async function restoreMissingWorkbook(workbook, templateJson, message = '已提交修订缺少有效的静态工作簿快照') {
  if (hasWorkbookPayload(workbook)) return workbook;
  const fallback = templateSnapshotFallback(templateJson);
  if (fallback) return JSON.parse(JSON.stringify(fallback));
  throw fail(message, 409);
}

const STRUCTURED_VALUES_SQL = `SELECT v.record_key AS recordKey, f.code AS fieldCode,
    f.display_name AS displayName, v.value_type AS valueType, v.text_value AS textValue,
    v.decimal_value AS decimalValue, v.integer_value AS integerValue, v.boolean_value AS booleanValue,
    v.date_value AS dateValue, v.json_value AS jsonValue, v.source_formula AS sourceFormula,
    v.unit_snapshot AS unit, v.precision_snapshot AS precision, v.source_sheet AS sourceSheet,
    v.source_named_area AS sourceNamedArea, v.source_row AS sourceRow, v.source_column AS sourceColumn,
    v.entered_by AS enteredBy
  FROM business_values v JOIN field_definitions f ON f.id = v.field_definition_id
  WHERE v.revision_id = ? ORDER BY f.code, v.record_key`;

async function structuredValues(connection, revisionId) {
  return all(connection, STRUCTURED_VALUES_SQL, [revisionId]);
}

function roleInScope(actor, code, organizationId) {
  return (actor.roles || []).some(role => role.code === code
    && (role.organizationId == null || Number(role.organizationId) === Number(organizationId)));
}

async function reviewerRoleForTask(connection, actorId, organizationId) {
  return get(connection, `SELECT 1 AS allowed FROM effective_user_roles ur
    LEFT JOIN organizations scoped_org ON scoped_org.id = ur.organization_id
    JOIN users u ON u.id = ur.user_id
    WHERE ur.user_id = ? AND ur.role_code = 'department_reviewer' AND ur.effective_from <= CURRENT_TIMESTAMP
      AND (ur.effective_to IS NULL OR ur.effective_to > CURRENT_TIMESTAMP)
      AND (ur.organization_id IS NULL OR ur.organization_id = ?
        OR (scoped_org.organization_type = 'department' AND scoped_org.id = u.organization_id)) LIMIT 1`,
  [actorId, organizationId]);
}

async function reviewDepartmentCode(connection, actorId, task) {
  const department = await get(connection, `SELECT department.code FROM users
    JOIN organizations department ON department.id = users.organization_id
    WHERE users.id = ? AND department.organization_type = 'department' AND department.status = 'active'`, [actorId]);
  return department?.code || task.organization_code;
}

function openBusinessConnection() {
  const connection = new sqlite3.Database(storage.getDatabasePath());
  connection.configure('busyTimeout', 10000);
  return connection;
}

async function taskForReview(taskId, actor, connection = db) {
  const task = await get(connection, `SELECT t.*, p.version AS package_version, rt.cadence,
      rt.display_name AS report_type_name, o.code AS organization_code, o.name AS organization_name,
      r.id AS revision_id, r.revision_number, r.revision_status, r.submitted_by, r.submitted_at,
      r.collaboration_version, r.workbook_artifact_id, wa.storage_key AS workbook_path
    FROM report_tasks t JOIN period_packages p ON p.id = t.package_id
    JOIN report_types rt ON rt.id = t.report_type_id JOIN organizations o ON o.id = t.organization_id
    LEFT JOIN business_revisions r ON r.id = t.current_revision_id
    LEFT JOIN official_artifacts wa ON wa.id = r.workbook_artifact_id
    WHERE t.id = ?`, [taskId]);
  if (!task) throw fail('填报任务不存在', 404);
  if (task.cadence !== 'monthly') throw fail('此工作台仅支持月度审核', 409);
  if (!task.revision_id || !['submitted', 'finalized'].includes(task.revision_status)) throw fail('任务没有可审核或定稿的已提交修订', 409);

  const reviewerRole = await reviewerRoleForTask(connection, actor.id, task.organization_id);
  const managementRole = (actor.roles || []).some(role => role.code === 'management' || role.code === 'system_admin');
  const canReview = reviewerRole && await hasTaskAssignment(connection, task, actor.id, 'department_reviewer');
  const canFinalize = roleInScope(actor, 'report_finalizer', task.organization_id)
    && await hasTaskAssignment(connection, task, actor.id, 'finalizer');
  const canApprove = managementRole && await hasTaskAssignment(connection, task, actor.id, 'approver');
  if (!canReview && !canFinalize && !canApprove && !roleInScope(actor, 'system_admin', task.organization_id)) {
    throw fail('无权访问此任务的审核资料', 403);
  }
  if (!task.workbook_path) throw fail('已提交修订缺少静态工作簿快照', 409);
  return { ...task, canApproveAdjustment: Boolean(canApprove) };
}

async function getMonthlyReview(taskId, actor) {
  if (!Number.isSafeInteger(Number(taskId)) || Number(taskId) < 1) throw fail('任务编号无效', 400);
  const task = await taskForReview(Number(taskId), actor);
  const workbookPath = path.resolve(task.workbook_path);
  // Remote reference data is intentionally absent from the immutable submission.
  // Restore its configuration from the task's pinned template, never the latest version.
  const template = await get(db, 'SELECT workbook_json FROM template_versions WHERE id = ?', [task.template_version_id]);
  const workbook = await restoreMissingWorkbook(await readRevisionWorkbook(workbookPath, task.revision_id), template?.workbook_json);
  const definitions = JSON.parse(template?.workbook_json || '{}').sheets || [];
  const auxiliaryContract = { sheets: Object.values(workbook.sheets || {})
    .sort((a, b) => (a.index ?? a.order ?? 0) - (b.index ?? b.order ?? 0))
    .map(sheet => {
      const definition = definitions.find(item => item.name === sheet.name);
      return definition?.type === 'auxiliary' && definition.dataBinding
        ? { name: sheet.name, type: 'auxiliary', dataBinding: definition.dataBinding,
          rowCount: definition.rowCount, columnCount: definition.columnCount }
        : { name: sheet.name };
    }) };
  const anomalies = await all(db, `SELECT a.id, a.rule_code AS ruleCode, a.field_code AS fieldCode, a.message,
      a.explanation, a.severity, a.disposition, a.sheet_code AS sheetCode, a.row_index AS row,
      a.column_index AS column, a.triggering_value_json AS triggeringValueJson,
      a.comparison_value_json AS comparisonValueJson, a.threshold_json AS thresholdJson,
      reviewer.name AS reviewerName
    FROM anomaly_snapshots a LEFT JOIN users reviewer ON reviewer.id = a.reviewer_id
    WHERE a.revision_id = ? ORDER BY a.id`, [task.revision_id]);
  for (const anomaly of anomalies) {
    anomaly.triggeringValue = JSON.parse(anomaly.triggeringValueJson || 'null');
    anomaly.comparisonValue = JSON.parse(anomaly.comparisonValueJson || 'null');
    anomaly.threshold = JSON.parse(anomaly.thresholdJson || 'null');
    delete anomaly.triggeringValueJson;
    delete anomaly.comparisonValueJson;
    delete anomaly.thresholdJson;
  }
  const opinions = await all(db, `SELECT review_item_key AS reviewItemKey, department_code AS departmentCode,
      reviewer_id AS reviewerId, opinion, disposition, version, updated_at AS updatedAt
    FROM review_opinion_items WHERE revision_id = ? ORDER BY department_code`, [task.revision_id]);
  const reviewDepartment = await reviewDepartmentCode(db, actor.id, task);
  const myOpinion = opinions.find(item => item.reviewItemKey === 'monthly:submission'
    && item.departmentCode === reviewDepartment) || null;
  const attachments = await all(db, `SELECT id, indicator_code AS indicatorCode, original_name AS originalName,
      media_type AS mediaType, byte_size AS byteSize, sha256, uploaded_by AS uploadedBy, created_at AS createdAt
    FROM attachments WHERE revision_id = ? ORDER BY id`, [task.revision_id]);
  const values = await structuredValues(db, task.revision_id);
  const adjustmentRow = await get(db, `SELECT id, source_revision_id AS sourceRevisionId, status, reason,
      changed_fields_json AS changedFieldsJson, required_departments_json AS requiredDepartmentsJson,
      impact_json AS impactJson, requested_by AS requestedBy, approved_by AS approvedBy
    FROM adjustment_requests WHERE task_id = ? AND proposed_revision_id = ?`, [task.id, task.revision_id]);
  const adjustment = adjustmentRow ? { ...adjustmentRow,
    changedFields: JSON.parse(adjustmentRow.changedFieldsJson || '[]'),
    requiredDepartments: JSON.parse(adjustmentRow.requiredDepartmentsJson || '[]'),
    impact: JSON.parse(adjustmentRow.impactJson || '{}'),
    canDecide: task.canApproveAdjustment || (actor.roles || []).some(role => role.code === 'system_admin') } : null;
  return {
    task: { id: task.id, periodCode: task.period_code, status: task.task_status, cadence: task.cadence,
      reportTypeName: task.report_type_name, packageVersion: task.package_version,
      organizationCode: task.organization_code, organizationName: task.organization_name,
      configuration: JSON.parse(task.configuration_snapshot_json || '{}') },
    revision: { id: task.revision_id, number: task.revision_number, status: task.revision_status,
      submittedBy: task.submitted_by, submittedAt: task.submitted_at,
      collaborationVersion: task.collaboration_version },
    workbook,
    auxiliaryContract,
    anomalies,
    opinions,
    myOpinion,
    reviewDepartmentCode: reviewDepartment,
    values,
    attachments,
    adjustment
  };
}

async function assertFinalizationGates(connection, task) {
  if (!['submitted', 'reviewing'].includes(task.task_status)) throw fail('只有已提交或审核中的任务可以定稿', 409);
  const adjustment = await get(connection, `SELECT required_departments_json FROM adjustment_requests
    WHERE task_id = ? AND proposed_revision_id = ? AND status IN ('approved','applied')`, [task.id, task.current_revision_id]);
  const requiredDepartments = adjustment ? JSON.parse(adjustment.required_departments_json || '[]').map(code => ({ code }))
    : await taskReviewDepartments(connection, task);
  const completedDepartments = await all(connection, `SELECT DISTINCT department_code AS code
    FROM review_opinion_items WHERE revision_id = ? AND review_item_key = 'monthly:submission'
      AND disposition IN ('accept','comment')`, [task.current_revision_id]);
  const completed = new Set(completedDepartments.map(row => row.code));
  const missing = requiredDepartments.map(row => row.code).filter(code => !completed.has(code));
  if (missing.length) throw fail(`尚有部门未完成审核：${missing.join('、')}`, 409);
  const openAnomalies = Number((await get(connection, `SELECT COUNT(*) AS count FROM anomaly_snapshots
    WHERE revision_id = ? AND (severity = 'error' OR (severity = 'warning' AND
      (disposition IS NULL OR disposition <> 'accepted' OR TRIM(COALESCE(explanation,'')) = '')))` , [task.current_revision_id])).count);
  if (openAnomalies) throw fail('存在未处理的异常或阻断校验', 409);
  return { requiredDepartments: requiredDepartments.map(row => row.code) };
}

function digest(filePath) {
  return fs.readFile(filePath).then(buffer => ({ sha256: crypto.createHash('sha256').update(buffer).digest('hex'), byteSize: buffer.byteLength }));
}

async function finalizeMonthlyTask({ taskId, actor, xlsxFile, pdfFile }) {
  if (!Number.isSafeInteger(Number(taskId)) || Number(taskId) < 1) throw fail('任务编号无效', 400);
  if (!xlsxFile?.path || !pdfFile?.path) throw fail('定稿必须同时提交 XLSX 和 PDF 文件', 400);
  const connection = openBusinessConnection();
  const createdFiles = [];
  let transactionCommitted = false;
  try {
    await run(connection, 'PRAGMA foreign_keys = ON');
    await run(connection, 'PRAGMA busy_timeout = 10000');
    await run(connection, 'BEGIN IMMEDIATE');
    const task = await get(connection, `SELECT t.*, p.version AS package_version, rt.cadence, rt.display_name AS report_type_name,
        o.code AS organization_code, o.name AS organization_name
      FROM report_tasks t JOIN period_packages p ON p.id = t.package_id JOIN report_types rt ON rt.id = t.report_type_id
      JOIN organizations o ON o.id = t.organization_id WHERE t.id = ?`, [Number(taskId)]);
    if (!task) throw fail('填报任务不存在', 404);
    if (task.cadence === 'quarterly') {
      if (!roleInScope(actor, 'report_finalizer', task.organization_id)) throw fail('当前用户没有定稿角色', 403);
      const quarterlyAssignment = await hasTaskAssignment(connection, task, actor.id, 'finalizer');
      if (!quarterlyAssignment) throw fail('当前用户未被指定为此任务的定稿人', 403);
      const dependencies = await loadQuarterlyDependencies({ taskId: task.id, organizationId: task.organization_id,
        periodCode: task.period_code, configuration: JSON.parse(task.configuration_snapshot_json || '{}') });
      if (!dependencies.complete) {
        const missing = dependencies.missingPeriods.map(item => `${item.periodCode}:${item.status}${item.missingMetrics.length ? `(${item.missingMetrics.join(',')})` : ''}`);
        throw fail(`季度定稿因月报依赖未齐全而被阻止：${missing.join('、')}`, 409);
      }
      throw fail('季度审核、评分与定稿流程由后续季度审核工作流提供', 409);
    }
    if (task.cadence !== 'monthly') throw fail('此接口仅支持月度报表定稿', 409);
    if (!roleInScope(actor, 'report_finalizer', task.organization_id)) throw fail('当前用户没有定稿角色', 403);
    const assignment = await hasTaskAssignment(connection, task, actor.id, 'finalizer');
    if (!assignment) throw fail('当前用户未被指定为此任务的定稿人', 403);
    const revision = await get(connection, `SELECT r.*, a.storage_key AS workbook_path FROM business_revisions r
      LEFT JOIN official_artifacts a ON a.id = r.workbook_artifact_id WHERE r.id = ? AND r.task_id = ?`,
    [task.current_revision_id, task.id]);
    if (!revision || revision.revision_status !== 'submitted') throw fail('当前任务没有可定稿的已提交修订', 409);
    const adjustment = await get(connection, `SELECT * FROM adjustment_requests WHERE task_id = ?
      AND proposed_revision_id = ?`, [task.id, revision.id]);
    if (adjustment && adjustment.status !== 'approved') throw fail('调整修订须先完成部门审核和管理审批', 409);
    const gates = await assertFinalizationGates(connection, task);
    if (!revision.workbook_path) throw fail('已提交修订缺少静态工作簿快照', 409);

    const artifactRoot = storage.getArtifactDirectory();
    await fs.mkdir(artifactRoot, { recursive: true });
    const workbookKey = path.join(artifactRoot, `final-${crypto.randomUUID()}-workbook.json`);
    await fs.copyFile(revision.workbook_path, workbookKey);
    createdFiles.push(workbookKey);
    const structured = await structuredValues(connection, revision.id);
    const structuredKey = path.join(artifactRoot, `final-${crypto.randomUUID()}-data.json`);
    await fs.writeFile(structuredKey, JSON.stringify({ taskId: task.id, revisionId: revision.id, values: structured }), 'utf8');
    createdFiles.push(structuredKey);

    const xlsxKey = path.join(artifactRoot, `final-${crypto.randomUUID()}.xlsx`);
    await fs.copyFile(xlsxFile.path, xlsxKey);
    createdFiles.push(xlsxKey);
    const pdfKey = path.join(artifactRoot, `final-${crypto.randomUUID()}.pdf`);
    await fs.copyFile(pdfFile.path, pdfKey);
    createdFiles.push(pdfKey);
    const fileSpecs = [
      ['finalized_workbook_json', workbookKey], ['finalized_xlsx', xlsxKey],
      ['finalized_pdf', pdfKey], ['structured_data_json', structuredKey]
    ];
    const artifactMetadata = [];
    for (const [artifactType, storageKey] of fileSpecs) {
      const metadata = await digest(storageKey);
      artifactMetadata.push({ artifactType, storageKey, ...metadata });
    }
    const manifest = { schemaVersion: 1, taskId: Number(task.id), revisionId: Number(revision.id),
      revisionNumber: Number(revision.revision_number), reportType: task.report_type_name,
      periodCode: task.period_code, organizationCode: task.organization_code,
      templateVersionId: task.template_version_id, configurationVersion: task.package_version,
      calculationVersion: {
        engine: 'reporting-calculation-v1',
        ruleVersionIds: [...new Set((JSON.parse(task.configuration_snapshot_json || '{}').ruleVersionIds || []).map(Number))].sort((a, b) => a - b)
      },
      spreadJsVersion: '19.1.4', finalizedBy: Number(actor.id), finalizedAt: new Date().toISOString(),
      requiredReviewDepartments: gates.requiredDepartments,
      artifacts: artifactMetadata.map(({ artifactType, sha256, byteSize }) => ({ artifactType, sha256, byteSize })) };
    const manifestKey = path.join(artifactRoot, `final-${crypto.randomUUID()}-manifest.json`);
    await fs.writeFile(manifestKey, JSON.stringify(manifest, null, 2), 'utf8');
    createdFiles.push(manifestKey);
    artifactMetadata.push({ artifactType: 'version_manifest_json', storageKey: manifestKey, ...(await digest(manifestKey)) });
    for (const artifact of artifactMetadata) {
      await run(connection, `INSERT INTO official_artifacts
        (revision_id, artifact_type, storage_key, sha256, byte_size) VALUES (?, ?, ?, ?, ?)`,
      [revision.id, artifact.artifactType, artifact.storageKey, artifact.sha256, artifact.byteSize]);
    }
    await run(connection, 'UPDATE business_revisions SET is_current_effective = 0 WHERE task_id = ? AND is_current_effective = 1', [task.id]);
    await run(connection, `UPDATE business_revisions SET revision_status = 'finalized', is_current_effective = 1,
      finalized_at = CURRENT_TIMESTAMP WHERE id = ? AND revision_status = 'submitted'`, [revision.id]);
    await run(connection, `UPDATE report_tasks SET task_status = 'finalized' WHERE id = ? AND current_revision_id = ?`, [task.id, revision.id]);
    if (adjustment) {
      await monthlyAdjustments.recordQuarterlyImpacts(connection, adjustment, task, revision.id);
      await run(connection, `UPDATE adjustment_requests SET status = 'applied', applied_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'approved'`, [adjustment.id]);
      await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
        action: 'monthly_adjustment.applied', objectType: 'adjustment_request', objectId: adjustment.id,
        businessVersion: String(revision.revision_number), before: { status: 'approved', currentRevisionId: adjustment.source_revision_id },
        after: { status: 'applied', currentRevisionId: revision.id,
          changedFields: JSON.parse(adjustment.changed_fields_json || '[]'),
          changedValues: JSON.parse(adjustment.impact_json || '{}').changedValues || [] }, reason: '调整修订已完成定稿' });
    }
    await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
      action: 'business_revision.finalized', objectType: 'business_revision', objectId: revision.id,
      businessVersion: String(revision.revision_number), before: { taskStatus: task.task_status },
      after: { taskStatus: 'finalized', isCurrentEffective: true, artifactTypes: artifactMetadata.map(item => item.artifactType) },
      reason: '月报审核完成并定稿' });
    await run(connection, 'COMMIT');
    transactionCommitted = true;
    let checkpoint;
    try {
      checkpoint = await checkpointBackups.createCheckpoint({ actor, reason: `月报任务 ${task.id} 修订 ${revision.revision_number} 定稿检查点`,
        finalization: { taskId: Number(task.id), revisionId: Number(revision.id), revisionNumber: Number(revision.revision_number) } });
    } catch (error) {
      checkpoint = error.checkpoint || { id: null, checkpointId: null, status: 'unavailable' };
    }
    return { taskId: Number(task.id), revisionId: Number(revision.id), revisionNumber: Number(revision.revision_number),
      status: 'finalized', isCurrentEffective: true, checkpoint: { id: checkpoint.id, checkpointId: checkpoint.checkpointId,
        status: checkpoint.status || 'complete', ...(checkpoint.id == null ? { reason: checkpoint.reason,
          finalization: checkpoint.finalization } : {}) },
      artifacts: artifactMetadata.map(({ artifactType, sha256, byteSize }) => ({ artifactType, sha256, byteSize })) };
  } catch (error) {
    if (!transactionCommitted) {
      await run(connection, 'ROLLBACK').catch(() => {});
      await Promise.all(createdFiles.map(file => fs.rm(file, { force: true }).catch(() => {})));
    }
    throw error;
  } finally {
    await new Promise(resolve => connection.close(() => resolve()));
  }
}

async function assertTaskReader(taskId, actor) {
  const task = await get(db, `SELECT t.id, t.package_id, t.organization_id, rt.cadence
    FROM report_tasks t JOIN report_types rt ON rt.id = t.report_type_id WHERE t.id = ?`, [taskId]);
  if (!task) throw fail('填报任务不存在', 404);
  const role = ['department_reviewer', 'report_finalizer', 'system_admin', 'management'].some(code => roleInScope(actor, code, task.organization_id))
    || (actor.roles || []).some(item => item.code === 'management');
  const assigned = await Promise.all(['department_reviewer', 'finalizer', 'approver'].map(responsibility =>
    hasTaskAssignment(db, task, actor.id, responsibility))).then(results => results.some(Boolean));
  if (!role || (!assigned && !roleInScope(actor, 'system_admin', task.organization_id))) throw fail('无权访问此任务的定稿资料', 403);
  return task;
}

async function listFinalizedRevisions(taskId, actor) {
  const task = await assertTaskReader(Number(taskId), actor);
  if (task.cadence !== 'monthly') throw fail('此接口仅支持月度报表', 409);
  return all(db, `SELECT r.id, r.revision_number AS revisionNumber, r.finalized_at AS finalizedAt,
      r.is_current_effective AS isCurrentEffective,
      (SELECT COUNT(*) FROM official_artifacts a WHERE a.revision_id = r.id) AS artifactCount
    FROM business_revisions r
    WHERE r.task_id = ? AND r.revision_status = 'finalized' ORDER BY r.revision_number DESC`, [Number(taskId)]);
}

async function getFinalizedRevision(taskId, revisionId, actor) {
  const task = await assertTaskReader(Number(taskId), actor);
  if (task.cadence !== 'monthly') throw fail('此接口仅支持月度报表', 409);
  if (!Number.isSafeInteger(Number(revisionId)) || Number(revisionId) < 1) throw fail('修订编号无效', 400);
  const revision = await get(db, `SELECT r.id, r.task_id AS taskId, r.revision_number AS revisionNumber,
      r.revision_status AS revisionStatus, r.is_current_effective AS isCurrentEffective,
      r.submitted_by AS submittedBy, r.submitted_at AS submittedAt, r.finalized_at AS finalizedAt,
      r.collaboration_version AS collaborationVersion, a.storage_key AS workbookPath,
      t.period_code AS periodCode, t.organization_id AS organizationId, t.template_version_id AS templateVersionId,
      rt.display_name AS reportTypeName, o.code AS organizationCode, o.name AS organizationName
    FROM business_revisions r
    JOIN report_tasks t ON t.id = r.task_id
    JOIN report_types rt ON rt.id = t.report_type_id
    JOIN organizations o ON o.id = t.organization_id
    LEFT JOIN official_artifacts a ON a.revision_id = r.id AND a.artifact_type = 'finalized_workbook_json'
    WHERE r.id = ? AND r.task_id = ? AND r.revision_status = 'finalized'`, [Number(revisionId), Number(taskId)]);
  if (!revision) throw fail('历史定稿修订不存在', 404);
  if (!revision.workbookPath) throw fail('历史定稿缺少静态工作簿', 409);
  const template = await get(db, 'SELECT workbook_json FROM template_versions WHERE id = ?', [revision.templateVersionId]);
  const workbook = await restoreMissingWorkbook(await readRevisionWorkbook(path.resolve(revision.workbookPath), revision.id), template?.workbook_json,
    '历史定稿缺少有效的静态工作簿');
  const opinions = await all(db, `SELECT review_item_key AS reviewItemKey, department_code AS departmentCode,
      opinion, disposition, version, updated_at AS updatedAt
    FROM review_opinion_items WHERE revision_id = ? ORDER BY department_code, review_item_key`, [revision.id]);
  return {
    task: { id: Number(taskId), periodCode: revision.periodCode, organizationId: revision.organizationId,
      organizationCode: revision.organizationCode, organizationName: revision.organizationName,
      reportTypeName: revision.reportTypeName, status: 'finalized' },
    revision: { id: revision.id, number: revision.revisionNumber, status: revision.revisionStatus,
      isCurrentEffective: Boolean(revision.isCurrentEffective), submittedBy: revision.submittedBy,
      submittedAt: revision.submittedAt, finalizedAt: revision.finalizedAt,
      collaborationVersion: revision.collaborationVersion },
    opinions,
    workbook
  };
}

// A task may be reopened for adjustment while its earlier finalized versions
// remain available. List by archived revisions, not by the current task status.
async function listFinalizedTasks(actor) {
  if (!(actor.roles || []).some(role => ['department_reviewer', 'report_finalizer', 'management', 'system_admin'].includes(role.code))) {
    throw fail('需要审核员、审批人或定稿人角色', 403);
  }
  const tasks = await all(db, `SELECT t.id, t.period_code AS periodCode,
      o.name AS organizationName, rt.display_name AS reportTypeName, 'finalized' AS status,
      COALESCE((SELECT fr.id FROM business_revisions fr WHERE fr.task_id = t.id
        AND fr.revision_status = 'finalized' AND fr.is_current_effective = 1
        ORDER BY fr.revision_number DESC LIMIT 1),
        (SELECT fr.id FROM business_revisions fr WHERE fr.task_id = t.id
          AND fr.revision_status = 'finalized' ORDER BY fr.revision_number DESC LIMIT 1)) AS revisionId,
      COALESCE((SELECT fr.revision_number FROM business_revisions fr WHERE fr.task_id = t.id
        AND fr.revision_status = 'finalized' AND fr.is_current_effective = 1
        ORDER BY fr.revision_number DESC LIMIT 1), MAX(r.revision_number)) AS revisionNumber,
      COALESCE((SELECT fr.submitted_at FROM business_revisions fr WHERE fr.task_id = t.id
        AND fr.revision_status = 'finalized' AND fr.is_current_effective = 1
        ORDER BY fr.revision_number DESC LIMIT 1),
        (SELECT fr.submitted_at FROM business_revisions fr WHERE fr.task_id = t.id
          AND fr.revision_status = 'finalized' ORDER BY fr.revision_number DESC LIMIT 1)) AS submittedAt,
      COALESCE((SELECT fr.finalized_at FROM business_revisions fr WHERE fr.task_id = t.id
        AND fr.revision_status = 'finalized' AND fr.is_current_effective = 1
        ORDER BY fr.revision_number DESC LIMIT 1),
        (SELECT fr.finalized_at FROM business_revisions fr WHERE fr.task_id = t.id
          AND fr.revision_status = 'finalized' ORDER BY fr.revision_number DESC LIMIT 1)) AS finalizedAt
    FROM report_tasks t JOIN report_types rt ON rt.id = t.report_type_id
    JOIN organizations o ON o.id = t.organization_id
    JOIN business_revisions r ON r.task_id = t.id AND r.revision_status = 'finalized'
    WHERE rt.cadence = 'monthly'
    GROUP BY t.id ORDER BY t.period_code DESC, o.name, t.id`);
  const visible = [];
  for (const task of tasks) {
    try { await assertTaskReader(task.id, actor); visible.push(task); }
    catch (error) { if (error.status !== 403) throw error; }
  }
  return visible;
}

async function listMonthlyReviewTasks(actor) {
  const isReviewer = (actor.roles || []).some(role => role.code === 'department_reviewer');
  const isFinalizer = (actor.roles || []).some(role => role.code === 'report_finalizer' || role.code === 'system_admin');
  const isManagement = (actor.roles || []).some(role => role.code === 'management');
  if (!isReviewer && !isFinalizer && !isManagement) throw fail('需要审核员、审批人或定稿人角色', 403);
  const tasks = await all(db, `SELECT t.id, t.organization_id AS organizationId, t.package_id AS packageId,
      t.period_code AS periodCode, t.task_status AS status,
      t.deadline_at AS deadlineAt, rt.display_name AS reportTypeName, o.code AS organizationCode,
      o.name AS organizationName, r.id AS revisionId, r.revision_number AS revisionNumber,
      r.revision_status AS revisionStatus
    FROM report_tasks t JOIN report_types rt ON rt.id = t.report_type_id
    JOIN organizations o ON o.id = t.organization_id
    LEFT JOIN business_revisions r ON r.id = t.current_revision_id
    WHERE rt.cadence = 'monthly' AND t.task_status IN ('submitted','reviewing','finalized')
    ORDER BY t.period_code DESC, o.name, t.id`,
  []);
  const visible = [];
  for (const task of tasks) {
    const [reviewAssignment, finalizerAssignment, approverAssignment, reviewerRole] = await Promise.all([
      hasTaskAssignment(db, task.id, actor.id, 'department_reviewer'),
      hasTaskAssignment(db, task.id, actor.id, 'finalizer'),
      hasTaskAssignment(db, task.id, actor.id, 'approver'), reviewerRoleForTask(db, actor.id, task.organizationId)
    ]);
    const canReview = isReviewer && reviewAssignment && reviewerRole;
    const canFinalize = isFinalizer && finalizerAssignment && roleInScope(actor, 'report_finalizer', task.organizationId);
    const isAdmin = (actor.roles || []).some(role => role.code === 'system_admin'
      && (role.organizationId == null || Number(role.organizationId) === Number(task.organizationId)));
    const canDecide = (isManagement || isAdmin) && approverAssignment;
    if (canReview || canFinalize || canDecide || isAdmin) visible.push({ ...task, canReview, canFinalize, canDecide });
  }
  return visible;
}

async function getFinalizedArtifact(taskId, revisionId, artifactType, actor) {
  const task = await assertTaskReader(Number(taskId), actor);
  if (!['monthly', 'quarterly'].includes(task.cadence)
    || !/^(finalized_workbook_json|finalized_xlsx|finalized_pdf|structured_data_json|version_manifest_json)$/.test(artifactType)) {
    throw fail('定稿文件类型无效', 400);
  }
  const artifact = await get(db, `SELECT a.storage_key, a.sha256, a.byte_size, a.artifact_type
    FROM official_artifacts a JOIN business_revisions r ON r.id = a.revision_id
    WHERE r.id = ? AND r.task_id = ? AND r.revision_status = 'finalized' AND a.artifact_type = ?`,
  [Number(revisionId), Number(taskId), artifactType]);
  if (!artifact) throw fail('定稿文件不存在', 404);
  return artifact;
}

module.exports = { getMonthlyReview, finalizeMonthlyTask, assertFinalizationGates, listMonthlyReviewTasks,
  listFinalizedRevisions, getFinalizedRevision, listFinalizedTasks, getFinalizedArtifact };
