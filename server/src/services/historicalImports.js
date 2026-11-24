const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const db = require('../config/database');
const storage = require('../config/storage');
const { recordBusinessAudit } = require('./businessAudit');

const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const run = (connection, sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

async function begin() {
  await db.ready;
  const connection = new sqlite3.Database(storage.getDatabasePath());
  connection.configure('busyTimeout', 10000);
  await run(connection, 'PRAGMA foreign_keys = ON');
  await run(connection, 'PRAGMA busy_timeout = 10000');
  await run(connection, 'BEGIN IMMEDIATE');
  return connection;
}

function readValue(field, value) {
  const type = field.semantic_type;
  if (value === '' || value == null) throw fail('值不能为空');
  if (type === 'decimal') {
    const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    if (typeof raw !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)
      || (raw.split('.')[1]?.length || 0) > field.precision) throw fail(`数值须为十进制且最多 ${field.precision} 位小数`);
    return { value_type: 'decimal', decimal_value: raw };
  }
  if (type === 'integer') {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^-?(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed)) throw fail('须为有效整数');
    return { value_type: 'integer', integer_value: parsed };
  }
  if (type === 'boolean') {
    const bool = typeof value === 'boolean' ? value : ({ true: true, false: false, 1: true, 0: false, 是: true, 否: false })[String(value).trim().toLowerCase()];
    if (typeof bool !== 'boolean') throw fail('布尔值须为 true/false、1/0 或 是/否');
    return { value_type: 'boolean', boolean_value: Number(bool) };
  }
  if (type === 'short_text' || type === 'long_text') {
    const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
    if (text == null || (type === 'short_text' && text.length > 500) || (type === 'long_text' && text.length > 20000)) throw fail('文本值无效或超出长度限制');
    return { value_type: 'text', text_value: text };
  }
  if (type === 'date' || type === 'datetime') {
    let text = value instanceof Date ? value.toISOString().slice(0, type === 'date' ? 10 : 23) : value;
    if (typeof text === 'number' && Number.isFinite(text)) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.round(text * 86400000));
      text = date.toISOString().slice(0, 10);
    }
    if (type === 'date') {
      const date = typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00.000Z`) : null;
      if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw fail('日期须采用 YYYY-MM-DD 格式');
    } else if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text) || Number.isNaN(Date.parse(text))) {
      throw fail('日期时间须为带时区的 ISO 8601 格式');
    }
    return { value_type: 'date', date_value: text };
  }
  if (type === 'enum') {
    const options = JSON.parse(field.applicability_json || '{}').options || [];
    if (typeof value !== 'string' || !options.includes(value)) throw fail('值不属于字段枚举选项');
    return { value_type: 'json', json_value: JSON.stringify(value) };
  }
  if (type === 'organization_reference' || type === 'user_reference') {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw fail('引用编号无效');
    return { value_type: 'json', json_value: JSON.stringify(id), referencedId: id };
  }
  throw fail('不支持的字段类型');
}

async function getImportOptions() {
  const reportTypes = await all(db, `SELECT id, code, display_name AS displayName FROM report_types
    WHERE cadence='monthly' AND status='active' ORDER BY code`);
  const organizations = await all(db, `SELECT id, code, name FROM organizations WHERE status='active' ORDER BY code`);
  const fields = await all(db, `SELECT id, code, display_name AS displayName, semantic_type AS type, precision, applicability_json AS applicabilityJson
    FROM field_definitions WHERE status='approved' AND editable=1 ORDER BY code`);
  return { reportTypes, organizations, fields: fields.map(field => ({ ...field, applicability: JSON.parse(field.applicabilityJson || '{}') })) };
}

async function validateRows(connection, { reportTypeId, periodCode, rows }) {
  const reportType = await get(connection, "SELECT id, code, display_name FROM report_types WHERE id=? AND cadence='monthly' AND status='active'", [reportTypeId]);
  if (!reportType) throw fail('月报类型不存在或已停用', 404);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodCode)) throw fail('期间须采用 YYYY-MM 格式');
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000) throw fail('导入数据须为 1 至 10000 行');

  const fields = new Map((await all(connection, `SELECT id, code, semantic_type, precision, editable, applicability_json
    FROM field_definitions WHERE status='approved'`)).map(field => [field.code, field]));
  const organizations = new Map((await all(connection, `SELECT id, code, name FROM organizations WHERE status='active'`)).map(org => [org.code, org]));
  const tasks = await all(connection, `SELECT t.id, t.organization_id, t.task_status, t.current_revision_id, p.version,
      r.revision_status AS current_revision_status
    FROM report_tasks t JOIN period_packages p ON p.id=t.package_id LEFT JOIN business_revisions r ON r.id=t.current_revision_id
    WHERE t.report_type_id=? AND t.period_code=? AND p.status IN ('active','closed')
    ORDER BY p.version DESC, t.id DESC`, [reportTypeId, periodCode]);
  const taskByOrg = new Map();
  const tasksByOrg = new Map();
  for (const task of tasks) {
    if (!taskByOrg.has(Number(task.organization_id))) taskByOrg.set(Number(task.organization_id), task);
    if (!tasksByOrg.has(Number(task.organization_id))) tasksByOrg.set(Number(task.organization_id), []);
    tasksByOrg.get(Number(task.organization_id)).push(task);
  }
  const taskIds = tasks.map(task => Number(task.id));
  const existing = new Set();
  if (taskIds.length) {
    const currentValues = await all(connection, `SELECT t.organization_id, v.field_definition_id, v.record_key
      FROM business_values v JOIN report_tasks t ON t.id=v.task_id JOIN business_revisions r ON r.id=v.revision_id
      WHERE t.report_type_id=? AND t.period_code=?`, [reportTypeId, periodCode]);
    for (const item of currentValues) existing.add(`${item.organization_id}|${item.field_definition_id}|${item.record_key}`);
  }
  const finalizedOrganizations = new Set(tasks.filter(task => task.task_status === 'finalized'
    || task.current_revision_status === 'finalized').map(task => Number(task.organization_id)));
  const batchKeys = new Set();
  const resultRows = [];
  for (let index = 0; index < rows.length; index++) {
    const raw = rows[index] && typeof rows[index] === 'object' && !Array.isArray(rows[index]) ? rows[index] : {};
    const rowNumber = Number.isSafeInteger(Number(raw.rowNumber)) ? Number(raw.rowNumber) : index + 2;
    const orgCode = String(raw.organizationCode ?? '').trim();
    const fieldCode = String(raw.fieldCode ?? '').trim();
    const recordKey = raw.recordKey == null ? '' : String(raw.recordKey).trim();
    const errors = [];
    const warnings = [];
    const org = organizations.get(orgCode);
    const field = fields.get(fieldCode);
    if (!org) errors.push(`组织编码“${orgCode || '(空)'}”未匹配到有效组织`);
    if (!field) errors.push(`字段编码“${fieldCode || '(空)'}”不是已批准字段`);
    else if (!field.editable) errors.push('该字段为只读字段');
    if (recordKey.length > 200) errors.push('记录键不能超过 200 个字符');
    let typed = null;
    if (field && Object.hasOwn(raw, 'value')) {
      try {
        typed = readValue(field, raw.value);
        if (typed.referencedId) {
          const table = field.semantic_type === 'organization_reference' ? 'organizations' : 'users';
          if (!await get(connection, `SELECT id FROM ${table} WHERE id=?`, [typed.referencedId])) errors.push('引用的组织或用户不存在');
          delete typed.referencedId;
        }
      } catch (error) { errors.push(error.message); }
    } else errors.push('值不能为空');
    if (org && finalizedOrganizations.has(Number(org.id))) errors.push('对应月报已定稿，不能覆盖；请进入月报调整流程发起更正');
    const task = org ? taskByOrg.get(Number(org.id)) : null;
    if (org && !task) errors.push('该组织在所选报告类型和期间没有已激活的月报任务');
    if (task && task.task_status !== 'draft' && task.task_status !== 'finalized') errors.push(`当前任务状态为 ${task.task_status}，不能导入`);

    const key = org && field ? `${org.id}|${field.id}|${recordKey}` : null;
    let rowStatus = errors.length ? 'blocking_error' : 'new';
    if (!errors.length && key && (existing.has(key) || batchKeys.has(key))) {
      rowStatus = 'duplicate';
      warnings.push(existing.has(key) ? '数据库中已存在相同组织、字段和记录键，确认时将跳过' : '本文件中有重复的组织、字段和记录键，确认时保留首条并跳过后续行');
    }
    if (key && !batchKeys.has(key) && rowStatus !== 'blocking_error') batchKeys.add(key);
    resultRows.push({ rowNumber, organizationId: org?.id ?? null, organizationCode: orgCode,
      organizationName: org?.name ?? null, fieldDefinitionId: field?.id ?? null, fieldCode,
      displayName: field?.display_name ?? null, recordKey, value: raw.value ?? null,
      typed, taskId: task?.id ?? null, status: rowStatus, errors, warnings });
  }
  return { reportType, rows: resultRows, summary: {
    total: resultRows.length,
    blockingErrors: resultRows.filter(row => row.status === 'blocking_error').length,
    warnings: resultRows.reduce((count, row) => count + row.warnings.length, 0),
    newRecords: resultRows.filter(row => row.status === 'new').length,
    duplicates: resultRows.filter(row => row.status === 'duplicate').length
  }};
}

async function preview({ actor, reportTypeId, periodCode, sourceName, fileBuffer, rows }) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length < 4 || fileBuffer.length > 20 * 1024 * 1024
    || fileBuffer[0] !== 0x50 || fileBuffer[1] !== 0x4b) throw fail('请上传有效的 XLSX 文件（最大 20 MB）');
  const cleanName = path.basename(String(sourceName || 'historical-import.xlsx')).slice(0, 255);
  if (!/\.xlsx$/i.test(cleanName)) throw fail('仅支持 XLSX 文件');
  const sourceSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const connection = await begin();
  let artifactPath = null;
  try {
    const validated = await validateRows(connection, { reportTypeId: Number(reportTypeId), periodCode: String(periodCode || ''), rows });
    const batch = await run(connection, `INSERT INTO historical_import_batches
      (report_type_id, period_code, status, source_name, source_sha256, requested_by, result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [Number(reportTypeId), String(periodCode), validated.summary.blockingErrors ? 'rejected' : 'validated',
      cleanName, sourceSha256, actor.id, JSON.stringify(validated.summary)]);
    for (const row of validated.rows) {
      await run(connection, `INSERT INTO historical_import_rows (batch_id, row_number, organization_id, row_status, values_json, errors_json)
        VALUES (?, ?, ?, ?, ?, ?)`, [batch.lastID, row.rowNumber, row.organizationId, row.status,
        JSON.stringify({ organizationCode: row.organizationCode, fieldCode: row.fieldCode, recordKey: row.recordKey, value: row.value,
          fieldDefinitionId: row.fieldDefinitionId, taskId: row.taskId, typed: row.typed }), JSON.stringify([...row.errors, ...row.warnings])]);
    }
    const directory = path.join(storage.getArtifactDirectory(), 'historical-imports');
    await fs.mkdir(directory, { recursive: true });
    artifactPath = path.join(directory, `${batch.lastID}-${sourceSha256}.xlsx`);
    await fs.writeFile(artifactPath, fileBuffer, { flag: 'wx' }).catch(async error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await recordBusinessAudit({ connection, actor, action: 'historical_import.preview', objectType: 'historical_import_batch',
      objectId: batch.lastID, after: { reportTypeId: Number(reportTypeId), periodCode, sourceName: cleanName,
        sourceSha256, summary: validated.summary }, outcome: 'success' });
    await run(connection, 'COMMIT');
    return { batchId: Number(batch.lastID), status: validated.summary.blockingErrors ? 'rejected' : 'validated',
      sourceName: cleanName, sourceSha256, ...validated };
  } catch (error) {
    await run(connection, 'ROLLBACK').catch(() => {});
    if (artifactPath) await fs.rm(artifactPath, { force: true }).catch(() => {});
    throw error;
  } finally { await new Promise(resolve => connection.close(() => resolve())); }
}

async function confirm({ actor, batchId }) {
  if (!Number.isSafeInteger(Number(batchId)) || Number(batchId) <= 0) throw fail('导入批次编号无效');
  const connection = await begin();
  try {
    const batch = await get(connection, 'SELECT * FROM historical_import_batches WHERE id=?', [Number(batchId)]);
    if (!batch) throw fail('导入批次不存在', 404);
    if (Number(batch.requested_by) !== Number(actor.id) && !actor.roles?.some(role => role.code === 'system_admin')) throw fail('只有发起人或系统管理员可以确认此批次', 403);
    if (batch.status !== 'validated') throw fail(batch.status === 'rejected' ? '批次存在阻断错误，请修正文件后重新预览' : '批次已确认或状态无效', 409);
    const items = await all(connection, `SELECT row_number AS rowNumber, values_json AS valuesJson, row_status AS status
      FROM historical_import_rows WHERE batch_id=? ORDER BY row_number`, [batch.id]);
    const rows = items.map(item => ({ rowNumber: item.rowNumber, ...JSON.parse(item.valuesJson) }));
    const current = await validateRows(connection, { reportTypeId: Number(batch.report_type_id), periodCode: batch.period_code, rows });
    if (current.summary.blockingErrors) {
      await run(connection, `UPDATE historical_import_batches SET status='rejected', result_json=? WHERE id=?`,
        [JSON.stringify(current.summary), batch.id]);
      await run(connection, 'COMMIT');
      throw fail('预览后数据状态已变化或存在阻断错误；没有写入任何值，请重新预览', 409);
    }
    const revisions = new Map();
    let inserted = 0;
    for (const row of current.rows.filter(item => item.status === 'new')) {
      let revisionId = revisions.get(Number(row.taskId));
      if (!revisionId) {
        const task = await get(connection, 'SELECT task_status, current_revision_id FROM report_tasks WHERE id=?', [row.taskId]);
        if (!task || task.task_status !== 'draft') throw fail('确认时任务已不再是草稿；没有写入任何值', 409);
        revisionId = task.current_revision_id;
        if (revisionId) {
          const revision = await get(connection, "SELECT id FROM business_revisions WHERE id=? AND task_id=? AND revision_status='draft'", [revisionId, row.taskId]);
          if (!revision) throw fail('当前修订已锁定；没有写入任何值', 409);
        } else {
          const next = await get(connection, 'SELECT COALESCE(MAX(revision_number),0)+1 AS revision FROM business_revisions WHERE task_id=?', [row.taskId]);
          const created = await run(connection, `INSERT INTO business_revisions (task_id, revision_number, revision_status, submitted_by)
            VALUES (?, ?, 'draft', ?)`, [row.taskId, next.revision, actor.id]);
          revisionId = Number(created.lastID);
          await run(connection, 'UPDATE report_tasks SET current_revision_id=? WHERE id=? AND task_status=\'draft\'', [revisionId, row.taskId]);
        }
        revisions.set(Number(row.taskId), Number(revisionId));
      }
      const value = row.typed;
      await run(connection, `INSERT INTO business_values (revision_id, task_id, record_key, field_definition_id, value_type,
        text_value, decimal_value, integer_value, boolean_value, date_value, json_value, entered_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [revisionId, row.taskId, row.recordKey, row.fieldDefinitionId, value.value_type,
        value.text_value ?? null, value.decimal_value ?? null, value.integer_value ?? null, value.boolean_value ?? null,
        value.date_value ?? null, value.json_value ?? null, actor.id]);
      await run(connection, `UPDATE historical_import_rows SET row_status='imported', values_json=? WHERE batch_id=? AND row_number=?`,
        [JSON.stringify({ ...row, importedRevisionId: Number(revisionId) }), batch.id, row.rowNumber]);
      inserted++;
    }
    await run(connection, `UPDATE historical_import_batches SET status='imported', imported_at=CURRENT_TIMESTAMP,
      result_json=? WHERE id=?`, [JSON.stringify({ ...current.summary, imported: inserted,
        importedRevisionIds: [...revisions.values()] }), batch.id]);
    await recordBusinessAudit({ connection, actor, action: 'historical_import.apply', objectType: 'historical_import_batch',
      objectId: batch.id, after: { ...current.summary, imported: inserted, revisionIds: [...revisions.values()] }, outcome: 'success' });
    await run(connection, 'COMMIT');
    return { batchId: Number(batch.id), status: 'imported', imported: inserted, duplicates: current.summary.duplicates,
      revisionIds: [...revisions.values()] };
  } catch (error) {
    await run(connection, 'ROLLBACK').catch(() => {});
    throw error;
  } finally { await new Promise(resolve => connection.close(() => resolve())); }
}

module.exports = { getImportOptions, preview, confirm, readValue, validateRows };
