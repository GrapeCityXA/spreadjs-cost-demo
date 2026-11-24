const test = require('node:test');
const assert = require('node:assert/strict');
const { compilePermissionIndex, normalizedTag, permissionAt } = require('../src/services/permissionIndex');
const { authorizeChangeSet, validateInitialSnapshot, identityFor } = require('../src/services/changeSetAuthorization');

const tag = value => normalizedTag(value);
const workbook = { sheets: [{ code: 'business', name: '经营指标', rowCount: 4, columnCount: 4, readOnly: false,
  tag: tag({ visibility: 'visible' }),
  rowTags: [{ row: 1, tag: tag({ denyEditForRoles: ['subsidiary_filler'] }) }],
  columnTags: [{ col: 2, tag: tag({ maskedForRoles: ['subsidiary_filler'] }) }],
  cells: [{ row: 0, column: 0, value: '固定标题' }, { row: 0, column: 1, tag: tag({ hiddenForRoles: ['subsidiary_filler'] }) }],
  mappings: [{ kind: 'input', primary: true, permission: 'primary_input', row: 0, col: 0, rowCount: 3, colCount: 3,
    editableForRoles: ['subsidiary_filler'] }] }] };
const index = compilePermissionIndex(workbook);
const filler = { roles: [{ code: 'subsidiary_filler', organizationId: 3 }] };
const snapshot = { sheets: { sheetA: { name: '经营指标', order: 0 } } };
const edit = (row, col, data = { value: 12 }) => ({ type: 28, module: 'worksheet', sheetId: 'sheetA',
  target: { row, col, rowCount: 1, colCount: 1, sheetArea: 3 }, payload: { rangeData: data } });

test('Delete permits input clearing but cannot clear locked cells, styles or permission tags', () => {
  const clear = (row, col, clearType = 257) => ({ ...edit(row, col), type: 51, payload: { clearType, ignoredRowList: [] } });
  assert.equal(authorizeChangeSet({ ops: [clear(0, 0)] }, snapshot, index, filler, 3), null);
  for (const op of [clear(1, 0), clear(0, 1), clear(3, 3), clear(0, 0, 2), clear(0, 0, 8), clear(0, 0, 259)]) {
    assert.ok(authorizeChangeSet({ ops: [op] }, snapshot, index, filler, 3));
  }
  const range = clear(0, 0); range.target.rowCount = 2;
  assert.ok(authorizeChangeSet({ ops: [range] }, snapshot, index, filler, 3));
});
const initialSnapshot = (contract, dataTable) => ({ version: '19.1.4', name: '',
  docProps: { docPropsApp: {}, docPropsCore: {} }, customList: [], defaultSheetTabStyles: {}, builtInFileIcons: {},
  collaborationInfo: { v: '0.1' }, activeSheetId: 'sheetA', namedPatterns: {}, sheetTabs: {},
  sheets: { sheetA: { name: contract.name, isSelected: true, rowCount: contract.rowCount,
    columnCount: contract.columnCount, visible: 1, __ID__: 'sheetA', theme: 'Office2007',
    data: { dataTable, rowDataArray: [null, { tag: contract.rowTags[0].tag }],
      columnDataArray: [null, null, { tag: contract.columnTags[0].tag }],
      defaultDataNode: { style: { themeFont: 'Body' }, tag: contract.tag } },
    rowHeaderData: {}, colHeaderData: { defaultDataNode: { style: { themeFont: 'Body' } } },
    defaultData: {}, leftCellIndex: 0, topCellIndex: 0, selections: {},
    rowOutlines: { items: [] }, columnOutlines: { items: [] }, cellStates: {}, outlineColumnOptions: {},
    autoMergeRangeInfos: [], names: {}, order: 0 } } });

test('published null cells may omit snapshot values while retaining tags and rejecting injected values', () => {
  const contract = structuredClone(workbook);
  contract.sheets[0].cells[0].value = null;
  contract.sheets[0].cells[1].value = null;
  const initial = initialSnapshot(contract.sheets[0], {
    0: { 1: { tag: contract.sheets[0].cells[1].tag } }
  });
  assert.equal(validateInitialSnapshot(initial, contract), null);
  for (const value of [0, false, '', 'injected']) {
    const changed = structuredClone(initial);
    changed.sheets.sheetA.data.dataTable[0][0] = { value };
    assert.match(validateInitialSnapshot(changed, contract), /未发布的单元格值/);
  }
  const missingTag = structuredClone(initial);
  delete missingTag.sheets.sheetA.data.dataTable[0][1];
  assert.match(validateInitialSnapshot(missingTag, contract), /权限 Tag/);
  for (const value of [0, false, '', '固定标题']) {
    contract.sheets[0].cells[0].value = value;
    assert.match(validateInitialSnapshot(initial, contract), /缺少已发布的单元格值/);
  }
});

test('sheet, row, column and cell permission conflicts use deny precedence', () => {
  const identity = { roles: ['subsidiary_filler'], departments: [] };
  assert.equal(permissionAt(index.sheets[0], 0, 0, identity).editable, true);
  assert.equal(permissionAt(index.sheets[0], 1, 0, identity).editable, false);
  assert.equal(permissionAt(index.sheets[0], 0, 2, identity).visibility, 'masked');
  assert.equal(permissionAt(index.sheets[0], 0, 1, identity).visibility, 'hidden');
  assert.equal(permissionAt(index.sheets[0], 3, 3, identity).editable, false);
});

test('a new revision preserves native input formulas and rejects a changed seed formula', () => {
  const data = { 0: { 0: { formulaInfo: { refs: {}, parts: [{ text: '1+2' }] } },
    1: { tag: workbook.sheets[0].cells[1].tag } } };
  const source = initialSnapshot(workbook.sheets[0], data);
  const next = structuredClone(source);
  assert.equal(validateInitialSnapshot(next, workbook, source, index), null);
  next.sheets.sheetA.data.dataTable[0][0].formulaInfo.parts[0].text = '9+9';
  assert.match(validateInitialSnapshot(next, workbook, source, index), /公式/);
});

test('quarterly fixed table input exposes data rows to subsidiary fillers and keeps the header locked', () => {
  const tableIndex = compilePermissionIndex({ sheets: [{ code: 'quarter', name: '季度', rowCount: 6, columnCount: 2,
    cells: [{ row: 3, column: 0, tag: JSON.stringify({ schemaVersion: 1, recordKey: 'quarterly:key_business:A' }) },
      { row: 4, column: 0, tag: JSON.stringify({ schemaVersion: 1, recordKey: 'quarterly:key_business:B' }) }],
    mappings: [{ kind: 'table', primary: true, permission: 'primary_input', row: 2, col: 0, rowCount: 3, colCount: 1 }] }] });
  const identity = { roles: ['subsidiary_filler'], departments: [] };
  assert.equal(permissionAt(tableIndex.sheets[0], 2, 0, identity).editable, false);
  assert.equal(permissionAt(tableIndex.sheets[0], 3, 0, identity).editable, true);
  assert.equal(permissionAt(tableIndex.sheets[0], 4, 0, identity).editable, true);
});

test('quarterly fixed table permissions exclude unused template capacity beyond configured indicator rows', () => {
  const tableIndex = compilePermissionIndex({ sheets: [{ code: 'quarter', name: '季度', rowCount: 7, columnCount: 2,
    cells: [{ row: 3, column: 0, tag: tag({ recordKey: 'quarterly:key_business:A' }) },
      { row: 4, column: 0, tag: tag({ recordKey: 'quarterly:key_business:B' }) }],
    mappings: [{ kind: 'table', primary: true, permission: 'primary_input', row: 2, col: 0, rowCount: 4, colCount: 2 }] }] });
  const identity = { roles: ['subsidiary_filler'], departments: [] };
  assert.equal(permissionAt(tableIndex.sheets[0], 3, 1, identity).editable, true);
  assert.equal(permissionAt(tableIndex.sheets[0], 4, 1, identity).editable, true);
  assert.equal(permissionAt(tableIndex.sheets[0], 5, 0, identity).editable, false);
  assert.equal(permissionAt(tableIndex.sheets[0], 5, 1, identity).editable, false);
});

test('publication rejects malformed, unversioned and unstable permission Tags', () => {
  for (const invalid of ['not-json', JSON.stringify({ hiddenForRoles: ['subsidiary_filler'] }),
    tag({ hiddenForRoles: ['Alice Smith'] })]) {
    assert.throws(() => compilePermissionIndex({ sheets: [{ ...workbook.sheets[0], tag: invalid }] }), /权限 Tag|标识/);
  }
  assert.doesNotThrow(() => compilePermissionIndex({ sheets: [{ ...workbook.sheets[0],
    tag: tag({ hiddenForDepartments: ['DEPT_FINANCE_01'] }) }] }));
  assert.doesNotThrow(() => compilePermissionIndex({ sheets: [{ ...workbook.sheets[0],
    tag: tag({ hiddenForDepartments: ['财务部'] }) }] }));
});

test('direct ChangeSets allow only values or formulas inside authorized Primary Input cells', () => {
  assert.equal(authorizeChangeSet({ ops: [edit(0, 0)] }, snapshot, index, filler, 3), null);
  assert.equal(authorizeChangeSet({ ops: [edit(0, 0, { formula: { formula: '1+2' } })] }, snapshot, index, filler, 3), null);
  assert.match(authorizeChangeSet({ ops: [edit(0, 0, { formula: {} })] }, snapshot, index, filler, 3), /公式格式/);
  const rangeFormula = edit(0, 0, { formula: { formula: 'A1+1' } });
  rangeFormula.target.colCount = 2;
  assert.match(authorizeChangeSet({ ops: [rangeFormula] }, snapshot, index, filler, 3), /单个单元格/);
  assert.match(authorizeChangeSet({ ops: [edit(1, 0)] }, snapshot, index, filler, 3), /Primary Input/);
  assert.match(authorizeChangeSet({ ops: [edit(0, 2)] }, snapshot, index, filler, 3), /Primary Input/);
  assert.match(authorizeChangeSet({ ops: [edit(0, 0, { valueForKeys: { tag: 'tampered' } })] }, snapshot, index, filler, 3), /只允许/);
  assert.match(authorizeChangeSet({ ops: [{ type: 47, module: 'worksheet', sheetId: 'sheetA' }] }, snapshot, index, filler, 3), /视图/);
  assert.match(authorizeChangeSet({ ops: [edit(0, 0), edit(0, 1)] }, snapshot, index, filler, 3), /Primary Input/);
  assert.match(authorizeChangeSet({ ops: [edit(0, 0)] }, snapshot, index, { roles: [{ code: 'subsidiary_filler', organizationId: 4 }] }, 3), /Primary Input/);
});

test('collaboration creation requires the published template values and formulas', () => {
  const initial = initialSnapshot(workbook.sheets[0], { 0: { 0: { value: '固定标题' },
    1: { tag: workbook.sheets[0].cells[1].tag } } });
  assert.equal(validateInitialSnapshot(initial, workbook), null);
  initial.sheets.sheetA.data.dataTable[0][0].value = 'tampered';
  assert.match(validateInitialSnapshot(initial, workbook), /未发布/);
  initial.sheets.sheetA.data.dataTable[0][0].value = '固定标题';
  initial.sheets.sheetA.spans = [{ row: 0, col: 0, rowCount: 2, colCount: 2 }];
  assert.match(validateInitialSnapshot(initial, workbook), /未发布的结构/);
  const formulaWorkbook = { sheets: [{ ...workbook.sheets[0], cells: [{ row: 0, column: 0, formula: '=1' }] }] };
  const formulaSnapshot = initialSnapshot(formulaWorkbook.sheets[0], { 0: { 0: { formulaInfo: { formula: '1' } } } });
  assert.equal(validateInitialSnapshot(formulaSnapshot, formulaWorkbook), null);
  formulaSnapshot.sheets.sheetA.data.dataTable[0][0].formulaInfo.formula = '999';
  assert.match(validateInitialSnapshot(formulaSnapshot, formulaWorkbook), /未发布的公式/);
  const namedWorkbook = { sheets: [{ ...workbook.sheets[0], mappings: [{
    ...workbook.sheets[0].mappings[0], fieldCode: 'revenue', namedArea: 'INPUT_REVENUE', rowCount: 2, colCount: 2
  }] }] };
  const namedSnapshot = initialSnapshot(namedWorkbook.sheets[0], { 0: { 0: { value: '固定标题' },
    1: { tag: workbook.sheets[0].cells[1].tag } } });
  namedSnapshot.sheets.sheetA.names.INPUT_REVENUE = {
    name: 'INPUT_REVENUE', formulaInfo: { refs: { R0: { type: 0, sheetId: 'sheetA', row: 0, col: 0,
      endRow: 1, endCol: 1, flags: 0 } }, parts: [{ ref: 'R0' }] }, isReadOnly: true,
    comment: 'revenue / primary_input'
  };
  assert.equal(validateInitialSnapshot(namedSnapshot, namedWorkbook), null);
  namedSnapshot.sheets.sheetA.names.INPUT_REVENUE.formulaInfo.refs.R0.row = 2;
  assert.match(validateInitialSnapshot(namedSnapshot, namedWorkbook), /未发布的结构/);
  namedSnapshot.sheets.sheetA.names.INPUT_REVENUE.formulaInfo.refs.R0.row = 0;
  namedSnapshot.sheets.sheetA.names.INPUT_REVENUE.isReadOnly = false;
  assert.match(validateInitialSnapshot(namedSnapshot, namedWorkbook), /未发布的结构/);

  const tableMapping = { kind: 'table', primary: true, permission: 'primary_input', fieldCode: 'COSTS',
    namedArea: 'TABLE_COSTS', row: 1, col: 1, rowCount: 2, colCount: 2 };
  const tableWorkbook = { sheets: [{ ...workbook.sheets[0],
    cells: [...workbook.sheets[0].cells, { row: 1, column: 1, value: '默认项目' }], mappings: [tableMapping] }] };
  const tableData = { 0: { 0: { value: '固定标题' }, 1: { tag: workbook.sheets[0].cells[1].tag } },
    1: { 1: { value: null }, 2: { value: 10 } }, 2: { 1: { value: '水电' }, 2: { value: 20 } } };
  const tableSnapshot = initialSnapshot(tableWorkbook.sheets[0], tableData);
  tableSnapshot.sheets.sheetA.names.TABLE_COSTS = { name: 'TABLE_COSTS',
    formulaInfo: { refs: { R0: { type: 0, sheetId: 'sheetA', row: 1, col: 1, endRow: 2, endCol: 2, flags: 0 } },
      parts: [{ ref: 'R0' }] }, isReadOnly: true, comment: 'COSTS / primary_input' };
  const sourceTableData = { 0: structuredClone(tableData[0]),
    1: { 2: { value: 10 } }, 2: structuredClone(tableData[2]) };
  const tableSource = { sheets: { sheetA: { order: 0, data: { dataTable: sourceTableData } } } };
  const tablePermissionIndex = compilePermissionIndex(tableWorkbook);
  assert.equal(tablePermissionIndex.sheets[0].editableRanges.length, 0,
    'ordinary TABLE areas do not become collaboration ChangeSet write permissions');
  assert.equal(validateInitialSnapshot(tableSnapshot, tableWorkbook, tableSource, tablePermissionIndex), null,
    'a correction-room snapshot may seed values and a cleared default from the exact source cells in a published primary TABLE area');
  const unclearedDefault = structuredClone(tableSnapshot);
  unclearedDefault.sheets.sheetA.data.dataTable[1][1].value = '默认项目';
  assert.match(validateInitialSnapshot(unclearedDefault, tableWorkbook, tableSource, tablePermissionIndex), /未完整保留源修订/,
    'a template default cannot reappear when the source revision had cleared that cell');
  const omittedTableValue = structuredClone(tableSnapshot);
  delete omittedTableValue.sheets.sheetA.data.dataTable[2][2];
  assert.match(validateInitialSnapshot(omittedTableValue, tableWorkbook, tableSource, tablePermissionIndex), /未完整保留源修订/,
    'the initial snapshot cannot omit a previously submitted non-empty TABLE cell');
  tableSnapshot.sheets.sheetA.data.dataTable[2][2].value = 21;
  assert.match(validateInitialSnapshot(tableSnapshot, tableWorkbook, tableSource, tablePermissionIndex), /未发布的单元格值/,
    'seeded TABLE values must match the immutable source snapshot cell by cell');
  assert.match(authorizeChangeSet({ ops: [edit(1, 1)] }, snapshot, tablePermissionIndex, filler, 3), /Primary Input/,
    'TABLE seeding does not authorize subsequent live edits through scalar ChangeSet permissions');
});

test('department identifiers from authenticated identity control view and write scope', () => {
  const departmentTag = tag({ denyEditForDepartments: ['planning'], maskedForDepartments: ['planning'] });
  const departmentIndex = compilePermissionIndex({ sheets: [{ ...workbook.sheets[0],
    cells: [{ row: 0, column: 0, tag: departmentTag }] }] });
  const departmentFiller = { ...filler, departmentCodes: ['planning'] };
  assert.deepEqual(identityFor(departmentFiller, 3).departments, ['planning']);
  assert.equal(permissionAt(departmentIndex.sheets[0], 0, 0, identityFor(departmentFiller, 3)).visibility, 'masked');
  assert.match(authorizeChangeSet({ ops: [edit(0, 0)] }, snapshot, departmentIndex, departmentFiller, 3), /Primary Input/);
});


test('unbound template cells grant only explicitly published input permissions', () => {
  const contract = structuredClone(workbook);
  contract.sheets[0].cells.push({ row: 3, column: 3, tag: tag({ platform: 'cost-report-cell-permission-v1', permission: 'primary_input', editableForRoles: ['subsidiary_filler'] }) });
  const compiled = compilePermissionIndex(contract);
  assert.equal(authorizeChangeSet({ ops: [edit(3, 3)] }, snapshot, compiled, filler, 3), null);
  assert.ok(authorizeChangeSet({ ops: [edit(3, 3)] }, snapshot, compiled, { roles: [{ code: 'department_reviewer', organizationId: 3 }] }, 3));
  contract.sheets[0].mappings.push({ row: 3, col: 3, rowCount: 1, colCount: 1, kind: 'calc', permission: 'system' });
  assert.ok(authorizeChangeSet({ ops: [edit(3, 3)] }, snapshot, compilePermissionIndex(contract), filler, 3));
  contract.sheets[0].mappings.pop();
  contract.sheets[0].cells.at(-1).tag = tag({ platform: 'cost-report-cell-permission-v1', permission: 'read_only', editableForRoles: ['subsidiary_filler'] });
  assert.ok(authorizeChangeSet({ ops: [edit(3, 3)] }, snapshot, compilePermissionIndex(contract), filler, 3));
});
