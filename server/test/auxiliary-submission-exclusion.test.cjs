const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'cost-aux-extraction-'));
Object.assign(process.env, { COST_REPORT_DB_PATH: path.join(root, 'business.db'), COST_REPORT_COLLAB_DB_PATH: path.join(root, 'collaboration.db'), COST_REPORT_TEMPLATE_DIR: path.join(root, 'templates') });
const { extractBusinessValues } = require('../src/services/businessSubmission');
const { compileSubmissionManifest } = require('../src/services/templatePublication');
const fixture = require('../../tests/fixtures/binding-protocol-19.2.json');
const clone = value => JSON.parse(JSON.stringify(value));
const mapping = (code, id, row) => ({ kind: 'input', fieldCode: code, fieldDefinitionId: id, bindingPath: code,
  row, col: 1, rowCount: 1, colCount: 1, primary: true, permission: 'primary_input' });

test('publication excludes auxiliary/readonly mappings while preserving all sheet positions', () => {
  const source = [
    { code: 'ref', name: '接口参考', type: 'auxiliary', mappings: [mapping('IGNORED', 999, 0)] },
    { code: 'input', name: '业务', type: 'business', mappings: [mapping('REVENUE', 1, 1)] },
    { code: 'fixed', name: '固定参考', readOnly: true, mappings: [mapping('IGNORED', 999, 0)] }
  ];
  const manifest = compileSubmissionManifest({ sheets: source });
  assert.deepEqual(manifest.sheets.map(sheet => sheet.order), [0, 1, 2]);
  assert.deepEqual(manifest.sheets.map(sheet => sheet.mappings.length), [0, 1, 0]);
  assert.equal(manifest.sheets[1].mappings[0].sheetIndex, 1);
});

test('new and legacy published templates extract bound business data only, even between mapped auxiliary sheets', () => {
  const workbook = { sheets: [
    { code: 'REF', name: '接口辅助', type: 'auxiliary', mappings: [mapping('IGNORED', 999, 0)] },
    { code: 'MAIN', name: '业务一', type: 'business', mappings: [mapping('REVENUE', 1, 1)] },
    { code: 'FIXED', name: '固定辅助', readOnly: true, mappings: [{ kind: 'table', namedArea: 'FIXED_TABLE_DATA', row: 0, col: 0, rowCount: 2, colCount: 1, datasetColumns: [{ fieldDefinitionId: 999, fieldCode: 'IGNORED' }] }] },
    { code: 'SECOND', name: '业务二', type: 'business', mappings: [mapping('COST', 2, 2)] }
  ] };
  const snapshot = clone(fixture.after);
  const original = Object.values(snapshot.sheets)[0];
  snapshot.sheets = Object.fromEntries(workbook.sheets.map((sheet, index) => [`s${index}`, {
    ...clone(original), name: sheet.name, order: index
  }]));
  // Stale cell display data must not replace values from the bound source (100.25 / 20).
  snapshot.sheets.s1.data.dataTable[1][1].value = 777;
  snapshot.sheets.s3.data.dataTable[2][1].value = 888;
  const fields = new Map([[1, { id: 1, code: 'REVENUE', data_type: 'decimal', precision: 2 }], [2, { id: 2, code: 'COST', data_type: 'decimal', precision: 2 }]]);
  const legacy = { version: 1, sheets: workbook.sheets.map((sheet, order) => ({ code: sheet.code, name: sheet.name, order, mappings: sheet.mappings })) };
  for (const submission of [compileSubmissionManifest(workbook), legacy]) {
    const values = extractBusinessValues({ manifest: { submission }, workbook, snapshot, fields, actorId: 41, collaborationVersion: 3 });
    assert.deepEqual(values.map(value => [value.sourceSheet, value.typedValue.value]), [['MAIN', '100.25'], ['SECOND', '20']]);
  }
});

test.after(async () => { const db = require('../src/config/database'); await db.ready; await new Promise(resolve => db.close(resolve)); await new Promise(resolve => db.collaborationDb.close(resolve)); });
