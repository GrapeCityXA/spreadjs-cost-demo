const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sqlite3 = require('sqlite3').verbose();
const storage = require('../src/config/storage');

const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const run = (connection, sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const close = connection => new Promise((resolve, reject) => connection.close(error => error ? reject(error) : resolve()));

function parseArgs(args) {
  const values = { archive: null, userId: null, reason: '', offlineConfirmed: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--confirm-offline') values.offlineConfirmed = true;
    else if (arg === '--user-id') values.userId = Number(args[++index]);
    else if (arg === '--reason') values.reason = String(args[++index] || '').trim();
    else if (!values.archive && !arg.startsWith('--')) values.archive = arg;
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!values.archive || !values.offlineConfirmed || !Number.isSafeInteger(values.userId) || values.userId < 1 || !values.reason) {
    throw new Error('Usage: node server/scripts/restore-checkpoint.cjs <archive.tar.gz> --confirm-offline --user-id <id> --reason <text>');
  }
  return values;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function validateArchiveEntries(archivePath) {
  const listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  if (!listing.length) throw new Error('Checkpoint archive is empty');
  const roots = new Set();
  for (const entry of listing) {
    const normalized = entry.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (!parts.length || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized) || parts.includes('..')) {
      throw new Error(`Unsafe path in checkpoint archive: ${entry}`);
    }
    roots.add(parts[0]);
  }
  if (roots.size !== 1) throw new Error('Checkpoint must contain exactly one top-level directory');
  const verbose = execFileSync('tar', ['-tzvf', archivePath], { encoding: 'utf8' });
  if (verbose.split(/\r?\n/).some(line => /^[lh]/.test(line))) throw new Error('Checkpoint archive may not contain links');
  return [...roots][0];
}

async function validateExtractedBundle(bundleRoot) {
  const manifest = JSON.parse(await fs.readFile(path.join(bundleRoot, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.backupId || !Array.isArray(manifest.files)) throw new Error('Checkpoint manifest is invalid');
  const expected = new Set();
  for (const item of manifest.files) {
    const relative = String(item.path || '').replace(/\\/g, '/');
    const parts = relative.split('/');
    if (!relative || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || parts.includes('..') || expected.has(relative)) {
      throw new Error(`Checkpoint manifest contains an unsafe or duplicate path: ${relative}`);
    }
    expected.add(relative);
    const content = await fs.readFile(path.join(bundleRoot, ...parts));
    if (content.byteLength !== item.byteSize || sha256(content) !== item.sha256) throw new Error(`Checkpoint file failed integrity validation: ${relative}`);
  }
  const actual = new Set();
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relative = path.relative(bundleRoot, absolutePath).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`Checkpoint extraction contains a link: ${relative}`);
      if (entry.isDirectory()) await walk(absolutePath);
      else if (entry.isFile() && relative !== 'manifest.json') actual.add(relative);
    }
  }
  await walk(bundleRoot);
  if (actual.size !== expected.size || [...actual].some(relative => !expected.has(relative))) throw new Error('Checkpoint contains files outside its manifest');
  for (const required of ['business.sqlite', 'collaboration.sqlite']) if (!expected.has(required)) throw new Error(`Checkpoint is missing ${required}`);
  for (const required of ['templates', 'artifacts']) if (!(await fs.stat(path.join(bundleRoot, required))).isDirectory()) throw new Error(`Checkpoint is missing ${required}/`);
  return manifest;
}

async function validateBusinessDatabase(databasePath, userId, backupId) {
  const connection = await new Promise((resolve, reject) => {
    const opened = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(opened));
  });
  try {
    const integrity = await get(connection, 'PRAGMA integrity_check');
    if (integrity?.integrity_check !== 'ok') throw new Error('Checkpoint business database failed SQLite integrity_check');
    const user = await get(connection, `SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id
      WHERE u.id=? AND u.account_status='active' AND r.role_code='system_admin' AND r.organization_id IS NULL
        AND r.effective_from<=CURRENT_TIMESTAMP AND (r.effective_to IS NULL OR r.effective_to>CURRENT_TIMESTAMP) LIMIT 1`, [userId]);
    if (!user) throw new Error(`Restore administrator user ${userId} is not active with a global system_admin role in the checkpoint`);
    if (!await get(connection, 'SELECT id FROM backup_records WHERE id=?', [backupId])) throw new Error('Checkpoint does not contain its backup record');
  } finally { await close(connection); }
}

async function swapDirectory(source, target, suffix, changes) {
  const parent = path.dirname(target);
  const prepared = path.join(parent, `.restore-${path.basename(target)}-${suffix}`);
  await fs.rm(prepared, { recursive: true, force: true });
  await fs.cp(source, prepared, { recursive: true, force: false, dereference: false });
  const previous = `${target}.pre-restore-${suffix}`;
  let movedPrevious = false;
  if (await fs.stat(target).then(() => true, () => false)) {
    await fs.rename(target, previous);
    movedPrevious = true;
  }
  try {
    await fs.rename(prepared, target);
    changes.push({ target, previous: movedPrevious ? previous : null });
  } catch (error) {
    if (movedPrevious) await fs.rename(previous, target).catch(() => {});
    throw error;
  }
}

async function swapFile(source, target, suffix, changes) {
  const parent = path.dirname(target);
  const prepared = path.join(parent, `.restore-${path.basename(target)}-${suffix}`);
  await fs.copyFile(source, prepared);
  const previous = `${target}.pre-restore-${suffix}`;
  let movedPrevious = false;
  if (await fs.stat(target).then(() => true, () => false)) {
    await fs.rename(target, previous);
    movedPrevious = true;
  }
  try {
    await fs.rename(prepared, target);
    changes.push({ target, previous: movedPrevious ? previous : null });
  } catch (error) {
    if (movedPrevious) await fs.rename(previous, target).catch(() => {});
    throw error;
  }
}

async function rollback(changes) {
  for (const change of changes.reverse()) {
    await fs.rm(change.target, { recursive: true, force: true }).catch(() => {});
    if (change.previous) await fs.rename(change.previous, change.target).catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const archivePath = path.resolve(options.archive);
  const root = validateArchiveEntries(archivePath);
  const backupRoot = path.resolve(storage.getBackupDirectory());
  const extractionDirectory = path.join(backupRoot, `.restore-${Date.now()}-${crypto.randomUUID()}`);
  const bundleRoot = path.join(extractionDirectory, root);
  const suffix = `${Date.now()}-${crypto.randomUUID()}`;
  const changes = [];
  await fs.mkdir(extractionDirectory, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', extractionDirectory, '--no-same-owner', '--no-same-permissions']);
    const manifest = await validateExtractedBundle(bundleRoot);
    await validateBusinessDatabase(path.join(bundleRoot, 'business.sqlite'), options.userId, manifest.backupId);
    const collaborationValidation = await new Promise((resolve, reject) => {
      const connection = new sqlite3.Database(path.join(bundleRoot, 'collaboration.sqlite'), sqlite3.OPEN_READONLY,
        error => error ? reject(error) : connection.get('PRAGMA integrity_check', (queryError, row) => {
          connection.close(() => queryError ? reject(queryError) : resolve(row?.integrity_check));
        }));
    });
    if (collaborationValidation !== 'ok') throw new Error('Checkpoint collaboration database failed SQLite integrity_check');
    const businessPath = path.resolve(storage.getDatabasePath());
    const collaborationPath = path.resolve(storage.getCollaborationDatabasePath());
    if (businessPath === collaborationPath) throw new Error('Business and collaboration databases must remain separate');
    for (const target of [businessPath, collaborationPath, path.resolve(storage.getTemplateDirectory()), path.resolve(storage.getArtifactDirectory())]) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (path.relative(path.resolve(extractionDirectory), target).split(path.sep)[0] !== '..') {
        throw new Error(`Restore target overlaps checkpoint staging: ${target}`);
      }
    }
    await swapFile(path.join(bundleRoot, 'business.sqlite'), businessPath, suffix, changes);
    await swapFile(path.join(bundleRoot, 'collaboration.sqlite'), collaborationPath, suffix, changes);
    await swapDirectory(path.join(bundleRoot, 'templates'), path.resolve(storage.getTemplateDirectory()), suffix, changes);
    await swapDirectory(path.join(bundleRoot, 'artifacts'), path.resolve(storage.getArtifactDirectory()), suffix, changes);

    const restoredDb = await new Promise((resolve, reject) => {
      const connection = new sqlite3.Database(businessPath, error => error ? reject(error) : resolve(connection));
    });
    try {
      await run(restoredDb, 'PRAGMA foreign_keys=ON');
      await run(restoredDb, 'BEGIN IMMEDIATE');
      await run(restoredDb, "UPDATE backup_records SET status='complete' WHERE id = ?", [manifest.backupId]);
      await run(restoredDb, `INSERT INTO restore_events(backup_id, restored_by, reason, status, details_json)
        VALUES (?, ?, ?, 'awaiting_service_recovery', ?)`, [manifest.backupId, options.userId, options.reason,
        JSON.stringify({ checkpointId: manifest.checkpointId, archivePath })]);
      await run(restoredDb, 'COMMIT');
    } catch (error) {
      await run(restoredDb, 'ROLLBACK').catch(() => {});
      throw error;
    } finally { await close(restoredDb); }
    const markerPath = path.join(storage.getBackupDirectory(), 'pending-restore-audit.json');
    const markerTemporaryPath = `${markerPath}.tmp`;
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerTemporaryPath, JSON.stringify({ backupId: manifest.backupId, restoredBy: options.userId,
      checkpointId: manifest.checkpointId, reason: options.reason, details: { archivePath } }, null, 2), 'utf8');
    await fs.rename(markerTemporaryPath, markerPath);
    process.stdout.write(`Restored ${manifest.checkpointId}. Start the service; startup will write the recovery audit before listening.\n`);
  } catch (error) {
    await rollback(changes);
    throw error;
  } finally {
    await fs.rm(extractionDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
