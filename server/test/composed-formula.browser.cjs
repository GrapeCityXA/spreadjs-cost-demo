const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ cacheDir: path.resolve('.scratch/formula-browser-vite'),
    optimizeDeps: { entries: ['tests/composed-formula.browser.html'] },
    server: { host: '127.0.0.1', port: 0, open: false } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', error => console.error('Browser:', error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/composed-formula.browser.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.formulaTest, null, { timeout: 120000 });
    const fixturePath = process.env.FORMULA_FIXTURE_PATH || path.resolve('.scratch/integrated-formula-20261026/composed-fixture.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const result = await page.evaluate(async contract => {
      const { GC, loadTemplateWorkbook, shiftFormula } = window.formulaTest;
      function makeBook() {
        const host = document.createElement('div');
        host.style.cssText = 'width:800px;height:500px'; document.body.appendChild(host);
        return new GC.Spread.Sheets.Workbook(host);
      }
      const book = makeBook();
      try {
        await loadTemplateWorkbook(book, contract, { remoteData: false });
        const read = () => {
          const s = book.getSheet(0);
          return { formulas: [s.getFormula(1, 1), s.getFormula(4, 1), s.getFormula(4, 2), s.getFormula(6, 1), s.getFormula(6, 2)],
            values: [s.getValue(1, 1), s.getValue(4, 1), s.getValue(4, 2), s.getValue(6, 1), s.getValue(6, 2)] };
        };
        const cells = read();
        // Build component-native JSON, including formulas absent from the cells list.
        const nativeContract = JSON.parse(JSON.stringify(contract));
        for (const section of nativeContract.sheets[0].sections) {
          const model = makeBook();
          const s = model.getSheet(0);
          s.setRowCount(section.rowCount); s.setColumnCount(section.columnCount);
          for (const cell of section.cells) {
            const r = cell.row - section.startRow;
            if (cell.formula) s.setFormula(r, cell.column,
              shiftFormula(cell.formula, cell.row, cell.column, r, cell.column, s));
            else s.setValue(r, cell.column, cell.value);
          }
          section.designerJson = s.toJSON(); model.destroy();
        }
        nativeContract.sheets[0].cells = [];
        await loadTemplateWorkbook(book, nativeContract, { remoteData: false });
        const native = read();
        const saved = book.toJSON();
        await loadTemplateWorkbook(book, { ...nativeContract, designerJson: saved }, { remoteData: false });
        const restored = read();
        const direct = shiftFormula('A1+$B$2+C$3', 0, 0, 2, 1, book.getSheet(0));
        return { cells, native, restored, direct };
      } finally { book.destroy(); }
    }, fixture);
    const expected = { formulas: ['A1*2', 'SUM(A3:A4)', 'A3+$A$1+A$1+$A4', 'A6*3', '"A1"&A6'], values: [20, 12, 32, 12, 'A14'] };
    assert.deepEqual(result.cells, expected);
    assert.deepEqual(result.native, expected);
    assert.deepEqual(result.restored, expected);
    assert.equal(result.direct, 'B3+$B$2+D$3');
    console.log('SpreadJS browser checks passed: server cells, native component formulas, saved workbook, direct insertion offsets.');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
