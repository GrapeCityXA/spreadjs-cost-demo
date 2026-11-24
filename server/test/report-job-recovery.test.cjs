const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-job-recovery-'));
Object.assign(process.env, { COST_REPORT_DB_PATH: path.join(root, 'business.db'),
  COST_REPORT_COLLAB_DB_PATH: path.join(root, 'collaboration.db'), COST_REPORT_TEMPLATE_DIR: path.join(root, 'templates') });
const db = require('../src/config/database');
const service = require('../src/services/reportStudio');
const nativeRun = db.run;
const sql = (connection, statement, args = []) => new Promise((resolve, reject) => nativeRun.call(connection, statement, args, function(error) { error ? reject(error) : resolve(this); }));
const job = id => new Promise((resolve, reject) => db.get('SELECT * FROM report_studio_jobs WHERE id=?', [id], (e,r) => e ? reject(e) : resolve(r)));
const enqueue = async () => (await sql(db, "INSERT INTO report_studio_jobs(template_id,query_json,requested_by) VALUES(1,'{}',1)")).lastID;
let locker;
(async () => {
  await service.initialize();
  db.configure('busyTimeout', 20);
  await sql(db, "INSERT INTO users(id,username,password,name) VALUES(1,'job-user','test','任务测试')");
  await sql(db, "INSERT INTO report_studio_templates(id,family_id,name,version,status,template_json,created_by) VALUES(1,'test','测试模板',1,'published','{}',1)");
  // This user has no design/read role: execution must finish with a permission error.
  locker = new sqlite3.Database(process.env.COST_REPORT_DB_PATH);
  const first = await enqueue();
  let locked, attempts = 0;
  const lockReady = new Promise(resolve => { locked = resolve; });
  db.run = function(statement, ...args) {
    if (statement.includes("SET status='failed',error_text=?")) {
      attempts++;
      if (attempts === 1) {
        sql(locker, 'BEGIN IMMEDIATE').then(() => { locked(); nativeRun.call(this, statement, ...args); });
        return this;
      }
    }
    return nativeRun.call(this, statement, ...args);
  };
  const processing = service.tick();
  await lockReady;
  await service.tick();
  assert.equal((await job(first)).status, 'running', 'a concurrent tick must not recover an active worker');
  await new Promise(resolve => setTimeout(resolve, 75));
  await sql(locker, 'ROLLBACK');
  await processing;
  assert.ok(attempts >= 2, 'actual SQLite lock causes a terminal-write retry');
  assert.equal((await job(first)).status, 'failed');
  assert.match((await job(first)).error_text, /无权/);
  db.run = nativeRun;

  const second = await enqueue();
  attempts = 0;
  db.run = function(statement, ...args) {
    if (statement.includes("SET status='failed',error_text=?") && ++attempts === 1) {
      sql(locker, 'BEGIN IMMEDIATE').then(() => nativeRun.call(this, statement, ...args));
      return this;
    }
    return nativeRun.call(this, statement, ...args);
  };
  await assert.rejects(service.tick(), { code: 'SQLITE_BUSY' });
  assert.equal((await job(second)).status, 'running', 'reproduce abandoned running state after persistent lock');
  await sql(locker, 'ROLLBACK');
  db.run = nativeRun;
  const third = await enqueue();
  await service.tick();
  assert.equal((await job(second)).status, 'failed');
  assert.match((await job(second)).error_text, /生成任务已中断/);
  assert.equal((await job(third)).status, 'failed', 'queue continues processing the next job');
  assert.match((await job(third)).error_text, /无权/);
  assert.ok((await job(second)).completed_at);
  console.log(JSON.stringify({ passed: true, root, transientLockRetry: true, persistentLockRecovery: true, activeWorkerPreserved: true, queueContinues: true }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  db.run = nativeRun;
  if (locker) await new Promise(resolve => locker.close(resolve));
  await new Promise(resolve => db.close(resolve));
  await new Promise(resolve => db.collaborationDb.close(resolve));
});
