const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inReportBrowser } = require('../src/services/reportRenderer');
const source = name => fs.readFileSync(path.resolve(__dirname, '../../src/template', name), 'utf8').replace(/^import .*$/gm, '').replace(/export /g, '');

(async () => {
  const result = await inReportBrowser(async payload => {
    const { loadTemplateWorkbook, auxiliaryStructureJSON } = new Function('registerTemplateFunctions', `${payload.binding}\n${payload.loader}\nreturn {loadTemplateWorkbook, auxiliaryStructureJSON}`)(async () => {});
    const S = GC.Spread.Sheets, book = new S.Workbook(document.getElementById('report'));
    const format = '=IMAGE(@,"手写签名",0)';
    const contract = {
      designerSettings: { version: '19.2.0', activeSheetIndex: 1, sheetCount: 2, sheetTabCount: 0,
        formatStringNames: [{ name: format, formula: 'IMAGE(C10,"手写签名",0)', row: 9, col: 2 }] },
      sheets: [
        { name: '辅助数据表', code: 'aux', type: 'auxiliary', rowCount: 20, columnCount: 10,
          dataBinding: { url: 'http://127.0.0.1/report-data/AuxiliaryFixture', dataPath: '' } },
        { name: '填报页', code: 'main', type: 'business', rowCount: 20, columnCount: 12,
          designerJson: { name: '填报页', rowCount: 20, columnCount: 12, data: { dataTable: {
            0: { 0: { value: '已有填报内容' }, 1: { value: 25 }, 2: { formula: 'B1*2' } },
            9: { 2: { style: { formatter: format } } },
          } } } },
      ],
    };
    const original = JSON.stringify(contract), errors = [];
    await loadTemplateWorkbook(book, contract, { onRemoteError: message => errors.push(message) });
    const saved = auxiliaryStructureJSON(book);
    const first = { errors, reference: book.getSheet(0).getValue(1, 1), business: book.getSheet(1).getValue(0, 0), formula: book.getSheet(1).getFormula(0, 2), formatter: book.getSheet(1).getFormatter(9, 2), saved, unchanged: original === JSON.stringify(contract) };
    // Full native JSON is the second reopen path after saving from Designer.
    const reopened = new S.Workbook(document.createElement('div'));
    await loadTemplateWorkbook(reopened, { ...contract, designerJson: saved }, { onRemoteError: message => errors.push(message) });
    first.reopenedReference = reopened.getSheet(0).getValue(1, 1);
    first.reopenedBusiness = reopened.getSheet(1).getValue(0, 0);
    first.reopenedFormatter = reopened.getSheet(1).getFormatter(9, 2);
    book.destroy(); reopened.destroy();
    return first;
  }, { binding: source('auxiliaryDataBinding.js'), loader: source('composedTemplateWorkbook.js'),
    tables: [{ name: 'AuxiliaryFixture', rows: [{ code: 'A', amount: 123 }, { code: 'B', amount: 456 }] }] }, 90000, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.reference, 123);
  assert.equal(result.reopenedReference, 123);
  assert.equal(result.business, '已有填报内容');
  assert.equal(result.reopenedBusiness, '已有填报内容');
  assert.equal(result.formula, 'B1*2');
  assert.equal(result.formatter, '=IMAGE(@,"手写签名",0)');
  assert.equal(result.reopenedFormatter, result.formatter);
  assert.equal(result.unchanged, true);
  assert.equal(JSON.stringify(result.saved).includes('auxiliary_source'), false);
  assert.equal(JSON.stringify(result.saved).includes('456'), false);
  console.log('PASS: composed settings + signature IMAGE formatter + remote data; native reopen; business values/formulas preserved; runtime data excluded.');
})().catch(error => { console.error(error); process.exitCode = 1; });
