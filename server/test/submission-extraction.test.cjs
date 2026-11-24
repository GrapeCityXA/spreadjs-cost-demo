const test = require('node:test');
const assert = require('node:assert/strict');
const { extractBusinessValues, validateUserFormula } = require('../src/services/businessSubmission');

test('precheck calculates native revenue formulas and reports division errors', async () => {
  await require('../src/config/database').ready;
  const { buildMonthlyFillingSummary } = require('../src/services/monthlyFillingSummary');
  const snapshot = { v: 2, data: { sheets: { s: { name: 'Sheet1', order: 0, rowCount: 10, columnCount: 10,
    data: { dataTable: { 0: { 0: { formulaInfo: { refs: {}, parts: [{ text: '1+2' }] } } } } } } } } };
  const input = { task: { id: 0, periodCode: '2026-10', configuration: {} }, organization: {}, manifest: {}, snapshot, roomVersion: 2,
    workbook: { sheets: [{ name: 'Sheet1', mappings: [{ kind: 'input', fieldCode: 'REVENUE', row: 0, col: 0,
      primary: true, permission: 'primary_input', required: true, dataType: 'decimal' }] }] } };
  const valid = await buildMonthlyFillingSummary(input);
  assert.equal(valid.calculations.currentMonth.revenue, 3);
  assert.equal(valid.precheck.blockingCount, 0);
  snapshot.data.sheets.s.data.dataTable[0][0].formulaInfo.parts[0].text = '1/0';
  const invalid = await buildMonthlyFillingSummary(input);
  assert.ok(invalid.precheck.blocking.some(item => item.code === 'user_formula_error'));
});

test('native collaborative formulas extract calculated values without trusting a stale cached value', () => {
  const manifest = { submission: { version: 1, sheets: [{ code: 'MAIN', name: 'Sheet1', order: 0, mappings: [
    { kind: 'input', namedArea: 'MAIN_INPUT_AMOUNT', row: 0, col: 0, rowCount: 1, colCount: 1,
      fieldDefinitionId: 1, fieldCode: 'AMOUNT', primary: true, permission: 'primary_input' }
  ] }] } };
  const snapshot = { sheets: { s: { name: 'Sheet1', order: 0, rowCount: 10, columnCount: 10,
    data: { dataTable: { 0: { 0: { value: 999, formulaInfo: { refs: {}, parts: [{ text: '1+2' }] } } } } } } } };
  const values = extractBusinessValues({ manifest, workbook: { sheets: [{ name: 'Sheet1' }] }, snapshot,
    fields: new Map([[1, { id: 1, code: 'AMOUNT', data_type: 'decimal', precision: 2 }]]), actorId: 1, collaborationVersion: 2 });
  assert.deepEqual(values[0].typedValue, { type: 'decimal', value: '3' });
  assert.equal(values[0].sourceFormula, '1+2');
  snapshot.sheets.s.data.dataTable[0][0].formulaInfo.parts[0].text = '1/0';
  assert.throws(() => extractBusinessValues({ manifest, workbook: { sheets: [{ name: 'Sheet1' }] }, snapshot,
    fields: new Map([[1, { id: 1, code: 'AMOUNT', data_type: 'decimal', precision: 2 }]]), actorId: 1, collaborationVersion: 2 }), /计算错误/);
});

test('extracts INPUT and fixed TABLE values from the published named-area manifest', () => {
  const manifest = { submission: { version: 1, sheets: [{
    code: 'SUMMARY', name: '汇总', mappings: [
      { kind: 'input', namedArea: 'SUMMARY_BODY_INPUT_REVENUE', row: 1, col: 2, rowCount: 1, colCount: 1,
        fieldDefinitionId: 7, fieldCode: 'REVENUE', primary: true, permission: 'primary_input' },
      { kind: 'table', namedArea: 'SUMMARY_BODY_TABLE_COSTS', row: 4, col: 0, rowCount: 3, colCount: 2,
        datasetColumns: [
          { fieldDefinitionId: 8, fieldCode: 'COST_CODE' },
          { fieldDefinitionId: 9, fieldCode: 'COST_AMOUNT' }
        ] }
    ]
  }] } };
  const workbook = { sheets: [{ name: '汇总', cells: [] }] };
  const snapshot = { data: { sheets: { sheet1: {
    name: '汇总', order: 0, data: { dataTable: {
      1: { 2: { value: '12345678901234567890.12' } },
      5: { 0: { value: 'TRAVEL' }, 1: { value: '10.25' } },
      6: { 0: { value: 'RENT' }, 1: { value: 0 } }
    } }
  } } } };
  const fields = new Map([
    [7, { id: 7, code: 'REVENUE', semantic_type: 'decimal', unit: '万元', precision: 2 }],
    [8, { id: 8, code: 'COST_CODE', semantic_type: 'short_text', unit: null, precision: 0 }],
    [9, { id: 9, code: 'COST_AMOUNT', semantic_type: 'decimal', unit: '元', precision: 2 }]
  ]);

  const values = extractBusinessValues({ manifest, workbook, snapshot, fields, actorId: 41, collaborationVersion: 12 });

  assert.deepEqual(values.map(({ recordKey, fieldDefinitionId, typedValue, sourceFormula, sourceNamedArea, sourceRow, sourceColumn }) => ({
    recordKey, fieldDefinitionId, typedValue, sourceFormula, sourceNamedArea, sourceRow, sourceColumn
  })), [
    { recordKey: '', fieldDefinitionId: 7, typedValue: { type: 'decimal', value: '12345678901234567890.12' }, sourceFormula: null,
      sourceNamedArea: 'SUMMARY_BODY_INPUT_REVENUE', sourceRow: 1, sourceColumn: 2 },
    { recordKey: 'SUMMARY_BODY_TABLE_COSTS:row:6', fieldDefinitionId: 8, typedValue: { type: 'text', value: 'TRAVEL' }, sourceFormula: null,
      sourceNamedArea: 'SUMMARY_BODY_TABLE_COSTS', sourceRow: 5, sourceColumn: 0 },
    { recordKey: 'SUMMARY_BODY_TABLE_COSTS:row:6', fieldDefinitionId: 9, typedValue: { type: 'decimal', value: '10.25' }, sourceFormula: null,
      sourceNamedArea: 'SUMMARY_BODY_TABLE_COSTS', sourceRow: 5, sourceColumn: 1 },
    { recordKey: 'SUMMARY_BODY_TABLE_COSTS:row:7', fieldDefinitionId: 8, typedValue: { type: 'text', value: 'RENT' }, sourceFormula: null,
      sourceNamedArea: 'SUMMARY_BODY_TABLE_COSTS', sourceRow: 6, sourceColumn: 0 },
    { recordKey: 'SUMMARY_BODY_TABLE_COSTS:row:7', fieldDefinitionId: 9, typedValue: { type: 'decimal', value: '0' }, sourceFormula: null,
      sourceNamedArea: 'SUMMARY_BODY_TABLE_COSTS', sourceRow: 6, sourceColumn: 1 }
  ]);
  assert.equal(values[0].unitSnapshot, '万元');
  assert.equal(values[0].precisionSnapshot, 2);
});

test('quarterly fixed table rows persist the configured stable qualitative record keys', () => {
  const manifest = { submission: { version: 1, sheets: [{ code: 'SCORE', name: '评分表', mappings: [{
    kind: 'table', namedArea: 'QUARTERLY_TABLE_KEY_BUSINESS', row: 0, col: 0, rowCount: 3, colCount: 1,
    datasetColumns: [{ fieldDefinitionId: 17, fieldCode: 'QUALITATIVE_CONTENT' }]
  }] }] } };
  const workbook = { sheets: [{ name: '评分表', cells: [] }] };
  const snapshot = { data: { sheets: { sheet1: { name: '评分表', order: 0, data: { dataTable: {
    1: { 0: { value: '完成客户扩面' } }, 2: { 0: { value: '推进重点项目' } }
  } } } } } };
  const fields = new Map([[17, { id: 17, code: 'QUALITATIVE_CONTENT', semantic_type: 'long_text', unit: null, precision: 0 }]]);
  const configuration = { indicators: [
    { code: 'BIZ_01', category: 'key_business', namedArea: 'QUARTERLY_TABLE_KEY_BUSINESS', recordKey: 'quarterly:key_business:BIZ_01' },
    { code: 'BIZ_02', category: 'key_business', namedArea: 'QUARTERLY_TABLE_KEY_BUSINESS', recordKey: 'quarterly:key_business:BIZ_02' }
  ] };
  const values = extractBusinessValues({ manifest, workbook, snapshot, fields, actorId: 41, collaborationVersion: 3, configuration });
  assert.deepEqual(values.map(item => item.recordKey), ['quarterly:key_business:BIZ_01', 'quarterly:key_business:BIZ_02']);
});

test('validates user formulas against same-sheet authorized cells and safe functions', () => {
  const context = { sheetIndex: 0, row: 3, col: 3, allowedCells: new Set(['0:0:0', '0:0:1']),
    allowedNames: new Set(['SUMMARY_BODY_INPUT_AMOUNT']), sheetIndices: new Map([['other sheet', 1]]), formulaCells: new Map() };
  assert.equal(validateUserFormula('=SUM(A1)+1', context).references[0], '0:0:0');
  assert.deepEqual(validateUserFormula('=SUM(A1:B2)', { ...context,
    allowedCells: new Set(['0:0:0', '0:0:1', '0:1:0', '0:1:1']) }).references,
  ['0:0:0', '0:0:1', '0:1:0', '0:1:1']);
  assert.throws(() => validateUserFormula('=SUM(A1:A3)', { ...context,
    allowedCells: new Set(['0:0:0', '0:0:1', '0:2:0']) }), /未授权/);
  assert.equal(validateUserFormula("=SUM('Other Sheet'!A1)", { ...context,
    allowedCells: new Set([...context.allowedCells, '1:0:0']) }).references[0], '1:0:0');
  assert.throws(() => validateUserFormula('=NOW()', context), /未获授权/);
  assert.throws(() => validateUserFormula('=[budget.xlsx]Sheet1!A1', context), /外部引用/);
  assert.throws(() => validateUserFormula('=C9+1', context), /未授权/);
  assert.throws(() => validateUserFormula('=OTHER_NAMED_AREA+1', context), /未获授权/);
  assert.throws(() => validateUserFormula('=B1+1', { ...context, row: 0, col: 1 }), /循环引用/);
});
