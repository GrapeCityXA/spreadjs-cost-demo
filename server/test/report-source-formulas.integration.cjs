const assert = require('node:assert/strict');
const { inReportBrowser, renderReport } = require('../src/services/reportRenderer');
const ExcelJS = require('exceljs');

(async () => {
  const fixture = await inReportBrowser(() => {
    const S = GC.Spread.Sheets;
    const report = new S.Workbook(document.getElementById('report'), { sheetCount: 0 });
    const template = report.addSheetTab(0, '汇总', S.SheetType.reportSheet).getTemplate();
    template.setRowCount(5); template.setColumnCount(5); template.setValue(0, 0, '定稿汇总');
    const sources = [], sourceWorkbooks = [];
    for (let id = 1; id <= 2; id++) {
      const book = new S.Workbook(document.createElement('div'), { sheetCount: 3 });
      const [main, detail, unused] = book.sheets;
      main.name("业务'数据"); detail.name('辅助 明细'); unused.name('无关辅助');
      for (const sheet of book.sheets) { sheet.setRowCount(10); sheet.setColumnCount(6); }
      detail.setValue(0, 0, id * 10); unused.setValue(0, 0, '不应进入成果');
      book.addCustomName('SharedAmount', "'辅助 明细'!$A$1", 0, 0);
      main.setFormula(0, 0, "'辅助 明细'!A1*2");
      main.setFormula(0, 1, 'SharedAmount+1');
      main.setFormula(0, 2, 'SUM(A1:B1)');
      main.setFormula(1, 0, '0'); main.setFormula(1, 1, 'FALSE()');
      main.setFormula(1, 2, '"辅助 明细!A1 is text"');
      detail.tables.add('Sales', 0, 2, 3, 1);
      detail.setValue(0, 2, 'value'); detail.setValue(1, 2, id * 3); detail.setValue(2, 2, id * 4);
      main.setFormula(0, 3, 'SUM(Sales[value])');
      // A stored result need not equal a later recalculation: preserve it exactly.
      main.setFormula(2, 0, '1+1');
      book.collaboration.registerCollaborationType(type);
      const workbook = id === 1 ? book.collaboration.toSnapshot() : book.toJSON();
      Object.values(workbook.sheets).find(s => s.name === main.name()).data.dataTable[2][0].value = 123.45;
      sources.push({ revisionId: id, sheetName: main.name(), name: '汇总' }); // also test output-name collision
      sourceWorkbooks.push({ revisionId: id, workbook }); book.destroy();
    }
    const result = { template: { schemaVersion: 1, sheets: [{ name: '汇总', json: template.toJSON() }] }, rows: [], parameters: {}, sources, sourceWorkbooks };
    report.destroy(); return result;
  });
  const original = JSON.stringify(fixture);
  const result = await renderReport(fixture);
  assert.equal(JSON.stringify(fixture), original, 'immutable source snapshot');
  const provenance = result.json.reportSourceFormulas;
  assert.equal(provenance.sheets.length, 4);
  assert.equal(provenance.sheets.filter(s => s.dependencyOnly).length, 2);
  assert.ok(!Object.values(result.json.sheets).some(s => s.name.includes('无关辅助')));
  const excel = new ExcelJS.Workbook(); await excel.xlsx.load(Buffer.from(result.xlsx, 'base64'));
  for (const source of provenance.sheets.filter(s => !s.dependencyOnly)) {
    const dependency = provenance.sheets.find(s => s.revisionId === source.revisionId && s.dependencyOnly);
    const sheet = result.json.sheets[source.name], cells = sheet.data.dataTable;
    assert.ok(cells[0][0].formula.includes(dependency.name), cells[0][0].formula);
    assert.equal(cells[0][0].value, source.revisionId * 20);
    assert.equal(cells[0][1].value, source.revisionId * 10 + 1);
    assert.equal(cells[0][3].value, source.revisionId * 7);
    assert.match(cells[0][3].formula, /SUM\(Source_\d+_\d+\[value\]\)/);
    assert.equal(cells[2][0].formula, '1+1'); assert.equal(cells[2][0].value, 123.45);
    assert.equal(cells[1][0].value, 0); assert.equal(cells[1][1].value, false);
    assert.equal(cells[1][2].formula, '"辅助 明细!A1 is text"');
    assert.ok(sheet.names.find(n => n.name === 'SharedAmount').formula.includes(dependency.name));
    assert.equal(excel.getWorksheet(source.name).getCell('A3').formula, '1+1');
    assert.equal(excel.getWorksheet(source.name).getCell('A3').result, 123.45);
  }
  const preview = await inReportBrowser(({ json, provenance }) => {
    const book = new GC.Spread.Sheets.Workbook(document.getElementById('report'));
    book.fromJSON(json, { doNotRecalculateAfterLoad: true });
    const results = provenance.sheets.filter(s => !s.dependencyOnly).map(source => {
      const sheet = book.getSheetFromName(source.name);
      return { revisionId: source.revisionId, formula: sheet.getFormula(0, 0), cached: sheet.getValue(2, 0),
        precedents: sheet.getPrecedents(0, 0), namedPrecedents: sheet.getPrecedents(0, 1) };
    });
    book.destroy(); return results;
  }, { json: result.json, provenance });
  for (const actual of preview) {
    const name = provenance.sheets.find(s => s.revisionId === actual.revisionId && s.dependencyOnly).name;
    assert.equal(actual.cached, 123.45);
    assert.ok(actual.precedents.some(r => r.sheetName === name));
    assert.ok(actual.namedPrecedents.some(r => r.sheetName === name));
  }
  console.log('PASS native snapshot + SSJSON formulas, cross-sheet and named references, organization isolation, required auxiliary snapshots, frozen values, XLSX and preview dependencies.');
})().catch(error => { console.error(error); process.exitCode = 1; });
