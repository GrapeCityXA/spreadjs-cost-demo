const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { chromium, expect } = require('@playwright/test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-auxiliary-datamanager-'));
Object.assign(process.env, { COST_REPORT_DB_PATH: path.join(root, 'business.db'), COST_REPORT_COLLAB_DB_PATH: path.join(root, 'collaboration.db'), COST_REPORT_TEMPLATE_DIR: path.join(root, 'templates'), COST_REPORT_ARTIFACT_DIR: path.join(root, 'artifacts'), COST_REPORT_BACKUP_DIR: path.join(root, 'backups'), JWT_SECRET: 'auxiliary-isolated-test' });
const db = require('../src/config/database');
const app = require('../src/app');
const collaboration = require('../src/services/collaborationServer');
const sql = (text, args = []) => new Promise((resolve, reject) => db.run(text, args, error => error ? reject(error) : resolve()));
let server, remote, browser, page;
(async () => {
  await db.ready;
  await sql("INSERT INTO users(id,username,password,name,permissions) VALUES(1,'aux-admin','test','辅助表管理员','[]')");
  await sql("INSERT INTO user_roles(user_id,role_code) VALUES(1,'system_admin'),(1,'subsidiary_filler'),(1,'subsidiary_submitter')");
  server = require('http').createServer(app); await collaboration.attach(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let amount = 123, requests = [];
  remote = require('http').createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Type', 'application/json');
    if (req.url === '/fail') { res.statusCode = 500; res.end('{}'); return; }
    res.end(JSON.stringify(req.url === '/empty' ? [] : { data: { items: [{ code: 'A', amount }, { code: 'B', amount: 456 }] } }));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const remoteUrl = `http://127.0.0.1:${remote.address().port}/reference`;
  const base = `http://127.0.0.1:${server.address().port}`, token = jwt.sign({ id: 1 }, process.env.JWT_SECRET);
  async function api(url, body, method = body === undefined ? 'GET' : 'POST', status = 200) {
    const response = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json(); assert.equal(response.status, status, `${url}: ${JSON.stringify(payload)}`); return payload;
  }
  const binding = { engine: 'datamanager', url: remoteUrl, dataPath: 'data.items' };
  const normalize = require('../src/services/auxiliaryDataBinding').normalizeAuxiliaryBinding;
  for (const invalid of [{ ...binding, url: 'file:///test' }, { ...binding, url: 'https://user:pass@example.com' }, { ...binding, dataPath: '__proto__.items' }, { ...binding, data: [1] }]) assert.throws(() => normalize(invalid));
  const permission = JSON.stringify({ platform: 'cost-report-cell-permission-v1', schemaVersion: 1, permission: 'primary_input', visibility: 'visible', editableForRoles: ['system_admin','subsidiary_filler'] });
  const component = await api('/template-governance/components', { code: 'aux_body', name: '辅助表验收主体', componentType: 'body', rowCount: 2, columnCount: 3, cells: [{ row: 0, column: 0, value: 10, tag: permission }, { row: 1, column: 1, formula: 'SUM(A1,2)' }], metadata: {} }, 'POST', 201);
  await api(`/template-governance/components/${component.componentId}/versions/${component.versionId}/submit`, {});
  browser = await chromium.launch({ headless: true }); page = await (await browser.newContext({ viewport: { width: 1540, height: 1080 } })).newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(host => { const Original = window.WebSocket; window.WebSocket = class extends Original { constructor(url, protocols) { const parsed = new URL(url); if (parsed.hostname === '127.0.0.1' && ['5176','5302'].includes(parsed.port) && ![protocols].flat().includes('vite-hmr')) parsed.host = host; super(parsed.href, protocols); } }; }, new URL(base).host);
  await page.route('**/api/**', async route => { const url = new URL(route.request().url()); if (!url.pathname.startsWith('/api/')) return route.continue(); await route.fulfill({ response: await route.fetch({ url: base + url.pathname + url.search, timeout: 90000 }) }); });
  await page.goto('http://127.0.0.1:5176');
  await page.evaluate(token => { localStorage.setItem('token', token); localStorage.setItem('userInfo', JSON.stringify({ id: 1, name: '辅助表管理员', roles: [{ code: 'system_admin' }] })); }, token);
  await page.goto('http://127.0.0.1:5176/portal/template?section=templates');
  await page.getByRole('button', { name: '从组件组合', exact: true }).click();
  await page.evaluate(id => { const vm = document.querySelector('main.governance-page').__vueParentComponent.proxy; vm.templateForm.name = '远程辅助表验收'; vm.templateForm.factory = 'ALL'; vm.templateForm.sheets[0].bodyVersionId = id; vm.addSheet(); vm.templateForm.sheets[1].name = '接口参考'; vm.templateForm.sheets[1].type = 'auxiliary'; vm.onSheetTypeChanged(vm.templateForm.sheets[1]); }, component.versionId);
  await page.getByText('接口数据 · DataManager', { exact: true }).click();
  await page.getByPlaceholder('https://example.com/api/reference-data').fill(remoteUrl);
  await page.getByPlaceholder('根节点是数组时留空，例如 data.items').fill('data.items');
  await page.getByRole('button', { name: '读取并预览', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('2 条记录 · 2 列');
  await page.screenshot({ path: path.join(root, 'dialog.png'), fullPage: true });
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const saved = await page.evaluate(() => { const vm = document.querySelector('main.governance-page').__vueParentComponent.proxy; return { id: vm.templateForm.versionId, templateId: vm.templateForm.templateId }; });
  const read = async () => (await api(`/template-governance/templates/versions/${saved.id}`)).template;
  let detail = await read(); assert.deepEqual(detail.workbook.sheets[1].dataBinding, binding); assert.deepEqual(detail.workbook.sheets[1].cells, []);
  await page.evaluate(id => document.querySelector('main.governance-page').__vueParentComponent.proxy.editTemplate({ versionId: id }), saved.id);
  await expect(page.getByPlaceholder('https://example.com/api/reference-data')).toHaveValue(remoteUrl);
  await page.getByRole('button', { name: '详细修改', exact: true }).click();
  const designerCell = () => page.evaluate(() => document.querySelector('main.workbench')?.__vueParentComponent?.proxy?.spread?.getSheet(1)?.getValue(1,1));
  await expect.poll(designerCell, { timeout: 60000 }).toBe(123);
  assert.equal(await page.evaluate(() => document.querySelector('main.workbench').__vueParentComponent.proxy.spread.getSheet(1).options.isProtected), true);
  await page.evaluate(() => document.querySelector('main.workbench').__vueParentComponent.proxy.spread.getSheet(0).setFormula(1,2,"'接口参考'!B2*2"));
  const ok = await page.evaluate(() => document.querySelector('main.workbench').__vueParentComponent.proxy.saveDirectTemplate(false)); assert.equal(ok, true);
  detail = await read();
  assert.deepEqual(detail.workbook.sheets[1].dataBinding, binding);
  assert.deepEqual(detail.workbook.designerJson.dataManager?.tables || [], []);
  assert.equal(JSON.stringify(detail.workbook.templateSnapshot).includes('auxiliary_source'), false);
  assert.equal(JSON.stringify(detail.workbook.designerJson).includes('456'), false);
  await page.reload(); await expect.poll(designerCell, { timeout: 60000 }).toBe(123);
  await page.screenshot({ path: path.join(root, 'designer.png'), fullPage: true });
  const checks = await api(`/template-governance/templates/versions/${saved.id}/publication-checks`); assert.equal(checks.report.passed, true, JSON.stringify(checks));
  await api(`/template-governance/templates/${saved.templateId}/versions/${saved.id}/submit`, {});
  const organization = await api('/admin/organizations', { code: 'AUX_ORG', name: '辅助表验收组织', organizationType: 'subsidiary', effectiveFrom: '2026-01-01' }, 'POST', 201);
  const reportType = await api('/period-configuration/report-types', { code: 'AUX_MONTHLY', displayName: '辅助表验收月报', cadence: 'monthly' }, 'POST', 201);
  const pkg = await api('/period-configuration/packages', { reportTypeId: reportType.reportTypeId, periodCode: '2027-01', templateVersionId: saved.id, organizations: [{ organizationId: organization.organizationId }], assignments: ['filler','submitter','department_reviewer','approver','finalizer'].map(responsibility => ({ organizationId: organization.organizationId, responsibility, userId: 1 })) }, 'POST', 201);
  await api(`/period-configuration/packages/${pkg.package.id}/activate`, {});
  const task = await db._helpers.get(db, 'SELECT * FROM report_tasks WHERE package_id = ?', [pkg.package.id]);
  await page.goto(`http://127.0.0.1:5176/portal/monthly-filling?taskId=${task.id}`);
  const fillingCell = index => page.evaluate(index => document.querySelector('main.filling-page')?.__vueParentComponent?.proxy?.workbook?.getSheet(index)?.getValue(index === 1 ? 1 : 0, index === 1 ? 1 : 0), index);
  await expect.poll(() => fillingCell(1), { timeout: 60000 }).toBe(123);
  await expect.poll(() => page.evaluate(() => document.querySelector('main.filling-page')?.__vueParentComponent?.proxy?.ready), { timeout: 30000 }).toBe(true);
  const live = await page.evaluate(() => { const vm = document.querySelector('main.filling-page').__vueParentComponent.proxy; return { protected: vm.workbook.getSheet(1).options.isProtected, locked: vm.workbook.getSheet(1).getCell(1,1).locked(), snapshot: JSON.stringify(vm.sharedDoc.data), error: vm.errorText }; });
  assert.equal(live.protected, true); assert.equal(live.locked, true); assert.equal(live.snapshot.includes('auxiliary_source'), false); assert.equal(live.error, '');
  await page.evaluate(() => document.querySelector('main.filling-page').__vueParentComponent.proxy.workbook.getSheet(0).setValue(0,0,20));
  await expect.poll(() => page.evaluate(() => { const vm = document.querySelector('main.filling-page').__vueParentComponent.proxy; return vm.pendingChangeSets === 0 && Number(vm.sharedDoc.version) > 1 && !vm.errorText; }), { timeout: 30000 }).toBe(true);
  amount = 321; await page.reload(); await expect.poll(() => fillingCell(1), { timeout: 60000 }).toBe(321); assert.equal(await fillingCell(0), 20);
  const peer = await page.context().newPage();
  await peer.route('**/api/**', async route => { const url = new URL(route.request().url()); if (!url.pathname.startsWith('/api/')) return route.continue(); await route.fulfill({ response: await route.fetch({ url: base + url.pathname + url.search, timeout: 90000 }) }); });
  await peer.addInitScript(host => { const Original = window.WebSocket; window.WebSocket = class extends Original { constructor(url, protocols) { const parsed = new URL(url); if (parsed.hostname === '127.0.0.1' && ['5176','5302'].includes(parsed.port) && ![protocols].flat().includes('vite-hmr')) parsed.host = host; super(parsed.href, protocols); } }; }, new URL(base).host);
  await peer.goto(`http://127.0.0.1:5176/portal/monthly-filling?taskId=${task.id}`);
  await expect.poll(() => peer.evaluate(() => document.querySelector('main.filling-page')?.__vueParentComponent?.proxy?.ready), { timeout: 60000 }).toBe(true);
  await page.evaluate(() => document.querySelector('main.filling-page').__vueParentComponent.proxy.workbook.getSheet(0).setValue(0,0,30));
  await expect.poll(() => peer.evaluate(() => document.querySelector('main.filling-page').__vueParentComponent.proxy.workbook.getSheet(0).getValue(0,0)), { timeout: 30000 }).toBe(30);
  assert.equal(await peer.evaluate(() => document.querySelector('main.filling-page').__vueParentComponent.proxy.workbook.getSheet(1).getValue(1,1)), 321);
  await expect.poll(() => page.evaluate(() => { const vm = document.querySelector('main.filling-page').__vueParentComponent.proxy; return vm.pendingChangeSets === 0 && !vm.errorText && !vm.precheck?.stale; }), { timeout: 30000 }).toBe(true);
  console.log('Two-client collaboration passed; submitting revision.');
  const submitted = await page.evaluate(async taskId => { const { collaborationApi } = await import('/src/api/index.js'); const vm = document.querySelector('main.filling-page').__vueParentComponent.proxy; return collaborationApi.submitTask(taskId, { expectedVersion: Number(vm.sharedDoc.version), pendingChanges: 0, warningExplanations: [] }, crypto.randomUUID()); }, task.id);
  assert.ok(submitted.revisionId, JSON.stringify(submitted));
  await peer.close();
  await page.screenshot({ path: path.join(root, 'filling.png'), fullPage: true });
  const submittedFile = await db._helpers.get(db, 'SELECT storage_key FROM official_artifacts WHERE revision_id=? AND artifact_type=?', [submitted.revisionId, 'spreadjs_workbook_json']);
  const snapshot = JSON.parse(fs.readFileSync(submittedFile.storage_key, 'utf8'));
  assert.ok(snapshot.collaborationInfo, 'new submission preserves native format marker');
  // Reproduce old archives only in this isolated database. The original OT
  // archive remains intact and supplies this revision's exact metadata.
  delete snapshot.collaborationInfo;
  fs.writeFileSync(submittedFile.storage_key, JSON.stringify(snapshot));
  const submittedBeforeReview = fs.readFileSync(submittedFile.storage_key, 'utf8');
  amount = 654;
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.querySelector('main.filling-page')?.__vueParentComponent?.proxy?.ready), { timeout: 30000 }).toBe(true);
  const submittedFilling = await page.evaluate(() => {
    const sheet = document.querySelector('main.filling-page').__vueParentComponent.proxy.workbook.getSheet(0);
    return { formula: sheet.getFormula(1,1), value: sheet.getValue(1,1), crossFormula: sheet.getFormula(1,2), crossValue: sheet.getValue(1,2) };
  });
  assert.equal(submittedFilling.formula, 'SUM(A1,2)'); assert.equal(submittedFilling.value, 32);
  assert.match(submittedFilling.crossFormula, /B2\*2/); assert.equal(submittedFilling.crossValue, 1308);
  await page.goto(`http://127.0.0.1:5176/portal/monthly-review/${task.id}`);
  const reviewCell = () => page.evaluate(() => document.querySelector('main.review-workbench')?.__vueParentComponent?.proxy?.spread?.getSheet(1)?.getValue(1,1));
  await expect.poll(reviewCell, { timeout: 60000 }).toBe(654);
  const review = await page.evaluate(() => { const vm = document.querySelector('main.review-workbench').__vueParentComponent.proxy; return {
    protected: vm.spread.getSheet(1).options.isProtected, locked: vm.spread.getSheet(1).getCell(1,1).locked(),
    business: vm.spread.getSheet(0).getValue(0,0), formula: vm.spread.getSheet(0).getFormula(1,1), crossValue: vm.spread.getSheet(0).getValue(1,2), binding: vm.detail.auxiliaryContract.sheets[1].dataBinding
  }; });
  assert.equal(review.protected, true); assert.equal(review.locked, true); assert.equal(review.business, 30); assert.deepEqual(review.binding, binding);
  assert.equal(review.formula, 'SUM(A1,2)'); assert.equal(review.crossValue, 1308);
  assert.equal(fs.readFileSync(submittedFile.storage_key, 'utf8'), submittedBeforeReview, 'review must not rewrite submitted snapshot');
  await page.route(remoteUrl, route => route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' }));
  await page.reload();
  await expect(page.getByRole('button', { name: '重试加载辅助表' })).toBeVisible({ timeout: 30000 });
  assert.equal(await page.evaluate(() => document.querySelector('main.review-workbench').__vueParentComponent.proxy.spread.getSheet(0).getValue(0,0)), 30);
  await page.unroute(remoteUrl);
  await page.getByRole('button', { name: '重试加载辅助表' }).click();
  await expect.poll(reviewCell, { timeout: 30000 }).toBe(654);
  await expect(page.getByRole('button', { name: '重试加载辅助表' })).toHaveCount(0);
  const reviewXlsx = await page.evaluate(async () => {
    const blob = await document.querySelector('main.review-workbench').__vueParentComponent.proxy.exportXlsx();
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const exported = new (require('exceljs').Workbook)(); await exported.xlsx.load(Buffer.from(reviewXlsx));
  assert.equal(exported.getWorksheet('接口参考').getCell('B2').value, 654, 'review export retains auxiliary reference values');
  assert.equal(exported.getWorksheet('业务数据').getCell('B2').formula, 'SUM(A1,2)', 'export preserves formulas, not just their values');
  assert.match(exported.getWorksheet('业务数据').getCell('C2').formula, /B2\*2/);
  console.log('Review: pinned auxiliary config, fresh remote read, read-only cells, immutable submitted data, failure notice and retry passed.');
  const probe = await page.evaluate(async remoteUrl => {
    const { default: GC } = await import('/node_modules/.vite/deps/@grapecity-software_spread-sheets.js');
    const { bindAuxiliarySheet, auxiliaryStructureJSON, disposeAuxiliaryData } = await import('/src/template/auxiliaryDataBinding.js');
    const results = {};
    for (const kind of ['empty', 'fail', 'wrongPath']) {
      const book = new GC.Spread.Sheets.Workbook(document.createElement('div'));
      try { results[kind] = await bindAuxiliarySheet(book, book.getActiveSheet(), { dataBinding: { url: kind === 'wrongPath' ? remoteUrl : remoteUrl.replace('/reference', '/' + kind), dataPath: kind === 'wrongPath' ? 'missing' : '' } }, 0); }
      catch (error) { results[kind] = { error: error.message || String(error) }; }
      finally { disposeAuxiliaryData(book); book.destroy(); }
    }
    return results;
  }, remoteUrl);
  assert.equal(probe.empty.rowCount, 0); assert.ok(probe.fail.error); assert.ok(probe.wrongPath.error);
  assert.ok(requests.length >= 5); assert.ok(requests.every(request => !request.authorization)); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: true, browserErrors: errors, templateVersionId: saved.id, taskId: task.id, probe, requestCount: requests.length }, null, 2));
  console.log('PASS: native DataManager GET, nested/empty/error responses, dialog preview, save/reopen, Designer structure separation, publish/activate, live protected auxiliary sheet, business OT edit/reload, no JWT forwarding. Evidence:', root);
})().catch(async error => { console.error(error); if (page) { console.error((await page.locator('body').innerText()).slice(-5000)); await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }); } console.error('Evidence:', root); process.exitCode = 1; }).finally(async () => { await browser?.close(); server?.close(); remote?.close(); db.close(); db.collaborationDb.close(); });



