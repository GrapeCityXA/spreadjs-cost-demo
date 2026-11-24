const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium, expect } = require('@playwright/test');
const { inReportBrowser } = require('../src/services/reportRenderer');
let browser;
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'report-dependencies-'));
  console.log('Evidence:', directory);
  // Real SpreadJS workbook, isolated browser responses only: no production writes.
  const workbook = await inReportBrowser(() => {
    const S = GC.Spread.Sheets, book = new S.Workbook(document.getElementById('report'), { sheetCount: 3 });
    const [report, source, detail] = book.sheets;
    report.name('汇总'); source.name('来源 A'); detail.name('明细');
    for (const sheet of book.sheets) { sheet.setRowCount(20); sheet.setColumnCount(8); sheet.setColumnWidth(0, 140); }
    detail.setValue(1, 1, 10); source.setFormula(0, 0, "'明细'!B2"); source.setValue(1, 0, 0); source.setValue(2, 0, 20); source.setValue(0, 1, false);
    report.setValue(0, 0, '合计'); report.setFormula(0, 2, "SUM('来源 A'!A1:A3)+IF('来源 A'!B1,1,0)"); report.setFormula(0, 3, 'C1*2');
    report.setActiveCell(0, 2);
    const json = book.toJSON(); book.destroy(); return json;
  });
  const login = await fetch('http://127.0.0.1:5176/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'browser-user', password: 'browser-password' }) }).then(r => r.json());
  assert.ok(login.token);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error(e.stack); });
  const job = { id: 987654, name: '隔离勾稽验证', version: 1, status: 'complete', query: { periodCode: '2027-01' }, manifest: { version: 1, parameters: { periodCode: '2027-01' }, rowCount: 4, sourceSheetCount: 2, sourceRevisions: [] } };
  await page.route('**/api/report-studio**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/report-studio/jobs/987654/json') return route.fulfill({ json: workbook });
    if (url.pathname === '/api/report-studio/jobs/987654') return route.fulfill({ json: job });
    if (url.pathname === '/api/report-studio') { const response = await route.fetch(); const body = await response.json(); return route.fulfill({ json: { ...body, jobs: [job] } }); }
    return route.continue();
  });
  await page.goto('http://127.0.0.1:5176');
  await page.evaluate(login => { localStorage.setItem('token', login.token); localStorage.setItem('userInfo', JSON.stringify(login.user)); }, login);
  await page.goto('http://127.0.0.1:5176/portal/monthly-reference-report?section=results');
  await page.getByRole('button', { name: '预览与来源', exact: true }).click();
  const dialog = page.getByRole('dialog'), panel = dialog.getByRole('complementary', { name: '勾稽分析' });
  await expect(panel.locator('.cell-address')).toHaveText("'汇总'!C1", { timeout: 30000 });
  await expect(panel.locator('output')).toHaveText('30');
  await expect(panel.locator('.dependency-chart canvas')).toBeVisible();
  await page.screenshot({ path: path.join(directory, 'dependency-tree.png') });
  // Returning to the same direction must produce exactly the original canvas,
  // with no nodes or edges left over from an earlier tree.
  const graph = panel.locator('.dependency-chart');
  await page.mouse.move(20, 20);
  const originalGraph = await graph.screenshot();
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const label of ['影响去向', '双向追踪', '引用来源']) {
      await panel.locator('.el-radio-button__inner').getByText(label, { exact: true }).click();
      await page.mouse.move(20, 20);
      await graph.screenshot({ path: path.join(directory, `switch-${cycle}-${label}.png`) });
    }
    await expect.poll(async () => (await graph.screenshot()).equals(originalGraph), { timeout: 3000, message: 'Direction switching must not leave old tree pixels behind' }).toBe(true);
  }
  // Leaf position verified in the 1600×1000 screenshot; exercise real canvas hit testing.
  await page.mouse.click(1398, 454);
  await expect(panel.locator('.cell-address')).toHaveText("'明细'!B2");
  await panel.getByRole('button', { name: '关系清单', exact: true }).click();
  await expect(panel.locator('.dependency-list button')).toHaveCount(6);
  await expect(panel.locator('.dependency-list')).toContainText("'明细'!B2");
  await expect(panel.locator('.dependency-list')).toContainText('引用来源 · 0');
  await expect(panel.locator('.dependency-list')).toContainText('FALSE');
  await panel.getByRole('button', { name: /'明细'!B2/ }).click();
  await expect(panel.locator('.cell-address')).toHaveText("'明细'!B2");
  await expect(panel.locator('output')).toHaveText('10');
  await panel.getByRole('button', { name: '以此单元格继续追踪' }).click();
  await panel.locator('.el-radio-button__inner').getByText('影响去向', { exact: true }).click();
  await expect(panel.locator('.dependency-list')).toContainText("'汇总'!D1");
  await panel.locator('.el-radio-button__inner').getByText('双向追踪', { exact: true }).click();
  await expect(panel.locator('.dependency-list')).toContainText("'来源 A'!A1");
  await panel.getByRole('button', { name: '关系图', exact: true }).click();
  await expect(panel.locator('.dependency-chart canvas')).toBeVisible();
  const before = await dialog.locator('.report-preview').boundingBox();
  await dialog.getByRole('button', { name: '收起勾稽分析' }).click();
  const after = await dialog.locator('.report-preview').boundingBox(); assert.ok(after.width > before.width + 200);
  await dialog.getByRole('button', { name: '勾稽分析', exact: true }).click();
  await page.setViewportSize({ width: 900, height: 850 });
  await page.screenshot({ path: path.join(directory, 'dependency-narrow.png') });
  assert.ok(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 2));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '预览与来源', exact: true }).click();
  await expect(panel.locator('.cell-address')).toHaveText("'汇总'!C1");
  await expect(panel.locator('output')).toHaveText('30');
  assert.deepEqual(errors, []);
  console.log('PASS native formula/range/cross-sheet tree, zero/false, repeated direction switches without residual pixels, dependent chain, drilldown, panel resize, narrow layout, close/reopen. Evidence:', directory);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
