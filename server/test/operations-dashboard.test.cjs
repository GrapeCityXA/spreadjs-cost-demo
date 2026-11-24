const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const jwt = require('jsonwebtoken');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operations-dashboard-'));
Object.assign(process.env, { COST_REPORT_DB_PATH: path.join(root,'business.db'), COST_REPORT_COLLAB_DB_PATH: path.join(root,'collaboration.db'), COST_REPORT_TEMPLATE_DIR: path.join(root,'templates'), COST_REPORT_ARTIFACT_DIR: path.join(root,'artifacts'), COST_REPORT_BACKUP_DIR: path.join(root,'backups'), JWT_SECRET: 'isolated-dashboard-test' });
const db = require('../src/config/database');
const app = require('../src/app');
const run = (sql,args=[]) => new Promise((resolve,reject)=>db.run(sql,args,function(e){e?reject(e):resolve(this)}));
let server,base;
async function api(id,url) {
  const r=await fetch(base+'/api/management-dashboard'+url,{headers:id?{authorization:'Bearer '+jwt.sign({id},process.env.JWT_SECRET)}:{}});
  return {status:r.status,data:await r.json()};
}
(async()=>{
  await db.ready;
  for(const [id,role] of [[1,'system_admin'],[2,'subsidiary_filler'],[3,'report_finalizer']]) {
    await run('INSERT INTO users(id,username,password,name,permissions) VALUES(?,?,?,?,?)',[id,'dashboard'+id,'test-only','测试'+id,'[]']);
    await run('INSERT INTO user_roles(user_id,role_code) VALUES(?,?)',[id,role]);
  }
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
  const emptyAdmin = await api(1,'/overview');
  assert.equal(emptyAdmin.status,200);
  assert.equal(emptyAdmin.data.tasks.length,0);
  assert.equal(emptyAdmin.data.canManage,true,'empty task sets must retain role authority');
  await run("INSERT INTO organizations(id,code,name) VALUES(1,'D','测试公司')");
  await run("INSERT INTO templates(id,name,created_by) VALUES(1,'测试模板',1)");
  const contract={schemaVersion:1,customFunctions:[{typeName:'CostReport.Function_50',versionId:50,name:'MYFUNCTION',sourceTypeName:'MyFunction',instanceState:{factor:2}}],sheets:[{code:'main',name:'业务表',rowCount:2,columnCount:2,cells:[{row:0,column:0,value:0}]}]};
  await run('INSERT INTO template_versions(id,template_id,version,created_by,workbook_json) VALUES(1,1,1,1,?)',[JSON.stringify(contract)]);
  for(const [id,cadence,period] of [[1,'monthly','2030-01'],[2,'quarterly','2030-Q1']]) {
    await run('INSERT INTO report_types(id,code,display_name,cadence,workflow_profile) VALUES(?,?,?,?,?)',[id,'TYPE'+id,'报表'+id,cadence,cadence]);
    await run('INSERT INTO period_packages(id,report_type_id,period_code,template_version_id,created_by) VALUES(?,?,?,1,1)',[id,id,period]);
    await run("INSERT INTO report_tasks(id,package_id,report_type_id,organization_id,period_code,template_version_id,deadline_at,configuration_snapshot_json) VALUES(?,?,?,1,?,1,'2030-05-01',?)",[id,id,id,period,JSON.stringify({assignments:id===1?[{responsibility:'finalizer',userId:3}]:[]})]);
  }
  await run("INSERT INTO field_definitions(id,code,display_name,data_type,status,unit) VALUES(1,'AMOUNT','金额','decimal','approved','元'),(2,'FLAG','是否完成','boolean','approved',NULL),(3,'NEW','新增无值字段','text','approved',NULL),(4,'DRAFT','草稿字段','text','draft',NULL)");
  await run("INSERT INTO business_revisions(id,task_id,revision_number,revision_status,is_current_effective,submitted_at,finalized_at) VALUES(1,1,1,'superseded',0,'2030-02-01','2030-02-02'),(2,1,2,'finalized',1,'2030-02-03','2030-02-04'),(3,1,3,'submitted',0,'2030-02-05',NULL),(4,2,1,'finalized',1,'2030-04-01','2030-04-02')");
  await run("UPDATE report_tasks SET current_revision_id=3,task_status='submitted' WHERE id=1");
  await run("UPDATE report_tasks SET current_revision_id=4,task_status='finalized' WHERE id=2");
  for(const [rev,task,value] of [[1,1,'999'],[2,1,'0'],[3,1,'500'],[4,2,'10']]) await run("INSERT INTO business_values(revision_id,task_id,field_definition_id,value_type,decimal_value,source_formula,source_sheet,source_row,source_column,unit_snapshot) VALUES(?,?,1,'decimal',?,'SUM(A2:A3)','main',0,0,'元')",[rev,task,value]);
  await run("INSERT INTO business_values(revision_id,task_id,field_definition_id,value_type,boolean_value) VALUES(2,1,2,'boolean',0)");
  const report={schemaVersion:1,status:'warnings',checkedCount:2,skippedCount:1,issues:[{severity:'warning',message:'范围提示',sheetName:'业务表',row:0,col:0}]};
  await run('INSERT INTO revision_validation_snapshots(revision_id,actor_user_id,collaboration_version,report_json) VALUES(3,1,5,?)',[JSON.stringify(report)]);
  fs.mkdirSync(process.env.COST_REPORT_ARTIFACT_DIR,{recursive:true});
  const artifact=path.join(process.env.COST_REPORT_ARTIFACT_DIR,'finalized.json');fs.writeFileSync(artifact,JSON.stringify(contract));
  await run("INSERT INTO official_artifacts(revision_id,artifact_type,storage_key,sha256,byte_size) VALUES(2,'finalized_workbook_json',?,'test',1)",[artifact]);
  assert.equal((await api(null,'/overview')).status,401);assert.equal((await api(2,'/overview')).status,403);
  const overview=await api(1,'/overview');assert.equal(overview.status,200);const d=overview.data;
  assert.equal(d.canManage,true);
  assert.equal(d.tasks.length,2);assert.equal(d.fields.length,3);assert.ok(d.fields.some(f=>f.code==='NEW'));
  assert.deepEqual(d.values.map(v=>v.value),[0,false,10]);assert.ok(d.values.every(v=>[2,4].includes(v.revisionId)));
  const monthly=d.tasks.find(t=>t.taskId===1);assert.equal(monthly.effectiveRevisionId,2);assert.equal(monthly.submittedRevisionId,3);assert.equal(monthly.validation.status,'warnings');assert.ok(monthly.checkedAt);
  assert.equal(d.tasks.find(t=>t.taskId===2).validation,null);
  assert.equal((await api(3,'/overview')).data.tasks.length,1,'finalizer sees only assigned tasks');
  assert.equal((await api(3,'/overview')).data.canManage,false);
  assert.equal((await api(3,'/tasks/2/snapshot?revisionId=4')).status,403);
  assert.equal((await api(1,'/tasks/1/snapshot?revisionId=4')).status,404);
  const detail=await api(1,'/tasks/1/snapshot?revisionId=2');assert.equal(detail.status,200);const amount=detail.data.values.find(v=>v.fieldId===1);assert.equal(amount.sheetName,'业务表');assert.equal(amount.formula,'SUM(A2:A3)');assert.equal(detail.data.workbook.sheets[0].cells[0].value,0);assert.equal(detail.data.validation,null);
  const check=await api(1,'/tasks/1/snapshot?revisionId=3');assert.equal(check.data.validation.issues[0].col,0);assert.equal(check.data.checkedBy,'测试1');
  assert.deepEqual(detail.data.functions,[{name:'MYFUNCTION',versionId:50,typeName:'MyFunction'}]);
  console.log('PASS dashboard API: scoped authorization, effective-only typed values, approved fields, exact revision validation and workbook source.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(server)await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));await new Promise(r=>db.collaborationDb.close(r));console.log('Preserved fixtures:',root)});
