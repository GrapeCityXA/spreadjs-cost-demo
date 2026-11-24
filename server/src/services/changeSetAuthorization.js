const { isDeepStrictEqual } = require('node:util');
const { validateBindingSnapshot, validPath } = require('./bindingSource');
const { permissionAt } = require('./permissionIndex');
const { identityFor } = require('./permissionIdentity');
const { decodeNativeFormula } = require('./nativeUserFormula');

const SET_RANGE = 28; // SpreadJS 19.1.4 OpType.setRange.
const CLEAR_RANGE = 51; // Delete: StorageType.data (1) | StorageType.hyperlink (256).
const VIEW_ONLY_TYPES = new Set([47, 49, 52, 112, 124, 126, 128]);
const ROOT_KEYS = new Set(['version', 'name', 'docProps', 'customList', 'defaultSheetTabStyles',
  'builtInFileIcons', 'collaborationInfo', 'scenarioAdditionalInfo', 'dataManager', 'activeSheetId', 'sheets', 'namedPatterns', 'sheetTabs']);
const SHEET_KEYS = new Set(['name', 'isSelected', 'rowCount', 'columnCount', 'visible', '__ID__', 'theme',
  'bindingManager', 'data', 'rowHeaderData', 'colHeaderData', 'defaultData', 'leftCellIndex', 'topCellIndex', 'selections',
  'rowOutlines', 'columnOutlines', 'cellStates', 'outlineColumnOptions', 'autoMergeRangeInfos', 'names', 'order']);

function emptyObject(value) { return value == null || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length); }
function blankValue(value) { return value == null || value === ''; }
// SpreadJS omits a cell's value in collaboration snapshots when setValue(null)
// clears it. Preserve exact comparisons for every non-null published value.
function matchesPublishedValue(value, expected) {
  return value === expected || (value == null && expected == null);
}
function matchesSeedValue(value, sourceCell) {
  return Object.hasOwn(sourceCell, 'value')
    ? value === sourceCell.value || (blankValue(value) && blankValue(sourceCell.value))
    : blankValue(value);
}
const INVALID_FORMULA = Symbol('invalid formula');
function formulaText(info, snapshot, sheetId, functions = []) {
  if (info == null) return null;
  if (typeof info.formula === 'string') return info.formula;
  try { return decodeNativeFormula(info, snapshot, sheetId, new Set(functions)).formula; }
  catch { return INVALID_FORMULA; }
}
function matchesSeedFormula(formula, sourceFormula) {
  if (formula === INVALID_FORMULA || sourceFormula === INVALID_FORMULA) return false;
  if (typeof sourceFormula !== 'string') return formula == null;
  return typeof formula === 'string' && formula.replace(/^=/, '') === sourceFormula.replace(/^=/, '');
}
function sameKeys(value, allowed) { return value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.has(key)); }
function defaultNode(node, tag) {
  if (node == null) return tag == null;
  return sameKeys(node, new Set(['style', 'tag'])) && node?.tag === tag
    && node.style?.themeFont === 'Body' && Object.keys(node.style).length === 1;
}
function validAxisTags(entries, expectedEntries, coordinate) {
  if (entries == null) entries = [];
  if (!Array.isArray(entries)) return false;
  const expected = new Map((expectedEntries || []).map(entry => [Number(entry[coordinate]), entry.tag]));
  if (entries.some((entry, index) => entry && (!sameKeys(entry, new Set(['tag'])) || entry.tag !== expected.get(index)))) return false;
  return [...expected].every(([index, tag]) => entries[index]?.tag === tag);
}
function validNamedAreas(names, mappings, sheetId) {
  if (!names || typeof names !== 'object' || Array.isArray(names)) return false;
  const expected = new Map();
  for (const mapping of mappings || []) {
    if (!mapping.namedArea || !Number.isFinite(Number(mapping.row)) || !Number.isFinite(Number(mapping.col))) continue;
    const name = String(mapping.namedArea).replace(/[^A-Za-z0-9_]/g, '_');
    if (!expected.has(name)) expected.set(name, mapping);
  }
  if (Object.keys(names).length !== expected.size) return false;
  return [...expected].every(([name, mapping]) => {
    const actual = names[name];
    const row = Number(mapping.row), col = Number(mapping.col);
    const rowCount = Math.max(1, Number(mapping.rowCount) || 1);
    const colCount = Math.max(1, Number(mapping.colCount) || 1);
    const ref = actual?.formulaInfo?.refs?.R0;
    return sameKeys(actual, new Set(['name', 'formulaInfo', 'isReadOnly', 'comment']))
      && actual.name === name && actual.isReadOnly === true
      && actual.comment === `${mapping.fieldCode} / ${mapping.permission}`
      && sameKeys(actual.formulaInfo, new Set(['refs', 'parts']))
      && sameKeys(actual.formulaInfo.refs, new Set(['R0']))
      && Object.keys(actual.formulaInfo.refs).length === 1
      && Array.isArray(actual.formulaInfo.parts) && actual.formulaInfo.parts.length === 1
      && sameKeys(actual.formulaInfo.parts[0], new Set(['ref']))
      && actual.formulaInfo.parts[0].ref === 'R0'
      && sameKeys(ref, new Set(['type', 'sheetId', 'row', 'col', 'endRow', 'endCol', 'flags']))
      && ref.type === 0 && ref.sheetId === sheetId && ref.row === row && ref.col === col && ref.flags === 0
      && (rowCount * colCount === 1
        ? !Object.hasOwn(ref, 'endRow') && !Object.hasOwn(ref, 'endCol')
        : ref.endRow === row + rowCount - 1 && ref.endCol === col + colCount - 1);
  });
}

const without = (value, keys) => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !keys.includes(key)));
function publishedDirectLayoutError(snapshot, published) {
  if (!snapshot || !published || !isDeepStrictEqual(without(snapshot, ['sheets', 'activeSheetId', 'dataManager']),
    without(published, ['sheets', 'activeSheetId', 'dataManager']))) return '协作工作簿版式与已发布模板不符';
  if (!Object.hasOwn(snapshot.sheets || {}, snapshot.activeSheetId)
    || !isDeepStrictEqual(Object.keys(snapshot.sheets || {}).sort(), Object.keys(published.sheets || {}).sort())) return '协作工作表与已发布模板不符';
  const viewKeys = ['data', 'bindingManager', 'isSelected', 'selections', 'leftCellIndex', 'topCellIndex'];
  for (const [id, expected] of Object.entries(published.sheets || {})) {
    const actual = snapshot.sheets[id];
    if (!isDeepStrictEqual(without(actual, viewKeys), without(expected, viewKeys))
      || !isDeepStrictEqual(without(actual.data, ['dataTable']), without(expected.data, ['dataTable']))) return '协作工作表版式与已发布模板不符';
    const coordinates = new Set();
    for (const sheet of [actual, expected]) for (const [row, columns] of Object.entries(sheet.data?.dataTable || {})) {
      for (const col of Object.keys(columns)) coordinates.add(`${row},${col}`);
    }
    for (const coordinate of coordinates) {
      const [row, col] = coordinate.split(',');
      if (!isDeepStrictEqual(without(actual.data?.dataTable?.[row]?.[col], ['value', 'formulaInfo']),
        without(expected.data?.dataTable?.[row]?.[col], ['value', 'formulaInfo']))) return '协作单元格版式或权限与已发布模板不符';
    }
  }
  return null;
}

function validateInitialSnapshot(snapshot, workbook, seedSnapshot = null, permissionIndex = null, calculatedValues = {}) {
  const direct = Boolean(workbook?.designerJson && workbook?.templateSnapshot);
  if (direct) {
    const layoutError = publishedDirectLayoutError(snapshot, workbook.templateSnapshot);
    if (layoutError) return layoutError;
  }
  if (!direct && (!sameKeys(snapshot, ROOT_KEYS) || !['19.1.4', '19.2.0'].includes(snapshot.version) || snapshot.name !== ''
    || !emptyObject(snapshot.defaultSheetTabStyles) || !emptyObject(snapshot.builtInFileIcons)
    || !emptyObject(snapshot.namedPatterns) || !emptyObject(snapshot.sheetTabs)
    || !Array.isArray(snapshot.customList) || snapshot.customList.length
    || JSON.stringify(snapshot.docProps) !== '{"docPropsApp":{},"docPropsCore":{}}'
    || JSON.stringify(snapshot.collaborationInfo) !== '{"v":"0.1"}'
    || !Object.hasOwn(snapshot.sheets || {}, snapshot.activeSheetId))) return '协作初始工作簿包含未发布的结构';
  if (!direct && snapshot.scenarioAdditionalInfo && JSON.stringify(snapshot.scenarioAdditionalInfo) !== '{"appliedScenarios":{},"baseValues":{}}') return '初始工作簿包含未发布方案';
  const bindingError = validateBindingSnapshot(snapshot, workbook, seedSnapshot, calculatedValues);
  if (bindingError) return bindingError;
  const actualSheets = Object.values(snapshot?.sheets || {}).sort((a, b) => a.order - b.order);
  const expectedSheets = workbook?.sheets || [];
  if (actualSheets.length !== expectedSheets.length) return '协作初始工作表数量与已发布模板不符';
  for (let index = 0; index < expectedSheets.length; index += 1) {
    const actual = actualSheets[index], expected = expectedSheets[index];
    if (actual.name !== String(expected.name || expected.code || `工作表${index + 1}`).slice(0, 31)
      || actual.rowCount !== expected.rowCount || actual.columnCount !== expected.columnCount || !direct && actual.visible !== 1) {
      return '协作初始工作表结构与已发布模板不符';
    }
    if (actual.bindingManager && !(expected.mappings || []).some(mapping => mapping.bindingPath)) return '工作表包含未发布数据源';
    const dataModel = actual.data || {};
    if (!direct && (!sameKeys(actual, SHEET_KEYS) || actual.__ID__ !== Object.entries(snapshot.sheets).find(([, sheet]) => sheet === actual)?.[0]
      || actual.order !== index || !['Office', 'Office2007'].includes(actual.theme)
      || actual.leftCellIndex !== 0 || actual.topCellIndex !== 0
      || !emptyObject(actual.defaultData) || !emptyObject(actual.rowHeaderData)
      || !(emptyObject(actual.colHeaderData) || JSON.stringify(actual.colHeaderData) === '{"defaultDataNode":{"style":{"themeFont":"Body"}}}')
      || !emptyObject(actual.cellStates) || !emptyObject(actual.outlineColumnOptions)
      || JSON.stringify(actual.rowOutlines) !== '{"items":[]}' || JSON.stringify(actual.columnOutlines) !== '{"items":[]}'
      || !Array.isArray(actual.autoMergeRangeInfos) || actual.autoMergeRangeInfos.length
      || !sameKeys(dataModel, new Set(['dataTable', 'rowDataArray', 'columnDataArray', 'defaultDataNode']))
      || !defaultNode(dataModel.defaultDataNode, expected.tag)
      || !validAxisTags(dataModel.rowDataArray, expected.rowTags, 'row')
      || !validAxisTags(dataModel.columnDataArray, expected.columnTags, 'col')
      || !validNamedAreas(actual.names || {}, expected.mappings, actual.__ID__))) return '协作初始工作簿包含未发布的结构';
    if (!direct && ((actual.rows || []).some(item => item && item.visible === false)
      || (actual.columns || []).some(item => item && item.visible === false))) return '协作初始工作簿包含未发布的隐藏视图';
    const expectedCells = new Map((expected.cells || []).map(cell => [`${cell.row},${cell.column ?? cell.col}`, cell]));
    const sourceSheets = Object.values(seedSnapshot?.sheets || {}).sort((a, b) => a.order - b.order);
    const sourceSheet = sourceSheets[index];
    const sourceSheetId = Object.keys(seedSnapshot?.sheets || {}).find(id => seedSnapshot.sheets[id] === sourceSheet);
    const sourceFormula = cell => formulaText(cell?.formulaInfo, seedSnapshot, sourceSheetId, permissionIndex?.customFunctions);
    const actualFormula = cell => formulaText(cell?.formulaInfo, snapshot, actual.__ID__, permissionIndex?.customFunctions);
    const editableRanges = permissionIndex?.sheets?.[index]?.editableRanges || [];
    const tableSeedRanges = (expected.mappings || []).filter(mapping => mapping.kind === 'table'
      && mapping.primary === true && mapping.permission === 'primary_input').map(mapping => ({
      row: Number(mapping.row), col: Number(mapping.col), rowCount: Number(mapping.rowCount) || 1,
      colCount: Number(mapping.colCount) || 1
    })).filter(range => Number.isInteger(range.row) && Number.isInteger(range.col)
      && range.row >= 0 && range.col >= 0 && range.rowCount > 0 && range.colCount > 0
      && range.row + range.rowCount <= expected.rowCount && range.col + range.colCount <= expected.columnCount);
    const seedRanges = [...editableRanges, ...tableSeedRanges];
    const isSeedInput = (row, col) => Boolean(seedSnapshot && seedRanges.some(range => row >= range.row
      && row < range.row + range.rowCount && col >= range.col && col < range.col + range.colCount));
    for (const [row, columns] of Object.entries(actual.data?.dataTable || {})) {
      for (const [col, data] of Object.entries(columns || {})) {
        const cell = expectedCells.get(`${row},${col}`);
        const rowIndex = Number(row), colIndex = Number(col);
        const sourceCell = sourceSheet?.data?.dataTable?.[row]?.[col] || {};
        const seededInput = isSeedInput(rowIndex, colIndex);
        if (!direct && Object.keys(data).some(key => !['value', 'formulaInfo', 'tag', 'bindingPath'].includes(key))) return '协作初始工作簿包含未发布的单元格属性';
        if (Object.hasOwn(data, 'value') && (!cell || !matchesPublishedValue(data.value, cell.value))
          && (!seededInput || !matchesSeedValue(data.value, sourceCell))) {
          return '协作初始工作簿包含未发布的单元格值';
        }
        const publishedFormula = direct && workbook.templateSnapshot.sheets?.[actual.__ID__]?.data?.dataTable?.[row]?.[col]?.formulaInfo;
        // Native refs/parts preserve the published formula exactly, including
        // cross-sheet references whose displayed text may add optional quotes.
        const matchesPublishedFormula = publishedFormula && isDeepStrictEqual(data.formulaInfo, publishedFormula);
        if (data.formulaInfo && !matchesPublishedFormula && (!cell?.formula || !matchesSeedFormula(actualFormula(data), cell.formula))
          && (!seededInput || !matchesSeedFormula(actualFormula(data), sourceFormula(sourceCell)))) {
          return '协作初始工作簿包含未发布的公式';
        }
        if (data.bindingPath !== cell?.bindingPath) return '单元格绑定路径与已发布模板不符';
        if (data.tag !== cell?.tag) return '协作初始工作簿包含未发布的权限 Tag';
      }
    }
    if (seedSnapshot && sourceSheet) {
      for (const range of seedRanges) for (let row = range.row; row < range.row + range.rowCount; row += 1) {
        for (let col = range.col; col < range.col + range.colCount; col += 1) {
          const sourceCell = sourceSheet.data?.dataTable?.[row]?.[col] || {};
          const data = actual.data?.dataTable?.[row]?.[col] || {};
          if (!matchesSeedValue(data.value, sourceCell)) return '协作初始工作簿未完整保留源修订的输入值';
          if (!matchesSeedFormula(actualFormula(data), sourceFormula(sourceCell))) return '协作初始工作簿未完整保留源修订的输入公式';
        }
      }
    }
    for (const cell of expected.cells || []) {
      const col = cell.column ?? cell.col;
      const data = actual.data?.dataTable?.[cell.row]?.[col] || {};
      const sourceCell = sourceSheet?.data?.dataTable?.[cell.row]?.[col] || {};
      const seededInput = isSeedInput(cell.row, col);
      if (cell.formula && !data.formulaInfo
        && (!seededInput || sourceCell.formulaInfo != null)) return '协作初始工作簿缺少已发布公式';
      if (cell.value !== undefined && !cell.formula && !matchesPublishedValue(data.value, cell.value)
        && (!seededInput || !matchesSeedValue(data.value, sourceCell))) {
        return '协作初始工作簿缺少已发布的单元格值';
      }
      if (cell.bindingPath !== data.bindingPath) return '缺少已发布的单元格绑定路径';
      if (cell.tag !== data.tag) return '协作初始工作簿缺少已发布的权限 Tag';
    }
  }
  return null;
}

function authorizeChangeSet(changeSet, snapshot, index, user, organizationId) {
  if (!Array.isArray(changeSet?.ops) || !changeSet.ops.length || changeSet.ops.length > 500) return '协作变更集格式无效';
  if (index?.version !== 1 || !Array.isArray(index.sheets)) return '已发布模板缺少权限索引';
  const snapshotSheets = snapshot?.sheets || {};
  const identity = identityFor(user, organizationId);
  for (const op of changeSet.ops) {
    if (op?.module === 'dataManager') {
      const error = authorizeBindingUpdate(op, snapshot, index, identity);
      if (error) return error;
      continue;
    }
    const isClear = op?.type === CLEAR_RANGE;
    if (!op || ![SET_RANGE, CLEAR_RANGE].includes(op.type) || op.module !== 'worksheet' || typeof op.sheetId !== 'string') {
      return VIEW_ONLY_TYPES.has(op?.type) ? '视图或结构操作不能提交到协作房间' : '此协作操作类型未获授权';
    }
    if (Object.keys(op).some(key => !['type', 'module', 'sheetId', 'target', 'payload'].includes(key))
      || Object.keys(op.payload || {}).some(key => !(isClear ? ['clearType', 'ignoredRowList'] : ['rangeData']).includes(key))) return '协作操作包含未获授权的属性';
    if (isClear && (![1, 257].includes(op.payload?.clearType)
      || op.payload.ignoredRowList != null && (!Array.isArray(op.payload.ignoredRowList) || op.payload.ignoredRowList.length))) {
      return '只允许清除输入内容，不能清除格式、权限标签或结构';
    }
    const actualSheet = snapshotSheets[op.sheetId];
    const sheet = actualSheet && index.sheets[actualSheet.order];
    if (!sheet || actualSheet.name !== String(sheet.name || sheet.code).slice(0, 31)) return '协作操作引用了未知工作表';
    const target = op.target || {};
    const { row, col, rowCount, colCount, sheetArea } = target;
    if (![row, col, rowCount, colCount].every(Number.isSafeInteger) || row < 0 || col < 0 || rowCount < 1 || colCount < 1
      || rowCount * colCount > 10000 || row + rowCount > sheet.rowCount || col + colCount > sheet.columnCount || sheetArea !== 3) {
      return '协作操作的单元格范围无效';
    }
    const rangeData = op.payload?.rangeData;
    const keys = rangeData && Object.keys(rangeData);
    if (!isClear && (!keys || keys.length !== 1 || !['value', 'formula'].includes(keys[0]))) return '只允许提交单元格输入值或用户公式';
    if (!isClear && keys[0] === 'value' && rangeData.value != null && !['string', 'number', 'boolean'].includes(typeof rangeData.value)) {
      return '单元格输入值类型无效';
    }
    if (!isClear && keys[0] === 'formula' && (rowCount !== 1 || colCount !== 1 || rangeData.formula?.isArrayFormula
      || rangeData.formula?.isDynamicArray || rangeData.formula?.baseRange)) return '仅允许提交单个单元格的普通公式';
    if (!isClear && keys[0] === 'formula') {
      const formula = rangeData.formula;
      if (sameKeys(formula, new Set(['formulaInfo'])) && Object.hasOwn(formula, 'formulaInfo') && formula.formulaInfo === null) {
        // Native numeric overwrite removes the previous formula in the same ChangeSet.
      } else if (formula?.formulaInfo) {
        if (!sameKeys(formula, new Set(['formulaInfo']))) return '用户公式包含未获授权的属性';
        try {
          const decoded = decodeNativeFormula(formula.formulaInfo, snapshot, op.sheetId, new Set(index.customFunctions || []));
          for (const ref of decoded.references) {
            const source = snapshotSheets[ref.sheetId];
            const rules = index.sheets[source.order];
            if (!rules || source.name !== String(rules.name || rules.code).slice(0, 31)) return '用户公式引用了未知工作表';
            for (let r = ref.row; r <= ref.endRow; r++) for (let c = ref.col; c <= ref.endCol; c++) {
              if (!permissionAt(rules, r, c, identity).editable) return '用户公式引用了未授权的数据区域';
              if (ref.sheetId === op.sheetId && r === row && c === col) return '用户公式包含循环引用';
            }
          }
        } catch (error) { return error.message; }
      } else if (!formula || typeof formula.formula !== 'string' || !formula.formula.trim()) return '用户公式格式无效';
    }
    for (let r = row; r < row + rowCount; r += 1) for (let c = col; c < col + colCount; c += 1) {
      if ((sheet.bindings || []).some(binding => binding.row === r && binding.col === c) && !isClear) return '绑定单元格应通过数据源提交标量值';
      if (!permissionAt(sheet, r, c, identity).editable) return '协作操作超出当前用户获准的 Primary Input 区域';
    }
  }
  return null;
}

function authorizeBindingUpdate(op, snapshot, index, identity) {
  const payload = op.payload;
  if (op.type !== 441 || !sameKeys(op, new Set(['type', 'module', 'payload']))
    || !sameKeys(payload, new Set(['tableId', 'index', 'dataType', 'item']))
    || payload.index !== 0 || payload.dataType !== 'flat' || typeof payload.tableId !== 'string'
    || !payload.item || Array.isArray(payload.item) || typeof payload.item !== 'object'
    || !Object.keys(payload.item).length || Object.keys(payload.item).length > 1000) return '绑定数据操作格式无效';
  const table = snapshot?.dataManager?.tables?.[payload.tableId];
  if (!table || table.name !== 'reportData' || table.dataSourceOption?.remote) return '未知绑定数据源';
  for (const [path, value] of Object.entries(payload.item)) {
    if (!validPath(path) || !Object.hasOwn(table.dataSourceOption?.data?.[0] || {}, path)
      || value != null && !['string','number','boolean'].includes(typeof value)
      || typeof value === 'number' && !Number.isFinite(value)) return '绑定字段值无效';
    const authorized = Object.values(snapshot.sheets || {}).some(actual => {
      const rules = index.sheets[actual.order];
      return actual.bindingManager?.tableId === payload.tableId && actual.bindingManager.activeRecordIndex === 0
        && rules && actual.name === String(rules.name || rules.code).slice(0,31)
        && (rules.bindings || []).some(binding => binding.path === path && binding.primary
          && permissionAt(rules, binding.row, binding.col, identity).editable);
    });
    if (!authorized) return '绑定数据操作超出当前用户获准的填报范围';
  }
  return null;
}

module.exports = { authorizeChangeSet, validateInitialSnapshot, identityFor };
