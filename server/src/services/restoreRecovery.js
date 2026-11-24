const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../config/database');
const storage = require('../config/storage');
const { recordBusinessAudit } = require('./businessAudit');

const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const run = (connection, sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));

async function recoverPendingRestoreAudit() {
  const markerPath = path.join(storage.getBackupDirectory(), 'pending-restore-audit.json');
  let marker;
  try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  await db.ready;
  const user = await get(db, `SELECT u.id, u.username, u.name, u.organization_id AS organizationId
    FROM users u JOIN effective_user_roles r ON r.user_id = u.id
    WHERE u.id = ? AND u.account_status = 'active' AND r.role_code = 'system_admin'
      AND r.organization_id IS NULL AND r.effective_from <= CURRENT_TIMESTAMP
      AND (r.effective_to IS NULL OR r.effective_to > CURRENT_TIMESTAMP) LIMIT 1`, [marker.restoredBy]);
  if (!user) throw new Error('The restored checkpoint administrator is no longer active; recovery audit was not written');
  await run(db, 'BEGIN IMMEDIATE');
  try {
    const pending = await get(db, `SELECT id, status FROM restore_events WHERE backup_id = ? AND restored_by = ?
      AND status = 'awaiting_service_recovery' ORDER BY id DESC LIMIT 1`, [marker.backupId, user.id]);
    if (!pending) {
      await run(db, 'COMMIT');
      await fs.rm(markerPath, { force: true });
      return false;
    }
    await recordBusinessAudit({ connection: db, actor: user, action: 'checkpoint.restore.recovered', objectType: 'checkpoint',
      objectId: marker.checkpointId, after: { backupId: marker.backupId, status: 'recovered' }, reason: marker.reason });
    await run(db, `UPDATE restore_events SET status='recovered', details_json=? WHERE id=?`,
      [JSON.stringify({ ...marker.details, recoveredAt: new Date().toISOString() }), pending.id]);
    await run(db, 'COMMIT');
    await fs.rm(markerPath, { force: true });
    return true;
  } catch (error) {
    await run(db, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = { recoverPendingRestoreAudit };
