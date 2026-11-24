const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');

const root = fs.mkdtemp(path.join(os.tmpdir(), 'report-exports-'));

async function run() {
  const testRoot = await root;
  process.env.COST_REPORT_DB_PATH = path.join(testRoot, 'data', 'exports.db');
  process.env.COST_REPORT_COLLAB_DB_PATH = path.join(testRoot, 'data', 'collaboration.db');
  process.env.COST_REPORT_TEMPLATE_DIR = path.join(testRoot, 'templates');
  process.env.COST_REPORT_ARTIFACT_DIR = path.join(testRoot, 'artifacts');
  const app = require('../src/app');
  const db = require('../src/config/database');
  const server = http.createServer(app);
  await db.ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (route, { token, method = 'GET', body } = {}) => {
    const response = await fetch(`${baseUrl}${route}`, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return response;
  };
  const insert = (sql, values = []) => db._helpers.run(db, sql, values);
  const get = (sql, values = []) => db._helpers.get(db, sql, values);
  try {
    const password = await bcrypt.hash('exports-password', 4);
    const admin = await insert('INSERT INTO users (username,password,name) VALUES (?,?,?)', ['export-admin', password, '导出管理员']);
    const orgA = await insert("INSERT INTO organizations (code,name,organization_type) VALUES ('EXPORT-A','甲公司','subsidiary')");
    const orgB = await insert("INSERT INTO organizations (code,name,organization_type) VALUES ('EXPORT-B','乙公司','subsidiary')");
    const userA = await insert('INSERT INTO users (username,password,name,organization_id) VALUES (?,?,?,?)', ['export-a', password, '甲公司填报员', orgA.lastID]);
    const userB = await insert('INSERT INTO users (username,password,name,organization_id) VALUES (?,?,?,?)', ['export-b', password, '乙公司填报员', orgB.lastID]);
    await insert("INSERT INTO user_roles (user_id,role_code) VALUES (?,'system_admin')", [admin.lastID]);
    await insert("INSERT INTO user_roles (user_id,role_code) VALUES (?,'subsidiary_filler')", [userA.lastID]);
    await insert("INSERT INTO user_roles (user_id,role_code) VALUES (?,'subsidiary_filler')", [userB.lastID]);
    const template = await insert('INSERT INTO templates (name,created_by) VALUES (?,?)', ['Export test template', admin.lastID]);
    const templateVersion = await insert("INSERT INTO template_versions (template_id,version,status,created_by) VALUES (?,1,'published',?)", [template.lastID, admin.lastID]);
    const reportType = await insert("INSERT INTO report_types (code,display_name,cadence,workflow_profile,created_by) VALUES ('EXPORT_MONTHLY','月度经营报表','monthly','monthly',?)", [admin.lastID]);
    const pack = await insert("INSERT INTO period_packages (report_type_id,period_code,template_version_id,status,created_by) VALUES (?,'2026-08',?,'active',?)", [reportType.lastID, templateVersion.lastID, admin.lastID]);
    const field = await insert("INSERT INTO field_definitions (code,display_name,data_type,unit,precision,status,created_by) VALUES ('EXPORT_REVENUE','营业收入','decimal','万元',2,'approved',?)", [admin.lastID]);
    const artifactRoot = process.env.COST_REPORT_ARTIFACT_DIR;
    const evidenceRoot = path.join(artifactRoot, 'evidence');
    await fs.mkdir(evidenceRoot, { recursive: true });
    const taskIds = [];
    for (const [organization, user, code] of [[orgA, userA, 'EXPORT-A'], [orgB, userB, 'EXPORT-B']]) {
      const task = await insert(`INSERT INTO report_tasks (package_id,report_type_id,organization_id,period_code,task_status,deadline_at,
        configuration_snapshot_json,template_version_id) VALUES (?,?,?,'2026-08','draft','2026-09-02T15:59:59Z','{}',?)`,
      [pack.lastID, reportType.lastID, organization.lastID, templateVersion.lastID]);
      taskIds.push(task.lastID);
      const revision = await insert(`INSERT INTO business_revisions (task_id,revision_number,revision_status,submitted_by,submitted_at)
        VALUES (?,1,'draft',?,CURRENT_TIMESTAMP)`, [task.lastID, user.lastID]);
      await insert('UPDATE report_tasks SET current_revision_id=? WHERE id=?', [revision.lastID, task.lastID]);
      await insert(`INSERT INTO business_values (revision_id,task_id,record_key,field_definition_id,value_type,decimal_value,entered_by,
        unit_snapshot,precision_snapshot,source_sheet,source_named_area,source_row,source_column)
        VALUES (?,?,?,?,'decimal',?,?, '万元',2,'经济指标','INPUT_REVENUE',4,2)`,
      [revision.lastID, task.lastID, 'TOTAL', field.lastID, code === 'EXPORT-A' ? '105.20' : '207.35', user.lastID]);
      for (const [type, extension, content] of [['finalized_xlsx', '.xlsx', Buffer.from('PK\u0003\u0004export-xlsx')],
        ['finalized_pdf', '.pdf', Buffer.from('%PDF-1.7\nexport')]]) {
        const file = path.join(artifactRoot, `${code}-${type}${extension}`);
        await fs.mkdir(artifactRoot, { recursive: true }); await fs.writeFile(file, content);
        await insert('INSERT INTO official_artifacts (revision_id,artifact_type,storage_key,sha256,byte_size) VALUES (?,?,?,?,?)',
          [revision.lastID, type, file, crypto.createHash('sha256').update(content).digest('hex'), content.byteLength]);
      }
      const attachmentPath = path.join(evidenceRoot, `${code}-evidence.pdf`);
      const attachment = Buffer.from('%PDF-1.7\nattachment'); await fs.writeFile(attachmentPath, attachment);
      await insert(`INSERT INTO attachments (task_id,revision_id,original_name,storage_key,media_type,byte_size,sha256,uploaded_by,
        extension,scan_status) VALUES (?,?,?,?,'application/pdf',?,?,?,'.pdf','clean')`,
      [task.lastID, revision.lastID, '经营依据.pdf', attachmentPath, attachment.byteLength,
        crypto.createHash('sha256').update(attachment).digest('hex'), user.lastID]);
      await insert("UPDATE business_revisions SET revision_status='submitted' WHERE id=?", [revision.lastID]);
      await insert("UPDATE report_tasks SET task_status='submitted' WHERE id=?", [task.lastID]);
      await insert("UPDATE business_revisions SET revision_status='finalized', is_current_effective=1, finalized_at=CURRENT_TIMESTAMP WHERE id=?", [revision.lastID]);
      await insert("UPDATE report_tasks SET task_status='finalized' WHERE id=?", [task.lastID]);
    }

    const withdrawnRevision = await insert(`INSERT INTO business_revisions (task_id,revision_number,revision_status,submitted_by,submitted_at)
      VALUES (?,2,'withdrawn',?,CURRENT_TIMESTAMP)`, [taskIds[0], userA.lastID]);
    await insert(`INSERT INTO business_values (revision_id,task_id,record_key,field_definition_id,value_type,decimal_value,entered_by,
      unit_snapshot,precision_snapshot,source_sheet,source_named_area,source_row,source_column)
      VALUES (?,?,?,?,'decimal','99.99',?,'万元',2,'经济指标','INPUT_REVENUE',4,2)` ,
    [withdrawnRevision.lastID, taskIds[0], 'TOTAL', field.lastID, userA.lastID]);

    const login = async username => {
      const response = await request('/auth/login', { method: 'POST', body: { username, password: 'exports-password' } });
      assert.equal(response.status, 200);
      return (await response.json()).token;
    };
    const adminToken = await login('export-admin');
    const userAToken = await login('export-a');
    const userBToken = await login('export-b');
    const periods = await request('/exports/periods', { token: userAToken });
    assert.deepEqual((await periods.json()).periods.map(item => item.periodCode), ['2026-08']);
    const ownOrganizations = await request(`/exports/packages/${pack.lastID}/organizations`, { token: userAToken });
    assert.deepEqual((await ownOrganizations.json()).organizations.map(item => item.code), ['EXPORT-A']);
    const allOrganizations = await request(`/exports/packages/${pack.lastID}/organizations`, { token: adminToken });
    assert.deepEqual((await allOrganizations.json()).organizations.map(item => item.code), ['EXPORT-A', 'EXPORT-B']);

    const ownXlsx = await request('/exports/raw-data.xlsx?periodCode=2026-08', { token: userAToken });
    assert.equal(ownXlsx.status, 200);
    const ownWorkbook = new ExcelJS.Workbook();
    await ownWorkbook.xlsx.load(Buffer.from(await ownXlsx.arrayBuffer()));
    const ownSheet = ownWorkbook.getWorksheet('原始数据');
    assert.equal(ownSheet.rowCount, 3);
    assert.equal(ownSheet.getRow(2).getCell(3).value, 'EXPORT-A');
    assert.equal(ownSheet.getRow(2).getCell(9).value, 'EXPORT_REVENUE');
    assert.equal(ownSheet.getRow(2).getCell(12).value, '105.20');
    assert.equal(ownSheet.getRow(2).getCell(13).value, '万元');
    assert.equal(ownSheet.getRow(2).getCell(17).value, 'INPUT_REVENUE');

    const denied = await request(`/exports/raw-data.xlsx?periodCode=2026-08&organizationId=${orgB.lastID}`, { token: userAToken });
    assert.equal(denied.status, 403);
    const allData = await request('/exports/raw-data.xlsx?periodCode=2026-08', { token: adminToken });
    const allWorkbook = new ExcelJS.Workbook(); await allWorkbook.xlsx.load(Buffer.from(await allData.arrayBuffer()));
    assert.equal(allWorkbook.getWorksheet('原始数据').rowCount, 4);
    const companyFiltered = await request(`/exports/raw-data.xlsx?periodCode=2026-08&organizationId=${orgB.lastID}`, { token: adminToken });
    const companyWorkbook = new ExcelJS.Workbook(); await companyWorkbook.xlsx.load(Buffer.from(await companyFiltered.arrayBuffer()));
    assert.equal(companyWorkbook.getWorksheet('原始数据').rowCount, 2);
    assert.equal(companyWorkbook.getWorksheet('原始数据').getRow(2).getCell(3).value, 'EXPORT-B');

    const currentDraft = await insert(`INSERT INTO business_revisions (task_id,revision_number,revision_status,submitted_by)
      VALUES (?,3,'draft',?)`, [taskIds[0], userA.lastID]);
    await insert('UPDATE report_tasks SET current_revision_id=?,task_status=\'draft\' WHERE id=?', [currentDraft.lastID, taskIds[0]]);

    const created = await request('/exports/jobs', { method: 'POST', token: adminToken, body: { packageId: pack.lastID } });
    assert.equal(created.status, 202);
    const jobId = (await created.json()).job.id;
    const savedJob = await get('SELECT snapshot_manifest_json FROM export_jobs WHERE id=?', [jobId]);
    const savedSnapshot = JSON.parse(savedJob.snapshot_manifest_json);
    const savedTask = savedSnapshot.tasks.find(task => Number(task.taskId) === Number(taskIds[0]));
    assert.equal(Number(savedTask.currentRevisionId), Number(currentDraft.lastID));
    assert.deepEqual(savedTask.revisions.map(revision => Number(revision.revisionId)), [
      Number((await get("SELECT id FROM business_revisions WHERE task_id=? AND revision_number=1", [taskIds[0]])).id),
      Number(withdrawnRevision.lastID)
    ]);
    const laterRevision = await insert(`INSERT INTO business_revisions (task_id,revision_number,revision_status,submitted_by,submitted_at)
      VALUES (?,4,'submitted',?,CURRENT_TIMESTAMP)`, [taskIds[0], userA.lastID]);
    await insert(`INSERT INTO business_values (revision_id,task_id,record_key,field_definition_id,value_type,decimal_value,entered_by,
      unit_snapshot,precision_snapshot,source_sheet,source_named_area,source_row,source_column)
      VALUES (?,?,?,?,'decimal','555.55',?,'万元',2,'经济指标','INPUT_REVENUE',4,2)`,
    [laterRevision.lastID, taskIds[0], 'TOTAL', field.lastID, userA.lastID]);
    await insert("UPDATE report_tasks SET current_revision_id=?,task_status='submitted' WHERE id=?", [laterRevision.lastID, taskIds[0]]);
    let job;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await request('/exports/jobs', { token: adminToken });
      job = (await response.json()).jobs.find(job => job.id === jobId);
      if (job.status === 'complete' || job.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(job.status, 'complete', job.error || 'bulk export did not complete');
    const completedEvent = await get(`SELECT after_summary_json AS summary FROM business_audit_events
      WHERE action='bulk_export.completed' AND object_id=? ORDER BY id DESC LIMIT 1`, [String(jobId)]);
    assert.equal(JSON.parse(completedEvent.summary).rowCount, 3, 'the ZIP uses only revisions captured when its job was created');
    assert.equal(job.progress, 100);
    assert.ok(Date.parse(job.expiresAt) > Date.now());
    assert.ok(Math.abs(Date.parse(job.expiresAt) - Date.now() - 7 * 24 * 60 * 60 * 1000) < 10_000,
      'completed package download expires seven days after generation');
    const deniedJob = await request(`/exports/jobs/${jobId}/download`, { token: userBToken });
    assert.equal(deniedJob.status, 403);
    const zipResponse = await request(`/exports/jobs/${jobId}/download`, { token: adminToken });
    assert.equal(zipResponse.status, 200);
    const zip = Buffer.from(await zipResponse.arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    for (const name of ['2026-08/结构化原始数据-2026-08.xlsx', '2026-08/EXPORT-A/正式报表/EXPORT-A-2026-08-月度经营报表-修订-001-artifact-',
      '2026-08/EXPORT-B/附件/修订-001/附件-', '经营依据.pdf']) assert.ok(zip.includes(Buffer.from(name)), `ZIP is missing ${name}`);

    await insert("UPDATE export_jobs SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", [jobId]);
    const expiredDownload = await request(`/exports/jobs/${jobId}/download`, { token: adminToken });
    assert.equal(expiredDownload.status, 410);
    assert.equal((await request('/exports/jobs', { token: adminToken })).status, 200);
    assert.equal((await (await request('/exports/jobs', { token: adminToken })).json()).jobs.find(job => job.id === jobId).status, 'expired');

    const failedJob = await insert(`INSERT INTO export_jobs (package_id,requested_by,status,error_text,snapshot_manifest_json)
      VALUES (?,?,'failed','transient failure',?)`, [pack.lastID, admin.lastID, JSON.stringify(savedSnapshot)]);
    const retry = await request(`/exports/jobs/${failedJob.lastID}/retry`, { method: 'POST', token: adminToken });
    assert.equal(retry.status, 202);
    const retriedJobId = (await retry.json()).job.id;
    const retriedSnapshot = await get('SELECT snapshot_manifest_json FROM export_jobs WHERE id=?', [retriedJobId]);
    assert.deepEqual(JSON.parse(retriedSnapshot.snapshot_manifest_json), savedSnapshot,
      'retry reuses the failed job business-version snapshot');
    let retriedJob;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      retriedJob = (await (await request('/exports/jobs', { token: adminToken })).json()).jobs.find(job => job.id === retriedJobId);
      if (retriedJob.status === 'complete' || retriedJob.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(retriedJob.status, 'complete', retriedJob.error || 'retried export did not complete');
    const eventCount = await get("SELECT COUNT(*) AS count FROM business_audit_events WHERE action IN ('original_data.exported','bulk_export.requested','bulk_export.completed','bulk_export.downloaded','bulk_export.retried')");
    assert.ok(eventCount.count >= 5);
    console.log('Original data export API integration passed: scope, XLSX provenance, ZIP contents, job retry, expiry, and audit.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(() => db.collaborationDb.close(resolve)));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await fs.rm(testRoot, { recursive: true, force: true }); break; }
      catch (error) { if (error.code !== 'EBUSY' || attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
