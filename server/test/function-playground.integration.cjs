const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
const { expect } = require('@playwright/test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-function-playground-'));
Object.assign(process.env, { COST_REPORT_DB_PATH: path.join(root, 'business.db'), COST_REPORT_COLLAB_DB_PATH: path.join(root, 'collaboration.db'), COST_REPORT_TEMPLATE_DIR: path.join(root, 'templates'), COST_REPORT_ARTIFACT_DIR: path.join(root, 'artifacts'), COST_REPORT_BACKUP_DIR: path.join(root, 'backups'), JWT_SECRET: 'function-playground-isolated' });
const db = require('../src/config/database');
const app = require('../src/app');
const { runPlayground } = require('../src/services/functionPlayground');
const sql = (text, args = []) => new Promise((resolve, reject) => db.run(text, args, error => error ? reject(error) : resolve()));
const source = body => `class MyFunction extends GC.Spread.CalcEngine.Functions.Function { constructor(){super("MYFUNCTION",2,2)} evaluate(a,b){${body}} }`;
const variableSource = (args, body, extra = '') => `class MyFunction extends GC.Spread.CalcEngine.Functions.Function { constructor(){super("MYFUNCTION",2,2)} evaluate(${args}){${body}} ${extra} }`;
let server, browser;
(async () => {
  await db.ready;
  await sql("INSERT INTO users(id,username,password,name,permissions) VALUES(1,'playground-admin','test','测试管理员','[]'),(2,'playground-filler','test','测试填报人','[]')");
  await sql("INSERT INTO user_roles(user_id,role_code) VALUES(1,'system_admin'),(2,'filler')");
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET);
  const post = (payload, auth = token, signal) => fetch(base + '/api/function-playground/run', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(payload), signal });
  const payload = { mode: 'workbook', code: source('return a+b;'), cells: [] };
  assert.equal((await post(payload, '')).status, 401);
  assert.equal((await post(payload, jwt.sign({ id: 2 }, process.env.JWT_SECRET))).status, 403);
  assert.equal((await post({ ...payload, code: '' })).status, 400);
  assert.equal((await post({ code: payload.code, cases: [] })).status, 400);
  assert.equal((await post({ ...payload, cells: [{ row: 99, col: 0, value: 1 }] })).status, 400);
  const records = {};
  const grid = [{ row: 0, col: 0, value: 10 }, { row: 0, col: 1, value: 20 }, { row: 0, col: 2, formula: 'MYFUNCTION(A1,B1)' }, { row: 0, col: 3, formula: 'C1*2' }];
  async function workbook(code, cells = grid, initializeExample = false) { const response = await post({ mode: 'workbook', code, cells, initializeExample }); assert.equal(response.status, 200); return response.json(); }
  async function formula(code, expression) { return workbook(code, [{ row: 0, col: 0, formula: expression }]); }
  records.workbook = await workbook(source('return a+b;')); assert.equal(records.workbook.values[2].value, 30); assert.equal(records.workbook.values[3].value, 60);
  assert.equal((await workbook(source('return a*b;'))).values[2].value, 200);
  records.parameters = [];
  for (const [args, body, expression, expected, min, max] of [
    ['', 'return 42;', 'MYFUNCTION()', 42, 0, 0],
    ['a', 'return a*2;', 'MYFUNCTION(10)', 20, 1, 1],
    ['a,b,c', 'return a+b+c;', 'MYFUNCTION(10,20,30)', 60, 3, 3],
    ['a,b,c,d,e', 'return a+b+c+d+e;', 'MYFUNCTION(1,2,3,4,5)', 15, 5, 5],
    ['a,b=Math.max(4,5)', 'return a+b;', 'MYFUNCTION(10)', 15, 1, 2],
    ['a=5,b', 'return a+b;', 'MYFUNCTION(,10)', 15, 2, 2],
    ['...args', 'return args.reduce((s,n)=>s+n,0);', 'MYFUNCTION(10,20,30,40)', 100, 0, 255],
    ['a,...args', 'return a+args.reduce((s,n)=>s+n,0);', 'MYFUNCTION(1,2,3,4,5)', 15, 1, 255],
  ]) {
    const result = await formula(variableSource(args, body), expression);
    assert.equal(result.values?.[0].value, expected, JSON.stringify(result));
    assert.equal(result.argumentInfo.minArgs, min); assert.equal(result.argumentInfo.maxArgs, max);
    records.parameters.push({ args, expected, argumentInfo: result.argumentInfo });
  }
  const context = await formula(variableSource('context,a,b,c', 'return a+b+c+context.row;', 'isContextSensitive(){return true}'), 'MYFUNCTION(10,20,30)');
  assert.equal(context.values[0].value, 60); assert.equal(context.argumentInfo.maxArgs, 3);
  const seeded = await workbook(variableSource('a,b,c', 'return a+b+c;'), [], true);
  assert.equal(seeded.exampleFormula, '=MYFUNCTION(10,20,30)'); assert.equal(seeded.values[0].value, 60);
  const missing = await formula(variableSource('a,b,c', 'return a+b+c;'), 'MYFUNCTION(10,20)');
  assert.notEqual(missing.values?.[0].value, 30);
  assert.equal((await workbook('class MyFunction extends {')).status, 'Syntax Error');
  const thrown = await workbook(source('throw new Error("表格异常");')); assert.ok(thrown.error?.includes('表格异常') || thrown.errors?.includes('表格异常'));
  const isolation = await formula(source('let blocked=0;try{parent.document.body}catch(e){blocked++}try{localStorage.getItem("token")}catch(e){blocked++}return blocked===2 && typeof process==="undefined" && typeof require==="undefined";'), 'MYFUNCTION(0,0)');
  assert.equal(isolation.values[0].value, true);
  const before = Date.now();
  assert.equal((await workbook(source('while(true){}'))).status, 'Time Limit Exceeded'); assert.ok(Date.now()-before < 12000);
  const controller = new AbortController(); setTimeout(() => controller.abort(), 1200);
  await assert.rejects(runPlayground({ ...payload, code: source('while(true){}'), cells: grid }, controller.signal), { name: 'AbortError' });
  assert.equal((await workbook(source('return a+b;'))).values[2].value, 30);
  console.log('API: auth, workbook references, 0/1/3/5/default/rest/context parameters, generated example, errors, isolation, timeout, abort and recovery passed');

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1540, height: 1080 } });
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
  await page.route('**/api/**', async route => { const url = new URL(route.request().url()); if (!url.pathname.startsWith('/api/')) return route.continue(); await route.fulfill({ response: await route.fetch({ url: base + url.pathname + url.search }) }); });
  await page.goto('http://127.0.0.1:5176');
  await page.evaluate(token => { localStorage.setItem('token', token); localStorage.setItem('userInfo', JSON.stringify({ id: 1, name: '测试管理员', roles: [{ code: 'system_admin' }] })); }, token);
  await page.goto('http://127.0.0.1:5176/portal/rule-catalog?section=functions');
  const openEditor = () => page.getByRole('button', { name: '新建自定义公式', exact: true }).click();
  await openEditor();
  console.log('Browser entered:', page.url());
  const applyButton = page.getByRole('button', { name: '应用代码并计算', exact: true });
  await page.locator('.monaco-editor').waitFor({ timeout: 60000 });
  await expect(page.getByRole('button', { name: '运行全部用例', exact: false })).toHaveCount(0);
  await expect(page.getByText('用例结果', { exact: true })).toHaveCount(0);
  async function cellValue(row, col) { return page.evaluate(async ({ row, col }) => { const { default: GC } = await import('/node_modules/.vite/deps/@grapecity-software_spread-sheets.js'); return GC.Spread.Sheets.findControl(document.querySelector('.formula-sheet-host'))?.getActiveSheet().getValue(row, col); }, { row, col }); }
  async function waitCell(row, col, value) { await expect.poll(() => cellValue(row, col), { timeout: 25000 }).toBe(value); }
  async function setCode(code) { await page.locator('.monaco-editor').click(); await page.keyboard.press('Control+a'); await page.keyboard.insertText(code); }
  async function enterFormula(row, col, formula) {
    const rect = await page.evaluate(async ({row,col}) => { const { default: GC } = await import('/node_modules/.vite/deps/@grapecity-software_spread-sheets.js'); return GC.Spread.Sheets.findControl(document.querySelector('.formula-sheet-host')).getActiveSheet().getCellRect(row, col); }, {row,col});
    const box = await page.locator('.formula-sheet-host').boundingBox();
    await page.mouse.dblclick(box.x + rect.x + 18, box.y + rect.y + 10);
    await page.keyboard.press('Control+a'); await page.keyboard.type(formula); await page.keyboard.press('Enter');
  }
  await waitCell(0, 0, 30);
  await enterFormula(1, 2, '=MYFUNCTION(5,8)'); await waitCell(1, 2, 13);
  await page.reload(); await openEditor(); await waitCell(1, 2, 13);
  assert.equal(await cellValue(0, 0), 30);
  await setCode(source('return a*b;')); await applyButton.click(); await waitCell(0, 0, 200); await waitCell(1, 2, 40);
  await page.reload(); await openEditor(); await waitCell(0, 0, 200);
  await setCode(variableSource('a,b,c', 'return a+b+c;')); await applyButton.click();
  await expect(page.locator('.signature-info')).toContainText('3 个参数', { timeout: 25000 });
  await page.getByRole('button', { name: '填入当前单元格', exact: true }).click(); await waitCell(0, 0, 60);
  await enterFormula(1, 2, '=MYFUNCTION(A1,5,8)'); await waitCell(1, 2, 73);
  await setCode(variableSource('...args', 'return args.reduce((sum,n)=>sum+n,0);')); await applyButton.click();
  await expect(page.locator('.signature-info')).toContainText('可变参数', { timeout: 25000 });
  await enterFormula(2, 2, '=MYFUNCTION(1,2,3,4,5)'); await waitCell(2, 2, 15);
  await page.reload(); await openEditor(); await waitCell(2, 2, 15);
  await setCode('class MyFunction extends {'); await applyButton.click();
  await expect(page.locator('.sheet-error')).toContainText('Syntax Error', { timeout: 25000 });
  await setCode(variableSource('...args', 'throw new Error("自定义异常");')); await applyButton.click();
  await expect(page.locator('.sheet-error')).toContainText('自定义异常', { timeout: 25000 });
  await setCode(variableSource('...args', 'while(true){}')); await applyButton.click();
  await expect(page.locator('.sheet-error')).toContainText('Time Limit Exceeded', { timeout: 25000 });
  await setCode(variableSource('...args', 'return args.reduce((sum,n)=>sum+n,0);')); await applyButton.click(); await waitCell(2, 2, 15);
  await expect(page.locator('.sheet-state')).toContainText('计算完成', { timeout: 25000 });
  await expect(page.locator('.sheet-error')).toHaveCount(0);
  await page.screenshot({ path: path.join(root, 'spreadjs-only.png'), fullPage: true });
  await page.setViewportSize({ width: 900, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page overflow');
  assert.deepEqual(errors, [], 'no browser runtime errors');
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ records, errors }, null, 2));
  console.log('Browser: sheet-only UI, real keyboard formulas, Monaco edits, variable arity, references, persistence, errors, timeout and responsive layout passed');
  console.log('Evidence:', root);
})().catch(async error => { console.error(error); const page = browser?.contexts()[0]?.pages()[0]; if (page) { console.error((await page.locator('body').innerText()).slice(-5000)); await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }); } console.error('Evidence:', root); process.exitCode = 1; }).finally(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); db.close(); });
