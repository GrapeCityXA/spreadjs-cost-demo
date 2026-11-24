const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'cost-report-submission-'));
process.env.COST_REPORT_DB_PATH = path.join(root, 'data', 'business.db');
process.env.COST_REPORT_COLLAB_DB_PATH = path.join(root, 'data', 'collaboration.db');
process.env.COST_REPORT_TEMPLATE_DIR = path.join(root, 'templates');
process.env.COST_REPORT_ARTIFACT_DIR = path.join(root, 'artifacts');
process.env.NODE_ENV = 'test';

const db = require('../src/config/database');
const { submitBusinessRevision } = require('../src/services/businessSubmission');
const bindingMode = process.env.COST_REPORT_TEST_BINDING === '1';
const { ensureDefaultRules } = require('../src/controllers/ruleCatalogController');

const run = (connection, sql, params = []) => db._helpers.run(connection, sql, params);
const get = (connection, sql, params = []) => db._helpers.get(connection, sql, params);

test('submission rolls back business rows, artifacts, and room state; retry returns one atomic revision', async () => {
  try {
    await db.ready;
    const user = await run(db, `INSERT INTO users (username, password, name, permissions) VALUES ('submitter', 'x', '提交人', '[]')`);
    await run(db, `INSERT INTO user_roles (user_id, role_code) VALUES (?, 'subsidiary_submitter')`, [user.lastID]);
    const organization = await run(db, `INSERT INTO organizations (code, name) VALUES ('SUBMISSION_ORG', '提交验收组织')`);
    await ensureDefaultRules({ id: user.lastID, organizationId: organization.lastID });
    const negativeRevenueRule = await get(db, `SELECT rv.id FROM rule_versions rv JOIN rule_definitions rd ON rd.id = rv.rule_id
      WHERE rd.code = 'DEFAULT_NEGATIVE_REVENUE' AND rv.status = 'published'`);
    const field = await run(db, `INSERT INTO field_definitions
      (code, display_name, data_type, semantic_type, unit, precision, editable, status, created_by)
      VALUES ('SUBMISSION_REVENUE', '营业收入', 'decimal', 'decimal', '万元', 2, 1, 'approved', ?)` , [user.lastID]);
    const numericField = await run(db, `INSERT INTO field_definitions
      (code, display_name, data_type, semantic_type, unit, precision, editable, status, created_by)
      VALUES ('SUBMISSION_REQUIRED_NUMBER', '必填数值', 'decimal', 'decimal', '个', 2, 1, 'approved', ?)` , [user.lastID]);
    const template = await run(db, `INSERT INTO templates (name, created_by) VALUES ('提交验收模板', ?)`, [user.lastID]);
    const mapping = { id: 'amount', kind: 'input', namedArea: 'SUMMARY_BODY_INPUT_AMOUNT', row: 0, col: 0,
      rowCount: 1, colCount: 1, fieldDefinitionId: field.lastID, fieldCode: 'SUBMISSION_REVENUE',
      primary: true, permission: 'primary_input', required: false };
    const numericMapping = { id: 'required-number', kind: 'input', namedArea: 'SUMMARY_BODY_INPUT_REQUIRED_NUMBER', row: 0, col: 1,
      rowCount: 1, colCount: 1, fieldDefinitionId: numericField.lastID, fieldCode: 'SUBMISSION_REQUIRED_NUMBER', dataType: 'decimal',
      primary: true, permission: 'primary_input', required: false };
    if (bindingMode) for (const entry of [mapping, numericMapping]) Object.assign(entry, { bindingPath: entry.fieldCode, bindingVersion: 2 });
    const workbook = { schemaVersion: 1, sheets: [{ code: 'SUMMARY', name: '汇总', rowCount: 2, columnCount: 2,
      mappings: [mapping, numericMapping], cells: [] }] };
    const manifest = { name: '提交验收模板', submission: { version: 1, sheets: [{ code: 'SUMMARY', name: '汇总', order: 0,
      mappings: [mapping, numericMapping].map(item => ({ ...item, sheet: 'SUMMARY', sheetIndex: 0,
        sourceLocation: { row: item.row, column: item.col, rowCount: 1, columnCount: 1 } })) }] } };
    const templateVersion = await run(db, `INSERT INTO template_versions (template_id, version, status, created_by, manifest_json, workbook_json)
      VALUES (?, 1, 'published', ?, ?, ?)`, [template.lastID, user.lastID, JSON.stringify(manifest), JSON.stringify(workbook)]);
    const reportType = await run(db, `INSERT INTO report_types (code, display_name, cadence, workflow_profile, created_by)
      VALUES ('SUBMISSION_MONTHLY', '提交验收月报', 'monthly', 'monthly', ?)`, [user.lastID]);
    const periodPackage = await run(db, `INSERT INTO period_packages
      (report_type_id, period_code, version, template_version_id, configuration_json, status, created_by)
      VALUES (?, '2026-09', 1, ?, '{}', 'active', ?)`, [reportType.lastID, templateVersion.lastID, user.lastID]);
    const task = await run(db, `INSERT INTO report_tasks
      (package_id, report_type_id, organization_id, period_code, task_status, deadline_at, configuration_snapshot_json, template_version_id)
      VALUES (?, ?, ?, '2026-09', 'draft', '2026-10-01T23:59:59+08:00', ?, ?)`,
    [periodPackage.lastID, reportType.lastID, organization.lastID, JSON.stringify({ configuration: { ruleVersionIds: [negativeRevenueRule.id] },
      ruleVersions: [negativeRevenueRule.id] }), templateVersion.lastID]);
    await run(db, `INSERT INTO package_assignments (package_id, organization_id, responsibility, user_id, assigned_by)
      VALUES (?, ?, 'submitter', ?, ?)`, [periodPackage.lastID, organization.lastID, user.lastID, user.lastID]);
    const roomKey = `submission-task-${task.lastID}-revision-1`;
    const room = await run(db, `INSERT INTO collaboration_rooms
      (task_id, revision_number, collaboration_room_key, collaboration_db, latest_version, room_status, snapshot_reference)
      VALUES (?, 1, ?, ?, 1, 'open', ?)`, [task.lastID, roomKey, process.env.COST_REPORT_COLLAB_DB_PATH, `${roomKey}@1`]);
    await run(db.collaborationDb, `INSERT INTO collaboration_rooms (room_key, task_id, revision_number, room_status, current_version)
      VALUES (?, ?, 1, 'open', 1)`, [roomKey, task.lastID]);
    await run(db.collaborationDb, `INSERT INTO documents (id, type, version, snapshot_version) VALUES (?, 'spreadjs', 1, 1)`, [roomKey]);

    const snapshot = { v: 1, id: roomKey, data: { version: '19.1.4', name: '',
      sheets: { sheet1: { name: '汇总', order: 0, data: { dataTable: { 0: { 0: { value: '-123.45' }, 1: { value: 'not-a-number' } } } } } } } };
    if (bindingMode) {
      snapshot.data.dataManager = {tables:{form:{name:'reportData',dataSourceOption:{data:[{SUBMISSION_REVENUE:'-123.45',SUBMISSION_REQUIRED_NUMBER:'not-a-number'}]}}}};
      snapshot.data.sheets.sheet1.bindingManager = {type:'cellBinding',tableId:'form',activeRecordIndex:0};
      snapshot.data.sheets.sheet1.data.dataTable[0][0] = {bindingPath:'SUBMISSION_REVENUE',value:999};
      snapshot.data.sheets.sheet1.data.dataTable[0][1] = {bindingPath:'SUBMISSION_REQUIRED_NUMBER',value:999};
    }
    const actor = { id: user.lastID, organizationId: organization.lastID,
      roles: [{ code: 'subsidiary_submitter', organizationId: organization.lastID }] };
    const serviceOptions = { taskId: task.lastID, actor, expectedVersion: 1, pendingChanges: 0,
      warningExplanations: [{ ruleCode: 'DEFAULT_NEGATIVE_REVENUE', explanation: '经核对，本月营业收入为负数，属于业务冲销。' }],
      connectionProbe: () => true, runtimeProvider: async () => ({ documentServices: { fetch: async () => {
        assert.equal((await get(db, 'SELECT room_status FROM collaboration_rooms WHERE id = ?', [room.lastID])).room_status, 'frozen');
        assert.equal((await get(db.collaborationDb, 'SELECT room_status FROM collaboration_rooms WHERE room_key = ?', [roomKey])).room_status, 'frozen');
        return snapshot;
      } } }) };

    await assert.rejects(submitBusinessRevision({ ...serviceOptions, expectedVersion: 0, idempotencyKey: 'submission-stale-01' }), /已有新变更/);
    await assert.rejects(submitBusinessRevision({ ...serviceOptions, pendingChanges: 1, idempotencyKey: 'submission-pending-01' }), /等待全部协作变更/);
    await assert.rejects(submitBusinessRevision({ ...serviceOptions, connectionProbe: () => false, idempotencyKey: 'submission-offline-01' }), /保持当前任务协作连接/);
    await assert.rejects(submitBusinessRevision({ ...serviceOptions, idempotencyKey: 'submission-blocking-with-explanation-01' }), /必须是十进制数/);
    if (bindingMode) snapshot.data.dataManager.tables.form.dataSourceOption.data[0].SUBMISSION_REQUIRED_NUMBER = '12.5';
    else snapshot.data.sheets.sheet1.data.dataTable[0][1].value = '12.5';
    await assert.rejects(submitBusinessRevision({ ...serviceOptions, warningExplanations: [], idempotencyKey: 'submission-no-explanation-01', hooks: { afterValues() { throw new Error('frontend-gate-accepted'); } } }), /frontend-gate-accepted/);

    for (const [idempotencyKey, hook] of [
      ['submission-db-fail-01', { afterValues: async () => { throw new Error('injected database failure'); } }],
      ['submission-file-fail-01', { afterArtifacts: async () => { throw new Error('injected artifact failure'); } }],
      ['submission-room-fail-01', { afterRoomClose: async () => { throw new Error('injected room-state failure'); } }]
    ]) {
      await assert.rejects(submitBusinessRevision({ ...serviceOptions, validationReport: { schemaVersion: 1, collaborationVersion: 1, checkedCount: 1, skippedCount: 0, issues: [] }, idempotencyKey, hooks: hook }), /injected/);
      assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM revision_validation_snapshots')).count, 0);
      assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM business_revisions WHERE task_id = ?', [task.lastID])).count, 0);
      assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM business_values WHERE task_id = ?', [task.lastID])).count, 0);
      assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM official_artifacts')).count, 0);
      assert.equal((await get(db, 'SELECT room_status FROM collaboration_rooms WHERE id = ?', [room.lastID])).room_status, 'open');
      assert.equal((await get(db.collaborationDb, 'SELECT room_status FROM collaboration_rooms WHERE room_key = ?', [roomKey])).room_status, 'open');
      assert.equal((await get(db, 'SELECT task_status FROM report_tasks WHERE id = ?', [task.lastID])).task_status, 'draft');
      assert.deepEqual(await fs.readdir(process.env.COST_REPORT_ARTIFACT_DIR).catch(() => []), []);
    }

    const [submitted, replay] = await Promise.all([
      submitBusinessRevision({ ...serviceOptions, validationReport: { schemaVersion: 1, collaborationVersion: 1, checkedCount: 2, skippedCount: 1, issues: [{ severity: 'warning', message: '前端提示', sheetName: '汇总', row: 0, col: 0 }] }, idempotencyKey: 'submission-success-01' }),
      submitBusinessRevision({ ...serviceOptions, validationReport: { schemaVersion: 1, collaborationVersion: 1, checkedCount: 2, skippedCount: 1, issues: [{ severity: 'warning', message: '前端提示', sheetName: '汇总', row: 0, col: 0 }] }, idempotencyKey: 'submission-success-01' })
    ]);
    assert.deepEqual(replay, submitted);
    const check = await get(db, 'SELECT report_json,actor_user_id FROM revision_validation_snapshots WHERE revision_id=?', [submitted.revisionId]);
    assert.equal(JSON.parse(check.report_json).status, 'warnings');
    assert.equal(check.actor_user_id, actor.id);
    await assert.rejects(submitBusinessRevision({ ...serviceOptions, expectedVersion: 2, idempotencyKey: 'submission-success-01' }), /幂等键已用于不同/);
    const secondUser = await run(db, `INSERT INTO users (username, password, name, permissions) VALUES ('submitter-2', 'x', '另一提交人', '[]')`);
    await run(db, `INSERT INTO user_roles (user_id, role_code, organization_id) VALUES (?, 'subsidiary_submitter', ?)`, [secondUser.lastID, organization.lastID]);
    await run(db, `INSERT INTO package_assignments (package_id, organization_id, responsibility, user_id, assigned_by)
      VALUES (?, ?, 'submitter', ?, ?)`, [periodPackage.lastID, organization.lastID, secondUser.lastID, user.lastID]);
    await assert.rejects(submitBusinessRevision({ ...serviceOptions, actor: { ...actor, id: secondUser.lastID },
      idempotencyKey: 'submission-second-submitter' }), /不处于可提交状态/);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM business_revisions WHERE task_id = ?', [task.lastID])).count, 1);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM business_values WHERE revision_id = ?', [submitted.revisionId])).count, 2);
    const storedValue = await get(db, `SELECT decimal_value, unit_snapshot, precision_snapshot, source_named_area, source_collaboration_version
      FROM business_values WHERE revision_id = ? AND field_definition_id = ?`, [submitted.revisionId, field.lastID]);
    assert.deepEqual(storedValue, { decimal_value: '-123.45', unit_snapshot: '万元', precision_snapshot: 2,
      source_named_area: 'SUMMARY_BODY_INPUT_AMOUNT', source_collaboration_version: 1 });
    const anomaly = await get(db, `SELECT severity, message, explanation, rule_code, field_code, triggering_value_json,
      comparison_value_json, threshold_json, color_classification FROM anomaly_snapshots WHERE revision_id = ?`, [submitted.revisionId]);
    assert.equal(anomaly.severity, 'warning');
    assert.equal(anomaly.explanation, '经核对，本月营业收入为负数，属于业务冲销。');
    assert.equal(anomaly.rule_code, 'DEFAULT_NEGATIVE_REVENUE');
    assert.equal(Number((await get(db, 'SELECT rule_version_id FROM anomaly_snapshots WHERE revision_id = ?', [submitted.revisionId])).rule_version_id), Number(negativeRevenueRule.id));
    assert.equal(anomaly.field_code, 'SUBMISSION_REVENUE');
    assert.equal(anomaly.triggering_value_json, '-123.45');
    assert.equal(anomaly.color_classification, 'warning');
    assert.equal((await get(db, 'SELECT room_status FROM collaboration_rooms WHERE id = ?', [room.lastID])).room_status, 'closed');
    assert.equal((await get(db.collaborationDb, 'SELECT room_status FROM collaboration_rooms WHERE room_key = ?', [roomKey])).room_status, 'closed');
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM official_artifacts WHERE revision_id = ?', [submitted.revisionId])).count, 2);
    assert.equal((await get(db, "SELECT COUNT(*) AS count FROM business_audit_events WHERE action = 'business_revision.submit' AND object_id = ?", [String(submitted.revisionId)])).count, 1);

    const correctionRoomKey = `${roomKey}-revision-2`;
    const correctionRoom = await run(db, `INSERT INTO collaboration_rooms
      (task_id, revision_number, collaboration_room_key, collaboration_db, latest_version, room_status, snapshot_reference)
      VALUES (?, 2, ?, ?, 1, 'open', ?)`, [task.lastID, correctionRoomKey, process.env.COST_REPORT_COLLAB_DB_PATH, `${correctionRoomKey}@1`]);
    await run(db.collaborationDb, `INSERT INTO collaboration_rooms (room_key, task_id, revision_number, room_status, current_version)
      VALUES (?, ?, 2, 'open', 1)`, [correctionRoomKey, task.lastID]);
    await run(db.collaborationDb, `INSERT INTO documents (id, type, version, snapshot_version) VALUES (?, 'spreadjs', 1, 1)`, [correctionRoomKey]);
    await run(db.collaborationDb, `INSERT INTO collaboration_snapshots (room_id, version, snapshot_json)
      VALUES (?, 1, ?)`, [correctionRoom.lastID, JSON.stringify({ ...snapshot, id: correctionRoomKey })]);
    const draftRevision = await run(db, `INSERT INTO business_revisions
      (task_id, revision_number, revision_status, source_revision_id, collaboration_room_id)
      VALUES (?, 2, 'draft', ?, ?)`, [task.lastID, submitted.revisionId, correctionRoom.lastID]);
    await run(db, `UPDATE report_tasks SET current_revision_id = ?, task_status = 'draft' WHERE id = ?`, [draftRevision.lastID, task.lastID]);
    const correctionOptions = { ...serviceOptions, idempotencyKey: 'submission-resubmit-02',
      runtimeProvider: async () => ({ documentServices: { fetch: async () => ({ ...snapshot, id: correctionRoomKey }) } }) };
    const [resubmitted, repeatedResubmission] = await Promise.all([
      submitBusinessRevision(correctionOptions), submitBusinessRevision(correctionOptions)
    ]);
    assert.deepEqual(repeatedResubmission, resubmitted);
    assert.equal(resubmitted.revisionNumber, 2);
    assert.equal(await get(db, 'SELECT revision_id FROM revision_validation_snapshots WHERE revision_id=?', [resubmitted.revisionId]), undefined, 'older client resubmission does not inherit a previous check');
    assert.equal((await get(db, 'SELECT revision_status FROM business_revisions WHERE id = ?', [draftRevision.lastID])).revision_status, 'submitted');
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM business_values WHERE revision_id = ?', [draftRevision.lastID])).count, 2);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM anomaly_snapshots WHERE revision_id = ?', [draftRevision.lastID])).count, 1);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM official_artifacts WHERE revision_id = ?', [draftRevision.lastID])).count, 2);
    assert.equal((await get(db, `SELECT COUNT(*) AS count FROM report_task_events
      WHERE task_id = ? AND revision_id = ? AND event_type = 'resubmitted'`, [task.lastID, draftRevision.lastID])).count, 1);
    assert.equal((await get(db, `SELECT COUNT(*) AS count FROM business_audit_events
      WHERE action = 'business_revision.resubmit' AND object_id = ?`, [String(draftRevision.lastID)])).count, 1);
  } finally {
    await new Promise(resolve => db.close(resolve));
    await new Promise(resolve => db.collaborationDb.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
