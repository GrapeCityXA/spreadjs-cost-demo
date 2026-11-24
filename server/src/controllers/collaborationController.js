const { hasTaskAssignment } = require('../services/taskAssignments');
const db = require('../config/database');
const fs = require('node:fs/promises');
const { recordBusinessAudit } = require('../services/businessAudit');
const collaboration = require('../services/collaborationServer');
const { buildMonthlyFillingSummary } = require('../services/monthlyFillingSummary');
const { hasRole } = require('../middleware/auth');
const { departmentCodesFor, identityFor } = require('../services/permissionIdentity');
const { submitBusinessRevision } = require('../services/businessSubmission');
const { withdrawBusinessRevision, saveReviewOpinion, saveAnomalyDisposition } = require('../services/revisionLifecycle');
const evidenceAttachments = require('../services/evidenceAttachments');
const monthlyFinalization = require('../services/monthlyFinalization');
const { readRevisionWorkbook } = require('../services/staticWorkbookFile');
const monthlyAdjustments = require('../services/monthlyAdjustments');
const { loadMonthlyReferenceReport, listMonthlyReferenceVersions } = require('../services/monthlyReferenceReport');
const { loadQuarterlyDependencies, quarterlyConfiguration } = require('../services/quarterlyDependencies');
const { buildQuarterlyWorkbook, scopeQuarterlySpreadJsonWorkbook, isQuarterlyReferenceTemplate } = require('../services/quarterlyWorkbook');
const { compilePermissionIndex } = require('../services/permissionIndex');
const multer = require('multer');
const path = require('node:path');
const crypto = require('node:crypto');
const nativeFs = require('node:fs');
const { getArtifactDirectory } = require('../config/storage');

const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const run = (connection, sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const finalizeUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, callback) => {
      const directory = path.join(getArtifactDirectory(), '.incoming');
      nativeFs.mkdirSync(directory, { recursive: true });
      callback(null, directory);
    },
    filename: (req, file, callback) => callback(null, `${Date.now()}-${crypto.randomUUID()}`)
  }),
  limits: { files: 2, fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const allowed = (file.fieldname === 'xlsx' && /\.xlsx$/i.test(file.originalname)
        && file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      || (file.fieldname === 'pdf' && /\.pdf$/i.test(file.originalname) && file.mimetype === 'application/pdf');
    callback(allowed ? null : Object.assign(new Error('只接受 XLSX 和 PDF 定稿文件'), { status: 400 }), allowed);
  }
}).fields([{ name: 'xlsx', maxCount: 1 }, { name: 'pdf', maxCount: 1 }]);

async function taskRoom(taskId) {
  return get(db, `SELECT cr.*, t.package_id, t.organization_id, t.current_revision_id
    FROM collaboration_rooms cr JOIN report_tasks t ON t.id = cr.task_id
    WHERE cr.task_id = ? ORDER BY cr.revision_number DESC LIMIT 1`, [taskId]);
}

async function authorizedRoom(req, res, { adminOnly = false, submitterOnly = false } = {}) {
  const room = await taskRoom(Number(req.params.taskId));
  if (!room) {
    res.status(404).json({ error: '任务协作房间不存在' });
    return null;
  }
  if (adminOnly ? !hasRole(req.user, 'system_admin') : !(await collaboration.canAccessRoom(req.user, room))) {
    res.status(403).json({ error: adminOnly ? '只有系统管理员可以查看协作历史' : '无权访问此协作房间' });
    return null;
  }
  if (submitterOnly && !(await hasTaskAssignment(db, room.task_id, req.user.id, 'submitter'))) {
    res.status(403).json({ error: '只有本任务的提交人可以查看编辑历史' });
    return null;
  }
  return room;
}

exports.getRoom = asyncRoute(async (req, res) => {
  const room = await authorizedRoom(req, res);
  if (!room) return;
  const task = await get(db, `SELECT t.id, t.report_type_id, t.organization_id, t.period_code, t.task_status, t.deadline_at, t.template_version_id, t.current_revision_id,
      t.configuration_snapshot_json, rt.display_name AS report_type_name, rt.cadence,
      o.code AS organization_code, o.name AS organization_name, p.version AS package_version,
      tv.workbook_json, tv.manifest_json, tv.version AS template_version, tv.id AS templateVersionId
    FROM report_tasks t JOIN template_versions tv ON tv.id = t.template_version_id
    JOIN report_types rt ON rt.id = t.report_type_id JOIN organizations o ON o.id = t.organization_id
    JOIN period_packages p ON p.id = t.package_id WHERE t.id = ?`, [room.task_id]);
  const currentRevision = task.current_revision_id == null ? null : await get(db,
    `SELECT r.id, r.revision_number, r.revision_status, r.source_revision_id, r.submitted_by, r.submitted_at,
        r.collaboration_version, a.storage_key AS workbook_path
      FROM business_revisions r LEFT JOIN official_artifacts a ON a.id = r.workbook_artifact_id
      WHERE r.id = ? AND r.task_id = ?`, [task.current_revision_id, task.id]);
  const anomalies = currentRevision ? await all(db, `SELECT a.id, a.rule_version_id AS ruleVersionId,
      a.field_definition_id AS fieldDefinitionId, a.rule_code AS ruleCode, a.field_code AS fieldCode,
      a.record_key AS recordKey, a.message, a.explanation, a.disposition, a.color_classification AS colorClassification,
      a.triggering_value_json AS triggeringValueJson, a.comparison_value_json AS comparisonValueJson,
      a.threshold_json AS thresholdJson, a.sheet_code AS sheetCode, a.row_index AS row, a.column_index AS column,
      reviewer.name AS reviewerName
    FROM anomaly_snapshots a LEFT JOIN users reviewer ON reviewer.id = a.reviewer_id
    WHERE a.revision_id = ? ORDER BY a.id`, [currentRevision.id]) : [];
  const taskIndicators = await all(db, `SELECT indicator_code AS code, display_name AS displayName,
      indicator_type AS type, sort_order AS sortOrder, configuration_json AS configurationJson
    FROM task_indicators WHERE task_id = ? ORDER BY sort_order, id`, [task.id]);
  for (const indicator of taskIndicators) {
    const configuration = JSON.parse(indicator.configurationJson || '{}');
    Object.assign(indicator, { recordKey: configuration.recordKey || indicator.code,
      category: configuration.category || null, ownerOrganizationId: configuration.ownerOrganizationId || null,
      reviewerUserId: configuration.reviewerUserId || null, maximumScore: configuration.maximumScore ?? null,
      namedArea: configuration.namedArea || null, tagCode: configuration.tagCode || null, tag: configuration.tag || null });
    delete indicator.configurationJson;
  }
  const reviewItems = currentRevision ? await all(db, `SELECT review_item_key AS reviewItemKey,
      department_code AS departmentCode, reviewer_id AS reviewerId, opinion, disposition, version,
      updated_at AS updatedAt FROM review_opinion_items WHERE revision_id = ?`, [currentRevision.id]) : [];
  for (const anomaly of anomalies) {
    anomaly.triggeringValue = JSON.parse(anomaly.triggeringValueJson || 'null');
    anomaly.comparisonValue = JSON.parse(anomaly.comparisonValueJson || 'null');
    anomaly.threshold = JSON.parse(anomaly.thresholdJson || 'null');
    delete anomaly.triggeringValueJson; delete anomaly.comparisonValueJson; delete anomaly.thresholdJson;
  }
  const seedSourceId = currentRevision?.revision_status === 'draft' ? currentRevision.source_revision_id : null;
  const storedTaskConfiguration = JSON.parse(task.configuration_snapshot_json || '{}');
  const quarterlyConfig = task.cadence === 'quarterly' ? quarterlyConfiguration(storedTaskConfiguration) : null;
  const taskConfiguration = task.cadence === 'quarterly'
    ? { ...storedTaskConfiguration, ...quarterlyConfig, targets: storedTaskConfiguration.targets || quarterlyConfig.targets || [] }
    : storedTaskConfiguration;
  const manifest = JSON.parse(task.manifest_json || '{}');
  const requiresReferenceCompanyScope = isQuarterlyReferenceTemplate(manifest);
  const responseTaskConfiguration = { ...taskConfiguration,
    assignments: storedTaskConfiguration.assignments || taskConfiguration.assignments || [] };
  const submitterIds = [...new Set(responseTaskConfiguration.assignments.filter(item => item.responsibility === 'submitter')
    .map(item => Number(item.userId)).filter(Number.isSafeInteger))];
  const submitters = submitterIds.length ? await all(db, `SELECT id, name, username FROM users
    WHERE id IN (${submitterIds.map(() => '?').join(',')}) ORDER BY id`, submitterIds) : [];
  if (requiresReferenceCompanyScope) {
    responseTaskConfiguration.referenceCompanySheets = {
      [String(task.organization_id)]: taskConfiguration.referenceCompanySheets?.[String(task.organization_id)] || null
    };
  }
  const templateWorkbook = JSON.parse(task.workbook_json || '{}');
  const seedArtifact = seedSourceId == null ? null : await get(db,
    `SELECT storage_key FROM official_artifacts WHERE revision_id = ? AND artifact_type = 'spreadjs_workbook_json'`, [seedSourceId]);
  const rawSeedWorkbook = seedArtifact?.storage_key ? await readRevisionWorkbook(seedArtifact.storage_key, seedSourceId) : null;
  const seedWorkbook = rawSeedWorkbook && task.cadence === 'quarterly'
    ? scopeQuarterlySpreadJsonWorkbook(rawSeedWorkbook, templateWorkbook, task.organization_id,
      taskConfiguration.referenceCompanySheets, requiresReferenceCompanyScope)
    : rawSeedWorkbook;
  const rawSubmittedWorkbook = ['submitted', 'finalized'].includes(currentRevision?.revision_status) && currentRevision.workbook_path
    ? await readRevisionWorkbook(currentRevision.workbook_path, currentRevision.id) : null;
  const submittedWorkbook = rawSubmittedWorkbook && task.cadence === 'quarterly'
    ? scopeQuarterlySpreadJsonWorkbook(rawSubmittedWorkbook, templateWorkbook, task.organization_id,
      taskConfiguration.referenceCompanySheets, requiresReferenceCompanyScope)
    : rawSubmittedWorkbook;
  const timeline = await all(db, `SELECT e.id, e.event_type AS type, e.reason, e.remediation_deadline AS remediationDeadline,
      e.from_status AS fromStatus, e.to_status AS toStatus, e.created_at AS createdAt,
      e.revision_id AS revisionId, r.revision_number AS revisionNumber, u.id AS actorId, u.name AS actorName, u.username AS actorUsername
    FROM report_task_events e LEFT JOIN business_revisions r ON r.id = e.revision_id
    JOIN users u ON u.id = e.actor_user_id WHERE e.task_id = ? ORDER BY e.created_at, e.id`, [task.id]);
  const latestEdit = await get(db.collaborationDb, `SELECT op.actor_user_id AS userId, op.created_at AS editedAt
    FROM collaboration_operations op JOIN collaboration_rooms cr ON cr.id = op.room_id
    WHERE cr.room_key = ? ORDER BY op.version DESC LIMIT 1`,
  [room.collaboration_room_key]);
  const editor = latestEdit ? await get(db, 'SELECT name, username FROM users WHERE id = ?', [latestEdit.userId]) : null;
  const runtime = await collaboration.getRuntime();
  let collaborationSnapshot = null;
  try { collaborationSnapshot = await runtime.documentServices.fetch(room.collaboration_room_key); }
  catch { /* A new room may not have a persisted collaboration document yet. */ }
  if (collaborationSnapshot?.data && task.cadence === 'quarterly') {
    collaborationSnapshot = { ...collaborationSnapshot, data: scopeQuarterlySpreadJsonWorkbook(
      collaborationSnapshot.data, templateWorkbook, task.organization_id,
      taskConfiguration.referenceCompanySheets, requiresReferenceCompanyScope) };
  }
  const permissionIdentity = identityFor({ ...req.user, departmentCodes: await departmentCodesFor(req.user) }, task.organization_id);
  const quarterlyDependencies = task.cadence === 'quarterly' ? await loadQuarterlyDependencies({
    taskId: task.id, organizationId: task.organization_id, periodCode: task.period_code, configuration: taskConfiguration
  }) : null;
  const quarterlyAdjustmentImpacts = task.cadence === 'quarterly' ? await all(db, `SELECT i.id, i.status,
      i.monthly_task_id AS monthlyTaskId, i.created_at AS createdAt, a.changed_fields_json AS changedFieldsJson,
      a.reason AS adjustmentReason FROM monthly_adjustment_impacts i
      JOIN adjustment_requests a ON a.id=i.adjustment_request_id WHERE i.quarterly_task_id=?
      AND i.status IN ('pending_confirmation','requires_adjustment') ORDER BY i.id`, [task.id]) : [];
  for (const impact of quarterlyAdjustmentImpacts) {
    impact.changedFields = JSON.parse(impact.changedFieldsJson || '[]'); delete impact.changedFieldsJson;
  }
  const workbook = task.cadence === 'quarterly'
    ? buildQuarterlyWorkbook(templateWorkbook, taskIndicators.map(indicator => ({ ...indicator,
      code: indicator.code, displayName: indicator.displayName })), quarterlyDependencies, {
      organizationId: task.organization_id, referenceCompanySheets: taskConfiguration.referenceCompanySheets,
      requiresReferenceCompanyScope
    })
    : JSON.parse(task.workbook_json || '{}');
  const summary = await buildMonthlyFillingSummary({
    task: { id: task.id, reportTypeId: task.report_type_id, periodCode: task.period_code, configuration: taskConfiguration },
    organization: { id: task.organization_id, code: task.organization_code, name: task.organization_name },
    workbook, manifest, snapshot: collaborationSnapshot, roomVersion: Number(room.latest_version)
  });
  if (task.cadence === 'quarterly') manifest.permissionIndex = compilePermissionIndex(workbook);
  res.json({
    room: {
      taskId: room.task_id,
      roomKey: room.collaboration_room_key,
      revisionNumber: room.revision_number,
      status: room.room_status,
      currentVersion: room.latest_version,
      snapshotReference: room.snapshot_reference,
      endpointPath: '/collaboration/',
      revisionId: currentRevision?.id || null,
      businessRevisionNumber: currentRevision?.revision_number || null,
      revisionStatus: currentRevision?.revision_status || 'draft'
    },
    task: {
      id: task.id, periodCode: task.period_code, status: task.task_status,
      deadlineAt: task.deadline_at, organizationCode: task.organization_code,
      organizationName: task.organization_name, reportTypeName: task.report_type_name,
      packageVersion: task.package_version, templateVersion: task.template_version,
      configuration: responseTaskConfiguration, submitters
    },
    progress: {
      hasEdits: Number(room.latest_version) > 0,
      lastEditor: editor?.name || editor?.username || null,
      lastEditedAt: latestEdit?.editedAt || null,
      precheck: summary.precheck
    },
    precheck: summary.precheck,
    fieldDefinitions: (await all(db, 'SELECT id, code, semantic_type AS type, precision FROM field_definitions WHERE status = ?',["approved"])).filter(field => (workbook.sheets || []).some(sheet => (sheet.mappings || []).some(mapping => Number(mapping.fieldDefinitionId) === field.id || mapping.datasetColumns?.some(column => Number(column.fieldDefinitionId) === field.id)))),
    validationRules: summary.validationRules,
    calculations: summary.calculations,
    workbook,
    seedWorkbook,
    submittedWorkbook,
    anomalies,
    reviewItems,
    indicators: taskIndicators,
    quarterlyDependencies,
    quarterlyAdjustmentImpacts,
    revision: currentRevision ? { id: currentRevision.id, number: currentRevision.revision_number,
      status: currentRevision.revision_status, sourceRevisionId: currentRevision.source_revision_id,
      submittedBy: currentRevision.submitted_by, submittedAt: currentRevision.submitted_at } : null,
    timeline,
    manifest,
    permissionIdentity,
    templateVersionId: task.templateVersionId,
    periodCode: task.period_code,
    collaborationVersion: runtime.collaborationVersion
  });
});

exports.getMonthlyReview = asyncRoute(async (req, res) => {
  try {
    res.json(await monthlyFinalization.getMonthlyReview(Number(req.params.taskId), req.user));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '加载审核资料失败' });
  }
});

exports.listMonthlyReviewTasks = asyncRoute(async (req, res) => {
  try {
    res.json({ tasks: await monthlyFinalization.listMonthlyReviewTasks(req.user) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '获取审核任务失败' });
  }
});

exports.getMonthlyReferenceReport = asyncRoute(async (req, res) => {
  const roles = req.user.roles || [];
  const canReadAllOrganizations = roles.some(role => role.code === 'system_admin'
    || (['management', 'report_finalizer'].includes(role.code) && role.organizationId == null));
  if (!canReadAllOrganizations) return res.status(403).json({ error: '需要全局管理或定稿权限才能查看汇总月报' });
  try {
    if (req.query.view === 'versions') {
      return res.json({ versions: await listMonthlyReferenceVersions(req.query) });
    }
    const report = await loadMonthlyReferenceReport({ periodCode: req.query.periodCode,
      reportTypeId: req.query.reportTypeId, configurationPackageId: req.query.configurationPackageId });
    res.json(report);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '生成月度参考报表失败' });
  }
});

exports.finalizeMonthlyTask = (req, res) => {
  finalizeUpload(req, res, async error => {
    if (error) {
      await Promise.all(Object.values(req.files || {}).flat().map(file => fs.rm(file.path, { force: true }).catch(() => {})));
      const status = error.status || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
      return res.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '每个定稿文件不能超过 30 MB' : error.message || '定稿文件上传失败' });
    }
    const xlsxFile = req.files?.xlsx?.[0];
    const pdfFile = req.files?.pdf?.[0];
    try {
      if (!xlsxFile || !pdfFile) return res.status(400).json({ error: '定稿必须同时提交 XLSX 和 PDF 文件' });
      const xlsxHandle = await fs.open(xlsxFile.path, 'r');
      const xlsxSignature = Buffer.alloc(4);
      await xlsxHandle.read(xlsxSignature, 0, 4, 0);
      await xlsxHandle.close();
      const pdfHandle = await fs.open(pdfFile.path, 'r');
      const pdfSignature = Buffer.alloc(5);
      await pdfHandle.read(pdfSignature, 0, 5, 0);
      await pdfHandle.close();
      if (xlsxSignature[0] !== 0x50 || xlsxSignature[1] !== 0x4b || pdfSignature.toString('ascii') !== '%PDF-') {
        return res.status(400).json({ error: '定稿文件内容与扩展名不匹配' });
      }
      const result = await monthlyFinalization.finalizeMonthlyTask({ taskId: Number(req.params.taskId), actor: req.user, xlsxFile, pdfFile });
      res.json(result);
    } catch (finalizeError) {
      res.status(finalizeError.status || 500).json({ error: finalizeError.message || '月报定稿失败' });
    } finally {
      await Promise.all([xlsxFile, pdfFile].filter(Boolean).map(file => fs.rm(file.path, { force: true }).catch(() => {})));
    }
  });
};

exports.listFinalizedRevisions = asyncRoute(async (req, res) => {
  try {
    res.json({ revisions: await monthlyFinalization.listFinalizedRevisions(Number(req.params.taskId), req.user) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '获取历史定稿失败' });
  }
});

exports.getFinalizedRevision = asyncRoute(async (req, res) => {
  try {
    res.json(await monthlyFinalization.getFinalizedRevision(Number(req.params.taskId), Number(req.params.revisionId), req.user));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '获取定稿修订失败' });
  }
});

exports.listFinalizedTasks = asyncRoute(async (req, res) => {
  try { res.json({ tasks: await monthlyFinalization.listFinalizedTasks(req.user) }); }
  catch (error) { res.status(error.status || 500).json({ error: error.message || '获取历史定稿任务失败' }); }
});

exports.downloadFinalizedArtifact = asyncRoute(async (req, res) => {
  try {
    const artifact = await monthlyFinalization.getFinalizedArtifact(Number(req.params.taskId),
      Number(req.params.revisionId), req.params.artifactType, req.user);
    const contentTypes = { finalized_workbook_json: 'application/json', finalized_xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      finalized_pdf: 'application/pdf', structured_data_json: 'application/json', version_manifest_json: 'application/json' };
    res.setHeader('Content-Type', contentTypes[artifact.artifact_type]);
    res.setHeader('Content-Length', String(artifact.byte_size));
    res.setHeader('X-Artifact-SHA256', artifact.sha256);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(path.resolve(artifact.storage_key));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '下载定稿文件失败' });
  }
});

exports.submitTask = asyncRoute(async (req, res) => {
  try {
    const result = await submitBusinessRevision({ taskId: Number(req.params.taskId), actor: req.user,
      expectedVersion: Number(req.body?.expectedVersion), pendingChanges: Number(req.body?.pendingChanges),
      warningExplanations: req.body?.warningExplanations,
        validationReport: req.body?.validationReport,
      idempotencyKey: req.get('idempotency-key') });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '提交失败', ...(error.details ? { details: error.details } : {}) });
  }
});

exports.withdrawTask = asyncRoute(async (req, res) => {
  try {
    const result = await withdrawBusinessRevision({ taskId: Number(req.params.taskId), actor: req.user, reason: req.body?.reason });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '撤回失败' });
  }
});

exports.getAdjustmentFields = asyncRoute(async (req, res) => {
  try { res.json({ fields: await monthlyAdjustments.getAdjustmentFields(Number(req.params.taskId), req.user) }); }
  catch (error) { res.status(error.status || 500).json({ error: error.message || '读取可调整字段失败' }); }
});

exports.startMonthlyAdjustment = asyncRoute(async (req, res) => {
  try {
    res.status(201).json(await monthlyAdjustments.startMonthlyAdjustment({ taskId: Number(req.params.taskId), actor: req.user,
      fieldCodes: req.body?.fieldCodes, reason: req.body?.reason }));
  } catch (error) { res.status(error.status || 500).json({ error: error.message || '发起报告调整失败' }); }
});

exports.decideMonthlyAdjustment = asyncRoute(async (req, res) => {
  try {
    res.json(await monthlyAdjustments.approveOrRejectMonthlyAdjustment({ taskId: Number(req.params.taskId), actor: req.user,
      decision: req.body?.decision, note: req.body?.note }));
  } catch (error) { res.status(error.status || 500).json({ error: error.message || '调整审批失败' }); }
});

exports.confirmQuarterlyAdjustmentImpact = asyncRoute(async (req, res) => {
  try {
    res.json(await monthlyAdjustments.confirmQuarterlyImpact({ taskId: Number(req.params.taskId),
      impactId: Number(req.params.impactId), actor: req.user }));
  } catch (error) { res.status(error.status || 500).json({ error: error.message || '确认季度差异失败' }); }
});

exports.saveReviewOpinion = asyncRoute(async (req, res) => {
  try {
    const result = await saveReviewOpinion({ taskId: Number(req.params.taskId), actor: req.user,
      reason: req.body?.opinion, disposition: req.body?.disposition, remediationDeadline: req.body?.remediationDeadline,
      expectedVersion: req.body?.expectedVersion, reviewItemKey: req.body?.reviewItemKey });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '保存审核意见失败' });
  }
});

exports.saveAnomalyDisposition = asyncRoute(async (req, res) => {
  try {
    const result = await saveAnomalyDisposition({ taskId: Number(req.params.taskId), anomalyId: Number(req.params.anomalyId),
      actor: req.user, disposition: req.body?.disposition });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '保存异常处置失败' });
  }
});

exports.uploadEvidenceAttachment = (req, res, next) => {
  evidenceAttachments.uploadMiddleware()(req, res, error => {
    if (error) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : (error.status || 400);
      return res.status(status).json({ error: status === 413 ? '单个文件不能超过 20 MB' : (error.message || '上传失败') });
    }
    Promise.resolve().then(async () => {
      const task = await evidenceAttachments.taskForAccess(Number(req.params.taskId), req.user, true);
      const attachment = await evidenceAttachments.uploadAttachment(task, req.user, req.file, req.body?.indicatorCode);
      res.status(201).json({ attachment });
    }).catch(async uploadError => {
      if (req.file?.path) await fs.rm(req.file.path, { force: true }).catch(() => {});
      res.status(uploadError.status || 500).json({ error: uploadError.message || '上传失败' });
    });
  });
};

exports.downloadEvidenceAttachment = asyncRoute(async (req, res) => {
  try {
    const { row, absolutePath } = await evidenceAttachments.attachmentForDownload(
      Number(req.params.taskId), Number(req.params.attachmentId), req.user);
    const fallback = row.original_name.replace(/[\r\n"\\]/g, '_').replace(/[^\x20-\x7e]/g, '_') || 'evidence';
    res.setHeader('Content-Type', row.media_type);
    res.setHeader('Content-Length', String(row.byte_size));
    res.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(absolutePath);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '下载失败' });
  }
});

exports.listMonthlyTasks = asyncRoute(async (req, res) => {
  const tasks = await all(db, `SELECT t.id, t.package_id, t.organization_id, t.period_code, t.task_status,
      t.deadline_at, cr.room_status, cr.latest_version, cr.collaboration_room_key,
      rt.display_name AS report_type_name, rt.cadence, o.code AS organization_code, o.name AS organization_name
    FROM report_tasks t JOIN report_types rt ON rt.id = t.report_type_id
    JOIN organizations o ON o.id = t.organization_id
    JOIN collaboration_rooms cr ON cr.task_id = t.id AND cr.revision_number = (
      SELECT MAX(current_room.revision_number) FROM collaboration_rooms current_room WHERE current_room.task_id = t.id)
    WHERE t.task_status <> 'cancelled'
    ORDER BY t.deadline_at, t.id`);
  const visible = [];
  for (const task of tasks) {
    if (!(await collaboration.canAccessRoom(req.user, task))) continue;
    const latestEdit = await get(db.collaborationDb, `SELECT op.actor_user_id AS userId, op.created_at AS editedAt
      FROM collaboration_operations op JOIN collaboration_rooms cr ON cr.id = op.room_id
      WHERE cr.room_key = ? ORDER BY op.version DESC LIMIT 1`, [task.collaboration_room_key]);
    const editor = latestEdit ? await get(db, 'SELECT name, username FROM users WHERE id = ?', [latestEdit.userId]) : null;
    visible.push({
      id: task.id, periodCode: task.period_code, status: task.task_status, deadlineAt: task.deadline_at,
      roomStatus: task.room_status, organizationCode: task.organization_code, organizationName: task.organization_name,
      reportTypeName: task.report_type_name, cadence: task.cadence, hasEdits: Number(task.latest_version) > 0,
      lastEditor: editor?.name || editor?.username || null, lastEditedAt: latestEdit?.editedAt || null
    });
  }
  res.json({ tasks: visible });
});

exports.updateRoomLifecycle = asyncRoute(async (req, res) => {
  const { status, reason = '' } = req.body || {};
  if (!['frozen', 'closed'].includes(status)) return res.status(400).json({ error: '房间状态只能设为 frozen 或 closed' });
  if (status === 'closed' && !String(reason).trim()) return res.status(400).json({ error: '关闭房间必须填写原因' });
  const room = await taskRoom(Number(req.params.taskId));
  if (!room) return res.status(404).json({ error: '任务协作房间不存在' });
  if (!hasRole(req.user, 'system_admin') && !hasRole(req.user, 'management')) return res.status(403).json({ error: '需要管理人员权限' });
  if (room.room_status === 'closed') return res.status(409).json({ error: '协作房间已经关闭' });
  if (status === 'frozen' && room.room_status === 'frozen') return res.status(409).json({ error: '协作房间已经冻结' });

  const timestampColumn = status === 'frozen' ? 'frozen_at' : 'closed_at';
  await run(db, `UPDATE collaboration_rooms SET room_status = ?, ${timestampColumn} = CURRENT_TIMESTAMP WHERE id = ?`, [status, room.id]);
  await run(db.collaborationDb, `UPDATE collaboration_rooms SET room_status = ? WHERE room_key = ?`, [status, room.collaboration_room_key]);
  await recordBusinessAudit({ actor: req.user, organizationId: room.organization_id,
    action: `collaboration_room.${status}`, objectType: 'collaboration_room', objectId: room.id,
    businessVersion: String(room.latest_version), before: { status: room.room_status },
    after: { status, taskId: room.task_id }, reason: String(reason).trim() || null,
    requestId: req.get('x-request-id') || null });
  res.json({ taskId: room.task_id, roomKey: room.collaboration_room_key, status });
});

exports.getRoomHistory = asyncRoute(async (req, res) => {
  const room = await authorizedRoom(req, res, { submitterOnly: true });
  if (!room) return;
  const rooms = await all(db, 'SELECT collaboration_room_key, revision_number FROM collaboration_rooms WHERE task_id = ? ORDER BY revision_number DESC', [room.task_id]);
  const versions = [];
  for (const revisionRoom of rooms) {
    const collabRoom = await get(db.collaborationDb, 'SELECT id FROM collaboration_rooms WHERE room_key = ?', [revisionRoom.collaboration_room_key]);
    const operations = collabRoom ? await all(db.collaborationDb, `SELECT version, actor_user_id AS actorUserId, created_at AS createdAt, operation_json AS operationJson
      FROM collaboration_operations WHERE room_id = ? ORDER BY version DESC`, [collabRoom.id]) : [];
    for (const operation of operations) {
      const actor = await get(db, 'SELECT username, name FROM users WHERE id = ?', [operation.actorUserId]);
      const stored = JSON.parse(operation.operationJson);
      const changes = (stored.op?.ops || []).filter(op => op.target && (op.type === 51 && [1,257].includes(op.payload?.clearType) || op.type === 28 && ['value','formula'].some(key => Object.hasOwn(op.payload?.rangeData || {}, key)))).map(op => ({
        sheetId: op.sheetId, row: op.target.row, col: op.target.col, rowCount: op.target.rowCount, colCount: op.target.colCount,
        kind: op.type === 51 ? 'clear' : Object.hasOwn(op.payload?.rangeData || {}, 'formula') ? 'formula' : 'value',
        value: op.payload?.rangeData?.value ?? null
      }));
      changes.push(...(stored.op?.ops || []).filter(op => op.module === 'dataManager' && op.type === 441)
        .flatMap(op => Object.entries(op.payload?.item || {}).map(([bindingPath, value]) => ({ bindingPath, kind: 'value', value }))));
      delete operation.operationJson;
      versions.push({ ...operation, changes, version: Number(operation.version) + 1, roomKey: revisionRoom.collaboration_room_key,
        revisionNumber: revisionRoom.revision_number, actorUsername: actor?.username || null, actorName: actor?.name || null });
    }
  }
  const snapshots = await all(db.collaborationDb, `SELECT version, created_at AS createdAt FROM collaboration_milestones
    WHERE doc_id = ? ORDER BY version DESC`, [room.collaboration_room_key]);
  res.json({ taskId: room.task_id, roomKey: room.collaboration_room_key, status: room.room_status,
    currentVersion: room.latest_version, snapshotReference: room.snapshot_reference, versions, snapshots });
});

exports.getHistorySnapshot = asyncRoute(async (req, res) => {
  const room = await authorizedRoom(req, res, { submitterOnly: true });
  if (!room) return;
  const version = Number(req.params.version);
  if (!Number.isSafeInteger(version) || version < 0 || version > room.latest_version) return res.status(400).json({ error: '协作版本号无效' });
  const snapshot = await get(db.collaborationDb, `SELECT version, snapshot_json FROM collaboration_milestones
    WHERE doc_id = ? AND version = ?`, [room.collaboration_room_key, version]);
  if (!snapshot) return res.status(404).json({ error: '该版本没有持久化快照；请查看协作操作记录' });
  const data = JSON.parse(snapshot.snapshot_json);
  res.json({ taskId: room.task_id, roomKey: room.collaboration_room_key, version: snapshot.version,
    snapshot: data.data, snapshotReference: `${room.collaboration_room_key}@${snapshot.version}` });
});
