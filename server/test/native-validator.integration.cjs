const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { chromium } = require('@playwright/test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-native-validator-'));
Object.assign(process.env, { COST_REPORT_DB_PATH: path.join(root, 'business.db'), COST_REPORT_COLLAB_DB_PATH: path.join(root, 'collaboration.db'), COST_REPORT_TEMPLATE_DIR: path.join(root, 'templates'), COST_REPORT_ARTIFACT_DIR: path.join(root, 'artifacts'), COST_REPORT_BACKUP_DIR: path.join(root, 'backups'), JWT_SECRET: 'native-validator-isolated' });
const db = require('../src/config/database');
const app = require('../src/app');
const run = (sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
let server, browser, page;
(async()=>{
  await db.ready;
  await run("INSERT INTO users(id,username,password,name,permissions) VALUES(1,'native-validator-admin','test','校验管理员','[]')");
  await run("INSERT INTO user_roles(user_id,role_code) VALUES(1,'system_admin')");
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const token=jwt.sign({id:1},process.env.JWT_SECRET);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1480,height:1060}});
  const errors=[];page.on('response',async r=>{if(r.url().includes('/api/')&&r.status()>=400) console.error('API',r.status(),r.url(),await r.text())});page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{const url=new URL(route.request().url());if(!url.pathname.startsWith('/api/')) return route.continue();await route.fulfill({response:await route.fetch({url:base+url.pathname+url.search})})});
  await page.goto('http://127.0.0.1:5176');
  const probes=await page.evaluate(async()=>{
    const m=await import('/src/template/nativeValidator.js'); const {default:GC}=await import('/node_modules/.vite/deps/@grapecity-software_spread-sheets.js');await import('/node_modules/.vite/deps/@grapecity-software_spread-sheets-collaboration-addon.js');
    const specs=[
      {type:'number',operator:3,value1:'0',values:[100.25,-1],expected:[true,false]},
      {type:'integer',operator:6,value1:'0',value2:'100',values:[10,1.25],expected:[true,false]},
      {type:'date',operator:6,value1:'2026-01-01',value2:'2026-12-31',values:['2026-06-01','2027-01-01'],expected:[true,false]},
      {type:'list',list:'是,否',values:['是','未知'],expected:[true,false]},
      {type:'textLength',operator:5,value1:'3',values:['abc','abcd'],expected:[true,false]},
      {type:'formula',formula:'A1>=B1',cells:[[null,10]],values:[12,9],expected:[true,false]},
      {type:'formulaList',formula:'$B$1:$B$2',cells:[[null,'甲'],[null,'乙']],values:['甲','丙'],expected:[true,false]}
    ];
    const results=specs.map(spec=>{const expression=m.serializeValidator({...m.defaultValidatorConfig(),...spec});return {type:spec.type,results:m.testNativeRule(expression,spec.values.map((value,i)=>({name:String(i),input:{value,cells:spec.cells},expected:spec.expected[i]})))}});
    const book=new GC.Spread.Sheets.Workbook(document.createElement('div'),{sheetCount:1});const sheet=book.getSheet(0);sheet.setRowCount(6);sheet.setColumnCount(4);
    const expression=m.serializeValidator(m.defaultValidatorConfig());m.applyNativeRule(sheet,[{row:1,col:1,rowCount:2,colCount:1}],expression);sheet.setValue(1,1,-1);sheet.setValue(2,1,-2);
    const initial=m.validateNativeCells(book);const json=JSON.parse(JSON.stringify(book.toJSON()));const copy=new GC.Spread.Sheets.Workbook(document.createElement('div'),{sheetCount:1});await copy.fromJSON(json);const reloaded=m.validateNativeCells(copy);
    const snapshot=JSON.parse(JSON.stringify(book.collaboration.toSnapshot()));const collab=new GC.Spread.Sheets.Workbook(document.createElement('div'),{sheetCount:1});collab.collaboration.fromSnapshot(snapshot);const collaborative=m.validateNativeCells(collab);
    m.applyNativeRule(sheet,[{row:1,col:1,rowCount:2,colCount:1}],m.serializeValidator({...m.defaultValidatorConfig(),errorStyle:1}));const warnings=m.validateNativeCells(book);
    const partial=m.validateNativeCells(book,(_s,row)=>row!==2);
    const tag=sheet.getTag(1,1);book.destroy();copy.destroy();collab.destroy();return {results,initial,reloaded,collaborative,warnings,partial,tag,expression,json,snapshot};
  });
  for(const spec of probes.results) assert.ok(spec.results.every(r=>r.passed),JSON.stringify(spec));
  for(const key of ['initial','reloaded','collaborative'])assert.equal(probes[key].errors.length,2,key);
  assert.equal(probes.warnings.errors.length,0);assert.equal(probes.warnings.hints.length,2);assert.ok(probes.tag==null,'native validators must not need tags');
  assert.equal(probes.initial.checkedCount,2);assert.equal(probes.initial.skippedCount,0);
  assert.equal(probes.partial.checkedCount,1);assert.equal(probes.partial.skippedCount,1);assert.equal(probes.partial.hints.length,1);
  assert.equal(probes.partial.hints[0].row,1);assert.equal(probes.partial.hints[0].col,1);assert.ok(probes.partial.hints[0].sheetName);
  fs.writeFileSync(path.join(root,'native-roundtrip.json'),JSON.stringify(probes,null,2));
  await page.evaluate(({token})=>{localStorage.setItem('token',token);localStorage.setItem('userInfo',JSON.stringify({id:1,username:'native-validator-admin',name:'校验管理员',roles:[{code:'system_admin'}]}))},{token});
  await page.goto('http://127.0.0.1:5176/portal/rule-catalog');await page.getByRole('button',{name:'新建规则',exact:true}).click();
  await page.getByPlaceholder('例如 REVENUE_COMPLETION').fill('NATIVE_NONNEGATIVE');await page.getByPlaceholder('例如：收入完成率').fill('非负数原生校验');
  await page.getByRole('button',{name:'运行测试',exact:true}).click();await page.getByText('规则测试全部通过',{exact:true}).waitFor();
  await page.screenshot({path:path.join(root,'visual-editor.png'),fullPage:true});
  await page.getByRole('button',{name:'提交发布',exact:true}).click();await page.getByText('规则已免审发布',{exact:true}).waitFor();
  async function api(url,body,method=body?'POST':'GET'){const response=await fetch(base+'/api'+url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();assert.ok(response.ok,`${url}: ${JSON.stringify(data)}`);return data}
  const catalog=await api('/rules/catalog');const rule=catalog.rules.find(r=>r.code==='NATIVE_NONNEGATIVE');assert.equal(rule.status,'published');assert.equal(rule.expression.engine,'spreadjs-validator');
  const ruleJson=await page.evaluate(async expression=>{const m=await import('/src/template/nativeValidator.js');return m.restoreValidator(expression).toJSON()},rule.expression);assert.ok(ruleJson.condition);
  const next=await api(`/rules/${rule.ruleId}/versions`,{...rule,expression:{...rule.expression,config:{...rule.expression.config,value1:'2'}}});
  const premature=await fetch(base+`/api/rules/versions/${next.versionId}/submit`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});assert.equal(premature.status,409,'untested version cannot publish');
  await page.goto('http://127.0.0.1:5176/portal/template-workbench?mode=template&new=true');
  await page.waitForFunction(()=>{const el=document.querySelector('main.workbench');return el?.__vueParentComponent?.proxy?.spread != null});
  await page.getByPlaceholder('例如：月度经营报表').fill('原生校验完整模板');
  await page.evaluate(ruleId=>{const vm=document.querySelector('main.workbench').__vueParentComponent.proxy; const sheet=vm.spread.getActiveSheet();sheet.setRowCount(8);sheet.setColumnCount(6);sheet.setSelection(1,1,2,1);vm.selectedNativeRuleId=ruleId;vm.switchInspector('cell');},rule.versionId);
  await page.getByRole('button',{name:'应用到选中区域',exact:true}).click();
  assert.equal(await page.evaluate(()=>{const vm=document.querySelector('main.workbench').__vueParentComponent.proxy; return vm.spread.getActiveSheet().getDataValidator(2,1)?.isValid(vm.spread.getActiveSheet(),2,1,-1)}),false);
  const saved=await page.evaluate(async()=>{const vm=document.querySelector('main.workbench').__vueParentComponent.proxy;const ok=await vm.saveDirectTemplate(false);return {ok,id:vm.templateVersionId,templateId:vm.templateId}});assert.equal(saved.ok,true);
  await page.goto(`http://127.0.0.1:5176/portal/template-workbench?mode=template&templateVersionId=${saved.id}`);
  await page.waitForFunction(()=>document.querySelector('main.workbench')?.__vueParentComponent?.proxy?.spread?.getActiveSheet()?.getDataValidator(2,1));
  const detail=await api(`/template-governance/templates/versions/${saved.id}`);assert.equal(detail.template.workbook.sheets[0].mappings.length,0);
  const checks=await api(`/template-governance/templates/versions/${saved.id}/publication-checks`);assert.equal(checks.report.passed,true,JSON.stringify(checks));
  const published=await api(`/template-governance/templates/${saved.templateId}/versions/${saved.id}/submit`,{});assert.equal(published.status,'published');
  await page.screenshot({path:path.join(root,'designer-applied.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,root,nativeTypes:probes.results.map(r=>r.type),ruleVersionId:rule.versionId}));
})().catch(async e=>{console.error(e); if(page){console.error('PAGE',page.url(),(await page.locator('body').innerText()).slice(0,3000));await page.screenshot({path:path.join(root,'failure.png')})} process.exitCode=1}).finally(async()=>{await browser?.close();server?.close();db.close();});
