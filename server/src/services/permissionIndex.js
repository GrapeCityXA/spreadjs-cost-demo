const { editAllows, validateRule, validateEntries, entriesForSheet } = require('./permissionPolicy');
const { collectFunctionRefs } = require('./managedFunctions');
const TAG_VERSION = 1;
const ROLE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function parseTag(raw, location) {
  if (raw == null) return null;
  if (typeof raw !== 'string') throw new Error(`${location} 的权限 Tag 必须是 JSON 字符串`);
  let tag;
  try { tag = JSON.parse(raw); } catch { throw new Error(`${location} 的权限 Tag 不是有效 JSON`); }
  if (!tag || typeof tag !== 'object' || Array.isArray(tag) || tag.schemaVersion !== TAG_VERSION) {
    throw new Error(`${location} 的权限 Tag 版本无效`);
  }
  for (const key of ['hiddenForRoles', 'maskedForRoles', 'editableForRoles', 'denyEditForRoles', 'hiddenForDepartments', 'maskedForDepartments', 'editableForDepartments', 'denyEditForDepartments']) {
    if (tag[key] == null) continue;
    const validIdentifier = key.endsWith('Departments')
      ? value => typeof value === 'string' && value.trim() === value && value.length > 0
      : value => typeof value === 'string' && ROLE_IDENTIFIER.test(value);
    if (!Array.isArray(tag[key]) || tag[key].some(value => !validIdentifier(value))) {
      throw new Error(`${location} 的 ${key} 必须是稳定的角色或部门标识列表`);
    }
  }
  if (tag.visibility != null && !['visible', 'hidden', 'masked'].includes(tag.visibility)) throw new Error(`${location} 的可见性无效`);
  if (tag.allVisible != null && typeof tag.allVisible !== 'boolean') throw new Error(`${location} 的所有人可见设置无效`);
  if (tag.allVisible === false && !['user', 'role', 'department'].includes(tag.dimension)) throw new Error(`${location} 的可见权限维度无效`);
  if (tag.visibleUsers != null && (!Array.isArray(tag.visibleUsers) || tag.visibleUsers.some(id => !Number.isSafeInteger(id) || id <= 0))) throw new Error(`${location} 的人员列表无效`);
  for (const key of ['visibleRoles', 'visibleDepartments']) if (tag[key] != null && (!Array.isArray(tag[key])
    || tag[key].some(value => typeof value !== 'string' || !value.trim() || key === 'visibleRoles' && !ROLE_IDENTIFIER.test(value)))) throw new Error(`${location} 的可见范围无效`);
  if (tag.excludedVisibility != null && !['hidden', 'masked'].includes(tag.excludedVisibility)) throw new Error(`${location} 的无权限显示方式无效`);
  if (tag.editableForUsers != null && (!Array.isArray(tag.editableForUsers) || tag.editableForUsers.some(id => !Number.isSafeInteger(id) || id <= 0))) throw new Error(location + ' 的可编辑人员列表无效');
  if (tag.permissionModel != null && tag.permissionModel !== 2) throw new Error(location + ' 的权限模型版本无效');
  const conflict = validateRule(tag);
  if (conflict) throw new Error(location + '：' + conflict);
  return tag;
}

function normalizedTag(raw) {
  if (raw == null) return raw;
  let tag = raw;
  if (typeof raw === 'string') {
    try { tag = JSON.parse(raw); } catch { return raw; }
  }
  if (!tag || typeof tag !== 'object' || Array.isArray(tag)) return raw;
  return JSON.stringify({ ...tag, schemaVersion: TAG_VERSION });
}

function ruleFromTag(tag) {
  if (!tag) return null;
  return Object.fromEntries(['permissionModel', 'editDimension', 'editableForUsers', 'permission', 'visibility', 'allVisible', 'dimension', 'visibleUsers', 'visibleRoles', 'visibleDepartments', 'excludedVisibility', 'hiddenForRoles', 'maskedForRoles', 'editableForRoles', 'denyEditForRoles',
    'hiddenForDepartments', 'maskedForDepartments', 'editableForDepartments', 'denyEditForDepartments']
    .filter(key => tag[key] != null).map(key => [key, tag[key]]));
}

function fixedRecordRows(sheet, mapping) {
  if (mapping.kind !== 'table') return [];
  const keysByRow = new Map();
  (sheet.cells || []).forEach(cell => {
    const row = Number(cell.row), col = Number(cell.column ?? cell.col);
    if (row <= Number(mapping.row) || row >= Number(mapping.row) + Number(mapping.rowCount)
      || col < Number(mapping.col) || col >= Number(mapping.col) + Number(mapping.colCount)) return;
    try {
      const recordKey = JSON.parse(cell.tag || 'null')?.recordKey;
      if (typeof recordKey !== 'string' || !recordKey) return;
      const keys = keysByRow.get(row) || new Set();
      keys.add(recordKey);
      keysByRow.set(row, keys);
    } catch { /* malformed Tags do not grant write permission */ }
  });
  return [...keysByRow].filter(([, keys]) => keys.size === 1).map(([row]) => row).sort((a, b) => a - b);
}

function isFixedRecordTable(sheet, mapping) {
  return mapping.kind === 'table' && fixedRecordRows(sheet, mapping).length > 0;
}

function compilePermissionIndex(workbook) {
  if (!Array.isArray(workbook?.sheets) || !workbook.sheets.length) throw new Error('模板工作簿缺少工作表');
  return { version: TAG_VERSION, customFunctions: [...new Set(collectFunctionRefs(workbook).map(ref => ref.name))], sheets: workbook.sheets.map((sheet, sheetIndex) => {
    const name = `工作表 ${sheet.code || sheetIndex + 1}`;
    const sheetTag = parseTag(sheet.tag, name);
    for (const mapping of sheet.mappings || []) parseTag(normalizedTag(mapping), `${name} 映射权限`);
    const rowTags = [];
    const columnTags = [];
    const cellTags = [];
    for (const entry of sheet.rowTags || []) {
      const row = Number(entry.row);
      if (!Number.isInteger(row) || row < 0 || row >= sheet.rowCount) throw new Error(`${name} 的行权限坐标无效`);
      rowTags.push({ row, rule: ruleFromTag(parseTag(entry.tag, `${name} 第 ${row + 1} 行`)) });
    }
    for (const entry of sheet.columnTags || []) {
      const col = Number(entry.col);
      if (!Number.isInteger(col) || col < 0 || col >= sheet.columnCount) throw new Error(`${name} 的列权限坐标无效`);
      columnTags.push({ col, rule: ruleFromTag(parseTag(entry.tag, `${name} 第 ${col + 1} 列`)) });
    }
    for (const cell of sheet.cells || []) {
      if (cell.tag == null) continue;
      const row = Number(cell.row), col = Number(cell.column ?? cell.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= sheet.rowCount || col >= sheet.columnCount) {
        throw new Error(`${name} 的单元格权限坐标无效`);
      }
      cellTags.push({ row, col, rule: ruleFromTag(parseTag(cell.tag, `${name} 单元格 ${row + 1},${col + 1}`)) });
    }
    const editableRanges = (sheet.mappings || []).filter(mapping => (mapping.kind == null || mapping.kind === 'input'
      || (mapping.kind === 'table' && isFixedRecordTable(sheet, mapping))) && mapping.primary === true
      && mapping.permission === 'primary_input').flatMap(mapping => {
      const base = { col: Number(mapping.col), colCount: Number(mapping.colCount),
        users: mapping.editableForUsers || [], roles: mapping.editableForRoles || (mapping.editableForUsers || mapping.editableForDepartments ? [] : ['subsidiary_filler']), departments: mapping.editableForDepartments || [] };
      if (mapping.kind !== 'table') return [{ ...base, row: Number(mapping.row), rowCount: Number(mapping.rowCount) }];
      return fixedRecordRows(sheet, mapping).map(row => ({ ...base, row, rowCount: 1 }));
    });
    for (const cell of sheet.cells || []) {
      const tag = parseTag(cell.tag, name)
      if (tag?.platform !== 'cost-report-cell-permission-v1' || tag.permission !== 'primary_input') continue;
      const row = Number(cell.row), col = Number(cell.column ?? cell.col);
      const mapped = (sheet.mappings || []).some(mapping => row >= mapping.row && row < mapping.row + mapping.rowCount
        && col >= mapping.col && col < mapping.col + mapping.colCount);
      if (!mapped) editableRanges.push({ row, col, rowCount: 1, colCount: 1,
        users: tag.editableForUsers || [], roles: tag.editableForRoles || [], departments: tag.editableForDepartments || [] });
    }
    const grants = [{ rule: ruleFromTag(sheetTag), row: 0, col: 0, rowCount: sheet.rowCount, colCount: sheet.columnCount },
      ...rowTags.map(({ row, rule }) => ({ rule, row, col: 0, rowCount: 1, colCount: sheet.columnCount })),
      ...columnTags.map(({ col, rule }) => ({ rule, col, row: 0, rowCount: sheet.rowCount, colCount: 1 }))];
    for (const { rule, ...range } of grants) if (rule?.permission === 'primary_input') editableRanges.push({ ...range,
      users: rule.editableForUsers || [], roles: rule.editableForRoles || [], departments: rule.editableForDepartments || [] });
    const nonEditableRanges = (sheet.mappings || []).filter(mapping => mapping.permission !== 'primary_input' || !mapping.primary || mapping.kind === 'calc')
      .map(({ row, col, rowCount, colCount }) => ({ row, col, rowCount, colCount }));
    for (const mapping of (sheet.mappings || []).filter(mapping => mapping.kind === 'table')) {
      const inputRows = fixedRecordRows(sheet, mapping);
      for (let row = mapping.row; row < mapping.row + mapping.rowCount; row++) if (!inputRows.includes(row)) {
        nonEditableRanges.push({ row, col: mapping.col, rowCount: 1, colCount: mapping.colCount });
      }
    }
    for (const cell of sheet.cells || []) if (cell.formula) nonEditableRanges.push({ row: cell.row, col: cell.column ?? cell.col, rowCount: 1, colCount: 1 });
    return { code: sheet.code, name: sheet.name, rowCount: sheet.rowCount, columnCount: sheet.columnCount,
      bindings: (sheet.mappings || []).filter(mapping => mapping.bindingPath).map(mapping => ({ path: mapping.bindingPath, row: mapping.row, col: mapping.col, primary: mapping.primary })),
      readOnly: Boolean(sheet.readOnly), sheetRule: ruleFromTag(sheetTag), rowTags, columnTags, cellTags, editableRanges, nonEditableRanges };
  }) };
}

function includesIdentity(list, identity) { return Array.isArray(list) && list.some(value => identity.includes(value)); }
function audienceAllows(rule, identity) {
  if (rule.allVisible !== false) return true;
  if (rule.dimension === 'user') return (rule.visibleUsers || []).some(id => Number(id) === Number(identity.userId));
  return includesIdentity(rule.dimension === 'role' ? rule.visibleRoles : rule.visibleDepartments,
    (rule.dimension === 'role' ? identity.roles : identity.departments) || []);
}
function permissionAt(sheet, row, col, identity) {
  const rules = [sheet.sheetRule,
    ...sheet.rowTags.filter(entry => entry.row === row).map(entry => entry.rule),
    ...sheet.columnTags.filter(entry => entry.col === col).map(entry => entry.rule),
    ...sheet.cellTags.filter(entry => entry.row === row && entry.col === col).map(entry => entry.rule)].filter(Boolean);
  const hidden = rules.some(rule => rule.visibility === 'hidden' || includesIdentity(rule.hiddenForRoles, identity.roles)
    || includesIdentity(rule.hiddenForDepartments, identity.departments) || !audienceAllows(rule, identity) && rule.excludedVisibility !== 'masked');
  const masked = !hidden && rules.some(rule => rule.visibility === 'masked' || includesIdentity(rule.maskedForRoles, identity.roles)
    || includesIdentity(rule.maskedForDepartments, identity.departments) || !audienceAllows(rule, identity));
  const denied = sheet.readOnly || hidden || masked || rules.some(rule => includesIdentity(rule.denyEditForRoles, identity.roles)
    || includesIdentity(rule.denyEditForDepartments, identity.departments) || ['read_only', 'system'].includes(rule.permission))
    || (sheet.nonEditableRanges || []).some(range => row >= range.row && row < range.row + range.rowCount && col >= range.col && col < range.col + range.colCount);
  const mapped = sheet.editableRanges.some(range => row >= range.row && row < range.row + range.rowCount
    && col >= range.col && col < range.col + range.colCount
    && editAllows({ editableForUsers: range.users, editableForRoles: range.roles, editableForDepartments: range.departments }, identity));
  const explicitAllows = rules.filter(rule => rule.editableForUsers || rule.editableForRoles || rule.editableForDepartments);
  const allowed = mapped && !denied && explicitAllows.every(rule => editAllows(rule, identity));
  return { visibility: hidden ? 'hidden' : masked ? 'masked' : 'visible', editable: allowed };
}

function validatePermissionConfiguration(workbook, options) {
  try { compilePermissionIndex(workbook); }
  catch (error) { error.status = 400; throw error; }
  for (const sheet of workbook.sheets || []) {
    const error = validateEntries(entriesForSheet(sheet), options);
    if (error) throw Object.assign(new Error((sheet.name || sheet.code || '工作表') + '：' + error), { status: 400 });
  }
}

module.exports = { validatePermissionConfiguration, TAG_VERSION, parseTag, normalizedTag, compilePermissionIndex, permissionAt };
