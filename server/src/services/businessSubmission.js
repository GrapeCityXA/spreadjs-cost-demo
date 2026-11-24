const { calculateManagedSnapshot, collectFunctionRefs } = require('./managedFunctions');
const { normalizeValidationSnapshot } = require('./validationSnapshot');
const { readBoundValue, materializeBoundSnapshot } = require('./bindingSource');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();
const db = require('../config/database');
const storage = require('../config/storage');
const { getRuntime, isUserConnected } = require('./collaborationServer');
const { buildMonthlyFillingSummary } = require('./monthlyFillingSummary');
const { recordBusinessAudit } = require('./businessAudit');
const monthlyAdjustments = require('./monthlyAdjustments');
const { hasTaskAssignment } = require('./taskAssignments');
const { createSnapshotReader } = require('./nativeUserFormula');

const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const run = (connection, sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } };

function sheetList(data) {
  const source = data?.sheets || data?.data?.sheets;
  return Array.isArray(source) ? source : source && typeof source === 'object'
    ? Object.values(source).sort((left, right) => Number(left.order || 0) - Number(right.order || 0)) : [];
}

function snapshotCell(sheet, row, col) {
  return sheet?.data?.dataTable?.[row]?.[col] || sheet?.dataTable?.[row]?.[col] || {};
}

// SpreadJS 会把日期存成 Date、Excel 序列号或本地化文本；提交时统一成 ISO 字符串。
function normalizeDateValue(value, datetime = false) {
  const format = date => {
    if (Number.isNaN(date.getTime())) return null;
    return datetime ? date.toISOString() : date.toISOString().slice(0, 10);
  };
  if (value instanceof Date) return format(value);
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel 1900 日期系统：序列号 25569 对应 1970-01-01。
    if (value < 1 || value > 2958465) return null;
    return format(new Date(Math.round((value - 25569) * 86400000)));
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  // SpreadJS 把日期序列化成 OADate 标记，例如 /OADate(46327)/。
  const oaDate = text.match(/^\/OADate\((-?\d+(?:\.\d+)?)\)\/$/);
  if (oaDate) {
    const serial = Number(oaDate[1]);
    if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
    return format(new Date(Math.round((serial - 25569) * 86400000)));
  }
  if (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) {
    if (Number.isNaN(Date.parse(text))) return null;
    return datetime ? text : text.slice(0, 10);
  }
  const match = text.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/)
    || text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

function typedValue(value, field, { calculated = false } = {}) {  if (value == null || value === '') return null;
  const semantic = String(field.semantic_type || field.data_type || '').toLowerCase();
  if (['decimal', 'number'].includes(semantic) || field.data_type === 'decimal') {
    const precision = Number(field.precision || 0);
    const text = typeof value === 'number' ? String(value) : String(value).trim();
    const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
    if (decimal.test(text) && (text.split('.')[1] || '').length <= precision) {
      return { type: 'decimal', value: text === '-0' ? '0' : text };
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error(`字段 ${field.code} 必须是十进制数`);
    const rounded = numeric === 0 ? (0).toFixed(precision) : numeric.toFixed(precision);
    if (/e/i.test(rounded)) throw new Error(`字段 ${field.code} 数值超出可存储范围`);
    // Formula output is rounded to the field precision. User-entered values still
    // have to fit, except for binary floating-point noise around a rounded value.
    if (!calculated && Math.abs(numeric - Number(rounded)) > Number.EPSILON * Math.max(1, Math.abs(numeric)) * 8) {
      throw new Error(`字段 ${field.code} ${decimal.test(text) ? `最多允许 ${field.precision} 位小数` : '必须是十进制数'}`);
    }
    return { type: 'decimal', value: rounded === '-0' ? '0' : rounded };
  }
  if (['integer'].includes(semantic)) {
    const number = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isSafeInteger(number)) throw new Error(`字段 ${field.code} 必须是安全整数`);
    return { type: 'integer', value: number };
  }
  if (['boolean'].includes(semantic)) {
    if (value === true || value === false) return { type: 'boolean', value };
    if (value === 1 || value === 0) return { type: 'boolean', value: Boolean(value) };
    throw new Error(`字段 ${field.code} 必须是布尔值`);
  }
  if (['date', 'datetime'].includes(semantic)) {
    const normalized = normalizeDateValue(value, semantic === 'datetime');
    if (!normalized) throw new Error(`字段 ${field.code} 必须是有效日期（格式 YYYY-MM-DD）`);
    return { type: 'date', value: normalized };
  }
  if (['enum', 'organization_reference', 'user_reference', 'json'].includes(semantic) || field.data_type === 'json') {
    return { type: 'json', value: JSON.stringify(value) };
  }
  return { type: 'text', value: String(value) };
}

const SAFE_USER_FUNCTIONS = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'IF', 'IFERROR', 'AND', 'OR', 'NOT', 'ABS', 'ROUND', 'PRODUCT']);
const FORBIDDEN_USER_FUNCTIONS = new Set(['NOW', 'TODAY', 'RAND', 'RANDBETWEEN', 'OFFSET', 'INDIRECT', 'WEBSERVICE', 'FILTERXML', 'RTD', 'WEBSERVICE', 'IMAGE', 'STOCKHISTORY', 'SEQUENCE', 'FILTER', 'SORT', 'UNIQUE', 'LAMBDA', 'LET']);

function validateUserFormula(formula, { sheetIndex, row, col, allowedCells, allowedNames, sheetIndices, formulaCells, customFunctions = new Set() }) {
  const source = String(formula || '').trim().replace(/^=/, '');
  if (!source || source.length > 8192 || /\[[^\]]+\]|https?:\/\/|\\\\/i.test(source)) throw new Error('用户公式包含外部引用或格式无效');
  const functionCalls = [...source.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)].map(match => match[1].toUpperCase());
  for (const name of functionCalls) {
    if (FORBIDDEN_USER_FUNCTIONS.has(name) || (!SAFE_USER_FUNCTIONS.has(name) && !customFunctions.has(name))) throw new Error(`用户公式函数 ${name} 未获授权`);
  }
  const references = [];
  const referencePattern = /(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_ ]*))?!?\s*\$?([A-Z]{1,3})\$?(\d+)/g;
  const rangeEndPattern = /^\s*:\s*(?:(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_ ]*))!)?\s*\$?([A-Z]{1,3})\$?(\d+)/;
  const columnIndex = name => [...name].reduce((index, char) => index * 26 + char.charCodeAt(0) - 64, 0) - 1;
  let match;
  while ((match = referencePattern.exec(source))) {
    const refSheet = match[1] || match[2];
    const targetSheetIndex = refSheet ? sheetIndices.get(refSheet.trim().toLowerCase()) : sheetIndex;
    if (targetSheetIndex == null) throw new Error('用户公式引用了未知工作表');
    const startRow = Number(match[4]) - 1;
    const startCol = columnIndex(match[3]);
    const rangeEnd = rangeEndPattern.exec(source.slice(referencePattern.lastIndex));
    let endSheetIndex = targetSheetIndex;
    let endRow = startRow;
    let endCol = startCol;
    if (rangeEnd) {
      const endSheet = rangeEnd[1] || rangeEnd[2];
      if (endSheet) {
        endSheetIndex = sheetIndices.get(endSheet.trim().toLowerCase());
        if (endSheetIndex == null) throw new Error('用户公式引用了未知工作表');
      }
      endRow = Number(rangeEnd[4]) - 1;
      endCol = columnIndex(rangeEnd[3]);
      referencePattern.lastIndex += rangeEnd[0].length;
    }
    const firstRow = Math.min(startRow, endRow);
    const lastRow = Math.max(startRow, endRow);
    const firstCol = Math.min(startCol, endCol);
    const lastCol = Math.max(startCol, endCol);
    if ((lastRow - firstRow + 1) * (lastCol - firstCol + 1) > 100000) throw new Error('用户公式引用范围过大');
    for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex += 1) {
      for (let column = firstCol; column <= lastCol; column += 1) {
        const cellKey = `${targetSheetIndex}:${rowIndex}:${column}`;
        if (endSheetIndex !== targetSheetIndex || !allowedCells.has(cellKey)) throw new Error('用户公式引用了未授权的数据区域');
        references.push(cellKey);
      }
    }
  }
  let residue = source.replace(/"(?:[^"]|"")*"/g, ' ')
    .replace(/(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_ ]*))?!?\s*\$?[A-Z]{1,3}\$?\d+/g, ' ')
    .replace(/[A-Za-z_][A-Za-z0-9_.]*/g, name => allowedNames.has(name.toUpperCase()) ? ' ' : name)
    .replace(/\b[A-Za-z_][A-Za-z0-9_.]*\b/g, name => SAFE_USER_FUNCTIONS.has(name.toUpperCase()) || customFunctions.has(name.toUpperCase()) ? ' ' : name);
  if (/[A-Za-z_]/.test(residue) || /[^\d\s+\-*/^&%=,:;().<>]/.test(residue)) throw new Error('用户公式含未获授权的名称或语法');
  if (references.includes(`${sheetIndex}:${row}:${col}`)) throw new Error('用户公式包含循环引用');
  return { source, references, cellKey: `${sheetIndex}:${row}:${col}` };
}

function extractionMappings(manifest, workbook) {
  if (manifest?.submission?.version !== 1 || !Array.isArray(manifest.submission.sheets)) throw new Error('已发布模板缺少受支持的提交 Mapping Manifest');
  const mappings = [];
  manifest.submission.sheets.forEach((sheet, sheetIndex) => {
    // Old published manifests lack sheet type flags; consult the published workbook too.
    // Keep the original index: removing auxiliary sheets would shift business sheet addresses.
    const definition = workbook?.sheets?.[sheetIndex];
    if (sheet.type === 'auxiliary' || sheet.readOnly || definition?.type === 'auxiliary' || definition?.readOnly) return;
    for (const mapping of sheet.mappings || []) mappings.push({ ...mapping, sheetIndex, sheetCode: sheet.code, sheetName: sheet.name });
  });
  return mappings;
}

function hasNamedAreaKind(mapping, kind) {
  return mapping.kind === kind && new RegExp(`_${kind.toUpperCase()}_`).test(String(mapping.namedArea || ''));
}

function extractBusinessValues({ manifest, workbook, snapshot, fields, actorId, collaborationVersion, configuration = null, calculatedValues = {} }) {
  const snapshotData = snapshot?.data || snapshot;
  const formulaReader = createSnapshotReader(snapshotData, calculatedValues);
  const customFunctions = new Set(collectFunctionRefs(workbook).map(ref => ref.name));
  const sheets = sheetList(snapshot);
  const mappings = extractionMappings(manifest, workbook);
  const output = [];
  const sheetIndices = new Map();
  for (const sheet of manifest.submission.sheets) for (const name of [sheet.name, sheet.code])
    if (name) sheetIndices.set(String(name).toLowerCase(), Number(sheet.order));
  const allowedNames = new Set(mappings.filter(mapping => ['input', 'table'].includes(mapping.kind))
    .map(mapping => String(mapping.namedArea || '').toUpperCase()));
  const allowedCells = new Set();
  const formulaCells = new Map();
  for (const mapping of mappings) {
    if (!mapping.bindingPath && !hasNamedAreaKind(mapping, mapping.kind)) continue;
    if (mapping.kind === 'input' && (!mapping.primary || mapping.permission !== 'primary_input')) continue;
    const columns = mapping.kind === 'table' ? (mapping.datasetColumns || []) : [{ fieldDefinitionId: mapping.fieldDefinitionId, fieldCode: mapping.fieldCode }];
    const firstDataRow = mapping.kind === 'table' ? mapping.row + 1 : mapping.row;
    for (let row = firstDataRow; row < mapping.row + mapping.rowCount; row += 1) {
      for (let column = 0; column < columns.length; column += 1) {
        const col = mapping.col + column;
        const field = fields.get(Number(columns[column].fieldDefinitionId));
        if (field?.editable !== 0 && field?.editable !== false) allowedCells.add(`${mapping.sheetIndex}:${row}:${col}`);
      }
    }
  }
  for (const mapping of mappings) {
    if (mapping.kind !== 'input' && mapping.kind !== 'table') continue;
    if (!mapping.bindingPath && !hasNamedAreaKind(mapping, mapping.kind)) continue;
    if (mapping.kind === 'input' && (!mapping.primary || mapping.permission !== 'primary_input')) continue;
    const sheet = sheets[mapping.sheetIndex];
    if (!sheet || sheet.name !== String(mapping.sheetName || workbook?.sheets?.[mapping.sheetIndex]?.name || '').slice(0, 31)) {
      throw new Error(`工作表 ${mapping.sheetCode || mapping.sheetIndex} 与提交 Mapping Manifest 不一致`);
    }
    const columns = mapping.kind === 'table' ? (mapping.datasetColumns || []) : [{ fieldDefinitionId: mapping.fieldDefinitionId, fieldCode: mapping.fieldCode }];
    if (mapping.kind === 'table' && !columns.length) throw new Error(`表格命名区域 ${mapping.namedArea} 缺少列映射`);
    const firstDataRow = mapping.kind === 'table' ? mapping.row + 1 : mapping.row;
    const quarterlyRows = mapping.kind === 'table' && Array.isArray(configuration?.indicators)
      ? configuration.indicators.filter(indicator => indicator.namedArea === mapping.namedArea && indicator.recordKey)
      : [];
    for (let row = firstDataRow; row < mapping.row + mapping.rowCount; row += 1) {
      const rowValues = [];
      for (let column = 0; column < columns.length; column += 1) {
        const col = mapping.col + column;
        const cell = snapshotCell(sheet, row, col);
        const field = fields.get(Number(columns[column].fieldDefinitionId));
        if (!field || Number(columns[column].fieldDefinitionId) !== Number(field.id)) throw new Error(`命名区域 ${mapping.namedArea} 引用的字段不可用`);
        const nativeFormula = cell.formulaInfo?.parts
          ? formulaReader.read(Object.keys(snapshotData.sheets).find(id => snapshotData.sheets[id] === sheet), row, col) : null;
        const raw = nativeFormula ? nativeFormula.value : mapping.bindingPath ? readBoundValue(snapshotData, sheet, mapping.bindingPath) : Object.hasOwn(cell, 'value') ? cell.value : undefined;
        const formula = nativeFormula ? nativeFormula.formula : typeof cell.formulaInfo?.formula === 'string' ? cell.formulaInfo.formula : null;
        if (formula) {
          const key = `${mapping.sheetIndex}:${row}:${col}`;
          formulaCells.set(key, { dependencies: new Set(), formula });
        }
        const value = raw ?? cell.text;
        if (value == null || value === '') { rowValues.push(null); continue; }
        if (typeof value === 'string' && /^#[A-Z0-9/?]+[!?]?$/.test(value)) throw new Error(`命名区域 ${mapping.namedArea} 含公式错误`);
        if (formula) {
          const checked = validateUserFormula(formula, { sheetIndex: mapping.sheetIndex, row, col, allowedCells, allowedNames, sheetIndices, formulaCells, customFunctions });
          formulaCells.set(checked.cellKey, checked);
          if (raw === undefined || raw === null) throw new Error(`命名区域 ${mapping.namedArea} 的用户公式缺少计算结果`);
        }
        const typed = typedValue(value, field, { calculated: Boolean(formula) });
        const configuredRecordKey = quarterlyRows[row - firstDataRow]?.recordKey;
        rowValues.push({ recordKey: mapping.kind === 'table' ? configuredRecordKey || `${mapping.namedArea}:row:${row + 1}` : '',
          fieldDefinitionId: Number(field.id), typedValue: typed, sourceFormula: formula,
          unitSnapshot: field.unit || null, precisionSnapshot: Number(field.precision || 0), sourceSheet: mapping.sheetCode,
          sourceNamedArea: mapping.namedArea, sourceRow: row, sourceColumn: col,
          sourceCollaborationVersion: Number(collaborationVersion), enteredBy: Number(actorId) });
      }
      if ((mapping.kind === 'table' || mapping.kind === 'input' && !mapping.required) && rowValues.every(item => item == null)) continue;
      if (rowValues.some(item => item == null)) throw new Error(`表格命名区域 ${mapping.namedArea} 第 ${row + 1} 行必须完整填写`);
      rowValues.filter(Boolean).forEach(item => item.mappingId = mapping.id || null);
      if (mapping.kind === 'input') rowValues.filter(Boolean).forEach(item => { item.required = Boolean(mapping.required); });
      // Retain the values until the whole row has passed type and formula validation.
      for (const item of rowValues.filter(Boolean)) output.push(item);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visitFormula = key => {
    if (visiting.has(key)) throw new Error('用户公式之间存在循环引用');
    if (visited.has(key)) return;
    visiting.add(key);
    const formula = formulaCells.get(key);
    for (const reference of formula?.references || []) if (formulaCells.has(reference)) visitFormula(reference);
    visiting.delete(key); visited.add(key);
  };
  for (const key of formulaCells.keys()) visitFormula(key);
  return output;
}

function cleanWorkbookSnapshot(snapshot, calculatedValues = {}) {
  return materializeBoundSnapshot(snapshot, calculatedValues);
}

function typedColumns(value) {
  return {
    text: { text_value: value.value }, decimal: { decimal_value: value.value }, integer: { integer_value: value.value },
    boolean: { boolean_value: value.value ? 1 : 0 }, date: { date_value: value.value }, json: { json_value: value.value }
  }[value.type];
}

function insertValue(connection, revisionId, taskId, item) {
  const typed = typedColumns(item.typedValue);
  return run(connection, `INSERT INTO business_values
    (revision_id, task_id, record_key, field_definition_id, value_type, text_value, decimal_value, integer_value,
      boolean_value, date_value, json_value, source_formula, entered_by, unit_snapshot, precision_snapshot,
      source_sheet, source_named_area, source_row, source_column, source_collaboration_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [revisionId, taskId, item.recordKey, item.fieldDefinitionId, item.typedValue.type,
    typed.text_value ?? null, typed.decimal_value ?? null, typed.integer_value ?? null, typed.boolean_value ?? null,
    typed.date_value ?? null, typed.json_value ?? null, item.sourceFormula, item.enteredBy, item.unitSnapshot,
    item.precisionSnapshot, item.sourceSheet, item.sourceNamedArea, item.sourceRow, item.sourceColumn, item.sourceCollaborationVersion]);
}

function responseForRevision(row) {
  return { taskId: Number(row.task_id), revisionId: Number(row.id), revisionNumber: Number(row.revision_number),
    status: 'submitted', submitterId: Number(row.submitted_by), collaborationVersion: Number(row.collaboration_version),
    workbookArtifactId: Number(row.workbook_artifact_id) };
}

function normalizeWarningExplanations(input) {
  const entries = Array.isArray(input) ? input : input && typeof input === 'object'
    ? Object.entries(input).map(([warningKey, explanation]) => ({ warningKey, explanation })) : [];
  if (entries.length > 500) throw Object.assign(new Error('异常说明数量超出限制'), { status: 400 });
  return entries.map(item => ({
    warningKey: item?.warningKey == null ? null : String(item.warningKey).slice(0, 500),
    ruleVersionId: Number.isSafeInteger(Number(item?.ruleVersionId)) && Number(item.ruleVersionId) > 0 ? Number(item.ruleVersionId) : null,
    ruleCode: item?.ruleCode == null ? null : String(item.ruleCode).slice(0, 100),
    explanation: String(item?.explanation || '').trim().slice(0, 2000)
  }));
}

function explanationForWarning(warning, explanations) {
  const match = explanations.find(item => item.warningKey && item.warningKey === warning.warningKey)
    || (warning.ruleVersionId ? explanations.find(item => item.ruleVersionId === Number(warning.ruleVersionId)) : null)
    || explanations.find(item => item.ruleCode && item.ruleCode === warning.ruleCode);
  return match?.explanation || '';
}

async function submitBusinessRevisionInTransaction({ connection, taskId, actor, expectedVersion, pendingChanges, idempotencyKey, hooks = {},
  warningExplanations: rawWarningExplanations, validationReport, connectionProbe = isUserConnected, runtimeProvider = getRuntime }) {
  if (!Number.isSafeInteger(Number(taskId)) || Number(taskId) <= 0) throw Object.assign(new Error('任务编号无效'), { status: 400 });
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw Object.assign(new Error('请提交当前协作版本号'), { status: 400 });
  if (pendingChanges !== 0) throw Object.assign(new Error('请先等待全部协作变更确认后再提交'), { status: 409 });
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw Object.assign(new Error('缺少有效的提交幂等键'), { status: 400 });
  }
  const warningExplanations = normalizeWarningExplanations(rawWarningExplanations);
  const validationSnapshot = normalizeValidationSnapshot(validationReport, expectedVersion);
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ taskId: Number(taskId), expectedVersion, pendingChanges,
    warningExplanations, ...(validationSnapshot ? { validationSnapshot } : {}) })).digest('hex');
  const operation = `business_revision.submit:${Number(taskId)}`;
  let outcome = null;
  let transactionStarted = false;
  let committed = false;
  let frozenRoom = null;
  let artifactPaths = [];
  await run(connection, 'PRAGMA foreign_keys = ON');
  await run(connection, 'PRAGMA busy_timeout = 10000');
  await run(connection, 'ATTACH DATABASE ? AS submission_collab', [storage.getCollaborationDatabasePath()]);
  await run(connection, 'BEGIN IMMEDIATE');
  transactionStarted = true;
  try {
    const previous = await get(connection, `SELECT request_hash, response_json FROM idempotency_keys
      WHERE actor_user_id = ? AND operation = ? AND idempotency_key = ?`, [actor.id, operation, idempotencyKey]);
    if (previous) {
      if (previous.request_hash !== requestHash) throw Object.assign(new Error('此幂等键已用于不同的提交请求'), { status: 409 });
      if (!previous.response_json) throw Object.assign(new Error('相同的提交请求仍在处理中'), { status: 409 });
      outcome = JSON.parse(previous.response_json);
      await run(connection, 'COMMIT');
      committed = true;
      return outcome;
    }
    const task = await get(connection, `SELECT t.*, rt.cadence, cr.id AS room_id, cr.collaboration_room_key, cr.room_status,
        cr.latest_version, cr.snapshot_reference, p.template_version_id, tv.manifest_json, tv.workbook_json
      FROM report_tasks t JOIN collaboration_rooms cr ON cr.task_id = t.id
        AND cr.revision_number = (SELECT MAX(r.revision_number) FROM collaboration_rooms r WHERE r.task_id = t.id)
      JOIN report_types rt ON rt.id = t.report_type_id
      JOIN period_packages p ON p.id = t.package_id JOIN template_versions tv ON tv.id = t.template_version_id
      WHERE t.id = ?`, [Number(taskId)]);
    if (!task) throw Object.assign(new Error('填报任务不存在'), { status: 404 });
    if (task.task_status !== 'draft' || task.room_status !== 'open') throw Object.assign(new Error('当前任务不处于可提交状态'), { status: 409 });
    if (task.cadence === 'quarterly') {
      const pendingImpact = await get(connection, `SELECT COUNT(*) AS count FROM monthly_adjustment_impacts
        WHERE quarterly_task_id = ? AND status = 'pending_confirmation'`, [task.id]);
      if (Number(pendingImpact?.count || 0)) throw Object.assign(new Error('请先核对月报调整后的季度差异，再提交季度数据'), { status: 409 });
    }
    const assignment = await hasTaskAssignment(connection, task, actor.id, 'submitter');
    const role = (actor.roles || []).some(item => item.code === 'subsidiary_submitter'
      && (item.organizationId == null || Number(item.organizationId) === Number(task.organization_id)));
    if (!assignment || !role) throw Object.assign(new Error('当前用户没有此任务的提交责任'), { status: 403 });
    if (!connectionProbe(task.collaboration_room_key, actor.id)) throw Object.assign(new Error('请保持当前任务协作连接后再提交'), { status: 409 });
    const runtime = await runtimeProvider();
    const doc = await get(connection, 'SELECT version FROM submission_collab.documents WHERE id = ?', [task.collaboration_room_key]);
    const currentVersion = Number(doc?.version ?? 0);
    if (Number(task.latest_version) !== currentVersion || currentVersion !== expectedVersion) {
      throw Object.assign(new Error('协作工作簿已有新变更，请刷新后重试'), { status: 409 });
    }
    const frozeRoom = await run(connection, `UPDATE collaboration_rooms SET room_status = 'frozen', frozen_at = CURRENT_TIMESTAMP
      WHERE id = ? AND room_status = 'open' AND latest_version = ?`, [task.room_id, currentVersion]);
    const frozeCollab = await run(connection, `UPDATE submission_collab.collaboration_rooms SET room_status = 'frozen', current_version = ?
      WHERE room_key = ? AND room_status = 'open' AND current_version = ?`, [currentVersion, task.collaboration_room_key, currentVersion]);
    if (frozeRoom.changes !== 1 || frozeCollab.changes !== 1) throw Object.assign(new Error('协作房间状态已变化，请刷新后重试'), { status: 409 });
    frozenRoom = { roomId: task.room_id, roomKey: task.collaboration_room_key };
    await run(connection, 'COMMIT');
    transactionStarted = false;
    await run(connection, 'BEGIN IMMEDIATE');
    transactionStarted = true;
    const idempotencyInsert = await run(connection, `INSERT INTO idempotency_keys (actor_user_id, operation, idempotency_key, request_hash)
      VALUES (?, ?, ?, ?)`, [actor.id, operation, idempotencyKey, requestHash]);
    const snapshot = await runtime.documentServices.fetch(task.collaboration_room_key);
    if (!snapshot || Number(snapshot.v ?? snapshot.version ?? currentVersion) !== currentVersion) {
      throw Object.assign(new Error('当前协作快照与服务器版本不一致'), { status: 409 });
    }
    const snapshotData = snapshot.data || snapshot;
    if (!snapshotData?.sheets || !Object.keys(snapshotData.sheets).length) {
      throw Object.assign(new Error('当前协作工作簿尚未初始化，请刷新填报页面后重试'), { status: 409 });
    }
    const workbook = parse(task.workbook_json, {});
    const publishedManifest = parse(task.manifest_json, {});
    if (publishedManifest.submission?.version !== 1) throw Object.assign(new Error('发布模板缺少提交 Mapping Manifest，请重新发布模板版本'), { status: 409 });
    const summary = await buildMonthlyFillingSummary({ task: { id: task.id, reportTypeId: task.report_type_id,
      periodCode: task.period_code, configuration: parse(task.configuration_snapshot_json, {}) },
    organization: { id: task.organization_id }, workbook, manifest: publishedManifest, snapshot, roomVersion: currentVersion });
    // The browser decides business-rule blocking and required warning explanations.
    // Keep trusted calculations and warning evidence, but do not repeat the submission gate here.
    const warnings = summary.precheck?.warnings || [];
    const mappingEntries = extractionMappings(publishedManifest, workbook);
    const fieldIds = [...new Set(mappingEntries.flatMap(mapping => [mapping.fieldDefinitionId, ...(mapping.datasetColumns || []).map(column => column.fieldDefinitionId)]).map(Number).filter(Number.isSafeInteger))];
    const fieldsRows = fieldIds.length ? await all(connection, `SELECT id, code, data_type, semantic_type, unit, precision, editable FROM field_definitions
      WHERE id IN (${fieldIds.map(() => '?').join(',')}) AND status = 'approved'`, fieldIds) : [];
    const fields = new Map(fieldsRows.map(field => [Number(field.id), field]));
    const taskConfiguration = parse(task.configuration_snapshot_json, {});
    const values = extractBusinessValues({ manifest: publishedManifest, workbook, snapshot, fields, actorId: actor.id,
      collaborationVersion: currentVersion, configuration: taskConfiguration, calculatedValues: await calculateManagedSnapshot(workbook, snapshot) });
    const persistedCalculations = new Set();
    for (const mapping of mappingEntries.filter(item => item.kind === 'calc' && /_CALC_/.test(item.namedArea || ''))) {
      if (!mapping.formulaVersionId || !Object.hasOwn(summary.authoritativeValues || {}, mapping.fieldCode)) {
        throw Object.assign(new Error(`系统计算命名区域 ${mapping.namedArea} 缺少后端权威公式`), { status: 422 });
      }
      const field = fields.get(Number(mapping.fieldDefinitionId));
      if (!field) throw Object.assign(new Error(`系统计算命名区域 ${mapping.namedArea} 引用的字段不可用`), { status: 422 });
      if (persistedCalculations.has(Number(field.id))) continue;
      persistedCalculations.add(Number(field.id));
      const calculated = summary.authoritativeValues[mapping.fieldCode];
      const typed = typedValue(calculated, field, { calculated: true });
      if (!typed) continue;
      values.push({ recordKey: '', fieldDefinitionId: Number(field.id), typedValue: typed, sourceFormula: null,
        unitSnapshot: field.unit || null, precisionSnapshot: Number(field.precision || 0), sourceSheet: mapping.sheetCode,
        sourceNamedArea: mapping.namedArea, sourceRow: mapping.row, sourceColumn: mapping.col,
        sourceCollaborationVersion: currentVersion, enteredBy: null });
    }
    const draft = task.current_revision_id == null ? null : await get(connection,
      'SELECT * FROM business_revisions WHERE id = ? AND task_id = ?', [task.current_revision_id, task.id]);
    if (draft && (draft.revision_status !== 'draft' || Number(draft.collaboration_room_id) !== Number(task.room_id))) {
      throw Object.assign(new Error('当前草稿修订与协作房间不匹配'), { status: 409 });
    }
    const isResubmission = Boolean(draft?.source_revision_id);
    let revision;
    let revisionNumber;
    if (draft) {
      revision = { lastID: Number(draft.id) };
      revisionNumber = Number(draft.revision_number);
      await run(connection, `UPDATE business_revisions SET revision_status = 'submitted', submitted_by = ?,
        submitted_at = CURRENT_TIMESTAMP, collaboration_version = ? WHERE id = ? AND revision_status = 'draft'`,
      [actor.id, currentVersion, draft.id]);
    } else {
      revisionNumber = Number((await get(connection, 'SELECT COALESCE(MAX(revision_number), 0) AS revision FROM business_revisions WHERE task_id = ?', [task.id])).revision) + 1;
      revision = await run(connection, `INSERT INTO business_revisions
        (task_id, revision_number, revision_status, submitted_by, submitted_at, collaboration_room_id, collaboration_version)
        VALUES (?, ?, 'submitted', ?, CURRENT_TIMESTAMP, ?, ?)`, [task.id, revisionNumber, actor.id, task.room_id, currentVersion]);
    }
    for (const value of values) await insertValue(connection, revision.lastID, task.id, value);
    if (validationSnapshot) await run(connection, `INSERT INTO revision_validation_snapshots
      (revision_id,actor_user_id,collaboration_version,report_json) VALUES (?,?,?,?)`,
    [revision.lastID, actor.id, currentVersion, JSON.stringify(validationSnapshot)]);
    const adjustment = ['monthly', 'quarterly'].includes(task.cadence)
      ? await monthlyAdjustments.markAdjustmentSubmitted(connection, task, revision.lastID) : null;
    const fieldsByCode = new Map(fieldsRows.map(field => [field.code, Number(field.id)]));
    for (const warning of warnings) {
      const fieldId = Number(warning.fieldDefinitionId) || fieldsByCode.get(warning.fieldCode) || null;
      await run(connection, `INSERT INTO anomaly_snapshots
        (revision_id, rule_version_id, field_definition_id, severity, message, explanation, record_key,
          triggering_value_json, comparison_value_json, threshold_json, color_classification, warning_key,
          rule_code, field_code, sheet_code, row_index, column_index)
        VALUES (?, ?, ?, 'warning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [revision.lastID, warning.ruleVersionId || null, fieldId, warning.message, explanationForWarning(warning, warningExplanations),
        warning.recordKey || '', JSON.stringify(warning.triggeringValue ?? null), JSON.stringify(warning.comparisonValue ?? null),
        JSON.stringify(warning.threshold ?? null), warning.colorClassification || 'warning', warning.warningKey,
        warning.ruleCode || warning.code, warning.fieldCode || null, warning.sheetCode || null,
        warning.row == null ? null : Number(warning.row), warning.column == null ? null : Number(warning.column)]);
    }
    if (hooks.afterValues) await hooks.afterValues({ revisionId: revision.lastID, values });
    const artifactDirectory = storage.getArtifactDirectory();
    await fs.mkdir(artifactDirectory, { recursive: true });
    const stem = `task-${task.id}-revision-${revisionNumber}-${crypto.randomUUID()}`;
    const workbookPath = path.join(artifactDirectory, `${stem}.ssjson`);
    const snapshotPath = path.join(artifactDirectory, `${stem}.collaboration.json`);
    const tempWorkbookPath = `${workbookPath}.tmp`;
    const tempSnapshotPath = `${snapshotPath}.tmp`;
    artifactPaths = [workbookPath, snapshotPath, tempWorkbookPath, tempSnapshotPath];
    const functionRefs = collectFunctionRefs(workbook);
    const calculated = functionRefs.length ? await calculateManagedSnapshot(workbook, snapshot) : {};
    const staticWorkbook = cleanWorkbookSnapshot(snapshot, calculated);
    if (functionRefs.length) {
      staticWorkbook.customFunctions = Object.fromEntries(functionRefs.map(ref => [ref.name, ref]));
      for (const [key, item] of Object.entries(calculated)) {
        const [sheetId, row, col] = key.split(':');
        const cell = staticWorkbook.sheets?.[sheetId]?.data?.dataTable?.[row]?.[col];
        if (cell) cell.value = item.value;
      }
    }
    await fs.writeFile(tempWorkbookPath, JSON.stringify(staticWorkbook), { flag: 'wx' });
    await fs.rename(tempWorkbookPath, workbookPath);
    await fs.writeFile(tempSnapshotPath, JSON.stringify({ roomKey: task.collaboration_room_key, version: currentVersion, snapshot }), { flag: 'wx' });
    await fs.rename(tempSnapshotPath, snapshotPath);
    if (hooks.afterArtifacts) await hooks.afterArtifacts({ workbookPath, snapshotPath });
    const workbookHash = crypto.createHash('sha256').update(await fs.readFile(workbookPath)).digest('hex');
    const snapshotHash = crypto.createHash('sha256').update(await fs.readFile(snapshotPath)).digest('hex');
    const workbookStat = await fs.stat(workbookPath); const snapshotStat = await fs.stat(snapshotPath);
    const workbookArtifact = await run(connection, `INSERT INTO official_artifacts (revision_id, artifact_type, storage_key, sha256, byte_size)
      VALUES (?, 'spreadjs_workbook_json', ?, ?, ?)`, [revision.lastID, workbookPath, workbookHash, workbookStat.size]);
    const snapshotArtifact = await run(connection, `INSERT INTO official_artifacts (revision_id, artifact_type, storage_key, sha256, byte_size)
      VALUES (?, 'collaboration_snapshot', ?, ?, ?)`, [revision.lastID, snapshotPath, snapshotHash, snapshotStat.size]);
    await run(connection, 'UPDATE business_revisions SET workbook_artifact_id = ? WHERE id = ?', [workbookArtifact.lastID, revision.lastID]);
    await run(connection, `UPDATE report_tasks SET current_revision_id = ?, task_status = 'submitted' WHERE id = ? AND task_status = 'draft'`, [revision.lastID, task.id]);
    if (hooks.beforeCommit) await hooks.beforeCommit({ revisionId: revision.lastID, workbookArtifactId: workbookArtifact.lastID,
      snapshotArtifactId: snapshotArtifact.lastID });
    const response = responseForRevision({ ...revision, id: revision.lastID, task_id: task.id, revision_number: revisionNumber,
      submitted_by: actor.id, collaboration_version: currentVersion, workbook_artifact_id: workbookArtifact.lastID });
    await run(connection, `UPDATE idempotency_keys SET response_json = ? WHERE id = ?`, [JSON.stringify(response), idempotencyInsert.lastID]);
    await run(connection, `UPDATE collaboration_rooms SET room_status = 'closed', closed_at = CURRENT_TIMESTAMP,
      snapshot_reference = ? WHERE id = ?`, [`${task.collaboration_room_key}@${currentVersion}`, task.room_id]);
    await run(connection, `UPDATE submission_collab.collaboration_rooms SET room_status = 'closed' WHERE room_key = ?`, [task.collaboration_room_key]);
    if (hooks.afterRoomClose) await hooks.afterRoomClose({ taskId: task.id, roomId: task.room_id });
    await run(connection, `INSERT INTO report_task_events
      (task_id, revision_id, event_type, actor_user_id, from_status, to_status)
      VALUES (?, ?, ?, ?, 'draft', 'submitted')`,
    [task.id, revision.lastID, isResubmission ? 'resubmitted' : 'submitted', actor.id]);
    await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
      action: isResubmission ? 'business_revision.resubmit' : 'business_revision.submit',
      objectType: 'business_revision', objectId: response.revisionId, businessVersion: String(response.revisionNumber),
      after: { taskId: response.taskId, collaborationVersion: response.collaborationVersion, submitterId: actor.id } });
    if (adjustment) {
      await run(connection, `INSERT INTO report_task_events
        (task_id, revision_id, event_type, actor_user_id, reason, from_status, to_status)
        VALUES (?, ?, 'submitted', ?, ?, 'draft', 'submitted')`,
      [task.id, revision.lastID, actor.id, `调整字段：${adjustment.changedFields.join('、')}`]);
      await recordBusinessAudit({ connection, actor, organizationId: task.organization_id,
        action: `${task.cadence}_adjustment.submitted`, objectType: 'adjustment_request', objectId: adjustment.adjustmentRequestId,
        businessVersion: String(revisionNumber), after: adjustment });
    }
    await run(connection, 'COMMIT');
    committed = true;
    outcome = response;
  } catch (error) {
    if (transactionStarted && !committed) await run(connection, 'ROLLBACK').catch(() => {});
    if (frozenRoom && !committed) {
      try {
        await run(connection, 'BEGIN IMMEDIATE');
        await run(connection, `UPDATE collaboration_rooms SET room_status = 'open', frozen_at = NULL WHERE id = ? AND room_status = 'frozen'`, [frozenRoom.roomId]);
        await run(connection, `UPDATE submission_collab.collaboration_rooms SET room_status = 'open' WHERE room_key = ? AND room_status = 'frozen'`, [frozenRoom.roomKey]);
        await run(connection, 'COMMIT');
      } catch {
        await run(connection, 'ROLLBACK').catch(() => {});
      }
    }
    for (const file of artifactPaths) await fs.rm(file, { force: true }).catch(() => {});
    if (error.status) throw error;
    throw Object.assign(new Error(`提交失败：${error.message}`), { status: 500, cause: error });
  }
  return outcome;
}

let submissionQueue = Promise.resolve();
function submitBusinessRevision(options) {
  const pending = submissionQueue.then(async () => {
    await db.ready;
    const connection = new sqlite3.Database(storage.getDatabasePath());
    connection.configure('busyTimeout', 10000);
    try {
      return await submitBusinessRevisionInTransaction({ ...options, connection });
    } finally {
      await new Promise(resolve => connection.close(resolve));
    }
  });
  submissionQueue = pending.catch(() => {});
  return pending;
}

module.exports = { extractBusinessValues, typedValue, validateUserFormula, submitBusinessRevision };
