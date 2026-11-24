const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { chromium } = require('@playwright/test');

// Every API request uses a new database. Never write to the running demo's data.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'component-grid-save-'));
Object.assign(process.env, {
  COST_REPORT_DB_PATH: path.join(root, 'business.db'),
  COST_REPORT_COLLAB_DB_PATH: path.join(root, 'collaboration.db'),
  COST_REPORT_TEMPLATE_DIR: path.join(root, 'templates'),
  COST_REPORT_ARTIFACT_DIR: path.join(root, 'artifacts'),
  COST_REPORT_BACKUP_DIR: path.join(root, 'backups'),
  JWT_SECRET: 'component-grid-isolated-test'
});
const db = require('../src/config/database');
const app = require('../src/app');
const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, e => e ? reject(e) : resolve()));
const get = (sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (e, row) => e ? reject(e) : resolve(row)));
let server, browser;
(async () => {
  try {
    await db.ready;
    await run("INSERT INTO users(id,username,password,name,permissions) VALUES(1,'grid-admin','test','网格验收管理员','[]')");
    await run("INSERT INTO user_roles(user_id,role_code) VALUES(1,'system_admin')");
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    page.on('pageerror', error => console.error('Browser error:', error.message));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith('/api/')) return route.continue();
      await route.fulfill({ response: await route.fetch({ url: base + url.pathname + url.search }) });
    });
    await page.goto('http://127.0.0.1:5176/login');
    await page.evaluate(token => {
      localStorage.setItem('token', token);
      localStorage.setItem('userInfo', JSON.stringify({ id: 1, name: '网格验收管理员', roles: [{ code: 'system_admin' }] }));
    }, token);
    await page.goto('http://127.0.0.1:5176/portal/template-workbench?new=true');
    await page.locator('.designer-frame canvas:visible').first().waitFor({ timeout: 30000 }).catch(async error => {
      console.error('Page:', page.url(), (await page.locator('body').innerText()).slice(0, 2000));
      throw error;
    });
    await page.evaluate(() => {
      let c = document.querySelector('.workbench').__vueParentComponent;
      while (c && c.type.name !== 'DesignerWorkbench') c = c.parent;
      window.vm = c.proxy;
    });
    await page.waitForFunction(() => vm._savedDesign != null);
    const created = await page.evaluate(async () => {
      vm.form.name = '网格同步验收'; vm.form.code = 'grid_save_check';
      const s = vm.spread.getActiveSheet();
      s.setRowCount(10); s.setColumnCount(8); s.setValue(9, 7, '新增区域');
      return { saved: await vm.saveDraft(false), id: vm.versionId };
    });
    assert.equal(created.saved, true);
    const readGrid = async () => JSON.parse((await get('SELECT workbook_json FROM template_component_versions WHERE id = ?', [created.id])).workbook_json);
    let grid = await readGrid();
    assert.equal(grid.rowCount, 10); assert.equal(grid.columnCount, 8);
    assert.equal(grid.cells.find(c => c.row === 9 && c.column === 7)?.value, '新增区域');
    assert.equal(await page.evaluate(async () => {
      const s = vm.spread.getActiveSheet();
      s.setRowCount(4); s.setColumnCount(3); s.setValue(3, 2, '缩小后的内容');
      return vm.saveDraft(false);
    }), true);
    grid = await readGrid();
    assert.equal(grid.rowCount, 4); assert.equal(grid.columnCount, 3);
    assert.equal(grid.cells.find(c => c.row === 3 && c.column === 2)?.value, '缩小后的内容');
    assert.equal(await page.evaluate(async () => {
      const sheet = vm.spread.getActiveSheet();
      sheet.setRowCount(250); sheet.setColumnCount(120);
      sheet.setValue(249, 119, '超过旧尺寸上限');
      return vm.saveDraft(false);
    }), true);
    grid = await readGrid();
    assert.equal(grid.rowCount, 250); assert.equal(grid.columnCount, 120);
    assert.equal(grid.cells.find(c => c.row === 249 && c.column === 119)?.value, '超过旧尺寸上限');
    const dense = await fetch(base + `/api/template-governance/components/versions/${created.id}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowCount: 250, columnCount: 120,
        cells: Array.from({ length: 20100 }, (_, i) => ({ row: Math.floor(i / 120), column: i % 120, value: i })), metadata: {} })
    });
    assert.equal(dense.status, 200);
    grid = await readGrid();
    assert.equal(grid.cells.length, 20100);
    const rejected = await fetch(base + `/api/template-governance/components/versions/${created.id}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowCount: 4, columnCount: 3, cells: [{ row: 3, column: 5, value: '越界' }], metadata: {} })
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await readGrid(), grid);
    const nativeSheet = { name: '完整模板', rowCount: 2500, columnCount: 250,
      data: { dataTable: { 2499: { 249: { value: '远端单元格' } } } } };
    const template = await fetch(base + '/api/template-governance/templates', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '超出旧上限的完整模板', factory: 'ALL',
        designerJson: { version: '19.2.0', sheets: { Sheet1: nativeSheet } },
        sheets: [{ code: 'large_sheet', name: nativeSheet.name, type: 'business', inlineWorkbook: {
          rowCount: 2500, columnCount: 250, cells: [{ row: 2499, column: 249, value: '远端单元格' }],
          metadata: { designerJson: nativeSheet, mappings: [], nativeValidations: [], permissionTags: {} }
        } }] })
    });
    assert.equal(template.status, 201, await template.text());
    console.log(JSON.stringify({ passed: true, root, create: '10x8', update: '4x3', enlarged: '250x120', populatedCells: 20100, backendBoundaryRetained: true }));
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
