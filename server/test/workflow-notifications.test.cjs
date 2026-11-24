const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-notifications-'));
Object.assign(process.env, { COST_REPORT_DB_PATH: path.join(root, 'business.db'), COST_REPORT_COLLAB_DB_PATH: path.join(root, 'collaboration.db'),
  COST_REPORT_TEMPLATE_DIR: path.join(root, 'templates'), COST_REPORT_ARTIFACT_DIR: path.join(root, 'artifacts'),
  COST_REPORT_BACKUP_DIR: path.join(root, 'backups'), JWT_SECRET: 'notification-isolated-test-secret', HOST: '127.0.0.1', PORT: '5305' });
const db = require('../src/config/database');
const { recordBusinessAudit } = require('../src/services/businessAudit');
const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function(e) { e ? reject(e) : resolve(this); }));
const wait = ms => new Promise(r => setTimeout(r, ms));
const token = id => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });
const sockets = [];
let child;
const base = 'http://127.0.0.1:5305';
async function until(fn) { for (let i = 0; i < 60; i++) { const value = await fn(); if (value) return value; await wait(100); } throw new Error('Timed out waiting for notification'); }
async function api(id, url, method = 'GET') { const res = await fetch(base + '/api/task-operations' + url, { method, headers: { Authorization: 'Bearer ' + token(id) } }); return { status: res.status, data: await res.json() }; }
async function connect(id, auth = token(id)) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/notifications/socket'); sockets.push(ws);
  const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw))); ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'authenticate', token: auth }));
  return { ws, messages };
}
(async () => {
  await db.ready;
  for (const [id, roles] of [[1,['system_admin','data_administrator','template_designer']], [2,['template_designer']], [3,['subsidiary_filler']], [4,['subsidiary_filler']]]) {
    await run('INSERT INTO users(id,username,password,name,permissions) VALUES(?,?,?,?,?)', [id, 'user'+id, 'test-only', '通知测试用户'+id, '["template"]']);
    for (const role of roles) await run('INSERT INTO user_roles(user_id,role_code) VALUES(?,?)', [id, role]);
  }
  await run("INSERT INTO organizations(id,code,name) VALUES(1,'TEST','通知测试组织')");
  await run("INSERT INTO organizations(id,code,name) VALUES(2,'TEST2','通知测试组织二')");
  await run("INSERT INTO templates(id,name,created_by) VALUES(1,'通知测试模板',1)");
  await run('INSERT INTO template_versions(id,template_id,version,created_by) VALUES(1,1,1,1)');
  await run("INSERT INTO report_types(id,code,display_name,cadence,workflow_profile) VALUES(1,'TEST','通知测试月报','monthly','monthly')");
  await run("INSERT INTO period_packages(id,report_type_id,period_code,template_version_id,created_by) VALUES(1,1,'2030-01',1,1)");
  for (const id of [1,2]) await run(`INSERT INTO report_tasks(id,package_id,report_type_id,organization_id,period_code,deadline_at,template_version_id,configuration_snapshot_json)
    VALUES(?,1,1,?,'2030-01','2030-01-31',1,?)`, [id, id, JSON.stringify({ assignments: [{ responsibility: 'filler', userId: 3 }] })]);
  await run("INSERT INTO field_drafts(id,proposed_code,proposal_json,created_by) VALUES(1,'NOTICE','{\"displayName\":\"实时提醒测试字段\"}',2)");
  child = spawn(process.execPath, ['src/index.js'], { cwd: path.resolve(__dirname, '..'), env: process.env, stdio: ['ignore','pipe','pipe'] });
  let logs = ''; child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  await until(async () => { if (child.exitCode != null) throw new Error(logs); return fetch(base+'/health').then(r => r.ok).catch(()=>false); });
  const admin = await connect(1), outsider = await connect(4);
  await until(() => admin.messages.some(m => m.type === 'ready') && outsider.messages.some(m => m.type === 'ready'));
  const bad = await connect(4, 'invalid'); await until(() => bad.ws.readyState === WebSocket.CLOSED);
  assert.equal(bad.messages.length, 0, 'unauthenticated connection receives no inbox events');
  const expired = await connect(4, jwt.sign({ id: 4 }, process.env.JWT_SECRET, { expiresIn: -1 }));
  await until(() => expired.ws.readyState === WebSocket.CLOSED); assert.equal(expired.messages.length, 0);
  await run('BEGIN IMMEDIATE');
  await recordBusinessAudit({ actor: { id: 2 }, action: 'field_draft.create', objectType: 'field_draft', objectId: 1 });
  await wait(1300);
  assert.equal(admin.messages.filter(m => m.type === 'notifications.changed').length, 0, 'uncommitted audit never publishes');
  await run('COMMIT');
  await until(() => admin.messages.some(m => m.type === 'notifications.changed'));
  const inbox = await api(1, '/notifications'); assert.equal(inbox.status,200);
  const notice = inbox.data.notifications.find(n => n.payload.label === '字段提案待审批');
  assert.ok(notice); assert.equal(notice.payload.target, '/portal/field-catalog?draftId=1&workflowFrom=todo');
  assert.equal((await api(4,'/notifications')).data.notifications.length,0);
  assert.equal(outsider.messages.filter(m => m.type === 'notifications.changed').length,0, 'only the intended recipient receives invalidation');
  assert.equal((await api(4, `/notifications/${notice.id}/read`, 'POST')).status,404);
  const beforeRead = admin.messages.filter(m => m.type === 'notifications.changed').length;
  assert.equal((await api(1, `/notifications/${notice.id}/read`, 'POST')).status,200);
  await until(() => admin.messages.filter(m => m.type === 'notifications.changed').length > beforeRead);
  assert.equal((await api(1,'/notifications')).data.unreadCount,0);
  await recordBusinessAudit({ actor: { id: 1 }, action: 'period_package.activate', objectType: 'period_package', objectId: 1 });
  await until(async () => (await api(3,'/notifications')).data.notifications.length === 2);
  const filler = await connect(3); await until(() => filler.messages.some(m => m.type === 'ready'));
  const offline = await api(3,'/notifications');
  assert.equal(offline.data.unreadCount,2,'offline inbox survives until reconnect');
  assert.deepEqual(offline.data.notifications.map(n=>n.payload.target).sort(), ['/portal/monthly-filling?taskId=1&workflowFrom=todo','/portal/monthly-filling?taskId=2&workflowFrom=todo']);
  await wait(1500); assert.equal((await api(3,'/notifications')).data.notifications.length,2,'cursor prevents duplicate deliveries');
  await run("UPDATE report_tasks SET configuration_snapshot_json='{}'");
  assert.equal((await api(3,'/notifications')).data.notifications.length,0,'removed assignee no longer sees task details');
  const { createWorkflowNotifications } = require('../src/services/workflowNotifications');
  await createWorkflowNotifications(db).processEvents();
  assert.equal((await api(1,'/notifications')).data.notifications.length,1,'restarting a worker does not replay notifications');
  await run('BEGIN IMMEDIATE');
  await recordBusinessAudit({ actor: { id: 2 }, action: 'field_draft.correct', objectType: 'field_draft', objectId: 1 });
  await run('ROLLBACK'); await wait(1300);
  assert.equal((await api(1,'/notifications')).data.notifications.length,1,'rolled-back event has no delivery');
  await run("UPDATE template_versions SET status='in_review',created_by=2 WHERE id=1");
  await recordBusinessAudit({ actor: { id: 2 }, action: 'template.submit', objectType: 'template', objectId: 1, businessVersion: '1' });
  await until(async () => (await api(1,'/notifications')).data.notifications.some(n => n.payload.target === '/portal/template?section=templates&notificationVersionId=1&workflowFrom=todo'));
  assert.ok(!(await api(2,'/notifications')).data.notifications.some(n => n.payload.action === 'template.submit'), 'designers do not receive governance approval todos');
  await run("UPDATE template_versions SET status='published',reviewed_by=1 WHERE id=1");
  await recordBusinessAudit({ actor: { id: 1 }, action: 'template.approve', objectType: 'template', objectId: 1, businessVersion: '1' });
  await until(async () => (await api(2,'/notifications')).data.notifications.some(n => n.payload.action === 'template.approve'));
  console.log('PASS: committed delivery, recipient isolation, auth, ownership, deep links, read sync, offline recovery, deduplication, revoked access and rollback');
  console.log('Preserved test data:', root);
})().catch(error => { console.error(error); process.exitCode=1; }).finally(async () => {
  for (const ws of sockets) ws.terminate(); child?.kill();
  await new Promise(resolve => db.close(resolve)); await new Promise(resolve => db.collaborationDb.close(resolve));
});
