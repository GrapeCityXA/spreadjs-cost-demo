const db = require('../config/database');
const { listRoleDefinitions } = require('./roleCatalog');
const all = sql => new Promise((resolve, reject) => db.all(sql, [], (error, rows) => error ? reject(error) : resolve(rows)));
async function permissionOptions() {
  const [users, assignments, departments, definitions] = await Promise.all([
    all(`SELECT u.id, u.name, u.username, o.name AS organizationName,
      CASE WHEN o.organization_type = 'department' AND o.status = 'active' THEN o.code END AS departmentCode
      FROM users u LEFT JOIN organizations o ON o.id = u.organization_id WHERE u.account_status = 'active' ORDER BY u.id`),
    all(`SELECT DISTINCT user_id, role_code AS code, organization_id AS organizationId FROM effective_user_roles
      WHERE effective_from <= CURRENT_TIMESTAMP AND (effective_to IS NULL OR effective_to > CURRENT_TIMESTAMP)`),
    all(`SELECT code, name FROM organizations WHERE organization_type = 'department' AND status = 'active' ORDER BY code`),
    listRoleDefinitions()
  ]);
  return { users: users.map(({ departmentCode, ...user }) => ({ ...user,
    departments: departmentCode ? [departmentCode] : [], roleScopes: assignments.filter(role => role.user_id === user.id)
      .map(({ code, organizationId }) => ({ code, organizationId })) })),
    roles: definitions.filter(role => role.status === 'active').map(({ code, name }) => ({ code, name })), departments };
}
module.exports = { permissionOptions };
