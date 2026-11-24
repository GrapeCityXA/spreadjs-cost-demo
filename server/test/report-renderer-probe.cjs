const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { inReportBrowser, renderReport } = require('../src/services/reportRenderer');
(async () => {
  const template = await inReportBrowser(async () => {
    const S = GC.Spread.Sheets;
    const book = new S.Workbook(document.getElementById('report'), { sheetCount: 0 });
    const report = book.addSheetTab(0, '定稿指标', S.SheetType.reportSheet);
    const t = report.getTemplate(); t.setRowCount(4); t.setColumnCount(3);
    ['组织', '指标', '数值'].forEach((v, c) => t.setValue(0, c, v));
    ['organizationName', 'fieldName', 'value'].forEach((key, c) => t.setTemplateCell(1, c, { type: 'List', binding: `ReportData[${key}]` }));
    return { schemaVersion: 1, sheets: [{ name: '定稿指标', json: t.toJSON() }] };
  }, undefined, 90000, true);
  const result = await renderReport({ template, rows: [{ organizationName: '湖北联通', fieldName: '任意指标', value: 100.25 }, { organizationName: '组织二', fieldName: '其他指标', value: 77 }], parameters: {}, sources: [] }, true);
  const cells = result.json.sheets['定稿指标'].data.dataTable;
  assert.equal(cells[1][2].value, 100.25); assert.equal(cells[2][2].value, 77);
  assert.equal(Buffer.from(result.pdf, 'base64').subarray(0, 4).toString(), '%PDF');
  assert.equal(Buffer.from(result.xlsx, 'base64').subarray(0, 2).toString(), 'PK');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cost-report-studio-probe-'));
  await fs.writeFile(path.join(dir, 'template.json'), JSON.stringify(template));
  await fs.writeFile(path.join(dir, 'output.json'), JSON.stringify(result.json));
  await fs.writeFile(path.join(dir, 'output.xlsx'), Buffer.from(result.xlsx, 'base64'));
  await fs.writeFile(path.join(dir, 'output.pdf'), Buffer.from(result.pdf, 'base64'));
  console.log(JSON.stringify({ pass: true, dir, templateKeys: Object.keys(template.sheets[0].json) }));
})().catch(e => { console.error(e); process.exitCode = 1; });
