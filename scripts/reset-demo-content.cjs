#!/usr/bin/env node
// 通过 npm run demo:reset 运行。可分别选择是否清空字段、组件、模板、报表模板，默认全部保留。
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync, exec } = require('child_process');
const readline = require('readline/promises');

const root = path.resolve(__dirname, '..');
const serverDir = path.join(root, 'server');
const dataDir = path.join(serverDir, 'data', 'demo');
const envFile = path.join(serverDir, '.env');
let port = 3001;
try {
  if (fs.existsSync(envFile)) {
    const match = fs.readFileSync(envFile, 'utf8').match(/(?:^|\r?\n)PORT\s*=\s*(\d+)/);
    if (match) port = Number(match[1]);
  }
} catch {}

const FIELD_TABLES = ['field_definitions', 'field_definition_versions', 'field_drafts', 'field_draft_revisions'];
const COMPONENT_TABLES = ['template_components', 'template_component_versions'];
const TEMPLATE_TABLES = ['templates', 'template_versions', 'template_sheets', 'template_mappings'];
const REPORT_TEMPLATE_TABLES = ['report_studio_templates'];
const EXPORT_TABLES = ['report_types', ...FIELD_TABLES, ...COMPONENT_TABLES, ...TEMPLATE_TABLES, ...REPORT_TEMPLATE_TABLES];

function fail(message) {
  console.error('\n[失败] ' + message);
  process.exitCode = 1;
  process.exit(1);
}

async function main() {
  if (!fs.existsSync(path.join(serverDir, 'node_modules', 'sqlite3'))) {
    return fail('server/node_modules 不存在，请先在 server 目录执行 npm install。');
  }
  const sqlite3 = require(path.join(serverDir, 'node_modules', 'sqlite3'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const scriptedAnswers = process.env.RESET_ASSUME_ANSWERS ? process.env.RESET_ASSUME_ANSWERS.split(',') : null;
  let answerIndex = 0;
  const ask = async (question) => {
    const suffix = ' (y/N，默认 N)：';
    if (scriptedAnswers) {
      const value = (scriptedAnswers[answerIndex++] || '').trim();
      console.log(question + suffix + value);
      return /^y(es)?$/i.test(value);
    }
    return /^y(es)?$/i.test((await rl.question(question + suffix)).trim());
  };
  console.log('\n=== 成本指标演示数据清理 ===\n');
  console.log('将清空：周期包、任务、业务修订、协同房间、生成记录、通知等演示内容。');
  console.log('默认保留：业务字段、组件库、模板、报表模板。');
  console.log('将恢复：标准演示账号（9 个）、组织（4 个）；报表类型会从备份恢复。');
  console.log('会先自动备份，再停止并重启后端（端口 ' + port + '）。\n');
  console.log('如果后端是用 npm run dev（nodemon）启动的，请先关闭那个终端。\n');

  const clearFields = await ask('是否清空业务字段目录？');
  let clearComponents = await ask('是否清空组件库？');
  let clearTemplates = await ask('是否清空模板？');
  const clearReportTemplates = await ask('是否清空报表模板（报表工作室）？');
  if (clearFields && !clearComponents) {
    console.log('  字段被清空后组件会失去引用，组件库将一并清空。');
    clearComponents = true;
  }
  if ((clearFields || clearComponents) && !clearTemplates) {
    console.log('  字段/组件被清空后模板会失去引用，模板将一并清空。');
    clearTemplates = true;
  }
  console.log('\n本次选择：');
  console.log('  业务字段：' + (clearFields ? '清空' : '保留'));
  console.log('  组件库：  ' + (clearComponents ? '清空' : '保留'));
  console.log('  模板：    ' + (clearTemplates ? '清空' : '保留'));
  console.log('  报表模板：' + (clearReportTemplates ? '清空' : '保留'));
  console.log('  其他业务内容：清空');
  const proceed = await ask('确认继续？');
  rl.close();
  if (!proceed) {
    console.log('\n已取消，未修改任何数据。');
    process.exit(0);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(root, '.scratch', 'reset-backup-' + stamp);
  fs.mkdirSync(backup, { recursive: true });
  for (const file of ['business.db', 'collaboration.db']) {
    const source = path.join(dataDir, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(backup, file));
  }
  for (const dir of ['templates', 'artifacts']) {
    const source = path.join(dataDir, dir);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(backup, dir), { recursive: true });
  }
  console.log('\n[1/5] 已备份到：' + backup);

  const exported = {};
  const oldUserNames = new Map();
  const businessFile = path.join(dataDir, 'business.db');
  if (fs.existsSync(businessFile)) {
    const oldDb = await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(businessFile, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(db));
    });
    for (const table of EXPORT_TABLES) {
      exported[table] = await new Promise((resolve, reject) => oldDb.all('SELECT * FROM ' + table, (error, rows) => {
        if (error && /no such table/i.test(error.message)) return resolve([]);
        error ? reject(error) : resolve(rows);
      }));
    }
    for (const row of await new Promise((resolve, reject) => oldDb.all('SELECT id, username FROM users', (error, rows) => error ? reject(error) : resolve(rows)))) {
      oldUserNames.set(row.id, row.username);
    }
    await new Promise((resolve, reject) => oldDb.close(error => error ? reject(error) : resolve()));
    fs.writeFileSync(path.join(backup, 'restore-data.json'), JSON.stringify(exported, null, 2));
  }
  console.log('        已导出字段/组件/模板/报表模板/报表类型，共 ' + Object.values(exported).reduce((sum, rows) => sum + rows.length, 0) + ' 行');

  try {
    const out = execSync(`netstat -ano | findstr ":${port}" | findstr LISTENING`, { encoding: 'utf8' });
    const pids = [...new Set(out.split(/\r?\n/).map(line => line.trim().split(/\s+/).pop()).filter(value => /^\d+$/.test(value)))];
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1500));
  console.log('[2/5] 已停止后端');

  for (const file of ['business.db', 'business.db-wal', 'business.db-shm', 'collaboration.db', 'collaboration.db-wal', 'collaboration.db-shm']) {
    const target = path.join(dataDir, file);
    if (fs.existsSync(target)) fs.rmSync(target);
  }
  for (const dir of ['templates', 'artifacts']) {
    const target = path.join(dataDir, dir);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
  console.log('[3/5] 已删除旧数据库与模板输出文件');

  exec('start "cost-report-server" cmd /k npm start', { cwd: serverDir, windowsHide: false });
  const healthy = await waitHealth(45000);
  if (!healthy) {
    return fail('后端未能在 45 秒内就绪。请检查是否有其他后端占用端口 ' + port + '，或手动在 server 目录执行 npm start。');
  }
  console.log('[4/5] 后端已启动');

  execFileSync(process.execPath, [path.join(serverDir, 'scripts', 'seed-demo-users.cjs')], { cwd: serverDir, stdio: 'inherit' });

  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(businessFile, error => error ? reject(error) : resolve(connection));
  });
  try {
    const newUsers = await all(db, 'SELECT id, username FROM users');
    const newUserId = new Map(newUsers.map(row => [row.username, row.id]));
    const fallbackUser = newUserId.get('demo-admin') || newUserId.get('browser-user') || newUsers[0]?.id;
    const resolveUser = (oldId, required = true) => {
      const id = newUserId.get(oldUserNames.get(oldId));
      if (id) return id;
      if (required && !fallbackUser) throw new Error('无法映射报表模板的创建人：没有可用的演示账号');
      return required ? fallbackUser : null;
    };
    await restoreTable(db, 'report_types', exported.report_types || []);
    const monthly = await new Promise((resolve, reject) => db.get("SELECT id FROM report_types WHERE code = 'MONTHLY_REPORT'", (error, row) => error ? reject(error) : resolve(row)));
    if (!monthly) {
      await run(db, "INSERT INTO report_types (code, display_name, cadence, workflow_profile, status) VALUES ('MONTHLY_REPORT', '月度报告', 'monthly', 'monthly', 'active')");
    }
    if (!clearFields) {
      for (const table of FIELD_TABLES) await restoreTable(db, table, exported[table] || []);
    }
    if (!clearComponents) {
      for (const table of COMPONENT_TABLES) await restoreTable(db, table, exported[table] || []);
    }
    if (!clearTemplates) {
      for (const table of TEMPLATE_TABLES) await restoreTable(db, table, exported[table] || []);
    }
    if (!clearReportTemplates) {
      const rows = (exported.report_studio_templates || []).map(row => ({
        ...row,
        created_by: resolveUser(row.created_by, true),
        reviewed_by: row.reviewed_by == null ? null : resolveUser(row.reviewed_by, false)
      }));
      for (const table of REPORT_TEMPLATE_TABLES) await restoreTable(db, table, rows);
    }
  } finally {
    await new Promise(resolve => db.close(() => resolve()));
  }

  const counts = await countContent(sqlite3, businessFile);
  console.log('[5/5] 完成');
  console.log('\n当前数据：');
  console.log('  字段 ' + counts.field_definitions + ' 个 · 组件 ' + counts.template_components + ' 个 · 模板 ' + counts.templates + ' 个 · 报表类型 ' + counts.report_types + ' 个');
  console.log('  周期包 ' + counts.period_packages + ' · 任务 ' + counts.report_tasks + ' · 报表模板 ' + counts.report_studio_templates + ' · 通知 ' + counts.notifications);
  console.log('\n备份：' + backup);
  console.log('后端已在新窗口启动，刷新浏览器即可继续。');
  console.log('\n提示：Caddy 和前端不由本脚本启动。若 http://test.com 打不开，请在项目根目录执行：');
  console.log('  caddy start --config Caddyfile');
  console.log('若页面返回 502，请确认 npm run dev:showcase 正在 5199 端口运行。');
  process.exit(0);
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (error) { error ? reject(error) : resolve(this); }));
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}
async function restoreTable(db, table, rows) {
  if (!rows.length) return;
  const columns = (await all(db, 'PRAGMA table_info(' + table + ')')).map(column => column.name);
  if (!columns.length) throw new Error('目标表不存在：' + table);
  await run(db, 'BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const keys = Object.keys(row).filter(key => columns.includes(key));
      await run(db, `INSERT INTO ${table} (${keys.map(key => '"' + key + '"').join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(key => row[key]));
    }
    await run(db, 'COMMIT');
  } catch (error) {
    await run(db, 'ROLLBACK').catch(() => {});
    throw error;
  }
}
async function countContent(sqlite3, file) {
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(file, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(connection));
  });
  const tables = ['field_definitions', 'template_components', 'templates', 'report_types', 'period_packages', 'report_tasks', 'report_studio_templates', 'notifications'];
  const result = {};
  for (const table of tables) {
    result[table] = (await all(db, 'SELECT COUNT(*) AS n FROM ' + table))[0].n;
  }
  await new Promise(resolve => db.close(() => resolve()));
  return result;
}
async function waitHealth(timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch('http://localhost:' + port + '/health');
      if (response.ok) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

main().catch(error => fail(error.message || String(error)));
