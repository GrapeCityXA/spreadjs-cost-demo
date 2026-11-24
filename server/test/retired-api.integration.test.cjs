const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-retired-api-'));
process.env.COST_REPORT_DB_PATH = path.join(root, 'business.db');
process.env.COST_REPORT_COLLAB_DB_PATH = path.join(root, 'collaboration.db');
process.env.COST_REPORT_TEMPLATE_DIR = path.join(root, 'templates');
process.env.COST_REPORT_ARTIFACT_DIR = path.join(root, 'artifacts');
process.env.COST_REPORT_BACKUP_DIR = path.join(root, 'backups');
const app = require('../src/app');
const db = require('../src/config/database');

const retired = [
  ['POST', '/auth/register'], ['POST', '/auth/init-default-users'],
  ['GET', '/templates'], ['POST', '/templates'], ['GET', '/templates/1'],
  ['PUT', '/templates/1'], ['DELETE', '/templates/1'],
  ['POST', '/templates/submit-changes'], ['POST', '/templates/sync-changes'],
  ['GET', '/templates/pending-changes/1'], ['POST', '/templates/mark-executed'],
  ['GET', '/reports'], ['POST', '/reports'], ['GET', '/reports/1'],
  ['PUT', '/reports/1'], ['DELETE', '/reports/1'], ['POST', '/reports/1/submit'],
  ['POST', '/reports/1/audit'], ['GET', '/reports/1/audit-logs'],
  ['GET', '/database/stats'], ['POST', '/database/clear-reports'], ['POST', '/database/reset'],
  ['GET', '/data/project1'], ['GET', '/data/project2'],
  ['POST', '/report-studio/dataset'], ['GET', '/fields/admin/drafts'],
  ['POST', '/managed-functions/evaluate'], ['GET', '/period-configuration/packages/1'],
  ['GET', '/collaboration/tasks/1/attachments'], ['GET', '/exports/jobs/1'],
  ['GET', '/management-dashboard/tasks/1/detail']
];

async function run() {
  let server;
  try {
    await db.ready;
    await require('../src/services/originalDataExports').initialize();
    const hash = await bcrypt.hash('cleanup-test-password', 4);
    await db._helpers.run(db, "INSERT INTO users(id,username,password,name,permissions) VALUES (1,'cleanup-admin',?,'Cleanup Admin','[]')", [hash]);
    await db._helpers.run(db, "INSERT INTO user_roles(user_id,role_code) VALUES (1,'system_admin')");
    await db._helpers.run(db, "INSERT INTO users(id,username,password,name,permissions) VALUES (2,'cleanup-viewer',?,'Cleanup Viewer','[\"view\"]')", [hash]);
    await db._helpers.run(db, "INSERT INTO templates(id,name,created_by) VALUES (1,'Legacy template retained',1)");
    await db._helpers.run(db, "INSERT INTO datasources(id,name,type,data,created_by) VALUES (1,'Legacy values','tableData',?,2)",
      [JSON.stringify({ costData: [{ project1: '生产指标', project2: '产量', currentMonth: 120.5 }] })]);
    await db._helpers.run(db, "INSERT INTO reports(id,title,period,status,template_id,datasource_id,created_by) VALUES (1,'Legacy report retained','2026-01','completed',1,1,2)");
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (route, token, method = 'GET', body) => fetch(base + route, {
      method, signal: AbortSignal.timeout(10000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const login = async username => {
      const response = await request('/api/auth/login', null, 'POST', { username, password: 'cleanup-test-password' });
      assert.equal(response.status, 200);
      return (await response.json()).token;
    };
    const admin = await login('cleanup-admin');
    const viewer = await login('cleanup-viewer');
    for (const [method, route] of retired) {
      const response = await request('/api' + route, admin, method, ['POST', 'PUT'].includes(method) ? {} : undefined);
      assert.equal(response.status, 404, `${method} ${route} must be retired`);
      await response.arrayBuffer();
    }
    assert.equal((await request('/health')).status, 200);
    for (const route of ['/api/auth/me', '/api/template-governance/templates', '/api/period-configuration/packages',
      '/api/fields/drafts', '/api/exports/jobs', '/api/workflows']) {
      const response = await request(route, admin);
      assert.equal(response.status, 200, route);
      await response.arrayBuffer();
    }
    assert.equal((await request('/api/auth/me')).status, 401);
    const query = '/api/data/query?' + new URLSearchParams({ templateId: '1', month: '2026-01',
      project1: '生产指标', project2: '产量', fields: 'currentMonth' });
    const data = await request(query, viewer);
    assert.equal(data.status, 200);
    assert.deepEqual((await data.json()).data, [{ currentMonth: 120.5 }]);
    assert.equal((await request(query)).status, 401);
    // These are deliberate backend administration/recovery APIs, not abandoned UI routes.
    for (const [method, route] of [
      ['GET', '/api/fields/admin/values?taskId=1&revisionId=1'], ['POST', '/api/fields/admin/values'],
      ['POST', '/api/collaboration/tasks/1/room/lifecycle'], ['GET', '/api/collaboration/tasks/1/history/0'],
      ['GET', '/api/system-operations/checkpoints'], ['POST', '/api/system-operations/checkpoints'],
      ['POST', '/api/system-operations/checkpoints/1/retry'], ['POST', '/api/system-operations/collaboration/compact'],
      ['POST', '/api/system-operations/collaboration/empty-rooms/cleanup']
    ]) {
      const response = await request(route, viewer, method, method === 'POST' ? {} : undefined);
      assert.equal(response.status, route.endsWith('/history/0') ? 404 : 403, `${method} ${route} must still enforce access checks`);
      await response.arrayBuffer();
    }
    assert.equal((await request('/api/system-operations/checkpoints', admin)).status, 200);
    const retained = await db._helpers.get(db, `SELECT
      (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM templates) AS templates,
      (SELECT COUNT(*) FROM reports) AS reports, (SELECT COUNT(*) FROM datasources) AS datasources`);
    assert.deepEqual(retained, { users: 2, templates: 1, reports: 1, datasources: 1 });
    console.log(`PASS: ${retired.length} retired endpoints; current APIs, QUERY, permissions and stored data preserved`);
  } finally {
    await require('../src/services/reportStudio').stop();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await new Promise(resolve => db.close(resolve));
    await new Promise(resolve => db.collaborationDb.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
