const db = require('../config/database');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('../config/storage');
const { renderReport } = require('./reportRenderer');
const { readRevisionWorkbook } = require('./staticWorkbookFile');
const { recordBusinessAudit } = require('./businessAudit');
const { contractFor, projectTables, columnsFor, withColumnNames, designRows } = require('./reportDataContract');
const all = (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (e, r) => e ? reject(e) : resolve(r)));
const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function(e) { e ? reject(e) : resolve(this); }));
// A short database lock must not strand a finished job in "running".
async function writeJobState(sql, args = []) {
  for (let attempt = 0; ; attempt++) {
    try { return await run(sql, args); }
    catch (error) {
      if (!['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code) || attempt >= 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
const get = async (sql, args) => (await all(sql, args))[0];
const parse = (s, fallback = {}) => { try { return JSON.parse(s); } catch { return fallback; } };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const has = (actor, codes) => actor?.roles?.some(r => codes.includes(r.code));
const admin = actor => has(actor, ['system_admin']);
const designer = actor => admin(actor) || has(actor, ['template_designer']);
const manager = actor => has(actor, ['system_admin', 'management', 'report_finalizer']);
let ready, busy = false, interval;
const workerId = crypto.randomUUID();
const leaseDuration = 120000;
const heartbeatInterval = 10000;

function initialize() {
  if (!ready) ready = db.ready.then(() => new Promise((resolve, reject) => db.exec(`
    CREATE TABLE IF NOT EXISTS report_studio_templates (
      id INTEGER PRIMARY KEY, family_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','in_review','published','rejected')),
      template_json TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), reviewed_by INTEGER REFERENCES users(id),
      review_note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(family_id,version));
    CREATE TABLE IF NOT EXISTS report_studio_schedules (
      id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES report_studio_templates(id), name TEXT NOT NULL,
      query_json TEXT NOT NULL, day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 28), time TEXT NOT NULL,
      month_offset INTEGER NOT NULL DEFAULT -1 CHECK(month_offset IN (-1,0)), next_run TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS report_studio_jobs (
      id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES report_studio_templates(id),
      schedule_id INTEGER REFERENCES report_studio_schedules(id), slot TEXT UNIQUE, query_json TEXT NOT NULL,
      requested_by INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'queued', shared INTEGER NOT NULL DEFAULT 0,
      manifest_json TEXT, artifact_key TEXT, error_text TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT);
  `, e => e ? reject(e) : resolve()))).then(async () => {
    // Upgrade existing demo databases without racing another starting instance.
    for (const [name, type] of [['worker_id', 'TEXT'], ['lease_expires_at', 'INTEGER'], ['shared', 'INTEGER NOT NULL DEFAULT 0']]) {
      if ((await all('PRAGMA table_info(report_studio_jobs)')).some(c => c.name === name)) continue;
      try { await run(`ALTER TABLE report_studio_jobs ADD COLUMN ${name} ${type}`); }
      catch (error) {
        if (!(await all('PRAGMA table_info(report_studio_jobs)')).some(c => c.name === name)) throw error;
      }
    }
  });
  return ready;
}

function scope(actor) {
  if (!manager(actor)) throw fail('需要报表管理或定稿职责', 403);
  if (admin(actor) || actor.roles.some(r => ['management', 'report_finalizer'].includes(r.code) && r.organizationId == null)) return null;
  return [...new Set(actor.roles.filter(r => ['management', 'report_finalizer'].includes(r.code)).map(r => Number(r.organizationId)).filter(Boolean))];
}
function normalizeQuery(actor, input) {
  const allowed = scope(actor), reportTypeId = Number(input.reportTypeId);
  if (!Number.isSafeInteger(reportTypeId) || reportTypeId <= 0) throw fail('请选择报告类型');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.periodCode || '')) throw fail('请选择报告期间（YYYY-MM）');
  let organizationIds = [...new Set((input.organizationIds || []).map(Number))];
  if (organizationIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw fail('组织编号无效');
  if (allowed && organizationIds.some(id => !allowed.includes(id))) throw fail('无权读取所选组织', 403);
  if (!organizationIds.length && allowed) organizationIds = allowed;
  if (allowed && !organizationIds.length) throw fail('没有可访问的组织', 403);
  return { reportTypeId, periodCode: input.periodCode, organizationIds };
}
function deniedSheets(workbook) {
  return new Set((workbook.sheets || []).filter(s => s.type === 'readonly_auxiliary' || s.type === 'auxiliary' || s.readOnly === true).flatMap(s => [s.name, s.name?.slice(0, 31), s.code]).filter(Boolean));
}
async function dataset(actor, input, withSources = false, preview = false) {
  const allowed = scope(actor);
  const query = preview ? { reportTypeId: Number(input.reportTypeId), organizationIds: allowed || [] } : normalizeQuery(actor, input);
  if (preview && allowed && !allowed.length) return { rows: [], sources: [], revisions: [], incomplete: [], taskCount: 0, query };
  const args = [query.reportTypeId];
  if (!preview) args.push(query.periodCode);
  const reportType = await get('SELECT cadence FROM report_types WHERE id=?', [query.reportTypeId]);
  if (reportType?.cadence !== 'monthly') throw fail('当前报表数据源支持月度填报类型');
  let filter = '';
  if (query.organizationIds.length) { filter = ` AND t.organization_id IN (${query.organizationIds.map(() => '?').join(',')})`; args.push(...query.organizationIds); }
  // Select every task so a generated report cannot silently omit unfinished organizations.
  const tasks = await all(`SELECT t.id,t.organization_id AS organizationId,o.code AS organizationCode,o.name AS organizationName,
    t.period_code AS periodCode,rt.display_name AS reportType,r.id AS revisionId,r.revision_number AS revisionNumber,
    a.storage_key AS workbookPath,tv.workbook_json AS workbookJson
    FROM report_tasks t JOIN organizations o ON o.id=t.organization_id JOIN report_types rt ON rt.id=t.report_type_id
    JOIN template_versions tv ON tv.id=t.template_version_id
    LEFT JOIN business_revisions r ON r.id=t.current_revision_id AND r.is_current_effective=1 AND r.revision_status='finalized'
    LEFT JOIN official_artifacts a ON a.id=r.workbook_artifact_id
    WHERE t.report_type_id=? ${preview ? 'AND r.id IS NOT NULL' : 'AND t.period_code=?'} AND t.task_status NOT IN ('cancelled','canceled') ${filter}
    ORDER BY ${preview ? 't.period_code DESC,t.id DESC LIMIT 10' : 'o.code,t.id'}`, args);
  const rows = [], sources = [], sourceWorkbooks = [], revisions = [], incomplete = [];
  for (const id of query.organizationIds) if (!tasks.some(t => t.organizationId === id)) {
    const org = await get('SELECT name FROM organizations WHERE id=?', [id]);
    incomplete.push(`${org?.name || id}（没有该期间的填报任务）`);
  }
  for (const task of tasks) {
    if (!task.revisionId) { incomplete.push(task.organizationName); continue; }
    const workbook = parse(task.workbookJson), excluded = deniedSheets(workbook);
    const values = await all(`SELECT v.*,f.code AS fieldCode,f.display_name AS fieldName,f.unit FROM business_values v
      JOIN field_definitions f ON f.id=v.field_definition_id WHERE v.revision_id=?
      ${preview ? 'AND v.record_key IN (SELECT DISTINCT record_key FROM business_values WHERE revision_id=? ORDER BY record_key LIMIT 10)' : ''}
      ORDER BY v.record_key,f.code`, preview ? [task.revisionId, task.revisionId] : [task.revisionId]);
    for (const value of values) {
      if (excluded.has(value.source_sheet)) continue;
      const key = `${value.value_type}_value`;
      const raw = value[key];
      rows.push({ taskId: task.id, organizationId: task.organizationId, organizationCode: task.organizationCode,
        organizationName: task.organizationName, periodCode: task.periodCode, reportType: task.reportType,
        revisionId: task.revisionId, recordKey: value.record_key, sheetName: value.source_sheet || '',
        sheetCode: (workbook.sheets || []).find(s => [s.code,s.name,s.name?.slice(0,31)].includes(value.source_sheet))?.code || value.source_sheet || '',
        sourceNamedArea: value.source_named_area || '', fieldDefinitionId: value.field_definition_id,
        fieldCode: value.fieldCode, fieldName: value.fieldName, unit: value.unit_snapshot || value.unit || '',
        value: ['decimal', 'integer'].includes(value.value_type) ? Number(raw) : value.value_type === 'boolean' ? Boolean(raw) : raw,
        valueType: value.value_type });
    }
    revisions.push({ taskId: task.id, revisionId: task.revisionId, revisionNumber: task.revisionNumber, organizationId: task.organizationId, organizationName: task.organizationName });
    if (withSources) {
      if (!task.workbookPath) throw fail(`${task.organizationName} 缺少定稿工作簿`, 409);
      const book = await readRevisionWorkbook(task.workbookPath, task.revisionId, db);
      sourceWorkbooks.push({ revisionId: task.revisionId, workbook: book });
      for (const sheet of Object.values(book.sheets || {})) {
        if (excluded.has(sheet.name)) continue;
        const name = `${task.organizationCode}_${task.id}_${sheet.name}`.replace(/[\\/*?:\[\]]/g, '_').slice(0, 25) + `_${sources.length + 1}`;
        sources.push({ name, revisionId: task.revisionId, sheetName: sheet.name });
      }
    }
  }
  if (rows.length > 50000) throw fail('超过 50,000 条指标明细，请缩小组织范围');
  return { query, rows, sources, sourceWorkbooks, revisions, incomplete, taskCount: tasks.length };
}
async function designSource(actor, reportTypeId) {
  if (!designer(actor) && !manager(actor)) throw fail('没有报表设计权限', 403);
  const contract = await contractFor(reportTypeId);
  return { ...contract, limit: 10, canPreview: manager(actor) && (scope(actor) == null || scope(actor).length > 0) };
}
async function designData(actor, reportTypeId, tableName, legacy = false) {
  const contract = await designSource(actor, reportTypeId);
  if (!legacy && !contract.tables.some(t => t.name === tableName)) throw fail('数据表不存在', 404);
  // Template authoring alone never grants access to finalized business values.
  const data = contract.canPreview ? await dataset(actor, { reportTypeId }, false, true) : { rows: [] };
  if (legacy && tableName === 'ReportData') return data.rows.slice(0, 10);
  const table = projectTables(contract, data.rows, 10).find(t => t.name === tableName);
  return table ? designRows(table) : [];
}
async function prepareRender(actor, input) {
  await initialize();
  const query = normalizeQuery(actor, input);
  const t = await template(actor, input.templateId);
  if (t.status !== 'published') throw fail('请先发布报表模板', 409);
  checkSource(t, query);
  const data = await dataset(actor, query, true);
  if (!data.taskCount || !data.rows.length) throw fail('所选范围没有可生成的已定稿指标数据', 409);
  if (data.incomplete.length) throw fail(`以下组织尚未定稿：${[...new Set(data.incomplete)].join('、')}`, 409);
  const tables = t.template.schemaVersion === 2 ? projectTables(t.template.dataSource, data.rows).map(table => ({
    ...table, schema: { columns: columnsFor(table) } })) : undefined;
  const parameters = { period: query.periodCode, periodCode: query.periodCode, reportTypeId: query.reportTypeId };
  const manifest = { templateId: t.id, templateName: t.name, version: t.version, parameters, query,
    sourceRevisions: data.revisions, rowCount: data.rows.length, sourceSheetCount: data.sources.length };
  return { template: t.template, templateMeta: { id: t.id, name: t.name, version: t.version },
    query, parameters, rows: data.rows, tables, sources: data.sources, sourceWorkbooks: data.sourceWorkbooks,
    revisions: data.revisions, manifest };
}
function validateTemplate(value) {
  if (!value || ![1, 2].includes(value.schemaVersion) || !Array.isArray(value.sheets) || value.sheets.length < 1 || value.sheets.length > 12) throw fail('需要 1–12 张 ReportSheet');
  if (value.schemaVersion === 2 && (!Number.isSafeInteger(value.dataSource?.reportTypeId) || value.dataSource.reportTypeId < 1)) throw fail('请选择业务数据来源');
  const names = new Set();
  for (const sheet of value.sheets) {
    if (!sheet.name || sheet.name.length > 31 || /[\\/*?:\[\]]/.test(sheet.name) || names.has(sheet.name)) throw fail('报表工作表名称无效或重复');
    names.add(sheet.name);
    if (!sheet.json || typeof sheet.json !== 'object' || Array.isArray(sheet.json)) throw fail('报表模板内容无效');
  }
  // Store native templates only. DataManager/remote sources and actual business rows are supplied at generation.
  const visit = object => {
    if (!object || typeof object !== 'object') return;
    for (const [key, val] of Object.entries(object)) {
      if (['dataSource', 'dataManager', 'remote', 'connectionString'].includes(key) && val != null) throw fail('报表模板只保存布局，请使用系统定稿数据源');
      visit(val);
    }
  };
  visit(value.sheets);
  if (JSON.stringify(value).length > 5000000) throw fail('模板内容超过 5 MB');
  return value;
}
async function template(actor, id) {
  await initialize();
  const row = await get('SELECT * FROM report_studio_templates WHERE id=?', [Number(id)]);
  if (!row) throw fail('报表模板不存在', 404);
  if (!admin(actor) && row.created_by !== actor.id && row.status !== 'published') throw fail('无权查看此模板', 403);
  if (!designer(actor) && !manager(actor)) throw fail('无权查看报表模板', 403);
  return { ...row, template: parse(row.template_json), template_json: undefined };
}
async function saveTemplate(actor, input) {
  await initialize();
  if (!designer(actor)) throw fail('需要模板设计职责', 403);
  const name = String(input.name || '').trim();
  if (!name || name.length > 120) throw fail('请填写 1–120 字的模板名称');
  const checked = validateTemplate(input.template);
  let source = checked.schemaVersion === 2 ? await contractFor(checked.dataSource.reportTypeId) : null;
  if (source) {
    if (checked.dataSource.columnMapping === 'named-v1') source = withColumnNames(source, checked.dataSource);
    else {
      // Existing templates still reference wire keys; do not reinterpret their formulas.
      delete source.columnMapping;
      source.tables = source.tables.map(t => ({ ...t, columns: t.columns.map(({ bindingName, ...c }) => c) }));
    }
  }
  // Rebuild the source definition on the server: never persist caller-provided rows, URLs or JWTs.
  const json = JSON.stringify({ schemaVersion: checked.schemaVersion, sheets: checked.sheets, ...(source ? { dataSource: source } : {}) });
  let row = input.id ? await template(actor, input.id) : null;
  if (row && !admin(actor) && row.created_by !== actor.id) throw fail('只能修改本人模板', 403);
  if (row?.status === 'in_review') throw fail('模板正在审批中', 409);
  if (row && ['draft', 'rejected'].includes(row.status)) {
    const changed = await run("UPDATE report_studio_templates SET name=?,template_json=?,status='draft',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('draft','rejected')", [name, json, row.id]);
    if (!changed.changes) throw fail('模板状态已变化，请刷新后重试', 409);
  } else {
    const family = row?.family_id || crypto.randomUUID();
    const result = await run(`INSERT INTO report_studio_templates(family_id,name,version,template_json,created_by)
      SELECT ?,?,COALESCE(MAX(version),0)+1,?,? FROM report_studio_templates WHERE family_id=?`, [family, name, json, actor.id, family]);
    row = { id: result.lastID };
  }
  await audit(actor, 'save', row.id);
  return template(actor, row.id);
}
async function transition(actor, id, action, note) {
  const row = await template(actor, id);
  let next;
  if (action === 'submit') {
    if (!designer(actor) || (!admin(actor) && row.created_by !== actor.id)) throw fail('无权提交此模板', 403);
    if (!['draft', 'rejected'].includes(row.status)) throw fail('当前状态不能提交', 409);
    next = admin(actor) ? 'published' : 'in_review';
  } else {
    if (!admin(actor)) throw fail('仅系统管理员可以审批', 403);
    if (row.status !== 'in_review' || !['approve', 'reject'].includes(action)) throw fail('当前状态不能审批', 409);
    next = action === 'approve' ? 'published' : 'rejected';
  }
  const changed = await run('UPDATE report_studio_templates SET status=?,reviewed_by=?,review_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?', [next, next === 'in_review' ? null : actor.id, String(note || '').slice(0, 1000), row.id, row.status]);
  if (!changed.changes) throw fail('模板状态已变化', 409);
  await audit(actor, action, row.id);
  return template(actor, row.id);
}
const audit = (actor, action, id) => recordBusinessAudit({ actor, action: `report_template.${action}`, objectType: 'report_template', objectId: id });
async function actorFor(id) {
  const user = await get("SELECT id,organization_id AS organizationId FROM users WHERE id=? AND account_status='active'", [id]);
  if (!user) throw fail('发起人账号已停用', 403);
  user.roles = await all('SELECT role_code AS code,organization_id AS organizationId FROM effective_user_roles WHERE user_id=? AND effective_from<=CURRENT_TIMESTAMP AND (effective_to IS NULL OR effective_to>CURRENT_TIMESTAMP)', [id]);
  return user;
}
async function enqueue(actor, input, scheduleId = null, slot = null) {
  await initialize();
  const query = normalizeQuery(actor, input), t = await template(actor, input.templateId);
  if (t.status !== 'published') throw fail('请先发布报表模板', 409);
  checkSource(t, query);
  const result = await run('INSERT INTO report_studio_jobs(template_id,schedule_id,slot,query_json,requested_by) VALUES(?,?,?,?,?)', [t.id, scheduleId, slot, JSON.stringify(query), actor.id]);
  await recordBusinessAudit({ actor, action: 'report_generation.requested', objectType: 'report_studio_job', objectId: result.lastID, after: { templateId: t.id, query } });
  return { id: result.lastID, status: 'queued' };
}
async function uploadResult(actor, body, files) {
  await initialize();
  if (!manager(actor)) throw fail('没有报表生成权限', 403);
  let organizationIds;
  try { organizationIds = Array.isArray(body.organizationIds) ? body.organizationIds : JSON.parse(body.organizationIds || '[]'); }
  catch { throw fail('组织范围无效'); }
  const query = normalizeQuery(actor, { reportTypeId: Number(body.reportTypeId), periodCode: body.periodCode, organizationIds });
  const t = await template(actor, Number(body.templateId));
  if (t.status !== 'published') throw fail('请先发布报表模板', 409);
  checkSource(t, query);
  const data = await dataset(actor, query, false);
  if (!data.taskCount || !data.rows.length) throw fail('所选范围没有可生成的已定稿指标数据', 409);
  if (data.incomplete.length) throw fail(`以下组织尚未定稿：${[...new Set(data.incomplete)].join('、')}`, 409);
  const workbookFile = files?.workbook?.[0], xlsxFile = files?.xlsx?.[0], pdfFile = files?.pdf?.[0];
  if (!workbookFile || !xlsxFile || !pdfFile) throw fail('报表成果文件不完整');
  if (workbookFile.size + xlsxFile.size + pdfFile.size > 50 * 1024 * 1024) throw fail('报表成果超过 50 MB');
  let workbook;
  try { workbook = JSON.parse(workbookFile.buffer.toString('utf8')); }
  catch { throw fail('报表工作簿 JSON 无效'); }
  if (!workbook || typeof workbook !== 'object' || !workbook.sheets) throw fail('报表工作簿 JSON 无效');
  if (xlsxFile.buffer.subarray(0, 2).toString('latin1') !== 'PK') throw fail('Excel 文件无效');
  if (pdfFile.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw fail('PDF 文件无效');
  let clientManifest = {};
  try { clientManifest = typeof body.manifest === 'string' ? JSON.parse(body.manifest) : (body.manifest || {}); } catch { clientManifest = {}; }
  const parameters = { period: query.periodCode, periodCode: query.periodCode, reportTypeId: query.reportTypeId };
  const manifest = { templateId: t.id, templateName: t.name, version: t.version, parameters, query,
    generatedAt: new Date().toISOString(), sourceRevisions: data.revisions, rowCount: data.rows.length,
    sourceSheetCount: Number.isSafeInteger(Number(clientManifest.sourceSheetCount)) ? Number(clientManifest.sourceSheetCount) : 0 };
  const key = crypto.randomUUID(), directory = path.join(storage.getArtifactDirectory(), 'report-studio', key);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'workbook.json'), JSON.stringify(workbook));
    await fs.writeFile(path.join(directory, 'report.xlsx'), xlsxFile.buffer);
    await fs.writeFile(path.join(directory, 'report.pdf'), pdfFile.buffer);
    const result = await run(`INSERT INTO report_studio_jobs
      (template_id, query_json, requested_by, status, shared, manifest_json, artifact_key, completed_at)
      VALUES (?, ?, ?, 'complete', 1, ?, ?, CURRENT_TIMESTAMP)`,
    [t.id, JSON.stringify(query), actor.id, JSON.stringify(manifest), key]);
    await recordBusinessAudit({ actor, action: 'report_generation.uploaded', objectType: 'report_studio_job',
      objectId: result.lastID, after: manifest });
    return { id: result.lastID, status: 'complete' };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
async function processJob(job, renderer = renderReport) {
  const claim = await run("UPDATE report_studio_jobs SET status='running',worker_id=?,lease_expires_at=? WHERE id=? AND status='queued'", [workerId, Date.now() + leaseDuration, job.id]);
  if (!claim.changes) return;
  let heartbeatPending = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatPending = heartbeatPending.then(() => writeJobState(
      "UPDATE report_studio_jobs SET lease_expires_at=? WHERE id=? AND status='running' AND worker_id=? AND lease_expires_at>?",
      [Date.now() + leaseDuration, job.id, workerId, Date.now()],
    )).catch(error => console.error(`报表任务 ${job.id} 心跳保存失败:`, error.message));
  }, heartbeatInterval);
  heartbeat.unref();
  try {
    const actor = await actorFor(job.requested_by), t = await template(actor, job.template_id);
    if (t.status !== 'published') throw fail('报表模板尚未发布', 409);
    const data = await dataset(actor, parse(job.query_json), true);
    checkSource(t, data.query);
    if (!data.taskCount || !data.rows.length) throw fail('所选范围没有可生成的已定稿指标数据', 409);
    if (data.incomplete.length) throw fail(`以下组织尚未定稿：${[...new Set(data.incomplete)].join('、')}`, 409);
    const key = `${job.id}-${crypto.randomUUID()}`, directory = path.join(storage.getArtifactDirectory(), 'report-studio', key);
    const parameters = { period: data.query.periodCode, periodCode: data.query.periodCode, reportTypeId: data.query.reportTypeId };
    const tables = t.template.schemaVersion === 2 ? projectTables(t.template.dataSource, data.rows).map(table => ({ ...table, schema: { columns: columnsFor(table) } })) : undefined;
    const rendered = await renderer({ template: t.template, rows: data.rows, tables, parameters, sources: data.sources, sourceWorkbooks: data.sourceWorkbooks });
    const manifest = { templateId: t.id, templateName: t.name, version: t.version, parameters, query: data.query,
      generatedAt: new Date().toISOString(), sourceRevisions: data.revisions, rowCount: data.rows.length, sourceSheetCount: data.sources.length };
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'workbook.json'), JSON.stringify(rendered.json));
    await fs.writeFile(path.join(directory, 'report.xlsx'), Buffer.from(rendered.xlsx, 'base64'));
    await fs.writeFile(path.join(directory, 'report.pdf'), Buffer.from(rendered.pdf, 'base64'));
    await fs.writeFile(path.join(directory, 'snapshot.json'), JSON.stringify({ manifest, rows: data.rows, tables }));
    const completed = await writeJobState("UPDATE report_studio_jobs SET status='complete',artifact_key=?,manifest_json=?,completed_at=CURRENT_TIMESTAMP,lease_expires_at=NULL WHERE id=? AND status='running' AND worker_id=? AND lease_expires_at>?", [key, JSON.stringify(manifest), job.id, workerId, Date.now()]);
    if (!completed.changes) throw fail('生成任务的执行权已失效，请重新生成', 409);
    await recordBusinessAudit({ actor, action: 'report_generation.completed', objectType: 'report_studio_job', objectId: job.id, after: manifest });
  } catch (error) {
    await writeJobState("UPDATE report_studio_jobs SET status='failed',error_text=?,completed_at=CURRENT_TIMESTAMP,lease_expires_at=NULL WHERE id=? AND status='running' AND worker_id=?", [String(error.message).slice(0, 2000), job.id, workerId]);
  } finally {
    clearInterval(heartbeat);
    await heartbeatPending;
  }
}
// Monthly civil time in Asia/Shanghai, no dependency on the server's local timezone.
function nextRun(day, time, after = new Date()) {
  const civil = new Date(after.getTime() + 8 * 3600000);
  let year = civil.getUTCFullYear(), month = civil.getUTCMonth();
  const [hour, minute] = time.split(':').map(Number);
  let next = new Date(Date.UTC(year, month, day, hour - 8, minute));
  if (next <= after) next = new Date(Date.UTC(year, month + 1, day, hour - 8, minute));
  return next.toISOString();
}
async function saveSchedule(actor, input) {
  await initialize();
  const q = normalizeQuery(actor, { ...input, periodCode: '2000-01' });
  const t = await template(actor, input.templateId);
  if (t.status !== 'published') throw fail('计划必须使用已发布的模板版本', 409);
  checkSource(t, q);
  const day = Number(input.day), time = String(input.time || '');
  if (!Number.isInteger(day) || day < 1 || day > 28 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw fail('请选择每月 1–28 日和有效时间');
  if (![-1, 0].includes(Number(input.monthOffset))) throw fail('报告期间应选择当月或上月');
  const result = await run(`INSERT INTO report_studio_schedules(template_id,name,query_json,day,time,month_offset,next_run,created_by) VALUES(?,?,?,?,?,?,?,?)`,
    [t.id, String(input.name || t.name).slice(0, 120), JSON.stringify(q), day, time, Number(input.monthOffset), nextRun(day, time), actor.id]);
  await recordBusinessAudit({ actor, action: 'report_schedule.created', objectType: 'report_studio_schedule', objectId: result.lastID, after: { templateId: t.id, query: q, day, time, monthOffset: Number(input.monthOffset) } });
  return { id: result.lastID };
}
async function toggleSchedule(actor, id, enabled) {
  const row = await get('SELECT * FROM report_studio_schedules WHERE id=?', [id]);
  if (!row) throw fail('计划不存在', 404);
  if (!manager(actor) || (!admin(actor) && row.created_by !== actor.id)) throw fail('无权修改该计划', 403);
  await run('UPDATE report_studio_schedules SET enabled=?,next_run=? WHERE id=?', [enabled ? 1 : 0, enabled ? nextRun(row.day, row.time) : row.next_run, id]);
  await recordBusinessAudit({ actor, action: 'report_schedule.updated', objectType: 'report_studio_schedule', objectId: id, after: { enabled } });
  return { ok: true };
}
async function tick(now = new Date(), renderer = renderReport) {
  if (busy) return;
  busy = true;
  try {
    await initialize();
    // busy protects only this instance. Other instances may still be rendering.
    // Our own unfinished rows are abandoned; foreign rows require an expired lease.
    // Legacy rows have no owner, so allow a grace period during upgrade as well.
    await writeJobState(`UPDATE report_studio_jobs SET status='failed',error_text='生成任务已中断，未能保存结束状态，请重试',completed_at=CURRENT_TIMESTAMP,lease_expires_at=NULL
      WHERE status='running' AND (worker_id=? OR lease_expires_at<=?
        OR (worker_id IS NULL AND lease_expires_at IS NULL AND created_at<=?))`,
    [workerId, Date.now(), new Date(Date.now() - leaseDuration).toISOString().slice(0, 19).replace('T', ' ')]);
    for (const plan of await all('SELECT * FROM report_studio_schedules WHERE enabled=1 AND next_run<=? ORDER BY next_run LIMIT 10', [now.toISOString()])) {
      const civil = new Date(new Date(plan.next_run).getTime() + 8 * 3600000);
      const period = new Date(Date.UTC(civil.getUTCFullYear(), civil.getUTCMonth() + plan.month_offset, 1)).toISOString().slice(0, 7);
      const query = { ...parse(plan.query_json), periodCode: period };
      // Unique slot and conditional advance make restart/retry safe. Authorization is checked again at execution.
      await run(`INSERT OR IGNORE INTO report_studio_jobs(template_id,schedule_id,slot,query_json,requested_by) VALUES(?,?,?,?,?)`, [plan.template_id, plan.id, `${plan.id}:${plan.next_run}`, JSON.stringify(query), plan.created_by]);
      await run('UPDATE report_studio_schedules SET next_run=? WHERE id=? AND next_run=?', [nextRun(plan.day, plan.time, new Date(plan.next_run)), plan.id, plan.next_run]);
    }
    const job = await get("SELECT * FROM report_studio_jobs WHERE status='queued' ORDER BY id LIMIT 1");
    if (job) await processJob(job, renderer);
  } finally { busy = false; }
}
async function start() {
  await initialize();
  if (interval) return;
  interval = setInterval(() => tick().catch(e => console.error('报表调度:', e.message)), 5000); interval.unref();
  tick().catch(e => console.error('报表调度:', e.message));
}
async function stop() { clearInterval(interval); interval = null; while (busy) await new Promise(resolve => setTimeout(resolve, 100)); }
async function jobFor(actor, id) {
  await initialize();
  const row = await get('SELECT j.*,t.name,t.version FROM report_studio_jobs j JOIN report_studio_templates t ON t.id=j.template_id WHERE j.id=?', [id]);
  if (!row) throw fail('生成记录不存在', 404);
  if (!admin(actor) && row.requested_by !== actor.id && !(row.shared && manager(actor))) throw fail('无权查看该生成记录', 403);
  normalizeQuery(actor, parse(row.query_json));
  const allowed = scope(actor), manifest = parse(row.manifest_json);
  if (allowed && (manifest.sourceRevisions || []).some(r => !allowed.includes(Number(r.organizationId)))) throw fail('已失去成果中部分组织的访问权限', 403);
  return { ...row, manifest, query: parse(row.query_json), artifact_key: undefined, path: row.artifact_key && path.join(storage.getArtifactDirectory(), 'report-studio', row.artifact_key) };
}
async function list(actor) {
  await initialize();
  if (!designer(actor) && !manager(actor)) throw fail('没有报表工作室权限', 403);
  const templates = await all(`SELECT id,family_id,name,version,status,created_by,reviewed_by,review_note,created_at,template_json FROM report_studio_templates
    WHERE status='published' OR created_by=? OR ?=1 ORDER BY id DESC`, [actor.id, admin(actor) ? 1 : 0]);
  const schedules = manager(actor) ? await all('SELECT * FROM report_studio_schedules WHERE created_by=? OR ?=1 ORDER BY id DESC', [actor.id, admin(actor) ? 1 : 0]) : [];
  const permitted = manager(actor) ? scope(actor) : [];
  const jobRows = manager(actor) ? await all(`SELECT j.id,j.template_id,j.status,j.shared,j.error_text,j.created_at,j.completed_at,j.query_json,j.manifest_json,t.name,t.version
    FROM report_studio_jobs j JOIN report_studio_templates t ON t.id=j.template_id
    WHERE requested_by=? OR ?=1 OR j.shared=1 ORDER BY j.id DESC LIMIT 100`, [actor.id, admin(actor) ? 1 : 0]) : [];
  const jobs = jobRows.filter(job => {
    if (!job.shared || admin(actor)) return true;
    try {
      normalizeQuery(actor, parse(job.query_json));
      const manifest = parse(job.manifest_json);
      return !permitted || !(manifest.sourceRevisions || []).some(r => !permitted.includes(Number(r.organizationId)));
    } catch { return false; }
  }).map(({ shared, manifest_json, ...job }) => ({ ...job, query: parse(job.query_json) }));
  const organizations = manager(actor) ? (await all("SELECT id,code,name FROM organizations WHERE status='active'")).filter(o => !permitted || permitted.includes(o.id)) : [];
  return { templates: templates.map(t => ({ ...t, template_json: undefined, sourceReportTypeId: parse(t.template_json).dataSource?.reportTypeId || null })), schedules: schedules.map(p => ({ ...p, query: parse(p.query_json) })), jobs, organizations,
    reportTypes: await all('SELECT id,display_name AS name,cadence FROM report_types'), capabilities: { design: designer(actor), manage: manager(actor), approve: admin(actor) } };
}
function checkSource(template, query) {
  if (template.template.schemaVersion === 2 && template.template.dataSource.reportTypeId !== query.reportTypeId) throw fail('生成数据来源必须与报表模板的填报类型一致');
}
module.exports = { initialize, list, template, saveTemplate, transition, dataset, designSource, designData, prepareRender, uploadResult, enqueue, saveSchedule, toggleSchedule, tick, start, stop, jobFor, nextRun, validateTemplate, deniedSheets };
