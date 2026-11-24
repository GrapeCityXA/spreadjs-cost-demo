const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../config/database');
const checkpoints = require('./checkpointBackups');
const { getShowcaseConfig } = require('../config/showcaseConfig');
const collaboration = require('./collaborationServer');
const { touchActivity, idleMs } = require('./showcaseActivity');
const { configuredPaths, makePlan, cleanDatabase } = require('../../scripts/reset-demo.cjs');

let running = null;
let timer = null;

const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, error => error ? reject(error) : resolve()));
const all = (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));

function fail(message, status = 409) {
  return Object.assign(new Error(message), { status });
}

async function clearDirectory(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) await fs.rm(path.join(directory, entry.name), { recursive: true, force: true });
}

async function pruneBackups(directory, retain) {
  const entries = (await fs.readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isFile() && /^reset-.*\.tar\.gz$/.test(entry.name))
    .map(entry => entry.name).sort().reverse();
  for (const name of entries.slice(retain)) await fs.rm(path.join(directory, name), { force: true });
}

async function detachIfNeeded() {
  const databases = await all('PRAGMA database_list');
  if (databases.some(item => item.name === 'collab')) await run('DETACH DATABASE collab');
}

async function resetShowcase({ actor = null, reason = 'Showcase data reset', retain = null } = {}) {
  if (running) throw fail('已有展示数据清理正在执行');
  running = (async () => {
    const paths = configuredPaths();
    const keepCount = Number.isSafeInteger(Number(retain)) && Number(retain) > 0
      ? Number(retain) : getShowcaseConfig().reset.backupRetain;
    if (path.resolve(paths.backups) === path.resolve(paths.checkpoints)) {
      throw fail('重置备份目录不能与检查点备份目录相同');
    }
    await fs.mkdir(paths.backups, { recursive: true, mode: 0o700 });

    // Use the existing checkpoint backup API: it is safe while the backend is
    // running and produces a complete DB + templates + artifacts archive.
    const checkpoint = await checkpoints.createCheckpoint({ actor, reason });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(paths.backups, `reset-${stamp}-${path.basename(checkpoint.archivePath)}`);
    await fs.copyFile(checkpoint.archivePath, backup);
    await pruneBackups(paths.backups, keepCount);

    let attached = false;
    try {
      await detachIfNeeded();
      await run('ATTACH DATABASE ? AS collab', [paths.collaboration]);
      attached = true;
      await run('PRAGMA busy_timeout=5000');
      await run('PRAGMA foreign_keys=OFF');
      await run('BEGIN IMMEDIATE');
      const plan = await makePlan(db, paths, 'showcase');
      await cleanDatabase(db, plan);
      await run('COMMIT');
    } catch (error) {
      await run('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      if (attached) await run('DETACH DATABASE collab').catch(() => {});
      await run('PRAGMA foreign_keys=ON').catch(() => {});
    }

    // The database is clean; remove visit-generated files. The copied reset
    // backup above is intentionally outside these directories.
    for (const directory of [paths.templates, paths.artifacts, paths.checkpoints]) {
      await clearDirectory(directory).catch(error => console.error('Showcase reset file cleanup failed:', directory, error.message));
    }
    touchActivity();
    return { ok: true, backup, retain: keepCount };
  })();
  try { return await running; }
  finally { running = null; }
}

function startScheduler() {
  const config = getShowcaseConfig().reset;
  if (timer || !config.enabled) return false;
  const hours = config.idleHours;
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error('SHOWCASE_RESET_IDLE_HOURS 必须是正数；内置清理未启用');
    return false;
  }
  timer = setInterval(async () => {
    if (running) return;
    // An open collaboration room counts as active use even when it is idle.
    if (collaboration.activeConnectionCount() > 0) {
      touchActivity();
      return;
    }
    if (idleMs() < hours * 60 * 60 * 1000) return;
    try {
      const result = await resetShowcase({ reason: 'Idle showcase reset' });
      console.log('Showcase idle reset complete:', result.backup);
    } catch (error) {
      console.error('Showcase idle reset failed:', error.message);
    } finally {
      touchActivity();
    }
  }, 60 * 1000);
  timer.unref();
  console.log(`Showcase idle reset enabled: after ${hours} hour(s) without activity`);
  return true;
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { resetShowcase, startScheduler, stopScheduler };
