const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const jwt = require('jsonwebtoken');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finalized-data-'));
Object.assign(process.env, { COST_REPORT_DB_PATH: path.join(root, 'business.db'), COST_REPORT_COLLAB_DB_PATH: path.join(root, 'collaboration.db'), COST_REPORT_TEMPLATE_DIR: path.join(root, 'templates'), COST_REPORT_ARTIFACT_DIR: path.join(root, 'artifacts'), COST_REPORT_BACKUP_DIR: path.join(root, 'backups'), JWT_SECRET: 'isolated-finalized-data-test' });
const db = require('../src/config/database');
const app = require('../src/app');
const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function(error) { error ? reject(error) : resolve(this); }));
let server, base;
async function api(userId, url) {
  const response = await fetch(base + '/api/collaboration' + url, { headers: userId ? { authorization: 'Bearer ' + jwt.sign({ id: userId }, process.env.JWT_SECRET) } : {} });
  return { status: response.status, data: await response.json() };
}
(async () => {
  await db.ready;
  for (const [id, role] of [[1, 'system_admin'], [2, 'subsidiary_filler'], [3, 'report_finalizer']]) {
    await run('INSERT INTO users(id,username,password,name,permissions) VALUES(?,?,?,?,?)', [id, 'finalized' + id, 'test-only', '测试' + id, '[]']);
    await run('INSERT INTO user_roles(user_id,role_code) VALUES(?,?)', [id, role]);
  }
  await run("INSERT INTO organizations(id,code,name) VALUES(1,'ORG','测试公司'),(2,'OTHER','其他公司')");
  await run("INSERT INTO templates(id,name,created_by) VALUES(1,'测试模板',1)");
  await run("INSERT INTO template_versions(id,template_id,version,created_by,workbook_json) VALUES(1,1,1,1,'{}')");
  await run("INSERT INTO report_types(id,code,display_name,cadence,workflow_profile) VALUES(1,'MONTHLY','月报','monthly','monthly')");
  await run("INSERT INTO period_packages(id,report_type_id,period_code,template_version_id,created_by) VALUES(1,1,'2030-01',1,1)");
  for (const id of [1, 2]) await run("INSERT INTO report_tasks(id,package_id,report_type_id,organization_id,period_code,template_version_id,deadline_at,configuration_snapshot_json) VALUES(?,1,1,?,'2030-01',1,'2030-02-01',?)", [id, id, JSON.stringify({ assignments: id === 1 ? [{ responsibility: 'finalizer', userId: 3 }] : [] })]);
  await run("INSERT INTO business_revisions(id,task_id,revision_number,revision_status,is_current_effective,submitted_at,finalized_at) VALUES(1,1,1,'finalized',0,'2030-01-01','2030-01-02'),(2,1,2,'finalized',1,'2030-01-03','2030-01-04'),(3,1,3,'draft',0,NULL,NULL),(4,2,1,'finalized',1,'2030-01-05','2030-01-06')");
  await run("UPDATE report_tasks SET current_revision_id=3,task_status='draft' WHERE id=1");
  await run("UPDATE report_tasks SET current_revision_id=4,task_status='finalized' WHERE id=2");
  fs.mkdirSync(process.env.COST_REPORT_ARTIFACT_DIR, { recursive: true });
  for (const revisionId of [1, 2, 4]) {
    const file = path.join(process.env.COST_REPORT_ARTIFACT_DIR, revisionId + '.json');
    fs.writeFileSync(file, JSON.stringify({ sheets: { Sheet1: { name: 'Sheet1', data: { dataTable: { 0: { 0: { value: revisionId } } } } } } }));
    await run("INSERT INTO official_artifacts(revision_id,artifact_type,storage_key,sha256,byte_size) VALUES(?,'finalized_workbook_json',?,'test',1)", [revisionId, file]);
    await run("INSERT INTO review_opinion_items(revision_id,review_item_key,department_code,reviewer_id,opinion,disposition,version) VALUES(?,'monthly:submission','REVIEW',1,?,'accept',1)", [revisionId, '修订意见' + revisionId]);
  }
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await api(null, '/finalized-tasks')).status, 401);
  assert.equal((await api(2, '/finalized-tasks')).status, 403);
  const tasks = await api(1, '/finalized-tasks');
  assert.equal(tasks.status, 200); assert.equal(tasks.data.tasks.length, 2);
  assert.equal(tasks.data.tasks.find(t => t.id === 1).revisionNumber, 2, 'reopened task retains its finalized history');
  assert.equal((await api(3, '/finalized-tasks')).data.tasks.length, 1, 'only assigned task visible');
  assert.equal((await api(3, '/tasks/2/revisions/4')).status, 403);
  assert.equal((await api(1, '/tasks/1/revisions/4')).status, 404, 'cross-task revision rejected');
  assert.equal((await api(1, '/tasks/1/revisions/3')).status, 404, 'draft cannot be viewed as finalized');
  assert.equal((await api(1, '/tasks/1/revisions/no-id')).status, 400);
  for (const id of [1, 2]) {
    const detail = await api(3, '/tasks/1/revisions/' + id);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.revision.id, id);
    assert.equal(detail.data.revision.isCurrentEffective, id === 2);
    assert.equal(detail.data.revision.submittedAt, id === 1 ? '2030-01-01' : '2030-01-03');
    assert.equal(detail.data.opinions[0].opinion, '修订意见' + id);
    assert.equal(detail.data.workbook.sheets.Sheet1.data.dataTable[0][0].value, id);
  }
  console.log('PASS finalized data: authentication, task assignment, reopened history, exact revision, opinions and workbook.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.close(resolve));
  await new Promise(resolve => db.collaborationDb.close(resolve));
  console.log('Isolated test data:', root);
});
