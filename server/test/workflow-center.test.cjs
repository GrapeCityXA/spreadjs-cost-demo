const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-workflow-center-'));
Object.assign(process.env, { COST_REPORT_DB_PATH: path.join(root, 'business.db'), COST_REPORT_COLLAB_DB_PATH: path.join(root, 'collaboration.db'),
  COST_REPORT_TEMPLATE_DIR: path.join(root, 'templates'), COST_REPORT_ARTIFACT_DIR: path.join(root, 'artifacts'), COST_REPORT_BACKUP_DIR: path.join(root, 'backups'), JWT_SECRET: 'workflow-isolated-test' });
const db = require('../src/config/database');
const app = require('../src/app');
const run = (sql, args = []) => new Promise((resolve,reject) => db.run(sql,args,function(e){ e ? reject(e) : resolve(this); }));
let server, base;
async function api(id, url, body) {
  const response = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(id ? { Authorization: 'Bearer '+jwt.sign({id},process.env.JWT_SECRET) } : {}) }, ...(body ? {body:JSON.stringify(body)} : {}) });
  return { status: response.status, data: await response.json() };
}
async function ok(id,url,body) { const r=await api(id,url,body); assert.ok(r.status<300,`${url}: ${r.status} ${JSON.stringify(r.data)}`);return r.data; }
const task = items => items.find(r=>r.id==='task:1');
(async()=>{
  await db.ready;
  const identities = [[1,['system_admin']],[2,['template_designer']],[3,['subsidiary_filler','subsidiary_submitter']],[4,['department_reviewer']],[5,['report_finalizer']],[6,['data_administrator','business_rule_administrator','business_rule_reviewer']],[7,['subsidiary_filler']]];
  for(const [id,roles] of identities) {
    await run('INSERT INTO users(id,username,password,name,permissions) VALUES(?,?,?,?,?)',[id,'workflow'+id,'test-only','流程测试人员'+id,'[]']);
    for(const role of roles) await run('INSERT INTO user_roles(user_id,role_code) VALUES(?,?)',[id,role]);
  }
  await run("INSERT INTO organizations(id,code,name) VALUES(1,'FLOW','流程测试组织')");
  await run("INSERT INTO templates(id,name,created_by) VALUES(1,'流程测试模板',2)");
  await run('INSERT INTO template_versions(id,template_id,version,created_by) VALUES(1,1,1,2)');
  await run("INSERT INTO report_types(id,code,display_name,cadence,workflow_profile) VALUES(1,'FLOW','流程测试月报','monthly','monthly')");
  await run("INSERT INTO period_packages(id,report_type_id,period_code,template_version_id,created_by) VALUES(1,1,'2030-01',1,1)");
  const assignments = [{responsibility:'filler',userId:3},{responsibility:'submitter',userId:3},{responsibility:'department_reviewer',userId:4},{responsibility:'finalizer',userId:5}];
  await run(`INSERT INTO report_tasks(id,package_id,report_type_id,organization_id,period_code,deadline_at,template_version_id,configuration_snapshot_json)
    VALUES(1,1,1,1,'2030-01','2030-02-02',1,?)`,[JSON.stringify({assignments})]);
  server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve)); base=`http://127.0.0.1:${server.address().port}/api`;
  assert.equal((await api(null,'/workflows')).status,401);
  assert.equal(task((await ok(1,'/workflows')).items).todo,false,'unassigned admin has management access, not a filling todo');
  assert.equal(task((await ok(3,'/workflows')).items).todo,true);
  assert.equal(task((await ok(1,'/workflows')).items).flow.steps.find(s=>s.state==='current').key,'filling');
  assert.equal((await ok(1,'/management-dashboard')).selectedPeriod,null,'no quarter finalization does not hide monthly tasks from workflow progress');
  assert.equal(task((await ok(4,'/workflows')).items).todo,false);
  assert.equal(task((await ok(7,'/workflows')).items),undefined,'same role without assignment cannot see task');
  await run("INSERT INTO business_revisions(id,task_id,revision_number,revision_status,submitted_by) VALUES(1,1,1,'submitted',3)");
  await run("UPDATE report_tasks SET task_status='submitted',current_revision_id=1 WHERE id=1");
  assert.equal(task((await ok(3,'/workflows')).items).todo,false);
  assert.equal(task((await ok(3,'/workflows')).items).handled,true);
  assert.equal(task((await ok(4,'/workflows')).items).todo,true);
  assert.equal(task((await ok(1,'/workflows')).items).flow.steps.find(s=>s.state==='current').key,'review');
  assert.equal(task((await ok(5,'/workflows')).items).todo,false);
  await run("UPDATE users SET account_status='disabled' WHERE id=4");
  assert.equal(task((await ok(5,'/workflows')).items).todo,false,'disabled reviewer must not silently advance the task to finalization');
  await run("UPDATE users SET account_status='active' WHERE id=4");
  await run(`INSERT INTO review_opinion_items(revision_id,review_item_key,department_code,reviewer_id,opinion,disposition,version) VALUES(1,'monthly:submission','FLOW',4,'同意','accept',1)`);
  assert.equal(task((await ok(4,'/workflows')).items).todo,false);
  assert.equal(task((await ok(5,'/workflows')).items).todo,true);
  assert.equal(task((await ok(1,'/workflows')).items).flow.steps.find(s=>s.state==='current').key,'finalizing');
  await run("UPDATE report_tasks SET task_status='finalized' WHERE id=1");
  assert.equal(task((await ok(5,'/workflows')).items).todo,false);
  await run("INSERT INTO user_roles(user_id,role_code) VALUES(6,'score_editor')");
  await run("INSERT INTO report_types(id,code,display_name,cadence,workflow_profile) VALUES(2,'FLOW_Q','流程测试季报','quarterly','quarterly')");
  await run("INSERT INTO period_packages(id,report_type_id,period_code,template_version_id,created_by) VALUES(2,2,'2030-Q1',1,1)");
  await run(`INSERT INTO report_tasks(id,package_id,report_type_id,organization_id,period_code,deadline_at,template_version_id,configuration_snapshot_json,task_status)
    VALUES(2,2,2,1,'2030-Q1','2030-04-02',1,?,'submitted')`,[JSON.stringify({assignments:[...assignments,{responsibility:'scorer',userId:6}]})]);
  await run("INSERT INTO business_revisions(id,task_id,revision_number,revision_status,submitted_by) VALUES(2,2,1,'submitted',3)");
  await run('UPDATE report_tasks SET current_revision_id=2 WHERE id=2');
  await run(`INSERT INTO task_indicators(id,task_id,indicator_code,display_name,indicator_type,configuration_json) VALUES(1,2,'FLOW_I','流程指标','qualitative','{"ownerOrganizationId":1,"reviewerUserId":4}')`);
  const quarter = async id => (await ok(id,'/workflows')).items.find(r=>r.id==='task:2');
  assert.equal((await quarter(4)).stage,'季度指标审核'); assert.equal((await quarter(4)).todo,true);
  assert.equal((await quarter(6)).todo,false);
  await run("INSERT INTO quarterly_review_items(revision_id,indicator_id,reviewer_id,status) VALUES(2,1,4,'approved')");
  assert.equal((await quarter(6)).stage,'季度评分'); assert.equal((await quarter(6)).todo,true);
  assert.equal((await quarter(1)).flow.steps.find(s=>s.state==='current').key,'scoring');
  await run("INSERT INTO quarterly_indicator_scores(revision_id,indicator_id,scorer_id,score_decimal,score_source) VALUES(2,1,6,'10','manual')");
  assert.equal((await quarter(5)).stage,'季度定稿'); assert.equal((await quarter(5)).todo,true);
  const { recordBusinessAudit } = require('../src/services/businessAudit');
  await recordBusinessAudit({actor:{id:5},action:'quarterly_package.ranked_and_finalized',objectType:'period_package',objectId:2});
  await run("UPDATE report_tasks SET task_status='finalized' WHERE id=2");
  const allTasks=(await ok(1,'/workflows')).items.filter(r=>r.taskId);
  assert.deepEqual(new Set(allTasks.map(r=>r.kind)),new Set(['monthly','quarterly']));
  assert.ok(allTasks.every(r=>r.flow.steps.every(s=>s.state==='done')));
  assert.equal((await quarter(5)).handled,true,'quarterly package finalizer sees completed task history');
  const proposal={code:'FLOW_FIELD',displayName:'流程字段',type:'decimal',unit:'元',precision:2,editable:true,applicability:{}};
  const field=await ok(2,'/fields/drafts',proposal);
  assert.equal((await api(6,`/fields/admin/drafts/${field.draftId}/approve`,{})).status,403,'data administrator cannot approve');
  assert.ok((await ok(1,'/workflows')).items.find(r=>r.id===`field:${field.draftId}`).todo);
  await ok(1,`/fields/admin/drafts/${field.draftId}/approve`,{});
  const direct=await ok(1,'/fields/drafts',{...proposal,code:'FLOW_DIRECT'});
  assert.equal(direct.status,'approved');
  const updated=await ok(1,`/fields/admin/fields/${direct.fieldDefinitionId}/supersede`,{...proposal,code:'FLOW_DIRECT',displayName:'管理员新版本'});
  assert.equal(updated.status,'approved','admin field versions are exempt too');
  for(const actor of [2,1]) {
    const component=await ok(actor,'/template-governance/components',{code:'flow_component_'+actor,name:'流程组件',componentType:'body',rowCount:2,columnCount:2,cells:[],metadata:{}});
    const route=`/template-governance/components/${component.componentId}/versions/${component.versionId}`;
    const submitted=await ok(actor,route+'/submit',{});
    assert.equal(submitted.status,actor===1?'published':'in_review');
    if(actor===2){ assert.equal((await api(2,route+'/review',{action:'approve'})).status,403); await ok(1,route+'/review',{action:'approve'}); }
    const template=await ok(actor,'/template-governance/templates',{name:'流程模板'+actor,factory:'ALL',sheets:[{code:'main',name:'主表',type:'business',bodyVersionId:component.versionId}]});
    const tRoute=`/template-governance/templates/${template.templateId}/versions/${template.versionId}`;
    assert.equal((await ok(actor,tRoute+'/submit',{})).status,actor===1?'published':'in_review');
    if(actor===2){assert.equal((await api(2,tRoute+'/review',{action:'approve'})).status,403); await ok(1,tRoute+'/review',{action:'approve'});}
  }
  for(const actor of [6,1]) {
    const rule=await ok(actor,'/rules',{code:'FLOW_RULE_'+actor,displayName:'流程规则',ruleType:'validation',scope:'field',severity:'blocking',expression:{op:'gte',args:[{field:'actual'},0]},testCases:[{name:'非负',input:{actual:1},expected:true}]});
    const rRoute=`/rules/versions/${rule.versionId}`;
    await ok(actor,rRoute+'/test',{});
    assert.equal((await ok(actor,rRoute+'/submit',{})).status,actor===1?'published':'pending_review');
    if(actor===6){assert.equal((await api(6,rRoute+'/publish',{})).status,403); await ok(1,rRoute+'/publish',{});}
  }
  const inbox=await ok(1,'/workflows');
  assert.equal(inbox.items.filter(r=>r.todo).length,0);
  assert.ok(inbox.items.filter(r=>r.handled && r.statusLabel==='已完成').length>=8,'completed governance history includes exempt submissions');
  const notices = require('../src/services/workflowNotifications').createWorkflowNotifications(db);
  await notices.processEvents();
  assert.equal((await notices.list(6)).notifications.some(n=>/\.(submit|create|correct)$/.test(n.payload.action)),false,'former reviewer receives no approval notifications');
  console.log('PASS workflow center: scoped tasks, stage transitions, administrator-only governance, exempt publication, completed history, notifications');
  console.log('Preserved test data:',root);
})().catch(error=>{console.error(error);console.error('Preserved test data:',root);process.exitCode=1;}).finally(async()=>{
  if(server) await new Promise(resolve=>server.close(resolve));
  await new Promise(resolve=>db.close(resolve));await new Promise(resolve=>db.collaborationDb.close(resolve));
});
