const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-retired-tables-'));
process.env.COST_REPORT_DB_PATH = path.join(root, 'fresh.db');
process.env.COST_REPORT_COLLAB_DB_PATH = path.join(root, 'collaboration.db');
process.env.COST_REPORT_TEMPLATE_DIR = path.join(root, 'templates');
const db = require('../src/config/database');
const { all, get, run, migrate } = db._helpers;
const retired = ['template_syncs', 'template_changes', 'indicator_scores', 'score_adjustments'];
const close = connection => new Promise((resolve, reject) => connection.close(error => error ? reject(error) : resolve()));
const tableNames = async connection => (await all(connection,
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map(row => row.name);
async function retainedRows(connection) {
  const result = {};
  for (const name of await tableNames(connection)) {
    if (retired.includes(name) || name === 'schema_migrations') continue;
    result[name] = await all(connection, `SELECT * FROM "${name.replaceAll('"', '""')}"`);
  }
  return result;
}

test('migration 24 retires only unused tables, rolls back on failure and supports fresh/repeated startup', async t => {
  await db.ready;
  t.after(async () => { await close(db); await close(db.collaborationDb); });
  const migrations = db.migrations.businessMigrations;
  const old = db.openDatabase(path.join(root, 'upgrade.db'), migrations.filter(item => item.version < 24));
  await old.ready;
  t.after(() => close(old.connection));
  const connection = old.connection;
  assert.equal((await get(connection, 'SELECT MAX(version) AS version FROM schema_migrations')).version, 23);
  for (const name of retired) assert.ok((await tableNames(connection)).includes(name));
  await run(connection, "INSERT INTO users(id,username,password,name) VALUES(1,'migration-user','fixture-only','Migration User')");
  await run(connection, "INSERT INTO datasources(id,name,type,data,created_by) VALUES(1,'retained','tableData','{}',1)");
  await run(connection, "INSERT INTO templates(id,name,created_by) VALUES(1,'Retained template',1)");
  await run(connection, "INSERT INTO reports(id,title,template_id,datasource_id,created_by) VALUES(1,'Retained report',1,1,1)");
  await run(connection, `INSERT INTO template_changes(id,template_id,change_version,commands,template_data,created_by)
    VALUES(1,1,'fixture-1','[]','{}',1)`);
  await run(connection, 'INSERT INTO template_syncs(id,change_id,report_id) VALUES(1,1,1)');
  const before = await retainedRows(connection);
  const migrationHistory = await all(connection, 'SELECT * FROM schema_migrations ORDER BY version');

  // An unexpected external dependency must roll back the earlier DROP in the same migration.
  await run(connection, 'CREATE TABLE migration_guard(change_id INTEGER REFERENCES template_changes(id))');
  await run(connection, 'INSERT INTO migration_guard VALUES(1)');
  await assert.rejects(migrate(connection, migrations), /FOREIGN KEY constraint failed/);
  for (const name of retired) assert.ok((await tableNames(connection)).includes(name), `${name} is restored on failure`);
  assert.equal((await get(connection, 'SELECT COUNT(*) AS count FROM template_syncs')).count, 1);
  assert.equal((await get(connection, 'SELECT COUNT(*) AS count FROM template_changes')).count, 1);
  assert.deepEqual(await all(connection, 'SELECT * FROM schema_migrations ORDER BY version'), migrationHistory);
  await run(connection, 'DROP TABLE migration_guard');

  await migrate(connection, migrations);
  const upgradedNames = await tableNames(connection);
  for (const name of retired) assert.ok(!upgradedNames.includes(name), `${name} is retired`);
  assert.deepEqual(await retainedRows(connection), before, 'all retained table contents are unchanged');
  assert.deepEqual(await all(connection, 'SELECT * FROM schema_migrations WHERE version < 24 ORDER BY version'), migrationHistory);
  assert.equal((await get(connection, "SELECT COUNT(*) AS count FROM schema_migrations WHERE version=24 AND name='retire_unused_template_sync_and_scoring_tables'")).count, 1);
  assert.deepEqual(await all(connection, 'PRAGMA foreign_key_check'), []);
  assert.deepEqual(await all(connection, 'PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);

  assert.deepEqual(await tableNames(db), upgradedNames, 'fresh and upgraded schemas contain the same tables');
  await migrate(connection, migrations);
  assert.deepEqual(await retainedRows(connection), before, 'repeated startup preserves retained data');
  assert.equal((await get(connection, 'SELECT COUNT(*) AS count FROM schema_migrations WHERE version=24')).count, 1);
});
