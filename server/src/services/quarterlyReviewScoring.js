const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();
const db = require('../config/database');
const storage = require('../config/storage');
const { evaluateExpression } = require('./ruleEvaluator');
const { loadQuarterlyDependencies } = require('./quarterlyDependencies');
const { recordBusinessAudit } = require('./businessAudit');
const checkpointBackups = require('./checkpointBackups');
const { readRevisionWorkbook } = require('./staticWorkbookFile');
const { hasTaskAssignment } = require('./taskAssignments');
const { competitionRanks, weightedScore, redemptionCoefficient } = require('./quarterlyScoreMath');

const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const run = (connection, sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const fail = (message, status) => Object.assign(new Error(message), { status });
const parse = (value, fallback = {}) => { try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; } };

async function saveOfficialArtifact(connection, revisionId, artifactType, { sourcePath, content }, createdFiles) {
  const directory = storage.getArtifactDirectory();
  await fs.mkdir(directory, { recursive: true });
  const extension = artifactType === 'finalized_xlsx' ? '.xlsx'
    : artifactType === 'finalized_pdf' ? '.pdf' : '.json';
  const targetPath = path.join(directory, `quarterly-${crypto.randomUUID()}${extension}`);
  if (sourcePath) await fs.copyFile(sourcePath, targetPath);
  else await fs.writeFile(targetPath, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  createdFiles.push(targetPath);
  const bytes = await fs.readFile(targetPath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const inserted = await run(connection, `INSERT INTO official_artifacts
    (revision_id, artifact_type, storage_key, sha256, byte_size) VALUES (?, ?, ?, ?, ?)`,
  [revisionId, artifactType, targetPath, sha256, bytes.byteLength]);
  return { id: inserted.lastID, artifactType, sha256, byteSize: bytes.byteLength };
}

function roleInScope(actor, code, organizationId) {
  return (actor.roles || []).some(role => role.code === code
    && (role.organizationId == null || Number(role.organizationId) === Number(organizationId)));
}

function hasRole(actor, code, organizationId) {
  return (actor.roles || []).some(role => role.code === code
    && (organizationId == null || role.organizationId == null || Number(role.organizationId) === Number(organizationId)));
}

async function canFinalizeQuarterlyPackage(task, actor, connection = db) {
  if ((actor.roles || []).some(role => role.code === 'system_admin' && role.organizationId == null)) return true;
  const organizations = await all(connection, `SELECT t.id AS taskId, t.organization_id AS organizationId
    FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id
    WHERE t.package_id=? AND rt.cadence='quarterly'`, [task.package_id]);
  const assignments = await Promise.all(organizations.map(item => hasTaskAssignment(connection, item.taskId, actor.id, 'finalizer')));
  return organizations.length > 0 && organizations.every((item, index) => assignments[index]
    && roleInScope(actor, 'report_finalizer', Number(item.organizationId)));
}

function openBusinessConnection() {
  const connection = new sqlite3.Database(storage.getDatabasePath());
  connection.configure('busyTimeout', 10000);
  return connection;
}

async function fetchTask(taskId, connection = db) {
  const task = await get(connection, `SELECT t.*, p.version AS package_version, rt.cadence, rt.display_name AS report_type_name,
      o.code AS organization_code, o.name AS organization_name,
      r.id AS revision_id, r.revision_number, r.revision_status, r.submitted_by, r.submitted_at,
      r.collaboration_version, r.workbook_artifact_id, wa.storage_key AS workbook_path
    FROM report_tasks t JOIN period_packages p ON p.id = t.package_id
    JOIN report_types rt ON rt.id = t.report_type_id JOIN organizations o ON o.id = t.organization_id
    LEFT JOIN business_revisions r ON r.id = t.current_revision_id
    LEFT JOIN official_artifacts wa ON wa.id = r.workbook_artifact_id
    WHERE t.id = ?`, [Number(taskId)]);
  if (!task) throw fail('填报任务不存在', 404);
  if (task.cadence !== 'quarterly') throw fail('此工作台仅支持季度审核与评分', 409);
  if (!task.revision_id || !['submitted', 'finalized'].includes(task.revision_status)) throw fail('任务没有可审核或定稿的已提交修订', 409);
  if (!task.workbook_path) throw fail('已提交修订缺少静态工作簿快照', 409);
  return task;
}

async function taskIndicators(task, connection = db) {
  const rows = await all(connection, `SELECT id, field_definition_id AS fieldDefinitionId, indicator_code AS code, display_name AS displayName, indicator_type AS type,
      weight, sort_order AS sortOrder, configuration_json AS configurationJson
    FROM task_indicators WHERE task_id = ? ORDER BY sort_order, id`, [task.id]);
  return rows.map(row => ({ ...row, id: Number(row.id), configuration: parse(row.configurationJson) }));
}

async function dataAdjustmentForRevision(task, revisionId, connection = db) {
  const row = await get(connection, `SELECT id, source_revision_id AS sourceRevisionId, status, reason, changed_fields_json AS changedFieldsJson,
      required_departments_json AS requiredDepartmentsJson, impact_json AS impactJson,
      requested_by AS requestedBy, approved_by AS approvedBy, applied_at AS appliedAt
    FROM adjustment_requests WHERE task_id=? AND proposed_revision_id=?`, [task.id, revisionId]);
  return row ? { ...row, changedFields: parse(row.changedFieldsJson, []),
    requiredDepartments: parse(row.requiredDepartmentsJson, []), impact: parse(row.impactJson) } : null;
}

async function adjustedIndicators(task, adjustment, indicators, connection = db) {
  if (!adjustment) return [];
  const fieldCodes = adjustment.changedFields || [];
  if (!fieldCodes.length) return [];
  const fields = await all(connection, `SELECT id FROM field_definitions WHERE code IN (${fieldCodes.map(() => '?').join(',')})`, fieldCodes);
  const fieldIds = new Set(fields.map(item => Number(item.id)));
  return indicators.filter(item => fieldIds.has(Number(item.fieldDefinitionId)));
}

async function assignedCapabilities(task, actor, indicators, connection = db) {
  const role = code => roleInScope(actor, code, task.organization_id);
  const assignment = responsibility => hasTaskAssignment(connection, task, actor.id, responsibility);
  const isAdmin = role('system_admin');
  const [scorerAssignment, approverAssignment, finalizerAssignment] = await Promise.all([
    assignment('scorer'), assignment('approver'), assignment('finalizer')
  ]);
  const isScorer = Boolean(scorerAssignment && (role('score_editor') || isAdmin));
  const isApprover = Boolean(approverAssignment && (role('management') || isAdmin));
  const isFinalizer = Boolean(finalizerAssignment && (role('report_finalizer') || isAdmin));
  const isGlobalAdmin = (actor.roles || []).some(item => item.code === 'system_admin' && item.organizationId == null);
  const canFinalizePackage = isGlobalAdmin || (isFinalizer && await canFinalizeQuarterlyPackage(task, actor, connection));
  const isManagementReader = isScorer || isApprover || isFinalizer;
  const assignedTaskReviewer = await hasTaskAssignment(connection, task, actor.id, 'department_reviewer');
  const reviewIndicators = assignedTaskReviewer ? indicators.filter(indicator =>
    hasRole(actor, 'department_reviewer', indicator.configuration.ownerOrganizationId) || isAdmin) : [];
  const canReview = reviewIndicators.length > 0;
  if (!isManagementReader && !canReview) throw fail('无权访问此任务的季度审核资料', 403);
  return { isAdmin, isScorer, isApprover, isFinalizer, canFinalizePackage, isManagementReader, canReview,
    reviewIndicators: isManagementReader ? indicators : reviewIndicators };
}

function filterWorkbookForReviewer(workbook, allIndicators, allowedIndicators) {
  const result = JSON.parse(JSON.stringify(workbook || {}));
  result.sheets = (result.sheets || []).filter(sheet => sheet.code !== 'quarterly_economics');
  const allowed = new Set(allowedIndicators.map(item => Number(item.id)));
  const allowedRows = new Set();
  const headerRows = new Set();
  const groups = new Map();
  allIndicators.forEach((indicator, index) => {
    const key = indicator.configuration.namedArea;
    if (!key) return;
    const group = groups.get(key) || [];
    group.push({ indicator, index: group.length });
    groups.set(key, group);
  });
  for (const [namedArea, entries] of groups) {
    for (const sheet of result.sheets || []) {
      const mapping = (sheet.mappings || []).find(item => item.namedArea === namedArea);
      if (!mapping) continue;
      headerRows.add(`${sheet.code}:${Number(mapping.row)}`);
      entries.forEach(({ indicator, index }) => {
        const rowKey = `${sheet.code}:${Number(mapping.row) + index + 1}`;
        if (allowed.has(Number(indicator.id))) allowedRows.add(rowKey);
      });
    }
  }
  for (const sheet of result.sheets || []) {
    sheet.cells = (sheet.cells || []).map(cell => {
      const row = Number(cell.row);
      const rowKey = `${sheet.code}:${row}`;
      if (row === 0 || allowedRows.has(rowKey) || headerRows.has(rowKey)) return cell;
      const copy = { ...cell };
      for (const key of ['value', 'formula', 'formulaInfo', 'tag', 'dataSource', 'text']) delete copy[key];
      return copy;
    });
  }
  return result;
}

async function finalizedDependencySnapshot(task, connection = db) {
  if (task.revision_status !== 'finalized' || !task.revision_id) return null;
  const artifact = await get(connection, `SELECT storage_key AS storageKey FROM official_artifacts
    WHERE revision_id=? AND artifact_type='version_manifest_json' ORDER BY id DESC LIMIT 1`, [task.revision_id]);
  if (!artifact?.storageKey) return null;
  try {
    const manifest = JSON.parse(await fs.readFile(artifact.storageKey, 'utf8'));
    if (Number(manifest.taskId) !== Number(task.id) || Number(manifest.revisionId) !== Number(task.revision_id)) return null;
    return manifest.quarterlyDependencies || null;
  } catch { return null; }
}

async function calculateAutomaticScores(task, revisionId, indicators, existingScores, connection = db, dependencySnapshot = null) {
  const values = await all(connection, `SELECT f.code AS fieldCode, v.decimal_value AS decimalValue,
      v.integer_value AS integerValue, v.text_value AS textValue, v.json_value AS jsonValue
    FROM business_values v JOIN field_definitions f ON f.id = v.field_definition_id WHERE v.revision_id = ?`, [revisionId]);
  const input = {};
  for (const value of values) {
    input[value.fieldCode] = value.decimalValue != null ? Number(value.decimalValue)
      : value.integerValue != null ? Number(value.integerValue) : value.textValue ?? parse(value.jsonValue, null);
  }
  const configuration = parse(task.configuration_snapshot_json);
  const dependencies = dependencySnapshot || await loadQuarterlyDependencies({ taskId: task.id, organizationId: task.organization_id,
    periodCode: task.period_code, configuration });
  input.QUARTER_REVENUE = dependencies.currentQuarter?.revenue?.value ?? null;
  input.QUARTER_PROFIT = dependencies.currentQuarter?.profit?.value ?? null;
  input.YTD_REVENUE = dependencies.yearToDate?.revenue?.value ?? null;
  input.YTD_PROFIT = dependencies.yearToDate?.profit?.value ?? null;
  input.revenue = input.QUARTER_REVENUE;
  input.profit = input.QUARTER_PROFIT;
  input.yearToDateRevenue = input.YTD_REVENUE;
  input.yearToDateProfit = input.YTD_PROFIT;
  const stored = new Map(existingScores.map(score => [Number(score.indicatorId), score]));
  const scores = [];
  for (const indicator of indicators) {
    const config = indicator.configuration;
    const prior = stored.get(Number(indicator.id));
    if (config.exempt === true || config.isExempt === true) {
      scores.push({ indicatorId: indicator.id, score: Number(config.maximumScore), scoreSource: 'exempt', formulaVersionId: null, version: prior?.version || 0 });
      continue;
    }
    const formulaVersionId = Number(config.scoreFormulaVersionId ?? config.formulaVersionId ?? 0) || null;
    if (!formulaVersionId) {
      scores.push(prior || { indicatorId: indicator.id, score: null, scoreSource: 'manual', formulaVersionId: null, version: 0 });
      continue;
    }
    const formula = await get(connection, `SELECT rv.id, rv.expression_json AS expressionJson, rv.parameters_json AS parametersJson,
        rd.rule_type AS ruleType FROM rule_versions rv JOIN rule_definitions rd ON rd.id = rv.rule_id WHERE rv.id = ?`, [formulaVersionId]);
    if (!formula || formula.ruleType !== 'formula') throw fail(`指标 ${indicator.displayName} 的自动评分公式快照无效`, 409);
    let computed;
    try { computed = evaluateExpression(parse(formula.expressionJson, null), input, parse(formula.parametersJson)); }
    catch (error) { throw fail(`指标 ${indicator.displayName} 的自动评分计算失败：${error.message}`, 409); }
    if (computed == null) {
      scores.push({ indicatorId: indicator.id, score: null, scoreSource: 'formula', formulaVersionId, version: prior?.version || 0 });
      continue;
    }
    const numeric = Number(computed);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > Number(config.maximumScore)) {
      throw fail(`指标 ${indicator.displayName} 的自动评分结果超出 0 至最高分范围`, 409);
    }
    scores.push({ indicatorId: indicator.id, score: numeric, scoreSource: 'formula', formulaVersionId, version: prior?.version || 0 });
  }
  return { scores, dependencies };
}

async function getQuarterlyReview(taskId, actor, { includeWorkbook = true } = {}) {
  const task = await fetchTask(taskId);
  const indicators = await taskIndicators(task);
  const access = await assignedCapabilities(task, actor, indicators);
  const authorizedIds = new Set(access.reviewIndicators.map(item => item.id));
  // Result refreshes keep the existing preview; avoid reading and copying its snapshot.
  let visibleWorkbook;
  if (includeWorkbook) {
    const workbook = await readRevisionWorkbook(task.workbook_path, task.revision_id);
    visibleWorkbook = access.isManagementReader ? workbook : filterWorkbookForReviewer(workbook, indicators, access.reviewIndicators);
  }
  const reviewRows = await all(db, `SELECT indicator_id AS indicatorId, reviewer_id AS reviewerId, status, opinion,
      remediation_deadline AS remediationDeadline, version, updated_at AS updatedAt
    FROM quarterly_review_items WHERE revision_id = ?`, [task.revision_id]);
  const reviewsById = new Map(reviewRows.map(row => [Number(row.indicatorId), row]));
  const scoreRows = await all(db, `SELECT indicator_id AS indicatorId, score_decimal AS score, score_source AS scoreSource,
      formula_version_id AS formulaVersionId, comment, version, updated_at AS updatedAt
    FROM quarterly_indicator_scores WHERE revision_id = ?`, [task.revision_id]);
  const dependencySnapshot = await finalizedDependencySnapshot(task);
  const automatic = await calculateAutomaticScores(task, task.revision_id, indicators, scoreRows, db, dependencySnapshot);
  const scoresById = new Map(automatic.scores.map(row => [Number(row.indicatorId), row]));
  const adjustments = await all(db, `SELECT a.id, a.adjustment_type AS adjustmentType, a.amount_decimal AS amount,
      a.reason, a.status, a.requested_by AS requestedBy, requester.name AS requesterName,
      a.decided_by AS decidedBy, decider.name AS deciderName, a.decision_note AS decisionNote, a.created_at AS createdAt
    FROM quarterly_adjustment_requests a LEFT JOIN users requester ON requester.id = a.requested_by
    LEFT JOIN users decider ON decider.id = a.decided_by WHERE a.revision_id = ? ORDER BY a.id`, [task.revision_id]);
  const dataAdjustment = await dataAdjustmentForRevision(task, task.revision_id);
  if (dataAdjustment) {
    const affected = await adjustedIndicators(task, dataAdjustment, indicators);
    dataAdjustment.affectedIndicatorIds = affected.map(item => Number(item.id));
  }
  let visibleDataAdjustment = dataAdjustment;
  if (dataAdjustment && !access.isManagementReader) {
    const reviewed = new Set(access.reviewIndicators.map(item => Number(item.id)));
    const visibleAffected = dataAdjustment.affectedIndicatorIds.filter(id => reviewed.has(Number(id)));
    if (!visibleAffected.length) visibleDataAdjustment = null;
    else {
      const visibleFields = await all(db, `SELECT DISTINCT f.code FROM task_indicators i
        JOIN field_definitions f ON f.id=i.field_definition_id WHERE i.id IN (${visibleAffected.map(() => '?').join(',')})`, visibleAffected);
      const visibleCodes = new Set(visibleFields.map(item => item.code));
      visibleDataAdjustment = { ...dataAdjustment, affectedIndicatorIds: visibleAffected,
        changedFields: dataAdjustment.changedFields.filter(code => visibleCodes.has(code)) };
    }
  }
  const visibleIndicators = access.isManagementReader ? indicators : access.reviewIndicators;
  const visibleScores = visibleIndicators.map(indicator => ({ ...indicator,
    review: reviewsById.get(indicator.id) || { indicatorId: indicator.id, reviewerId: indicator.configuration.reviewerUserId,
      status: 'pending', opinion: '', remediationDeadline: null, version: 0 },
    scoring: scoresById.get(indicator.id) || null }));
  const scoreSummary = weightedScore(indicators, automatic.scores, adjustments);
  const anomalyRows = await all(db, `SELECT id, rule_code AS ruleCode, field_code AS fieldCode, message, explanation,
      severity, disposition, sheet_code AS sheetCode, row_index AS row, column_index AS column
    FROM anomaly_snapshots WHERE revision_id=? ORDER BY id`, [task.revision_id]);
  const allowedCodes = new Set(visibleIndicators.map(item => item.code));
  const attachments = await all(db, `SELECT id, indicator_code AS indicatorCode, original_name AS originalName,
      media_type AS mediaType, byte_size AS byteSize, sha256, uploaded_by AS uploadedBy, created_at AS createdAt
    FROM attachments WHERE revision_id=? ORDER BY id`, [task.revision_id]);
  const visibleAttachments = access.isManagementReader ? attachments
    : attachments.filter(file => !file.indicatorCode || allowedCodes.has(file.indicatorCode));
  const rankings = await all(db, `SELECT rank, organization_id AS organizationId, organization.name AS organizationName,
      score_decimal AS totalScore, redemption_coefficient_decimal AS redemptionCoefficient
    FROM report_rankings JOIN organizations organization ON organization.id=report_rankings.organization_id
    WHERE package_id=? AND ranking_type='quarterly' ORDER BY rank, organization.name`, [task.package_id]);
  const officialArtifacts = (access.isFinalizer || access.isAdmin) && task.revision_status === 'finalized'
    ? await all(db, `SELECT artifact_type AS artifactType, sha256, byte_size AS byteSize
      FROM official_artifacts WHERE revision_id=? AND artifact_type IN
        ('finalized_workbook_json','finalized_xlsx','finalized_pdf','structured_data_json','version_manifest_json') ORDER BY id`,
    [task.revision_id]) : [];
  const reviewerTaskConfiguration = {
    packageVersion: task.package_version,
    reportTypeId: task.report_type_id,
    periodCode: task.period_code,
    workflowProfile: parse(task.configuration_snapshot_json).workflowProfile
  };
  return {
    task: { id: task.id, periodCode: task.period_code, status: task.task_status, cadence: task.cadence,
      reportTypeName: task.report_type_name, packageVersion: task.package_version,
      organizationCode: task.organization_code, organizationName: task.organization_name,
      configuration: access.isManagementReader ? parse(task.configuration_snapshot_json) : reviewerTaskConfiguration },
    revision: { id: task.revision_id, number: task.revision_number, status: task.revision_status,
      submittedBy: task.submitted_by, submittedAt: task.submitted_at,
      collaborationVersion: task.collaboration_version },
    ...(includeWorkbook ? { workbook: visibleWorkbook } : {}),
    anomalies: access.isManagementReader ? anomalyRows : anomalyRows.filter(item => visibleIndicators.some(indicator => indicator.code === item.fieldCode)),
    attachments: visibleAttachments,
    officialArtifacts,
    rankings: access.isManagementReader ? rankings : [],
    indicators: visibleScores,
    adjustments: access.isManagementReader ? adjustments : [],
    dataAdjustment: visibleDataAdjustment,
    scoreSummary: access.isManagementReader ? scoreSummary : null,
    quarterlyDependencies: access.isManagementReader ? automatic.dependencies : null,
    quarterlyDependenciesSnapshotted: access.isManagementReader ? Boolean(dependencySnapshot) : undefined,
    permissions: { ...access, canFinalize: access.canFinalizePackage, reviewIndicators: undefined, isAdmin: undefined },
    allReviewItems: access.isManagementReader ? indicators.map(item => ({ indicatorId: item.id,
      indicatorCode: item.code, displayName: item.displayName, ownerOrganizationId: item.configuration.ownerOrganizationId,
      departmentReviewerId: item.configuration.reviewerUserId,
      ...(reviewsById.get(item.id) || { status: 'pending', version: 0 }) })) : undefined
  };
}

async function listQuarterlyReviewTasks(actor) {
  const roles = new Set((actor.roles || []).map(role => role.code));
  const admin = roles.has('system_admin');
  const canListReviews = roles.has('department_reviewer') || admin;
  const canScore = roles.has('score_editor') || admin;
  const canApprove = roles.has('management') || admin;
  const canFinalize = roles.has('report_finalizer') || admin;
  if (!canListReviews && !canScore && !canApprove && !canFinalize) throw fail('需要季度审核、评分或定稿权限', 403);
  const tasks = await all(db, `SELECT t.id, t.package_id AS packageId, t.organization_id AS organizationId,
      t.period_code AS periodCode, t.task_status AS status, t.deadline_at AS deadlineAt,
      rt.display_name AS reportTypeName, o.code AS organizationCode, o.name AS organizationName,
      r.id AS revisionId, r.revision_number AS revisionNumber, r.revision_status AS revisionStatus
    FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id JOIN organizations o ON o.id=t.organization_id
    LEFT JOIN business_revisions r ON r.id=t.current_revision_id
    WHERE rt.cadence='quarterly' AND t.task_status IN ('submitted','reviewing','finalized')
    ORDER BY t.period_code DESC,o.name,t.id`);
  const visibleTasks = [];
  for (const task of tasks) {
    const scopedTask = { ...task, package_id: task.packageId, organization_id: task.organizationId };
    const indicators = await taskIndicators(scopedTask);
    let access;
    try { access = await assignedCapabilities(scopedTask, actor, indicators); }
    catch (error) { if (error.status === 403) continue; throw error; }
    visibleTasks.push({ ...task, canReview: access.canReview,
      canScore: access.isScorer, canApprove: access.isApprover, canFinalize: access.canFinalizePackage });
  }
  return visibleTasks;
}

async function saveIndicatorReview({ taskId, indicatorId, actor, expectedVersion, status, opinion, remediationDeadline }) {
  if (!['in_review', 'approved', 'returned'].includes(status)) throw fail('审核状态无效', 400);
  const text = String(opinion || '').trim();
  if (!text || text.length > 2000) throw fail('审核意见必填，最多 2000 字', 400);
  let deadline = null;
  if (status === 'returned') {
    if (typeof remediationDeadline !== 'string' || remediationDeadline.length > 80
      || !/(Z|[+-]\d{2}:\d{2})$/.test(remediationDeadline) || !Number.isFinite(Date.parse(remediationDeadline))) {
      throw fail('退回必须填写带上海时区的有效整改截止时间', 400);
    }
    deadline = new Date(remediationDeadline).toISOString();
  }
  const connection = openBusinessConnection();
  try {
    await run(connection, 'PRAGMA foreign_keys=ON');
    await run(connection, 'ATTACH DATABASE ? AS quarterly_collab', [storage.getCollaborationDatabasePath()]);
    await run(connection, 'BEGIN IMMEDIATE');
    const task = await fetchTask(taskId, connection);
    if (task.revision_status !== 'submitted') throw fail('已定稿修订不能更改审核事项', 409);
    const indicators = await taskIndicators(task, connection);
    const indicator = indicators.find(item => item.id === Number(indicatorId));
    if (!indicator) throw fail('指标不存在', 404);
    const dataAdjustment = await dataAdjustmentForRevision(task, task.revision_id, connection);
    const correctionIndicators = await adjustedIndicators(task, dataAdjustment, indicators, connection);
    if (dataAdjustment && dataAdjustment.status !== 'department_review') throw fail('此调整已进入管理审批或已结束，指标审核已锁定', 409);
    if (dataAdjustment && !correctionIndicators.some(item => item.id === indicator.id)) {
      throw fail('本次调整仅要求复核受影响的季度指标', 403);
    }
    const assigned = await hasTaskAssignment(connection, task, actor.id, 'department_reviewer');
    if ((Number(indicator.configuration.reviewerUserId) !== Number(actor.id) && !assigned)
      || (!hasRole(actor, 'department_reviewer', indicator.configuration.ownerOrganizationId)
        && !roleInScope(actor, 'system_admin', task.organization_id))) throw fail('当前用户不是该指标的指定审核人', 403);
    if (!assigned && !roleInScope(actor, 'system_admin', task.organization_id)) throw fail('当前用户未被分配此季度审核任务', 403);
    const current = await get(connection, 'SELECT version FROM quarterly_review_items WHERE revision_id=? AND indicator_id=?',
      [task.revision_id, indicator.id]);
    const version = Number(current?.version || 0);
    if (Number(expectedVersion) !== version) throw fail('审核事项已被其他用户更新，请刷新后重试', 409);
    await run(connection, `INSERT INTO quarterly_review_items
      (revision_id, indicator_id, reviewer_id, status, opinion, remediation_deadline, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(revision_id, indicator_id) DO UPDATE SET status=excluded.status, opinion=excluded.opinion,
        remediation_deadline=excluded.remediation_deadline, version=quarterly_review_items.version+1, updated_at=CURRENT_TIMESTAMP`,
    [task.revision_id, indicator.id, actor.id, status, text, deadline]);
    if (dataAdjustment && status === 'returned') {
      await run(connection, `UPDATE adjustment_requests SET status='rejected', rejected_at=CURRENT_TIMESTAMP,
        impact_json=? WHERE id=? AND status='department_review'`,
      [JSON.stringify({ ...dataAdjustment.impact, departmentReturnNote: text }), dataAdjustment.id]);
      await run(connection, `UPDATE business_revisions SET revision_status='rejected' WHERE id=? AND revision_status='submitted'`, [task.revision_id]);
      await run(connection, `UPDATE report_tasks SET task_status='finalized', current_revision_id=? WHERE id=?`,
        [dataAdjustment.sourceRevisionId, task.id]);
      await run(connection, `UPDATE collaboration_rooms SET room_status='closed', closed_at=CURRENT_TIMESTAMP
        WHERE task_id=? AND revision_number=(SELECT MAX(revision_number) FROM collaboration_rooms WHERE task_id=?)`, [task.id, task.id]);
      await run(connection, `UPDATE quarterly_collab.collaboration_rooms SET room_status='closed' WHERE task_id=?
        AND revision_number=(SELECT MAX(revision_number) FROM quarterly_collab.collaboration_rooms WHERE task_id=?)`, [task.id, task.id]);
      await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
        action: 'quarterly_adjustment.rejected', objectType: 'adjustment_request', objectId: dataAdjustment.id,
        before: { status: 'department_review', proposedRevisionId: task.revision_id },
        after: { status: 'rejected', currentEffectiveRevisionId: dataAdjustment.sourceRevisionId }, reason: text });
    } else {
      await run(connection, `UPDATE report_tasks SET task_status='reviewing' WHERE id=? AND task_status='submitted'`, [task.id]);
      if (dataAdjustment && status === 'approved') {
        const completed = await all(connection, `SELECT indicator_id AS indicatorId FROM quarterly_review_items
          WHERE revision_id=? AND status='approved'`, [task.revision_id]);
        const completedIds = new Set(completed.map(item => Number(item.indicatorId)));
        if (correctionIndicators.every(item => completedIds.has(item.id))) {
          await run(connection, `UPDATE adjustment_requests SET status='management_approval'
            WHERE id=? AND status='department_review'`, [dataAdjustment.id]);
          await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
            action: 'quarterly_adjustment.department_review_completed', objectType: 'adjustment_request', objectId: dataAdjustment.id,
            before: { status: 'department_review' }, after: { status: 'management_approval', affectedIndicators: correctionIndicators.map(item => item.code) },
            reason: '全部受影响指标已通过部门审核' });
        }
      }
    }
    await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
      action: 'quarterly_review_item.updated', objectType: 'quarterly_review_item', objectId: `${task.revision_id}:${indicator.id}`,
      before: { status: current ? 'updated' : 'pending', version }, after: { status, opinion: text,
        remediationDeadline: deadline, version: version + 1 } });
    await run(connection, 'COMMIT');
    return { indicatorId: indicator.id, status, version: version + 1 };
  } catch (error) { await run(connection, 'ROLLBACK').catch(() => {}); throw error; }
  finally { await new Promise(resolve => connection.close(() => resolve())); }
}

async function assertScorer(task, actor, connection) {
  if (!roleInScope(actor, 'score_editor', task.organization_id) && !roleInScope(actor, 'system_admin', task.organization_id)) throw fail('需要评分权限', 403);
  const assigned = await hasTaskAssignment(connection, task, actor.id, 'scorer');
  if (!assigned && !roleInScope(actor, 'system_admin', task.organization_id)) throw fail('当前用户未被指定为此任务的评分人', 403);
}

async function saveIndicatorScore({ taskId, indicatorId, actor, expectedVersion, score, comment }) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) throw fail('评分必须是有效数值', 400);
  const connection = openBusinessConnection();
  try {
    await run(connection, 'PRAGMA foreign_keys=ON'); await run(connection, 'BEGIN IMMEDIATE');
    const task = await fetchTask(taskId, connection);
    if (task.revision_status !== 'submitted') throw fail('已定稿修订不能更改评分', 409);
    await assertScorer(task, actor, connection);
    const indicators = await taskIndicators(task, connection);
    const indicator = indicators.find(item => item.id === Number(indicatorId));
    if (!indicator) throw fail('指标不存在', 404);
    const config = indicator.configuration;
    if (Number(config.scoreFormulaVersionId ?? config.formulaVersionId ?? 0) || config.exempt || config.isExempt) {
      throw fail('自动评分或豁免指标不能手工录入分数', 409);
    }
    if (numeric < 0 || numeric > Number(config.maximumScore)) throw fail(`分数必须在 0 至 ${config.maximumScore} 之间`, 400);
    const dependency = await loadQuarterlyDependencies({ taskId: task.id, organizationId: task.organization_id,
      periodCode: task.period_code, configuration: parse(task.configuration_snapshot_json) });
    if (!dependency.complete) throw fail('月报依赖未齐全，暂不能评分', 409);
    const prior = await get(connection, 'SELECT version FROM quarterly_indicator_scores WHERE revision_id=? AND indicator_id=?',
      [task.revision_id, indicator.id]);
    const version = Number(prior?.version || 0);
    if (Number(expectedVersion) !== version) throw fail('评分已被其他用户更新，请刷新后重试', 409);
    await run(connection, `INSERT INTO quarterly_indicator_scores
      (revision_id, indicator_id, scorer_id, score_decimal, score_source, comment, version, updated_at)
      VALUES (?, ?, ?, ?, 'manual', ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(revision_id, indicator_id) DO UPDATE SET scorer_id=excluded.scorer_id,
        score_decimal=excluded.score_decimal, comment=excluded.comment, version=quarterly_indicator_scores.version+1,
        updated_at=CURRENT_TIMESTAMP`, [task.revision_id, indicator.id, actor.id, String(numeric), String(comment || '').trim().slice(0, 2000) || null]);
    await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
      action: 'quarterly_indicator_score.updated', objectType: 'quarterly_indicator_score', objectId: `${task.revision_id}:${indicator.id}`,
      before: prior ? { version } : null, after: { score: numeric, version: version + 1 } });
    await run(connection, 'COMMIT');
    return { indicatorId: indicator.id, score: numeric, version: version + 1 };
  } catch (error) { await run(connection, 'ROLLBACK').catch(() => {}); throw error; }
  finally { await new Promise(resolve => connection.close(() => resolve())); }
}

async function addAdjustment({ taskId, actor, adjustmentType, amount, reason }) {
  if (!['reward', 'penalty'].includes(adjustmentType)) throw fail('奖惩类型无效', 400);
  const numeric = Number(amount);
  const explanation = String(reason || '').trim();
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 10000 || !explanation || explanation.length > 1000) {
    throw fail('奖惩金额须大于 0 且不超过 10000，原因必填且最多 1000 字', 400);
  }
  const connection = openBusinessConnection();
  try {
    await run(connection, 'PRAGMA foreign_keys=ON'); await run(connection, 'BEGIN IMMEDIATE');
    const task = await fetchTask(taskId, connection);
    await assertScorer(task, actor, connection);
    if (task.revision_status !== 'submitted') throw fail('已定稿修订不能新增奖惩', 409);
    const dependency = await loadQuarterlyDependencies({ taskId: task.id, organizationId: task.organization_id,
      periodCode: task.period_code, configuration: parse(task.configuration_snapshot_json) });
    if (!dependency.complete) throw fail('月报依赖未齐全，暂不能提交奖惩', 409);
    const inserted = await run(connection, `INSERT INTO quarterly_adjustment_requests
      (revision_id, adjustment_type, amount_decimal, reason, requested_by) VALUES (?, ?, ?, ?, ?)`,
    [task.revision_id, adjustmentType, String(numeric), explanation, actor.id]);
    await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
      action: 'quarterly_adjustment.proposed', objectType: 'quarterly_adjustment_request', objectId: inserted.lastID,
      after: { adjustmentType, amount: numeric, reason: explanation, status: 'pending' } });
    await run(connection, 'COMMIT');
    return { id: inserted.lastID, status: 'pending' };
  } catch (error) { await run(connection, 'ROLLBACK').catch(() => {}); throw error; }
  finally { await new Promise(resolve => connection.close(() => resolve())); }
}

async function decideAdjustment({ taskId, adjustmentId, actor, decision, note }) {
  if (!['approved', 'rejected'].includes(decision)) throw fail('奖惩审批决定无效', 400);
  const connection = openBusinessConnection();
  try {
    await run(connection, 'PRAGMA foreign_keys=ON'); await run(connection, 'BEGIN IMMEDIATE');
    const task = await fetchTask(taskId, connection);
    if (!roleInScope(actor, 'management', task.organization_id) && !roleInScope(actor, 'system_admin', task.organization_id)) throw fail('需要管理审批权限', 403);
    const assignment = await hasTaskAssignment(connection, task, actor.id, 'approver');
    if (!assignment && !roleInScope(actor, 'system_admin', task.organization_id)) throw fail('当前用户未被指定为此任务的审批人', 403);
    const result = await run(connection, `UPDATE quarterly_adjustment_requests SET status=?, decided_by=?, decision_note=?, decided_at=CURRENT_TIMESTAMP
      WHERE id=? AND revision_id=? AND status='pending'`, [decision, actor.id, String(note || '').trim().slice(0, 1000) || null,
      Number(adjustmentId), task.revision_id]);
    if (!result.changes) throw fail('奖惩申请不存在、已处理或不属于当前修订', 409);
    await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
      action: 'quarterly_adjustment.decided', objectType: 'quarterly_adjustment_request', objectId: adjustmentId,
      after: { status: decision, decisionNote: note || null } });
    await run(connection, 'COMMIT');
    return { id: Number(adjustmentId), status: decision };
  } catch (error) { await run(connection, 'ROLLBACK').catch(() => {}); throw error; }
  finally { await new Promise(resolve => connection.close(() => resolve())); }
}

async function finalizationGates(task, connection = db) {
  const indicators = await taskIndicators(task, connection);
  const reviews = await all(connection, `SELECT indicator_id AS indicatorId, status FROM quarterly_review_items WHERE revision_id=?`, [task.revision_id]);
  const reviewById = new Map(reviews.map(row => [Number(row.indicatorId), row.status]));
  const missingReviews = indicators.filter(item => reviewById.get(item.id) !== 'approved').map(item => item.displayName);
  const storedScores = await all(connection, `SELECT indicator_id AS indicatorId, score_decimal AS score, score_source AS scoreSource,
      formula_version_id AS formulaVersionId, version FROM quarterly_indicator_scores WHERE revision_id=?`, [task.revision_id]);
  const automatic = await calculateAutomaticScores(task, task.revision_id, indicators, storedScores, connection);
  const missingScores = automatic.scores.filter(row => row.score == null).map(row => indicators.find(item => item.id === Number(row.indicatorId))?.displayName);
  const pendingAdjustments = Number((await get(connection, `SELECT COUNT(*) AS count FROM quarterly_adjustment_requests
    WHERE revision_id=? AND status='pending'`, [task.revision_id])).count);
  const openAnomalies = Number((await get(connection, `SELECT COUNT(*) AS count FROM anomaly_snapshots
    WHERE revision_id=? AND (severity='error' OR (severity='warning'
      AND (disposition IS NULL OR disposition<>'accepted' OR TRIM(COALESCE(explanation,''))='')))`, [task.revision_id])).count);
  const pendingMonthlyImpacts = Number((await get(connection, `SELECT COUNT(*) AS count FROM monthly_adjustment_impacts
    WHERE quarterly_task_id=? AND status='pending_confirmation'`, [task.id])).count);
  const dataAdjustment = await dataAdjustmentForRevision(task, task.revision_id, connection);
  const adjustmentApprovalPending = Boolean(dataAdjustment && !['approved', 'applied'].includes(dataAdjustment.status));
  const dependencies = automatic.dependencies;
  return { allowed: !missingReviews.length && !missingScores.length && !pendingAdjustments && !openAnomalies
      && !pendingMonthlyImpacts && !adjustmentApprovalPending && dependencies.complete,
    missingReviews, missingScores, pendingAdjustments, openAnomalies, pendingMonthlyImpacts, adjustmentApprovalPending,
    missingPeriods: dependencies.missingPeriods || [], dependencies };
}

async function finalizeQuarterlyTask({ taskId, actor, artifactFiles = [] }) {
  const connection = openBusinessConnection();
  const createdFiles = [];
  let transactionCommitted = false;
  try {
    await run(connection, 'PRAGMA foreign_keys=ON'); await run(connection, 'BEGIN IMMEDIATE');
    const task = await fetchTask(taskId, connection);
    if (!await canFinalizeQuarterlyPackage(task, actor, connection)) {
      throw fail('季度统一定稿需要配置包内每个组织的定稿指派和对应权限', 403);
    }
    if (task.revision_status !== 'submitted') throw fail('当前任务没有可定稿的已提交修订', 409);
    const gates = await finalizationGates(task, connection);
    if (!gates.allowed) {
      const reasons = [];
      if (gates.missingReviews.length) reasons.push(`尚有指标未通过审核：${gates.missingReviews.join('、')}`);
      if (gates.missingScores.length) reasons.push(`尚有指标未评分：${gates.missingScores.join('、')}`);
      if (gates.pendingAdjustments) reasons.push(`尚有 ${gates.pendingAdjustments} 项奖惩待审批`);
      if (gates.openAnomalies) reasons.push('存在未处理的异常或阻断校验');
      if (gates.pendingMonthlyImpacts) reasons.push(`尚有 ${gates.pendingMonthlyImpacts} 项月报调整差异待确认`);
      if (gates.adjustmentApprovalPending) reasons.push('季度数据调整尚未完成管理审批');
      if (!gates.dependencies.complete) reasons.push(`月报依赖未齐：${gates.missingPeriods.map(item => item.periodCode).join('、')}`);
      throw fail(reasons.join('；'), 409);
    }
    const packageTasks = await all(connection, `SELECT t.id, t.package_id, t.organization_id, t.period_code, t.task_status,
        t.configuration_snapshot_json, t.current_revision_id AS revision_id, r.revision_status
      FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id
      LEFT JOIN business_revisions r ON r.id=t.current_revision_id WHERE t.package_id=? AND rt.cadence='quarterly'`, [task.package_id]);
    if (packageTasks.some(item => !item.revision_id || !['submitted', 'finalized'].includes(item.revision_status))) {
      throw fail('季度排名需等待本配置包内所有组织提交季度修订', 409);
    }
    const filesByTask = new Map();
    for (const file of artifactFiles) {
      const grouped = filesByTask.get(Number(file.taskId)) || {};
      if (grouped[file.type]) throw fail('每个季度任务只能提交一份 XLSX 和一份 PDF', 400);
      grouped[file.type] = file.path;
      filesByTask.set(Number(file.taskId), grouped);
    }
    if (filesByTask.size !== packageTasks.length || packageTasks.some(item => {
      const files = filesByTask.get(Number(item.id));
      return !files?.xlsx || !files?.pdf;
    })) throw fail('季度统一定稿必须为配置包内每个组织提交 XLSX 与 PDF 归档文件', 400);
    const summaries = [];
    for (const packageTask of packageTasks) {
      if (!packageTask.revision_id || !['submitted', 'finalized'].includes(packageTask.revision_status)) {
        throw fail('季度排名需等待本配置包内所有组织提交季度修订', 409);
      }
      const pTask = await fetchTask(packageTask.id, connection);
      const packageGates = await finalizationGates(pTask, connection);
      if (!packageGates.allowed) throw fail('季度排名需等待本配置包内所有组织完成审核、评分、审批、异常处置及月报依赖', 409);
      const indicators = await taskIndicators(pTask, connection);
      const stored = await all(connection, `SELECT indicator_id AS indicatorId, score_decimal AS score, score_source AS scoreSource,
          formula_version_id AS formulaVersionId, version FROM quarterly_indicator_scores WHERE revision_id=?`, [pTask.revision_id]);
      const automatic = await calculateAutomaticScores(pTask, pTask.revision_id, indicators, stored, connection);
      const adjustments = await all(connection, `SELECT adjustment_type AS adjustmentType, amount_decimal AS amount, status
        FROM quarterly_adjustment_requests WHERE revision_id=?`, [pTask.revision_id]);
      const score = weightedScore(indicators, automatic.scores, adjustments);
      const organization = await get(connection, 'SELECT code AS organizationCode, name AS organizationName FROM organizations WHERE id=?', [pTask.organization_id]);
      summaries.push({ task: pTask, indicators, automatic, adjustments, score, organization });
    }
    const ranked = competitionRanks(summaries.map(item => ({ organizationId: item.task.organization_id,
      revisionId: item.task.revision_id, organizationCode: item.organization.organizationCode,
      organizationName: item.organization.organizationName, totalScore: item.score.totalScore })));
    const rankByOrganization = new Map(ranked.map(item => [Number(item.organizationId), item.rank]));
    const finalizedArtifacts = [];
    for (const item of summaries) {
      const score = item.score.totalScore;
      const rank = rankByOrganization.get(Number(item.task.organization_id));
      const coefficient = redemptionCoefficient(item.task.configuration_snapshot_json, score, rank);
      for (const calculated of item.automatic.scores.filter(entry => entry.scoreSource !== 'manual')) {
        await run(connection, `INSERT INTO quarterly_indicator_scores
          (revision_id, indicator_id, scorer_id, score_decimal, score_source, formula_version_id, version, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
          ON CONFLICT(revision_id, indicator_id) DO UPDATE SET scorer_id=excluded.scorer_id,
            score_decimal=excluded.score_decimal, score_source=excluded.score_source,
            formula_version_id=excluded.formula_version_id, version=quarterly_indicator_scores.version+1,
            updated_at=CURRENT_TIMESTAMP`, [item.task.revision_id, calculated.indicatorId, actor.id,
          String(calculated.score), calculated.scoreSource, calculated.formulaVersionId]);
      }
      await run(connection, `INSERT INTO report_rankings
        (package_id, organization_id, revision_id, ranking_type, rank, score_decimal, calculation_version, redemption_coefficient_decimal)
        VALUES (?, ?, ?, 'quarterly', ?, ?, 'quarterly-score-v1', ?)
        ON CONFLICT(package_id, ranking_type, organization_id) DO UPDATE SET revision_id=excluded.revision_id,
          rank=excluded.rank, score_decimal=excluded.score_decimal, calculation_version=excluded.calculation_version,
          redemption_coefficient_decimal=excluded.redemption_coefficient_decimal, created_at=CURRENT_TIMESTAMP`, [item.task.package_id, item.task.organization_id, item.task.revision_id,
        rank, String(score), coefficient == null ? null : String(coefficient)]);
      const sourceWorkbook = await fs.readFile(item.task.workbook_path, 'utf8');
      const structuredRows = await all(connection, `SELECT f.code AS fieldCode, v.record_key AS recordKey, v.value_type AS valueType,
          v.text_value AS textValue, v.decimal_value AS decimalValue, v.integer_value AS integerValue,
          v.boolean_value AS booleanValue, v.date_value AS dateValue, v.json_value AS jsonValue,
          v.source_formula AS sourceFormula, v.unit_snapshot AS unit, v.precision_snapshot AS precision
      FROM business_values v JOIN field_definitions f ON f.id=v.field_definition_id WHERE v.revision_id=? ORDER BY f.code,v.record_key`,
      [item.task.revision_id]);
      const sourceArtifact = await get(connection, 'SELECT sha256 FROM official_artifacts WHERE id=? AND revision_id=?',
        [item.task.workbook_artifact_id, item.task.revision_id]);
      const manifest = { schemaVersion: 1, reportType: item.task.report_type_name, cadence: 'quarterly',
        taskId: Number(item.task.id), revisionId: Number(item.task.revision_id), revisionNumber: Number(item.task.revision_number),
        organizationId: Number(item.task.organization_id), periodCode: item.task.period_code,
        packageVersion: item.task.package_version, configurationVersion: item.task.package_version,
        templateVersionId: Number(item.task.template_version_id),
        ruleVersionIds: [...new Set((parse(item.task.configuration_snapshot_json).ruleVersionIds || []).map(Number))].sort((a, b) => a - b),
        sourceWorkbookArtifactId: Number(item.task.workbook_artifact_id), sourceWorkbookSha256: sourceArtifact?.sha256 || null,
        quarterlyDependencies: item.automatic.dependencies,
        calculationVersion: 'quarterly-score-v1',
        score, rank, redemptionCoefficient: coefficient, finalizedBy: Number(actor.id), finalizedAt: new Date().toISOString() };
      const taskArtifacts = [];
      taskArtifacts.push(await saveOfficialArtifact(connection, item.task.revision_id, 'finalized_workbook_json',
        { content: sourceWorkbook }, createdFiles));
      taskArtifacts.push(await saveOfficialArtifact(connection, item.task.revision_id, 'finalized_xlsx',
        { sourcePath: filesByTask.get(Number(item.task.id)).xlsx }, createdFiles));
      taskArtifacts.push(await saveOfficialArtifact(connection, item.task.revision_id, 'finalized_pdf',
        { sourcePath: filesByTask.get(Number(item.task.id)).pdf }, createdFiles));
      taskArtifacts.push(await saveOfficialArtifact(connection, item.task.revision_id, 'structured_data_json',
        { content: { taskId: Number(item.task.id), revisionId: Number(item.task.revision_id), values: structuredRows } }, createdFiles));
      taskArtifacts.push(await saveOfficialArtifact(connection, item.task.revision_id, 'version_manifest_json',
        { content: { ...manifest, artifacts: taskArtifacts.map(({ artifactType, sha256, byteSize }) => ({ artifactType, sha256, byteSize })) } }, createdFiles));
      finalizedArtifacts.push({ taskId: Number(item.task.id), revisionId: Number(item.task.revision_id), artifacts: taskArtifacts });
      await run(connection, `UPDATE business_revisions SET is_current_effective=0 WHERE task_id=? AND is_current_effective=1`, [item.task.id]);
      await run(connection, `UPDATE business_revisions SET revision_status='finalized', is_current_effective=1,
        finalized_at=CURRENT_TIMESTAMP WHERE id=? AND revision_status='submitted'`, [item.task.revision_id]);
      await run(connection, `UPDATE report_tasks SET task_status='finalized' WHERE id=? AND current_revision_id=?`, [item.task.id, item.task.revision_id]);
      const dataAdjustment = await dataAdjustmentForRevision(item.task, item.task.revision_id, connection);
      if (dataAdjustment?.status === 'approved') {
        await run(connection, `UPDATE adjustment_requests SET status='applied', applied_at=CURRENT_TIMESTAMP
          WHERE id=? AND status='approved'`, [dataAdjustment.id]);
        await recordBusinessAudit({ connection, actor, organizationId: item.task.organization_id,
          action: 'quarterly_adjustment.applied', objectType: 'adjustment_request', objectId: dataAdjustment.id,
          businessVersion: String(item.task.revision_number),
          before: { status: 'approved', currentRevisionId: dataAdjustment.sourceRevisionId },
          after: { status: 'applied', currentRevisionId: item.task.revision_id,
            changedFields: dataAdjustment.changedFields, changedValues: dataAdjustment.impact.changedValues || [] },
          reason: '季度调整修订随配置包重新定稿' });
      }
    }
    await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
      action: 'quarterly_package.ranked_and_finalized', objectType: 'period_package', objectId: task.package_id,
      after: { tasks: ranked.map(item => ({ organizationId: item.organizationId, revisionId: item.revisionId,
        score: item.totalScore, rank: item.rank })) }, reason: '季度审核、评分及定稿关口通过' });
    await run(connection, 'COMMIT');
    transactionCommitted = true;
    let checkpoint;
    try {
      checkpoint = await checkpointBackups.createCheckpoint({ actor, reason: `季度配置包 ${task.package_id} 统一定稿检查点`,
        finalization: { packageId: Number(task.package_id), revisions: finalizedArtifacts.map(item => ({
          taskId: item.taskId, revisionId: item.revisionId })) } });
    } catch (error) {
      checkpoint = error.checkpoint || { id: null, checkpointId: null, status: 'unavailable' };
    }
    return { taskId: Number(task.id), status: 'finalized', checkpoint: { id: checkpoint.id, checkpointId: checkpoint.checkpointId,
      status: checkpoint.status || 'complete', ...(checkpoint.id == null ? { reason: checkpoint.reason,
        finalization: checkpoint.finalization } : {}) },
      score: summaries.find(item => Number(item.task.id) === Number(task.id)).score,
      ranking: ranked.find(item => Number(item.organizationId) === Number(task.organization_id))?.rank,
      artifacts: finalizedArtifacts,
      rankings: ranked.map(item => ({ ...item, redemptionCoefficient: redemptionCoefficient(
        summaries.find(summary => Number(summary.task.organization_id) === Number(item.organizationId))?.task.configuration_snapshot_json,
        Number(item.totalScore), item.rank) })) };
  } catch (error) {
    if (!transactionCommitted) {
      await run(connection, 'ROLLBACK').catch(() => {});
      await Promise.all(createdFiles.map(file => fs.rm(file, { force: true }).catch(() => {})));
    }
    throw error;
  }
  finally { await new Promise(resolve => connection.close(() => resolve())); }
}

module.exports = { competitionRanks, weightedScore, redemptionCoefficient, listQuarterlyReviewTasks, getQuarterlyReview,
  saveIndicatorReview, saveIndicatorScore, addAdjustment, decideAdjustment, finalizationGates, finalizeQuarterlyTask };
