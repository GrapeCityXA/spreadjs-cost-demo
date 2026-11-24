const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { TarArchive } = require('archiver');
const sqlite3 = require('sqlite3').verbose();
const db = require('../config/database');
const storage = require('../config/storage');
const { recordBusinessAudit } = require('./businessAudit');

const run = (connection, sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function validateFinalizationContext(value) {
  if (value == null) return null;
  const invalid = () => Object.assign(new Error('定稿检查点元数据格式无效'), { status: 400 });
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const positiveInteger = number => Number.isSafeInteger(number) && number > 0;
  const keys = Object.keys(value).sort().join(',');
  if (keys === 'revisionId,revisionNumber,taskId'
    && positiveInteger(value.taskId) && positiveInteger(value.revisionId) && positiveInteger(value.revisionNumber)) return value;
  if (keys === 'packageId,revisions' && positiveInteger(value.packageId) && Array.isArray(value.revisions)
    && value.revisions.length > 0 && value.revisions.every(revision => revision && typeof revision === 'object'
      && !Array.isArray(revision) && Object.keys(revision).sort().join(',') === 'revisionId,taskId'
      && positiveInteger(revision.taskId) && positiveInteger(revision.revisionId))) return value;
  throw invalid();
}

async function fileManifest(root) {
  const result = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`Checkpoint cannot include symbolic links: ${relativePath}`);
      if (entry.isDirectory()) await walk(absolutePath);
      else if (entry.isFile()) {
        const content = await fs.readFile(absolutePath);
        result.push({ path: relativePath, sha256: sha256(content), byteSize: content.byteLength });
      }
    }
  }
  await walk(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function sqliteBackup(sourcePath, targetPath) {
  const reader = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(sourcePath, error => error ? reject(error) : resolve(connection));
  });
  try {
    await new Promise((resolve, reject) => {
      const backup = reader.backup(targetPath, error => {
        if (error) reject(error);
        else backup.step(-1, stepError => stepError ? reject(stepError) : resolve());
      });
    });
  } finally {
    await new Promise((resolve, reject) => reader.close(error => error ? reject(error) : resolve()));
  }
}

function createArchive(sourceDirectory, outputPath, archiveRootName) {
  return new Promise((resolve, reject) => {
    const output = require('node:fs').createWriteStream(outputPath);
    const archive = new TarArchive({ gzip: true, gzipOptions: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDirectory, archiveRootName);
    archive.finalize().catch(reject);
  });
}

async function copyDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true, errorOnExist: false, dereference: false,
    filter: async sourcePath => {
      const stats = await fs.lstat(sourcePath);
      if (stats.isSymbolicLink()) throw new Error(`Checkpoint cannot include symbolic links: ${sourcePath}`);
      return true;
    } });
}

async function createCheckpoint({ actor = null, reason = 'Scheduled consistent checkpoint', finalization = null,
  checkpointId: requestedCheckpointId = null, backupId: requestedBackupId = null } = {}) {
  const backupRoot = path.resolve(storage.getBackupDirectory());
  const checkpointId = requestedCheckpointId || `checkpoint-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  if (checkpointId.length > 128 || !/^checkpoint-[A-Za-z0-9-]+$/.test(checkpointId)) {
    throw Object.assign(new Error('Checkpoint ID is invalid'), { status: 400 });
  }
  const stagingDirectory = path.join(backupRoot, `.${checkpointId}.staging`);
  const archivePath = path.join(backupRoot, `${checkpointId}.tar.gz`);
  let backupId;
  let checkpointClaimed = false;
  let businessLocked = false;
  let collaborationLocked = false;
  try {
    await db.ready;
    await fs.mkdir(backupRoot, { recursive: true });
    if (requestedBackupId == null) {
      const record = await run(db, `INSERT INTO backup_records (backup_key, manifest_json, status, created_by)
        VALUES (?, '{}', 'running', ?)`, [checkpointId, actor?.id ?? null]);
      backupId = record.lastID;
      checkpointClaimed = true;
    } else {
      backupId = requestedBackupId;
      const retry = await run(db, `UPDATE backup_records SET status = 'running', completed_at = NULL
        WHERE id = ? AND backup_key = ? AND status = 'failed'`, [backupId, checkpointId]);
      if (!retry.changes) throw Object.assign(new Error('Checkpoint is not in a retryable failed state'), { status: 409 });
      checkpointClaimed = true;
    }
    await fs.mkdir(stagingDirectory, { recursive: true });
    await Promise.all([fs.mkdir(storage.getTemplateDirectory(), { recursive: true }),
      fs.mkdir(storage.getArtifactDirectory(), { recursive: true })]);

    await run(db, 'BEGIN IMMEDIATE');
    businessLocked = true;
    await run(db.collaborationDb, 'BEGIN IMMEDIATE');
    collaborationLocked = true;
    const businessPath = path.join(stagingDirectory, 'business.sqlite');
    const collaborationPath = path.join(stagingDirectory, 'collaboration.sqlite');
    await Promise.all([sqliteBackup(storage.getDatabasePath(), businessPath),
      sqliteBackup(storage.getCollaborationDatabasePath(), collaborationPath)]);
    await Promise.all([
      copyDirectory(storage.getTemplateDirectory(), path.join(stagingDirectory, 'templates')),
      copyDirectory(storage.getArtifactDirectory(), path.join(stagingDirectory, 'artifacts'))
    ]);
    await run(db.collaborationDb, 'COMMIT');
    collaborationLocked = false;
    await run(db, 'COMMIT');
    businessLocked = false;

    const files = await fileManifest(stagingDirectory);
    const manifest = { schemaVersion: 1, checkpointId, backupId, reason, createdAt: new Date().toISOString(),
      consistency: 'sqlite-backup-api-with-write-locks', stores: ['business.sqlite', 'collaboration.sqlite', 'templates/', 'artifacts/'],
      finalization: finalization || null, files };
    await fs.writeFile(path.join(stagingDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await createArchive(stagingDirectory, archivePath, checkpointId);
    await run(db, 'UPDATE backup_records SET status = ?, manifest_json = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['complete', JSON.stringify({ ...manifest, archivePath }), backupId]);
    if (actor) await recordBusinessAudit({ connection: db, actor, action: 'checkpoint.create', objectType: 'checkpoint',
      objectId: checkpointId, after: { backupId, archivePath, finalization }, reason });
    return { id: backupId, checkpointId, archivePath, manifest };
  } catch (error) {
    if (collaborationLocked) await run(db.collaborationDb, 'ROLLBACK').catch(() => {});
    if (businessLocked) await run(db, 'ROLLBACK').catch(() => {});
    if (checkpointClaimed) await fs.rm(archivePath, { force: true }).catch(() => {});
    if (checkpointClaimed) {
      await run(db, `UPDATE backup_records SET status = 'failed', manifest_json = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [JSON.stringify({ checkpointId, reason, finalization, error: error.message }), backupId]).catch(() => {});
    }
    if (!checkpointClaimed && requestedBackupId == null && error.code === 'SQLITE_CONSTRAINT' && !error.status) error.status = 409;
    error.checkpoint = { id: backupId ?? null, checkpointId, status: 'failed', reason, finalization };
    throw error;
  } finally {
    if (checkpointClaimed) await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function listCheckpoints() {
  await db.ready;
  const records = await all(db, `SELECT id, backup_key AS checkpointId, manifest_json AS manifestJson,
      status, created_by AS createdBy, created_at AS createdAt, completed_at AS completedAt
    FROM backup_records ORDER BY id DESC LIMIT 200`);
  return records.map(record => ({ ...record, manifest: JSON.parse(record.manifestJson || '{}'), manifestJson: undefined }));
}

async function retryCheckpoint({ checkpointId, actor, reason, finalization }) {
  await db.ready;
  const record = await get(db, `SELECT id, backup_key AS checkpointId, manifest_json AS manifestJson, status
    FROM backup_records WHERE backup_key = ?`, [checkpointId]);
  if (!record) {
    if (typeof reason !== 'string' || !reason.trim()) throw Object.assign(new Error('此检查点没有持久化记录，请提供原定稿的检查点原因'), { status: 409 });
    return createCheckpoint({ actor, checkpointId, reason: reason.trim(),
      finalization: validateFinalizationContext(finalization) });
  }
  if (record.status !== 'failed') throw Object.assign(new Error('只有失败的检查点可以重试'), { status: 409 });
  let metadata;
  try {
    metadata = JSON.parse(record.manifestJson || '{}');
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid checkpoint metadata shape');
  }
  catch (error) {
    if (typeof reason !== 'string' || !reason.trim() || finalization === undefined) {
      throw Object.assign(new Error('失败检查点元数据损坏，请重试时显式提供 reason 和 finalization'), { status: 409 });
    }
    metadata = {};
  }
  const retryReason = typeof reason === 'string' && reason.trim() ? reason.trim() : metadata.reason || 'Retry failed checkpoint';
  const retryFinalization = validateFinalizationContext(finalization === undefined ? metadata.finalization : finalization);
  return createCheckpoint({ actor, checkpointId: record.checkpointId, backupId: Number(record.id),
    reason: retryReason, finalization: retryFinalization });
}

async function compactCollaborationOperations({ actor, now = new Date(), retentionDays = 90 } = {}) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  await db.ready;
  await run(db.collaborationDb, 'BEGIN IMMEDIATE');
  try {
    const rooms = await all(db.collaborationDb, `SELECT d.id AS documentId, d.version AS currentVersion,
        d.snapshot_version AS snapshotVersion, r.id AS roomId
      FROM documents d JOIN collaboration_rooms r ON r.room_key = d.id`);
    let compactedOperations = 0;
    let compactedRooms = 0;
    for (const room of rooms) {
      const boundary = Math.min(Number(room.snapshotVersion), Number(room.currentVersion));
      const rows = await all(db.collaborationDb, `SELECT version, actor_user_id AS actorUserId, created_at AS createdAt
        FROM collaboration_operations WHERE room_id = ? AND version <= ? ORDER BY version`, [room.roomId, boundary]);
      const candidates = [];
      for (const row of rows) {
        if (row.createdAt >= cutoff) break;
        candidates.push(row);
      }
      if (!candidates.length) continue;
      const actorCounts = {};
      for (const row of candidates) actorCounts[String(row.actorUserId)] = (actorCounts[String(row.actorUserId)] || 0) + 1;
      const first = Number(candidates[0].version);
      const last = Number(candidates[candidates.length - 1].version);
      const versions = candidates.map(row => Number(row.version));
      const result = await run(db.collaborationDb, `INSERT OR IGNORE INTO collaboration_operation_summaries
        (room_id, from_version, through_version, operation_count, versions_json, actor_counts_json)
        VALUES (?, ?, ?, ?, ?, ?)`, [room.roomId, first, last, candidates.length, JSON.stringify(versions), JSON.stringify(actorCounts)]);
      if (!result.changes) continue;
      await run(db.collaborationDb, `DELETE FROM collaboration_operations WHERE room_id = ? AND version IN (${versions.map(() => '?').join(',')})`,
        [room.roomId, ...versions]);
      await run(db.collaborationDb, `DELETE FROM operations WHERE doc_id = ? AND version IN (${versions.map(() => '?').join(',')})`,
        [room.documentId, ...versions]);
      compactedOperations += candidates.length;
      compactedRooms += 1;
    }
    await run(db.collaborationDb, 'COMMIT');
    if (actor && compactedOperations) await recordBusinessAudit({ actor, action: 'collaboration.operations.compact',
      objectType: 'collaboration_operations', after: { compactedOperations, compactedRooms, cutoff },
      reason: `Compacted raw collaboration operations older than ${retentionDays} days` });
    return { compactedOperations, compactedRooms, cutoff };
  } catch (error) {
    await run(db.collaborationDb, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

async function cleanEmptyCollaborationRooms({ actor, reason } = {}) {
  if (!reason?.trim()) throw Object.assign(new Error('清理协作室必须填写原因'), { status: 400 });
  await db.ready;
  let businessLocked = false;
  let collaborationLocked = false;
  try {
    await run(db, 'BEGIN IMMEDIATE');
    businessLocked = true;
    await run(db.collaborationDb, 'BEGIN IMMEDIATE');
    collaborationLocked = true;
    const rooms = await all(db, `SELECT cr.id, cr.collaboration_room_key AS roomKey FROM collaboration_rooms cr
      WHERE cr.latest_version = 0 AND NOT EXISTS (
        SELECT 1 FROM business_revisions r WHERE r.collaboration_room_id = cr.id
          AND r.revision_status <> 'draft')`);
    let removed = 0;
    for (const room of rooms) {
      const collab = await get(db.collaborationDb, 'SELECT id FROM collaboration_rooms WHERE room_key = ?', [room.roomKey]);
      if (collab) {
        const occupied = await get(db.collaborationDb, `SELECT
          (SELECT COUNT(*) FROM collaboration_operations WHERE room_id = ?) +
          (SELECT COUNT(*) FROM collaboration_snapshots WHERE room_id = ? AND version > 0) +
          (SELECT COUNT(*) FROM operations WHERE doc_id = ?) +
          (SELECT COUNT(*) FROM collaboration_milestones WHERE doc_id = ? AND version > 0) +
          (SELECT COUNT(*) FROM documents WHERE id = ? AND version > 0) AS count`,
        [collab.id, collab.id, room.roomKey, room.roomKey, room.roomKey]);
        if (Number(occupied.count) > 0) continue;
        await run(db.collaborationDb, 'DELETE FROM collaboration_operations WHERE room_id = ?', [collab.id]);
        await run(db.collaborationDb, 'DELETE FROM collaboration_snapshots WHERE room_id = ?', [collab.id]);
        await run(db.collaborationDb, 'DELETE FROM collaboration_milestones WHERE doc_id = ?', [room.roomKey]);
        await run(db.collaborationDb, 'DELETE FROM operations WHERE doc_id = ?', [room.roomKey]);
        await run(db.collaborationDb, 'DELETE FROM snapshot_fragments WHERE doc_id = ?', [room.roomKey]);
        await run(db.collaborationDb, 'DELETE FROM documents WHERE id = ?', [room.roomKey]);
        await run(db.collaborationDb, 'DELETE FROM collaboration_presence WHERE room_id = ?', [collab.id]);
        await run(db.collaborationDb, 'DELETE FROM collaboration_rooms WHERE id = ?', [collab.id]);
      }
      await run(db, `UPDATE business_revisions SET collaboration_room_id = NULL
        WHERE collaboration_room_id = ? AND revision_status = 'draft'`, [room.id]);
      await run(db, 'DELETE FROM collaboration_rooms WHERE id = ?', [room.id]);
      removed += 1;
    }
    if (actor && removed) await recordBusinessAudit({ actor, action: 'collaboration.rooms.cleanup',
      objectType: 'collaboration_room', after: { removed }, reason: reason.trim() });
    await run(db.collaborationDb, 'COMMIT');
    collaborationLocked = false;
    await run(db, 'COMMIT');
    businessLocked = false;
    return { removed };
  } catch (error) {
    if (collaborationLocked) await run(db.collaborationDb, 'ROLLBACK').catch(() => {});
    if (businessLocked) await run(db, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = { createCheckpoint, retryCheckpoint, listCheckpoints, compactCollaborationOperations,
  cleanEmptyCollaborationRooms };
