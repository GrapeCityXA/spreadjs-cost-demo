const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {chromium,expect}=require('@playwright/test');
let browser;
(async()=>{
  const base='http://127.0.0.1:5176', url=base+'/portal/management-dashboard';
  const evidence=await fs.mkdtemp(path.join(os.tmpdir(),'operations-dashboard-browser-'));console.log('Evidence:',evidence);
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'browser-user',password:'browser-password'})}).then(r=>r.json());assert.ok(login.token);
  const headers={authorization:'Bearer '+login.token};
  const data=await fetch(base+'/api/management-dashboard/overview',{headers}).then(r=>r.json());
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1600,height:1100}});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.evaluate(l=>{localStorage.clear();localStorage.setItem('token',l.token);localStorage.setItem('userInfo',JSON.stringify(l.user))},login);
  await page.goto(url);await expect(page.getByRole('heading',{name:'填报与数据看板',exact:true})).toBeVisible();
  await expect(page.locator('.overview-cards article').first().locator('strong')).toHaveText(String(data.tasks.length));
  await page.screenshot({path:path.join(evidence,'overview.png')});
  const quality=page.locator('.quality-panel'), metric=page.locator('.metric-panel'), progress=page.getByRole('region',{name:'全部填报任务进度'});
  await expect(quality).toContainText('未记录');await expect(metric.locator('.metric-chart canvas')).toBeVisible();
  async function choose(name,option) {await metric.locator('.el-select').filter({has:page.getByRole('combobox',{name,exact:true})}).click();await page.getByRole('option',{name:option,exact:true}).click()}
  await choose('指标报告类型','手工体验月报 A');await choose('业务指标字段','本月利润总额');await choose('指标汇总方式','平均值');
  await expect(metric).toContainText('11 万元');await page.reload();await expect(metric).toContainText('本月利润总额 · 平均值');await expect(metric).toContainText('11 万元');
  await metric.getByRole('button',{name:'查看来源',exact:true}).click();await page.getByRole('button',{name:'原表与公式来源',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'填报数据详情'});await expect(dialog).toContainText('当前有效定稿');
  await dialog.getByRole('button',{name:/!B3$/}).click();await expect(dialog.locator('.cell-address')).toContainText('!B3');await expect(dialog.locator('output')).toHaveText('11');
  await dialog.screenshot({path:path.join(evidence,'monthly-source.png')});await page.keyboard.press('Escape');
  await progress.locator('tr').filter({hasText:'浏览器季度验收'}).getByRole('button',{name:'数据详情'}).click();
  await dialog.getByRole('tab',{name:'定稿原表与勾稽分析'}).click();
  try { await expect(dialog.locator('output')).toHaveText('页眉'); } catch(e) { console.log('Legacy dialog:',await dialog.innerText());throw new Error(e.message); }
  const legacy=await page.evaluate(async()=>{const {default:GC}=await import('/node_modules/.vite/deps/@grapecity-software_spread-sheets.js');const book=GC.Spread.Sheets.findControl(document.querySelector('.report-preview'));return {count:book.getSheetCount(),value:book.getSheet(0).getValue(0,0),protected:book.sheets.every(s=>s.options.isProtected)}});
  assert.deepEqual(legacy,{count:3,value:'页眉',protected:true});await dialog.screenshot({path:path.join(evidence,'legacy-workbook.png')});await page.keyboard.press('Escape');
  await quality.locator('tr').filter({hasText:'浏览器季度验收'}).getByRole('button',{name:'检查详情'}).click();await expect(dialog).toContainText('此提交版本未记录前端校验结果');await page.keyboard.press('Escape');
  await page.getByText('季度评分与排名',{exact:true}).click();await expect(page.locator('.score-panel')).toContainText('浏览器验收组织');
  await page.screenshot({path:path.join(evidence,'dashboard.png'),fullPage:true});
  // Future submissions use the same persisted validation contract; only browser responses are replaced.
  const validation={schemaVersion:1,status:'warnings',checkedCount:2,skippedCount:1,issues:[{severity:'warning',message:'数值超出建议范围',sheetName:'业务数据',row:2,col:1}]};
  await page.route('**/api/management-dashboard/overview',route=>route.fulfill({json:{...data,tasks:data.tasks.map(t=>t.taskId===4?{...t,validation}:t)}}));
  await page.route('**/api/management-dashboard/tasks/4/snapshot?*',async route=>{const response=await route.fetch();const body=await response.json();await route.fulfill({json:{...body,validation,checkedAt:'2026-10-12 01:00:00',checkedBy:'提交人'}})});
  await page.goto(url);await expect(quality).toContainText('存在提示');await quality.locator('tr').filter({hasText:'手工体验月报 A'}).filter({hasText:'2027-01'}).getByRole('button',{name:'检查详情'}).click();
  await expect(dialog).toContainText('因不可见跳过 1 个');await expect(dialog).toContainText('数值超出建议范围');await dialog.getByRole('button',{name:'业务数据!B3',exact:true}).click();await expect(dialog.locator('output')).toHaveText('11');
  await page.keyboard.press('Escape');await page.setViewportSize({width:900,height:850});await page.screenshot({path:path.join(evidence,'narrow.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.deepEqual(errors,[]);
  console.log('PASS dashboard: real metrics/source values, saved preferences, legacy workbook restoration, read-only preview, unrecorded validation, warning coordinates, ranking and responsive layout; no page errors.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close()});
