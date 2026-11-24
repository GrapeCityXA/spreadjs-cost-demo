const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('PAGE_ERROR', error.message); });
  page.setDefaultTimeout(20000);
  const user = { id: 1, username: 'isolated-admin', name: '隔离验收', permissions: [], roles: [{ code: 'system_admin' }] };
  let workbook;
  await page.addInitScript(user => { localStorage.setItem('token', 'isolated-browser-token'); localStorage.setItem('userInfo', JSON.stringify(user)); }, user);
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith('/api/')) return route.continue();
    console.log('MOCK', pathname);
    const reply = json => route.fulfill({ json });
    if (pathname === '/api/auth/me') return reply({ user });
    if (pathname.endsWith('/notifications')) return reply({ notifications: [], unreadCount: 0 });
    if (pathname === '/api/collaboration/finalized-tasks') return reply({ tasks: [{ id: 1, organizationName: '测试公司', reportTypeName: '月报', periodCode: '2030-01', revisionNumber: 2 }] });
    if (pathname.endsWith('/revisions')) return reply({ revisions: [{ id: 2, revisionNumber: 2, finalizedAt: '2030-02-04', isCurrentEffective: true }, { id: 1, revisionNumber: 1, finalizedAt: '2030-02-02' }] });
    if (/\/revisions\/[12]$/.test(pathname)) {
      const id = Number(pathname.split('/').at(-1));
      return reply({ task: { id: 1, organizationName: '测试公司', reportTypeName: '月报', periodCode: '2030-01' }, revision: { id, number: id, submittedAt: '2030-02-0' + id, finalizedAt: '2030-02-04', isCurrentEffective: id === 2 }, opinions: [{ departmentCode: '审核部', reviewItemKey: 'monthly:submission', disposition: 'accept', opinion: '审核通过 R' + id }], workbook });
    }
    if (pathname === '/api/report-studio') return reply({ capabilities: { manage: true, design: true, approve: true }, templates: [], schedules: [], jobs: [], reportTypes: [], organizations: [] });
    return reply({});
  });
  await page.goto('http://127.0.0.1:5188/guide');
  workbook = await page.evaluate(async () => (await import('/tests/finalized-preview-fixture.js')).nativeSnapshot());
  await page.goto((process.env.FINALIZED_TEST_BASE || 'http://127.0.0.1:5188') + '/portal/finalized-data');
  console.log('FINALIZED_NAVIGATED', page.url());
  await expect(page.locator('.detail-head')).toContainText('修订 R2', { timeout: 60000 });
  await expect(page.locator('.opinion-card')).toContainText('审核通过 R2');
  await page.getByRole('button', { name: '勾稽分析', exact: true }).click({ timeout: 60000 });
  const panel = page.getByRole('complementary', { name: '勾稽分析' });
  await expect(panel.locator('code')).toContainText('SUM(A1:A2)');
  await expect(panel.locator('output')).toHaveText('30');
  const list = panel.getByRole('button', { name: '关系清单', exact: true });
  if (await list.isVisible()) await list.click();
  await expect(panel.locator('.dependency-list')).toContainText('A1');
  await expect(panel.locator('.dependency-list')).toContainText('A2');
  const protection = await page.evaluate(() => {
    const host = document.querySelector('.report-preview > div');
    const book = window.GC.Spread.Sheets.findControl(host);
    return { protected: book.getActiveSheet().options.isProtected, locked: book.getActiveSheet().getCell(0, 1).locked(), formula: book.getActiveSheet().getFormula(0, 1) };
  });
  assert.equal(protection.protected, true); assert.equal(protection.locked, true); assert.equal(protection.formula, 'SUM(A1:A2)');
  await page.locator('.revision-switcher .el-select').click();
  await page.getByRole('option', { name: /^R1/ }).click();
  await expect(page.locator('.detail-head')).toContainText('修订 R1');
  await expect(page.locator('.opinion-card')).toContainText('审核通过 R1');
  await page.getByRole('button', { name: '生成报表', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '月度参考报表' })).toBeVisible({ timeout: 30000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.screenshot({ path: '.scratch/finalized-integrated-page.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS finalized browser: native collaboration snapshot, saved formula/value, dependency references, historical selection, report dialog, no page errors.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
