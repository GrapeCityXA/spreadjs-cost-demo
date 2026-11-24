const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
let browser;
(async () => {
  const base = 'http://127.0.0.1:5176';
  const evidence = await fs.mkdtemp(path.join(os.tmpdir(), 'collaboration-fillers-'));
  console.log('Evidence:', evidence);
  browser = await chromium.launch({ headless: true });
  const errors = [], pages = [];
  // Joining may initialize an empty assigned room. No cells are edited or submitted.
  for (const credentials of [
    { username: '组织填报人一', password: 'browser-scoped-password' },
    { username: 'browser-scoped-user-2', password: 'browser-scoped-password-2' }
  ]) {
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) }).then(r => r.json());
    assert.ok(login.token);
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    pages.push(page); page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.evaluate(l => { localStorage.setItem('token', l.token); localStorage.setItem('userInfo', JSON.stringify(l.user)); }, login);
    await page.goto(base + '/portal/monthly-filling?taskId=7&workflowFrom=todo');
    await expect(page.locator('.workbench-layout')).toBeVisible({ timeout: 25000 });
    await expect(page.locator('.spread-host canvas').first()).toBeVisible();
    const state = await page.locator('main').evaluate(e => {
      const vm = e.__vueParentComponent.proxy, sheet = vm.workbook.getSheet(0);
      return { ready: vm.ready, error: vm.errorText, connection: vm.connectionState,
        room: vm.room.roomKey, version: vm.sharedDoc.version, sheets: vm.workbook.getSheetCount(),
        formula: sheet.getFormula(11, 1), value: sheet.getValue(11, 1) };
    });
    assert.equal(state.ready, true); assert.equal(state.error, '');
    assert.equal(state.connection, '已连接'); assert.equal(state.sheets, 2);
    assert.ok(state.version > 0); assert.ok(state.formula.includes('shujuyuan!A3'));
    console.log(JSON.stringify({ user: credentials.username, ...state }));
    await page.screenshot({ path: path.join(evidence, `filler-${pages.length}.png`) });
  }
  for (const page of pages) await expect.poll(() => page.locator('main').evaluate(e => e.__vueParentComponent.proxy.collaborators.length), { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  await pages[0].reload();
  await expect(pages[0].locator('.workbench-layout')).toBeVisible({ timeout: 20000 });
  await expect(pages[0].getByRole('alert')).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('PASS both assigned fillers open task 7 with the published formula, see each other, and reload successfully; no business inputs changed.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
