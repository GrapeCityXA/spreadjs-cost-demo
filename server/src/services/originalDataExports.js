const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { createWriteStream } = require('node:fs');
const db = require('../config/database');
const storage = require('../config/storage');
const { recordBusinessAudit } = require('./businessAudit');

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPORT_TTL_MS = 7 * DAY_MS;
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function hasRole(actor, code, organizationId = null) {
  return (actor.roles || []).some(role => role.code === code
    && (role.organizationId == null || organizationId == null || Number(role.organizationId) === Number(organizationId)));
}

function hasGlobalRole(actor, code) {
  return (actor.roles || []).some(role => role.code === code && role.organizationId == null);
}

function assertManagement(actor) {
  if (!hasGlobalRole(actor, 'system_admin') && !hasGlobalRole(actor, 'management')) throw fail('需要全局管理人员权限', 403);
}

function safePeriod(value) {
  const period = String(value || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) && !/^\d{4}-Q[1-4]$/.test(period)) throw fail('周期编号无效');
  return period;
}

function valueOf(row) {
  if (row.jsonValue != null) return row.jsonValue;
  if (row.textValue != null) return row.textValue;
  if (row.decimalValue != null) return row.decimalValue;
  if (row.integerValue != null) return row.integerValue;
  if (row.booleanValue != null) return row.booleanValue ? '是' : '否';
  return row.dateValue;
}

function scopedManagementOrganizationIds(actor) {
  return [...new Set((actor.roles || []).filter(role => role.code === 'management' && role.organizationId != null)
    .map(role => Number(role.organizationId)).filter(id => Number.isSafeInteger(id) && id > 0))];
}

function resolveOrganizationScope(actor, { missingOrganizationMessage, unauthorizedMessage }) {
  if (hasGlobalRole(actor, 'system_admin') || hasGlobalRole(actor, 'management')) {
    return { globalManagement: true, management: true, organizationIds: null };
  }
  const scopedManagementIds = scopedManagementOrganizationIds(actor);
  if (scopedManagementIds.length) return { globalManagement: false, management: true, organizationIds: scopedManagementIds };
  const organizationId = Number(actor.organizationId);
  if (!Number.isSafeInteger(organizationId) || organizationId < 1) {
    throw fail(missingOrganizationMessage || unauthorizedMessage, 403);
  }
  if (!hasRole(actor, 'subsidiary_filler', organizationId) && !hasRole(actor, 'subsidiary_submitter', organizationId)) {
    throw fail(unauthorizedMessage, 403);
  }
  return { globalManagement: false, management: false, organizationIds: [organizationId] };
}

function makeRawWorkbook(rows, periodCode) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Reporting Platform';
  workbook.created = new Date();
  workbook.subject = `Structured original submissions for ${periodCode}`;
  const sheet = workbook.addWorksheet('原始数据', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    { header: '周期', key: 'periodCode', width: 14 }, { header: '报告类型', key: 'reportType', width: 20 },
    { header: '组织编码', key: 'organizationCode', width: 18 }, { header: '组织名称', key: 'organizationName', width: 28 },
    { header: '任务编号', key: 'taskId', width: 12 }, { header: '修订编号', key: 'revisionNumber', width: 12 },
    { header: '修订状态', key: 'revisionStatus', width: 14 }, { header: '记录键', key: 'recordKey', width: 24 },
    { header: '字段编码', key: 'fieldCode', width: 28 }, { header: '字段名称', key: 'displayName', width: 28 },
    { header: '数据类型', key: 'valueType', width: 14 }, { header: '值', key: 'value', width: 36 },
    { header: '单位', key: 'unit', width: 14 }, { header: '精度', key: 'precision', width: 10 },
    { header: '来源公式', key: 'sourceFormula', width: 30 }, { header: '来源工作表', key: 'sourceSheet', width: 20 },
    { header: '来源命名区域', key: 'sourceNamedArea', width: 24 }, { header: '来源行', key: 'sourceRow', width: 10 },
    { header: '来源列', key: 'sourceColumn', width: 10 }, { header: '填报人', key: 'enteredBy', width: 18 },
    { header: '提交人', key: 'submittedBy', width: 18 }, { header: '提交时间', key: 'submittedAt', width: 22 },
    { header: '业务修订ID', key: 'revisionId', width: 14 }
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  for (const row of rows) sheet.addRow({ ...row, value: valueOf(row) });
  sheet.autoFilter = { from: 'A1', to: `W${Math.max(1, rows.length + 1)}` };
  const provenance = workbook.addWorksheet('导出说明');
  provenance.addRows([
    ['项目', '说明'], ['周期', periodCode], ['生成时间', new Date().toISOString()],
    ['数据范围', '已提交业务修订的结构化原始值；每一行对应一个记录键与字段'],
    ['来源', '任务与业务修订快照；来源公式、命名区域、工作表和坐标均来自提交记录'],
    ['值格式', '金额和小数按原始精度文本导出，避免 Excel 数值转换改变存储精度']
  ]);
  provenance.columns = [{ width: 20 }, { width: 100 }];
  return workbook.xlsx.writeBuffer();
}

function buildRawQuery(actor, query) {
  const periodCode = safePeriod(query.periodCode);
  const requestedOrganizationId = query.organizationId == null || query.organizationId === '' ? null : Number(query.organizationId);
  const scope = resolveOrganizationScope(actor, { missingOrganizationMessage: '当前用户没有所属组织', unauthorizedMessage: '无权导出原始数据' });
  let organizationIds = scope.organizationIds;
  if (requestedOrganizationId != null) {
    if (organizationIds && !organizationIds.includes(requestedOrganizationId)) throw fail('无权导出其他组织的原始数据', 403);
    organizationIds = [requestedOrganizationId];
  }
  if (query.organizationId && !Number.isSafeInteger(Number(query.organizationId))) throw fail('组织编号无效');
  const filters = ['t.period_code = ?', "r.submitted_at IS NOT NULL", "r.revision_status IN ('submitted','reviewing','returned','withdrawn','scoring','scored','finalized')"];
  const params = [periodCode];
  if (organizationIds?.length === 1) { filters.push('t.organization_id = ?'); params.push(organizationIds[0]); }
  else if (organizationIds?.length > 1) { filters.push(`t.organization_id IN (${organizationIds.map(() => '?').join(',')})`); params.push(...organizationIds); }
  if (query.reportTypeId != null && query.reportTypeId !== '') {
    if (!/^\d+$/.test(String(query.reportTypeId))) throw fail('报告类型编号无效');
    filters.push('t.report_type_id = ?'); params.push(Number(query.reportTypeId));
  }
  return { periodCode, organizationId: organizationIds?.length === 1 ? organizationIds[0] : null,
    organizationIds, management: scope.management, filters: filters.join(' AND '), params };
}

async function getRawRows(actor, query = {}) {
  const filter = buildRawQuery(actor, query);
  const rows = await all(`SELECT t.id AS taskId, t.period_code AS periodCode, rt.display_name AS reportType,
      o.id AS organizationId, o.code AS organizationCode, o.name AS organizationName,
      r.id AS revisionId, r.revision_number AS revisionNumber, r.revision_status AS revisionStatus,
      r.submitted_at AS submittedAt, submitter.name AS submittedBy, v.record_key AS recordKey,
      f.code AS fieldCode, f.display_name AS displayName, v.value_type AS valueType,
      v.text_value AS textValue, v.decimal_value AS decimalValue, v.integer_value AS integerValue,
      v.boolean_value AS booleanValue, v.date_value AS dateValue, v.json_value AS jsonValue,
      COALESCE(v.unit_snapshot, f.unit) AS unit, COALESCE(v.precision_snapshot, f.precision) AS precision,
      v.source_formula AS sourceFormula, v.source_sheet AS sourceSheet, v.source_named_area AS sourceNamedArea,
      v.source_row AS sourceRow, v.source_column AS sourceColumn, editor.name AS enteredBy
    FROM report_tasks t JOIN report_types rt ON rt.id = t.report_type_id
      JOIN organizations o ON o.id = t.organization_id JOIN business_revisions r ON r.task_id = t.id
      JOIN business_values v ON v.revision_id = r.id JOIN field_definitions f ON f.id = v.field_definition_id
      LEFT JOIN users submitter ON submitter.id = r.submitted_by LEFT JOIN users editor ON editor.id = v.entered_by
    WHERE ${filter.filters}
    ORDER BY o.code, t.id, r.revision_number, f.code, v.record_key`, filter.params);
  return { filter, rows };
}

async function exportRawData(actor, query) {
  const { filter, rows } = await getRawRows(actor, query);
  const buffer = await makeRawWorkbook(rows, filter.periodCode);
  await recordBusinessAudit({ actor, action: 'original_data.exported', objectType: 'original_data_export',
    objectId: filter.periodCode, after: { periodCode: filter.periodCode, organizationId: filter.organizationId, rowCount: rows.length },
    reason: '结构化原始数据导出' });
  return { buffer, filename: `原始数据-${filter.periodCode}.xlsx`, rowCount: rows.length };
}

async function createZipFile(outputPath, entries) {
  const { ZipArchive } = await import('archiver');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const output = createWriteStream(outputPath, { flags: 'wx' });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const completed = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(output);
  for (const entry of entries) {
    if (entry.buffer) archive.append(entry.buffer, { name: entry.name });
    else archive.file(entry.path, { name: entry.name });
  }
  await archive.finalize();
  await completed;
}

function insideDirectory(file, directory) {
  const resolved = path.resolve(file);
  return resolved.startsWith(path.resolve(directory) + path.sep);
}

function safeZipSegment(value) {
  const segment = String(value || '').replace(/[\\/\u0000-\u001f]/g, '_').trim();
  return segment && segment !== '.' && segment !== '..' ? segment : '未命名';
}

async function capturePackageSnapshot(packageId) {
  const tasks = await all(`SELECT t.id AS taskId, t.task_status AS taskStatus, t.organization_id AS organizationId,
      t.current_revision_id AS currentRevisionId, t.period_code AS periodCode,
      o.code AS organizationCode, o.name AS organizationName, rt.display_name AS reportType,
      r.revision_number AS revisionNumber, r.revision_status AS revisionStatus, r.submitted_at AS submittedAt
    FROM report_tasks t JOIN organizations o ON o.id = t.organization_id
      JOIN report_types rt ON rt.id = t.report_type_id LEFT JOIN business_revisions r ON r.id = t.current_revision_id
    WHERE t.package_id = ? ORDER BY o.code`, [packageId]);
  for (const task of tasks) {
    task.revisions = await all(`SELECT id AS revisionId, revision_number AS revisionNumber,
        revision_status AS revisionStatus, submitted_at AS submittedAt
      FROM business_revisions WHERE task_id = ? AND submitted_at IS NOT NULL ORDER BY revision_number`, [task.taskId]);
    task.artifacts = await all(`SELECT a.id AS artifactId, a.artifact_type AS artifactType, a.storage_key AS storageKey,
        r.id AS revisionId, r.revision_number AS revisionNumber
      FROM official_artifacts a JOIN business_revisions r ON r.id = a.revision_id
      WHERE r.task_id = ? ORDER BY r.revision_number, a.artifact_type`, [task.taskId]);
    for (const revision of task.revisions) {
      revision.attachments = await all(`SELECT id AS attachmentId, original_name AS originalName,
          storage_key AS storageKey FROM attachments WHERE task_id = ? AND revision_id = ? ORDER BY id`,
      [task.taskId, revision.revisionId]);
    }
  }
  return { version: 1, tasks };
}

async function packageEntries(packageId, periodCode, snapshot, updateProgress) {
  periodCode = safePeriod(periodCode);
  const tasks = snapshot.tasks;
  const entries = [];
  const rawRows = (await getRawRows({ id: -1, organizationId: null, roles: [{ code: 'system_admin' }] }, { periodCode })).rows;
  const packageTaskIds = new Set(tasks.map(task => Number(task.taskId)));
  const packageRevisionIds = new Set(tasks.flatMap(task => task.revisions.map(revision => Number(revision.revisionId))));
  const packageRawRows = rawRows.filter(row => packageTaskIds.has(Number(row.taskId))
    && packageRevisionIds.has(Number(row.revisionId)));
  entries.push({ name: `${periodCode}/结构化原始数据-${periodCode}.xlsx`, buffer: await makeRawWorkbook(packageRawRows, periodCode) });
  let processed = 0;
  for (const task of tasks) {
    const companyRoot = `${periodCode}/${safeZipSegment(task.organizationCode)}`;
    const taskRows = packageRawRows.filter(row => Number(row.taskId) === Number(task.taskId));
    entries.push({ name: `${companyRoot}/原始数据/原始数据-${safeZipSegment(task.organizationCode)}-${task.periodCode}.xlsx`,
      buffer: await makeRawWorkbook(taskRows, task.periodCode) });
    const companyManifest = { periodCode: task.periodCode, taskId: Number(task.taskId), reportType: task.reportType,
      organization: { code: task.organizationCode, name: task.organizationName }, taskStatus: task.taskStatus,
      currentRevisionId: task.currentRevisionId == null ? null : Number(task.currentRevisionId),
      revisionNumber: task.revisionNumber == null ? null : Number(task.revisionNumber),
      revisionStatus: task.revisionStatus || null, submittedAt: task.submittedAt || null,
      formalReportIncluded: false, attachments: [] };
    for (const artifact of task.artifacts) {
      if (!['finalized_xlsx', 'finalized_pdf'].includes(artifact.artifactType)) continue;
      const filePath = path.resolve(artifact.storageKey);
      if (!insideDirectory(filePath, storage.getArtifactDirectory())) continue;
      await fs.access(filePath);
      const ext = artifact.artifactType === 'finalized_xlsx' ? 'xlsx' : 'pdf';
      entries.push({ path: filePath,
        name: `${companyRoot}/正式报表/${safeZipSegment(task.organizationCode)}-${task.periodCode}-${safeZipSegment(task.reportType)}-修订-${String(artifact.revisionNumber).padStart(3, '0')}-artifact-${artifact.artifactId}.${ext}` });
      companyManifest.formalReportIncluded = true;
    }
    for (const revision of task.revisions) {
      for (const attachment of revision.attachments) {
        const filePath = path.resolve(attachment.storageKey);
        const evidenceRoot = path.join(storage.getArtifactDirectory(), 'evidence');
        if (!insideDirectory(filePath, evidenceRoot)) continue;
        await fs.access(filePath);
        const safeName = path.basename(attachment.originalName).replace(/[\\/]/g, '_');
        entries.push({ path: filePath,
          name: `${companyRoot}/附件/修订-${String(revision.revisionNumber).padStart(3, '0')}/附件-${attachment.attachmentId}-${safeName}` });
        companyManifest.attachments.push({ id: Number(attachment.attachmentId), revisionNumber: Number(revision.revisionNumber), originalName: attachment.originalName });
      }
    }
    entries.push({ name: `${companyRoot}/company-manifest.json`, buffer: Buffer.from(JSON.stringify(companyManifest, null, 2), 'utf8') });
    processed += 1;
    await updateProgress(Math.min(90, 10 + Math.round(80 * processed / Math.max(1, tasks.length))));
  }
  return { entries, taskCount: tasks.length, rowCount: packageRawRows.length };
}

let queue = Promise.resolve();
let expiryTimer;
async function runJob(jobId) {
  const job = await get('SELECT * FROM export_jobs WHERE id = ?', [jobId]);
  if (!job || job.status !== 'queued') return;
  await run("UPDATE export_jobs SET status='running', progress=1, error_text=NULL WHERE id=? AND status='queued'", [jobId]);
  const updateProgress = progress => run('UPDATE export_jobs SET progress=? WHERE id=? AND status=?', [progress, jobId, 'running']);
  let outputPath;
  try {
    const pack = await get(`SELECT p.id, p.period_code AS periodCode, p.status, rt.display_name AS reportType
      FROM period_packages p JOIN report_types rt ON rt.id=p.report_type_id WHERE p.id=?`, [job.package_id]);
    if (!pack || !['active', 'closed'].includes(pack.status)) throw fail('周期配置包不存在或尚未激活', 409);
    const snapshot = job.snapshot_manifest_json && job.snapshot_manifest_json !== '{}'
      ? JSON.parse(job.snapshot_manifest_json) : await capturePackageSnapshot(pack.id);
    if (snapshot.version !== 1 || !Array.isArray(snapshot.tasks)) throw fail('导出版本清单无效', 409);
    const collected = await packageEntries(pack.id, pack.periodCode, snapshot, updateProgress);
    const exportRoot = path.join(storage.getArtifactDirectory(), 'exports');
    await fs.mkdir(exportRoot, { recursive: true });
    outputPath = path.join(exportRoot, `${crypto.randomUUID()}.zip`);
    await createZipFile(outputPath, collected.entries);
    const expiresAt = new Date(Date.now() + EXPORT_TTL_MS).toISOString();
    await run("UPDATE export_jobs SET status='complete', progress=100, storage_key=?, expires_at=?, completed_at=CURRENT_TIMESTAMP WHERE id=?",
      [outputPath, expiresAt, jobId]);
    await recordBusinessAudit({ actor: { id: job.requested_by }, action: 'bulk_export.completed', objectType: 'export_job',
      objectId: jobId, after: { status: 'complete', periodCode: pack.periodCode, taskCount: collected.taskCount,
        rowCount: collected.rowCount, expiresAt }, reason: '异步周期导出包已生成' });
  } catch (error) {
    if (outputPath) await fs.rm(outputPath, { force: true }).catch(() => {});
    const publicError = error.status ? String(error.message || '导出生成失败').slice(0, 300) : '导出文件生成失败，请重试或联系管理员';
    await run("UPDATE export_jobs SET status='failed', error_text=?, completed_at=CURRENT_TIMESTAMP WHERE id=?",
      [publicError, jobId]);
    await recordBusinessAudit({ actor: { id: job.requested_by }, action: 'bulk_export.failed', objectType: 'export_job', objectId: jobId,
      after: { status: 'failed', error: publicError }, reason: '异步周期导出包生成失败' }).catch(() => {});
  }
}

function enqueue(jobId) {
  queue = queue.then(() => runJob(jobId)).catch(error => console.error('Export worker failed', error));
}

async function initialize() {
  await cleanupExpiredJobs();
  if (!expiryTimer) {
    expiryTimer = setInterval(() => cleanupExpiredJobs().catch(error => console.error('Export expiry cleanup failed', error)), 60 * 60 * 1000);
    expiryTimer.unref?.();
  }
  await run("UPDATE export_jobs SET status='queued', progress=0 WHERE status='running'");
  const queued = await all("SELECT id FROM export_jobs WHERE status='queued' ORDER BY id");
  queued.forEach(job => enqueue(Number(job.id)));
}

async function cleanupExpiredJobs() {
  const expired = await all("SELECT id, storage_key AS storageKey FROM export_jobs WHERE status='complete' AND expires_at <= ?", [new Date().toISOString()]);
  for (const job of expired) {
    if (job.storageKey && insideDirectory(job.storageKey, path.join(storage.getArtifactDirectory(), 'exports'))) {
      await fs.rm(job.storageKey, { force: true }).catch(() => {});
    }
  }
  await run("UPDATE export_jobs SET status='expired', storage_key=NULL WHERE status='complete' AND expires_at <= ?", [new Date().toISOString()]);
}

async function createJob(actor, packageId) {
  assertManagement(actor);
  const id = Number(packageId);
  if (!Number.isSafeInteger(id) || id < 1) throw fail('周期配置包编号无效');
  let pack;
  let result;
  await run('BEGIN IMMEDIATE');
  try {
    pack = await get(`SELECT p.id FROM period_packages p JOIN report_types rt ON rt.id=p.report_type_id
      WHERE p.id=? AND p.status IN ('active','closed')`, [id]);
    if (!pack) throw fail('该周期没有已激活的配置包', 404);
    const snapshot = await capturePackageSnapshot(pack.id);
    result = await run('INSERT INTO export_jobs (package_id, requested_by, snapshot_manifest_json) VALUES (?, ?, ?)',
      [pack.id, actor.id, JSON.stringify(snapshot)]);
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    throw error;
  }
  const period = await get(`SELECT p.period_code AS periodCode, rt.display_name AS reportType FROM period_packages p
    JOIN report_types rt ON rt.id=p.report_type_id WHERE p.id=?`, [pack.id]);
  await recordBusinessAudit({ actor, action: 'bulk_export.requested', objectType: 'export_job', objectId: result.lastID,
    after: { status: 'queued', periodCode: period.periodCode, reportType: period.reportType, packageId: pack.id }, reason: '用户请求生成全公司周期导出包' });
  enqueue(Number(result.lastID));
  return getJob(Number(result.lastID), actor);
}

function assertJobAccess(job, actor) {
  if (Number(job.requested_by) === Number(actor.id) || hasGlobalRole(actor, 'system_admin') || hasGlobalRole(actor, 'management')) return;
  throw fail('无权访问此导出作业', 403);
}

function presentJob(row) {
  return { id: Number(row.id), packageId: Number(row.package_id), periodCode: row.period_code, status: row.status,
    reportType: row.report_type_name, progress: Number(row.progress), error: row.error_text || null, createdAt: row.created_at,
    completedAt: row.completed_at, expiresAt: row.expires_at, canDownload: row.status === 'complete' };
}

async function getJob(jobId, actor) {
  const job = await get(`SELECT j.*, p.period_code, rt.display_name AS report_type_name FROM export_jobs j
    JOIN period_packages p ON p.id=j.package_id JOIN report_types rt ON rt.id=p.report_type_id WHERE j.id=?`, [jobId]);
  if (!job) throw fail('导出作业不存在', 404);
  assertJobAccess(job, actor);
  if (job.status === 'complete' && job.expires_at && Date.parse(job.expires_at) <= Date.now()) {
    await fs.rm(job.storage_key, { force: true }).catch(() => {});
    await run("UPDATE export_jobs SET status='expired', storage_key=NULL WHERE id=? AND status='complete'", [jobId]);
    job.status = 'expired'; job.storage_key = null;
  }
  return presentJob(job);
}

async function listJobs(actor) {
  assertManagement(actor);
  const rows = await all(`SELECT j.*, p.period_code, rt.display_name AS report_type_name FROM export_jobs j
    JOIN period_packages p ON p.id=j.package_id JOIN report_types rt ON rt.id=p.report_type_id
    ORDER BY j.created_at DESC, j.id DESC LIMIT 100`);
  return rows.map(presentJob);
}

async function retryJob(jobId, actor) {
  assertManagement(actor);
  const original = await get('SELECT package_id, snapshot_manifest_json FROM export_jobs WHERE id=? AND status=?', [jobId, 'failed']);
  if (!original) throw fail('只有失败的导出作业可以重试', 409);
  const result = await run('INSERT INTO export_jobs (package_id, requested_by, snapshot_manifest_json) VALUES (?, ?, ?)',
    [original.package_id, actor.id, original.snapshot_manifest_json || '{}']);
  await recordBusinessAudit({ actor, action: 'bulk_export.retried', objectType: 'export_job', objectId: result.lastID,
    before: { sourceJobId: Number(jobId), packageId: Number(original.package_id) }, after: { status: 'queued' }, reason: '重试失败的导出作业' });
  enqueue(Number(result.lastID));
  return getJob(Number(result.lastID), actor);
}

async function downloadJob(jobId, actor) {
  const row = await get(`SELECT j.*, p.period_code, rt.display_name AS report_type_name FROM export_jobs j
    JOIN period_packages p ON p.id=j.package_id JOIN report_types rt ON rt.id=p.report_type_id WHERE j.id=?`, [jobId]);
  if (!row) throw fail('导出作业不存在', 404);
  assertJobAccess(row, actor);
  const job = await getJob(jobId, actor);
  if (job.status !== 'complete') throw fail(job.status === 'expired' ? '下载链接已过期' : '导出文件尚未就绪', job.status === 'expired' ? 410 : 409);
  const filePath = path.resolve(row.storage_key);
  if (!insideDirectory(filePath, path.join(storage.getArtifactDirectory(), 'exports'))) throw fail('导出文件路径无效', 404);
  await fs.access(filePath).catch(() => { throw fail('导出文件不存在', 410); });
  await recordBusinessAudit({ actor, action: 'bulk_export.downloaded', objectType: 'export_job', objectId: jobId,
    after: { periodCode: row.period_code, downloadedAt: new Date().toISOString() }, reason: '下载周期导出包' });
  return { path: filePath, filename: `周期导出-${row.period_code}.zip` };
}

async function listPeriods(actor) {
  const scope = resolveOrganizationScope(actor, { unauthorizedMessage: '无权查看原始数据周期' });
  if (scope.globalManagement) return all(`SELECT p.id AS packageId, p.report_type_id AS reportTypeId, p.version AS packageVersion,
      p.period_code AS periodCode, rt.display_name AS reportType
    FROM period_packages p JOIN report_types rt ON rt.id=p.report_type_id
    WHERE p.status IN ('active','closed') ORDER BY p.period_code DESC, rt.display_name`);
  if (scope.management) {
    const placeholders = scope.organizationIds.map(() => '?').join(',');
    return all(`SELECT DISTINCT p.id AS packageId, p.report_type_id AS reportTypeId, p.version AS packageVersion,
        t.period_code AS periodCode, rt.display_name AS reportType
      FROM report_tasks t JOIN period_packages p ON p.id=t.package_id JOIN report_types rt ON rt.id=t.report_type_id
        JOIN business_revisions r ON r.task_id=t.id
      WHERE t.organization_id IN (${placeholders}) AND r.submitted_at IS NOT NULL
      ORDER BY t.period_code DESC, rt.display_name`, scope.organizationIds);
  }
  return all(`SELECT DISTINCT p.id AS packageId, p.report_type_id AS reportTypeId, p.version AS packageVersion,
      t.period_code AS periodCode, rt.display_name AS reportType
    FROM report_tasks t JOIN period_packages p ON p.id=t.package_id JOIN report_types rt ON rt.id=t.report_type_id
      JOIN business_revisions r ON r.task_id=t.id
    WHERE t.organization_id=? AND r.submitted_at IS NOT NULL ORDER BY t.period_code DESC, rt.display_name`, scope.organizationIds);
}

async function listOrganizations(actor, packageId) {
  const id = Number(packageId);
  if (!Number.isSafeInteger(id) || id < 1) throw fail('周期配置包编号无效');
  const pack = await get("SELECT id FROM period_packages WHERE id=? AND status IN ('active','closed')", [id]);
  if (!pack) throw fail('周期配置包不存在', 404);
  const scope = resolveOrganizationScope(actor, { unauthorizedMessage: '无权查看该周期的组织' });
  const organizationIds = scope.organizationIds;
  const filters = ['t.package_id=?'];
  const params = [id];
  if (organizationIds?.length === 1) { filters.push('t.organization_id=?'); params.push(organizationIds[0]); }
  else if (organizationIds?.length > 1) { filters.push(`t.organization_id IN (${organizationIds.map(() => '?').join(',')})`); params.push(...organizationIds); }
  const organizations = await all(`SELECT DISTINCT o.id, o.code, o.name FROM report_tasks t
    JOIN organizations o ON o.id=t.organization_id WHERE ${filters.join(' AND ')} ORDER BY o.code`, params);
  if (!organizations.length && organizationIds?.length === 1) throw fail('该周期不包含当前组织', 403);
  return organizations.map(organization => ({ id: Number(organization.id), code: organization.code, name: organization.name }));
}

module.exports = { exportRawData, createJob, getJob, listJobs, retryJob, downloadJob, listPeriods, listOrganizations, initialize,
  _test: { makeRawWorkbook, buildRawQuery, valueOf, safeZipSegment, scopedManagementOrganizationIds, resolveOrganizationScope } };
