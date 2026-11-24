const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeNativeFormula, createSnapshotReader } = require('../src/services/nativeUserFormula');
const { authorizeChangeSet } = require('../src/services/changeSetAuthorization');
const { quarterlyTemplateCompatibility } = require('../src/services/quarterlyTemplateCompatibility');
const info = text => ({ refs: {}, parts: [{ text }] });
const snapshot = () => ({ sheets: { s: { name: 'Sheet1', order: 0, rowCount: 20, columnCount: 10,
  data: { dataTable: { 0: { 0: { value: 2 }, 1: { value: 3 } } } } } } });
const range = { refs: { R0: { type: 0, row: 0, col: 0, endRow: 0, endCol: 1, flags: 30 } },
  parts: [{ text: 'SUM(' }, { ref: 'R0' }, { text: ')*2' }] };

test('native formulas read authoritative values without cached values; stale values are ignored', () => {
  for (const [formula, expected] of [['1+2', 3], ['2+3*4', 14], ['(2+3)*4', 20], ['ROUND(-1.25,1)', -1.3]]) {
    const data = snapshot(); data.sheets.s.data.dataTable[1] = { 0: { value: 999, formulaInfo: info(formula) } };
    assert.deepEqual(createSnapshotReader(data).read('s', 1, 0), { value: expected, formula });
  }
  const data = snapshot(); data.sheets.s.data.dataTable[1] = { 0: { formulaInfo: range } };
  assert.deepEqual(createSnapshotReader(data).read('s', 1, 0), { formula: 'SUM(A1:B1)*2', value: 10 });
});

test('IFERROR returns its fallback for calculation errors', () => {
  const data = snapshot();
  data.sheets.s.data.dataTable[1] = { 0: { formulaInfo: info('IFERROR(1/0,"")') } };
  assert.deepEqual(createSnapshotReader(data).read('s', 1, 0), { formula: 'IFERROR(1/0,"")', value: '' });
  const sum = snapshot();
  sum.sheets.s.data.dataTable[1] = { 0: { formulaInfo: { refs: range.refs,
    parts: [{ text: 'IFERROR(SUM(' }, { ref: 'R0' }, { text: '),0)' }] } } };
  assert.deepEqual(createSnapshotReader(sum).read('s', 1, 0), { formula: 'IFERROR(SUM(A1:B1),0)', value: 5 });
  assert.throws(() => decodeNativeFormula(info('IFERROR(1)'), snapshot(), 's'));
});

test('formula-bound cells evaluate the formula before reading the binding cache', () => {
  const data = snapshot();
  data.dataManager = { tables: { reportData: { name: 'reportData', dataSourceOption: { data: [{ REVENUE: 0 }] } } } };
  data.sheets.s.bindingManager = { type: 'cellBinding', tableId: 'reportData', activeRecordIndex: 0 };
  data.sheets.s.data.dataTable[1] = {};
  data.sheets.s.data.dataTable[1][0] = {
    bindingPath: 'REVENUE', value: 0,
    formulaInfo: { refs: { R0: { type: 0, row: 0, col: 0, endRow: 0, endCol: 1, flags: 30 } }, parts: [{ text: 'SUM(' }, { ref: 'R0' }, { text: ')' }] }
  };
  assert.deepEqual(createSnapshotReader(data).read('s', 1, 0), { formula: 'SUM(A1:B1)', value: 5 });
});

test('malformed, external, unknown and oversized native formulas fail closed', () => {
  for (const value of [null, {}, info('WEBSERVICE("https://example.org")'), info('1+'), info('1;2'),
    { ...info('1'), extra: true }, { refs: {}, parts: [{ ref: 'missing' }] },
    { ...range, refs: { R0: { ...range.refs.R0, sheetId: 'unknown' } } },
    { ...range, refs: { R0: { ...range.refs.R0, endCol: 99999 } } }]) {
    assert.throws(() => decodeNativeFormula(value, snapshot(), 's'));
  }
  const data = snapshot(); data.sheets.s.data.dataTable[1] = { 0: { formulaInfo: info('1/0') } };
  assert.throws(() => createSnapshotReader(data).read('s', 1, 0), /计算错误/);
  data.sheets.s.data.dataTable[0][0] = { formulaInfo: { refs: { R0: { type: 0, row: 0, col: 0, flags: 0 } }, parts: [{ ref: 'R0' }] } };
  assert.throws(() => createSnapshotReader(data).read('s', 0, 0), /循环/);
});

test('native formula authorization preserves input, reference, array and structure guards', () => {
  const data = snapshot();
  const index = { version: 1, sheets: [{ name: 'Sheet1', rowCount: 20, columnCount: 10, rowTags: [], columnTags: [], cellTags: [],
    editableRanges: [{ row: 0, col: 0, rowCount: 4, colCount: 2, roles: ['subsidiary_filler'] }] }] };
  const user = { roles: [{ code: 'subsidiary_filler', organizationId: 1 }] };
  const op = { type: 28, module: 'worksheet', sheetId: 's', target: { row: 1, col: 0, rowCount: 1, colCount: 1, sheetArea: 3 }, payload: { rangeData: { formula: { formulaInfo: range } } } };
  const auth = value => authorizeChangeSet({ ops: [value] }, data, index, user, 1);
  assert.equal(auth(op), null);
  const clear = structuredClone(op); clear.payload.rangeData.formula = { formulaInfo: null }; assert.equal(auth(clear), null);
  const altered = structuredClone(op); altered.payload.rangeData.formula.formulaInfo.refs.R0.col = 2; altered.payload.rangeData.formula.formulaInfo.refs.R0.endCol = 3;
  assert.match(auth(altered), /未授权/);
  for (const property of ['isArrayFormula', 'isDynamicArray', 'baseRange']) {
    const invalid = structuredClone(op); invalid.payload.rangeData.formula[property] = true; assert.ok(auth(invalid));
  }
  const hidden = structuredClone(op); hidden.target.col = 5; assert.ok(auth(hidden));
  const multiple = structuredClone(op); multiple.target.rowCount = 2; assert.ok(auth(multiple));
  const empty = structuredClone(op); empty.payload.rangeData.formula = null; assert.ok(auth(empty));
});

test('quarterly compatibility reports understandable conflicts and keeps financial read-only rule', () => {
  const mapping = { fieldCode: 'REVENUE', displayName: '本期营收', namedArea: 'MAIN_INPUT_REVENUE', primary: true, permission: 'primary_input' };
  const check = permission => quarterlyTemplateCompatibility({ sheets: [{ name: '财务', mappings: [{ ...mapping, permission }] }] });
  assert.equal(check('primary_input').compatible, false);
  assert.deepEqual(check('primary_input').conflicts[0], { sheetName: '财务', fieldName: '本期营收', namedArea: 'MAIN_INPUT_REVENUE' });
  assert.equal(check('readonly').compatible, true);
});
