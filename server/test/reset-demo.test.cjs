const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const sqlite3 = require('sqlite3');
const {resetDemo,validateScheduledEnvironment,USERS,FIELDS,COMPONENTS,RULES,REPORT_TYPES} = require('../scripts/reset-demo.cjs');
const run = (db,sql,args=[]) => new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
const all = (db,sql,args=[]) => new Promise((resolve,reject)=>db.all(sql,args,(e,r)=>e?reject(e):resolve(r)));
const close = db => new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
let root,base;

test.before(async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),'cost-demo-reset-test-'));
  process.env.COST_REPORT_DB_PATH=path.join(root,'base.db');
  process.env.COST_REPORT_COLLAB_DB_PATH=path.join(root,'base-collab.db');
  process.env.COST_REPORT_TEMPLATE_DIR=path.join(root,'base-templates');
  base=require('../src/config/database');
  await base.ready;
  await close(base);await close(base.collaborationDb);
});

async function fixture() {
  const dir=await fs.mkdtemp(path.join(root,'case-'));
  const paths={business:path.join(dir,'business.db'),collaboration:path.join(dir,'collaboration.db'),templates:path.join(dir,'templates'),artifacts:path.join(dir,'artifacts'),checkpoints:path.join(dir,'checkpoints'),backups:path.join(dir,'reset-backups')};
  await fs.copyFile(path.join(root,'base.db'),paths.business);
  await fs.copyFile(path.join(root,'base-collab.db'),paths.collaboration);
  for(const key of ['templates','artifacts','checkpoints']) {await fs.mkdir(paths[key]);await fs.writeFile(path.join(paths[key],'old-data.txt'),key+' private old data');}
  const db=new sqlite3.Database(paths.business);
  await run(db,"INSERT INTO organizations(id,code,name) VALUES(1,'ORG','Organization'),(2,'OUTSIDE','Unrelated')");
  for(let i=0;i<USERS.length;i++) await run(db,'INSERT INTO users(id,username,password,name,organization_id) VALUES(?,?,?,?,1)',[i+1,USERS[i],'keep-password-hash-'+i,USERS[i]]);
  await run(db,"INSERT INTO users(id,username,password,name,organization_id) VALUES(100,'visitor','remove-me','Visitor',2)");
  await run(db,"INSERT INTO user_roles(user_id,role_code,organization_id,granted_by) VALUES(1,'system_admin',NULL,1),(2,'template_designer',NULL,1),(3,'subsidiary_filler',1,1),(100,'subsidiary_filler',2,1)");
  await run(db,"INSERT INTO custom_roles(code,name,scope_type,status,created_by) VALUES('extra','Unused role','organization','active',1)");
  for (const code of REPORT_TYPES) {
    const cadence=code==='BROWSER_QUARTERLY_ACCEPTANCE'?'quarterly':'monthly';
    await run(db,'INSERT INTO report_types(code,display_name,cadence,workflow_profile,created_by) VALUES(?,?,?,?,1)',[code,code,cadence,cadence]);
  }
  await run(db,"INSERT INTO report_types(code,display_name,cadence,workflow_profile,created_by) VALUES('VISITOR_REPORT','Visitor experiment','monthly','monthly',100)");
  await run(db,"INSERT INTO report_types(code,display_name,cadence,workflow_profile,created_by) VALUES('EXPERIENCE_MONTHLY_A','手工体验月报 A','monthly','monthly',1)");
  for(let i=0;i<COMPONENTS.length;i++) {
    await run(db,'INSERT INTO template_components(id,code,component_type,status,created_by) VALUES(?,?,?,\'active\',1)',[i+1,COMPONENTS[i],i?'footer':'header']);
    await run(db,"INSERT INTO template_component_versions(id,component_id,version,workbook_json,metadata_json,status,workflow_status,created_by) VALUES(?,?,1,?,?,'published','published',1)",[i+1,i+1,JSON.stringify({keep:'workbook-'+i}),JSON.stringify({name:COMPONENTS[i],mappings:[],managedFunctions:[]})]);
  }
  await run(db,"INSERT INTO template_components(id,code,component_type,created_by) VALUES(100,'remove-body','body',1)");
  await run(db,"INSERT INTO template_component_versions(component_id,version,workbook_json,created_by) VALUES(100,1,'{}',1)");
  for(let i=0;i<FIELDS.length;i++) {
    await run(db,"INSERT INTO field_definitions(id,code,display_name,data_type,status,created_by,approved_by) VALUES(?,?,?,'decimal','approved',1,2)",[i+1,FIELDS[i],FIELDS[i]]);
    await run(db,"INSERT INTO field_drafts(id,proposed_code,proposal_json,status,created_by,reviewed_by) VALUES(?,?,'{}','approved',1,2)",[i+1,FIELDS[i]]);
    await run(db,"INSERT INTO field_definition_versions(field_definition_id,version,snapshot_json,created_by,approved_by,source_draft_id,approved_at) VALUES(?,1,'{}',1,2,?,CURRENT_TIMESTAMP)",[i+1,i+1]);
  }
  for(let i=0;i<RULES.length;i++) {
    await run(db,"INSERT INTO rule_definitions(id,code,display_name,rule_type,status,created_by) VALUES(?,?,?,'anomaly','active',1)",[i+1,RULES[i],RULES[i]]);
    await run(db,"INSERT INTO rule_versions(rule_id,version,expression_json,status,seeded,created_by) VALUES(?,1,'{}','published',1,1)",[i+1]);
  }
  await run(db,"INSERT INTO rule_definitions(id,code,display_name,rule_type,created_by) VALUES(100,'MANUAL','Remove custom','validation',1)");
  await run(db,"INSERT INTO rule_versions(rule_id,version,expression_json,status,created_by) VALUES(100,1,'{}','published',1)");
  await run(db,"INSERT INTO templates(id,name,status,created_by) VALUES(1,'Remove published template','published',1)");
  await run(db,"INSERT INTO reports(id,title,status,template_id,created_by) VALUES(1,'Remove completed report','completed',1,1)");
  await run(db,"INSERT INTO audit_logs(action,created_by) VALUES('keep-guard-test',1)");
  // Optional tables created lazily by the report studio must also be emptied.
  await run(db,'CREATE TABLE report_studio_jobs(id INTEGER PRIMARY KEY, payload TEXT)');
  await run(db,"INSERT INTO report_studio_jobs VALUES(1,'old-generated-report')");
  await run(db,'UPDATE workflow_notification_cursor SET audit_id=123');
  await close(db);
  const collab=new sqlite3.Database(paths.collaboration);
  await run(collab,"INSERT INTO collaboration_rooms(id,room_key,task_id,revision_number) VALUES(1,'old-room',1,1)");
  await run(collab,"INSERT INTO collaboration_snapshots(room_id,version,snapshot_json) VALUES(1,1,'{}')");
  await close(collab);
  return paths;
}

async function contents(file) {
  const db=new sqlite3.Database(file,sqlite3.OPEN_READONLY);
  try {
    const schema=await all(db,'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name');
    const rows={};
    for(const t of schema.filter(r=>r.type==='table')) rows[t.name]=await all(db,`SELECT * FROM "${t.name}" ORDER BY rowid`);
    return {schema,rows};
  } finally {await close(db);}
}

test('preview is read-only, explicit offline confirmation is mandatory',async()=>{
  const paths=await fixture();const before=await hash(paths.business);
  const plan=await resetDemo({paths});
  assert.equal(plan.mode,'preview');assert.equal(plan.users.length,6);
  assert.equal(plan.tables.find(t=>t.table==='reports').after,0);
  assert.equal(await hash(paths.business),before);
  await assert.rejects(fs.stat(paths.backups),{code:'ENOENT'});
  await assert.rejects(resetDemo({paths,apply:true}),/停止所有后端/);
  assert.equal(await hash(paths.business),before);
});

test('reset preserves credentials and seed contents, clears both stores/files, restores guards, and is repeatable',async()=>{
  const paths=await fixture();const before=await contents(paths.business);
  const originalHash=await hash(paths.business);
  const result=await resetDemo({paths,apply:true,confirmOffline:true,retain:1});
  assert.equal(await hash(path.join(result.backup,'business.db')),originalHash);
  const after=await contents(paths.business);
  assert.deepEqual(after.schema,before.schema);
  assert.deepEqual(after.rows.users,before.rows.users.filter(r=>r.id!==100));
  assert.equal(after.rows.organizations.length,1);
  assert.equal(after.rows.custom_roles.length,0);
  assert.equal(after.rows.template_components.length,2);
  assert.deepEqual(after.rows.template_component_versions,before.rows.template_component_versions.filter(r=>r.component_id!==100));
  assert.equal(after.rows.field_definitions.length,4);
  assert.equal(after.rows.field_drafts.length,0);
  assert.ok(after.rows.field_definition_versions.every(r=>r.source_draft_id===null));
  assert.equal(after.rows.rule_definitions.length,6);
  assert.deepEqual(after.rows.report_types,before.rows.report_types.filter(r=>REPORT_TYPES.includes(r.code)));
  assert.equal(after.rows.report_types.filter(r=>r.cadence==='monthly'&&r.status==='active').length,2,'historical import still has monthly options');
  assert.equal(after.rows.report_types.filter(r=>r.cadence==='quarterly').length,1);
  // Exercise the real options service used by HistoricalImportWorkbench,
  // not just table counts or whether the page can mount.
  const options=JSON.parse(execFileSync(process.execPath,['-e',`
    const db=require('./server/src/config/database');
    (async()=>{await db.ready; const options=await require('./server/src/services/historicalImports').getImportOptions();
      console.log(JSON.stringify(options));
      await new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));
      await new Promise((resolve,reject)=>db.collaborationDb.close(e=>e?reject(e):resolve()));
    })().catch(e=>{console.error(e);process.exit(1);});
  `],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,COST_REPORT_DB_PATH:paths.business,COST_REPORT_COLLAB_DB_PATH:paths.collaboration,COST_REPORT_TEMPLATE_DIR:paths.templates},encoding:'utf8',windowsHide:true}));
  assert.equal(options.reportTypes.length,2,'real historical-import options remain usable after reset');
  assert.equal(options.fields.length,4);
  for(const t of ['templates','reports','audit_logs','report_studio_jobs']) assert.equal(after.rows[t].length,0,t);
  assert.equal(after.rows.workflow_notification_cursor[0].audit_id,0);
  assert.equal((await contents(paths.collaboration)).rows.collaboration_snapshots.length,0);
  for(const key of ['templates','artifacts','checkpoints']) assert.deepEqual(await fs.readdir(paths[key]),[]);
  const db=new sqlite3.Database(paths.business);
  await assert.rejects(run(db,'DELETE FROM rule_versions'),/immutable/);
  await run(db,"INSERT INTO users(username,password,name) VALUES('next-visitor','x','Next')");
  assert.ok((await all(db,"SELECT id FROM users WHERE username='next-visitor'"))[0].id>100,'never reuse a removed visitor identity');
  await close(db);
  await fs.mkdir(path.join(paths.backups,'manual-archive'));
  await resetDemo({paths,apply:true,confirmOffline:true,retain:1});
  assert.deepEqual((await contents(paths.business)).rows.users,after.rows.users);
  assert.deepEqual((await contents(paths.business)).rows.report_types,after.rows.report_types);
  await assert.rejects(fs.stat(result.backup),{code:'ENOENT'});
  assert.ok((await fs.stat(path.join(paths.backups,'manual-archive'))).isDirectory());
});

test('showcase reset keeps content and report templates while clearing visit data',async()=>{
  const paths=await fixture();
  const db=new sqlite3.Database(paths.business);
  for (const [id, username] of [[101,'demo-admin'],[102,'demo-filler'],[103,'demo-reviewer']]) {
    await run(db,'INSERT INTO users(id,username,password,name) VALUES(?,?,?,?)',[id,username,'keep-'+id,username]);
  }
  await run(db,'CREATE TABLE report_studio_templates(id INTEGER PRIMARY KEY, family_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT \'draft\', template_json TEXT NOT NULL, created_by INTEGER NOT NULL, reviewed_by INTEGER, review_note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(family_id,version))');
  await run(db,"INSERT INTO report_studio_templates(id,family_id,name,version,status,template_json,created_by) VALUES(1,'keep-family','Keep report',1,'published','{\"sheet\":true}',101)");
  await close(db);
  const before=await contents(paths.business);
  await resetDemo({paths,profile:'showcase',apply:true,confirmOffline:true});
  const after=await contents(paths.business);
  assert.equal(after.rows.templates.length,before.rows.templates.length,'business templates are configuration');
  assert.equal(after.rows.template_components.length,before.rows.template_components.length);
  assert.equal(after.rows.field_definitions.length,before.rows.field_definitions.length);
  assert.deepEqual(after.rows.report_studio_templates,before.rows.report_studio_templates,'report studio templates survive daily reset');
  assert.equal(after.rows.report_studio_jobs.length,0);
  assert.equal(after.rows.reports.length,0);
  assert.deepEqual(after.rows.report_types,before.rows.report_types);
  assert.equal(after.rows.users.length,before.rows.users.length,'demo accounts are preserved');
  assert.equal((await contents(paths.collaboration)).rows.collaboration_snapshots.length,0);
  await resetDemo({paths,profile:'showcase',apply:true,confirmOffline:true,clearReportTemplates:true});
  assert.equal((await contents(paths.business)).rows.report_studio_templates.length,0,'explicit opt-out clears report templates');
});

test('failure before commit rolls back both databases and their triggers; backup remains recoverable',async()=>{
  const paths=await fixture();const before=await contents(paths.business);const oldCollab=await contents(paths.collaboration);
  await assert.rejects(resetDemo({paths,apply:true,confirmOffline:true,beforeCommit:()=>{throw new Error('injected failure');}}),/数据库已回滚/);
  assert.deepEqual(await contents(paths.business),before);
  assert.deepEqual(await contents(paths.collaboration),oldCollab);
  assert.equal(await fs.readFile(path.join(paths.artifacts,'old-data.txt'),'utf8'),'artifacts private old data');
  const [backup]=await fs.readdir(paths.backups);
  assert.equal(JSON.parse(await fs.readFile(path.join(paths.backups,backup,'manifest.json'),'utf8')).state,'rolled-back');
  await assert.rejects(fs.stat(paths.business+'.reset.lock'),{code:'ENOENT'});
  await assert.rejects(fs.stat(paths.business+'.reset-recovery.json'),{code:'ENOENT'});
});

test('missing seeds, new schema tables, overlapping paths, WAL and concurrent resets fail closed',async()=>{
  const paths=await fixture();const db=new sqlite3.Database(paths.business);
  await run(db,"UPDATE users SET username='renamed-admin' WHERE id=1");
  await assert.rejects(resetDemo({paths}),/6 个启用账号/);
  await run(db,"UPDATE users SET username='browser-user' WHERE id=1");
  await run(db,'CREATE TABLE future_data(id INTEGER)');
  await assert.rejects(resetDemo({paths}),/未审核的数据表/);
  await run(db,'DROP TABLE future_data');
  await assert.rejects(resetDemo({paths:{...paths,backups:paths.artifacts}}),/不能互相嵌套/);
  await fs.writeFile(paths.business+'.reset.lock','another reset');
  await assert.rejects(resetDemo({paths,apply:true,confirmOffline:true}),/已有清理锁/);
  await fs.unlink(paths.business+'.reset.lock');
  await run(db,'PRAGMA journal_mode=WAL');
  await close(db);
  await assert.rejects(resetDemo({paths,apply:true,confirmOffline:true}),/DELETE 日志模式/);
  assert.equal((await contents(paths.business)).rows.users.length,7);
});

test('new unbacked files abort deletion after SQL commit and retain the recovery backup',async()=>{
  const paths=await fixture();
  await assert.rejects(resetDemo({paths,apply:true,confirmOffline:true,beforeCommit:()=>fs.writeFile(path.join(paths.artifacts,'new-file.txt'),'concurrent data')}),/数据库已清理，文件阶段未完成/);
  assert.equal(await fs.readFile(path.join(paths.artifacts,'new-file.txt'),'utf8'),'concurrent data');
  const [backup]=await fs.readdir(paths.backups);
  assert.equal(JSON.parse(await fs.readFile(path.join(paths.backups,backup,'manifest.json'),'utf8')).state,'database-cleaned-files-incomplete');
  const recovery=JSON.parse(await fs.readFile(paths.business+'.reset-recovery.json','utf8'));
  assert.equal(recovery.backup,await fs.realpath(path.join(paths.backups,backup)));
  const afterFailure=await contents(paths.business);
  await assert.rejects(resetDemo({paths,apply:true,confirmOffline:true}),/禁止自动重试/);
  await assert.rejects(resetDemo({paths}),/禁止自动重试/);
  assert.deepEqual(await contents(paths.business),afterFailure);
  assert.equal((await fs.readdir(paths.backups)).length,1,'must not create a second backup of partially reset data');
});

test('scheduled reset requires explicit opt-in and every storage path, before touching data',async()=>{
  const paths=await fixture();const before=await hash(paths.business);
  const env={COST_REPORT_DEMO_RESET_ENABLED:'true'};
  const keys=['COST_REPORT_DB_PATH','COST_REPORT_COLLAB_DB_PATH','COST_REPORT_TEMPLATE_DIR','COST_REPORT_ARTIFACT_DIR','COST_REPORT_BACKUP_DIR','COST_REPORT_RESET_BACKUP_DIR'];
  keys.forEach((key,i)=>{env[key]=path.join(root,String(i));});
  assert.doesNotThrow(()=>validateScheduledEnvironment(env));
  assert.throws(()=>validateScheduledEnvironment({...env,COST_REPORT_DEMO_RESET_ENABLED:'false'}),/未启用/);
  for(const key of keys) {
    assert.throws(()=>validateScheduledEnvironment({...env,[key]:''}),/绝对路径/);
    assert.throws(()=>validateScheduledEnvironment({...env,[key]:'relative/path'}),/绝对路径/);
  }
  const previous=process.env.COST_REPORT_DEMO_RESET_ENABLED;
  process.env.COST_REPORT_DEMO_RESET_ENABLED='false';
  try {await assert.rejects(resetDemo({paths,scheduled:true,apply:true,confirmOffline:true}),/未启用/);}
  finally {if(previous===undefined) delete process.env.COST_REPORT_DEMO_RESET_ENABLED;else process.env.COST_REPORT_DEMO_RESET_ENABLED=previous;}
  assert.equal(await hash(paths.business),before);
  await assert.rejects(fs.stat(paths.backups),{code:'ENOENT'});
  const actual={COST_REPORT_DEMO_RESET_ENABLED:'true',COST_REPORT_DB_PATH:paths.business,COST_REPORT_COLLAB_DB_PATH:paths.collaboration,COST_REPORT_TEMPLATE_DIR:paths.templates,COST_REPORT_ARTIFACT_DIR:paths.artifacts,COST_REPORT_BACKUP_DIR:paths.checkpoints,COST_REPORT_RESET_BACKUP_DIR:paths.backups};
  const saved=Object.fromEntries(Object.keys(actual).map(key=>[key,process.env[key]]));
  Object.assign(process.env,actual);
  try {
    const walDb=new sqlite3.Database(paths.business);
    await run(walDb,'PRAGMA journal_mode=WAL');await close(walDb);
    await assert.rejects(resetDemo({paths,scheduled:true}),/DELETE 日志模式/,'scheduled preview must reject WAL before the service is stopped');
  } finally {
    for(const [key,value] of Object.entries(saved)) {if(value===undefined) delete process.env[key];else process.env[key]=value;}
  }
});

test('a missing baseline report type prevents cleanup before any data is removed',async()=>{
  const paths=await fixture();const db=new sqlite3.Database(paths.business);
  await run(db,"DELETE FROM report_types WHERE code='BROWSER_HISTORICAL_IMPORT'");
  await close(db);
  const before=await contents(paths.business);
  await assert.rejects(resetDemo({paths,apply:true,confirmOffline:true}),/基础报表类型/);
  assert.deepEqual(await contents(paths.business),before);
  await assert.rejects(fs.stat(paths.backups),{code:'ENOENT'});
});

test('all system-seeded rules are kept, including subsequently added built-ins',async()=>{
  const paths=await fixture();const db=new sqlite3.Database(paths.business);
  await run(db,"INSERT INTO rule_definitions(id,code,display_name,rule_type,created_by) VALUES(101,'ADDITIONAL_BUILTIN','Extra builtin','validation',1)");
  await run(db,"INSERT INTO rule_versions(rule_id,version,expression_json,status,seeded,created_by) VALUES(101,1,'{}','published',1,1)");
  await close(db);
  const result=await resetDemo({paths,apply:true,confirmOffline:true});
  assert.ok(result.builtInRules.includes('ADDITIONAL_BUILTIN'));
  assert.equal((await contents(paths.business)).rows.rule_definitions.length,7);
});

test('links and an active SQLite writer cannot be cleaned',async()=>{
  const paths=await fixture();const outside=await fs.mkdtemp(path.join(root,'outside-'));
  await fs.writeFile(path.join(outside,'keep.txt'),'untouched');
  const link=path.join(paths.artifacts,'linked');
  await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(resetDemo({paths,apply:true,confirmOffline:true}),/链接/);
  assert.equal(await fs.readFile(path.join(outside,'keep.txt'),'utf8'),'untouched');
  await fs.unlink(link);
  const db=new sqlite3.Database(paths.business);
  await run(db,'BEGIN IMMEDIATE');
  try {await assert.rejects(resetDemo({paths,apply:true,confirmOffline:true}),/SQLITE_BUSY/);}
  finally {await run(db,'ROLLBACK');await close(db);}
  assert.equal((await contents(paths.business)).rows.users.length,7);
});
