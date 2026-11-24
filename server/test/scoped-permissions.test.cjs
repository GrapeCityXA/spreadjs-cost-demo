const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { compilePermissionIndex, permissionAt, normalizedTag, parseTag } = require('../src/services/permissionIndex');
const { authorizeChangeSet } = require('../src/services/changeSetAuthorization');
const rule = (dimension, values, excludedVisibility = 'hidden') => ({ allVisible: false, dimension,
  [({ user: 'visibleUsers', role: 'visibleRoles', department: 'visibleDepartments' })[dimension]]: values, excludedVisibility });
const tag = normalizedTag;
const identity = { userId: 3, roles: ['subsidiary_filler'], departments: ['FIN'] };
const sheet = (overrides = {}) => ({ code: 'main', name: '主表', rowCount: 5, columnCount: 5, cells: [], mappings: [], ...overrides });

test('four permission levels intersect across user, role and department, in frontend/backend parity', async () => {
  const { cellPermission } = await import(pathToFileURL(path.resolve(__dirname, '../../src/template/permissionView.js')));
  const definition = sheet({ tag: tag({ ...rule('user', [3]), permission: 'primary_input', editableForRoles: ['subsidiary_filler'] }),
    rowTags: [{ row: 1, tag: tag(rule('department', ['OTHER'])) }],
    columnTags: [{ col: 2, tag: tag(rule('role', ['management'])) }],
    cells: [{ row: 3, column: 3, tag: tag(rule('user', [4], 'masked')) }] });
  const index = compilePermissionIndex({ sheets: [definition] });
  for (const user of [identity, { ...identity, userId: 4 }, { ...identity, departments: ['OTHER'] }]) {
    for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) assert.deepEqual(cellPermission(index.sheets[0], row, col, user), permissionAt(index.sheets[0], row, col, user));
  }
  assert.deepEqual(permissionAt(index.sheets[0], 0, 0, identity), { visibility: 'visible', editable: true });
  assert.deepEqual(permissionAt(index.sheets[0], 1, 0, identity), { visibility: 'hidden', editable: false });
  assert.deepEqual(permissionAt(index.sheets[0], 0, 2, identity), { visibility: 'hidden', editable: false });
  assert.deepEqual(permissionAt(index.sheets[0], 3, 3, identity), { visibility: 'masked', editable: false });
  const edit = (row, col) => ({ type: 28, module: 'worksheet', sheetId: 'a', target: { row, col, rowCount: 1, colCount: 1, sheetArea: 3 }, payload: { rangeData: { value: 100.25 } } });
  const snapshot = { sheets: { a: { name: '主表', order: 0 } } };
  const user = { id: 3, departmentCodes: ['FIN'], roles: [{ code: 'subsidiary_filler', organizationId: 1 }] };
  assert.equal(authorizeChangeSet({ ops: [edit(0, 0)] }, snapshot, index, user, 1), null);
  for (const [row, col] of [[1, 0], [0, 2], [3, 3]]) assert.ok(authorizeChangeSet({ ops: [edit(row, col)] }, snapshot, index, user, 1));
});

test('row and column grants include unbound cells, but never override restrictions or calculations', () => {
  const grant = tag({ permission: 'primary_input', editableForRoles: ['subsidiary_filler'] });
  const index = compilePermissionIndex({ sheets: [sheet({ rowTags: [{ row: 1, tag: grant }], columnTags: [{ col: 2, tag: grant }],
    cells: [{ row: 1, column: 1, formula: '=1+1' }, { row: 1, column: 2, tag: tag({ permission: 'read_only' }) }],
    mappings: [{ row: 1, col: 3, rowCount: 1, colCount: 1, kind: 'calc', permission: 'system', primary: false }] })] }).sheets[0];
  assert.equal(permissionAt(index, 1, 0, identity).editable, true);
  assert.equal(permissionAt(index, 0, 2, identity).editable, true);
  for (const [row, col] of [[0, 0], [1, 1], [1, 2], [1, 3]]) assert.equal(permissionAt(index, row, col, identity).editable, false);
});

test('malformed audience rules fail publication instead of becoming public', () => {
  for (const value of [{ allVisible: 'false' }, { allVisible: false }, { visibleUsers: ['3'] }, { visibleRoles: [3] }, { excludedVisibility: 'unknown' }]) assert.throws(() => parseTag(tag(value), '测试'));
});

test('broad grants preserve fixed-table headers and unused record capacity', () => {
  const index = compilePermissionIndex({ sheets: [sheet({ tag: tag({ permission: 'primary_input', editableForRoles: ['subsidiary_filler'] }),
    cells: [{ row: 1, column: 0, tag: tag({ recordKey: 'first' }) }],
    mappings: [{ row: 0, col: 0, rowCount: 4, colCount: 2, kind: 'table', permission: 'primary_input', primary: true }] })] }).sheets[0];
  assert.equal(permissionAt(index, 1, 1, identity).editable, true);
  for (const row of [0, 2, 3]) assert.equal(permissionAt(index, row, 1, identity).editable, false);
});

test('filling hides restricted axes and masks the last sheet if every sheet is restricted', async () => {
  const { applyPermissionView } = await import(pathToFileURL(path.resolve(__dirname, '../../src/template/permissionView.js')));
  const calls = [], cells = new Map();
  const native = { visible: value => calls.push(['sheet', value]), setRowVisible: (row, value) => calls.push(['row', row, value]),
    setColumnVisible: (col, value) => calls.push(['col', col, value]), getStyle: () => null,
    getCell: (row, col) => ({ backColor: () => {}, locked: value => cells.set(`${row},${col}`, value) }),
    setFormatter: (row, col, value) => calls.push(['mask', row, col, value.format(123456)]) };
  const workbook = { getSheetCount: () => 1, getSheet: () => native };
  const index = compilePermissionIndex({ sheets: [sheet({ tag: tag(rule('user', [4])), rowTags: [{ row: 1, tag: tag(rule('role', ['management'])) }], columnTags: [{ col: 2, tag: tag(rule('department', ['OTHER'])) }] })] });
  applyPermissionView(workbook, index, identity, true);
  assert.ok(!calls.some(call => call[0] === 'sheet'), 'retain a safe masked worksheet when none is visible');
  assert.ok(calls.some(call => call[0] === 'row' && call[1] === 1 && call[2] === false));
  assert.ok(calls.some(call => call[0] === 'col' && call[1] === 2 && call[2] === false));
  assert.equal(cells.size, 25);
  assert.ok([...cells.values()].every(Boolean));
  assert.ok(calls.filter(call => call[0] === 'mask').every(call => call[3] === '••••'));
});

test('multi-selection expands every selected row/column/cell and deduplicates overlaps', async () => {
  const { permissionTargets } = await import(pathToFileURL(path.resolve(__dirname, '../../src/template/permissionRules.js')));
  const native = { getSelections: () => [{ row: 1, col: 2, rowCount: 2, colCount: 2 }, { row: 2, col: 3, rowCount: 1, colCount: 1 }], getRowCount: () => 5, getColumnCount: () => 5 };
  assert.equal(permissionTargets(native, 'row').length, 2);
  assert.equal(permissionTargets(native, 'column').length, 2);
  assert.equal(permissionTargets(native, 'cell').length, 4);
  assert.deepEqual(permissionTargets(native, 'sheet'), [{ row: -1, col: -1 }]);
});
