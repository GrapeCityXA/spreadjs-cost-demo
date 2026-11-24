#!/usr/bin/env node
// Insert the tracked showcase baseline only when the content tables are empty.
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const storage = require('../src/config/storage');

const seedFile = path.resolve(__dirname, '../config/seed/showcase-content.json');
const userColumns = new Set(['created_by', 'approved_by', 'reviewed_by', 'submitted_by', 'entered_by', 'granted_by']);
const order = [
  'report_types', 'field_definitions', 'field_drafts', 'field_draft_revisions', 'field_definition_versions',
  'rule_definitions', 'rule_versions', 'datasources', 'template_components', 'template_component_versions',
  'templates', 'template_versions', 'template_sheets', 'template_mappings', 'report_studio_templates'
];

const open = file => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, error => error ? reject(error) : resolve(db));
});
const all = (db, sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, error => error ? reject(error) : resolve()));
const close = db => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));

async function seedShowcaseContent() {
  const dbFile = storage.getDatabasePath();
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const db = await open(dbFile);
  try {
    const counts = {};
    for (const table of ['field_definitions', 'template_components', 'templates', 'report_studio_templates']) {
      counts[table] = (await all(db, `SELECT COUNT(*) AS n FROM ${table}`))[0].n;
    }
    if (Object.values(counts).some(count => count > 0)) {
      return { seeded: false, reason: 'showcase content already exists', counts };
    }
    const users = await all(db, 'SELECT id, username FROM users');
    const byName = new Map(users.map(user => [user.username, user.id]));
    const fallback = byName.get('demo-admin') || byName.get('browser-user') || users[0]?.id;
    const remap = oldId => {
      if (oldId == null) return null;
      return byName.get(seed.userMap?.[oldId]) || fallback || null;
    };
    await run(db, 'BEGIN IMMEDIATE');
    try {
      for (const table of order) {
        for (const raw of seed.tables?.[table] || []) {
          const row = { ...raw };
          for (const column of userColumns) if (column in row) row[column] = remap(row[column]);
          const columns = Object.keys(row);
          await run(db, `INSERT OR IGNORE INTO ${table} (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(column => row[column]));
        }
      }
      await run(db, 'COMMIT');
    } catch (error) {
      await run(db, 'ROLLBACK').catch(() => {});
      throw error;
    }
    return { seeded: true, counts };
  } finally {
    await close(db);
  }
}

if (require.main === module) {
  seedShowcaseContent().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error('生成展示内容失败：', error.message);
    process.exitCode = 1;
  });
}
module.exports = { seedShowcaseContent };
