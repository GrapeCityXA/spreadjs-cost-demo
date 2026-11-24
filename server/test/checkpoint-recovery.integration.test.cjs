const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();

const root = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'ticket28-checkpoint-'));
process.env.COST_REPORT_DB_PATH = path.join(root, 'live', 'business.sqlite');
process.env.COST_REPORT_COLLAB_DB_PATH = path.join(root, 'live', 'collaboration.sqlite');
process.env.COST_REPORT_TEMPLATE_DIR = path.join(root, 'live', 'templates');
process.env.COST_REPORT_ARTIFACT_DIR = path.join(root, 'live', 'artifacts');
process.env.COST_REPORT_BACKUP_DIR = path.join(root, 'live', 'backups');

const app = require('../src/app');
const db = require('../src/config/database');
const collaboration = require('../src/services/collaborationServer');
const server = http.createServer(app);

async function request(base, route, options = {}) {
  const response = await fetch(`${base}/api${route}`, {
    method: options.method || 'GET',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  return { response, payload: await response.json().catch(() => ({})) };
}

async function run() {
  try {
    await db.ready;
    await collaboration.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const hash = await bcrypt.hash('checkpoint-admin-password', 4);
    const admin = await db._helpers.run(db, 'INSERT INTO users(username,password,name,permissions) VALUES (?,?,?,?)',
      ['checkpoint-admin', hash, 'Checkpoint Administrator', JSON.stringify(['template', 'report'])]);
    await db._helpers.run(db, "INSERT INTO user_roles(user_id,role_code) VALUES (?, 'system_admin')", [admin.lastID]);
    const login = await request(base, '/auth/login', { method: 'POST', body: { username: 'checkpoint-admin', password: 'checkpoint-admin-password' } });
    assert.equal(login.response.status, 200);
    const token = login.payload.token;
    assert.equal((await request(base, '/system-operations/checkpoints')).response.status, 401,
      'checkpoint operations must require authentication');
    await db._helpers.run(db, 'INSERT INTO users(username,password,name,permissions) VALUES (?,?,?,?)',
      ['checkpoint-viewer', hash, 'Checkpoint Viewer', JSON.stringify(['report'])]);
    const viewerLogin = await request(base, '/auth/login', { method: 'POST', body: { username: 'checkpoint-viewer', password: 'checkpoint-admin-password' } });
    assert.equal(viewerLogin.response.status, 200);
    assert.equal((await request(base, '/system-operations/checkpoints', { token: viewerLogin.payload.token })).response.status, 403,
      'checkpoint operations must require a system administrator');
    await fs.mkdir(process.env.COST_REPORT_TEMPLATE_DIR, { recursive: true });
    await fs.mkdir(path.join(process.env.COST_REPORT_ARTIFACT_DIR, 'evidence'), { recursive: true });
    await fs.writeFile(path.join(process.env.COST_REPORT_TEMPLATE_DIR, 'published-template.json'), '{"version":4}');
    await fs.writeFile(path.join(process.env.COST_REPORT_ARTIFACT_DIR, 'evidence', 'proof.pdf'), 'retained evidence');

    const invalidRetention = await request(base, '/system-operations/collaboration/compact', { method: 'POST', token, body: { retentionDays: 89 } });
    assert.equal(invalidRetention.response.status, 400, 'raw collaboration operations must be kept for at least 90 days');
    const unsafeCheckpointId = await request(base, '/system-operations/checkpoints/%2E%2E%2F%2E%2E%2Foutside/retry', {
      method: 'POST', token, body: { reason: 'Must reject an unsafe checkpoint ID' }
    });
    assert.equal(unsafeCheckpointId.response.status, 400, 'checkpoint IDs must not allow path traversal');

    const checkpoint = await request(base, '/system-operations/checkpoints', { method: 'POST', token, body: { reason: 'Ticket 28 recovery acceptance' } });
    assert.equal(checkpoint.response.status, 201, JSON.stringify(checkpoint.payload));
    const archivePath = checkpoint.payload.archivePath;
    assert.ok(await fs.stat(archivePath));
    const extracted = path.join(root, 'restored');
    await fs.mkdir(extracted, { recursive: true });
    execFileSync('tar', ['-xzf', archivePath, '-C', extracted]);
    const bundle = path.join(extracted, checkpoint.payload.checkpointId);
    const manifest = JSON.parse(await fs.readFile(path.join(bundle, 'manifest.json'), 'utf8'));
    assert.equal(manifest.backupId, checkpoint.payload.id);
    for (const file of manifest.files) {
      const content = await fs.readFile(path.join(bundle, ...file.path.split('/')));
      assert.equal(crypto.createHash('sha256').update(content).digest('hex'), file.sha256, file.path);
    }
    assert.ok(manifest.files.some(file => file.path === 'business.sqlite'));
    assert.ok(manifest.files.some(file => file.path === 'collaboration.sqlite'));
    assert.ok(manifest.files.some(file => file.path === 'templates/published-template.json'));
    assert.ok(manifest.files.some(file => file.path === 'artifacts/evidence/proof.pdf'));

    await db._helpers.run(db, `UPDATE backup_records SET status='failed', manifest_json=? WHERE id=?`,
      [JSON.stringify({ checkpointId: checkpoint.payload.checkpointId, reason: 'Retry acceptance', finalization: null }), checkpoint.payload.id]);
    const retryAttempts = await Promise.all([1, 2].map(() => request(base,
      `/system-operations/checkpoints/${checkpoint.payload.checkpointId}/retry`, { method: 'POST', token })));
    const retriedCheckpoint = retryAttempts.find(result => result.response.status === 200);
    assert.ok(retriedCheckpoint, JSON.stringify(retryAttempts.map(result => result.payload)));
    assert.ok(retryAttempts.some(result => result.response.status === 409), 'concurrent retries must report a conflict to the loser');
    assert.equal(retriedCheckpoint.payload.checkpointId, checkpoint.payload.checkpointId);
    assert.equal((await db._helpers.get(db, 'SELECT status FROM backup_records WHERE id=?', [checkpoint.payload.id])).status, 'complete');
    assert.ok(await fs.stat(checkpoint.payload.archivePath), 'a losing concurrent retry must not delete the winner archive');
    const orphanCheckpointId = `checkpoint-retry-${crypto.randomUUID()}`;
    const orphanRetries = await Promise.all([1, 2].map(() => request(base,
      `/system-operations/checkpoints/${orphanCheckpointId}/retry`, { method: 'POST', token,
        body: { reason: 'Recover checkpoint without a reservation row',
          finalization: { taskId: 101, revisionId: 8, revisionNumber: 2 } } })));
    const orphanRetry = orphanRetries.find(result => result.response.status === 200);
    assert.ok(orphanRetry, JSON.stringify(orphanRetries.map(result => result.payload)));
    assert.ok(orphanRetries.some(result => result.response.status === 409), 'concurrent orphan retries must report a conflict to the loser');
    assert.equal(orphanRetry.payload.checkpointId, orphanCheckpointId);
    assert.equal(orphanRetry.payload.manifest.finalization.revisionId, 8);
    const corruptedCheckpointId = `checkpoint-corrupt-${crypto.randomUUID()}`;
    await db._helpers.run(db, `INSERT INTO backup_records(backup_key,manifest_json,status,created_by)
      VALUES (?, 'null', 'failed', ?)`, [corruptedCheckpointId, admin.lastID]);
    const missingRecoveryMetadata = await request(base, `/system-operations/checkpoints/${corruptedCheckpointId}/retry`, {
      method: 'POST', token, body: { reason: 'Repair corrupted checkpoint metadata' }
    });
    assert.equal(missingRecoveryMetadata.response.status, 409);
    const recoveredCorruptedCheckpoint = await request(base, `/system-operations/checkpoints/${corruptedCheckpointId}/retry`, {
      method: 'POST', token, body: { reason: 'Repair corrupted checkpoint metadata',
        finalization: { taskId: 101, revisionId: 8, revisionNumber: 2 } }
    });
    assert.equal(recoveredCorruptedCheckpoint.response.status, 200, JSON.stringify(recoveredCorruptedCheckpoint.payload));
    assert.equal(recoveredCorruptedCheckpoint.payload.manifest.finalization.revisionNumber, 2);

    const compactDb = db.collaborationDb;
    const room = await db._helpers.run(compactDb, `INSERT INTO collaboration_rooms(room_key,task_id,revision_number,current_version)
      VALUES ('retention-room',101,1,2)`);
    await db._helpers.run(compactDb, 'INSERT INTO documents(id,type,version,snapshot_version) VALUES (?,?,?,?)', ['retention-room', 'spreadjs', 2, 1]);
    await db._helpers.run(compactDb, 'INSERT INTO collaboration_milestones(doc_id,version,snapshot_json) VALUES (?,?,?)',
      ['retention-room', 1, '{"data":{"retained":true}}']);
    await db._helpers.run(compactDb, 'INSERT INTO collaboration_operations(room_id,version,actor_user_id,operation_json,created_at) VALUES (?,?,?,?,?)',
      [room.lastID, 1, admin.lastID, '{"v":1}', '2020-01-01 00:00:00']);
    await db._helpers.run(compactDb, 'INSERT INTO collaboration_operations(room_id,version,actor_user_id,operation_json,created_at) VALUES (?,?,?,?,?)',
      [room.lastID, 2, admin.lastID, '{"v":2}', '2020-01-01 00:00:01']);
    await db._helpers.run(compactDb, 'INSERT INTO operations(doc_id,version,operation) VALUES (?,?,?)', ['retention-room', 1, '{"ot":1}']);
    await db._helpers.run(compactDb, 'INSERT INTO operations(doc_id,version,operation) VALUES (?,?,?)', ['retention-room', 2, '{"ot":2}']);
    const compact = await request(base, '/system-operations/collaboration/compact', { method: 'POST', token, body: {} });
    assert.equal(compact.response.status, 200, JSON.stringify(compact.payload));
    assert.equal(compact.payload.compactedOperations, 1);
    const retained = await db._helpers.all(compactDb, 'SELECT version FROM collaboration_operations WHERE room_id = ? ORDER BY version', [room.lastID]);
    assert.deepEqual(retained.map(row => row.version), [2], 'operations newer than the persisted snapshot must remain');
    const summary = await db._helpers.get(compactDb, 'SELECT from_version, through_version, operation_count, versions_json FROM collaboration_operation_summaries WHERE room_id = ?', [room.lastID]);
    assert.deepEqual(summary, { from_version: 1, through_version: 1, operation_count: 1, versions_json: '[1]' });
    const snapshot = await db._helpers.get(compactDb, 'SELECT snapshot_json FROM collaboration_milestones WHERE doc_id = ? AND version = 1', ['retention-room']);
    assert.equal(JSON.parse(snapshot.snapshot_json).data.retained, true);

    const org = await db._helpers.run(db, "INSERT INTO organizations(code,name) VALUES ('RETENTION-ORG','Retention Test')");
    const template = await db._helpers.run(db, "INSERT INTO templates(name,created_by,status) VALUES ('Retention Template',?,'draft')", [admin.lastID]);
    const templateVersion = await db._helpers.run(db, `INSERT INTO template_versions(template_id,version,status,manifest_json,workbook_json,created_by)
      VALUES (?,1,'draft','{}','{}',?)`, [template.lastID, admin.lastID]);
    const reportType = await db._helpers.run(db, `INSERT INTO report_types(code,display_name,cadence,workflow_profile,created_by)
      VALUES ('RETENTION-REPORT','Retention Test','monthly','standard',?)`, [admin.lastID]);
    const packageRow = await db._helpers.run(db, `INSERT INTO period_packages(report_type_id,period_code,template_version_id,created_by)
      VALUES (?,'2026-09',?,?)`, [reportType.lastID, templateVersion.lastID, admin.lastID]);
    const task = await db._helpers.run(db, `INSERT INTO report_tasks(package_id,report_type_id,organization_id,period_code,deadline_at,
      configuration_snapshot_json,template_version_id) VALUES (?,?,?,'2026-09','2026-10-15T00:00:00.000Z','{}',?)`,
    [packageRow.lastID, reportType.lastID, org.lastID, templateVersion.lastID]);
    const emptyRoom = await db._helpers.run(db, `INSERT INTO collaboration_rooms(task_id,revision_number,collaboration_room_key,
      collaboration_db,latest_version) VALUES (?,1,'empty-room',?,0)`, [task.lastID, process.env.COST_REPORT_COLLAB_DB_PATH]);
    const draftRevision = await db._helpers.run(db, `INSERT INTO business_revisions(task_id,revision_number,revision_status,collaboration_room_id)
      VALUES (?,1,'draft',?)`, [task.lastID, emptyRoom.lastID]);
    await db._helpers.run(db, 'UPDATE report_tasks SET current_revision_id=? WHERE id=?', [draftRevision.lastID, task.lastID]);
    const emptyCollaborationRoom = await db._helpers.run(compactDb, `INSERT INTO collaboration_rooms(room_key,task_id,revision_number,current_version)
      VALUES ('empty-room',?,1,0)`, [task.lastID]);
    await db._helpers.run(compactDb, 'INSERT INTO documents(id,type,version,snapshot_version) VALUES (?,?,0,0)', ['empty-room', 'spreadjs']);
    await db._helpers.run(compactDb, 'INSERT INTO snapshot_fragments(doc_id,fragment_id,data) VALUES (?,?,?)',
      ['empty-room', 'seed', '{"template":true}']);
    const emptyCleanup = await request(base, '/system-operations/collaboration/empty-rooms/cleanup', { method: 'POST', token,
      body: { reason: 'Remove never-submitted empty room' } });
    assert.equal(emptyCleanup.response.status, 200, JSON.stringify(emptyCleanup.payload));
    assert.equal(emptyCleanup.payload.removed, 1);
    assert.equal(await db._helpers.get(db, 'SELECT id FROM collaboration_rooms WHERE id=?', [emptyRoom.lastID]), undefined);
    assert.equal((await db._helpers.get(db, 'SELECT collaboration_room_id AS roomId FROM business_revisions WHERE id=?', [draftRevision.lastID])).roomId, null);
    assert.equal(await db._helpers.get(compactDb, 'SELECT id FROM collaboration_rooms WHERE id=?', [emptyCollaborationRoom.lastID]), undefined);
    assert.equal(await db._helpers.get(compactDb, 'SELECT id FROM documents WHERE id=?', ['empty-room']), undefined);

    const legacyDraft = await db._helpers.run(db, 'INSERT INTO reports(title,status,created_by) VALUES (?,?,?)', ['Retained Draft', 'draft', admin.lastID]);
    const legacySubmitted = await db._helpers.run(db, 'INSERT INTO reports(title,status,created_by) VALUES (?,?,?)', ['Retained Submitted', 'submitted', admin.lastID]);
    const draftDelete = await request(base, `/reports/${legacyDraft.lastID}`, { method: 'DELETE', token });
    assert.equal(draftDelete.response.status, 404, JSON.stringify(draftDelete.payload));
    const submittedDelete = await request(base, `/reports/${legacySubmitted.lastID}`, { method: 'DELETE', token });
    assert.equal(submittedDelete.response.status, 404);
    const reset = await request(base, '/database/reset', { method: 'POST', token, body: { confirm: 'RESET_DATABASE_CONFIRMED' } });
    assert.equal(reset.response.status, 404);
    const clear = await request(base, '/database/clear-reports', { method: 'POST', token, body: {} });
    assert.equal(clear.response.status, 404);
    assert.ok(await db._helpers.get(db, 'SELECT id FROM reports WHERE id=?', [legacySubmitted.lastID]));

    const deleteableTemplate = await db._helpers.run(db, "INSERT INTO templates(name,status,created_by) VALUES ('Deleteable Draft','draft',?)", [admin.lastID]);
    const protectedTemplate = await db._helpers.run(db, "INSERT INTO templates(name,status,created_by) VALUES ('Published Template','published',?)", [admin.lastID]);
    const deleteDraft = await request(base, `/templates/${deleteableTemplate.lastID}`, { method: 'DELETE', token });
    assert.equal(deleteDraft.response.status, 404, JSON.stringify(deleteDraft.payload));
    const deletePublished = await request(base, `/templates/${protectedTemplate.lastID}`, { method: 'DELETE', token });
    assert.equal(deletePublished.response.status, 404);

    assert.ok(await db._helpers.get(db, 'SELECT id FROM reports WHERE id=?', [legacyDraft.lastID]));
    assert.ok(await db._helpers.get(db, 'SELECT id FROM templates WHERE id=?', [deleteableTemplate.lastID]));

    const officialDirectory = path.join(process.env.COST_REPORT_ARTIFACT_DIR, 'official');
    const attachmentDirectory = path.join(process.env.COST_REPORT_ARTIFACT_DIR, 'evidence');
    await fs.mkdir(officialDirectory, { recursive: true });
    const historicalArtifactPath = path.join(officialDirectory, 'historic-revision.pdf');
    const currentArtifactPath = path.join(officialDirectory, 'current-revision.pdf');
    const historicalAttachmentPath = path.join(attachmentDirectory, 'historic-evidence.pdf');
    const currentAttachmentPath = path.join(attachmentDirectory, 'current-evidence.pdf');
    await Promise.all([[historicalArtifactPath, 'historic official artifact'], [currentArtifactPath, 'current official artifact'],
      [historicalAttachmentPath, 'historic attachment'], [currentAttachmentPath, 'current attachment']]
      .map(([file, content]) => fs.writeFile(file, content)));
    const historicRevision = await db._helpers.run(db, `INSERT INTO business_revisions(task_id,revision_number,revision_status,is_current_effective)
      VALUES (?,2,'draft',0)`, [task.lastID]);
    await db._helpers.run(db, 'UPDATE report_tasks SET current_revision_id=? WHERE id=?', [historicRevision.lastID, task.lastID]);
    const historicArtifactContent = await fs.readFile(historicalArtifactPath);
    await db._helpers.run(db, `INSERT INTO official_artifacts(revision_id,artifact_type,storage_key,sha256,byte_size)
      VALUES (?,?,?,?,?)`, [historicRevision.lastID, 'finalized_pdf', historicalArtifactPath,
      crypto.createHash('sha256').update(historicArtifactContent).digest('hex'), historicArtifactContent.byteLength]);
    const historicAttachmentContent = await fs.readFile(historicalAttachmentPath);
    await db._helpers.run(db, `INSERT INTO attachments(task_id,revision_id,original_name,storage_key,media_type,byte_size,sha256,uploaded_by)
      VALUES (?,?,?,?,?,?,?,?)`, [task.lastID, historicRevision.lastID, path.basename(historicalAttachmentPath), historicalAttachmentPath,
      'application/pdf', historicAttachmentContent.byteLength, crypto.createHash('sha256').update(historicAttachmentContent).digest('hex'), admin.lastID]);
    const finalRoom = await db._helpers.run(db, `INSERT INTO collaboration_rooms(task_id,revision_number,collaboration_room_key,
      collaboration_db,latest_version,room_status) VALUES (?,3,'finalized-history-room',?,1,'closed')`,
    [task.lastID, process.env.COST_REPORT_COLLAB_DB_PATH]);
    const currentRevision = await db._helpers.run(db, `INSERT INTO business_revisions(task_id,revision_number,revision_status,
      collaboration_room_id,is_current_effective) VALUES (?,3,'draft',?,0)`, [task.lastID, finalRoom.lastID]);
    await db._helpers.run(db, 'UPDATE report_tasks SET current_revision_id=? WHERE id=?', [currentRevision.lastID, task.lastID]);
    const currentArtifactContent = await fs.readFile(currentArtifactPath);
    await db._helpers.run(db, `INSERT INTO official_artifacts(revision_id,artifact_type,storage_key,sha256,byte_size)
      VALUES (?,?,?,?,?)`, [currentRevision.lastID, 'finalized_pdf', currentArtifactPath,
      crypto.createHash('sha256').update(currentArtifactContent).digest('hex'), currentArtifactContent.byteLength]);
    const currentAttachmentContent = await fs.readFile(currentAttachmentPath);
    await db._helpers.run(db, `INSERT INTO attachments(task_id,revision_id,original_name,storage_key,media_type,byte_size,sha256,uploaded_by)
      VALUES (?,?,?,?,?,?,?,?)`, [task.lastID, currentRevision.lastID, path.basename(currentAttachmentPath), currentAttachmentPath,
      'application/pdf', currentAttachmentContent.byteLength, crypto.createHash('sha256').update(currentAttachmentContent).digest('hex'), admin.lastID]);
    await db._helpers.run(db, `UPDATE business_revisions SET revision_status='finalized',is_current_effective=0 WHERE id=?`, [historicRevision.lastID]);
    await db._helpers.run(db, `UPDATE business_revisions SET revision_status='finalized',is_current_effective=1 WHERE id=?`, [currentRevision.lastID]);
    await db._helpers.run(db, "UPDATE report_tasks SET task_status='finalized' WHERE id=?", [task.lastID]);
    await assert.rejects(db._helpers.run(db, 'DELETE FROM official_artifacts WHERE revision_id=?', [currentRevision.lastID]), /official artifacts are retained/);
    const protectedAudit = await db._helpers.get(db, `SELECT id FROM business_audit_events
      WHERE action='checkpoint.create' ORDER BY id DESC LIMIT 1`);
    await assert.rejects(db._helpers.run(db, 'DELETE FROM business_audit_events WHERE id=?', [protectedAudit.id]), /business audit events are retained/);
    const snapshotRoom = await db._helpers.run(compactDb, `INSERT INTO collaboration_rooms(room_key,task_id,revision_number,current_version,room_status)
      VALUES ('finalized-history-room',?,3,1,'closed')`, [task.lastID]);
    await db._helpers.run(compactDb, 'INSERT INTO documents(id,type,version,snapshot_version) VALUES (?,?,1,1)', ['finalized-history-room', 'spreadjs']);
    const collaborationSnapshot = JSON.stringify({ data: { taskId: task.lastID, revisionNumber: 3, cells: { A1: 'evidence' } } });
    await db._helpers.run(compactDb, 'INSERT INTO collaboration_milestones(doc_id,version,snapshot_json) VALUES (?,?,?)',
      ['finalized-history-room', 1, collaborationSnapshot]);
    await db._helpers.run(compactDb, 'INSERT INTO collaboration_snapshots(room_id,version,snapshot_json) VALUES (?,?,?)',
      [snapshotRoom.lastID, 1, collaborationSnapshot]);
    const records = await request(base, '/system-operations/checkpoints', { token });
    assert.equal(records.response.status, 200);
    assert.ok(records.payload.checkpoints.some(item => item.checkpointId === checkpoint.payload.checkpointId && item.status === 'complete'));

    const restoreCheckpoint = await request(base, '/system-operations/checkpoints', { method: 'POST', token, body: { reason: 'Offline restore acceptance fixture' } });
    assert.equal(restoreCheckpoint.response.status, 201);
    const restoredRoot = path.join(root, 'restored-live');
    const restore = spawnSync(process.execPath, ['server/scripts/restore-checkpoint.cjs', restoreCheckpoint.payload.archivePath,
      '--confirm-offline', '--user-id', String(admin.lastID), '--reason', 'Ticket 28 isolated restore acceptance'], {
      cwd: path.resolve('.'), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, COST_REPORT_DB_PATH: path.join(restoredRoot, 'business.sqlite'),
        COST_REPORT_COLLAB_DB_PATH: path.join(restoredRoot, 'collaboration.sqlite'),
        COST_REPORT_TEMPLATE_DIR: path.join(restoredRoot, 'templates'), COST_REPORT_ARTIFACT_DIR: path.join(restoredRoot, 'artifacts') }
    });
    assert.equal(restore.status, 0, `${restore.stdout}\n${restore.stderr}`);
    assert.match(restore.stdout, /Restored checkpoint-/);
    assert.equal(await fs.readFile(path.join(restoredRoot, 'templates', 'published-template.json'), 'utf8'), '{"version":4}');
    assert.equal(await fs.readFile(path.join(restoredRoot, 'artifacts', 'evidence', 'proof.pdf'), 'utf8'), 'retained evidence');
    const recoveryCode = `const db=require('./server/src/config/database');\n(async()=>{await db.ready;await require('./server/src/services/restoreRecovery').recoverPendingRestoreAudit();await new Promise((resolve,reject)=>db.close(error=>error?reject(error):db.collaborationDb.close(error=>error?reject(error):resolve())));})().catch(error=>{console.error(error);process.exitCode=1});`;
    const recovery = spawnSync(process.execPath, ['-e', recoveryCode], { cwd: path.resolve('.'), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, COST_REPORT_DB_PATH: path.join(restoredRoot, 'business.sqlite'),
        COST_REPORT_COLLAB_DB_PATH: path.join(restoredRoot, 'collaboration.sqlite'),
        COST_REPORT_TEMPLATE_DIR: path.join(restoredRoot, 'templates'), COST_REPORT_ARTIFACT_DIR: path.join(restoredRoot, 'artifacts') } });
    assert.equal(recovery.status, 0, `${recovery.stdout}\n${recovery.stderr}`);
    const restoredDb = new sqlite3.Database(path.join(restoredRoot, 'business.sqlite'));
    const restoreAudit = await new Promise((resolve, reject) => restoredDb.get(`SELECT re.status, re.reason,
        e.action, e.outcome FROM restore_events re JOIN business_audit_events e
        ON e.object_type='checkpoint' AND e.object_id=? WHERE re.backup_id=?`,
    [restoreCheckpoint.payload.checkpointId, restoreCheckpoint.payload.id], (error, row) => error ? reject(error) : resolve(row)));
    assert.equal(restoreAudit.status, 'recovered');
    assert.equal(restoreAudit.action, 'checkpoint.restore.recovered');
    assert.equal(restoreAudit.outcome, 'success');
    const restoredIntegrity = await new Promise((resolve, reject) => restoredDb.get('PRAGMA integrity_check',
      (error, row) => error ? reject(error) : resolve(row.integrity_check)));
    assert.equal(restoredIntegrity, 'ok');
    const revisionLinks = await new Promise((resolve, reject) => restoredDb.all(`SELECT r.revision_number AS revisionNumber,
        r.revision_status AS status, r.is_current_effective AS isCurrentEffective,
        COUNT(DISTINCT a.id) AS artifactCount, COUNT(DISTINCT e.id) AS attachmentCount,
        cr.collaboration_room_key AS roomKey
      FROM business_revisions r LEFT JOIN official_artifacts a ON a.revision_id=r.id
      LEFT JOIN attachments e ON e.revision_id=r.id LEFT JOIN collaboration_rooms cr ON cr.id=r.collaboration_room_id
      WHERE r.task_id=? AND r.revision_number IN (2,3) GROUP BY r.id ORDER BY r.revision_number`,
    [task.lastID], (error, rows) => error ? reject(error) : resolve(rows)));
    assert.deepEqual(revisionLinks, [
      { revisionNumber: 2, status: 'finalized', isCurrentEffective: 0, artifactCount: 1, attachmentCount: 1, roomKey: null },
      { revisionNumber: 3, status: 'finalized', isCurrentEffective: 1, artifactCount: 1, attachmentCount: 1, roomKey: 'finalized-history-room' }
    ]);
    const restoredCollab = new sqlite3.Database(path.join(restoredRoot, 'collaboration.sqlite'));
    const restoredSnapshot = await new Promise((resolve, reject) => restoredCollab.get(`SELECT s.snapshot_json
      FROM collaboration_snapshots s JOIN collaboration_rooms r ON r.id=s.room_id
      WHERE r.room_key='finalized-history-room' AND s.version=1`, (error, row) => error ? reject(error) : resolve(row)));
    assert.equal(JSON.parse(restoredSnapshot.snapshot_json).data.revisionNumber, 3);
    for (const file of ['historic-revision.pdf', 'current-revision.pdf', 'historic-evidence.pdf', 'current-evidence.pdf']) {
      assert.ok(await fs.stat(path.join(restoredRoot, 'artifacts', file === 'historic-revision.pdf' || file === 'current-revision.pdf'
        ? 'official' : 'evidence', file)));
    }
    await new Promise((resolve, reject) => restoredCollab.close(error => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => restoredDb.close(error => error ? reject(error) : resolve()));
    process.stdout.write('Ticket 28 checkpoint and collaboration-retention acceptance passed.\n');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
    await new Promise(resolve => db.collaborationDb.close(resolve));
    try { require('node:fs').rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
