const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-job-multiprocess-'));
Object.assign(process.env, {
  COST_REPORT_DB_PATH: path.join(root, 'business.db'),
  COST_REPORT_COLLAB_DB_PATH: path.join(root, 'collaboration.db'),
  COST_REPORT_TEMPLATE_DIR: path.join(root, 'templates'),
  COST_REPORT_ARTIFACT_DIR: path.join(root, 'artifacts'),
});
const db = require('../src/config/database');
const service = require('../src/services/reportStudio');
const sql = (s, a = []) => new Promise((resolve, reject) => db.run(s, a, function(e) { e ? reject(e) : resolve(this); }));
const row = (s, a = []) => new Promise((resolve, reject) => db.get(s, a, (e, r) => e ? reject(e) : resolve(r)));
const job = id => row('SELECT * FROM report_studio_jobs WHERE id=?', [id]);
const actor = { id: 1, roles: [{ code: 'system_admin', organizationId: null }] };
const workers = [];
function worker() {
  const child = fork(path.join(__dirname, 'helpers/report-job-worker.cjs'), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  workers.push(child);
  let sequence = 0;
  const pending = new Map();
  child.on('message', message => {
    if (message.event) child.emit(message.event);
    else {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      message.error ? request.reject(new Error(message.error)) : request.resolve();
    }
  });
  child.on('exit', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('worker exited')); }
    pending.clear();
  });
  child.request = command => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`worker ${command} timed out`)); }, 25000);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, command });
  });
  return child;
}
const enqueue = async () => (await service.enqueue(actor, { templateId: 1, reportTypeId: 1, periodCode: '2027-01', organizationIds: [1] })).id;
async function rendering(child, processing) {
  // Surface an early processing failure instead of hanging on a missing event.
  await Promise.race([once(child, 'rendering'), processing.then(() => { throw new Error('job never rendered'); })]);
}

test('independent report schedulers preserve live jobs, recover expired workers and fence stale completion', { timeout: 60000 }, async () => {
  try {
    await service.initialize();
    await sql("INSERT INTO users(id,username,password,name) VALUES(1,'job-admin','test','任务管理员')");
    await sql("INSERT INTO user_roles(user_id,role_code) VALUES(1,'system_admin')");
    await sql("INSERT INTO organizations(id,code,name) VALUES(1,'A','测试组织')");
    await sql("INSERT INTO templates(id,name,created_by) VALUES(1,'业务模板',1)");
    await sql("INSERT INTO template_versions(id,template_id,version,status,workbook_json,created_by) VALUES(1,1,1,'published',?,1)", [JSON.stringify({ sheets: [{ name: '主表', code: 'MAIN', type: 'business' }] })]);
    await sql("INSERT INTO report_types(id,code,display_name,cadence,workflow_profile) VALUES(1,'monthly','月报','monthly','monthly')");
    await sql("INSERT INTO period_packages(id,report_type_id,period_code,template_version_id,created_by,status) VALUES(1,1,'2027-01',1,1,'active')");
    await sql("INSERT INTO field_definitions(id,code,display_name,data_type,status) VALUES(1,'TOTAL','合计','decimal','approved')");
    await sql("INSERT INTO report_tasks(id,package_id,report_type_id,organization_id,period_code,deadline_at,configuration_snapshot_json,template_version_id,task_status) VALUES(1,1,1,1,'2027-01','2027-02-10','{}',1,'finalized')");
    await sql("INSERT INTO business_revisions(id,task_id,revision_number,revision_status,is_current_effective) VALUES(1,1,1,'finalized',1)");
    await sql("INSERT INTO business_values(revision_id,task_id,field_definition_id,value_type,decimal_value,source_sheet) VALUES(1,1,1,'decimal','10','MAIN')");
    fs.mkdirSync(path.join(root, 'artifacts'));
    const source = path.join(root, 'artifacts', 'source.json');
    fs.writeFileSync(source, JSON.stringify({ sheets: { main: { name: '主表' } } }));
    await sql("INSERT INTO official_artifacts(id,revision_id,artifact_type,storage_key,sha256,byte_size) VALUES(1,1,'spreadjs_workbook_json',?,'test',1)", [source]);
    await sql('UPDATE business_revisions SET workbook_artifact_id=1 WHERE id=1');
    await sql('UPDATE report_tasks SET current_revision_id=1 WHERE id=1');
    await sql("INSERT INTO report_studio_templates(id,family_id,name,version,status,template_json,created_by) VALUES(1,'test','测试报表',1,'published',?,1)", [JSON.stringify({ schemaVersion: 1, sheets: [{ name: '报表', json: {} }] })]);

    const a = worker(), b = worker();
    const first = await enqueue();
    const processing = a.request('tick');
    await rendering(a, processing);
    const claimed = await job(first);
    assert.equal(claimed.status, 'running');
    assert.ok(claimed.worker_id);
    await b.request('start');
    await b.request('stop'); // stop waits for the initial startup tick too
    await b.request('tick');
    assert.equal((await job(first)).status, 'running', 'startup and polling cannot interrupt another worker');
    await new Promise(resolve => setTimeout(resolve, 10500));
    assert.ok((await job(first)).lease_expires_at > claimed.lease_expires_at, 'a long-running render renews its lease');
    await a.request('release');
    await processing;
    const completed = await job(first);
    assert.equal(completed.status, 'complete');
    assert.ok(fs.existsSync(path.join(root, 'artifacts', 'report-studio', completed.artifact_key, 'report.xlsx')));
    assert.equal((await row("SELECT COUNT(*) AS n FROM business_audit_events WHERE action='report_generation.completed' AND object_id=?", [first])).n, 1);

    const crashed = await enqueue();
    const crashing = a.request('tick');
    const expectedExit = assert.rejects(crashing, /worker exited/);
    await rendering(a, crashing);
    const exit = once(a, 'exit'); a.kill(); await exit; await expectedExit;
    await sql('UPDATE report_studio_jobs SET lease_expires_at=? WHERE id=?', [Date.now() - 1, crashed]);
    await b.request('tick');
    assert.equal((await job(crashed)).status, 'failed', 'expired crashed workers are recovered');

    const stale = await enqueue();
    const staleProcessing = b.request('tick');
    await rendering(b, staleProcessing);
    await sql('UPDATE report_studio_jobs SET lease_expires_at=? WHERE id=?', [Date.now() - 1, stale]);
    await service.tick();
    await b.request('release'); await staleProcessing;
    assert.equal((await job(stale)).status, 'failed');
    assert.equal((await row("SELECT COUNT(*) AS n FROM business_audit_events WHERE action='report_generation.completed' AND object_id=?", [stale])).n, 0, 'stale completion cannot produce a false success audit');

    // A fresh job still succeeds after recovery; two simultaneous claims render it once.
    const c = worker();
    const next = await enqueue();
    let renders = 0;
    for (const child of [b, c]) child.once('rendering', () => { renders++; child.request('release').catch(() => {}); });
    await Promise.all([b.request('tick'), c.request('tick')]);
    assert.equal(renders, 1);
    assert.equal((await job(next)).status, 'complete');
    await Promise.all([b.request('close'), c.request('close')]);
  } finally {
    for (const child of workers) if (child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise(resolve => db.close(resolve));
    await new Promise(resolve => db.collaborationDb.close(resolve));
  }
});
