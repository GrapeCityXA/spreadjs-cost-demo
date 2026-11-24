#!/usr/bin/env node
// Offline maintenance only. Never import the application (it starts jobs/migrations).
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3');
const storage = require('../src/config/storage');

const USERS = ['browser-user', 'browser-designer', '组织填报人一', 'browser-scoped-user-2', 'browser-quarter-reviewer', 'evidence-outsider'];
const SHOWCASE_USERS = [...USERS, 'demo-admin', 'demo-filler', 'demo-reviewer'];
const FIELDS = ['BROWSER_CURRENT_REVENUE', 'BROWSER_CURRENT_PROFIT', 'BROWSER_PRIOR_REVENUE', 'BROWSER_PRIOR_PROFIT'];
const COMPONENTS = ['test_header', 'test_footer'];
// These are entry-point configuration, not the reports generated during a visit.
const REPORT_TYPES = ['BROWSER_MONTHLY_PERIOD', 'BROWSER_HISTORICAL_IMPORT', 'BROWSER_QUARTERLY_ACCEPTANCE'];
const RULES = [...require('../src/services/defaultAnomalyRules').DEFAULT_ANOMALY_RULE_CODES, 'CONTROL_LOSS_FORMULA'];
// Showcase deployments keep their configured content and only clear visit data.
// Report studio templates are explicit business configuration, so they survive the daily reset.
const SHOWCASE_KEEP_TABLES = ['organizations', 'organization_aliases', 'organization_relationships', 'users', 'user_roles',
  'custom_roles', 'custom_role_capabilities', 'datasources', 'field_definitions', 'field_definition_versions', 'field_drafts',
  'field_draft_revisions', 'template_components', 'template_component_versions', 'templates', 'template_versions', 'template_sheets',
  'template_mappings', 'rule_definitions', 'rule_versions', 'report_types', 'report_studio_templates'];
const BUSINESS_TABLES = new Set(`adjustment_requests anomaly_snapshots attachments audit_logs backup_records business_audit_events business_revisions business_values collaboration_rooms custom_role_capabilities custom_roles datasources export_jobs field_definition_versions field_definitions field_draft_revisions field_drafts historical_import_batches historical_import_rows idempotency_keys monthly_adjustment_impacts notifications official_artifacts organization_aliases organization_relationships organizations package_assignments package_organizations package_targets period_package_drafts period_packages quarterly_adjustment_requests quarterly_indicator_scores quarterly_review_items report_rankings report_studio_jobs report_studio_schedules report_studio_templates report_task_events report_tasks report_type_reminder_schedules report_types reports restore_events review_opinion_items review_opinions revision_validation_snapshots rule_definitions rule_versions schema_migrations task_assignment_history task_cancellations task_deadline_changes task_indicators task_reminder_deliveries template_component_versions template_components template_mappings template_sheets template_versions templates user_roles users workflow_notification_cursor workflow_notification_deliveries`.split(' '));
const COLLAB_TABLES = new Set('collaboration_milestones collaboration_operation_summaries collaboration_operations collaboration_presence collaboration_rooms collaboration_snapshots documents operations schema_migrations snapshot_fragments'.split(' '));
const q = name => '"' + name.replaceAll('"', '""') + '"';
const marks = items => items.map(() => '?').join(',');
const all = (db, sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (e, rows) => e ? reject(e) : resolve(rows)));
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, e => e ? reject(e) : resolve()));
const exec = (db, sql) => new Promise((resolve, reject) => db.exec(sql, e => e ? reject(e) : resolve()));
const close = db => new Promise((resolve, reject) => db.close(e => e ? reject(e) : resolve()));
const open = (file, mode) => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(file, mode, e => e ? reject(e) : resolve(db));
});
const fail = message => { throw new Error(message); };
const within = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };

function configuredPaths() {
  const business = path.resolve(storage.getDatabasePath());
  return { business, collaboration: path.resolve(storage.getCollaborationDatabasePath()),
    templates: path.resolve(storage.getTemplateDirectory()), artifacts: path.resolve(storage.getArtifactDirectory()),
    checkpoints: path.resolve(storage.getBackupDirectory()),
    backups: path.resolve(process.env.COST_REPORT_RESET_BACKUP_DIR || path.join(path.dirname(business), '../demo-reset-backups')) };
}

function validateScheduledEnvironment(env = process.env) {
  if (env.COST_REPORT_DEMO_RESET_ENABLED !== 'true') fail('定时清理未启用：需明确设置 COST_REPORT_DEMO_RESET_ENABLED=true');
  for (const key of ['COST_REPORT_DB_PATH', 'COST_REPORT_COLLAB_DB_PATH', 'COST_REPORT_TEMPLATE_DIR', 'COST_REPORT_ARTIFACT_DIR', 'COST_REPORT_BACKUP_DIR', 'COST_REPORT_RESET_BACKUP_DIR']) {
    if (!env[key] || !path.isAbsolute(env[key])) fail(`定时清理必须显式配置绝对路径：${key}，禁止回退到默认存储`);
  }
}

async function noLinks(target) {
  for (let current = target; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
    if (stat?.isSymbolicLink()) fail(`拒绝符号链接或目录联接：${current}`);
    if (path.dirname(current) === current) break;
  }
}

async function canonicalPath(target) {
  let existing = path.resolve(target);
  await noLinks(existing);
  const missing = [];
  while (!(await fs.lstat(existing).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e)))) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  // Resolve Windows short-name/case aliases before checking directory overlap.
  return path.join(await fs.realpath(existing), ...missing);
}

async function validatePaths(paths) {
  for (const [name, value] of Object.entries(paths)) {
    if (!path.isAbsolute(value) || path.parse(value).root === value) fail(`不安全的 ${name} 路径`);
    await noLinks(value);
  }
  const dirs = ['templates', 'artifacts', 'checkpoints', 'backups'];
  if (paths.business === paths.collaboration) fail('两个数据库必须使用不同文件');
  for (const name of ['business', 'collaboration']) {
    if (!(await fs.stat(paths[name])).isFile()) fail(`数据库不存在：${paths[name]}`);
    for (const dir of dirs) if (within(paths[dir], paths[name])) fail(`数据库不能位于待清理或备份目录内：${dir}`);
  }
  for (let a = 0; a < dirs.length; a++) for (let b = a + 1; b < dirs.length; b++) {
    if (within(paths[dirs[a]], paths[dirs[b]]) || within(paths[dirs[b]], paths[dirs[a]])) fail('文件目录与备份目录不能互相嵌套或相同');
  }
}

async function filesIn(root) {
  const entries = [];
  async function walk(dir) {
    await noLinks(dir);
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) fail(`拒绝清理链接：${file}`);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) entries.push({ path: path.relative(root, file), bytes: (await fs.stat(file)).size });
      else fail(`不支持的文件类型：${file}`);
    }
  }
  const stat = await fs.stat(root).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (stat) await walk(root);
  return entries.sort((a,b) => a.path.localeCompare(b.path));
}

async function sha(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function tableNames(db, schema, allowed) {
  const names = (await all(db, `SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)).map(r => r.name);
  for (const name of names) if (!allowed.has(name)) fail(`发现未审核的数据表 ${schema}.${name}，请先更新清理策略`);
  return names;
}

async function makePlan(db, paths, profile = 'legacy', clearReportTemplates = false) {
  const business = await tableNames(db, 'main', BUSINESS_TABLES);
  const collaboration = await tableNames(db, 'collab', COLLAB_TABLES);
  for (const [schema, version] of [['main', 24], ['collab', 3]]) {
    if ((await all(db, `SELECT MAX(version) AS v FROM ${schema}.schema_migrations`))[0]?.v !== version) fail(`不支持的 ${schema} 数据库版本；需先核对迁移与清理策略`);
  }
  const keep = Object.fromEntries(business.map(t => [t, []]));
  let legacyUsers, legacyReportTypes, legacyRules;
  async function select(table, condition, args = []) {
    const rows = await all(db, `SELECT rowid AS _rowid, * FROM ${q(table)} WHERE ${condition}`, args);
    keep[table] = rows.map(r => r._rowid);
    return rows;
  }
  if (profile === 'showcase') {
    const demoUsers = await select('users', `username IN (${marks(SHOWCASE_USERS)})`, SHOWCASE_USERS);
    if (demoUsers.length !== SHOWCASE_USERS.length || demoUsers.some(u => u.account_status !== 'active')) fail('缺少展示模式账号或账号未启用；未清理任何数据');
    const monthly = await all(db, "SELECT id FROM report_types WHERE cadence='monthly' AND status='active' LIMIT 1");
    if (!monthly.length) fail('缺少启用的月度报表类型；未清理任何数据');
    for (const table of SHOWCASE_KEEP_TABLES) {
      if (clearReportTemplates && table === 'report_studio_templates') continue;
      if (!business.includes(table)) continue;
      keep[table] = (await all(db, `SELECT rowid AS _rowid FROM ${q(table)}`)).map(r => r._rowid);
    }
    keep.schema_migrations = null;
    keep.workflow_notification_cursor = null;
  } else {
    const users = await select('users', `username IN (${marks(USERS)})`, USERS);
    legacyUsers = users;
    if (users.length !== 6 || users.some(u => u.account_status !== 'active')) fail('必须存在指定的 6 个启用账号；未清理任何数据');
    const userIds = users.map(u => u.id);
    const roles = await select('user_roles', `user_id IN (${marks(userIds)}) AND effective_from <= CURRENT_TIMESTAMP AND (effective_to IS NULL OR effective_to > CURRENT_TIMESTAMP)`, userIds);
    if (!roles.some(r => r.user_id === users.find(u => u.username === 'browser-user').id && r.role_code === 'system_admin' && r.organization_id == null && !r.effective_to)) fail('系统管理员缺少有效的全局管理员授权');
    const orgIds = [...new Set([...users, ...roles].map(r => r.organization_id).filter(id => id != null))];
    // Keep ancestors required by the retained identities, but no unrelated organizations.
    let relationships;
    do {
      relationships = await all(db, `SELECT * FROM organization_relationships WHERE child_organization_id IN (${marks(orgIds)}) AND effective_from <= CURRENT_TIMESTAMP AND (effective_to IS NULL OR effective_to > CURRENT_TIMESTAMP)`, orgIds);
      const added = relationships.map(r => r.parent_organization_id).filter(id => !orgIds.includes(id));
      if (!added.length) break;
      orgIds.push(...new Set(added));
    } while (true);
    await select('organizations', `id IN (${marks(orgIds)})`, orgIds);
    await select('organization_relationships', `parent_organization_id IN (${marks(orgIds)}) AND child_organization_id IN (${marks(orgIds)}) AND effective_from <= CURRENT_TIMESTAMP AND (effective_to IS NULL OR effective_to > CURRENT_TIMESTAMP)`, [...orgIds, ...orgIds]);
    const roleCodes = [...new Set(roles.map(r => r.role_code))];
    await select('custom_roles', `code IN (${marks(roleCodes)})`, roleCodes);
    await select('custom_role_capabilities', `role_code IN (${marks(roleCodes)})`, roleCodes);
    const reportTypes = await select('report_types', `code IN (${marks(REPORT_TYPES)})`, REPORT_TYPES);
    legacyReportTypes = reportTypes;
    if (reportTypes.length !== REPORT_TYPES.length || reportTypes.some(t => t.status !== 'active'
      || t.cadence !== (t.code === 'BROWSER_QUARTERLY_ACCEPTANCE' ? 'quarterly' : 'monthly')
      || t.workflow_profile !== t.cadence)) fail('缺少或停用了基础报表类型，请先从清理前备份恢复，避免历史导入和周期配置不可用');
    const components = await select('template_components', `code IN (${marks(COMPONENTS)})`, COMPONENTS);
    if (components.length !== 2) fail('缺少测试表头或测试表尾');
    const versions = [];
    for (const c of components) {
      const [v] = await all(db, `SELECT rowid AS _rowid,* FROM template_component_versions WHERE component_id=? AND workflow_status='published' ORDER BY version DESC,id DESC LIMIT 1`, [c.id]);
      if (!v) fail(`${c.code} 没有已发布版本`);
      const metadata = JSON.parse(v.metadata_json || '{}');
      if (metadata.mappings?.length || metadata.managedFunctions?.length) fail(`${c.code} 引用了业务映射或自定义函数，需先核对依赖再清理`);
      versions.push(v);
    }
    keep.template_component_versions = versions.map(v => v._rowid);
    const fields = await select('field_definitions', `code IN (${marks(FIELDS)}) AND status='approved'`, FIELDS);
    if (fields.length !== 4) fail('缺少指定的 4 个已批准字段');
    const fieldVersions = [];
    for (const field of fields) {
      const [v] = await all(db, 'SELECT rowid AS _rowid,* FROM field_definition_versions WHERE field_definition_id=? AND version=?', [field.id, field.version]);
      if (!v) fail(`字段 ${field.code} 缺少当前正式版本`);
      fieldVersions.push(v);
    }
    keep.field_definition_versions = fieldVersions.map(v => v._rowid);
    const rules = await select('rule_definitions', `id IN (SELECT rule_id FROM rule_versions WHERE seeded=1 AND status='published')`);
    legacyRules = rules;
    if (RULES.some(code => !rules.some(r => r.code === code))) fail('缺少内置规则，请先在规则目录初始化内置规则');
    const ruleVersions = [];
    for (const rule of rules) {
      const [v] = await all(db, `SELECT rowid AS _rowid,* FROM rule_versions WHERE rule_id=? AND seeded=1 AND status='published' ORDER BY version DESC,id DESC LIMIT 1`, [rule.id]);
      if (!v) fail(`内置规则 ${rule.code} 缺少系统发布版本`);
      ruleVersions.push(v);
    }
    keep.rule_versions = ruleVersions.map(v => v._rowid);
    keep.schema_migrations = null;
    keep.workflow_notification_cursor = null;
  }
  const tables = [];
  for (const [schema,names] of [['main',business],['collab',collaboration]]) for (const table of names) {
    const before = (await all(db, `SELECT COUNT(*) AS n FROM ${schema}.${q(table)}`))[0].n;
    const after = table === 'schema_migrations' ? before : schema === 'collab' ? 0 : table === 'workflow_notification_cursor' ? 1 : keep[table].length;
    tables.push({database:schema === 'main' ? 'business' : 'collaboration',table,before,after,remove:before-after});
  }
  const files = {};
  for (const name of ['templates','artifacts','checkpoints']) {
    const entries = await filesIn(paths[name]);
    files[name] = {path:paths[name], files:entries.length, bytes:entries.reduce((sum,f)=>sum+f.bytes,0)};
  }
  const summary = profile === 'showcase'
    ? {
        users: (await all(db, 'SELECT username FROM users ORDER BY id')).map(r => r.username),
        reportTypes: (await all(db, 'SELECT code, display_name AS name, cadence FROM report_types ORDER BY id')).map(r => ({ code: r.code, name: r.name, cadence: r.cadence })),
        components: (await all(db, 'SELECT code FROM template_components ORDER BY id')).map(r => r.code),
        fields: (await all(db, 'SELECT code FROM field_definitions ORDER BY id')).map(r => r.code),
        builtInRules: (await all(db, 'SELECT code FROM rule_definitions ORDER BY id')).map(r => r.code)
      }
    : { users: legacyUsers.map(u => u.username), reportTypes: legacyReportTypes.map(t => ({ code: t.code, name: t.display_name, cadence: t.cadence })), components: COMPONENTS, fields: FIELDS, builtInRules: legacyRules.map(r => r.code) };
  return { paths, profile, ...summary, tables, files, keep };
}

async function integrity(db) {
  for (const schema of ['main','collab']) {
    if ((await all(db, `PRAGMA ${schema}.integrity_check`)).some(r => r.integrity_check !== 'ok')) fail(`${schema} 完整性检查失败`);
    const violations = await all(db, `PRAGMA ${schema}.foreign_key_check`);
    if (violations.length) fail(`${schema} 存在外键依赖错误：${JSON.stringify(violations.slice(0,5))}`);
  }
}

async function createBackup(paths, plan) {
  await fs.mkdir(paths.backups, {recursive:true,mode:0o700});
  const name = `reset-${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomUUID()}`;
  const folder = path.join(paths.backups,name);
  await fs.mkdir(folder, {mode:0o700});
  // With both databases in DELETE journal mode and BEGIN EXCLUSIVE held, these
  // files are a consistent snapshot. No writes have been performed yet.
  for (const key of ['business','collaboration']) await fs.copyFile(paths[key],path.join(folder,key+'.db'));
  for (const key of ['templates','artifacts','checkpoints']) {
    await fs.mkdir(path.join(folder,key));
    if (await fs.stat(paths[key]).catch(e=>e.code==='ENOENT'?null:Promise.reject(e))) {
      await fs.cp(paths[key],path.join(folder,key),{recursive:true,filter:async source=>{await noLinks(source);return true;}});
    }
  }
  const files = [];
  for (const f of await filesIn(folder)) files.push({...f,sha256:await sha(path.join(folder,f.path))});
  for (const key of ['business','collaboration']) {
    if (await sha(paths[key]) !== await sha(path.join(folder,key+'.db'))) fail('数据库备份校验失败');
  }
  for (const key of ['templates','artifacts','checkpoints']) {
    const source = await filesIn(paths[key]);
    const copied = await filesIn(path.join(folder,key));
    if (JSON.stringify(source)!==JSON.stringify(copied)) fail(`文件备份清单不一致：${key}`);
    for (const f of source) if (await sha(path.join(paths[key],f.path)) !== await sha(path.join(folder,key,f.path))) fail(`文件备份校验失败：${f.path}`);
  }
  const {keep,...publicPlan} = plan;
  const manifest = {format:'cost-report-demo-reset-v1',createdAt:new Date().toISOString(),state:'backed-up',plan:publicPlan,files};
  await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  return {folder,manifest};
}

async function cleanDatabase(db, plan) {
  const triggers = [];
  for (const schema of ['main','collab']) {
    for (const t of await all(db, `SELECT name,sql FROM ${schema}.sqlite_master WHERE type='trigger'`)) {
      triggers.push({schema,...t});
      await exec(db, `DROP TRIGGER ${schema}.${q(t.name)}`);
    }
  }
  // Retention guards are suspended only inside this offline transaction and
  // restored verbatim before commit. Rollback also restores them on failure.
  for (const row of plan.tables) {
    const schema = row.database === 'business' ? 'main' : 'collab';
    if (row.table === 'schema_migrations' || (schema === 'main' && row.table === 'workflow_notification_cursor')) continue;
    const ids = schema === 'main' ? plan.keep[row.table] : [];
    await run(db, `DELETE FROM ${schema}.${q(row.table)}${ids.length ? ` WHERE rowid NOT IN (${marks(ids)})` : ''}`, ids);
  }
  await exec(db, `UPDATE template_component_versions SET supersedes_version_id=NULL;
    UPDATE rule_versions SET supersedes_version_id=NULL;
    UPDATE field_definition_versions SET source_draft_id=NULL;
    DELETE FROM workflow_notification_cursor;
    INSERT INTO workflow_notification_cursor(id,audit_id) VALUES(1,0);`);
  for (const t of triggers) {
    const sql = t.schema === 'main' ? t.sql : t.sql.replace(/^CREATE TRIGGER\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|\S+)/i, `CREATE TRIGGER collab.${q(t.name)}`);
    await exec(db,sql);
  }
  await integrity(db);
  for (const row of plan.tables) {
    const schema = row.database === 'business' ? 'main' : 'collab';
    if ((await all(db,`SELECT COUNT(*) AS n FROM ${schema}.${q(row.table)}`))[0].n !== row.after) fail(`清理结果不符合计划：${row.table}`);
  }
}

async function pruneBackups(root, keepCount, current) {
  const candidates=[];
  for (const item of await fs.readdir(root,{withFileTypes:true})) {
    if (!item.isDirectory() || !/^reset-\d{4}-.*-[0-9a-f-]{36}$/.test(item.name)) continue;
    const folder=path.join(root,item.name);
    await noLinks(folder);
    const manifest=await fs.readFile(path.join(folder,'manifest.json'),'utf8').then(JSON.parse).catch(()=>null);
    if (manifest?.format==='cost-report-demo-reset-v1' && manifest.state==='complete') candidates.push(folder);
  }
  candidates.sort().reverse();
  for (const folder of candidates.slice(keepCount)) {
    if (folder===current || !within(root,folder) || folder===root) fail('备份清理路径校验失败');
    await filesIn(folder); // Refuse links anywhere inside a retained backup.
    await fs.rm(folder,{recursive:true});
  }
}

async function resetDemo({apply=false,confirmOffline=false,retain=7,paths=configuredPaths(),beforeCommit,scheduled=false,profile='legacy',clearReportTemplates=false}={}) {
  if (!['legacy', 'showcase'].includes(profile)) fail(`未知清理方案：${profile}`);
  if (scheduled) validateScheduledEnvironment();
  if (apply && !confirmOffline) fail('执行清理前必须停止所有后端实例，并传入 --apply --confirm-offline');
  if (!Number.isSafeInteger(retain)||retain<1) fail('--retain 必须是至少为 1 的整数');
  paths=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([key,value])=>[key,await canonicalPath(value)])));
  await validatePaths(paths);
  let lock,db,inTransaction=false,backup,committed=false,filesCleaned=false,recoveryCreated=false;
  const lockPath=paths.business+'.reset.lock';
  const recoveryPath=paths.business+'.reset-recovery.json';
  if (await fs.lstat(recoveryPath).catch(e=>e.code==='ENOENT'?null:Promise.reject(e))) fail(`上次清理尚待恢复核对，禁止自动重试：${recoveryPath}`);
  try {
    if (apply) {
      lock=await fs.open(lockPath,'wx',0o600).catch(e=>e.code==='EEXIST'?fail(`已有清理锁：${lockPath}；确认没有清理进程后才能人工移除`):Promise.reject(e));
      await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
    }
    db=await open(paths.business,apply?sqlite3.OPEN_READWRITE:sqlite3.OPEN_READONLY);
    await run(db,'PRAGMA busy_timeout=1000');
    await run(db,'ATTACH DATABASE ? AS collab',[paths.collaboration]);
    if (apply || scheduled) {
      for (const schema of ['main','collab']) {
        if ((await all(db,`PRAGMA ${schema}.journal_mode`))[0].journal_mode !== 'delete') fail('清理要求两库均为 DELETE 日志模式；停止服务后先离线转换，不能对 WAL 库直接复制');
      }
    }
    if (apply) {
      await run(db,'PRAGMA foreign_keys=OFF');
      await run(db,'PRAGMA main.secure_delete=ON');
      await run(db,'PRAGMA collab.secure_delete=ON');
      await run(db,'BEGIN EXCLUSIVE');
    } else await run(db,'BEGIN');
    inTransaction=true;
    const plan=await makePlan(db,paths,profile,clearReportTemplates);
    await integrity(db);
    if (!apply) { await run(db,'ROLLBACK');inTransaction=false;const {keep,...result}=plan;return {mode:'preview',...result}; }
    backup=await createBackup(paths,plan);
    // Survives a post-commit failure (or a killed process), so tomorrow's timer
    // cannot silently turn an incomplete reset into a new successful baseline.
    await fs.writeFile(recoveryPath,JSON.stringify({backup:backup.folder,startedAt:new Date().toISOString(),paths},null,2),{flag:'wx',mode:0o600});
    recoveryCreated=true;
    await cleanDatabase(db,plan);
    if (beforeCommit) await beforeCommit(db); // Test fault injection; never exposed by CLI.
    await run(db,'COMMIT');inTransaction=false;committed=true;
    for (const key of ['templates','artifacts','checkpoints']) {
      await noLinks(paths[key]);
      // Detect concurrent filesystem changes instead of deleting unbacked data.
      const current=await filesIn(paths[key]);
      const expected=backup.manifest.files.filter(f=>f.path.startsWith(key+path.sep));
      if (current.length!==expected.length) fail(`清理期间文件变化，请保持后端停止：${key}`);
      for (const file of current) {
        const entry=expected.find(f=>f.path===path.join(key,file.path));
        if (!entry || await sha(path.join(paths[key],file.path))!==entry.sha256) fail(`文件变化，未删除：${file.path}`);
      }
      await fs.mkdir(paths[key],{recursive:true});
      for (const name of await fs.readdir(paths[key])) {
        const target=path.resolve(paths[key],name);
        if (!within(paths[key],target)||target===paths[key]) fail('清理目标超出允许目录');
        await fs.rm(target,{recursive:true});
      }
    }
    filesCleaned=true;
    await exec(db,'VACUUM main; VACUUM collab;');
    await integrity(db);
    backup.manifest.state='complete';
    backup.manifest.completedAt=new Date().toISOString();
    await fs.writeFile(path.join(backup.folder,'manifest.json'),JSON.stringify(backup.manifest,null,2));
    await pruneBackups(paths.backups,retain,backup.folder);
    await fs.unlink(recoveryPath);recoveryCreated=false;
    const {keep,...result}=plan;
    return {mode:'applied',backup:backup.folder,retain,...result};
  } catch (error) {
    let rolledBack=false;
    if (inTransaction) {
      try {await run(db,'ROLLBACK');rolledBack=true;}
      catch (rollbackError) {error.message+=`；回滚失败：${rollbackError.message}`;}
    }
    if (recoveryCreated && !committed && rolledBack) {
      await fs.unlink(recoveryPath).then(()=>{recoveryCreated=false;}).catch(()=>{});
    }
    if (backup) {
      backup.manifest.state=committed?(filesCleaned?'cleaned-postcheck-incomplete':'database-cleaned-files-incomplete'):(rolledBack?'rolled-back':'rollback-unconfirmed');
      backup.manifest.error=error.message;
      await fs.writeFile(path.join(backup.folder,'manifest.json'),JSON.stringify(backup.manifest,null,2)).catch(()=>{});
      error.message+=`；备份：${backup.folder}${committed?(filesCleaned?'；数据与文件已清理，后续校验或备份轮换失败，请检查日志':'；数据库已清理，文件阶段未完成，请保持服务停止并检查'):(rolledBack?'；数据库已回滚':'；回滚状态未确认，请保持服务停止')}`;
    }
    throw error;
  } finally {
    try {if(db) await close(db);}
    finally {if(lock){await lock.close();await fs.unlink(lockPath);}}
  }
}

async function cli(args) {
  const options={};
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--apply') options.apply=true;
    else if(args[i]==='--confirm-offline') options.confirmOffline=true;
    else if(args[i]==='--dry-run') options.dryRun=true;
    else if(args[i]==='--scheduled') options.scheduled=true;
    else if(args[i]==='--showcase') options.profile='showcase';
    else if(args[i]==='--clear-report-templates') options.clearReportTemplates=true;
    else if(args[i]==='--retain') options.retain=Number(args[++i]);
    else if(args[i]==='--help') {console.log('预览：npm run demo:reset\n展示模式预览：npm run demo:reset -- --showcase\n执行（先停止全部后端）：npm run demo:reset -- [--showcase] --apply --confirm-offline [--retain 7]\n定时模式额外传 --scheduled：必须明确启用且配置全部存储绝对路径。\n展示模式默认保留字段、组件、模板、报表模板；需要连报表模板一起清空时加 --clear-report-templates。\n路径沿用 COST_REPORT_*；备份目录可设 COST_REPORT_RESET_BACKUP_DIR。');return;}
    else fail(`未知参数：${args[i]}`);
  }
  if(options.apply&&options.dryRun) fail('--apply 与 --dry-run 不能同时使用');
  console.log(JSON.stringify(await resetDemo(options),null,2));
}
if(require.main===module) cli(process.argv.slice(2)).catch(e=>{console.error('演示数据清理失败：'+e.message);process.exitCode=1;});
module.exports={resetDemo,configuredPaths,validateScheduledEnvironment,makePlan,cleanDatabase,USERS,SHOWCASE_USERS,SHOWCASE_KEEP_TABLES,FIELDS,COMPONENTS,RULES,REPORT_TYPES};
