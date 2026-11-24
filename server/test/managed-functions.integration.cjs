const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { chromium, expect } = require('@playwright/test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-managed-functions-'));
Object.assign(process.env, { COST_REPORT_DB_PATH: path.join(root, 'business.db'), COST_REPORT_COLLAB_DB_PATH: path.join(root, 'collaboration.db'), COST_REPORT_TEMPLATE_DIR: path.join(root, 'templates'), COST_REPORT_ARTIFACT_DIR: path.join(root, 'artifacts'), COST_REPORT_BACKUP_DIR: path.join(root, 'backups'), JWT_SECRET: 'managed-functions-isolated' });
const db = require('../src/config/database');
const app = require('../src/app');
const collaboration = require('../src/services/collaborationServer');
const { calculateManagedSnapshot, templateDefinitions } = require('../src/services/managedFunctions');
const { authorizeChangeSet, validateInitialSnapshot } = require('../src/services/changeSetAuthorization');
const sql = (text, args = []) => new Promise((resolve, reject) => db.run(text, args, error => error ? reject(error) : resolve()));
const source = multiplier => `class ManagedTotal extends GC.Spread.CalcEngine.Functions.Function {
  constructor() { super("MYTOTAL"); this.typeName = "CustomFunctions.MyTotal"; this.multiplier = ${multiplier}; }
  evaluate(a,b,c) { return (a+b+c)*this.multiplier; }
  toJSON() { return {typeName:this.typeName,multiplier:this.multiplier}; }
  fromJSON(settings) { this.multiplier = settings.multiplier; }
}`;
let server, browser, page;
(async () => {
  await db.ready;
  await sql("INSERT INTO users(id,username,password,name,permissions) VALUES(1,'function-admin','test','函数管理员','[]'),(2,'function-author','test','函数维护者','[]'),(3,'function-filler','test','填报人','[]')");
  await sql("INSERT INTO user_roles(user_id,role_code) VALUES(1,'system_admin'),(1,'subsidiary_filler'),(1,'subsidiary_submitter'),(2,'business_rule_administrator'),(3,'filler')");
  server = require('http').createServer(app); await collaboration.attach(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET), author = jwt.sign({ id: 2 }, process.env.JWT_SECRET), filler = jwt.sign({ id: 3 }, process.env.JWT_SECRET);
  async function api(url, body, method = body === undefined ? 'GET' : 'POST', auth = token, status = 200) {
    const response = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json(); assert.equal(response.status, status, `${url}: ${JSON.stringify(payload)}`); return payload;
  }
  const payload = { code: 'MY_TOTAL', displayName: '三项合计', ruleType: 'formula', scope: 'business_formula', severity: 'info', description: '三项之和乘以实例倍数', expression: { engine: 'spreadjs-function', schemaVersion: 1, sourceCode: source(2) } };
  const legacy = 'class MyFunction extends GC.Spread.CalcEngine.Functions.Function { constructor(){super("LEGACY",2,2);this.factor=3;} evaluate(a,b,c){return (a+b+c)*this.factor;} }';
  const upgraded = await api('/function-playground/serialization-template', { code: legacy });
  assert.ok(upgraded.code.includes('evaluate(a,b,c){return (a+b+c)*this.factor;}'));
  assert.ok(upgraded.code.includes('factor: this.factor'));
  const legacyDefinition = await require('../src/services/managedFunctions').inspectDefinition({ engine: 'spreadjs-function', schemaVersion: 1, sourceCode: upgraded.code });
  assert.equal(legacyDefinition.minArgs, 3); assert.equal(legacyDefinition.instanceState.factor, 3);
  await api('/rules', payload, 'POST', filler, 403);
  const first = await api('/rules', payload, 'POST', token, 201);
  const sourceTools = await api('/function-playground/source-tools', { code: source(2), ruleId: first.ruleId });
  assert.equal(sourceTools.className, 'ManagedTotal'); assert.equal(sourceTools.conflict, '');
  for (const [code, sourceCode] of [
    ['DUP_FUNCTION', source(2).replaceAll('ManagedTotal', 'OtherTotal').replace('CustomFunctions.MyTotal', 'CustomFunctions.OtherTotal')],
    ['DUP_CLASS', source(2).replace('MYTOTAL', 'OTHER_TOTAL').replace('CustomFunctions.MyTotal', 'CustomFunctions.OtherTotal')],
    ['DUP_TYPE', source(2).replaceAll('ManagedTotal', 'OtherTotal').replace('MYTOTAL', 'OTHER_TOTAL')],
  ]) await api('/rules', { ...payload, code, expression: { ...payload.expression, sourceCode } }, 'POST', token, 409);
  const uniqueSource = source(2).replaceAll('ManagedTotal', 'SeparateTotal').replace('MYTOTAL', 'SEPARATE_TOTAL').replace('CustomFunctions.MyTotal', 'CustomFunctions.SeparateTotal');
  const draft = await api('/rules', { ...payload, code: 'SEPARATE_TOTAL', expression: { ...payload.expression, sourceCode: uniqueSource } }, 'POST', token, 201);
  await api(`/rules/versions/${draft.versionId}`, { ...payload, expression: payload.expression }, 'PATCH', token, 409);
  assert.ok((await api('/function-playground/source-tools', { code: source(2) })).conflict);
  await api('/function-playground/source-tools', { code: source(2) }, 'POST', '', 401);
  await api(`/rules/versions/${first.versionId}/submit`, {}, 'POST', token, 409);
  const inspected = await api(`/rules/versions/${first.versionId}/test`, {});
  assert.equal(inspected.expression.minArgs, 3); assert.equal(inspected.expression.instanceState.multiplier, 2);
  assert.equal((await api(`/rules/versions/${first.versionId}/submit`, {})).status, 'published');
  await api(`/rules/versions/${first.versionId}`, payload, 'PATCH', token, 403);
  const second = await api(`/rules/${first.ruleId}/versions`, { ...payload, expression: { ...payload.expression, sourceCode: source(3) } }, 'POST', author, 201);
  await api(`/rules/versions/${second.versionId}/test`, {}, 'POST', author);
  assert.equal((await api(`/rules/versions/${second.versionId}/submit`, {}, 'POST', author)).status, 'pending_review');
  await api(`/rules/versions/${second.versionId}/publish`, {}, 'POST', author, 403);

  await api('/managed-functions/definitions', { versionIds: [second.versionId] }, 'POST', filler, 400);
  await api('/managed-functions/definitions', { versionIds: [first.versionId] }, 'POST', '', 401);
  await api(`/rules/versions/${second.versionId}/publish`, {});
  const published = await api('/managed-functions/definitions', { versionIds: [first.versionId, second.versionId] }, 'POST', filler);
  assert.deepEqual(published.definitions.map(d => d.id), [first.versionId, second.versionId]);
  // Backend evaluation is an internal service; the UI evaluates published definitions locally.
  const { executeDefinitions } = require('../src/services/managedFunctions');
  const results = await executeDefinitions(published.definitions, { calls: [
    { versionId: first.versionId, args: [10,20,30] }, { versionId: second.versionId, args: [10,20,30] }
  ] });
  assert.deepEqual(results, [{ value: 120 }, { value: 180 }]);
  const workflows = await api('/workflows');
  fs.writeFileSync(path.join(root, 'workflows.json'), JSON.stringify(workflows));
  console.log('API: draft, serialization, administrator publication, review, immutable versions, published-only runtime passed');

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1540, height: 1080 } });
  await page.addInitScript(host => { const Original = window.WebSocket; window.WebSocket = class extends Original { constructor(url, protocols) { const parsed = new URL(url); if (['127.0.0.1','localhost'].includes(parsed.hostname) && ['5176','5302'].includes(parsed.port) && ![protocols].flat().includes('vite-hmr')) parsed.host = host; super(parsed.href, protocols); } }; }, new URL(base).host);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let calculationRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/managed-functions/evaluate') calculationRequests++; });
  await page.route('**/api/**', async route => { const url = new URL(route.request().url()); if (!url.pathname.startsWith('/api/')) return route.continue(); await route.fulfill({ response: await route.fetch({ url: base + url.pathname + url.search }) }); });
  await page.goto('http://localhost:5176');
  await page.evaluate(token => { localStorage.setItem('token', token); localStorage.setItem('userInfo', JSON.stringify({ id: 1, name: '函数管理员', roles: [{ code: 'system_admin' }] })); }, token);
  await page.goto('http://localhost:5176/portal/rule-catalog?section=functions');
  await expect(page.getByRole('button', { name: '新建自定义公式', exact: true })).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole('tabpanel', { name: '自定义公式', exact: true }).getByText('三项合计', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: path.join(root, 'catalog.png'), fullPage: true });
  await page.getByRole('button', { name: '新建自定义公式', exact: true }).click();
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.monaco-editor')).toContainText('toJSON');
  await expect(page.getByLabel('函数名（公式中使用）')).toHaveValue('MYFUNCTION');
  await page.getByLabel('函数名（公式中使用）').fill('UI_AMOUNT');
  await page.getByLabel('class 名（代码中的类）').fill('UiAmount');
  await page.getByRole('button', { name: '应用名称', exact: true }).click();
  await expect(page.locator('.panel-heading').first()).toContainText('UiAmount.js');
  await page.getByRole('combobox', { name: '添加可选方法' }).selectOption('acceptsArray');
  await expect(page.locator('.monaco-editor')).toContainText('acceptsArray');
  const arrayOption = page.locator('#function-method-select option[value="acceptsArray"]');
  await expect(arrayOption).toBeDisabled();
  const withArray = await page.evaluate(() => document.querySelector('.function-playground').__vueParentComponent.exposed.getData().sourceCode);
  const withoutArray = withArray.replace(/\n  acceptsArray\(argIndex\) \{[\s\S]*?\n  \}\n/, '\n');
  assert.notEqual(withArray, withoutArray);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  async function replaceEditor(text) {
    await page.evaluate(value => navigator.clipboard.writeText(value), text);
    await page.locator('.monaco-editor').click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+v');
  }
  await replaceEditor(withoutArray);
  await expect(page.getByRole('combobox', { name: '添加可选方法' })).toBeEnabled();
  await expect(arrayOption).toBeEnabled(); await expect(arrayOption).not.toContainText('已添加');
  await page.keyboard.press('Control+z');
  await expect(arrayOption).toBeDisabled(); await expect(arrayOption).toContainText('已添加');
  await page.keyboard.press('Control+y');
  await expect(page.getByRole('combobox', { name: '添加可选方法' })).toBeEnabled();
  await expect(arrayOption).toBeEnabled();
  await page.getByRole('combobox', { name: '添加可选方法' }).selectOption('acceptsArray');
  await expect(arrayOption).toBeDisabled();
  await replaceEditor(withoutArray.slice(0, -1));
  await expect(page.locator('.source-error')).toContainText('模板检查');
  await expect(arrayOption).not.toContainText('已添加');
  await expect(page.getByRole('combobox', { name: '添加可选方法' })).toBeDisabled();
  await replaceEditor(withArray);
  await expect(page.getByRole('combobox', { name: '添加可选方法' })).toBeEnabled();
  await expect(arrayOption).toBeDisabled();
  await page.getByRole('button', { name: '应用代码并计算', exact: true }).click();
  await expect(page.locator('.sheet-actions')).toContainText('已注册：UI_AMOUNT', { timeout: 30000 });
  await page.getByRole('button', { name: '填入当前单元格', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const { default: GC } = await import('/node_modules/.vite/deps/@grapecity-software_spread-sheets.js');
    return GC.Spread.Sheets.findControl(document.querySelector('.formula-sheet-host'))?.getActiveSheet()?.getValue(0, 0);
  }), { timeout: 30000 }).toBe(10);
  await page.screenshot({ path: path.join(root, 'source-tools-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.source-tools').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'source-tools-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1540, height: 1080 });
  await page.getByPlaceholder('例如 SALES_AMOUNT').fill('UI_FUNCTION'); await page.getByPlaceholder('例如 含税金额').fill('界面保存函数');
  await page.getByRole('button', { name: '保存并发布', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: '自定义公式', exact: true }).getByText('界面保存函数', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  await page.goto('http://localhost:5176/portal/template-workbench?mode=template&new=true');
  await expect.poll(() => page.evaluate(() => Boolean(document.querySelector('main.workbench')?.__vueParentComponent?.proxy?.spread)), { timeout: 60000 }).toBe(true);
  await page.getByPlaceholder('例如：月度经营报表').fill('自定义函数完整模板');
  await page.evaluate(() => { const vm = document.querySelector('main.workbench').__vueParentComponent.proxy; vm.fieldDrawer = true; vm.fieldTab = 'formulas'; vm.spread.getActiveSheet().setRowCount(10); vm.spread.getActiveSheet().setColumnCount(6); vm.selectedTargetCell = { row: 0, col: 2 }; vm.spread.getActiveSheet().setValue(0, 0, 10); vm.spread.getActiveSheet().setValue(0, 1, 20); vm.spread.getActiveSheet().setTag(0,0,JSON.stringify({platform:'cost-report-cell-permission-v1',schemaVersion:1,permission:'primary_input',visibility:'visible',editableForRoles:['system_admin','subsidiary_filler']})); });
  // Use the actual palette insertion action and its formula dialog.
  await page.evaluate(id => { const vm = document.querySelector('main.workbench').__vueParentComponent.proxy; vm.injectFormula(vm.businessFormulas.find(rule => rule.versionId === id)); }, first.versionId);
  await page.locator('.el-message-box input').fill('=MYTOTAL(A1,B1,30)'); await page.getByRole('button', { name: '确定', exact: true }).click();
  const cell = () => page.evaluate(() => document.querySelector('main.workbench').__vueParentComponent.proxy.spread.getActiveSheet().getValue(0, 2));
  await expect.poll(cell, { timeout: 30000 }).toBe(120);
  const saved = await page.evaluate(async () => { const vm = document.querySelector('main.workbench').__vueParentComponent.proxy; const ok = await vm.saveDirectTemplate(false); return { ok, id: vm.templateVersionId, templateId: vm.templateId }; });
  assert.equal(saved.ok, true);
  await page.goto(`http://localhost:5176/portal/template-workbench?mode=template&templateVersionId=${saved.id}`);
  await expect.poll(async () => page.evaluate(() => document.querySelector('main.workbench')?.__vueParentComponent?.proxy?.spread?.getActiveSheet()?.getValue(0,2)), { timeout: 60000 }).toBe(120);
  const detail = (await api(`/template-governance/templates/versions/${saved.id}`)).template;
  const checks = await api(`/template-governance/templates/versions/${saved.id}/publication-checks`);
  assert.equal(checks.report.passed, true, JSON.stringify(checks));
  await api(`/template-governance/templates/${saved.templateId}/versions/${saved.id}/submit`, {});
  const probe = await page.evaluate(async contract => {
    const { default: GC } = await import('/node_modules/.vite/deps/@grapecity-software_spread-sheets.js');
    const { registerTemplateFunctions } = await import('/src/template/managedFunctions.js');
    const first = new GC.Spread.Sheets.Workbook(document.createElement('div'));
    const second = new GC.Spread.Sheets.Workbook(document.createElement('div'));
    await registerTemplateFunctions(first, contract); await registerTemplateFunctions(second, contract);
    first.fromJSON(contract.designerJson); first.collaboration.fromSnapshot(contract.templateSnapshot); const snapshot = JSON.parse(JSON.stringify(first.collaboration.toSnapshot()));
    second.collaboration.fromSnapshot(snapshot);
    window.managedProbe = { first, second };
    return { snapshot, functions: first.toJSON().customFunctions };
  }, detail.workbook);
  await expect.poll(() => page.evaluate(() => window.managedProbe.second.getActiveSheet().getValue(0,2)), { timeout: 30000 }).toBe(120);
  const { compilePermissionIndex } = require('../src/services/permissionIndex');
  const permissionIndex = compilePermissionIndex(detail.workbook);
  assert.equal(validateInitialSnapshot(probe.snapshot, detail.workbook, null, permissionIndex), null);
  const computed = await calculateManagedSnapshot(detail.workbook, probe.snapshot);
  assert.equal(Object.values(computed).find(item => /MYTOTAL/.test(item.formula))?.value, 120);
  const boundProbe = await page.evaluate(async contract => {
    const { default: GC } = await import('/node_modules/.vite/deps/@grapecity-software_spread-sheets.js');
    const { registerTemplateFunctions } = await import('/src/template/managedFunctions.js');
    const { bindReportData } = await import('/src/template/dataBinding.js');
    const book = new GC.Spread.Sheets.Workbook(document.createElement('div'));
    try {
      await registerTemplateFunctions(book, contract); await book.fromJSON(contract.designerJson);
      contract.sheets[0].mappings = [{ id: 'total', kind: 'input', fieldCode: 'TOTAL', fieldDefinitionId: 1,
        bindingPath: 'TOTAL', bindingVersion: 2, row: 0, col: 2, rowCount: 1, colCount: 1, primary: true,
        permission: 'primary_input', editableForRoles: ['subsidiary_filler'] }];
      contract.sheets[0].cells.find(cell => cell.row === 0 && cell.column === 2).bindingPath = 'TOTAL';
      await bindReportData(book, contract);
      const snapshot = JSON.parse(JSON.stringify(book.collaboration.toSnapshot()));
      contract.templateSnapshot = snapshot;
      return { snapshot, contract };
    } finally { book.destroy(); }
  }, JSON.parse(JSON.stringify(detail.workbook)));
  const boundIndex = compilePermissionIndex(boundProbe.contract);
  assert.match(validateInitialSnapshot(boundProbe.snapshot, boundProbe.contract, null, boundIndex), /初始公式无法计算/);
  const boundComputed = await calculateManagedSnapshot(boundProbe.contract, boundProbe.snapshot);
  assert.equal(validateInitialSnapshot(boundProbe.snapshot, boundProbe.contract, null, boundIndex, boundComputed), null);
  const extracted = require('../src/services/businessSubmission').extractBusinessValues({
    workbook: detail.workbook, snapshot: probe.snapshot, calculatedValues: computed, actorId: 1, collaborationVersion: 1,
    manifest: { submission: { version: 1, sheets: [{ code: 'MAIN', name: detail.workbook.sheets[0].name, order: 0,
      mappings: [0,1,2].map(col => ({ kind: 'input', namedArea: `MAIN_INPUT_VALUE_${col}`, row: 0, col, rowCount: 1, colCount: 1,
        fieldDefinitionId: col + 1, fieldCode: `VALUE_${col}`, primary: true, permission: 'primary_input', ...(col === 2 ? { bindingPath: 'TOTAL' } : {}) })) }] } },
    fields: new Map([0,1,2].map(col => [col + 1, { id: col + 1, code: `VALUE_${col}`, data_type: 'decimal', precision: 2 }]))
  });
  assert.deepEqual(extracted.map(item => item.typedValue.value), ['10','20','120']);
  await page.evaluate(() => { window.managedProbe.first.collaboration.onChangeSet(change => { window.managedProbe.second.collaboration.applyChangeSet(change); }); window.managedProbe.first.getActiveSheet().setValue(0,0,40); });
  await expect.poll(() => page.evaluate(() => window.managedProbe.second.getActiveSheet().getValue(0,2)), { timeout: 30000 }).toBe(180);
  const poisoned = JSON.parse(JSON.stringify(detail.workbook)); Object.values(poisoned.designerJson.customFunctions)[0].versionId = 999999;
  await assert.rejects(templateDefinitions(poisoned));
  await page.screenshot({ path: path.join(root, 'designer-restored.png'), fullPage: true });
  await page.evaluate(() => { window.managedProbe.first.destroy(); window.managedProbe.second.destroy(); });
  const organization = await api('/admin/organizations', { code: 'FUNCTION_ORG', name: '函数验收组织', organizationType: 'subsidiary', effectiveFrom: '2026-01-01' }, 'POST', token, 201);
  const reportType = await api('/period-configuration/report-types', { code: 'FUNCTION_MONTHLY', displayName: '函数验收月报', cadence: 'monthly' }, 'POST', token, 201);
  const pkg = await api('/period-configuration/packages', { reportTypeId: reportType.reportTypeId, periodCode: '2027-01', templateVersionId: saved.id,
    organizations: [{ organizationId: organization.organizationId }], assignments: ['filler','submitter','department_reviewer','approver','finalizer'].map(responsibility => ({ organizationId: organization.organizationId, responsibility, userId: 1 })) }, 'POST', token, 201);
  await api(`/period-configuration/packages/${pkg.package.id}/activate`, {});
  const task = await db._helpers.get(db, 'SELECT * FROM report_tasks WHERE package_id = ?', [pkg.package.id]);
  await page.goto(`http://localhost:5176/portal/monthly-filling?taskId=${task.id}`);
  const readFill = () => page.evaluate(() => document.querySelector('main.filling-page')?.__vueParentComponent?.proxy?.workbook?.getActiveSheet()?.getValue(0,2));
  await expect.poll(readFill, { timeout: 60000 }).toBe(120);
  const initialRoomVersion = await page.evaluate(() => Number(document.querySelector('main.filling-page').__vueParentComponent.proxy.sharedDoc.version));
  await page.evaluate(() => document.querySelector('main.filling-page').__vueParentComponent.proxy.workbook.getActiveSheet().setValue(0,0,40));
  await expect.poll(readFill, { timeout: 30000 }).toBe(180);
  await expect.poll(() => page.evaluate(initialVersion => { const vm = document.querySelector('main.filling-page').__vueParentComponent.proxy; return vm.pendingChangeSets === 0 && Number(vm.sharedDoc?.version) > initialVersion && !vm.errorText; }, initialRoomVersion), { timeout: 30000 }).toBe(true);
  await page.reload(); await expect.poll(readFill, { timeout: 60000 }).toBe(180);
  const timing = await page.evaluate(() => {
    const sheet = document.querySelector('main.filling-page').__vueParentComponent.proxy.workbook.getActiveSheet();
    const start = performance.now(); sheet.setValue(0,0,40);
    return { value: sheet.getValue(0,2), durationMs: performance.now() - start };
  });
  assert.equal(timing.value, 180); console.log('Local synchronous recalculation:', timing);
  const submitted = await page.evaluate(async taskId => { const { collaborationApi } = await import('/src/api/index.js'); const vm = document.querySelector('main.filling-page').__vueParentComponent.proxy; return collaborationApi.submitTask(taskId, { expectedVersion: Number(vm.sharedDoc.version), pendingChanges: 0, warningExplanations: [] }, crypto.randomUUID()); }, task.id);
  assert.ok(submitted.revisionId, JSON.stringify(submitted));
  const submittedRoom = await api(`/collaboration/tasks/${task.id}/room`);
  assert.ok(submittedRoom.submittedWorkbook);
  // Fresh JS realm: the preview must load version-pinned implementations itself.
  await page.goto('http://localhost:5176/portal/home');
  await page.evaluate(async json => {
    const { createApp } = await import('/node_modules/.vite/deps/vue.js');
    const { default: Preview } = await import('/src/components/ReportResultPreview.vue');
    const host = document.createElement('div'); document.body.appendChild(host);
    window.resultPreviewApp = createApp(Preview, { workbook: json, frozen: true }); window.resultPreviewApp.mount(host);
    window.resultPreviewHost = host;
  }, submittedRoom.submittedWorkbook);
  await expect.poll(() => page.evaluate(async () => {
    const { default: GC } = await import('/node_modules/.vite/deps/@grapecity-software_spread-sheets.js');
    const book = GC.Spread.Sheets.findControl(window.resultPreviewHost.querySelector('.report-preview')?.firstElementChild);
    if (!book?.getActiveSheet()) return null;
    book.calculate(); return book.getActiveSheet().getValue(0,2);
  }), { timeout: 20000 }).toBe(180);
  assert.equal(calculationRequests, 0, 'Designer, filling and result preview never request server evaluation');
  await page.evaluate(() => { window.resultPreviewApp.unmount(); window.resultPreviewHost.remove(); });
  await page.screenshot({ path: path.join(root, 'filling-live.png'), fullPage: true });
  console.log('Live task: period activation, authenticated WebSocket room, changed input recalculation, reload and submission passed');
  assert.deepEqual(errors, []);
  console.log('Browser: managed catalog, save/publish, Designer injection/save/reopen, native JSON, collaboration snapshot/change propagation and server calculation passed');
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: true, browserErrors: errors, templateVersionId: saved.id, taskId: task.id, revisionId: submitted.revisionId }, null, 2));
  console.log('Evidence:', root);
})().catch(async error => { console.error(error); if (page) { console.error((await page.locator('body').innerText()).slice(-5000)); console.error('Filling state:', await page.evaluate(() => { const vm = document.querySelector('main.filling-page')?.__vueParentComponent?.proxy; return vm ? { ready: vm.ready, connection: vm.connectionState, error: vm.errorText, version: vm.sharedDoc?.version } : null; })); await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }); } console.error('Evidence:', root); process.exitCode = 1; }).finally(async () => { await browser?.close(); server?.close(); db.close(); db.collaborationDb.close(); });
