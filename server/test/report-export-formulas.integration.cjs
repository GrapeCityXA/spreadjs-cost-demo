const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { inReportBrowser, renderReport } = require('../src/services/reportRenderer');

(async () => {
  const fixture = await inReportBrowser(async () => {
    const S = GC.Spread.Sheets;
    const book = new S.Workbook(document.getElementById('report'), { sheetCount: 0 });
    const report = book.addSheetTab(0, '汇总报表', S.SheetType.reportSheet);
    const t = report.getTemplate(); t.setRowCount(10); t.setColumnCount(5);
    t.setValue(0, 0, '公式及样式验证'); t.addSpan(0, 0, 1, 3);
    t.setTemplateCell(1, 0, { type: 'List', binding: 'ReportData[value]' });
    t.setFormula(2, 0, 'SUM(A2)'); // Must expand to SUM(A2:A3) and remain editable.
    t.setValue(4, 0, 10); t.setValue(4, 1, 20); t.setFormula(4, 2, 'A5+B5');
    t.setColumnWidth(0, 180); t.setRowHeight(0, 36);
    t.getRange(0, 0, 1, 3).backColor('#123456').foreColor('#ffffff');
    const template = { schemaVersion: 1, sheets: [{ name: report.name(), json: t.toJSON() }] };
    const sources = [];
    for (const [index, color] of ['#ff0000', '#0000ff'].entries()) {
      const source = new S.Workbook(document.createElement('div'));
      const base = new S.Style(); base.name = 'Base'; base.backColor = color; base.font = 'bold 14px Arial'; source.addNamedStyle(base);
      const child = new S.Style(); child.name = 'Amount'; child.parentName = 'Base'; child.formatter = '#,##0.00'; source.addNamedStyle(child);
      const sheet = source.getActiveSheet(); sheet.name('来源'); sheet.setRowCount(5); sheet.setColumnCount(4);
      sheet.setValue(0, 0, 1234.5); sheet.setStyleName(0, 0, 'Amount');
      sheet.addSpan(2, 0, 1, 2); sheet.setColumnWidth(0, 170); sheet.setRowHeight(0, 33);
      const local = new S.Style(); local.name = 'Local'; local.foreColor = '#008800'; sheet.addNamedStyle(local);
      sheet.setValue(1, 0, '局部样式'); sheet.setStyleName(1, 0, 'Local');
      const json = source.toJSON();
      sources.push({ name: `组织${index + 1}`, json: json.sheets['来源'], workbookStyles: json.namedStyles });
      source.destroy();
    }
    book.destroy(); return { template, rows: [{ value: 100.25 }, { value: 200.5 }], sources, parameters: {} };
  });
  const result = await renderReport(fixture);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-formula-style-'));
  await fs.writeFile(path.join(dir, 'output.json'), JSON.stringify(result.json));
  await fs.writeFile(path.join(dir, 'output.xlsx'), Buffer.from(result.xlsx, 'base64'));
  await fs.writeFile(path.join(dir, 'output.pdf'), Buffer.from(result.pdf, 'base64'));
  console.log('Evidence:', dir);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(result.xlsx, 'base64'));
  const report = wb.getWorksheet('汇总报表');
  const formulas = []; report.eachRow(row => row.eachCell(cell => { if (cell.formula) formulas.push({ address: cell.address, formula: cell.formula, result: cell.result }); }));
  assert.ok(formulas.some(c => /SUM\(A2:A3\)/i.test(c.formula)), JSON.stringify(formulas));
  assert.ok(formulas.some(c => c.result === 30 && /\+/.test(c.formula)), JSON.stringify(formulas));
  assert.ok(formulas.some(c => c.result === 300.75), JSON.stringify(formulas));
  for (const [index, rgb] of ['FFFF0000', 'FF0000FF'].entries()) {
    const sheet = wb.getWorksheet(`组织${index + 1}`);
    assert.equal(sheet.getCell('A1').value, 1234.5);
    assert.equal(sheet.getCell('A1').fill.fgColor.argb.toUpperCase(), rgb);
    assert.equal(sheet.getCell('A1').numFmt, '#,##0.00');
    assert.equal(sheet.getCell('A1').font.bold, true);
    assert.equal(sheet.getCell('A2').font.color.argb.toUpperCase(), 'FF008800');
    assert.equal(sheet.getCell('B3').master.address, 'A3');
  }
  const preview = await inReportBrowser(async ({ json }) => {
    const book = new GC.Spread.Sheets.Workbook(document.getElementById('report'));
    book.fromJSON(json);
    book.options.calculationMode = GC.Spread.Sheets.CalculationMode.auto;
    const results = book.sheets.map(sheet => ({ name: sheet.name(), backColor: sheet.getActualStyle(0, 0).backColor }));
    const sheet = book.getSheetFromName('汇总报表');
    // Locate the ordinary formula after ReportSheet has expanded its template rows.
    let cell;
    for (let r = 0; r < sheet.getRowCount(); r++) if ((sheet.getFormula(r, 2) || '').includes('+')) cell = r;
    const before = sheet.getValue(cell, 2); sheet.setValue(cell, 0, 50);
    const after = sheet.getValue(cell, 2);
    book.destroy(); return { results, before, after };
  }, { json: result.json });
  assert.equal(preview.before, 30); assert.equal(preview.after, 70);
  assert.equal(preview.results[1].backColor.toLowerCase(), '#ff0000');
  assert.equal(preview.results[2].backColor.toLowerCase(), '#0000ff');
  console.log('PASS: native XLSX roundtrip retains expanded SUM and recalculable formulas; workbook-scoped inherited and conflicting styles survive preview and Excel; merged cells preserved.');
})().catch(error => { console.error(error); process.exitCode = 1; });
