const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const http = require('node:http');
const crypto = require('node:crypto');
const quarterlyReferenceProfile = require('../../shared/quarterly-reference-profile.json');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-report-api-'));
process.env.COST_REPORT_DB_PATH = path.join(testRoot, 'data', 'acceptance.db');
process.env.COST_REPORT_COLLAB_DB_PATH = path.join(testRoot, 'data', 'collaboration.db');
process.env.COST_REPORT_TEMPLATE_DIR = path.join(testRoot, 'templates');
process.env.COST_REPORT_ARTIFACT_DIR = path.join(testRoot, 'artifacts');
process.env.COST_REPORT_BACKUP_DIR = path.join(testRoot, 'backups');

const app = require('../src/app');
const db = require('../src/config/database');
const collaboration = require('../src/services/collaborationServer');
const server = http.createServer(app);
const baseUrlReady = (async () => {
  await db.ready;
  await collaboration.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/api`;
})();

async function request(route, { token, method = 'GET', body, headers = {} } = {}) {
  const baseUrl = await baseUrlReady;
  const response = await fetch(`${baseUrl}${route}`, {
    signal: AbortSignal.timeout(10_000),
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json();
  return { response, payload };
}

async function readPackage(id, token) {
  const result = await request('/period-configuration/packages', { token });
  return { response: result.response, payload: { package: result.payload.packages.find(item => String(item.id) === String(id)) } };
}

async function uploadRequest(route, token, name, content, indicatorCode, mediaType = 'application/pdf') {
  const baseUrl = await baseUrlReady;
  const form = new FormData();
  form.append('file', new Blob([content], { type: mediaType }), name);
  form.append('indicatorCode', indicatorCode);
  const response = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { response, payload: await response.json() };
}

async function finalizeRequest(route, token) {
  const baseUrl = await baseUrlReady;
  const form = new FormData();
  form.append('xlsx', new Blob([Buffer.from('PK\u0003\u0004test-xlsx')], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }), 'monthly.xlsx');
  form.append('pdf', new Blob(['%PDF-1.7\nacceptance'], { type: 'application/pdf' }), 'monthly.pdf');
  const response = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { response, payload: await response.json() };
}

async function historicalImportPreview(token, reportTypeId, rows, filename = 'history.xlsx') {
  const form = new FormData();
  form.append('reportTypeId', String(reportTypeId));
  form.append('periodCode', '2026-09');
  form.append('rows', JSON.stringify(rows));
  form.append('file', new Blob([Buffer.from('PK\u0003\u0004acceptance-xlsx')], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }), filename);
  const response = await fetch(`${await baseUrlReady}/historical-imports/preview`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
  });
  return { response, payload: await response.json() };
}

async function quarterlyFinalizeRequest(route, token, taskIds) {
  const baseUrl = await baseUrlReady;
  const form = new FormData();
  for (const taskId of taskIds) {
    form.append('artifacts', new Blob([Buffer.from('PK\u0003\u0004quarterly-xlsx')], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }), `${taskId}.xlsx`);
    form.append('artifacts', new Blob(['%PDF-1.7\nquarterly acceptance'], { type: 'application/pdf' }), `${taskId}.pdf`);
  }
  const response = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { response, payload: await response.json() };
}

async function runAcceptance() {
 try {
  await db.ready;
  await baseUrlReady;
  assert.equal(await db.getSchemaVersion(), db.migrations.businessMigrations.at(-1).version);
  const collaborationTables = await new Promise((resolve, reject) => {
    db.collaborationDb.all("SELECT name FROM sqlite_master WHERE type='table'", (error, rows) => error ? reject(error) : resolve(rows.map(row => row.name)));
  });
  assert.ok(collaborationTables.includes('collaboration_operations'));
  assert.ok(collaborationTables.includes('documents'));
  assert.ok(collaborationTables.includes('operations'));
  assert.ok(collaborationTables.includes('snapshot_fragments'));
  assert.ok(collaborationTables.includes('collaboration_milestones'));
  assert.ok(!collaborationTables.includes('business_values'));

  const legacyPath = path.join(testRoot, 'data', 'legacy.db');
  const legacyDb = new sqlite3.Database(legacyPath);
  await new Promise((resolve, reject) => legacyDb.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      name TEXT NOT NULL, permissions TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, factory TEXT,
      status TEXT DEFAULT 'draft', created_by INTEGER NOT NULL, template_file_path TEXT, datasource_type TEXT,
      datasource_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE reports (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, period TEXT, status TEXT DEFAULT 'draft',
      template_id INTEGER, template_file_path TEXT, datasource_id INTEGER, created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO users(username,password,name,permissions) VALUES ('legacy-user','hash','Legacy User','[]');
    INSERT INTO templates(name,created_by) VALUES ('Legacy Template',1);
    INSERT INTO reports(title,created_by) VALUES ('Legacy Report',1);
  `, error => error ? reject(error) : resolve()));

  await new Promise((resolve, reject) => legacyDb.close(error => error ? reject(error) : resolve()));
  const upgraded = db.openDatabase(legacyPath, db.migrations.businessMigrations);
  await upgraded.ready;
  const preserved = await new Promise((resolve, reject) => upgraded.connection.get(
    `SELECT (SELECT username FROM users WHERE id=1) AS username,
      (SELECT name FROM templates WHERE id=1) AS template_name,
      (SELECT title FROM reports WHERE id=1) AS report_title,
      (SELECT COUNT(*) FROM schema_migrations) AS migration_count`,
    (error, row) => error ? reject(error) : resolve(row)
  ));
  assert.deepEqual(preserved, { username: 'legacy-user', template_name: 'Legacy Template', report_title: 'Legacy Report', migration_count: db.migrations.businessMigrations.length });
  await new Promise((resolve, reject) => upgraded.connection.close(error => error ? reject(error) : resolve()));

  // Pending-account login remains covered without the retired self-registration API.
  const pendingHash = await bcrypt.hash('acceptance-password', 4);
  await db._helpers.run(db, "INSERT INTO users(username,password,name,permissions,account_status) VALUES (?,?,?,'[]','disabled')",
    ['acceptance-user', pendingHash, 'Acceptance User']);
  const pendingLogin = await request('/auth/login', { method: 'POST', body: { username: 'acceptance-user', password: 'acceptance-password' } });
  assert.equal(pendingLogin.response.status, 401);
  const adminHash = await bcrypt.hash('acceptance-admin-password', 12);
  const adminInsert = await db._helpers.run(db, `INSERT INTO users (username, password, name, permissions)
    VALUES (?, ?, ?, ?)`, ['acceptance-admin', adminHash, 'Acceptance Administrator', JSON.stringify(['view', 'template', 'report'])]);
  const registeredUser = { id: adminInsert.lastID };
  await db._helpers.run(db, `INSERT INTO user_roles (user_id, role_code) VALUES (?, 'system_admin')`, [registeredUser.id]);

  const login = await request('/auth/login', {
    method: 'POST',
    body: { username: 'acceptance-admin', password: 'acceptance-admin-password' }
  });
  assert.equal(login.response.status, 200);
  assert.ok(login.payload.token);

  const currentUser = await request('/auth/me', { token: login.payload.token });
  assert.equal(currentUser.response.status, 200);
  assert.equal(currentUser.payload.user.username, 'acceptance-admin');
  assert.equal(currentUser.payload.user.roles[0].code, 'system_admin');

  const invalidSubmission = await request('/collaboration/tasks/1/submit', { method: 'POST', token: login.payload.token,
    headers: { 'Idempotency-Key': 'api-invalid-submit-01' }, body: { expectedVersion: -1, pendingChanges: 0 } });
  assert.equal(invalidSubmission.response.status, 400);
  assert.match(invalidSubmission.payload.error, /当前协作版本号/);

  const orgA = await request('/admin/organizations', { method: 'POST', token: login.payload.token, body: {
    code: 'HB-WH-A', name: '武汉分公司', organizationType: 'subsidiary', effectiveFrom: '2026-01-01', alias: '武汉公司'
  } });
  assert.equal(orgA.response.status, 201);
  const orgAuditQuery = await request(`/admin/audit-events?actorId=${registeredUser.id}&organizationId=${orgA.payload.organizationId}&action=organization.create`, { token: login.payload.token });
  assert.equal(orgAuditQuery.response.status, 200);
  const orgAuditEvent = orgAuditQuery.payload.events.find(event => event.objectId === String(orgA.payload.organizationId));
  assert.equal(orgAuditEvent.actorUsername, 'acceptance-admin');
  assert.equal(orgAuditEvent.outcome, 'success');
  assert.equal(orgAuditEvent.businessVersion, '1');
  assert.equal(orgAuditEvent.afterSummary.code, 'HB-WH-A');
  const unauthenticatedAuditRead = await request('/admin/audit-events');
  assert.equal(unauthenticatedAuditRead.response.status, 401);
  const anonymousDenial = await request('/admin/audit-events?outcome=denied', { token: login.payload.token });
  assert.ok(anonymousDenial.payload.events.some(event => event.actorId == null && event.reason === 'authentication_required'));
  const auditExportResponse = await fetch(`${await baseUrlReady}/admin/audit-events/export?organizationId=${orgA.payload.organizationId}`, {
    headers: { Authorization: `Bearer ${login.payload.token}` }
  });
  assert.equal(auditExportResponse.status, 200);
  assert.match(auditExportResponse.headers.get('content-type'), /text\/csv/);
  assert.match(await auditExportResponse.text(), /HB-WH-A/);
  const selfOrganizationChange = await request(`/admin/users/${registeredUser.id}`, { method: 'PATCH', token: login.payload.token,
    body: { organizationId: orgA.payload.organizationId, reason: 'forbidden self scope change' } });
  assert.equal(selfOrganizationChange.response.status, 403);
  const orgB = await request('/admin/organizations', { method: 'POST', token: login.payload.token, body: {
    code: 'HB-YC-B', name: '宜昌分公司', organizationType: 'subsidiary', effectiveFrom: '2026-01-01'
  } });
  assert.equal(orgB.response.status, 201);
  const orgC = await request('/admin/organizations', { method: 'POST', token: login.payload.token, body: {
    code: 'HB-JM-C', name: '荆门分公司', organizationType: 'subsidiary', effectiveFrom: '2026-01-01'
  } });
  assert.equal(orgC.response.status, 201);
  const orgList = await request('/admin/organizations', { token: login.payload.token });
  assert.ok(orgList.payload.organizations.find(org => org.id === orgA.payload.organizationId).aliases.some(alias => alias.alias === '武汉公司'));
  const cycle = await request(`/admin/organizations/${orgA.payload.organizationId}`, { method: 'PATCH', token: login.payload.token,
    body: { parentOrganizationId: orgA.payload.organizationId } });
  assert.equal(cycle.response.status, 400);

  const managedUser = await request('/admin/users', { method: 'POST', token: login.payload.token, body: {
    username: 'scoped-user', name: 'Scoped User', password: 'scoped-password-1', organizationId: orgA.payload.organizationId,
    roles: [{ code: 'subsidiary_filler', organizationId: orgA.payload.organizationId }]
  } });
  assert.equal(managedUser.response.status, 201);
  const orgAdmin = await request('/admin/users', { method: 'POST', token: login.payload.token, body: {
    username: 'organization-admin', name: 'Organization Administrator', password: 'org-admin-password-1', organizationId: orgA.payload.organizationId,
    roles: [{ code: 'organization_user_admin' }]
  } });
  assert.equal(orgAdmin.response.status, 201);
  const orgAdminLogin = await request('/auth/login', { method: 'POST', body: { username: 'organization-admin', password: 'org-admin-password-1' } });
  // Custom role definitions are composed from supported capabilities and take
  // effect on existing sessions without materializing extra permanent grants.
  const roleBody = { code: 'custom_identity_designer', name: '自定义身份设计员', scopeType: 'global',
    capabilities: ['organization_user_admin', 'template_designer'], reason: '角色功能验收' };
  assert.equal((await request('/admin/roles', { method: 'POST', token: orgAdminLogin.payload.token, body: roleBody })).response.status, 403);
  assert.equal((await request('/admin/roles', { method: 'POST', token: login.payload.token, body: { ...roleBody, capabilities: ['system_admin'] } })).response.status, 400);
  assert.equal((await request('/admin/roles', { method: 'POST', token: login.payload.token, body: { ...roleBody, scopeType: 'organization' } })).response.status, 400);
  assert.equal((await request('/admin/roles', { method: 'POST', token: login.payload.token, body: roleBody })).response.status, 201);
  assert.equal((await request('/admin/roles', { method: 'POST', token: login.payload.token, body: roleBody })).response.status, 409);
  assert.equal((await request('/admin/roles/system_admin', { method: 'PATCH', token: login.payload.token, body: roleBody })).response.status, 400);
  const customUser = await request('/admin/users', { method: 'POST', token: login.payload.token, body: {
    username: 'custom-role-user', name: '自定义角色用户', password: 'custom-role-password', organizationId: orgA.payload.organizationId,
    roles: [{ code: roleBody.code }]
  } });
  assert.equal(customUser.response.status, 201, JSON.stringify(customUser.payload));
  const customLogin = await request('/auth/login', { method: 'POST', body: { username: 'custom-role-user', password: 'custom-role-password' } });
  assert.ok(customLogin.payload.user.roles.some(role => role.code === 'template_designer'));
  assert.equal(customLogin.payload.user.roles.find(role => role.code === roleBody.code).name, roleBody.name);
  assert.equal((await request('/admin/organizations', { token: customLogin.payload.token })).response.status, 200);
  assert.equal((await request(`/admin/users/${customUser.payload.userId}/roles`, { method: 'PUT', token: orgAdminLogin.payload.token,
    body: { roles: [{ code: roleBody.code }], reason: '不得通过自定义角色授予系统级权限' } })).response.status, 403);
  const updateRole = data => request(`/admin/roles/${roleBody.code}`, { method: 'PATCH', token: login.payload.token, body: { ...roleBody, ...data } });
  assert.equal((await updateRole({ capabilities: ['template_designer'] })).response.status, 200);
  assert.equal((await request('/admin/organizations', { token: customLogin.payload.token })).response.status, 403, 'removed capability is revoked for existing token');
  assert.equal((await updateRole({ status: 'disabled' })).response.status, 200);
  assert.deepEqual((await request('/auth/me', { token: customLogin.payload.token })).payload.user.roles, []);
  assert.equal((await request(`/admin/users/${customUser.payload.userId}/roles`, { method: 'PUT', token: login.payload.token,
    body: { roles: [{ code: roleBody.code }], reason: '停用角色不可重新授予' } })).response.status, 400);
  assert.equal((await updateRole({ status: 'active' })).response.status, 200);
  assert.equal((await request('/admin/organizations', { token: customLogin.payload.token })).response.status, 200);
  const scopedRole = { code: 'custom_org_reporter', name: '自定义组织填报负责人', scopeType: 'organization',
    capabilities: ['subsidiary_filler', 'subsidiary_submitter'], reason: '组织范围验收' };
  assert.equal((await request('/admin/roles', { method: 'POST', token: login.payload.token, body: scopedRole })).response.status, 201);
  assert.equal((await request(`/admin/users/${customUser.payload.userId}/roles`, { method: 'PUT', token: login.payload.token,
    body: { roles: [{ code: scopedRole.code }], reason: '缺少组织' } })).response.status, 400);
  assert.equal((await request(`/admin/users/${customUser.payload.userId}/roles`, { method: 'PUT', token: login.payload.token,
    body: { roles: [{ code: scopedRole.code, organizationId: orgA.payload.organizationId }], reason: '只允许组织 A' } })).response.status, 200);
  const effectiveCustom = (await request('/auth/me', { token: customLogin.payload.token })).payload.user.roles;
  assert.ok(effectiveCustom.some(role => role.code === 'subsidiary_submitter' && role.organizationId === orgA.payload.organizationId));
  assert.ok(effectiveCustom.every(role => role.organizationId === orgA.payload.organizationId));
  assert.equal((await request('/admin/organizations', { token: customLogin.payload.token })).response.status, 403);
  const renameCustom = body => request(`/admin/users/${customUser.payload.userId}`, { method: 'PATCH', token: login.payload.token, body });
  assert.equal((await renameCustom({ username: '组织填报验收账号' })).response.status, 400);
  assert.equal((await renameCustom({ username: 'acceptance-admin', reason: '重复账号' })).response.status, 409);
  assert.equal((await renameCustom({ username: '组织填报验收账号', name: '组织填报验收账号', reason: '账号与姓名同步修改' })).response.status, 200);
  assert.equal((await request('/auth/login', { method: 'POST', body: { username: 'custom-role-user', password: 'custom-role-password' } })).response.status, 401);
  assert.equal((await request('/auth/login', { method: 'POST', body: { username: '组织填报验收账号', password: 'custom-role-password' } })).response.status, 200);
  const customAudits = await request('/admin/audit-events?action=role.update', { token: login.payload.token });
  assert.ok(customAudits.payload.events.some(event => event.objectId === roleBody.code && event.afterSummary.status === 'disabled'));
  assert.equal((await request('/admin/organizations', { token: orgAdminLogin.payload.token })).response.status, 200);
  const elevatedGrant = await request(`/admin/users/${managedUser.payload.userId}/roles`, { method: 'PUT', token: orgAdminLogin.payload.token,
    body: { roles: [{ code: 'management' }], reason: 'unauthorized elevation' } });
  assert.equal(elevatedGrant.response.status, 403);
  const deniedRoleAudit = await request('/admin/audit-events?action=user.roles.replace&outcome=denied', { token: login.payload.token });
  assert.ok(deniedRoleAudit.payload.events.some(event => event.objectId === String(managedUser.payload.userId)));
  const protectedAdminChange = await request(`/admin/users/${registeredUser.id}`, { method: 'PATCH', token: orgAdminLogin.payload.token,
    body: { organizationId: orgA.payload.organizationId, reason: 'unauthorized admin change' } });
  assert.equal(protectedAdminChange.response.status, 403);
  const deniedEvents = await request('/admin/audit-events?action=user.update&outcome=denied', { token: login.payload.token });
  assert.ok(deniedEvents.payload.events.some(event => event.objectId === String(registeredUser.id) && event.outcome === 'denied'));
  const missingResetReason = await request(`/admin/users/${managedUser.payload.userId}/reset-password`, { method: 'POST', token: login.payload.token,
    body: { password: 'new-scoped-password' } });
  assert.equal(missingResetReason.response.status, 400);
  const resetFailureAudit = await request('/admin/audit-events?action=user.password.reset&outcome=failed', { token: login.payload.token });
  assert.ok(resetFailureAudit.payload.events.some(event => event.objectId === String(managedUser.payload.userId)));
  await db._helpers.run(db, `CREATE TRIGGER fail_password_reset_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'user.password.reset' BEGIN SELECT RAISE(FAIL, 'simulated audit failure'); END`);
  const failedReset = await request(`/admin/users/${managedUser.payload.userId}/reset-password`, { method: 'POST', token: login.payload.token,
    body: { password: 'new-scoped-password', reason: 'simulate rollback' } });
  assert.equal(failedReset.response.status, 500);
  const failedResetAudit = await request(`/admin/audit-events?outcome=failed&objectId=${managedUser.payload.userId}`, { token: login.payload.token });
  const failedResetEvent = failedResetAudit.payload.events.find(event => event.afterSummary?.httpStatus === 500);
  assert.ok(failedResetEvent);
  assert.equal(failedResetEvent.businessVersion, '1');
  assert.equal(failedResetEvent.beforeSummary.stateChanged, false);
  assert.equal(failedResetEvent.reason, 'request_failed');
  assert.equal(JSON.stringify(failedResetEvent).includes('new-scoped-password'), false);
  const oldPasswordStillWorks = await request('/auth/login', { method: 'POST', body: { username: 'scoped-user', password: 'scoped-password-1' } });
  assert.equal(oldPasswordStillWorks.response.status, 200);
  await db._helpers.run(db, 'DROP TRIGGER fail_password_reset_audit');
  const successfulReset = await request(`/admin/users/${managedUser.payload.userId}/reset-password`, { method: 'POST', token: login.payload.token,
    body: { password: 'new-scoped-password-2', reason: '管理员密码重置' } });
  assert.equal(successfulReset.response.status, 200);
  const resetAudit = await db._helpers.get(db, `SELECT comment FROM audit_logs
    WHERE entity_type = 'user' AND entity_id = ? AND action = 'user.password.reset'`, [String(managedUser.payload.userId)]);
  assert.equal(resetAudit.comment, '管理员密码重置');
  const oldPasswordRejected = await request('/auth/login', { method: 'POST', body: { username: 'scoped-user', password: 'scoped-password-1' } });
  assert.equal(oldPasswordRejected.response.status, 401);
  const scopedLogin = await request('/auth/login', { method: 'POST', body: { username: 'scoped-user', password: 'new-scoped-password-2' } });
  assert.equal(scopedLogin.response.status, 200);
  assert.equal(scopedLogin.payload.user.roles[0].organizationId, orgA.payload.organizationId);
  const nonAdminAuditQuery = await request('/admin/audit-events', { token: scopedLogin.payload.token });
  assert.equal(nonAdminAuditQuery.response.status, 403);

  const selfGrant = await request(`/admin/users/${managedUser.payload.userId}/roles`, { method: 'PUT', token: scopedLogin.payload.token,
    body: { roles: [{ code: 'system_admin' }], reason: 'forbidden self grant' } });
  assert.equal(selfGrant.response.status, 403);
  const selfOrgAdminRoleChange = await request(`/admin/users/${orgAdmin.payload.userId}/roles`, { method: 'PUT', token: orgAdminLogin.payload.token,
    body: { roles: [], reason: 'self role removal' } });
  assert.equal(selfOrgAdminRoleChange.response.status, 403);
  const updatedRoles = await request(`/admin/users/${managedUser.payload.userId}/roles`, { method: 'PUT', token: login.payload.token,
    body: { roles: [{ code: 'subsidiary_filler', organizationId: orgB.payload.organizationId }], reason: '职责调整' } });
  assert.equal(updatedRoles.response.status, 200);
  const changedSession = await request('/auth/me', { token: scopedLogin.payload.token });
  assert.ok(changedSession.payload.user.roles.some(role => role.code === 'subsidiary_filler' && role.organizationId === orgB.payload.organizationId));
  assert.ok(!changedSession.payload.user.roles.some(role => role.code === 'subsidiary_filler' && role.organizationId === orgA.payload.organizationId));

  const departmentUser = await request('/admin/users', { method: 'POST', token: login.payload.token, body: {
    username: 'department-user', name: 'Department User', password: 'department-password-1', organizationId: orgC.payload.organizationId,
    roles: [{ code: 'department_reviewer', organizationId: orgB.payload.organizationId }]
  } });
  assert.equal(departmentUser.response.status, 201);
  const departmentLogin = await request('/auth/login', { method: 'POST', body: { username: 'department-user', password: 'department-password-1' } });

  const manager = await request('/admin/users', { method: 'POST', token: login.payload.token, body: {
    username: 'management-user', name: 'Management User', password: 'management-password-1', organizationId: orgC.payload.organizationId,
    roles: [{ code: 'management' }]
  } });
  assert.equal(manager.response.status, 201);
  const managerLogin = await request('/auth/login', { method: 'POST', body: { username: 'management-user', password: 'management-password-1' } });

  assert.equal((await request('/admin/organizations', { token: managerLogin.payload.token })).response.status, 403);

  const leader = await request('/admin/users', { method: 'POST', token: login.payload.token, body: {
    username: 'leader-user', name: 'Leader User', password: 'leader-password-1', organizationId: orgC.payload.organizationId,
    roles: [{ code: 'leader', organizationId: orgC.payload.organizationId }]
  } });
  assert.equal(leader.response.status, 201);
  const leaderLogin = await request('/auth/login', { method: 'POST', body: { username: 'leader-user', password: 'leader-password-1' } });

  const restoredRole = await request(`/admin/users/${managedUser.payload.userId}/roles`, { method: 'PUT', token: login.payload.token,
    body: { roles: [{ code: 'subsidiary_filler', organizationId: orgA.payload.organizationId }], reason: '恢复原职责范围' } });
  assert.equal(restoredRole.response.status, 200);
  const restoredSession = await request('/auth/me', { token: scopedLogin.payload.token });
  assert.ok(restoredSession.payload.user.roles.some(role => role.code === 'subsidiary_filler' && role.organizationId === orgA.payload.organizationId));

  const disabled = await request(`/admin/users/${managedUser.payload.userId}`, { method: 'PATCH', token: login.payload.token,
    body: { status: 'disabled', reason: '账户停用' } });
  assert.equal(disabled.response.status, 200);
  const disabledMe = await request('/auth/me', { token: scopedLogin.payload.token });
  assert.equal(disabledMe.response.status, 401);

  const designerHash = await bcrypt.hash('field-designer-password', 12);
  const designerInsert = await db._helpers.run(db, `INSERT INTO users (username, password, name, permissions) VALUES (?, ?, ?, '[]')`,
    ['field-designer', designerHash, 'Field Designer']);
  await db._helpers.run(db, `INSERT INTO user_roles (user_id, role_code) VALUES (?, 'template_designer')`, [designerInsert.lastID]);
  const dataAdminHash = await bcrypt.hash('field-admin-password', 12);
  const dataAdminInsert = await db._helpers.run(db, `INSERT INTO users (username, password, name, permissions) VALUES (?, ?, ?, '[]')`,
    ['field-admin', dataAdminHash, 'Field Administrator']);
  await db._helpers.run(db, `INSERT INTO user_roles (user_id, role_code) VALUES (?, 'data_administrator')`, [dataAdminInsert.lastID]);
  const designerLogin = await request('/auth/login', { method: 'POST', body: { username: 'field-designer', password: 'field-designer-password' } });
  const dataAdminLogin = await request('/auth/login', { method: 'POST', body: { username: 'field-admin', password: 'field-admin-password' } });
  assert.equal(designerLogin.response.status, 200);
  assert.equal(dataAdminLogin.response.status, 200);
  const testField = await db._helpers.run(db, `INSERT INTO field_definitions
    (code, display_name, data_type, semantic_type, unit, precision, editable, applicability_json, status, version, created_by, approved_by)
    VALUES ('FIELD_TEST_DECIMAL', '验收金额', 'decimal', 'decimal', '人民币元', 2, 1, '{}', 'approved', 1, ?, ?)`
  , [designerInsert.lastID, dataAdminInsert.lastID]);
  await db._helpers.run(db, `INSERT INTO field_definition_versions (field_definition_id, version, snapshot_json, created_by, approved_by)
    VALUES (?, 1, ?, ?, ?)`, [testField.lastID, JSON.stringify({ id: testField.lastID, version: 1, code: 'FIELD_TEST_DECIMAL', displayName: '验收金额', type: 'decimal', editable: true, status: 'approved' }), designerInsert.lastID, dataAdminInsert.lastID]);
  const designerRuleCatalog = await request('/rules/catalog', { token: designerLogin.payload.token });
  assert.equal(designerRuleCatalog.response.status, 200);
  assert.ok(designerRuleCatalog.payload.rules.some(rule => rule.ruleType === 'formula' && rule.scope === 'business_formula' && rule.status === 'published'));
  const privateRule = await db._helpers.run(db, `INSERT INTO rule_definitions (code, rule_type, display_name, status, created_by)
    VALUES ('PRIVATE_DRAFT_RULE', 'validation', '私有草稿规则', 'draft', ?)`, [dataAdminInsert.lastID]);
  await db._helpers.run(db, `INSERT INTO rule_versions (rule_id, version, expression_json, parameters_json, severity, status, created_by)
    VALUES (?, 1, '{"op":"eq","args":[1,1]}', '{"internal":"secret"}', 'blocking', 'draft', ?)`
  , [privateRule.lastID, dataAdminInsert.lastID]);
  const designerRulesAfterDraft = await request('/rules/catalog', { token: designerLogin.payload.token });
  assert.equal(designerRulesAfterDraft.response.status, 200);
  assert.equal(designerRulesAfterDraft.payload.rules.some(rule => rule.code === 'PRIVATE_DRAFT_RULE'), false,
    'template designers only receive published rule versions');
  const ruleAdminRules = await request('/rules/catalog', { token: login.payload.token });
  assert.ok(ruleAdminRules.payload.rules.some(rule => rule.code === 'PRIVATE_DRAFT_RULE' && rule.expression.op === 'eq'),
    'rule administrators retain access to unpublished rule versions');
  const createGovernedComponent = async (code, componentType, columns = 3) => request('/template-governance/components', {
    method: 'POST', token: designerLogin.payload.token,
    body: { code, name: `${code} 组件`, componentType, rowCount: 2, columnCount: columns,
      cells: [{ row: 0, column: 0, value: code }], metadata: {} }
  });
  const publishComponent = async (component, token = login.payload.token) => {
    const submit = await request(`/template-governance/components/${component.payload.componentId}/versions/${component.payload.versionId}/submit`, { method: 'POST', token: designerLogin.payload.token, body: {} });
    assert.equal(submit.response.status, 200);
    return request(`/template-governance/components/${component.payload.componentId}/versions/${component.payload.versionId}/review`, { method: 'POST', token, body: { action: 'approve' } });
  };
  const headerComponent = await createGovernedComponent('accept_header', 'header');
  const bodyComponent = await createGovernedComponent('accept_body', 'body');
  const footerComponent = await createGovernedComponent('accept_footer', 'footer');
  const wideHeaderComponent = await createGovernedComponent('accept_wide_header', 'header', 4);
  const approvedTestField = await db._helpers.get(db, 'SELECT id, version, code FROM field_definitions WHERE code = ?', ['FIELD_TEST_DECIMAL']);
  assert.equal(headerComponent.response.status, 201);
  const editableComponentDraft = await request(`/template-governance/components/versions/${bodyComponent.payload.versionId}`, {
    method: 'PUT', token: designerLogin.payload.token,
    body: { rowCount: 2, columnCount: 3, cells: [{ row: 0, column: 0, value: 'FIELD_TEST_DECIMAL', tag: { platform: 'cost-report-mapping-v1', fieldCode: 'FIELD_TEST_DECIMAL', namedArea: 'INPUT_FIELD_TEST_DECIMAL' } }],
      metadata: { name: 'accept_body 组件', mappings: [{ fieldDefinitionId: approvedTestField.id, fieldVersion: approvedTestField.version, fieldCode: 'FIELD_TEST_DECIMAL', namedArea: 'INPUT_FIELD_TEST_DECIMAL',
        row: 0, col: 0, rowCount: 1, colCount: 1, primary: true, permission: 'primary_input' }] } }
  });
  assert.equal(editableComponentDraft.response.status, 200);
  const footerWithDuplicatePrimary = await request(`/template-governance/components/versions/${footerComponent.payload.versionId}`, {
    method: 'PUT', token: designerLogin.payload.token,
    body: { rowCount: 2, columnCount: 3, cells: [{ row: 0, column: 0, value: 'FIELD_TEST_DECIMAL', tag: { platform: 'cost-report-mapping-v1', fieldCode: 'FIELD_TEST_DECIMAL', namedArea: 'INPUT_FIELD_TEST_DECIMAL' } }],
      metadata: { name: 'accept_footer 组件', mappings: [{ fieldDefinitionId: approvedTestField.id, fieldVersion: approvedTestField.version, fieldCode: 'FIELD_TEST_DECIMAL', namedArea: 'INPUT_FIELD_TEST_DECIMAL',
        row: 0, col: 0, rowCount: 1, colCount: 1, primary: true, permission: 'primary_input' }] } }
  });
  assert.equal(footerWithDuplicatePrimary.response.status, 200);
  const persistedMapping = (await request('/template-governance/components', { token: designerLogin.payload.token })).payload.components
    .find(component => component.versionId === bodyComponent.payload.versionId).metadata.mappings[0];
  assert.equal(persistedMapping.namedArea, 'INPUT_FIELD_TEST_DECIMAL');
  assert.equal((await publishComponent(headerComponent)).response.status, 200);
  assert.equal((await publishComponent(bodyComponent)).response.status, 200);
  assert.equal((await publishComponent(footerComponent)).response.status, 200);
  assert.equal((await publishComponent(wideHeaderComponent)).response.status, 200);
  await require('./direct-template-lifecycle.cjs')({ request, db, designerToken: designerLogin.payload.token,
    reviewerToken: login.payload.token, field: approvedTestField });
  await require('./composed-template-detail.cjs')({ request, token: designerLogin.payload.token, bodyVersionId: bodyComponent.payload.versionId });
  const badGridTemplate = await request('/template-governance/templates', { method: 'POST', token: designerLogin.payload.token, body: {
    name: 'Grid mismatch', sheets: [{ code: 'main', name: '业务', type: 'business', bodyVersionId: bodyComponent.payload.versionId,
      headerVersionId: wideHeaderComponent.payload.versionId }]
  } });
  assert.equal(badGridTemplate.response.status, 400);
  const governedTemplate = await request('/template-governance/templates', { method: 'POST', token: designerLogin.payload.token, body: {
    name: 'Governed acceptance template', description: 'multi-sheet workflow', factory: 'Acceptance', sheets: [
      { code: 'main', name: '成本数据', type: 'business', headerVersionId: headerComponent.payload.versionId,
        bodyVersionId: bodyComponent.payload.versionId, footerVersionId: footerComponent.payload.versionId },
      { code: 'guide', name: '填报说明', type: 'auxiliary', auxiliary: { rowCount: 2, columnCount: 2,
        cells: [{ row: 0, column: 0, value: '填写单位和周期' }, { row: 1, column: 0, value: '本页只读' }] } },
      { code: 'detail', name: '明细', type: 'business', bodyVersionId: bodyComponent.payload.versionId }
    ]
  } });
  assert.equal(governedTemplate.response.status, 201);

  const referenceWorkbookPath = path.resolve(__dirname, '../../', quarterlyReferenceProfile.sourceName);
  const referenceWorkbookHash = crypto.createHash('sha256').update(fs.readFileSync(referenceWorkbookPath)).digest('hex');
  assert.equal(referenceWorkbookHash, quarterlyReferenceProfile.sha256, 'registered reference workbook remains byte-for-byte unchanged');
  assert.deepEqual([...quarterlyReferenceProfile.companySheetNames, ...quarterlyReferenceProfile.auxiliarySheetNames].sort(),
    [...quarterlyReferenceProfile.sheetNames].sort(), 'reference profile classifies every source sheet exactly once');
  const quarterlyReferenceSheets = quarterlyReferenceProfile.sheetNames.map((name, index) => ({
    code: `reference_sheet_${String(index + 1).padStart(2, '0')}`,
    name,
    kind: quarterlyReferenceProfile.companySheetNames.includes(name) ? 'company' : 'readonly',
    rowCount: 1,
    columnCount: 1,
    cells: [],
    nativeValidations: [],
    designerJson: { name, rowCount: 1, columnCount: 1, sheets: {} }
  }));
  const badReferenceHash = await request('/template-governance/templates/import-quarterly-reference', {
    method: 'POST', token: designerLogin.payload.token,
    body: { sourceName: quarterlyReferenceProfile.sourceName, sourceSha256: '0'.repeat(64), sheets: quarterlyReferenceSheets }
  });
  assert.equal(badReferenceHash.response.status, 400, 'reference import rejects a workbook with an unregistered hash');
  const misclassifiedReferenceSheets = structuredClone(quarterlyReferenceSheets);
  misclassifiedReferenceSheets[0].kind = 'company';
  const badReferenceClassification = await request('/template-governance/templates/import-quarterly-reference', {
    method: 'POST', token: designerLogin.payload.token,
    body: { sourceName: quarterlyReferenceProfile.sourceName, sourceSha256: referenceWorkbookHash, sheets: misclassifiedReferenceSheets }
  });
  assert.equal(badReferenceClassification.response.status, 400, 'reference import rejects a sheet assigned to the wrong configured category');
  const misclassifiedCompanySheets = structuredClone(quarterlyReferenceSheets);
  misclassifiedCompanySheets[8].kind = 'readonly';
  const badCompanyClassification = await request('/template-governance/templates/import-quarterly-reference', {
    method: 'POST', token: designerLogin.payload.token,
    body: { sourceName: quarterlyReferenceProfile.sourceName, sourceSha256: referenceWorkbookHash, sheets: misclassifiedCompanySheets }
  });
  assert.equal(badCompanyClassification.response.status, 400, 'reference import rejects a company page assigned to the auxiliary category');
  const importedReference = await request('/template-governance/templates/import-quarterly-reference', {
    method: 'POST', token: designerLogin.payload.token,
    body: { sourceName: quarterlyReferenceProfile.sourceName, sourceSha256: referenceWorkbookHash, sheets: quarterlyReferenceSheets }
  });
  assert.equal(importedReference.response.status, 201);
  const repeatedReference = await request('/template-governance/templates/import-quarterly-reference', {
    method: 'POST', token: designerLogin.payload.token,
    body: { sourceName: quarterlyReferenceProfile.sourceName, sourceSha256: referenceWorkbookHash, sheets: quarterlyReferenceSheets }
  });
  assert.equal(repeatedReference.response.status, 201, 'reimport creates an independent draft instead of a component-code conflict');
  assert.notEqual(repeatedReference.payload.templateId, importedReference.payload.templateId);
  assert.equal(repeatedReference.payload.components.length, 13);
  const originalComponentCodes = new Set(importedReference.payload.components.map(item => item.code));
  assert.ok(repeatedReference.payload.components.every(item => !originalComponentCodes.has(item.code)));
  assert.deepEqual({
    sheetCount: importedReference.payload.sheetCount,
    companySheetCount: importedReference.payload.companySheetCount,
    readonlySheetCount: importedReference.payload.readonlySheetCount,
    status: importedReference.payload.status
  }, { sheetCount: 22, companySheetCount: 13, readonlySheetCount: 9, status: 'draft' });
  const importedReferenceDetail = await request(`/template-governance/templates/versions/${importedReference.payload.versionId}`, {
    token: designerLogin.payload.token
  });
  assert.equal(importedReferenceDetail.response.status, 200);
  const importedWorkbook = importedReferenceDetail.payload.template.workbook;
  assert.deepEqual(importedWorkbook.sheets.map(sheet => sheet.name), quarterlyReferenceProfile.sheetNames);
  assert.equal(importedWorkbook.sheets.filter(sheet => sheet.type === 'business').length, 13);
  assert.equal(importedWorkbook.sheets.filter(sheet => sheet.type === 'auxiliary').length, 9);
  assert.ok(importedWorkbook.sheets.filter(sheet => sheet.type === 'business').every(sheet =>
    sheet.sections?.some(section => section.type === 'body' && section.componentVersionId)));
  assert.ok(importedWorkbook.sheets.filter(sheet => sheet.type === 'auxiliary').every(sheet => sheet.readOnly === true));
  assert.equal(importedReferenceDetail.payload.template.manifest.sourceWorkbook.importedReadOnly, true);
  assert.ok(importedReferenceDetail.payload.template.manifest.migration.unresolvedGovernance.includes('approved_expected_data'));
  const editableImportedSheets = importedReferenceDetail.payload.template.sheets.map(sheet => ({
    code: sheet.sheet_code, name: sheet.display_name, type: sheet.sheet_type,
    headerVersionId: sheet.header_component_version_id, bodyVersionId: sheet.body_component_version_id,
    footerVersionId: sheet.footer_component_version_id, auxiliary: sheet.auxiliary
  }));
  const savedReferenceDraft = await request(`/template-governance/templates/versions/${importedReference.payload.versionId}`, {
    method: 'PUT', token: designerLogin.payload.token,
    body: { name: '2026 年专业化子公司二季度考核 · 迁移草稿（持续治理）', description: '治理往返验收', factory: '季度考核', sheets: editableImportedSheets }
  });
  assert.equal(savedReferenceDraft.response.status, 200, JSON.stringify(savedReferenceDraft.payload));
  const savedReferenceDetail = await request(`/template-governance/templates/versions/${importedReference.payload.versionId}`, {
    token: designerLogin.payload.token
  });
  assert.equal(savedReferenceDetail.payload.template.manifest.sourceWorkbook.sha256, referenceWorkbookHash,
    'saving the imported Draft preserves its source workbook fingerprint');
  assert.deepEqual(savedReferenceDetail.payload.template.manifest.migration.unresolvedGovernance,
    importedReferenceDetail.payload.template.manifest.migration.unresolvedGovernance,
    'saving the imported Draft preserves unresolved governance requirements');
  assert.equal(savedReferenceDetail.payload.template.status, 'draft', 'saving the imported reference template does not publish it');
  assert.equal(savedReferenceDetail.payload.template.workbook.sheets.length, 22);
  assert.deepEqual(savedReferenceDetail.payload.template.workbook.sheets.map(sheet => sheet.name), quarterlyReferenceProfile.sheetNames,
    'saving the imported Draft preserves the 22-sheet order and names');
  assert.equal(savedReferenceDetail.payload.template.workbook.sheets.filter(sheet => sheet.type === 'auxiliary' && sheet.readOnly).length, 9,
    'saving the imported Draft preserves all nine read-only reference sheets');
  assert.deepEqual(savedReferenceDetail.payload.template.sheets.filter(sheet => sheet.sheet_type === 'auxiliary').map(sheet => sheet.auxiliary),
    importedReferenceDetail.payload.template.sheets.filter(sheet => sheet.sheet_type === 'auxiliary').map(sheet => sheet.auxiliary),
    'saving the imported Draft preserves read-only auxiliary cells and layout JSON');
  const importedReferencePublicationChecks = await request(
    `/template-governance/templates/versions/${importedReference.payload.versionId}/publication-checks`, { token: designerLogin.payload.token });
  assert.equal(importedReferencePublicationChecks.response.status, 200);
  const referenceMigrationCheck = importedReferencePublicationChecks.payload.report.checks.find(item => item.code === 'reference_migration');
  assert.equal(referenceMigrationCheck.passed, false, 'the imported reference template cannot pass publication with empty company field registries');
  assert.ok(importedReferencePublicationChecks.payload.report.issues.some(item => item.code === 'reference_company_mapping_missing'
    && item.sheets.length === 13), 'publication checks identify all 13 company sheets with no approved field mappings');
  assert.equal(importedReferencePublicationChecks.payload.report.issues.some(item => item.code === 'reference_sheet_structure_invalid'), false,
    'the imported Draft passes reference sheet order and read-only classification checks');
  const publicationChecks = await request(`/template-governance/templates/versions/${governedTemplate.payload.versionId}/publication-checks`, { token: designerLogin.payload.token });
  assert.equal(publicationChecks.response.status, 200);
  assert.equal(publicationChecks.payload.report.passed, true);
  assert.ok(publicationChecks.payload.report.checks.some(check => check.code === 'fields' && check.passed));
  const templateRolePreview = await request(`/template-governance/templates/versions/${governedTemplate.payload.versionId}/role-preview?role=subsidiary_filler`, { token: designerLogin.payload.token });
  assert.equal(templateRolePreview.response.status, 200);
  assert.equal(templateRolePreview.payload.preview.sheets[0].mappings.find(mapping => mapping.fieldCode === 'FIELD_TEST_DECIMAL').editability, 'editable');
  const reviewerRolePreview = await request(`/template-governance/templates/versions/${governedTemplate.payload.versionId}/role-preview?role=reviewer`, { token: designerLogin.payload.token });
  assert.equal(reviewerRolePreview.payload.preview.sheets[0].mappings.find(mapping => mapping.fieldCode === 'FIELD_TEST_DECIMAL').editability, 'locked');
  const blockedTemplate = await request('/template-governance/templates', { method: 'POST', token: designerLogin.payload.token, body: {
    name: 'Publication gate rejection', sheets: [{ code: 'main', name: '业务数据', type: 'business', bodyVersionId: bodyComponent.payload.versionId }]
  } });
  const blockedTemplateDetail = await request(`/template-governance/templates/versions/${blockedTemplate.payload.versionId}`, { token: designerLogin.payload.token });
  const invalidWorkbook = blockedTemplateDetail.payload.template.workbook;
  const missingFormulaWorkbook = structuredClone(invalidWorkbook);
  invalidWorkbook.sheets[0].mappings[0].fieldCode = 'MISSING_APPROVED_FIELD';
  invalidWorkbook.sheets[0].mappings[0].fieldDefinitionId = null;
  await db._helpers.run(db, 'UPDATE template_versions SET workbook_json = ? WHERE id = ?', [JSON.stringify(invalidWorkbook), blockedTemplate.payload.versionId]);
  const rejectedByPublicationGate = await request(`/template-governance/templates/${blockedTemplate.payload.templateId}/versions/${blockedTemplate.payload.versionId}/submit`, {
    method: 'POST', token: designerLogin.payload.token, body: {}
  });
  assert.equal(rejectedByPublicationGate.response.status, 400);
  assert.equal(rejectedByPublicationGate.payload.report.passed, false);
  assert.ok(rejectedByPublicationGate.payload.report.issues.some(issue => issue.code === 'field_unapproved'));
  const missingFormulaMapping = missingFormulaWorkbook.sheets[0].mappings[0];
  Object.assign(missingFormulaMapping, { kind: 'calc', permission: 'system', primary: false,
    namedArea: 'MAIN_BODY_CALC_FIELD_TEST_DECIMAL', formulaSource: null, formulaVersionId: null });
  const missingFormulaCell = missingFormulaWorkbook.sheets[0].cells.find(cell =>
    Number(cell.row) === missingFormulaMapping.row && Number(cell.column ?? cell.col) === missingFormulaMapping.col);
  const missingFormulaTag = JSON.parse(missingFormulaCell.tag);
  Object.assign(missingFormulaTag, { kind: 'calc', permission: 'system', primary: false,
    namedArea: missingFormulaMapping.namedArea, formulaSource: null, formulaVersionId: null });
  missingFormulaCell.tag = JSON.stringify(missingFormulaTag);
  await db._helpers.run(db, 'UPDATE template_versions SET workbook_json = ? WHERE id = ?',
    [JSON.stringify(missingFormulaWorkbook), blockedTemplate.payload.versionId]);
  const missingFormulaPublication = await request(`/template-governance/templates/${blockedTemplate.payload.templateId}/versions/${blockedTemplate.payload.versionId}/submit`, {
    method: 'POST', token: designerLogin.payload.token, body: {}
  });
  assert.equal(missingFormulaPublication.response.status, 400);
  assert.ok(missingFormulaPublication.payload.report.checks.find(check => check.code === 'formulas').issues
    .some(issue => issue.code === 'formula_unavailable' && issue.namedArea === missingFormulaMapping.namedArea),
  'a CALC field without a formula cannot reach published status');
  const governedReviewSubmit = await request(`/template-governance/templates/${governedTemplate.payload.templateId}/versions/${governedTemplate.payload.versionId}/submit`, {
    method: 'POST', token: designerLogin.payload.token, body: {}
  });
  assert.equal(governedReviewSubmit.response.status, 200);
  const selfPublishDenied = await request(`/template-governance/templates/${governedTemplate.payload.templateId}/versions/${governedTemplate.payload.versionId}/review`, {
    method: 'POST', token: designerLogin.payload.token, body: { action: 'approve' }
  });
  assert.equal(selfPublishDenied.response.status, 403);
  const governedPublished = await request(`/template-governance/templates/${governedTemplate.payload.templateId}/versions/${governedTemplate.payload.versionId}/review`, {
    method: 'POST', token: login.payload.token, body: { action: 'approve' }
  });
  assert.equal(governedPublished.response.status, 200);
  const governedDetail = await request(`/template-governance/templates/versions/${governedTemplate.payload.versionId}`, { token: designerLogin.payload.token });
  assert.equal(governedDetail.payload.template.workbook.sheets[0].columnCount, 3);
  assert.deepEqual(governedDetail.payload.template.workbook.sheets[0].sections.map(section => section.startRow), [0, 2, 4]);
  assert.equal(governedDetail.payload.template.workbook.sheets[0].sections[1].componentVersionId, bodyComponent.payload.versionId);
  const composedFieldMappings = governedDetail.payload.template.workbook.sheets[0].mappings.filter(mapping => mapping.fieldCode === 'FIELD_TEST_DECIMAL');
  assert.equal(composedFieldMappings.length, 2);
  assert.equal(composedFieldMappings.filter(mapping => mapping.primary && mapping.permission === 'primary_input').length, 1);
  assert.equal(composedFieldMappings.filter(mapping => !mapping.primary && mapping.permission === 'read_only').length, 1);
  assert.equal(composedFieldMappings[0].row, 2);
  assert.equal(composedFieldMappings[0].namedArea, 'MAIN_BODY_INPUT_FIELD_TEST_DECIMAL');
  const templateFieldMappings = governedDetail.payload.template.workbook.sheets.flatMap(sheet => sheet.mappings || [])
    .filter(mapping => mapping.fieldCode === 'FIELD_TEST_DECIMAL');
  assert.equal(templateFieldMappings.length, 3);
  assert.equal(templateFieldMappings.filter(mapping => mapping.primary && mapping.permission === 'primary_input').length, 1);
  assert.equal(templateFieldMappings.filter(mapping => !mapping.primary && mapping.permission === 'read_only').length, 2);
  assert.equal(governedDetail.payload.template.workbook.sheets[1].readOnly, true);
  assert.equal(governedDetail.payload.template.workbook.sheets[1].cells[0].value, '填写单位和周期');
  const publishedTemplateMutation = await request(`/template-governance/templates/versions/${governedTemplate.payload.versionId}`, {
    method: 'PUT', token: designerLogin.payload.token, body: { name: 'mutated', sheets: [] }
  });
  assert.equal(publishedTemplateMutation.response.status, 409);
  const bodyV2 = await request(`/template-governance/components/${bodyComponent.payload.componentId}/versions`, {
    method: 'POST', token: designerLogin.payload.token,
    body: { rowCount: 3, columnCount: 3, cells: [{ row: 2, column: 0, value: 'v2' }], metadata: { note: 'new body revision' } }
  });
  assert.equal(bodyV2.response.status, 201);
  assert.equal((await request(`/template-governance/components/${bodyComponent.payload.componentId}/versions/${bodyV2.payload.versionId}/submit`, {
    method: 'POST', token: designerLogin.payload.token, body: {}
  })).response.status, 200);
  assert.equal((await request(`/template-governance/components/${bodyComponent.payload.componentId}/versions/${bodyV2.payload.versionId}/review`, {
    method: 'POST', token: login.payload.token, body: { action: 'approve' }
  })).response.status, 200);
  const componentHistory = await request('/template-governance/components', { token: designerLogin.payload.token });
  assert.equal(componentHistory.payload.components.find(item => item.versionId === bodyComponent.payload.versionId).status, 'superseded');
  assert.equal(componentHistory.payload.components.find(item => item.versionId === bodyV2.payload.versionId).status, 'published');
  await assert.rejects(db._helpers.run(db, `UPDATE template_component_versions SET workbook_json = '{}' WHERE id = ?`, [bodyV2.payload.versionId]), /published component versions are immutable/);
  const publishedComponentMutation = await request(`/template-governance/components/versions/${bodyV2.payload.versionId}`, {
    method: 'PUT', token: designerLogin.payload.token,
    body: { rowCount: 3, columnCount: 3, cells: [], metadata: { name: 'mutated published' } }
  });
  assert.equal(publishedComponentMutation.response.status, 409);
  const templateV2 = await request(`/template-governance/templates/${governedTemplate.payload.templateId}/versions`, {
    method: 'POST', token: designerLogin.payload.token, body: { fromVersionId: governedTemplate.payload.versionId }
  });
  assert.equal(templateV2.response.status, 201);
  const templateV2Detail = await request(`/template-governance/templates/versions/${templateV2.payload.versionId}`, { token: designerLogin.payload.token });
  assert.equal(templateV2Detail.payload.template.sheets.length, 3);
  assert.equal(templateV2Detail.payload.template.workbook.sheets[1].cells[1].value, '本页只读');
  const templateV2Submit = await request(`/template-governance/templates/${governedTemplate.payload.templateId}/versions/${templateV2.payload.versionId}/submit`, {
    method: 'POST', token: designerLogin.payload.token, body: {}
  });
  assert.equal(templateV2Submit.response.status, 200);
  const templateV2Review = await request(`/template-governance/templates/${governedTemplate.payload.templateId}/versions/${templateV2.payload.versionId}/review`, {
    method: 'POST', token: login.payload.token, body: { action: 'reject', note: '补充说明页内容后再提审' }
  });
  assert.equal(templateV2Review.response.status, 200);
  assert.equal(templateV2Review.payload.status, 'rejected');
  const templateV3 = await request(`/template-governance/templates/${governedTemplate.payload.templateId}/versions`, {
    method: 'POST', token: designerLogin.payload.token, body: { fromVersionId: templateV2.payload.versionId }
  });
  assert.equal(templateV3.response.status, 201);
  assert.equal(templateV3.payload.version, 3);
  const templateV3Submit = await request(`/template-governance/templates/${governedTemplate.payload.templateId}/versions/${templateV3.payload.versionId}/submit`, {
    method: 'POST', token: designerLogin.payload.token, body: {}
  });
  assert.equal(templateV3Submit.response.status, 200);
  const templateV3Review = await request(`/template-governance/templates/${governedTemplate.payload.templateId}/versions/${templateV3.payload.versionId}/review`, {
    method: 'POST', token: login.payload.token, body: { action: 'approve' }
  });
  assert.equal(templateV3Review.response.status, 200);
  assert.equal((await db._helpers.get(db, 'SELECT status FROM template_versions WHERE id = ?', [governedTemplate.payload.versionId])).status, 'superseded');
  const managedPeriodAccess = await request('/period-configuration/report-types', { token: designerLogin.payload.token });
  assert.equal(managedPeriodAccess.response.status, 403);
  const monthlyType = await request('/period-configuration/report-types', { method: 'POST', token: login.payload.token,
    body: { code: 'ACCEPTANCE_MONTHLY', displayName: '月度经营分析', cadence: 'monthly' } });
  assert.equal(monthlyType.response.status, 201);
  assert.equal(monthlyType.payload.workflowProfile, 'monthly');
  const unauthorizedReferenceReport = await request(`/collaboration/reference-report?periodCode=2026-10&reportTypeId=${monthlyType.payload.reportTypeId}`,
    { token: designerLogin.payload.token });
  assert.equal(unauthorizedReferenceReport.response.status, 403);
  const periodResponsibilities = ['filler', 'submitter', 'department_reviewer', 'approver', 'finalizer'];
  const assignmentsFor = organizationIds => organizationIds.flatMap(organizationId => periodResponsibilities.map(responsibility => ({ organizationId, responsibility, userId: registeredUser.id })));
  const emptyEditorDraft = await request('/period-configuration/packages', { method: 'POST', token: login.payload.token,
    body: { draftOnly: true } });
  assert.equal(emptyEditorDraft.response.status, 201, JSON.stringify(emptyEditorDraft.payload));
  const draftId = emptyEditorDraft.payload.package.id;
  assert.match(draftId, /^draft-/);
  assert.ok((await request('/period-configuration/packages', { token: login.payload.token })).payload.packages.some(item => item.id === draftId));
  const incompleteCheck = await request(`/period-configuration/packages/${draftId}/validate`, { method: 'POST', token: login.payload.token });
  assert.equal(incompleteCheck.payload.valid, false);
  assert.equal(incompleteCheck.payload.errors.length, 4);
  const incompleteActivation = await request(`/period-configuration/packages/${draftId}/activate`, { method: 'POST', token: login.payload.token });
  assert.equal(incompleteActivation.response.status, 400);
  const partialInput = { draftOnly: true, reportTypeId: monthlyType.payload.reportTypeId, periodCode: '2098-01',
    templateVersionId: templateV3.payload.versionId, organizations: [{ organizationId: orgA.payload.organizationId }],
    metricWeights: { revenue: 50, profit: 50 }, targets: [{ amount: '' }], indicators: [{ code: '' }],
    assignments: assignmentsFor([orgA.payload.organizationId]) };
  assert.equal((await request(`/period-configuration/packages/${draftId}`, { method: 'PUT', token: login.payload.token, body: partialInput })).response.status, 200);
  const restoredDraft = await readPackage(draftId, login.payload.token);
  assert.deepEqual(restoredDraft.payload.package.draftInput.targets, [{ amount: '' }]);
  assert.equal((await request(`/period-configuration/packages/${draftId}/validate`, { method: 'POST', token: login.payload.token })).payload.valid, false);
  assert.equal((await db._helpers.get(db, "SELECT COUNT(*) AS count FROM report_tasks WHERE period_code = '2098-01'")).count, 0);
  const completedInput = { ...partialInput, targets: [], indicators: [], assignments: partialInput.assignments.map(assignment =>
    ['filler', 'submitter'].includes(assignment.responsibility) ? { ...assignment, userId: customUser.payload.userId } : assignment) };
  assert.equal((await request(`/period-configuration/packages/${draftId}`, { method: 'PUT', token: login.payload.token, body: completedInput })).response.status, 200);
  const completedDraft = await request(`/period-configuration/packages/${draftId}/validate`, { method: 'POST', token: login.payload.token });
  assert.equal(completedDraft.payload.valid, true, JSON.stringify(completedDraft.payload));
  const completedPackageId = completedDraft.payload.packageId;
  assert.equal((await db._helpers.get(db, "SELECT COUNT(*) AS count FROM report_tasks WHERE period_code = '2098-01'")).count, 0);
  const stagedEdit = await request(`/period-configuration/packages/${completedPackageId}`, { method: 'PUT', token: login.payload.token,
    body: { ...completedInput, assignments: [{ organizationId: orgA.payload.organizationId, responsibility: 'submitter', userId: -1 }] } });
  assert.equal(stagedEdit.response.status, 200);
  const staleActivation = await request(`/period-configuration/packages/${completedPackageId}/activate`, { method: 'POST', token: login.payload.token });
  assert.equal(staleActivation.response.status, 400, 'numeric package id must not bypass pending draft changes');
  assert.ok(staleActivation.payload.errors.some(error => /责任人不存在|责任分配无效/.test(error)));
  await request(`/period-configuration/packages/${stagedEdit.payload.package.id}`, { method: 'PUT', token: login.payload.token, body: completedInput });
  const completedActivation = await request(`/period-configuration/packages/${completedPackageId}/activate`, { method: 'POST', token: login.payload.token });
  assert.equal(completedActivation.response.status, 200, JSON.stringify(completedActivation.payload));
  assert.equal(completedActivation.payload.taskCount, 1);
  const customTaskId = completedActivation.payload.taskIds[0];
  assert.equal((await request(`/collaboration/tasks/${customTaskId}/room`, { token: customLogin.payload.token })).response.status, 200,
    'custom role qualifies for task responsibility and collaboration room');
  const customIdentity = await collaboration.activeUser(customUser.payload.userId);
  assert.equal(await collaboration.canAccessRoom(customIdentity, { id: customTaskId, organization_id: orgB.payload.organizationId }), false,
    'custom role cannot cross its assigned organization');
  assert.equal((await request(`/admin/roles/${scopedRole.code}`, { method: 'PATCH', token: login.payload.token,
    body: { ...scopedRole, status: 'disabled' } })).response.status, 200);
  assert.equal((await request(`/collaboration/tasks/${customTaskId}/room`, { token: customLogin.payload.token })).response.status, 403,
    'disabling a custom role revokes task access even when responsibility assignment remains');
  assert.equal((await request(`/admin/roles/${scopedRole.code}`, { method: 'PATCH', token: login.payload.token,
    body: { ...scopedRole, status: 'active' } })).response.status, 200);
  assert.equal((await request(`/period-configuration/packages/${completedPackageId}`, { method: 'PUT', token: login.payload.token,
    body: completedInput })).response.status, 409, 'draft mode must not edit active packages');
  assert.equal((await request('/period-configuration/packages', { method: 'POST', token: designerLogin.payload.token,
    body: { draftOnly: true } })).response.status, 403);
  const invalidMonthlyWeights = await request('/period-configuration/packages', { method: 'POST', token: login.payload.token, body: {
    reportTypeId: monthlyType.payload.reportTypeId, periodCode: '2026-09', templateVersionId: templateV3.payload.versionId,
    organizations: [{ organizationId: orgA.payload.organizationId }], metricWeights: { revenue: 80, profit: 30 }
  } });
  assert.equal(invalidMonthlyWeights.response.status, 201);
  assert.equal(invalidMonthlyWeights.payload.package.assignments.length, 0,
    'missing responsibilities are not silently assigned to a system administrator');

  const invalidMonthlyValidation = await request(`/period-configuration/packages/${invalidMonthlyWeights.payload.package.id}/validate`, { method: 'POST', token: login.payload.token });
  assert.equal(invalidMonthlyValidation.payload.valid, false);
  assert.ok(invalidMonthlyValidation.payload.errors.some(error => /收入与利润权重合计/.test(error)));
  const periodResources = await request('/period-configuration/resources', { token: login.payload.token });
  assert.ok(periodResources.payload.templates.some(item => item.versionId === templateV3.payload.versionId));
  assert.deepEqual(periodResources.payload.ruleThresholdDefaults, {
    yoyChangePercent: 30, momChangePercent: 30, targetCompletionMinPercent: 70, targetCompletionMaxPercent: 130
  });
  const invalidRuleThresholds = await request('/period-configuration/packages', { method: 'POST', token: login.payload.token, body: {
    reportTypeId: monthlyType.payload.reportTypeId, periodCode: '2026-12', templateVersionId: templateV3.payload.versionId,
    organizations: [{ organizationId: orgA.payload.organizationId }],
    ruleThresholds: { yoyChangePercent: 30, momChangePercent: 30, targetCompletionMinPercent: 130, targetCompletionMaxPercent: 70 }
  } });
  assert.equal(invalidRuleThresholds.response.status, 400);
  const periodPackage = await request('/period-configuration/packages', { method: 'POST', token: login.payload.token, body: {
    reportTypeId: monthlyType.payload.reportTypeId, periodCode: '2026-10', templateVersionId: templateV3.payload.versionId,
    metricWeights: { revenue: 65, profit: 35 },
    organizations: [{ organizationId: orgA.payload.organizationId }, { organizationId: orgB.payload.organizationId }],
    targets: [{ organizationId: orgA.payload.organizationId, fieldDefinitionId: approvedTestField.id, phase: 'annual', phasePeriod: '2026', amount: '120' }],
    generateMonthlyTargetsFromAnnual: [{ organizationId: orgA.payload.organizationId, fieldDefinitionId: approvedTestField.id, year: '2026' }],
    assignments: assignmentsFor([orgA.payload.organizationId, orgB.payload.organizationId]),
    configuration: { note: 'acceptance package snapshot' }
  } });
  assert.equal(periodPackage.response.status, 201, JSON.stringify(periodPackage.payload));
  assert.equal(periodPackage.payload.package.status, 'draft');
  assert.deepEqual(periodPackage.payload.package.configuration.ruleThresholds, periodResources.payload.ruleThresholdDefaults);
  assert.equal(periodPackage.payload.package.organizations[0].deadline_at, '2026-11-02T23:59:59+08:00');
  assert.equal(periodPackage.payload.package.targets.filter(target => target.generated_from_annual).length, 12);
  assert.equal(periodPackage.payload.package.targets.filter(target => target.generated_from_annual).reduce((sum, target) => sum + Number(target.amount_decimal), 0), 120);
  const packageValidation = await request(`/period-configuration/packages/${periodPackage.payload.package.id}/validate`, { method: 'POST', token: login.payload.token });
  assert.equal(packageValidation.response.status, 200);
  assert.equal(packageValidation.payload.valid, true);
  const periodActivation = await request(`/period-configuration/packages/${periodPackage.payload.package.id}/activate`, { method: 'POST', token: login.payload.token });
  assert.equal(periodActivation.response.status, 200, JSON.stringify(periodActivation.payload));
  assert.equal(periodActivation.payload.taskCount, 2);
  const packageActivationAudit = await request(`/admin/audit-events?objectType=period_package&objectId=${periodPackage.payload.package.id}&action=period_package.activate`, { token: login.payload.token });
  assert.deepEqual(packageActivationAudit.payload.events[0].afterSummary.ruleThresholds, periodPackage.payload.package.configuration.ruleThresholds,
    'package activation audit records the effective threshold ratios');
  const activatedTasks = await db._helpers.all(db, 'SELECT * FROM report_tasks WHERE package_id = ? ORDER BY organization_id', [periodPackage.payload.package.id]);
  assert.equal(activatedTasks.length, 2);
  const taskFiller = await request('/admin/users', { method: 'POST', token: login.payload.token, body: {
    username: 'reminder-filler', name: 'Reminder Filler', password: 'reminder-filler-password',
    organizationId: orgA.payload.organizationId, roles: [{ code: 'subsidiary_filler', organizationId: orgA.payload.organizationId }]
  } });
  assert.equal(taskFiller.response.status, 201);
  const taskFillerLogin = await request('/auth/login', { method: 'POST', body: { username: 'reminder-filler', password: 'reminder-filler-password' } });
  const formerTaskFiller = await request('/admin/users', { method: 'POST', token: login.payload.token, body: {
    username: 'former-task-filler', name: 'Former Task Filler', password: 'former-task-filler-password',
    organizationId: orgA.payload.organizationId, roles: [{ code: 'subsidiary_filler', organizationId: orgA.payload.organizationId }]
  } });
  assert.equal(formerTaskFiller.response.status, 201);
  await db._helpers.run(db, `UPDATE package_assignments SET user_id=?
    WHERE package_id=? AND organization_id=? AND responsibility='filler'`,
  [formerTaskFiller.payload.userId, activatedTasks[0].package_id, activatedTasks[0].organization_id]);
  const formerAssignmentSnapshot = JSON.parse(activatedTasks[0].configuration_snapshot_json);
  const initialFiller = formerAssignmentSnapshot.assignments.find(item => item.responsibility === 'filler');
  if (initialFiller) initialFiller.userId = formerTaskFiller.payload.userId;
  await db._helpers.run(db, 'UPDATE report_tasks SET configuration_snapshot_json=? WHERE id=?',
    [JSON.stringify(formerAssignmentSnapshot), activatedTasks[0].id]);
  const formerTaskFillerLogin = await request('/auth/login', { method: 'POST', body: {
    username: 'former-task-filler', password: 'former-task-filler-password'
  } });
  assert.equal((await request(`/collaboration/tasks/${activatedTasks[0].id}/room`, { token: formerTaskFillerLogin.payload.token })).response.status, 200,
    'the originally assigned filler can access the task room before reassignment');
  const deniedTaskProgress = await request('/task-operations/progress', { token: designerLogin.payload.token });
  assert.equal(deniedTaskProgress.response.status, 403);
  const initialTaskProgress = await request('/task-operations/progress', { token: login.payload.token });
  assert.equal(initialTaskProgress.response.status, 200, JSON.stringify(initialTaskProgress.payload));
  assert.equal(initialTaskProgress.payload.tasks.filter(item => item.periodCode === '2026-10').length, 2,
    'progress includes all participating organizations before any edits');
  assert.ok(initialTaskProgress.payload.tasks.filter(item => item.periodCode === '2026-10').every(item => item.roomCreated && !item.hasEdits));
  assert.ok(initialTaskProgress.payload.tasks.every(item => 'precheck' in item && 'onlineUsers' in item));
  const reminderDaysDenied = await request(`/task-operations/report-types/${monthlyType.payload.reportTypeId}/reminders`, {
    method: 'PUT', token: login.payload.token, body: { schedule: { daysBefore: [31] } }
  });
  assert.equal(reminderDaysDenied.response.status, 400);
  const reminderSchedule = await request(`/task-operations/report-types/${monthlyType.payload.reportTypeId}/reminders`, {
    method: 'PUT', token: login.payload.token, body: { schedule: { daysBefore: [3, 1], deadlineMorning: true, dailyAfterExpiry: true } }
  });
  assert.equal(reminderSchedule.response.status, 200);
  assert.deepEqual(reminderSchedule.payload.schedule.daysBefore, [3, 1]);
  const missingReassignmentReason = await request(`/task-operations/tasks/${activatedTasks[0].id}/reassign`, {
    method: 'POST', token: login.payload.token, body: { responsibility: 'filler', userId: taskFiller.payload.userId, reason: '' }
  });
  assert.equal(missingReassignmentReason.response.status, 400);
  const reassignedTask = await request(`/task-operations/tasks/${activatedTasks[0].id}/reassign`, {
    method: 'POST', token: login.payload.token,
    body: { responsibility: 'filler', userId: taskFiller.payload.userId, reason: '岗位轮换，调整填报责任人' }
  });
  assert.equal(reassignedTask.response.status, 200, JSON.stringify(reassignedTask.payload));
  assert.equal(reassignedTask.payload.previousUserId, formerTaskFiller.payload.userId);
  assert.equal((await request(`/collaboration/tasks/${activatedTasks[0].id}/room`, { token: formerTaskFillerLogin.payload.token })).response.status, 403,
    'the former filler loses access to the reassigned task room');
  assert.equal((await request(`/collaboration/tasks/${activatedTasks[0].id}/room`, { token: taskFillerLogin.payload.token })).response.status, 200,
    'the newly assigned filler gains access to the task room');
  const historicalAssignment = await db._helpers.get(db, 'SELECT previous_user_id,new_user_id,reason FROM task_assignment_history WHERE task_id=?', [activatedTasks[0].id]);
  assert.deepEqual(historicalAssignment, { previous_user_id: formerTaskFiller.payload.userId, new_user_id: taskFiller.payload.userId, reason: '岗位轮换，调整填报责任人' });
  const additionalFiller = await request(`/task-operations/tasks/${activatedTasks[0].id}/reassign`, {
    method: 'POST', token: login.payload.token,
    body: { mode: 'add', responsibility: 'filler', userId: formerTaskFiller.payload.userId, reason: '追加协同填报人，保留当前责任人' }
  });
  assert.equal(additionalFiller.response.status, 200, JSON.stringify(additionalFiller.payload));
  const sharedTask = await request(`/collaboration/tasks/${activatedTasks[0].id}/room`, { token: taskFillerLogin.payload.token });
  assert.ok(sharedTask.payload.task.configuration.assignments.some(item => item.responsibility === 'filler' && item.userId === taskFiller.payload.userId));
  assert.ok(sharedTask.payload.task.configuration.assignments.some(item => item.responsibility === 'filler' && item.userId === formerTaskFiller.payload.userId));
  assert.ok(sharedTask.payload.task.submitters.some(item => item.id === registeredUser.id && item.username));
  assert.equal((await request(`/task-operations/tasks/${activatedTasks[0].id}/reassign`, {
    method: 'POST', token: login.payload.token,
    body: { mode: 'add', responsibility: 'filler', userId: formerTaskFiller.payload.userId, reason: '不能重复追加' }
  })).response.status, 409);
  assert.equal((await request(`/task-operations/tasks/${activatedTasks[0].id}/reassign`, {
    method: 'POST', token: taskFillerLogin.payload.token,
    body: { mode: 'add', responsibility: 'filler', userId: formerTaskFiller.payload.userId, reason: '普通填报人不能分配权限' }
  })).response.status, 403);
  const rejectedShortExtension = await request(`/task-operations/tasks/${activatedTasks[0].id}/extend-deadline`, {
    method: 'POST', token: login.payload.token,
    body: { deadlineAt: '2026-11-02T23:59:59+08:00', reason: '测试相同时间被拒绝' }
  });
  assert.equal(rejectedShortExtension.response.status, 400);
  const extendedTask = await request(`/task-operations/tasks/${activatedTasks[0].id}/extend-deadline`, {
    method: 'POST', token: login.payload.token,
    body: { deadlineAt: '2026-11-04T23:59:59+08:00', reason: '等待缺失凭证补齐' }
  });
  assert.equal(extendedTask.response.status, 200, JSON.stringify(extendedTask.payload));
  const taskOperations = require('../src/controllers/taskOperationsController');
  assert.equal(taskOperations._test.taskIsOverdue('submitted', false, '2026-11-05T00:00:00.000Z', '2026-11-04T23:59:59.000Z'), true,
    'tasks submitted after their deadline retain the overdue indicator');
  assert.equal(taskOperations._test.taskIsOverdue('submitted', false, '2026-11-04T20:00:00.000Z', '2026-11-04T23:59:59.000Z'), false,
    'on-time submitted tasks are not marked overdue');
  assert.equal(taskOperations._test.taskIsOverdue('submitted', false, '2026-11-05 00:30:00', '2026-11-05T08:00:00+08:00'), true,
    'SQLite UTC submission timestamps are compared in UTC, not interpreted as Shanghai time');
  await taskOperations._test.processDueReminders(new Date('2026-11-05T03:00:00.000Z'));
  const deliveredReminders = await db._helpers.all(db, `SELECT n.notification_type,n.status,n.user_id,n.task_id FROM notifications n
    JOIN task_reminder_deliveries d ON d.notification_id=n.id WHERE n.task_id=? AND n.user_id=? ORDER BY n.id`,
  [activatedTasks[0].id, taskFiller.payload.userId]);
  assert.ok(deliveredReminders.length >= 3, 'before-deadline and overdue reminder events are delivered in system');
  assert.ok(deliveredReminders.every(item => item.notification_type === 'task_reminder' && item.status === 'sent'));
  const fillerNotifications = await request('/task-operations/notifications', { token: taskFillerLogin.payload.token });
  assert.equal(fillerNotifications.response.status, 200);
  const reminderForAssignee = fillerNotifications.payload.notifications.find(item => item.taskId === activatedTasks[0].id);
  assert.ok(reminderForAssignee);
  assert.equal((await request(`/task-operations/notifications/${reminderForAssignee.id}/read`, {
    method: 'POST', token: taskFillerLogin.payload.token, body: {}
  })).response.status, 200);
  const progressAfterOperations = await request('/task-operations/progress', { token: login.payload.token });
  const operatedTask = progressAfterOperations.payload.tasks.find(item => item.id === activatedTasks[0].id);
  assert.equal(operatedTask.assignments.find(item => item.responsibility === 'filler').userId, taskFiller.payload.userId);
  assert.equal(operatedTask.deadlineAt, '2026-11-04T15:59:59.000Z');
  assert.equal(operatedTask.extensionReason, '等待缺失凭证补齐');
  const monthlyReferenceReport = await request(`/collaboration/reference-report?periodCode=2026-10&reportTypeId=${monthlyType.payload.reportTypeId}`,
    { token: login.payload.token });
  assert.equal(monthlyReferenceReport.response.status, 200, JSON.stringify(monthlyReferenceReport.payload));
  assert.equal(monthlyReferenceReport.payload.rows.length, 2);
  assert.equal(monthlyReferenceReport.payload.finalizedOrganizations, 0);
  assert.equal(monthlyReferenceReport.payload.rows[0].metrics.revenue.currentYearToDate.value, null);
  assert.equal(monthlyReferenceReport.payload.scoringAvailable, false);
  assert.equal(activatedTasks[0].deadline_at, '2026-11-02T23:59:59+08:00');
  const taskSnapshot = JSON.parse(activatedTasks[0].configuration_snapshot_json);
  assert.equal(taskSnapshot.templateVersionId, templateV3.payload.versionId);
  assert.equal(taskSnapshot.packageVersion, 1);
  assert.deepEqual(taskSnapshot.configuration.metricWeights, { revenue: 65, profit: 35 });
  const snapshottedDefaultRules = await db._helpers.all(db, `SELECT rd.code FROM rule_versions rv JOIN rule_definitions rd ON rd.id = rv.rule_id
    WHERE rv.id IN (${taskSnapshot.ruleVersions.map(() => '?').join(',')})`, taskSnapshot.ruleVersions);
  assert.deepEqual(new Set(snapshottedDefaultRules.map(rule => rule.code)), new Set([
    'DEFAULT_YOY_CHANGE', 'DEFAULT_MOM_CHANGE', 'DEFAULT_COMPLETION_BAND', 'DEFAULT_NEGATIVE_REVENUE', 'DEFAULT_ADJUSTMENT_PRESENT'
  ]), 'task snapshots pin the exact published versions of all default anomaly rules');
  assert.equal(taskSnapshot.targets.length, 13);
  const businessRooms = await db._helpers.all(db, 'SELECT * FROM collaboration_rooms WHERE task_id IN (?, ?) ORDER BY task_id', [activatedTasks[0].id, activatedTasks[1].id]);
  assert.equal(businessRooms.length, 2);
  const collaborationRooms = await db._helpers.all(db.collaborationDb, 'SELECT * FROM collaboration_rooms WHERE task_id IN (?, ?) ORDER BY task_id', [activatedTasks[0].id, activatedTasks[1].id]);
  assert.equal(collaborationRooms.length, 2);
  const initialSnapshot = await db._helpers.get(db.collaborationDb, 'SELECT snapshot_json FROM collaboration_snapshots WHERE room_id = ? AND version = 0', [collaborationRooms[0].id]);
  assert.ok(JSON.parse(initialSnapshot.snapshot_json).sheets.length > 0);
  const roomInfo = await request(`/collaboration/tasks/${activatedTasks[0].id}/room`, { token: login.payload.token });
  assert.equal(roomInfo.response.status, 200);
  assert.equal(roomInfo.payload.room.roomKey, businessRooms[0].collaboration_room_key);
  assert.equal(roomInfo.payload.room.snapshotReference, `${businessRooms[0].collaboration_room_key}@0`);
  assert.equal((await request(`/collaboration/tasks/${activatedTasks[0].id}/room`, { token: designerLogin.payload.token })).response.status, 403);
  assert.equal((await request(`/collaboration/tasks/${activatedTasks[0].id}/history`, { token: designerLogin.payload.token })).response.status, 403);
  assert.equal((await request(`/collaboration/tasks/${activatedTasks[0].id}/room/lifecycle`, { method: 'POST', token: login.payload.token,
    body: { status: 'closed' } })).response.status, 400);
  const freezeRoom = await request(`/collaboration/tasks/${activatedTasks[0].id}/room/lifecycle`, { method: 'POST', token: login.payload.token,
    body: { status: 'frozen' } });
  assert.equal(freezeRoom.response.status, 200);
  assert.equal(freezeRoom.payload.status, 'frozen');
  const closeRoom = await request(`/collaboration/tasks/${activatedTasks[0].id}/room/lifecycle`, { method: 'POST', token: login.payload.token,
    body: { status: 'closed', reason: 'integration closeout' } });
  assert.equal(closeRoom.response.status, 200);
  assert.equal((await db._helpers.get(db, 'SELECT room_status, closed_at FROM collaboration_rooms WHERE id = ?', [businessRooms[0].id])).room_status, 'closed');
  assert.equal((await db._helpers.get(db.collaborationDb, 'SELECT room_status FROM collaboration_rooms WHERE id = ?', [collaborationRooms[0].id])).room_status, 'closed');
  assert.equal((await request(`/collaboration/tasks/${activatedTasks[0].id}/history`, { token: login.payload.token })).response.status, 200);
  await db._helpers.run(db, `INSERT INTO user_roles (user_id, role_code, organization_id) VALUES
    (?, 'subsidiary_submitter', ?), (?, 'department_reviewer', ?), (?, 'subsidiary_submitter', ?), (?, 'department_reviewer', ?)`,
  [registeredUser.id, orgA.payload.organizationId, registeredUser.id, orgA.payload.organizationId,
    registeredUser.id, orgB.payload.organizationId, registeredUser.id, orgB.payload.organizationId]);
  const makeSubmittedRevision = async (task, sequence) => {
    fs.mkdirSync(process.env.COST_REPORT_ARTIFACT_DIR, { recursive: true });
    const workbookPath = path.join(process.env.COST_REPORT_ARTIFACT_DIR, `revision-seed-${sequence}.ssjson`);
    const workbookJson = JSON.stringify({ version: '19.1.4', sheets: [{ name: `上一修订${sequence}`, data: { dataTable: { 0: { 0: { value: `保留内容${sequence}` } } } } }] });
    fs.writeFileSync(workbookPath, workbookJson, 'utf8');
    const revision = await db._helpers.run(db, `INSERT INTO business_revisions
      (task_id, revision_number, revision_status, submitted_by, submitted_at, collaboration_room_id, collaboration_version)
      VALUES (?, 1, 'submitted', ?, CURRENT_TIMESTAMP, ?, 0)`, [task.id, registeredUser.id, task.room_id]);
    const artifact = await db._helpers.run(db, `INSERT INTO official_artifacts
      (revision_id, artifact_type, storage_key, sha256, byte_size) VALUES (?, 'spreadjs_workbook_json', ?, 'test-hash', ?)`,
    [revision.lastID, workbookPath, Buffer.byteLength(workbookJson)]);
    await db._helpers.run(db, 'UPDATE business_revisions SET workbook_artifact_id = ? WHERE id = ?', [artifact.lastID, revision.lastID]);
    await db._helpers.run(db, `UPDATE report_tasks SET current_revision_id = ?, task_status = 'submitted' WHERE id = ?`, [revision.lastID, task.id]);
    await db._helpers.run(db, `UPDATE collaboration_rooms SET room_status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?`, [task.room_id]);
    await db._helpers.run(db.collaborationDb, `UPDATE collaboration_rooms SET room_status = 'closed' WHERE room_key = ?`, [task.collaboration_room_key]);
    return { revisionId: revision.lastID, workbookJson };
  };
  const lifecycleTaskA = { ...activatedTasks[0], room_id: businessRooms[0].id, collaboration_room_key: businessRooms[0].collaboration_room_key };
  await makeSubmittedRevision(lifecycleTaskA, 'race');
  const submittedDutyReassignment = await request(`/task-operations/tasks/${lifecycleTaskA.id}/reassign`, {
    method: 'POST', token: login.payload.token,
    body: { responsibility: 'filler', userId: taskFiller.payload.userId, reason: '提交后填报职责已完成' }
  });
  assert.equal(submittedDutyReassignment.response.status, 409);
  const competingLifecycleRequests = await Promise.all([
    request(`/collaboration/tasks/${lifecycleTaskA.id}/withdraw`, { method: 'POST', token: login.payload.token, body: { reason: '并发撤回测试' } }),
    request(`/collaboration/tasks/${lifecycleTaskA.id}/review-opinions`, { method: 'POST', token: login.payload.token,
      body: { reviewItemKey: 'monthly:submission', expectedVersion: 0, disposition: 'comment', opinion: '并发首次审核意见' } })
  ]);
  assert.deepEqual(competingLifecycleRequests.map(item => item.response.status).sort(), [200, 409],
    'the first review opinion and withdrawal serialize so exactly one wins');
  const raceTask = await db._helpers.get(db, 'SELECT task_status, current_revision_id FROM report_tasks WHERE id = ?', [lifecycleTaskA.id]);
  const raceEventCount = await db._helpers.get(db, `SELECT COUNT(*) AS count FROM report_task_events
    WHERE task_id = ? AND event_type IN ('withdrawn','reviewing')`, [lifecycleTaskA.id]);
  assert.equal(raceEventCount.count, 1);
  if (competingLifecycleRequests[0].response.status === 200) assert.equal(raceTask.task_status, 'draft');
  else assert.equal(raceTask.task_status, 'reviewing');

  const lifecycleTaskB = { ...activatedTasks[1], room_id: businessRooms[1].id, collaboration_room_key: businessRooms[1].collaboration_room_key };
  const previousRevision = await makeSubmittedRevision(lifecycleTaskB, 'return');
  const acceptedAnomaly = await db._helpers.run(db, `INSERT INTO anomaly_snapshots
    (revision_id, severity, message, explanation, warning_key, rule_code, field_code, triggering_value_json,
      comparison_value_json, threshold_json, color_classification)
    VALUES (?, 'warning', '较上年同期变化超过阈值。', '已核对，属于一次性业务结算。', 'rule-a:FIELD_TEST_DECIMAL',
      'RULE_A', 'FIELD_TEST_DECIMAL', '130', '100', '{"absoluteChangePercent":30}', 'warning')`, [previousRevision.revisionId]);
  const correctionAnomaly = await db._helpers.run(db, `INSERT INTO anomaly_snapshots
    (revision_id, severity, message, explanation, warning_key, rule_code, field_code, triggering_value_json,
      comparison_value_json, threshold_json, color_classification)
    VALUES (?, 'warning', '目标完成率超出范围。', '已核对目标口径。', 'rule-b:FIELD_TEST_DECIMAL',
      'RULE_B', 'FIELD_TEST_DECIMAL', '140', '100', '{"maximumPercent":130}', 'warning')`, [previousRevision.revisionId]);
  const anomalyRoom = await request(`/collaboration/tasks/${lifecycleTaskB.id}/room`, { token: login.payload.token });
  assert.equal(anomalyRoom.response.status, 200);
  assert.equal(anomalyRoom.payload.anomalies.length, 2);
  assert.equal(anomalyRoom.payload.anomalies[0].explanation, '已核对，属于一次性业务结算。');
  const accepted = await request(`/collaboration/tasks/${lifecycleTaskB.id}/anomalies/${acceptedAnomaly.lastID}/disposition`, {
    method: 'POST', token: login.payload.token, body: { disposition: 'accepted' }
  });
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.payload));
  assert.equal((await db._helpers.get(db, 'SELECT disposition FROM anomaly_snapshots WHERE id = ?', [acceptedAnomaly.lastID])).disposition, 'accepted');
  const correctionRequested = await request(`/collaboration/tasks/${lifecycleTaskB.id}/anomalies/${correctionAnomaly.lastID}/disposition`, {
    method: 'POST', token: login.payload.token, body: { disposition: 'correction_requested' }
  });
  assert.equal(correctionRequested.response.status, 200, JSON.stringify(correctionRequested.payload));
  assert.equal((await db._helpers.get(db, 'SELECT disposition FROM anomaly_snapshots WHERE id = ?', [correctionAnomaly.lastID])).disposition, 'correction_requested');
  const returnWithoutReason = await request(`/collaboration/tasks/${lifecycleTaskB.id}/review-opinions`, { method: 'POST', token: login.payload.token,
    body: { disposition: 'return', opinion: '', remediationDeadline: '2026-11-05T23:59:00+08:00' } });
  assert.equal(returnWithoutReason.response.status, 400);
  const returnWithoutDeadline = await request(`/collaboration/tasks/${lifecycleTaskB.id}/review-opinions`, { method: 'POST', token: login.payload.token,
    body: { disposition: 'return', opinion: '请修正并说明差异', remediationDeadline: '' } });
  assert.equal(returnWithoutDeadline.response.status, 400);
  const returnWithoutTimezone = await request(`/collaboration/tasks/${lifecycleTaskB.id}/review-opinions`, { method: 'POST', token: login.payload.token,
    body: { disposition: 'return', opinion: '请修正并说明差异', remediationDeadline: '2026-11-05T23:59:00' } });
  assert.equal(returnWithoutTimezone.response.status, 400);
  const returned = await request(`/collaboration/tasks/${lifecycleTaskB.id}/review-opinions`, { method: 'POST', token: login.payload.token,
    body: { reviewItemKey: 'monthly:submission', expectedVersion: 0, disposition: 'return', opinion: '请修正并说明差异', remediationDeadline: '2026-11-05T15:59:00Z' } });
  assert.equal(returned.response.status, 200, JSON.stringify(returned.payload));
  assert.equal(returned.payload.status, 'draft');
  assert.equal((await db._helpers.get(db, `SELECT revision_status, source_revision_id FROM business_revisions WHERE id = ?`, [returned.payload.revisionId])).source_revision_id,
  previousRevision.revisionId);
  const returnedRoom = await request(`/collaboration/tasks/${lifecycleTaskB.id}/room`, { token: login.payload.token });
  assert.equal(returnedRoom.payload.room.status, 'open');
  assert.equal(returnedRoom.payload.room.revisionNumber, 2);
  assert.equal(returnedRoom.payload.timeline.some(event => event.type === 'returned'), true);
  assert.equal(returnedRoom.payload.timeline.some(event => event.type === 'draft_created'), true);
  assert.equal(returnedRoom.payload.seedWorkbook?.sheets?.[0]?.name, '上一修订return', JSON.stringify(returnedRoom.payload.seedWorkbook));
  const oldRoomStatus = await db._helpers.get(db, 'SELECT room_status FROM collaboration_rooms WHERE id = ?', [businessRooms[1].id]);
  assert.equal(oldRoomStatus.room_status, 'closed');
  assert.equal((await db._helpers.get(db.collaborationDb, 'SELECT room_status FROM collaboration_rooms WHERE room_key = ?', [returned.payload.roomKey])).room_status, 'open');
  assert.equal(returnedRoom.payload.timeline.find(event => event.type === 'returned').remediationDeadline, '2026-11-05T23:59:00+08:00');
  await db._helpers.run(db, `INSERT OR IGNORE INTO task_indicators
    (task_id, indicator_code, display_name, indicator_type, sort_order)
    VALUES (?, 'API_EVIDENCE', 'API evidence indicator', 'quantitative', 1)`, [lifecycleTaskB.id]);
  const taskLevelUpload = await uploadRequest(`/collaboration/tasks/${lifecycleTaskB.id}/attachments`, login.payload.token,
    'task-evidence.pdf', '%PDF-1.7\nTask evidence', '');
  assert.equal(taskLevelUpload.response.status, 201, JSON.stringify(taskLevelUpload.payload));
  assert.equal(taskLevelUpload.payload.attachment.indicatorCode, null);
  const unsupportedFile = await uploadRequest(`/collaboration/tasks/${lifecycleTaskB.id}/attachments`, login.payload.token,
    'program.exe', 'MZ executable', 'API_EVIDENCE', 'application/octet-stream');
  assert.equal(unsupportedFile.response.status, 400);
  const macroFile = await uploadRequest(`/collaboration/tasks/${lifecycleTaskB.id}/attachments`, login.payload.token,
    'macro.xlsm', 'macro workbook', 'API_EVIDENCE', 'application/vnd.ms-excel.sheet.macroEnabled.12');
  assert.equal(macroFile.response.status, 400);
  for (let index = 1; index <= 10; index += 1) {
    const uploaded = await uploadRequest(`/collaboration/tasks/${lifecycleTaskB.id}/attachments`, login.payload.token,
      `api-evidence-${index}.pdf`, `%PDF-1.7\nAPI ${index}`, 'API_EVIDENCE');
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  }
  const evidenceActor = (await request('/auth/me', { token: login.payload.token })).payload.user;
  const evidenceService = require('../src/services/evidenceAttachments');
  const apiEvidence = await evidenceService.listAttachments(lifecycleTaskB, evidenceActor);
  assert.equal(apiEvidence.length, 11);
  const firstApiEvidence = apiEvidence.find(item => item.indicatorCode === 'API_EVIDENCE');
  assert.ok(firstApiEvidence && firstApiEvidence.revisionId === returned.payload.revisionId);
  const authorizedEvidenceDownload = await fetch(`${await baseUrlReady}/collaboration/tasks/${lifecycleTaskB.id}/attachments/${firstApiEvidence.id}/download`, {
    headers: { Authorization: `Bearer ${login.payload.token}` }
  });
  assert.equal(authorizedEvidenceDownload.status, 200);
  assert.equal(await authorizedEvidenceDownload.text(), '%PDF-1.7\nAPI 1');
  const deniedEvidenceDownload = await fetch(`${await baseUrlReady}/collaboration/tasks/${lifecycleTaskB.id}/attachments/${firstApiEvidence.id}/download`, {
    headers: { Authorization: `Bearer ${designerLogin.payload.token}` }
  });
  assert.equal(deniedEvidenceDownload.status, 403);
  const overLimitEvidence = await uploadRequest(`/collaboration/tasks/${lifecycleTaskB.id}/attachments`, login.payload.token,
    'api-evidence-11.pdf', '%PDF-1.7\nAPI 11', 'API_EVIDENCE');
  assert.equal(overLimitEvidence.response.status, 409);
  const deniedCancel = await request(`/task-operations/tasks/${lifecycleTaskB.id}/cancel`, {
    method: 'POST', token: login.payload.token, body: { reason: '' }
  });
  assert.equal(deniedCancel.response.status, 400);
  await db._helpers.run(db, "UPDATE report_tasks SET deadline_at='2026-09-01T00:00:00Z' WHERE id=?", [lifecycleTaskB.id]);
  const overdueProgress = await request('/task-operations/progress', { token: login.payload.token });
  assert.equal(overdueProgress.payload.tasks.find(item => item.id === lifecycleTaskB.id).overdue, true);
  const cancelledTask = await request(`/task-operations/tasks/${lifecycleTaskB.id}/cancel`, {
    method: 'POST', token: login.payload.token, body: { reason: '该期不再要求此公司填报' }
  });
  assert.equal(cancelledTask.response.status, 200, JSON.stringify(cancelledTask.payload));
  const cancelledProgress = await request('/task-operations/progress', { token: login.payload.token });
  const cancelledRow = cancelledProgress.payload.tasks.find(item => item.id === lifecycleTaskB.id);
  assert.equal(cancelledRow.status, 'cancelled');
  assert.equal(cancelledRow.cancellationReason, '该期不再要求此公司填报');
  assert.equal((await request(`/task-operations/tasks/${lifecycleTaskB.id}/extend-deadline`, { method: 'POST', token: login.payload.token,
    body: { deadlineAt: '2026-12-01T23:59:59+08:00', reason: '不能修改' } })).response.status, 409);

  await db._helpers.run(db, `INSERT OR IGNORE INTO user_roles (user_id, role_code, organization_id)
    VALUES (?, 'report_finalizer', ?)`, [registeredUser.id, orgA.payload.organizationId]);
  const olderLifecycleRevision = await db._helpers.get(db, `SELECT id FROM business_revisions
    WHERE task_id = ? ORDER BY revision_number DESC LIMIT 1`, [lifecycleTaskA.id]);
  await db._helpers.run(db, `UPDATE business_revisions SET revision_status = 'finalized', finalized_at = CURRENT_TIMESTAMP,
    is_current_effective = 1 WHERE id = ?`, [olderLifecycleRevision.id]);
  const finalRoom = await db._helpers.get(db, `SELECT id FROM collaboration_rooms WHERE task_id = ? ORDER BY revision_number DESC LIMIT 1`, [lifecycleTaskA.id]);
  const nextFinalRevisionNumber = Number((await db._helpers.get(db,
    'SELECT COALESCE(MAX(revision_number), 0) AS n FROM business_revisions WHERE task_id = ?', [lifecycleTaskA.id])).n) + 1;
  const finalWorkbookPath = path.join(process.env.COST_REPORT_ARTIFACT_DIR, 'monthly-review-static-workbook.ssjson');
  const finalWorkbookJson = JSON.stringify({ version: '19.1.4', sheets: [{
    name: '月报提交快照', data: { dataTable: { 0: { 0: { value: '已提交内容' } } } }
  }] });
  fs.writeFileSync(finalWorkbookPath, finalWorkbookJson, 'utf8');
  const finalRevision = await db._helpers.run(db, `INSERT INTO business_revisions
    (task_id, revision_number, revision_status, submitted_by, submitted_at, collaboration_room_id, collaboration_version)
    VALUES (?, ?, 'submitted', ?, CURRENT_TIMESTAMP, ?, 0)`,
  [lifecycleTaskA.id, nextFinalRevisionNumber, registeredUser.id, finalRoom.id]);
  const finalWorkbookArtifact = await db._helpers.run(db, `INSERT INTO official_artifacts
    (revision_id, artifact_type, storage_key, sha256, byte_size) VALUES (?, 'spreadjs_workbook_json', ?, 'final-test-hash', ?)` ,
  [finalRevision.lastID, finalWorkbookPath, Buffer.byteLength(finalWorkbookJson)]);
  await db._helpers.run(db, 'UPDATE business_revisions SET workbook_artifact_id = ? WHERE id = ?', [finalWorkbookArtifact.lastID, finalRevision.lastID]);
  await db._helpers.run(db, `UPDATE report_tasks SET current_revision_id = ?, task_status = 'submitted' WHERE id = ?`, [finalRevision.lastID, lifecycleTaskA.id]);
  const pendingFinalization = await finalizeRequest(`/collaboration/tasks/${lifecycleTaskA.id}/finalize`, login.payload.token);
  assert.equal(pendingFinalization.response.status, 409, JSON.stringify(pendingFinalization.payload));
  const unauthorizedFinalization = await finalizeRequest(`/collaboration/tasks/${lifecycleTaskA.id}/finalize`, designerLogin.payload.token);
  assert.equal(unauthorizedFinalization.response.status, 403, JSON.stringify(unauthorizedFinalization.payload));
  const staticReview = await request(`/collaboration/tasks/${lifecycleTaskA.id}/review`, { token: login.payload.token });
  assert.equal(staticReview.response.status, 200, JSON.stringify(staticReview.payload));
  assert.equal(staticReview.payload.workbook.sheets[0].name, '月报提交快照');
  assert.equal(Object.hasOwn(staticReview.payload, 'room'), false, 'static review returns the stored workbook without opening a Collaboration Room');
  assert.equal((await request(`/collaboration/tasks/${lifecycleTaskA.id}/review`, { token: designerLogin.payload.token })).response.status, 403);
  assert.ok((await request('/collaboration/review-tasks', { token: login.payload.token })).payload.tasks.some(task => task.id === lifecycleTaskA.id));
  const reviewOpinion = await request(`/collaboration/tasks/${lifecycleTaskA.id}/review-opinions`, { method: 'POST', token: login.payload.token,
    body: { reviewItemKey: 'monthly:submission', expectedVersion: 0, disposition: 'comment', opinion: '数据与提交口径一致。' } });
  assert.equal(reviewOpinion.response.status, 200, JSON.stringify(reviewOpinion.payload));
  assert.equal(reviewOpinion.payload.reviewVersion, 1);
  assert.equal((await db._helpers.get(db, 'SELECT task_status FROM report_tasks WHERE id = ?', [lifecycleTaskA.id])).task_status, 'reviewing');
  const staleOpinion = await request(`/collaboration/tasks/${lifecycleTaskA.id}/review-opinions`, { method: 'POST', token: login.payload.token,
    body: { reviewItemKey: 'monthly:submission', expectedVersion: 0, disposition: 'accept', opinion: '过期版本意见' } });
  assert.equal(staleOpinion.response.status, 409);
  const concurrentOpinionRequests = await Promise.all([
    request(`/collaboration/tasks/${lifecycleTaskA.id}/review-opinions`, { method: 'POST', token: login.payload.token,
      body: { reviewItemKey: 'monthly:submission', expectedVersion: 1, disposition: 'accept', opinion: '并发审核意见 A' } }),
    request(`/collaboration/tasks/${lifecycleTaskA.id}/review-opinions`, { method: 'POST', token: login.payload.token,
      body: { reviewItemKey: 'monthly:submission', expectedVersion: 1, disposition: 'comment', opinion: '并发审核意见 B' } })
  ]);
  assert.deepEqual(concurrentOpinionRequests.map(item => item.response.status).sort(), [200, 409],
    'concurrent opinions against one review version allow exactly one update');
  assert.equal(fs.readFileSync(finalWorkbookPath, 'utf8'), finalWorkbookJson,
    'saving review opinions leaves the submitted workbook snapshot byte-for-byte unchanged');
  const reviewDepartment = await db._helpers.run(db, `INSERT INTO organizations (code, name, organization_type)
    VALUES ('ACCEPTANCE_REVIEW_DEPT', '验收审核部门', 'department')`);
  const departmentReviewer = await db._helpers.run(db, `INSERT INTO users
    (username, password, name, organization_id) VALUES (?, ?, '并行审核员', ?)` ,
  ['acceptance-department-reviewer', await bcrypt.hash('department-review-password', 4), reviewDepartment.lastID]);
  const targetPackage = await db._helpers.get(db, 'SELECT package_id, organization_id FROM report_tasks WHERE id = ?', [lifecycleTaskA.id]);
  await db._helpers.run(db, `INSERT INTO user_roles (user_id, role_code, organization_id, granted_by)
    VALUES (?, 'department_reviewer', ?, ?)`, [departmentReviewer.lastID, reviewDepartment.lastID, registeredUser.id]);
  await db._helpers.run(db, `INSERT INTO package_assignments
    (package_id, organization_id, responsibility, user_id, assigned_by, reason) VALUES (?, ?, 'department_reviewer', ?, ?, '并行审核验收')`,
  [targetPackage.package_id, targetPackage.organization_id, departmentReviewer.lastID, registeredUser.id]);
  const reviewerTaskConfiguration = JSON.parse((await db._helpers.get(db,
    'SELECT configuration_snapshot_json FROM report_tasks WHERE id=?', [lifecycleTaskA.id])).configuration_snapshot_json);
  reviewerTaskConfiguration.assignments.push({ responsibility: 'department_reviewer', userId: departmentReviewer.lastID, reason: '并行审核验收' });
  await db._helpers.run(db, 'UPDATE report_tasks SET configuration_snapshot_json=? WHERE id=?',
    [JSON.stringify(reviewerTaskConfiguration), lifecycleTaskA.id]);
  const departmentReviewerLogin = await request('/auth/login', { method: 'POST', body: {
    username: 'acceptance-department-reviewer', password: 'department-review-password'
  } });
  assert.equal(departmentReviewerLogin.response.status, 200, JSON.stringify(departmentReviewerLogin.payload));
  await db._helpers.run(db, `INSERT OR IGNORE INTO task_indicators
    (task_id, indicator_code, display_name, indicator_type, field_definition_id, configuration_json)
    VALUES (?, 'ADJUSTMENT_COST', '成本调整指标', 'quantitative', ?, ?)`,
  [lifecycleTaskA.id, approvedTestField.id, JSON.stringify({ ownerOrganizationId: reviewDepartment.lastID })]);
  const parallelReview = await request(`/collaboration/tasks/${lifecycleTaskA.id}/review`, { token: departmentReviewerLogin.payload.token });
  assert.equal(parallelReview.response.status, 200, JSON.stringify(parallelReview.payload));
  assert.equal(parallelReview.payload.reviewDepartmentCode, 'ACCEPTANCE_REVIEW_DEPT');
  assert.equal(parallelReview.payload.myOpinion, null);
  const departmentOpinion = await request(`/collaboration/tasks/${lifecycleTaskA.id}/review-opinions`, {
    method: 'POST', token: departmentReviewerLogin.payload.token,
    body: { reviewItemKey: 'monthly:submission', expectedVersion: 0, disposition: 'accept', opinion: '审核部门独立通过。' }
  });
  assert.equal(departmentOpinion.response.status, 200, JSON.stringify(departmentOpinion.payload));
  assert.equal(departmentOpinion.payload.departmentCode, 'ACCEPTANCE_REVIEW_DEPT');
  const pendingAnomaly = await db._helpers.run(db, `INSERT INTO anomaly_snapshots
    (revision_id, severity, message, explanation, warning_key, rule_code, field_code, color_classification)
    VALUES (?, 'warning', '需要处置的预警', '业务已说明。', 'pending-final-gate', 'FINAL_GATE', 'FIELD_TEST_DECIMAL', 'warning')`, [finalRevision.lastID]);
  const anomalyBlockedFinalization = await finalizeRequest(`/collaboration/tasks/${lifecycleTaskA.id}/finalize`, login.payload.token);
  assert.equal(anomalyBlockedFinalization.response.status, 409, JSON.stringify(anomalyBlockedFinalization.payload));
  const acceptedFinalAnomaly = await request(`/collaboration/tasks/${lifecycleTaskA.id}/anomalies/${pendingAnomaly.lastID}/disposition`, {
    method: 'POST', token: login.payload.token, body: { disposition: 'accepted' }
  });
  assert.equal(acceptedFinalAnomaly.response.status, 200, JSON.stringify(acceptedFinalAnomaly.payload));
  const finalized = await finalizeRequest(`/collaboration/tasks/${lifecycleTaskA.id}/finalize`, login.payload.token);
  assert.equal(finalized.response.status, 200, JSON.stringify(finalized.payload));
  const finalizedFillingView = await request(`/collaboration/tasks/${lifecycleTaskA.id}/room`, { token: login.payload.token });
  assert.equal(finalizedFillingView.response.status, 200, JSON.stringify(finalizedFillingView.payload));
  assert.equal(finalizedFillingView.payload.task.status, 'finalized');
  assert.deepEqual(finalizedFillingView.payload.submittedWorkbook, JSON.parse(finalWorkbookJson),
    'a finalized filling task retains its submitted snapshot for static display without joining its closed room');
  assert.equal(finalized.payload.status, 'finalized');
  assert.ok(finalized.payload.checkpoint?.checkpointId, 'monthly finalization returns its recoverable checkpoint reference');
  assert.equal(finalized.payload.artifacts.length, 5);
  const finalState = await db._helpers.get(db, `SELECT t.task_status, r.revision_status, r.is_current_effective,
    r.finalized_at FROM report_tasks t JOIN business_revisions r ON r.id = t.current_revision_id WHERE t.id = ?`, [lifecycleTaskA.id]);
  assert.deepEqual([finalState.task_status, finalState.revision_status, finalState.is_current_effective], ['finalized', 'finalized', 1]);
  assert.ok(finalState.finalized_at);
  const historicRevisions = await request(`/collaboration/tasks/${lifecycleTaskA.id}/revisions`, { token: login.payload.token });
  assert.equal(historicRevisions.response.status, 200, JSON.stringify(historicRevisions.payload));
  assert.ok(historicRevisions.payload.revisions.some(revision => revision.id === olderLifecycleRevision.id));
  assert.equal(historicRevisions.payload.revisions.filter(revision => revision.isCurrentEffective).length, 1);
  const historicXlsx = await fetch(`${await baseUrlReady}/collaboration/tasks/${lifecycleTaskA.id}/revisions/${finalRevision.lastID}/artifacts/finalized_xlsx`, {
    headers: { Authorization: `Bearer ${login.payload.token}` }
  });
  assert.equal(historicXlsx.status, 200);
  assert.match(historicXlsx.headers.get('x-artifact-sha256'), /^[a-f0-9]{64}$/);
  assert.equal((await db._helpers.get(db, `SELECT COUNT(*) AS count FROM official_artifacts WHERE revision_id = ?
    AND artifact_type IN ('finalized_workbook_json','finalized_xlsx','finalized_pdf','structured_data_json','version_manifest_json')`,
  [finalRevision.lastID])).count, 5);
  const manifestResponse = await fetch(`${await baseUrlReady}/collaboration/tasks/${lifecycleTaskA.id}/revisions/${finalRevision.lastID}/artifacts/version_manifest_json`, {
    headers: { Authorization: `Bearer ${login.payload.token}` }
  });
  assert.equal(manifestResponse.status, 200);
  const versionManifest = await manifestResponse.json();
  assert.equal(versionManifest.templateVersionId, templateV3.payload.versionId);
  assert.ok(versionManifest.configurationVersion);
  assert.ok(versionManifest.calculationVersion.engine);
  assert.ok(versionManifest.requiredReviewDepartments.includes('ACCEPTANCE_REVIEW_DEPT'));

  await db._helpers.run(db, `INSERT INTO business_values
    (revision_id, task_id, record_key, field_definition_id, value_type, decimal_value, entered_by)
    VALUES (?, ?, '', ?, 'decimal', '100', ?)`, [finalRevision.lastID, lifecycleTaskA.id, approvedTestField.id, registeredUser.id]);
  const adjustmentFields = await request(`/collaboration/tasks/${lifecycleTaskA.id}/adjustment-fields`, { token: login.payload.token });
  assert.equal(adjustmentFields.response.status, 200, JSON.stringify(adjustmentFields.payload));
  assert.ok(adjustmentFields.payload.fields.some(field => field.fieldCode === approvedTestField.code));
  const adjustmentStarted = await request(`/collaboration/tasks/${lifecycleTaskA.id}/adjustments`, { method: 'POST', token: login.payload.token,
    body: { fieldCodes: [approvedTestField.code], reason: '更正经核对发现的月度成本数据' } });
  assert.equal(adjustmentStarted.response.status, 201, JSON.stringify(adjustmentStarted.payload));
  assert.equal(adjustmentStarted.payload.status, 'draft');
  assert.deepEqual(adjustmentStarted.payload.requiredDepartments, ['ACCEPTANCE_REVIEW_DEPT'],
    'adjustments only require departments responsible for affected indicators');
  assert.equal((await db._helpers.get(db, 'SELECT is_current_effective FROM business_revisions WHERE id = ?', [finalRevision.lastID])).is_current_effective, 1,
    'the old finalized revision remains effective while an adjustment draft is being edited');
  const proposedWorkbookPath = path.join(process.env.COST_REPORT_ARTIFACT_DIR, 'monthly-adjustment-proposed.ssjson');
  const proposedWorkbookJson = JSON.stringify({ version: '19.1.4', sheets: [{ name: '月报调整草稿', data: { dataTable: {} } }] });
  fs.writeFileSync(proposedWorkbookPath, proposedWorkbookJson, 'utf8');
  const adjustmentWorkbookArtifact = await db._helpers.run(db, `INSERT INTO official_artifacts
    (revision_id, artifact_type, storage_key, sha256, byte_size) VALUES (?, 'spreadjs_workbook_json', ?, 'adjustment-test-hash', ?)` ,
  [adjustmentStarted.payload.revisionId, proposedWorkbookPath, Buffer.byteLength(proposedWorkbookJson)]);
  await db._helpers.run(db, `UPDATE business_revisions SET revision_status='submitted', submitted_by=?, submitted_at=CURRENT_TIMESTAMP,
    workbook_artifact_id=?, collaboration_version=0 WHERE id=?`, [registeredUser.id, adjustmentWorkbookArtifact.lastID, adjustmentStarted.payload.revisionId]);
  await db._helpers.run(db, `INSERT INTO business_values
    (revision_id, task_id, record_key, field_definition_id, value_type, decimal_value, entered_by)
    VALUES (?, ?, '', ?, 'decimal', '125', ?)`, [adjustmentStarted.payload.revisionId, lifecycleTaskA.id, approvedTestField.id, registeredUser.id]);
  const adjustmentSubmission = await require('../src/services/monthlyAdjustments').markAdjustmentSubmitted(db,
    { id: lifecycleTaskA.id }, adjustmentStarted.payload.revisionId);
  assert.deepEqual(adjustmentSubmission.changedFields, [approvedTestField.code]);
  assert.equal(adjustmentSubmission.changedValues[0].before.decimal, '100');
  assert.equal(adjustmentSubmission.changedValues[0].after.decimal, '125');
  await db._helpers.run(db, `UPDATE report_tasks SET task_status='submitted' WHERE id=?`, [lifecycleTaskA.id]);
  const adjustmentDepartmentOpinion = await request(`/collaboration/tasks/${lifecycleTaskA.id}/review-opinions`, { method: 'POST', token: departmentReviewerLogin.payload.token,
    body: { reviewItemKey: 'monthly:submission', expectedVersion: 0, disposition: 'accept', opinion: '复核调整字段及其影响。' } });
  assert.equal(adjustmentDepartmentOpinion.response.status, 200, JSON.stringify(adjustmentDepartmentOpinion.payload));
  const adjustmentReview = await db._helpers.get(db, 'SELECT status, changed_fields_json FROM adjustment_requests WHERE id=?', [adjustmentStarted.payload.adjustmentRequestId]);
  assert.equal(adjustmentReview.status, 'management_approval');
  assert.deepEqual(JSON.parse(adjustmentReview.changed_fields_json), [approvedTestField.code]);
  const lockedAdjustmentReview = await request(`/collaboration/tasks/${lifecycleTaskA.id}/review-opinions`, { method: 'POST', token: departmentReviewerLogin.payload.token,
    body: { reviewItemKey: 'monthly:submission', expectedVersion: 1, disposition: 'return', opinion: '管理审批开始后不应允许退回。',
      remediationDeadline: '2026-11-05T23:59:00+08:00' } });
  assert.equal(lockedAdjustmentReview.response.status, 409, JSON.stringify(lockedAdjustmentReview.payload));
  const adjustmentApproved = await request(`/collaboration/tasks/${lifecycleTaskA.id}/adjustment-decision`, { method: 'POST', token: login.payload.token,
    body: { decision: 'approve', note: '批准按更正值更新本期定稿。' } });
  assert.equal(adjustmentApproved.response.status, 200, JSON.stringify(adjustmentApproved.payload));
  assert.equal((await db._helpers.get(db, 'SELECT is_current_effective FROM business_revisions WHERE id=?', [finalRevision.lastID])).is_current_effective, 1,
    'management approval alone does not replace the current effective revision');
  const appliedAdjustment = await finalizeRequest(`/collaboration/tasks/${lifecycleTaskA.id}/finalize`, login.payload.token);
  assert.equal(appliedAdjustment.response.status, 200, JSON.stringify(appliedAdjustment.payload));
  const appliedState = await db._helpers.get(db, `SELECT a.status, a.applied_at, old.is_current_effective AS old_effective,
    current.is_current_effective AS current_effective FROM adjustment_requests a
    JOIN business_revisions old ON old.id=a.source_revision_id
    JOIN business_revisions current ON current.id=a.proposed_revision_id WHERE a.id=?`, [adjustmentStarted.payload.adjustmentRequestId]);
  assert.deepEqual([appliedState.status, appliedState.old_effective, appliedState.current_effective], ['applied', 0, 1]);
  assert.ok(appliedState.applied_at);
  const rejectedAdjustment = await request(`/collaboration/tasks/${lifecycleTaskA.id}/adjustments`, { method: 'POST', token: login.payload.token,
    body: { fieldCodes: [approvedTestField.code], reason: '复核另一项申报字段' } });
  assert.equal(rejectedAdjustment.response.status, 201, JSON.stringify(rejectedAdjustment.payload));
  const rejectedWorkbookPath = path.join(process.env.COST_REPORT_ARTIFACT_DIR, 'monthly-adjustment-rejected.ssjson');
  fs.writeFileSync(rejectedWorkbookPath, proposedWorkbookJson, 'utf8');
  const rejectedWorkbookArtifact = await db._helpers.run(db, `INSERT INTO official_artifacts
    (revision_id, artifact_type, storage_key, sha256, byte_size) VALUES (?, 'spreadjs_workbook_json', ?, 'rejected-adjustment-hash', ?)` ,
  [rejectedAdjustment.payload.revisionId, rejectedWorkbookPath, Buffer.byteLength(proposedWorkbookJson)]);
  await db._helpers.run(db, `UPDATE business_revisions SET revision_status='submitted', submitted_by=?, submitted_at=CURRENT_TIMESTAMP,
    workbook_artifact_id=?, collaboration_version=0 WHERE id=?`, [registeredUser.id, rejectedWorkbookArtifact.lastID, rejectedAdjustment.payload.revisionId]);
  await db._helpers.run(db, `INSERT INTO business_values
    (revision_id, task_id, record_key, field_definition_id, value_type, decimal_value, entered_by)
    VALUES (?, ?, '', ?, 'decimal', '150', ?)`, [rejectedAdjustment.payload.revisionId, lifecycleTaskA.id, approvedTestField.id, registeredUser.id]);
  await require('../src/services/monthlyAdjustments').markAdjustmentSubmitted(db, { id: lifecycleTaskA.id }, rejectedAdjustment.payload.revisionId);
  await db._helpers.run(db, `UPDATE report_tasks SET task_status='submitted' WHERE id=?`, [lifecycleTaskA.id]);
  const rejectedReviewB = await request(`/collaboration/tasks/${lifecycleTaskA.id}/review-opinions`, { method: 'POST', token: departmentReviewerLogin.payload.token,
    body: { reviewItemKey: 'monthly:submission', expectedVersion: 0, disposition: 'accept', opinion: '已复核。' } });
  assert.equal(rejectedReviewB.response.status, 200, JSON.stringify(rejectedReviewB.payload));
  const rejectionResponse = await request(`/collaboration/tasks/${lifecycleTaskA.id}/adjustment-decision`, { method: 'POST', token: login.payload.token,
    body: { decision: 'reject', note: '证据不足，本次调整不予通过。' } });
  assert.equal(rejectionResponse.response.status, 200, JSON.stringify(rejectionResponse.payload));
  const rejectedState = await db._helpers.get(db, `SELECT a.status, r.is_current_effective, t.task_status
    FROM adjustment_requests a JOIN business_revisions r ON r.id=a.source_revision_id
    JOIN report_tasks t ON t.id=a.task_id WHERE a.id=?`, [rejectedAdjustment.payload.adjustmentRequestId]);
  assert.deepEqual([rejectedState.status, rejectedState.is_current_effective, rejectedState.task_status], ['rejected', 1, 'finalized'],
    'rejection restores the original finalized revision as current effective');

  const evidenceRevision = await db._helpers.get(db, `SELECT r.*, cr.collaboration_room_key FROM business_revisions r
    JOIN collaboration_rooms cr ON cr.id = r.collaboration_room_id WHERE r.id = ?`, [returned.payload.revisionId]);
  const evidenceWorkbookPath = path.join(process.env.COST_REPORT_ARTIFACT_DIR, 'revision-seed-evidence-return.ssjson');
  const evidenceWorkbookJson = JSON.stringify({ version: '19.1.4', sheets: [{ name: '证据修订工作簿', data: { dataTable: {} } }] });
  fs.writeFileSync(evidenceWorkbookPath, evidenceWorkbookJson, 'utf8');
  const evidenceWorkbookArtifact = await db._helpers.run(db, `INSERT INTO official_artifacts
    (revision_id, artifact_type, storage_key, sha256, byte_size) VALUES (?, 'spreadjs_workbook_json', ?, 'evidence-test-hash', ?)`,
  [returned.payload.revisionId, evidenceWorkbookPath, Buffer.byteLength(evidenceWorkbookJson)]);
  await db._helpers.run(db, `UPDATE business_revisions SET revision_status = 'submitted', submitted_by = ?,
    submitted_at = CURRENT_TIMESTAMP, workbook_artifact_id = ?, collaboration_version = 0 WHERE id = ?`,
  [registeredUser.id, evidenceWorkbookArtifact.lastID, returned.payload.revisionId]);
  await db._helpers.run(db, `UPDATE report_tasks SET task_status = 'submitted' WHERE id = ?`, [lifecycleTaskB.id]);
  await db._helpers.run(db, `UPDATE collaboration_rooms SET room_status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?`, [evidenceRevision.collaboration_room_id]);
  await db._helpers.run(db.collaborationDb, `UPDATE collaboration_rooms SET room_status = 'closed' WHERE room_key = ?`, [evidenceRevision.collaboration_room_key]);
  const returnWithEvidence = await request(`/collaboration/tasks/${lifecycleTaskB.id}/review-opinions`, { method: 'POST', token: login.payload.token,
    body: { reviewItemKey: 'monthly:submission', expectedVersion: 0, disposition: 'return', opinion: '请补充附件说明', remediationDeadline: '2026-11-05T23:59:00+08:00' } });
  assert.equal(returnWithEvidence.response.status, 200, JSON.stringify(returnWithEvidence.payload));
  const preservedEvidence = await evidenceService.listAttachments(lifecycleTaskB, evidenceActor);
  assert.equal(preservedEvidence.length, 22);
  assert.ok(preservedEvidence.some(item => item.revisionId === returnWithEvidence.payload.revisionId
    && item.indicatorCode === 'API_EVIDENCE' && item.sha256 === firstApiEvidence.sha256));
  assert.ok(preservedEvidence.some(item => item.revisionId === returnWithEvidence.payload.revisionId
    && item.indicatorCode === null && item.originalName === 'task-evidence.pdf'));
  assert.equal((await readPackage(periodPackage.payload.package.id, login.payload.token)).payload.package.status, 'active');
  const immutablePackage = await request(`/period-configuration/packages/${periodPackage.payload.package.id}`, { method: 'PUT', token: login.payload.token,
    body: { reportTypeId: monthlyType.payload.reportTypeId, periodCode: '2026-10', templateVersionId: templateV3.payload.versionId,
      organizations: [{ organizationId: orgA.payload.organizationId }] } });
  assert.equal(immutablePackage.response.status, 409);

  const quarterlyType = await request('/period-configuration/report-types', { method: 'POST', token: login.payload.token,
    body: { code: 'ACCEPTANCE_QUARTERLY', displayName: '季度综合评价', cadence: 'quarterly' } });
  assert.equal(quarterlyType.response.status, 201);
  const quarterlyInvalid = await request('/period-configuration/packages', { method: 'POST', token: login.payload.token, body: {
    reportTypeId: quarterlyType.payload.reportTypeId, periodCode: '2026-Q4', templateVersionId: templateV3.payload.versionId,
    organizations: [{ organizationId: orgA.payload.organizationId }], indicators: [
      { organizationId: orgA.payload.organizationId, code: 'QUALITY', displayName: '质量', weight: 80 }
    ]
  } });
  assert.equal(quarterlyInvalid.response.status, 400);
  assert.match(quarterlyInvalid.payload.error, /月度数据来源/);
  const invalidIndicatorTree = await request('/period-configuration/packages', { method: 'POST', token: login.payload.token, body: {
    reportTypeId: quarterlyType.payload.reportTypeId, periodCode: '2026-Q4', templateVersionId: templateV3.payload.versionId,
    organizations: [{ organizationId: orgA.payload.organizationId }],
    configuration: { monthlySourceReportTypeId: monthlyType.payload.reportTypeId }, indicators: [
      { organizationId: orgA.payload.organizationId, code: 'CHILD', displayName: '子指标', category: 'key_business', weight: 100,
        maximumScore: 10, ownerOrganizationId: reviewDepartment.lastID, reviewerUserId: departmentReviewer.lastID,
        namedArea: 'MAIN_BODY_TABLE_QUARTERLY_ITEMS', parentCode: 'MISSING' }
    ]
  } });
  assert.equal(invalidIndicatorTree.response.status, 400);
  assert.match(invalidIndicatorTree.payload.error, /上级指标不存在/);

  const sourceQuarterTemplate = await db._helpers.get(db, 'SELECT * FROM template_versions WHERE id = ?', [templateV3.payload.versionId]);
  const quarterWorkbook = JSON.parse(sourceQuarterTemplate.workbook_json);
  const quarterManifest = JSON.parse(sourceQuarterTemplate.manifest_json);
  const quarterMapping = { kind: 'table', namedArea: 'MAIN_BODY_TABLE_QUARTERLY_ITEMS', fieldCode: 'FIELD_TEST_DECIMAL',
    row: 10, col: 0, rowCount: 4, colCount: 1, datasetColumns: [{ fieldDefinitionId: approvedTestField.id, fieldCode: 'FIELD_TEST_DECIMAL' }],
    primary: true, permission: 'primary_input' };
  quarterWorkbook.sheets.find(sheet => sheet.code === 'main').mappings.push(quarterMapping);
  quarterManifest.submission.sheets.find(sheet => sheet.code === 'main').mappings.push({ ...quarterMapping, sheet: 'main', sheetIndex: 0,
    sourceLocation: { row: 10, column: 0, rowCount: 3, columnCount: 1 } });
  const quarterTemplate = await db._helpers.run(db, `INSERT INTO template_versions
    (template_id, version, status, manifest_json, workbook_json, created_by, reviewed_by, published_at)
    VALUES (?, 4, 'published', ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [sourceQuarterTemplate.template_id,
    JSON.stringify(quarterManifest), JSON.stringify(quarterWorkbook), designerInsert.lastID, login.payload.user.id]);
  const quarterlyFormulaRule = await db._helpers.run(db, `INSERT INTO rule_definitions
    (code, rule_type, display_name, status, created_by) VALUES ('ACCEPTANCE_QUARTER_REVENUE_SCORE', 'formula', '季度收入完成率评分', 'active', ?)`,
  [registeredUser.id]);
  const quarterlyFormulaVersion = await db._helpers.run(db, `INSERT INTO rule_versions
    (rule_id, version, expression_json, parameters_json, status, created_by, reviewed_by, published_at)
    VALUES (?, 1, ?, '{}', 'published', ?, ?, CURRENT_TIMESTAMP)`, [quarterlyFormulaRule.lastID,
    JSON.stringify({ op: 'score_completion', args: [{ field: 'QUARTER_REVENUE' }, { field: 'QUARTER_REVENUE_TARGET' }, 25] }),
    registeredUser.id, designerInsert.lastID]);
  const quarterlyRevenueTargetField = await db._helpers.run(db, `INSERT INTO field_definitions
    (code, display_name, data_type, precision, status, created_by, approved_by, approved_at)
    VALUES ('QUARTER_REVENUE_TARGET', '季度收入目标', 'decimal', 2, 'approved', ?, ?, CURRENT_TIMESTAMP)`,
  [registeredUser.id, registeredUser.id]);
  const quarterlyChildUnit = await db._helpers.run(db, `INSERT INTO organizations (code, name, organization_type, status)
    VALUES ('API-QUARTER-UNIT-A', 'API季度下属单位A', 'department', 'active')`);
  await db._helpers.run(db, `INSERT INTO organization_relationships
    (parent_organization_id, child_organization_id, effective_from, effective_to) VALUES (?, ?, '2026-01-01', NULL)`,
  [orgA.payload.organizationId, quarterlyChildUnit.lastID]);
  const quarterlyReferenceWorkbook = structuredClone(quarterWorkbook);
  quarterlyReferenceWorkbook.sheets = quarterlyReferenceProfile.sheetNames.map((name, index) => ({
    name,
    code: quarterlyReferenceProfile.companySheetNames.includes(name)
      ? (name === quarterlyReferenceProfile.companySheetNames[0] ? 'reference_company_a'
        : name === quarterlyReferenceProfile.companySheetNames[1] ? 'reference_company_b'
          : `reference_sheet_${String(index + 1).padStart(2, '0')}`)
      : `reference_auxiliary_${index + 1}`,
    type: quarterlyReferenceProfile.companySheetNames.includes(name) ? 'business' : 'auxiliary',
    ...(name === quarterlyReferenceProfile.companySheetNames[0] || name === quarterlyReferenceProfile.companySheetNames[1]
      ? { mappings: [quarterMapping], cells: [] } : {})
  }));
  const quarterlyReferenceManifest = { ...quarterManifest, sourceWorkbook: { name: 'registered-reference.xlsx',
    sha256: require('../../shared/quarterly-reference-profile.json').sha256, importedReadOnly: true } };
  const quarterlyReferenceVersion = await db._helpers.run(db, `INSERT INTO template_versions
    (template_id, version, status, manifest_json, workbook_json, created_by, reviewed_by, published_at)
    VALUES (?, 5, 'draft', ?, ?, ?, ?, NULL)`, [sourceQuarterTemplate.template_id,
    JSON.stringify(quarterlyReferenceManifest), JSON.stringify(quarterlyReferenceWorkbook), registeredUser.id, login.payload.user.id]);
  await db._helpers.run(db, `INSERT INTO template_sheets
    (template_version_id, sheet_code, display_name, sheet_order, sheet_type) VALUES (?, 'reference_company_a', '1参考公司甲', 0, 'business')`,
  [quarterlyReferenceVersion.lastID]);
  await db._helpers.run(db, `INSERT INTO template_sheets
    (template_version_id, sheet_code, display_name, sheet_order, sheet_type) VALUES (?, 'reference_company_b', '2参考公司乙', 1, 'business')`,
  [quarterlyReferenceVersion.lastID]);
  await db._helpers.run(db, `UPDATE template_versions SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [quarterlyReferenceVersion.lastID]);
  const quarterlyReferenceResources = await request('/period-configuration/resources', { token: login.payload.token });
  const quarterlyReferenceResource = quarterlyReferenceResources.payload.templates.find(item => item.versionId === quarterlyReferenceVersion.lastID);
  assert.equal(quarterlyReferenceResource.isQuarterlyReference, true);
  assert.deepEqual(quarterlyReferenceResource.companySheets.map(sheet => sheet.code), ['reference_company_a', 'reference_company_b']);
  const quarterlyReferencePackageBase = { reportTypeId: quarterlyType.payload.reportTypeId, periodCode: '2026-Q4',
    templateVersionId: quarterlyReferenceVersion.lastID, configuration: { monthlySourceReportTypeId: monthlyType.payload.reportTypeId },
    organizations: [{ organizationId: orgA.payload.organizationId }] };
  const missingCompanySheetMap = await request('/period-configuration/packages', { method: 'POST', token: login.payload.token,
    body: quarterlyReferencePackageBase });
  assert.equal(missingCompanySheetMap.response.status, 400);
  assert.match(missingCompanySheetMap.payload.error, /唯一且有效的公司考核页/);
  const duplicateCompanySheetMap = await request('/period-configuration/packages', { method: 'POST', token: login.payload.token,
    body: { ...quarterlyReferencePackageBase, organizations: [{ organizationId: orgA.payload.organizationId }, { organizationId: orgB.payload.organizationId }],
      configuration: { ...quarterlyReferencePackageBase.configuration,
        referenceCompanySheets: { [orgA.payload.organizationId]: 'reference_company_a', [orgB.payload.organizationId]: 'reference_company_a' } } } });
  assert.equal(duplicateCompanySheetMap.response.status, 400);
  assert.match(duplicateCompanySheetMap.payload.error, /唯一且有效的公司考核页/);
  const unknownCompanySheetMap = await request('/period-configuration/packages', { method: 'POST', token: login.payload.token,
    body: { ...quarterlyReferencePackageBase, configuration: { ...quarterlyReferencePackageBase.configuration,
      referenceCompanySheets: { [orgA.payload.organizationId]: 'not_a_template_sheet' } } } });
  assert.equal(unknownCompanySheetMap.response.status, 400);
  assert.match(unknownCompanySheetMap.payload.error, /唯一且有效的公司考核页/);
  const quarterlyPackage = await request('/period-configuration/packages', { method: 'POST', token: login.payload.token, body: {
    reportTypeId: quarterlyType.payload.reportTypeId, periodCode: '2026-Q4', templateVersionId: quarterlyReferenceVersion.lastID,
    organizations: [{ organizationId: orgA.payload.organizationId }, { organizationId: orgB.payload.organizationId },
      { organizationId: quarterlyChildUnit.lastID }],
    configuration: { monthlySourceReportTypeId: monthlyType.payload.reportTypeId,
      referenceCompanySheets: { [orgA.payload.organizationId]: 'reference_company_a', [orgB.payload.organizationId]: 'reference_company_b' },
      performanceRedemptionIntervals: [{ minScore: 90, maxScore: 100, minRank: 1, maxRank: 1, coefficient: 1.2 }] },
    assignments: [...assignmentsFor([orgA.payload.organizationId, orgB.payload.organizationId]),
      ...[orgA.payload.organizationId, orgB.payload.organizationId].map(organizationId => ({ organizationId, responsibility: 'scorer', userId: registeredUser.id })),
      ...[orgA.payload.organizationId, orgB.payload.organizationId].map(organizationId => ({ organizationId, responsibility: 'department_reviewer', userId: departmentReviewer.lastID }))],
    targets: [{ organizationId: orgA.payload.organizationId, fieldDefinitionId: approvedTestField.id,
      phase: 'quarterly', phasePeriod: '2026-Q4', amount: '100' }],
    indicators: [
      { organizationId: orgA.payload.organizationId, code: 'QUALITY', displayName: '质量', category: 'key_business', weight: 0,
        maximumScore: 10, ownerOrganizationId: reviewDepartment.lastID, reviewerUserId: departmentReviewer.lastID, namedArea: quarterMapping.namedArea, exempt: true },
      { organizationId: orgA.payload.organizationId, code: 'QUALITY_DETAIL', displayName: '质量明细', category: 'key_business', weight: 100,
        maximumScore: 20, ownerOrganizationId: reviewDepartment.lastID, reviewerUserId: departmentReviewer.lastID,
        namedArea: quarterMapping.namedArea, parentCode: 'QUALITY', fieldDefinitionId: approvedTestField.id },
      { organizationId: quarterlyChildUnit.lastID, code: 'UNIT_QUALITATIVE', displayName: '下属单位定性要点', category: 'key_business', weight: 0,
        maximumScore: 5, ownerOrganizationId: reviewDepartment.lastID, reviewerUserId: departmentReviewer.lastID,
        namedArea: quarterMapping.namedArea },
      { organizationId: orgB.payload.organizationId, code: 'QUALITY', displayName: '质量', category: 'key_work', weight: 100,
        maximumScore: 25, ownerOrganizationId: reviewDepartment.lastID, reviewerUserId: departmentReviewer.lastID,
        namedArea: quarterMapping.namedArea, fieldDefinitionId: approvedTestField.id,
        scoreFormulaVersionId: quarterlyFormulaVersion.lastID }
    ]
  } });
  assert.equal(quarterlyPackage.response.status, 201, JSON.stringify(quarterlyPackage.payload));
  const optionalIndicatorDraft = await request('/period-configuration/packages', { method: 'POST', token: login.payload.token, body: {
    draftOnly: true, reportTypeId: quarterlyType.payload.reportTypeId, periodCode: '2098-Q1', templateVersionId: quarterlyReferenceVersion.lastID,
    organizations: [{ organizationId: orgA.payload.organizationId }, { organizationId: orgB.payload.organizationId }],
    configuration: { monthlySourceReportTypeId: monthlyType.payload.reportTypeId,
      referenceCompanySheets: { [orgA.payload.organizationId]: 'reference_company_a', [orgB.payload.organizationId]: 'reference_company_b' } },
    assignments: [...assignmentsFor([orgA.payload.organizationId, orgB.payload.organizationId]),
      ...[orgA.payload.organizationId, orgB.payload.organizationId].map(organizationId => ({ organizationId, responsibility: 'scorer', userId: registeredUser.id }))],
    indicators: [], targets: []
  } });
  assert.equal(optionalIndicatorDraft.response.status, 201);
  const optionalIndicatorValidation = await request(`/period-configuration/packages/${optionalIndicatorDraft.payload.package.id}/validate`, { method: 'POST', token: login.payload.token });
  assert.equal(optionalIndicatorValidation.payload.valid, true, JSON.stringify(optionalIndicatorValidation.payload));
  assert.deepEqual((await readPackage(optionalIndicatorValidation.payload.packageId, login.payload.token)).payload.package.configuration.indicators, []);
  const optionalIndicatorActivation = await request(`/period-configuration/packages/${optionalIndicatorValidation.payload.packageId}/activate`, { method: 'POST', token: login.payload.token });
  assert.equal(optionalIndicatorActivation.response.status, 200, JSON.stringify(optionalIndicatorActivation.payload));
  assert.equal(optionalIndicatorActivation.payload.taskCount, 2);
  assert.equal((await db._helpers.get(db, `SELECT COUNT(*) AS count FROM task_indicators i
    JOIN report_tasks t ON t.id = i.task_id WHERE t.package_id = ?`, [optionalIndicatorValidation.payload.packageId])).count, 0);
  assert.deepEqual(quarterlyPackage.payload.package.configuration.referenceCompanySheets,
    { [orgA.payload.organizationId]: 'reference_company_a', [orgB.payload.organizationId]: 'reference_company_b' },
  'explicit company-sheet mappings are preserved in the package configuration');
  const quarterActivation = await request(`/period-configuration/packages/${quarterlyPackage.payload.package.id}/activate`, { method: 'POST', token: login.payload.token });
  assert.equal(quarterActivation.response.status, 200, JSON.stringify(quarterActivation.payload));
  const quarterDeadline = await db._helpers.get(db, 'SELECT deadline_at FROM report_tasks WHERE package_id = ? LIMIT 1', [quarterlyPackage.payload.package.id]);
  assert.equal(quarterDeadline.deadline_at, '2027-01-02T23:59:59+08:00');
  const indicatorCount = await db._helpers.get(db, 'SELECT COUNT(*) AS count FROM task_indicators ti JOIN report_tasks t ON t.id = ti.task_id WHERE t.package_id = ?', [quarterlyPackage.payload.package.id]);
  assert.equal(indicatorCount.count, 4);
  const indicatorParent = await db._helpers.get(db, `SELECT child.parent_id, parent.indicator_code AS parent_code FROM task_indicators child
    JOIN task_indicators parent ON parent.id = child.parent_id WHERE child.indicator_code = 'QUALITY_DETAIL'`);
  assert.equal(indicatorParent.parent_code, 'QUALITY');
  const stableQuarterIndicator = await db._helpers.get(db, `SELECT ti.configuration_json FROM task_indicators ti
    JOIN report_tasks t ON t.id = ti.task_id WHERE t.package_id = ? AND t.organization_id = ? AND ti.indicator_code = 'QUALITY_DETAIL'`,
  [quarterlyPackage.payload.package.id, orgA.payload.organizationId]);
  const stableQuarterConfig = JSON.parse(stableQuarterIndicator.configuration_json);
  assert.equal(stableQuarterConfig.recordKey, 'quarterly:key_business:QUALITY_DETAIL');
  assert.equal(stableQuarterConfig.maximumScore, 20);
  assert.equal(stableQuarterConfig.reviewerUserId, departmentReviewer.lastID);
  assert.equal(stableQuarterConfig.tagCode, 'QUARTERLY_KEY_BUSINESS_FILLER');
  const unitQuarterConfig = await db._helpers.get(db, `SELECT ti.configuration_json FROM task_indicators ti
    JOIN report_tasks t ON t.id = ti.task_id WHERE t.package_id = ? AND t.organization_id = ? AND ti.indicator_code = 'UNIT_QUALITATIVE'`,
  [quarterlyPackage.payload.package.id, orgA.payload.organizationId]);
  assert.equal(JSON.parse(unitQuarterConfig.configuration_json).sourceOrganizationId, quarterlyChildUnit.lastID);
  assert.equal(JSON.parse(unitQuarterConfig.configuration_json).organizationId, orgA.payload.organizationId);
  assert.equal(await db._helpers.get(db, `SELECT COUNT(*) AS count FROM report_tasks WHERE package_id = ? AND organization_id = ?`,
    [quarterlyPackage.payload.package.id, quarterlyChildUnit.lastID]).then(row => row.count), 0,
  'quarterly qualitative rows are attributed to the unique owning subsidiary task');
  const quarterlyTask = await db._helpers.get(db, 'SELECT id FROM report_tasks WHERE package_id = ? AND organization_id = ?',
    [quarterlyPackage.payload.package.id, orgA.payload.organizationId]);
  const appliedAdjustmentRequest = await db._helpers.get(db, 'SELECT * FROM adjustment_requests WHERE id=?', [adjustmentStarted.payload.adjustmentRequestId]);
  const monthlyImpactSource = await db._helpers.get(db, 'SELECT id, organization_id, period_code FROM report_tasks WHERE id=?', [lifecycleTaskA.id]);
  await require('../src/services/monthlyAdjustments').recordQuarterlyImpacts(db, appliedAdjustmentRequest,
    monthlyImpactSource, appliedAdjustment.payload.revisionId);
  const quarterlyRoom = await request(`/collaboration/tasks/${quarterlyTask.id}/room`, { token: login.payload.token });
  assert.equal(quarterlyRoom.response.status, 200, JSON.stringify(quarterlyRoom.payload));
  assert.ok(quarterlyRoom.payload.task.configuration.assignments.some(item => item.responsibility === 'filler'),
    'the quarterly filling Workbench receives its task assignments from the nested task configuration snapshot');
  assert.deepEqual(quarterlyRoom.payload.task.configuration.targets.map(target => [target.fieldCode, target.amount]),
    [[approvedTestField.code, '100']], 'the quarterly filling Workbench receives its snapshotted targets');
  assert.equal(quarterlyRoom.payload.quarterlyDependencies.complete, false);
  assert.equal(quarterlyRoom.payload.quarterlyAdjustmentImpacts.length, 1);
  assert.equal(quarterlyRoom.payload.quarterlyAdjustmentImpacts[0].status, 'pending_confirmation');
  const impactConfirmed = await request(`/collaboration/tasks/${quarterlyTask.id}/adjustment-impacts/${quarterlyRoom.payload.quarterlyAdjustmentImpacts[0].id}/confirm`,
    { method: 'POST', token: login.payload.token, body: {} });
  assert.equal(impactConfirmed.response.status, 200, JSON.stringify(impactConfirmed.payload));
  assert.equal(impactConfirmed.payload.status, 'confirmed');
  assert.equal(quarterlyRoom.payload.quarterlyDependencies.scoringAllowed, false);
  assert.equal(quarterlyRoom.payload.quarterlyDependencies.finalizationAllowed, false);
  assert.equal(quarterlyRoom.payload.quarterlyDependencies.months.length, 12);
  assert.ok(quarterlyRoom.payload.quarterlyDependencies.missingPeriods.some(item => item.periodCode === '2026-11'));
  assert.equal(quarterlyRoom.payload.quarterlyDependencies.months.find(item => item.periodCode === '2026-10').status, 'finalized');
  const quarterlyWorkbook = quarterlyRoom.payload.workbook;
  const quarterlyTable = quarterlyWorkbook.sheets.find(sheet => sheet.code === 'reference_company_a').cells.filter(cell => {
    if (!cell.tag) return false;
    try { return Boolean(JSON.parse(cell.tag).recordKey); } catch { return false; }
  });
  assert.equal(quarterlyTable.length, 3);
  assert.deepEqual(quarterlyTable.map(cell => JSON.parse(cell.tag).recordKey), [
    'quarterly:key_business:QUALITY', 'quarterly:key_business:QUALITY_DETAIL', 'quarterly:key_business:UNIT_QUALITATIVE'
  ]);
  const quarterlyEconomicsSheet = quarterlyWorkbook.sheets.find(sheet => sheet.code === 'quarterly_economics');
  assert.ok(quarterlyEconomicsSheet);
  assert.equal(quarterlyEconomicsSheet.cells.find(cell => cell.row === 1 && cell.column === 1).value, undefined);
  assert.equal(quarterlyRoom.payload.manifest.permissionIndex.sheets.at(-1).readOnly, true);
  const quarterlyFinalizeBlocked = await finalizeRequest(`/collaboration/tasks/${quarterlyTask.id}/finalize`, login.payload.token);
  assert.equal(quarterlyFinalizeBlocked.response.status, 409, JSON.stringify(quarterlyFinalizeBlocked.payload));
  assert.match(quarterlyFinalizeBlocked.payload.error, /季度定稿因月报依赖未齐全而被阻止/);

  fs.mkdirSync(path.join(testRoot, 'artifacts'), { recursive: true });
  const quarterlySnapshotPath = path.join(testRoot, 'artifacts', 'quarterly-review-snapshot.json');
  const quarterlySnapshotJson = JSON.stringify(quarterlyWorkbook);
  fs.writeFileSync(quarterlySnapshotPath, quarterlySnapshotJson, 'utf8');
  const quarterlyRoomRow = await db._helpers.get(db, 'SELECT id, latest_version FROM collaboration_rooms WHERE task_id = ?', [quarterlyTask.id]);
  const quarterlyRevision = await db._helpers.run(db, `INSERT INTO business_revisions
    (task_id, revision_number, revision_status, submitted_by, submitted_at, collaboration_room_id, collaboration_version)
    VALUES (?, 1, 'submitted', ?, CURRENT_TIMESTAMP, ?, ?)`, [quarterlyTask.id, registeredUser.id, quarterlyRoomRow.id, quarterlyRoomRow.latest_version]);
  const quarterlySnapshotArtifact = await db._helpers.run(db, `INSERT INTO official_artifacts
    (revision_id, artifact_type, storage_key, sha256, byte_size) VALUES (?, 'spreadjs_workbook_json', ?, ?, ?)`,
  [quarterlyRevision.lastID, quarterlySnapshotPath, '0'.repeat(64), Buffer.byteLength(quarterlySnapshotJson)]);
  await db._helpers.run(db, 'UPDATE business_revisions SET workbook_artifact_id = ? WHERE id = ?', [quarterlySnapshotArtifact.lastID, quarterlyRevision.lastID]);
  await db._helpers.run(db, `UPDATE report_tasks SET current_revision_id = ?, task_status = 'submitted' WHERE id = ?`, [quarterlyRevision.lastID, quarterlyTask.id]);
  await db._helpers.run(db, `INSERT INTO business_values
    (revision_id, task_id, record_key, field_definition_id, value_type, decimal_value, entered_by)
    VALUES (?, ?, 'quarterly:key_business:QUALITY_DETAIL', ?, 'decimal', '10', ?)`,
  [quarterlyRevision.lastID, quarterlyTask.id, approvedTestField.id, registeredUser.id]);
  const quarterlyOtherTask = await db._helpers.get(db, 'SELECT id FROM report_tasks WHERE package_id = ? AND organization_id = ?',
    [quarterlyPackage.payload.package.id, orgB.payload.organizationId]);
  const quarterlyOtherRoom = await request(`/collaboration/tasks/${quarterlyOtherTask.id}/room`, { token: login.payload.token });
  assert.equal(quarterlyOtherRoom.response.status, 200, JSON.stringify(quarterlyOtherRoom.payload));
  const quarterlyOtherSnapshotPath = path.join(testRoot, 'artifacts', 'quarterly-review-other-snapshot.json');
  const quarterlyOtherSnapshotJson = JSON.stringify(quarterlyOtherRoom.payload.workbook);
  fs.writeFileSync(quarterlyOtherSnapshotPath, quarterlyOtherSnapshotJson, 'utf8');
  const quarterlyOtherRoomRow = await db._helpers.get(db, 'SELECT id, latest_version FROM collaboration_rooms WHERE task_id = ?', [quarterlyOtherTask.id]);
  const quarterlyOtherRevision = await db._helpers.run(db, `INSERT INTO business_revisions
    (task_id, revision_number, revision_status, submitted_by, submitted_at, collaboration_room_id, collaboration_version)
    VALUES (?, 1, 'submitted', ?, CURRENT_TIMESTAMP, ?, ?)`, [quarterlyOtherTask.id, registeredUser.id,
    quarterlyOtherRoomRow.id, quarterlyOtherRoomRow.latest_version]);
  const quarterlyOtherSnapshotArtifact = await db._helpers.run(db, `INSERT INTO official_artifacts
    (revision_id, artifact_type, storage_key, sha256, byte_size) VALUES (?, 'spreadjs_workbook_json', ?, ?, ?)`,
  [quarterlyOtherRevision.lastID, quarterlyOtherSnapshotPath, '1'.repeat(64), Buffer.byteLength(quarterlyOtherSnapshotJson)]);
  await db._helpers.run(db, 'UPDATE business_revisions SET workbook_artifact_id = ? WHERE id = ?',
    [quarterlyOtherSnapshotArtifact.lastID, quarterlyOtherRevision.lastID]);
  await db._helpers.run(db, `INSERT INTO business_values
    (revision_id, task_id, record_key, field_definition_id, value_type, decimal_value, entered_by)
    VALUES (?, ?, '', ?, 'decimal', '3033', ?)`,
  [quarterlyOtherRevision.lastID, quarterlyOtherTask.id, quarterlyRevenueTargetField.lastID, registeredUser.id]);
  await db._helpers.run(db, `UPDATE report_tasks SET current_revision_id = ?, task_status = 'submitted' WHERE id = ?`,
    [quarterlyOtherRevision.lastID, quarterlyOtherTask.id]);
  const scopedFinalizer = await db._helpers.run(db, `INSERT INTO users (username, password, name, organization_id)
    VALUES (?, ?, '组织定稿人', ?)`, ['acceptance-scoped-finalizer', await bcrypt.hash('scoped-finalizer-password', 4), orgA.payload.organizationId]);
  await db._helpers.run(db, `INSERT INTO user_roles (user_id, role_code, organization_id, granted_by)
    VALUES (?, 'report_finalizer', ?, ?)`, [scopedFinalizer.lastID, orgA.payload.organizationId, registeredUser.id]);
  await db._helpers.run(db, `INSERT INTO package_assignments
    (package_id, organization_id, responsibility, user_id, assigned_by, reason)
    VALUES (?, ?, 'finalizer', ?, ?, '组织级定稿权限隔离验收')`,
  [quarterlyPackage.payload.package.id, orgA.payload.organizationId, scopedFinalizer.lastID, registeredUser.id]);
  const scopedFinalizerTaskConfig = JSON.parse((await db._helpers.get(db,
    'SELECT configuration_snapshot_json FROM report_tasks WHERE id=?', [quarterlyTask.id])).configuration_snapshot_json);
  scopedFinalizerTaskConfig.assignments.push({ responsibility: 'finalizer', userId: scopedFinalizer.lastID, reason: '组织级定稿权限隔离验收' });
  await db._helpers.run(db, 'UPDATE report_tasks SET configuration_snapshot_json=? WHERE id=?',
    [JSON.stringify(scopedFinalizerTaskConfig), quarterlyTask.id]);
  const scopedFinalizerLogin = await request('/auth/login', { method: 'POST', body: {
    username: 'acceptance-scoped-finalizer', password: 'scoped-finalizer-password'
  } });
  assert.equal(scopedFinalizerLogin.response.status, 200, JSON.stringify(scopedFinalizerLogin.payload));
  const scopedFinalizerTasks = await request('/quarterly-review/tasks', { token: scopedFinalizerLogin.payload.token });
  assert.deepEqual(scopedFinalizerTasks.payload.tasks.map(item => item.id), [quarterlyTask.id],
    'an organization-scoped finalizer only sees tasks assigned within that organization');
  assert.equal(scopedFinalizerTasks.payload.tasks[0].canFinalize, false,
    'the package-wide finalize control stays hidden until every organization is assigned to this finalizer');
  const scopedPackageFinalize = await request(`/quarterly-review/tasks/${quarterlyTask.id}/finalize`, {
    method: 'POST', token: scopedFinalizerLogin.payload.token, body: {}
  });
  assert.equal(scopedPackageFinalize.response.status, 403,
    'an organization-scoped finalizer cannot finalize the full configuration package');
  const unassignedGlobalFinalizer = await db._helpers.run(db, `INSERT INTO users (username, password, name, organization_id)
    VALUES (?, ?, '未指派的全局定稿人', ?)`, ['acceptance-unassigned-global-finalizer',
    await bcrypt.hash('global-finalizer-password', 4), orgA.payload.organizationId]);
  await db._helpers.run(db, `INSERT INTO user_roles (user_id, role_code, organization_id, granted_by)
    VALUES (?, 'report_finalizer', NULL, ?)`, [unassignedGlobalFinalizer.lastID, registeredUser.id]);
  const unassignedGlobalFinalizerLogin = await request('/auth/login', { method: 'POST', body: {
    username: 'acceptance-unassigned-global-finalizer', password: 'global-finalizer-password'
  } });
  assert.equal(unassignedGlobalFinalizerLogin.response.status, 200, JSON.stringify(unassignedGlobalFinalizerLogin.payload));
  const unassignedGlobalPackageFinalize = await request(`/quarterly-review/tasks/${quarterlyTask.id}/finalize`, {
    method: 'POST', token: unassignedGlobalFinalizerLogin.payload.token, body: {}
  });
  assert.equal(unassignedGlobalPackageFinalize.response.status, 403,
    'a global finalizer still needs explicit finalizer assignments across the package');
  const crossOrganizationQuarterlyDetail = await request(`/quarterly-review/tasks/${quarterlyOtherTask.id}`,
    { token: scopedFinalizerLogin.payload.token });
  assert.equal(crossOrganizationQuarterlyDetail.response.status, 403,
    'an organization-scoped finalizer cannot read another organization\'s workbook');
  const quarterlyReviewTaskList = await request('/quarterly-review/tasks', { token: departmentReviewerLogin.payload.token });
  assert.ok(quarterlyReviewTaskList.payload.tasks?.some(item => item.id === quarterlyTask.id), JSON.stringify(quarterlyReviewTaskList.payload));
  const quarterlyReviewerDetail = await request(`/quarterly-review/tasks/${quarterlyTask.id}`, { token: departmentReviewerLogin.payload.token });
  assert.equal(quarterlyReviewerDetail.response.status, 200, JSON.stringify(quarterlyReviewerDetail.payload));
  assert.deepEqual(quarterlyReviewerDetail.payload.indicators.map(item => item.code), ['QUALITY', 'QUALITY_DETAIL', 'UNIT_QUALITATIVE']);
  assert.equal(quarterlyReviewerDetail.payload.quarterlyDependencies, null,
    'department reviewers do not receive cross-indicator quarterly economic dependency values');
  assert.equal(quarterlyReviewerDetail.payload.task.configuration.indicators, undefined,
    'department reviewers do not receive configuration for unassigned indicators');
  assert.ok(!quarterlyReviewerDetail.payload.workbook.sheets.some(sheet => sheet.code === 'quarterly_economics'),
    'department reviewers only receive their assigned qualitative indicator context');
  const quarterlyIndicatorItems = quarterlyReviewerDetail.payload.indicators;
  const parallelIndicatorReviews = await Promise.all([
    request(`/quarterly-review/tasks/${quarterlyTask.id}/indicators/${quarterlyIndicatorItems[0].id}/review`, { method: 'POST',
      token: departmentReviewerLogin.payload.token, body: { expectedVersion: 0, status: 'approved', opinion: '指标审核通过。' } }),
    request(`/quarterly-review/tasks/${quarterlyTask.id}/indicators/${quarterlyIndicatorItems[1].id}/review`, { method: 'POST',
      token: departmentReviewerLogin.payload.token, body: { expectedVersion: 0, status: 'returned', opinion: '请补充支撑说明。',
        remediationDeadline: '2026-11-05T23:59:00+08:00' } })
  ]);
  assert.deepEqual(parallelIndicatorReviews.map(item => item.response.status), [200, 200]);
  const quarterReviewInProgress = await request(`/quarterly-review/tasks/${quarterlyTask.id}/indicators/${quarterlyIndicatorItems[2].id}/review`, {
    method: 'POST', token: departmentReviewerLogin.payload.token,
    body: { expectedVersion: 0, status: 'in_review', opinion: '正在核对下属单位指标。' }
  });
  assert.equal(quarterReviewInProgress.response.status, 200, JSON.stringify(quarterReviewInProgress.payload));
  const invalidQuarterlyScore = await request(`/quarterly-review/tasks/${quarterlyTask.id}/indicators/${quarterlyIndicatorItems[1].id}/score`, {
    method: 'POST', token: login.payload.token, body: { score: 21, expectedVersion: 0 }
  });
  assert.equal(invalidQuarterlyScore.response.status, 400);
  const blockedQuarterlyScore = await request(`/quarterly-review/tasks/${quarterlyTask.id}/indicators/${quarterlyIndicatorItems[1].id}/score`, {
    method: 'POST', token: login.payload.token, body: { score: 18, expectedVersion: 0 }
  });
  assert.equal(blockedQuarterlyScore.response.status, 409);
  assert.match(blockedQuarterlyScore.payload.error, /月报依赖未齐全/);
  const exemptQuarterlyItem = quarterlyReviewerDetail.payload.indicators.find(item => item.code === 'QUALITY');
  assert.equal(exemptQuarterlyItem.scoring.scoreSource, 'exempt');
  assert.equal(exemptQuarterlyItem.scoring.score, 10);
  const seededAdjustment = await db._helpers.run(db, `INSERT INTO quarterly_adjustment_requests
    (revision_id, adjustment_type, amount_decimal, reason, requested_by) VALUES (?, 'reward', '2.5', '季度激励', ?)` ,
  [quarterlyRevision.lastID, registeredUser.id]);
  const approveSeededQuarterlyReward = await request(`/quarterly-review/tasks/${quarterlyTask.id}/adjustments/${seededAdjustment.lastID}/decision`, {
    method: 'POST', token: login.payload.token, body: { decision: 'approved', note: '达到奖励条件' }
  });
  assert.equal(approveSeededQuarterlyReward.response.status, 200, JSON.stringify(approveSeededQuarterlyReward.payload));
  const quarterlyManagementDetail = await request(`/quarterly-review/tasks/${quarterlyTask.id}`, { token: login.payload.token });
  assert.equal(quarterlyManagementDetail.payload.scoreSummary.rewards, 2.5);
  assert.equal(quarterlyManagementDetail.payload.permissions.canFinalize, true,
    'an authorized package finalizer receives the same package-scope capability in task detail and the task queue');
  const missingEconomicsDetail = await request(`/quarterly-review/tasks/${quarterlyOtherTask.id}`, { token: login.payload.token });
  assert.equal(missingEconomicsDetail.payload.indicators[0].scoring.score, null,
    'an automatic economic score stays unavailable while its monthly source dependencies are incomplete');
  const qFinalizeBlocked = await request(`/quarterly-review/tasks/${quarterlyTask.id}/finalize`, { method: 'POST', token: login.payload.token, body: {} });
  assert.equal(qFinalizeBlocked.response.status, 409);
  assert.match(qFinalizeBlocked.payload.error, /月报依赖未齐/);

  const quarterlySourceType = await request('/period-configuration/report-types', { method: 'POST', token: login.payload.token,
    body: { code: 'ACCEPTANCE_QUARTERLY_SOURCE_MONTHLY', displayName: '季度定稿依赖月报', cadence: 'monthly' } });
  assert.equal(quarterlySourceType.response.status, 201);
  const sourceQuarterTasks = await db._helpers.all(db, 'SELECT * FROM report_tasks WHERE package_id = ?', [quarterlyPackage.payload.package.id]);
  for (const sourceQuarterTask of sourceQuarterTasks) {
    const snapshot = JSON.parse(sourceQuarterTask.configuration_snapshot_json);
    snapshot.configuration = { ...(snapshot.configuration || {}), monthlySourceReportTypeId: quarterlySourceType.payload.reportTypeId };
    await db._helpers.run(db, 'UPDATE report_tasks SET configuration_snapshot_json = ? WHERE id = ?',
      [JSON.stringify(snapshot), sourceQuarterTask.id]);
  }
  const sourceRevenueField = await db._helpers.run(db, `INSERT INTO field_definitions
    (code, display_name, data_type, precision, status, created_by, approved_by, approved_at)
    VALUES ('ACCEPTANCE_REVENUE_TOTAL', '验收营业收入', 'decimal', 2, 'approved', ?, ?, CURRENT_TIMESTAMP)`,
  [registeredUser.id, registeredUser.id]);
  const sourceProfitField = await db._helpers.run(db, `INSERT INTO field_definitions
    (code, display_name, data_type, precision, status, created_by, approved_by, approved_at)
    VALUES ('ACCEPTANCE_PROFIT_TOTAL', '验收利润总额', 'decimal', 2, 'approved', ?, ?, CURRENT_TIMESTAMP)`,
  [registeredUser.id, registeredUser.id]);
  for (let month = 1; month <= 12; month++) {
    const sourcePeriod = `2026-${String(month).padStart(2, '0')}`;
    const packages = await db._helpers.all(db, `SELECT p.id, p.version, COUNT(t.id) AS taskCount FROM period_packages p
      LEFT JOIN report_tasks t ON t.package_id = p.id WHERE p.report_type_id = ? AND p.period_code = ?
      GROUP BY p.id ORDER BY taskCount DESC, p.version DESC`, [quarterlySourceType.payload.reportTypeId, sourcePeriod]);
    let sourcePackageId = packages[0]?.id;
    if (!sourcePackageId) {
      const insertedPackage = await db._helpers.run(db, `INSERT INTO period_packages
        (report_type_id, period_code, version, template_version_id, status, configuration_json, created_by, activated_by, activated_at)
        VALUES (?, ?, 1, ?, 'active', '{}', ?, ?, CURRENT_TIMESTAMP)`,
      [quarterlySourceType.payload.reportTypeId, sourcePeriod, templateV3.payload.versionId, registeredUser.id, registeredUser.id]);
      sourcePackageId = insertedPackage.lastID;
    }
    for (const organizationId of [orgA.payload.organizationId, orgB.payload.organizationId]) {
      const existingTasks = await db._helpers.all(db, `SELECT t.id, t.package_id AS packageId FROM report_tasks t
        JOIN period_packages p ON p.id = t.package_id WHERE p.report_type_id = ? AND t.organization_id = ? AND t.period_code = ?`,
      [quarterlySourceType.payload.reportTypeId, organizationId, sourcePeriod]);
      assert.ok(existingTasks.length <= 1, `only one synthetic monthly source task is expected for ${sourcePeriod}/${organizationId}`);
      let sourceTaskId = existingTasks[0]?.id;
      if (!sourceTaskId) {
        const insertedTask = await db._helpers.run(db, `INSERT INTO report_tasks
          (package_id, report_type_id, organization_id, period_code, task_status, deadline_at, configuration_snapshot_json, template_version_id)
          VALUES (?, ?, ?, ?, 'submitted', '2027-01-31T23:59:59+08:00', '{}', ?)`,
        [sourcePackageId, quarterlySourceType.payload.reportTypeId, organizationId, sourcePeriod, templateV3.payload.versionId]);
        sourceTaskId = insertedTask.lastID;
      }
      await db._helpers.run(db, 'UPDATE business_revisions SET is_current_effective = 0 WHERE task_id = ? AND is_current_effective = 1', [sourceTaskId]);
      const priorRevision = await db._helpers.get(db, 'SELECT MAX(revision_number) AS revisionNumber FROM business_revisions WHERE task_id = ?', [sourceTaskId]);
      const sourceRevision = await db._helpers.run(db, `INSERT INTO business_revisions
        (task_id, revision_number, revision_status, submitted_by, submitted_at, is_current_effective, finalized_at)
        VALUES (?, ?, 'finalized', ?, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
      [sourceTaskId, Number(priorRevision.revisionNumber || 0) + 1, registeredUser.id]);
      await db._helpers.run(db, `UPDATE report_tasks SET current_revision_id = ?, task_status = 'finalized' WHERE id = ?`,
        [sourceRevision.lastID, sourceTaskId]);
      for (const [fieldDefinitionId, amount] of [[sourceRevenueField.lastID, String(1000 + month)], [sourceProfitField.lastID, String(100 + month)]]) {
        await db._helpers.run(db, `INSERT INTO business_values
          (revision_id, task_id, record_key, field_definition_id, value_type, decimal_value, entered_by)
          VALUES (?, ?, '', ?, 'decimal', ?, ?)`, [sourceRevision.lastID, sourceTaskId, fieldDefinitionId, amount, registeredUser.id]);
      }
    }
  }
  const readyQuarterlyDependencies = await request(`/quarterly-review/tasks/${quarterlyTask.id}`, { token: login.payload.token });
  assert.equal(readyQuarterlyDependencies.response.status, 200, JSON.stringify(readyQuarterlyDependencies.payload));
  assert.equal(readyQuarterlyDependencies.payload.quarterlyDependencies.complete, true);
  assert.deepEqual(readyQuarterlyDependencies.payload.quarterlyDependencies.missingPeriods, []);
  const latestQuarterReviewerDetail = await request(`/quarterly-review/tasks/${quarterlyTask.id}`, { token: departmentReviewerLogin.payload.token });
  assert.equal(latestQuarterReviewerDetail.response.status, 200, JSON.stringify(latestQuarterReviewerDetail.payload));
  const completeQuarterReviews = await Promise.all([
    ...latestQuarterReviewerDetail.payload.indicators.filter(item => item.review.status !== 'approved').map(item => request(
      `/quarterly-review/tasks/${quarterlyTask.id}/indicators/${item.id}/review`, { method: 'POST', token: departmentReviewerLogin.payload.token,
        body: { expectedVersion: item.review.version, status: 'approved', opinion: '已完成季度验收审核。' } })),
    (async () => {
      const otherDetail = await request(`/quarterly-review/tasks/${quarterlyOtherTask.id}`, { token: departmentReviewerLogin.payload.token });
      assert.equal(otherDetail.response.status, 200, JSON.stringify(otherDetail.payload));
      return Promise.all(otherDetail.payload.indicators.filter(item => item.review.status !== 'approved').map(item => request(
        `/quarterly-review/tasks/${quarterlyOtherTask.id}/indicators/${item.id}/review`, { method: 'POST', token: departmentReviewerLogin.payload.token,
          body: { expectedVersion: item.review.version, status: 'approved', opinion: '已完成季度验收审核。' } })));
    })()
  ]);
  const flattenedQuarterReviews = completeQuarterReviews.flat(2);
  assert.ok(flattenedQuarterReviews.every(result => result.response.status === 200), JSON.stringify(flattenedQuarterReviews.map(result => result.payload)));
  const quarterlyScoreResults = await Promise.all([
    ...quarterlyIndicatorItems.filter(item => !item.configuration.exempt && !item.configuration.scoreFormulaVersionId).map(item => request(
      `/quarterly-review/tasks/${quarterlyTask.id}/indicators/${item.id}/score`, { method: 'POST', token: login.payload.token,
        body: { score: item.code === 'QUALITY_DETAIL' ? 18 : 4, expectedVersion: item.scoring?.version || 0 } })),
    (async () => {
      const otherDetail = await request(`/quarterly-review/tasks/${quarterlyOtherTask.id}`, { token: login.payload.token });
      return Promise.all(otherDetail.payload.indicators.filter(item => !item.configuration.exempt && !item.configuration.scoreFormulaVersionId).map(item => request(
        `/quarterly-review/tasks/${quarterlyOtherTask.id}/indicators/${item.id}/score`, { method: 'POST', token: login.payload.token,
          body: { score: 20, expectedVersion: item.scoring?.version || 0 } })));
    })()
  ]);
  const flattenedQuarterScores = quarterlyScoreResults.flat(2);
  assert.ok(flattenedQuarterScores.every(result => result.response.status === 200), JSON.stringify(flattenedQuarterScores.map(result => result.payload)));
  const quarterlyTasksToFinalize = [quarterlyTask.id, quarterlyOtherTask.id];
  const successfulQuarterFinalization = await quarterlyFinalizeRequest(`/quarterly-review/tasks/${quarterlyTask.id}/finalize`,
    login.payload.token, quarterlyTasksToFinalize);
  assert.equal(successfulQuarterFinalization.response.status, 200, JSON.stringify(successfulQuarterFinalization.payload));
  assert.equal(successfulQuarterFinalization.payload.status, 'finalized');
  assert.ok(successfulQuarterFinalization.payload.checkpoint?.checkpointId, 'quarterly finalization returns its recoverable checkpoint reference');
  assert.equal(successfulQuarterFinalization.payload.artifacts.length, quarterlyTasksToFinalize.length);
  const quarterRankingByOrganization = new Map(successfulQuarterFinalization.payload.rankings.map(item => [Number(item.organizationId), item]));
  assert.equal(quarterRankingByOrganization.get(Number(orgA.payload.organizationId)).rank, 2);
  assert.equal(Number(quarterRankingByOrganization.get(Number(orgA.payload.organizationId)).totalScore), 92.5);
  assert.equal(quarterRankingByOrganization.get(Number(orgA.payload.organizationId)).redemptionCoefficient, null);
  assert.equal(quarterRankingByOrganization.get(Number(orgB.payload.organizationId)).rank, 1);
  assert.equal(Number(quarterRankingByOrganization.get(Number(orgB.payload.organizationId)).totalScore), 100);
  assert.equal(quarterRankingByOrganization.get(Number(orgB.payload.organizationId)).redemptionCoefficient, 1.2);
  const dashboardUnauthorized = await request('/management-dashboard');
  assert.equal(dashboardUnauthorized.response.status, 401);
  const dashboardScopedAccount = await request('/admin/users', { method: 'POST', token: login.payload.token, body: {
    username: 'dashboard-scoped-user', name: 'Dashboard Scoped User', password: 'dashboard-scoped-password-1',
    organizationId: orgA.payload.organizationId,
    roles: [{ code: 'subsidiary_filler', organizationId: orgA.payload.organizationId }]
  } });
  assert.equal(dashboardScopedAccount.response.status, 201, JSON.stringify(dashboardScopedAccount.payload));
  const dashboardScopedLogin = await request('/auth/login', { method: 'POST', body: {
    username: 'dashboard-scoped-user', password: 'dashboard-scoped-password-1'
  } });
  assert.equal(dashboardScopedLogin.response.status, 200, JSON.stringify(dashboardScopedLogin.payload));
  const dashboardScopedUser = await request('/management-dashboard', { token: dashboardScopedLogin.payload.token });
  assert.equal(dashboardScopedUser.response.status, 403, 'organization-scoped users cannot query the company-wide dashboard');
  const dashboardBeforeCorrection = await request('/management-dashboard?period=2026-Q4', { token: login.payload.token });
  assert.equal(dashboardBeforeCorrection.response.status, 200, JSON.stringify(dashboardBeforeCorrection.payload));
  assert.equal(dashboardBeforeCorrection.payload.source, 'current_effective_finalized_quarterly_revisions');
  assert.ok(dashboardBeforeCorrection.payload.economics.every(item =>
    typeof item.metrics.revenue.unitCompatible === 'boolean' && typeof item.metrics.profit.unitCompatible === 'boolean'),
  'the API reports whether monthly actuals can be compared in the configured target units');
  const dashboardRankA = dashboardBeforeCorrection.payload.ranking.find(item => Number(item.organizationId) === Number(orgA.payload.organizationId));
  assert.equal(dashboardRankA.rank, 2);
  assert.equal(dashboardRankA.totalScore, 92.5);
  assert.ok(dashboardBeforeCorrection.payload.ranking.every(item => item.revisionId != null));
  const dashboardSnapshot = await request(`/management-dashboard/tasks/${quarterlyTask.id}/snapshot?revisionId=${quarterlyRevision.lastID}`, { token: login.payload.token });
  assert.equal(dashboardSnapshot.response.status, 200, JSON.stringify(dashboardSnapshot.payload));
  assert.equal(dashboardSnapshot.payload.revision.id, quarterlyRevision.lastID);
  assert.ok(Array.isArray(dashboardSnapshot.payload.values));
  await db._helpers.run(db, `UPDATE report_rankings SET rank=1, score_decimal='92.5'
    WHERE package_id=? AND ranking_type='quarterly' AND organization_id IN (?,?)`,
  [quarterlyPackage.payload.package.id, orgA.payload.organizationId, orgB.payload.organizationId]);
  const dashboardTiedRanking = await request('/management-dashboard?period=2026-Q4', { token: login.payload.token });
  assert.equal(dashboardTiedRanking.response.status, 200, JSON.stringify(dashboardTiedRanking.payload));
  assert.deepEqual(dashboardTiedRanking.payload.ranking.map(item => [item.rank, item.totalScore]), [[1, 92.5], [1, 92.5]],
    'the dashboard preserves governed tie ranks and does not recalculate ties');
  await db._helpers.run(db, `UPDATE report_rankings SET rank=2, score_decimal='92.5'
    WHERE package_id=? AND ranking_type='quarterly' AND organization_id=?`,
  [quarterlyPackage.payload.package.id, orgA.payload.organizationId]);
  await db._helpers.run(db, `UPDATE report_rankings SET rank=1, score_decimal='100'
    WHERE package_id=? AND ranking_type='quarterly' AND organization_id=?`,
  [quarterlyPackage.payload.package.id, orgB.payload.organizationId]);
  const automaticQuarterScore = await db._helpers.get(db, `SELECT score_decimal AS score, score_source AS scoreSource,
      formula_version_id AS formulaVersionId FROM quarterly_indicator_scores WHERE revision_id = ?`, [quarterlyOtherRevision.lastID]);
  assert.deepEqual(automaticQuarterScore, { score: '25', scoreSource: 'formula', formulaVersionId: quarterlyFormulaVersion.lastID },
    'quarterly finalization persists the automatic score from the snapshotted formula version');
  const quarterlyFinalStates = await db._helpers.all(db, `SELECT t.id AS taskId, t.task_status AS taskStatus,
      r.id AS revisionId, r.revision_status AS revisionStatus, r.is_current_effective AS currentEffective,
      COUNT(a.id) AS artifactCount FROM report_tasks t JOIN business_revisions r ON r.id = t.current_revision_id
      LEFT JOIN official_artifacts a ON a.revision_id = r.id AND a.artifact_type IN
        ('finalized_workbook_json','finalized_xlsx','finalized_pdf','structured_data_json','version_manifest_json')
      WHERE t.id IN (?, ?) GROUP BY t.id,r.id ORDER BY t.id`, quarterlyTasksToFinalize);
  assert.equal(quarterlyFinalStates.length, 2);
  assert.ok(quarterlyFinalStates.every(row => row.taskStatus === 'finalized' && row.revisionStatus === 'finalized'
    && row.currentEffective === 1 && row.artifactCount === 5), JSON.stringify(quarterlyFinalStates));
  const officialQuarterReferenceReport = await request(`/quarterly-review/packages/${quarterlyPackage.payload.package.id}/official-report`,
    { token: login.payload.token });
  assert.equal(officialQuarterReferenceReport.response.status, 200, JSON.stringify(officialQuarterReferenceReport.payload));
  assert.deepEqual(officialQuarterReferenceReport.payload.referenceWorkbook.sheets.map(sheet => sheet.name), quarterlyReferenceProfile.sheetNames,
    'the finalized reference report returns the exact registered workbook layout for browser export');
  assert.deepEqual(officialQuarterReferenceReport.payload.companies.map(company => company.referenceSheetCode).sort(),
    ['reference_company_a', 'reference_company_b'], 'company mappings resolve to real company tabs in the source workbook');
  assert.deepEqual(officialQuarterReferenceReport.payload.companies.map(company => [company.task.organizationId, company.referenceSheetCode])
    .sort((left, right) => left[0] - right[0]),
    [[orgA.payload.organizationId, 'reference_company_a'], [orgB.payload.organizationId, 'reference_company_b']]);
  const quarterManifestResponse = await fetch(`${await baseUrlReady}/collaboration/tasks/${quarterlyTask.id}/revisions/${quarterlyRevision.lastID}/artifacts/version_manifest_json`, {
    headers: { Authorization: `Bearer ${login.payload.token}` }
  });
  assert.equal(quarterManifestResponse.status, 200);
  assert.match(quarterManifestResponse.headers.get('x-artifact-sha256'), /^[a-f0-9]{64}$/);
  const finalQuarterManifest = await quarterManifestResponse.json();
  assert.equal(finalQuarterManifest.calculationVersion, 'quarterly-score-v1');
  assert.equal(finalQuarterManifest.templateVersionId, Number(quarterlyReferenceVersion.lastID));
  assert.equal(finalQuarterManifest.sourceWorkbookSha256, '0'.repeat(64));
  assert.equal(finalQuarterManifest.rank, 2);
  assert.equal(finalQuarterManifest.redemptionCoefficient, null);
  assert.equal(finalQuarterManifest.quarterlyDependencies.complete, true,
    'quarter finalization snapshots complete monthly dependencies');
  assert.equal(finalQuarterManifest.quarterlyDependencies.months.length, 12,
    'quarter finalization snapshots the exact January-through-December revision sources');
  assert.ok(finalQuarterManifest.quarterlyDependencies.months.every(month => month.revisionId != null),
    'each month in the finalized dependency snapshot has an exact revision ID');
  assert.equal(finalQuarterManifest.artifacts.length, 4);
  const quarterlyOfficialReport = await request(`/quarterly-review/packages/${quarterlyPackage.payload.package.id}/official-report`, { token: login.payload.token });
  assert.equal(quarterlyOfficialReport.response.status, 200, JSON.stringify(quarterlyOfficialReport.payload));
  assert.equal(quarterlyOfficialReport.payload.source, 'quarter_finalization_locked_monthly_revisions');
  assert.equal(quarterlyOfficialReport.payload.companies.length, 2);
  const officialReportCompanyA = quarterlyOfficialReport.payload.companies.find(item => Number(item.task.organizationId) === Number(orgA.payload.organizationId));
  assert.deepEqual(officialReportCompanyA.monthlyDependencies.months.map(month => month.revisionId),
    finalQuarterManifest.quarterlyDependencies.months.map(month => month.revisionId),
  'the official report uses the exact monthly revisions snapshotted for the finalized quarter');
  assert.equal(officialReportCompanyA.ranking.rank, 2);
  const quarterXlsxResponse = await fetch(`${await baseUrlReady}/collaboration/tasks/${quarterlyTask.id}/revisions/${quarterlyRevision.lastID}/artifacts/finalized_xlsx`, {
    headers: { Authorization: `Bearer ${login.payload.token}` }
  });
  assert.equal(quarterXlsxResponse.status, 200);
  assert.match(quarterXlsxResponse.headers.get('x-artifact-sha256'), /^[a-f0-9]{64}$/);
  assert.equal(Buffer.from(await quarterXlsxResponse.arrayBuffer()).subarray(0, 2).toString(), 'PK');

  const quarterlyAdjustmentFields = await request(`/collaboration/tasks/${quarterlyTask.id}/adjustment-fields`, { token: login.payload.token });
  assert.equal(quarterlyAdjustmentFields.response.status, 200, JSON.stringify(quarterlyAdjustmentFields.payload));
  assert.ok(quarterlyAdjustmentFields.payload.fields.some(item => item.fieldCode === approvedTestField.code));
  const quarterlyAdjustmentStarted = await request(`/collaboration/tasks/${quarterlyTask.id}/adjustments`, { method: 'POST', token: login.payload.token,
    body: { fieldCodes: [approvedTestField.code], reason: '更正季度质量指标原始值' } });
  assert.equal(quarterlyAdjustmentStarted.response.status, 201, JSON.stringify(quarterlyAdjustmentStarted.payload));
  assert.equal((await db._helpers.get(db, 'SELECT is_current_effective FROM business_revisions WHERE id=?', [quarterlyRevision.lastID])).is_current_effective, 1,
    'the finalized quarterly revision remains effective while its correction is reviewed');
  assert.equal((await db._helpers.get(db, 'SELECT revision_status FROM business_revisions WHERE id=?', [quarterlyOtherRevision.lastID])).revision_status, 'finalized',
    'the other organization keeps its effective quarterly revision while package correction is pending');
  const quarterlyAdjustmentWorkbookPath = path.join(testRoot, 'artifacts', 'quarterly-adjustment-workbook.json');
  const quarterlyAdjustmentWorkbookJson = JSON.stringify(quarterlyWorkbook);
  fs.writeFileSync(quarterlyAdjustmentWorkbookPath, quarterlyAdjustmentWorkbookJson, 'utf8');
  const quarterlyAdjustmentWorkbookArtifact = await db._helpers.run(db, `INSERT INTO official_artifacts
    (revision_id, artifact_type, storage_key, sha256, byte_size) VALUES (?, 'spreadjs_workbook_json', ?, '2', ?)` ,
  [quarterlyAdjustmentStarted.payload.revisionId, quarterlyAdjustmentWorkbookPath, Buffer.byteLength(quarterlyAdjustmentWorkbookJson)]);
  await db._helpers.run(db, `UPDATE business_revisions SET revision_status='submitted', submitted_by=?, submitted_at=CURRENT_TIMESTAMP,
    workbook_artifact_id=?, collaboration_version=0 WHERE id=?`, [registeredUser.id, quarterlyAdjustmentWorkbookArtifact.lastID, quarterlyAdjustmentStarted.payload.revisionId]);
  await db._helpers.run(db, `INSERT INTO business_values
    (revision_id, task_id, record_key, field_definition_id, value_type, decimal_value, entered_by)
    VALUES (?, ?, 'quarterly:key_business:QUALITY_DETAIL', ?, 'decimal', '15', ?)`,
  [quarterlyAdjustmentStarted.payload.revisionId, quarterlyTask.id, approvedTestField.id, registeredUser.id]);
  const quarterlyAdjustmentSubmission = await require('../src/services/monthlyAdjustments').markAdjustmentSubmitted(db,
    { id: quarterlyTask.id }, quarterlyAdjustmentStarted.payload.revisionId);
  assert.deepEqual(quarterlyAdjustmentSubmission.changedFields, [approvedTestField.code]);
  await db._helpers.run(db, `UPDATE report_tasks SET current_revision_id=?, task_status='submitted' WHERE id=?`,
    [quarterlyAdjustmentStarted.payload.revisionId, quarterlyTask.id]);
  const dashboardWhileCorrectionPending = await request('/management-dashboard?period=2026-Q4', { token: login.payload.token });
  assert.equal(dashboardWhileCorrectionPending.response.status, 200, JSON.stringify(dashboardWhileCorrectionPending.payload));
  assert.equal(dashboardWhileCorrectionPending.payload.ranking.find(item => Number(item.organizationId) === Number(orgA.payload.organizationId)).revisionId,
    Number(quarterlyRevision.lastID), 'the dashboard excludes a submitted correction and keeps the current-effective finalized revision');
  assert.equal(dashboardWhileCorrectionPending.payload.selection.revisionIds.includes(Number(quarterlyAdjustmentStarted.payload.revisionId)), false,
    'the dashboard never includes submitted correction values');
  const correctionReviewDetail = await request(`/quarterly-review/tasks/${quarterlyTask.id}`, { token: departmentReviewerLogin.payload.token });
  assert.equal(correctionReviewDetail.response.status, 200, JSON.stringify(correctionReviewDetail.payload));
  assert.equal(correctionReviewDetail.payload.dataAdjustment.status, 'department_review');
  assert.deepEqual(correctionReviewDetail.payload.dataAdjustment.changedFields, [approvedTestField.code]);
  assert.equal(correctionReviewDetail.payload.indicators.find(item => item.code === 'QUALITY').review.status, 'approved',
    'unaffected quarterly indicator approvals carry forward to the new revision');
  const correctionIndicator = correctionReviewDetail.payload.indicators.find(item => item.code === 'QUALITY_DETAIL');
  const correctionApproved = await request(`/quarterly-review/tasks/${quarterlyTask.id}/indicators/${correctionIndicator.id}/review`, {
    method: 'POST', token: departmentReviewerLogin.payload.token,
    body: { expectedVersion: 0, status: 'approved', opinion: '已复核更正后的季度指标。' }
  });
  assert.equal(correctionApproved.response.status, 200, JSON.stringify(correctionApproved.payload));
  const correctionReadyForManagement = await db._helpers.get(db, 'SELECT status FROM adjustment_requests WHERE id=?',
    [quarterlyAdjustmentStarted.payload.adjustmentRequestId]);
  assert.equal(correctionReadyForManagement.status, 'management_approval');
  const quarterlyCorrectionApproved = await request(`/collaboration/tasks/${quarterlyTask.id}/adjustment-decision`, {
    method: 'POST', token: login.payload.token, body: { decision: 'approve', note: '批准更正并重新计算季度包排名。' }
  });
  assert.equal(quarterlyCorrectionApproved.response.status, 200, JSON.stringify(quarterlyCorrectionApproved.payload));
  const correctedManagementDetail = await request(`/quarterly-review/tasks/${quarterlyTask.id}`, { token: login.payload.token });
  const correctedIndicator = correctedManagementDetail.payload.indicators.find(item => item.code === 'QUALITY_DETAIL');
  const correctedScore = await request(`/quarterly-review/tasks/${quarterlyTask.id}/indicators/${correctedIndicator.id}/score`, {
    method: 'POST', token: login.payload.token, body: { score: 17, expectedVersion: 0 }
  });
  assert.equal(correctedScore.response.status, 200, JSON.stringify(correctedScore.payload));
  const finalizedCorrectedQuarterPackage = await quarterlyFinalizeRequest(`/quarterly-review/tasks/${quarterlyTask.id}/finalize`,
    login.payload.token, quarterlyTasksToFinalize);
  assert.equal(finalizedCorrectedQuarterPackage.response.status, 200, JSON.stringify(finalizedCorrectedQuarterPackage.payload));
  assert.equal(Number(finalizedCorrectedQuarterPackage.payload.rankings.find(item => Number(item.organizationId) === Number(orgA.payload.organizationId)).totalScore), 87.5);
  const quarterlyCorrectionState = await db._helpers.get(db, `SELECT a.status, old.is_current_effective AS oldEffective,
    current.is_current_effective AS currentEffective, current.revision_status AS currentStatus
    FROM adjustment_requests a JOIN business_revisions old ON old.id=a.source_revision_id
    JOIN business_revisions current ON current.id=a.proposed_revision_id WHERE a.id=?`, [quarterlyAdjustmentStarted.payload.adjustmentRequestId]);
  assert.deepEqual(quarterlyCorrectionState, { status: 'applied', oldEffective: 0, currentEffective: 1, currentStatus: 'finalized' });
  assert.equal((await db._helpers.get(db, `SELECT revision_status FROM business_revisions WHERE id=?`, [quarterlyOtherRevision.lastID])).revision_status, 'finalized',
    'package ranking is recalculated without replacing other organizations\' revisions');
  const dashboardAfterCorrection = await request('/management-dashboard?period=2026-Q4&organizationId=' + orgA.payload.organizationId,
    { token: login.payload.token });
  assert.equal(dashboardAfterCorrection.response.status, 200, JSON.stringify(dashboardAfterCorrection.payload));
  assert.equal(dashboardAfterCorrection.payload.ranking.length, 1);
  assert.equal(dashboardAfterCorrection.payload.ranking[0].totalScore, 87.5,
    'the dashboard refresh reads the newly finalized adjustment revision');
  assert.notEqual(dashboardAfterCorrection.payload.ranking[0].revisionId, quarterlyRevision.lastID);

  const rollbackPackage = await request('/period-configuration/packages', { method: 'POST', token: login.payload.token, body: {
    reportTypeId: monthlyType.payload.reportTypeId, periodCode: '2026-12', templateVersionId: templateV3.payload.versionId,
    metricWeights: { revenue: 50, profit: 50 },
    organizations: [{ organizationId: orgA.payload.organizationId }, { organizationId: orgB.payload.organizationId }],
    assignments: assignmentsFor([orgA.payload.organizationId, orgB.payload.organizationId])
  } });
  assert.equal(rollbackPackage.response.status, 201);
  const rollbackId = rollbackPackage.payload.package.id;
  await db._helpers.run(db, `INSERT INTO report_tasks (package_id, report_type_id, organization_id, period_code, deadline_at, configuration_snapshot_json, template_version_id)
    VALUES (?, ?, ?, ?, '2027-01-02T23:59:59+08:00', '{}', ?)`, [rollbackId, monthlyType.payload.reportTypeId, orgB.payload.organizationId, '2026-12', templateV3.payload.versionId]);
  const activationRollback = await request(`/period-configuration/packages/${rollbackId}/activate`, { method: 'POST', token: login.payload.token });
  assert.equal(activationRollback.response.status, 409);
  assert.equal((await db._helpers.get(db, 'SELECT status FROM period_packages WHERE id = ?', [rollbackId])).status, 'draft');
  assert.equal((await db._helpers.get(db, 'SELECT COUNT(*) AS count FROM report_tasks WHERE package_id = ?', [rollbackId])).count, 1,
    'failed generation rolls back tasks created before the conflicting organization');
  assert.equal((await db._helpers.get(db, 'SELECT COUNT(*) AS count FROM collaboration_rooms WHERE task_id IN (SELECT id FROM report_tasks WHERE package_id = ?)', [rollbackId])).count, 0);
  assert.equal((await db._helpers.get(db.collaborationDb, 'SELECT COUNT(*) AS count FROM collaboration_rooms WHERE task_id = ?', [
    (await db._helpers.get(db, 'SELECT id FROM report_tasks WHERE package_id = ? LIMIT 1', [rollbackId])).id
  ])).count, 0);
  const componentList = await request('/template-governance/components', { token: designerLogin.payload.token });
  assert.equal(componentList.payload.components.find(item => item.versionId === bodyComponent.payload.versionId).workbook.columnCount, 3);
  const proposal = { code: 'FIELD_GOVERNANCE_LIFECYCLE', displayName: '生命周期验收字段', type: 'decimal', unit: '人民币元', precision: 2,
    editable: true, applicability: { reportTypes: ['monthly'] } };
  const adminField = await request('/fields/drafts', { method: 'POST', token: login.payload.token, body: { ...proposal, code: 'SYSTEM_ADMIN_DIRECT_FIELD' } });
  assert.equal(adminField.response.status, 201);
  assert.equal(adminField.payload.status, 'approved');
  assert.ok(adminField.payload.fieldDefinitionId);
  assert.equal((await db._helpers.get(db, 'SELECT status FROM field_drafts WHERE id=?', [adminField.payload.draftId])).status, 'approved');
  const submittedDraft = await request('/fields/drafts', { method: 'POST', token: designerLogin.payload.token, body: proposal });
  assert.equal(submittedDraft.response.status, 201);
  const rejected = await request(`/fields/admin/drafts/${submittedDraft.payload.draftId}/reject`, { method: 'POST', token: login.payload.token, body: { reason: '请补充业务适用范围' } });
  assert.equal(rejected.response.status, 200);
  const corrected = await request(`/fields/drafts/${submittedDraft.payload.draftId}`, { method: 'PATCH', token: designerLogin.payload.token,
    body: { applicability: { reportTypes: ['monthly'], organizationTypes: ['subsidiary'] } } });
  assert.equal(corrected.response.status, 200);
  const correctionHistory = await db._helpers.get(db, 'SELECT COUNT(*) AS count FROM field_draft_revisions WHERE draft_id = ?', [submittedDraft.payload.draftId]);
  assert.equal(correctionHistory.count, 2);
  const correctedRevision = await db._helpers.get(db, 'SELECT proposal_json FROM field_draft_revisions WHERE draft_id = ? ORDER BY revision DESC LIMIT 1', [submittedDraft.payload.draftId]);
  assert.deepEqual(JSON.parse(correctedRevision.proposal_json).applicability, { reportTypes: ['monthly'], organizationTypes: ['subsidiary'] });
  const catalogBeforeApproval = await request('/fields/catalog', { token: designerLogin.payload.token });
  assert.equal(catalogBeforeApproval.payload.fields.some(field => field.code === proposal.code), false);
  const approved = await request(`/fields/admin/drafts/${submittedDraft.payload.draftId}/approve`, { method: 'POST', token: login.payload.token, body: {} });
  assert.equal(approved.response.status, 200);
  const selfOwnedDraft = await request('/fields/drafts', { method: 'POST', token: dataAdminLogin.payload.token, body: {
    ...proposal, code: 'FIELD_ADMIN_SELF_CHECK', displayName: '管理员自审校验'
  } });
  const selfApprove = await request(`/fields/admin/drafts/${selfOwnedDraft.payload.draftId}/approve`, { method: 'POST', token: dataAdminLogin.payload.token, body: {} });
  assert.equal(selfApprove.response.status, 403);
  const selfReject = await request(`/fields/admin/drafts/${selfOwnedDraft.payload.draftId}/reject`, { method: 'POST', token: login.payload.token, body: { reason: '确认 maker-checker 阻断后关闭测试草稿' } });
  assert.equal(selfReject.response.status, 200);
  const catalogAfterApproval = await request('/fields/catalog', { token: designerLogin.payload.token });
  assert.equal(catalogAfterApproval.payload.fields.find(field => field.code === proposal.code).type, 'decimal');

  const supersedeProposal = await request(`/fields/admin/fields/${approved.payload.fieldDefinitionId}/supersede`, { method: 'POST', token: dataAdminLogin.payload.token,
    body: { ...proposal, displayName: '验收金额（修订）', precision: 2, reason: '完善字段说明' } });
  assert.equal(supersedeProposal.response.status, 201);
  const supersedeApproval = await request(`/fields/admin/drafts/${supersedeProposal.payload.draftId}/approve`, { method: 'POST', token: login.payload.token, body: {} });
  assert.equal(supersedeApproval.response.status, 200);
  assert.equal(supersedeApproval.payload.fieldDefinitionId, approved.payload.fieldDefinitionId);
  assert.equal(supersedeApproval.payload.version, 2);
  const versions = await request(`/fields/admin/fields/${approved.payload.fieldDefinitionId}/versions`, { token: dataAdminLogin.payload.token });
  assert.deepEqual(versions.payload.versions.map(version => version.version), [2, 1]);
  assert.equal(versions.payload.versions.find(version => version.version === 1).snapshot.displayName, '生命周期验收字段');
  const mappingSchema = await db._helpers.all(db, 'PRAGMA table_info(template_mappings)');
  assert.ok(mappingSchema.some(column => column.name === 'field_definition_version_id'));
  const staleDraftInsert = await db._helpers.run(db, `INSERT INTO field_drafts
    (proposed_code, proposal_json, status, created_by, supersedes_field_id, base_field_version)
    VALUES (?, ?, 'pending', ?, ?, 1)`, [proposal.code, JSON.stringify({ ...proposal, displayName: '过期提案' }), dataAdminInsert.lastID, approved.payload.fieldDefinitionId]);
  const staleApproval = await request(`/fields/admin/drafts/${staleDraftInsert.lastID}/approve`, { method: 'POST', token: login.payload.token, body: {} });
  assert.equal(staleApproval.response.status, 409);

  const sampleTemplate = await db._helpers.run(db, `INSERT INTO templates (name, created_by) VALUES ('Field value sample', ?)`, [registeredUser.id]);
  const sampleTemplateVersion = await db._helpers.run(db, `INSERT INTO template_versions (template_id, version, status, created_by) VALUES (?, 1, 'draft', ?)`, [sampleTemplate.lastID, registeredUser.id]);
  const sampleReportType = await db._helpers.run(db, `INSERT INTO report_types (code, display_name, cadence, workflow_profile, created_by) VALUES ('FIELD_SAMPLE', '字段验收', 'monthly', 'monthly', ?)`, [registeredUser.id]);
  const samplePackage = await db._helpers.run(db, `INSERT INTO period_packages (report_type_id, period_code, template_version_id, created_by) VALUES (?, '2026-09', ?, ?)`, [sampleReportType.lastID, sampleTemplateVersion.lastID, registeredUser.id]);
  const sampleTask = await db._helpers.run(db, `INSERT INTO report_tasks (package_id, report_type_id, organization_id, period_code, deadline_at, configuration_snapshot_json, template_version_id)
    VALUES (?, ?, ?, '2026-09', '2026-10-02T23:59:59+08:00', '{}', ?)`, [samplePackage.lastID, sampleReportType.lastID, orgA.payload.organizationId, sampleTemplateVersion.lastID]);
  await db._helpers.run(db, "UPDATE period_packages SET status='active' WHERE id=?", [samplePackage.lastID]);
  const sampleRevision = await db._helpers.run(db, `INSERT INTO business_revisions (task_id, revision_number, revision_status) VALUES (?, 1, 'draft')`, [sampleTask.lastID]);
  const exactAmount = '12345678901234567890.12';
  const storedAmount = await request('/fields/admin/values', { method: 'POST', token: dataAdminLogin.payload.token, body: {
    taskId: sampleTask.lastID, revisionId: sampleRevision.lastID, fieldDefinitionId: approved.payload.fieldDefinitionId, recordKey: 'summary', value: exactAmount
  } });
  assert.equal(storedAmount.response.status, 200);
  const readAmount = await request(`/fields/admin/values?taskId=${sampleTask.lastID}&revisionId=${sampleRevision.lastID}`, { token: dataAdminLogin.payload.token });
  assert.equal(readAmount.payload.values[0].value, exactAmount);
  const storedZero = await request('/fields/admin/values', { method: 'POST', token: dataAdminLogin.payload.token, body: {
    taskId: sampleTask.lastID, revisionId: sampleRevision.lastID, fieldDefinitionId: approved.payload.fieldDefinitionId, recordKey: 'zero', value: '0'
  } });
  assert.equal(storedZero.payload.value, '0');
  const clearedValue = await request('/fields/admin/values', { method: 'POST', token: dataAdminLogin.payload.token, body: {
    taskId: sampleTask.lastID, revisionId: sampleRevision.lastID, fieldDefinitionId: approved.payload.fieldDefinitionId, recordKey: 'zero', value: null
  } });
  assert.equal(clearedValue.payload.value, null);
  const afterClear = await request(`/fields/admin/values?taskId=${sampleTask.lastID}&revisionId=${sampleRevision.lastID}`, { token: dataAdminLogin.payload.token });
  assert.deepEqual(afterClear.payload.values.map(row => row.value), [exactAmount]);
  const typedExamples = [
    ['integer', '验收计数', 0], ['short_text', '验收短文本', '短文本'], ['long_text', '验收长文本', '较长的业务说明'],
    ['date', '验收日期', '2026-09-23'], ['datetime', '验收时间', '2026-09-23T12:30:00+08:00'],
    ['boolean', '验收布尔值', false], ['enum', '验收枚举', 'ready'],
    ['organization_reference', '验收组织引用', orgA.payload.organizationId], ['user_reference', '验收用户引用', designerInsert.lastID]
  ];
  for (const [type, displayName, value] of typedExamples) {
    const code = `FIELD_TEST_${type.toUpperCase()}`;
    const typedDraft = await request('/fields/drafts', { method: 'POST', token: dataAdminLogin.payload.token, body: {
      code, displayName, type, unit: null, precision: 0, editable: true,
      applicability: {}, ...(type === 'enum' ? { options: ['ready', 'blocked'] } : {})
    } });
    assert.equal(typedDraft.response.status, 201, `${type} proposal failed: ${JSON.stringify(typedDraft.payload)}`);
    const typedApproval = await request(`/fields/admin/drafts/${typedDraft.payload.draftId}/approve`, { method: 'POST', token: login.payload.token, body: {} });
    assert.equal(typedApproval.response.status, 200, `${type} approval failed: ${JSON.stringify(typedApproval.payload)}`);
    const typedWrite = await request('/fields/admin/values', { method: 'POST', token: dataAdminLogin.payload.token, body: {
      taskId: sampleTask.lastID, revisionId: sampleRevision.lastID, fieldDefinitionId: typedApproval.payload.fieldDefinitionId,
      recordKey: type, value
    } });
    assert.equal(typedWrite.response.status, 200, `${type} value write failed: ${JSON.stringify(typedWrite.payload)}`);
  }
  const typedValues = await request(`/fields/admin/values?taskId=${sampleTask.lastID}&revisionId=${sampleRevision.lastID}`, { token: dataAdminLogin.payload.token });
  const typedValueByCode = Object.fromEntries(typedValues.payload.values.map(row => [row.code, row.value]));
  assert.equal(typedValueByCode.FIELD_TEST_INTEGER, 0);
  assert.equal(typedValueByCode.FIELD_TEST_SHORT_TEXT, '短文本');
  assert.equal(typedValueByCode.FIELD_TEST_LONG_TEXT, '较长的业务说明');
  assert.equal(typedValueByCode.FIELD_TEST_DATE, '2026-09-23');
  assert.equal(typedValueByCode.FIELD_TEST_DATETIME, '2026-09-23T12:30:00+08:00');
  assert.equal(typedValueByCode.FIELD_TEST_BOOLEAN, false);
  assert.equal(typedValueByCode.FIELD_TEST_ENUM, 'ready');
  assert.equal(typedValueByCode.FIELD_TEST_ORGANIZATION_REFERENCE, orgA.payload.organizationId);
  assert.equal(typedValueByCode.FIELD_TEST_USER_REFERENCE, designerInsert.lastID);

  const importOptions = await request('/historical-imports/options', { token: dataAdminLogin.payload.token });
  assert.equal(importOptions.response.status, 200);
  assert.ok(importOptions.payload.reportTypes.some(item => item.id === sampleReportType.lastID));
  const deniedImportOptions = await request('/historical-imports/options', { token: orgAdminLogin.payload.token });
  assert.equal(deniedImportOptions.response.status, 403);
  const previewRows = [{ rowNumber: 2, organizationCode: 'HB-WH-A', fieldCode: 'FIELD_TEST_INTEGER', recordKey: 'history-1', value: 41 }];
  const successfulPreview = await historicalImportPreview(dataAdminLogin.payload.token, sampleReportType.lastID, previewRows);
  assert.equal(successfulPreview.response.status, 201);
  assert.equal(successfulPreview.payload.summary.newRecords, 1);
  assert.equal(successfulPreview.payload.status, 'validated');
  const imported = await request(`/historical-imports/${successfulPreview.payload.batchId}/confirm`, { method: 'POST', token: dataAdminLogin.payload.token, body: {} });
  assert.equal(imported.response.status, 200, JSON.stringify(imported.payload));
  assert.equal(imported.payload.imported, 1);
  const importedValues = await db._helpers.all(db, `SELECT v.integer_value, v.entered_by, r.revision_status, ir.row_status, ir.values_json,
      ib.source_name, ib.source_sha256, ib.requested_by, ib.imported_at
    FROM historical_import_rows ir JOIN historical_import_batches ib ON ib.id=ir.batch_id
    JOIN business_values v ON v.revision_id=json_extract(ir.values_json, '$.importedRevisionId')
      AND v.field_definition_id=json_extract(ir.values_json, '$.fieldDefinitionId') AND v.record_key=json_extract(ir.values_json, '$.recordKey')
    JOIN business_revisions r ON r.id=v.revision_id WHERE ib.id=?`, [successfulPreview.payload.batchId]);
  assert.equal(importedValues.length, 1);
  assert.equal(importedValues[0].integer_value, 41);
  assert.equal(importedValues[0].entered_by, dataAdminInsert.lastID);
  assert.equal(importedValues[0].revision_status, 'draft');
  assert.equal(importedValues[0].row_status, 'imported');
  assert.equal(importedValues[0].source_name, 'history.xlsx');
  assert.match(importedValues[0].source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(importedValues[0].requested_by, dataAdminInsert.lastID);
  assert.ok(importedValues[0].imported_at);

  const duplicatePreview = await historicalImportPreview(dataAdminLogin.payload.token, sampleReportType.lastID, previewRows);
  assert.equal(duplicatePreview.payload.summary.duplicates, 1);
  assert.equal(duplicatePreview.payload.summary.blockingErrors, 0);
  const duplicateConfirmed = await request(`/historical-imports/${duplicatePreview.payload.batchId}/confirm`, { method: 'POST', token: dataAdminLogin.payload.token, body: {} });
  assert.equal(duplicateConfirmed.response.status, 200);
  assert.equal(duplicateConfirmed.payload.imported, 0);

  const beforeAtomicFailure = await db._helpers.get(db, 'SELECT COUNT(*) AS count FROM business_values WHERE task_id=?', [sampleTask.lastID]);
  const invalidBatch = await historicalImportPreview(dataAdminLogin.payload.token, sampleReportType.lastID, [
    { rowNumber: 2, organizationCode: 'HB-WH-A', fieldCode: 'FIELD_TEST_INTEGER', recordKey: 'must-not-write', value: 77 },
    { rowNumber: 3, organizationCode: 'HB-WH-A', fieldCode: 'UNKNOWN_FIELD', recordKey: 'bad-field', value: 12 }
  ]);
  assert.equal(invalidBatch.payload.summary.blockingErrors, 1);
  assert.equal(invalidBatch.payload.status, 'rejected');
  const invalidConfirmation = await request(`/historical-imports/${invalidBatch.payload.batchId}/confirm`, { method: 'POST', token: dataAdminLogin.payload.token, body: {} });
  assert.equal(invalidConfirmation.response.status, 409);
  const afterAtomicFailure = await db._helpers.get(db, 'SELECT COUNT(*) AS count FROM business_values WHERE task_id=?', [sampleTask.lastID]);
  assert.equal(afterAtomicFailure.count, beforeAtomicFailure.count);

  await db._helpers.run(db, "UPDATE business_revisions SET revision_status='finalized', is_current_effective=1 WHERE id=?", [sampleRevision.lastID]);
  await db._helpers.run(db, "UPDATE report_tasks SET task_status='finalized' WHERE id=?", [sampleTask.lastID]);
  const finalizedPreview = await historicalImportPreview(dataAdminLogin.payload.token, sampleReportType.lastID, [
    { rowNumber: 2, organizationCode: 'HB-WH-A', fieldCode: 'FIELD_TEST_INTEGER', recordKey: 'after-final', value: 88 }
  ]);
  assert.equal(finalizedPreview.payload.summary.blockingErrors, 1);
  assert.match(finalizedPreview.payload.rows[0].errors.join(' '), /调整流程/);
  console.log('API acceptance passed: identity, audit, field governance, typed values, historical import preview, duplicate detection, atomic confirmation, finalized protection, and template/component lifecycle.');
 } finally {
  await require('../src/controllers/taskOperationsController')._test.stopReminderScheduler();
  await require('../src/services/notificationChannel').close();
  await new Promise(resolve => server.close(resolve));
  await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => db.collaborationDb.close(error => error ? reject(error) : resolve()));
  try { if (process.env.KEEP_ACCEPTANCE_DATA === '1') console.log('Preserved acceptance data:', testRoot);
    else fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
  catch (error) { console.warn(`Temporary acceptance directory cleanup failed: ${error.message}`); }
 }
}

runAcceptance().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
