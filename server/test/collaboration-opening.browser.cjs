const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
let browser;
(async () => {
  const base = 'http://127.0.0.1:5176', taskId = 7;
  const evidence = await fs.mkdtemp(path.join(os.tmpdir(), 'collaboration-opening-')); console.log('Evidence:', evidence);
  const login = await fetch(base+'/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'browser-user',password:'browser-password'})}).then(r=>r.json()); assert.ok(login.token);
  const readRoom = () => fetch(base+`/api/collaboration/tasks/${taskId}/room`, {headers:{authorization:'Bearer '+login.token}}).then(r=>r.json());
  const before = await readRoom();
  assert.ok(!before.task.configuration.assignments.some(a=>a.responsibility==='filler' && a.userId===login.user.id),'use an assigned submitter who will not initialize or edit the shared workbook');
  browser = await chromium.launch({headless:true}); const page = await browser.newPage({viewport:{width:1500,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let blocked = true;
  // Simulate a proxy accepting a socket but never returning a room response.
  await page.routeWebSocket('**/collaboration/**', socket => { if (!blocked) socket.connectToServer(); });
  await page.goto(base); await page.evaluate(l=>{localStorage.setItem('token',l.token);localStorage.setItem('userInfo',JSON.stringify(l.user))},login);
  await page.goto(base+`/portal/monthly-filling?taskId=${taskId}&workflowFrom=todo`);
  await expect(page.getByRole('alert')).toContainText('协作连接超时',{timeout:25000});
  await expect(page.locator('.loading-panel')).toHaveCount(0);
  await page.screenshot({path:path.join(evidence,'timeout.png')});
  blocked = false;
  await page.getByRole('button',{name:'重新打开协作房间',exact:true}).click();
  await expect(page.locator('.workbench-layout')).toBeVisible({timeout:20000});
  const state=await page.locator('main').evaluate(e=>{const vm=e.__vueParentComponent.proxy;return {ready:vm.ready,loading:vm.loading,connected:vm.connectionState,sheets:vm.workbook.getSheetCount()}});
  assert.deepEqual(state,{ready:true,loading:false,connected:'已连接',sheets:before.workbook.sheets.length});
  await expect(page.locator('.spread-host canvas').first()).toBeVisible();
  await page.screenshot({path:path.join(evidence,'opened.png')});
  // Verify the real Vite proxy again without WebSocket interception.
  const real=await browser.newPage();real.on('pageerror',e=>errors.push(e.message));await real.goto(base);
  await real.evaluate(l=>{localStorage.setItem('token',l.token);localStorage.setItem('userInfo',JSON.stringify(l.user))},login);
  await real.goto(base+`/portal/monthly-filling?taskId=${taskId}&workflowFrom=todo`);
  await expect(real.locator('.workbench-layout')).toBeVisible({timeout:20000});
  // Leaving a stalled room must not let its late timeout overwrite the next task.
  blocked = true;
  await page.reload();
  await expect.poll(()=>page.locator('main').evaluate(e=>Boolean(e.__vueParentComponent?.proxy.sharedDoc)),{timeout:10000}).toBe(true);
  await page.locator('main').evaluate(e=>e.__vueParentComponent.proxy.$router.push({path:'/portal/monthly-filling',query:{taskId:4}}));
  await expect(page.locator('.workbench-layout')).toBeVisible({timeout:20000});
  await page.waitForTimeout(16000);
  await expect(page.locator('.workbench-layout')).toBeVisible();
  await expect(page.getByRole('alert').filter({hasText:'协作连接超时'})).toHaveCount(0);
  assert.equal((await readRoom()).room.currentVersion,before.room.currentVersion,'opening/timeout/retry must preserve shared data');
  assert.deepEqual(errors,[]);
  console.log('PASS real room opens through Vite WebSocket proxy; failed initial connection times out with retry; retry opens the workbook without changing shared version; no page errors.');
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(async()=>{await browser?.close()});
