const db = require('../config/database');

const all = (sql, params) => new Promise((resolve, reject) => db.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));

async function departmentCodesFor(user) {
  const id = user.organizationId ?? user.organization_id;
  if (id == null || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) return [];
  const rows = await all(`SELECT code FROM organizations WHERE organization_type = 'department' AND status = 'active'
    AND id = ?`, [Number(id)]);
  return rows.map(row => row.code);
}

function identityFor(user, organizationId) {
  return { userId: Number(user.id), roles: (user.roles || []).filter(role => role.organizationId == null
    || Number(role.organizationId) === Number(organizationId)).map(role => role.code),
  departments: user.departmentCodes || [] };
}

module.exports = { departmentCodesFor, identityFor };
