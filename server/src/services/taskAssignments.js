const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));

async function hasTaskAssignment(connection, task, userId, responsibility) {
  const assignments = await effectiveTaskAssignments(connection, task);
  return assignments.some(item => item.responsibility === responsibility && Number(item.userId) === Number(userId));
}

async function taskResponsibilitiesForUser(connection, task, userId) {
  const assignments = await effectiveTaskAssignments(connection, task);
  return assignments.filter(item => Number(item.userId) === Number(userId))
    .map(item => ({ responsibility: item.responsibility }));
}

async function effectiveTaskAssignments(connection, task) {
  const taskId = typeof task === 'object' ? task.id : task;
  const row = await get(connection, `SELECT t.package_id, t.organization_id, t.configuration_snapshot_json
    FROM report_tasks t WHERE t.id=?`, [taskId]);
  if (!row) return [];
  let snapshot = {};
  try { snapshot = JSON.parse(row.configuration_snapshot_json || '{}'); } catch { snapshot = {}; }
  const configured = Array.isArray(snapshot.assignments) ? snapshot.assignments : null;
  if (configured) {
    return configured.map(item => ({ responsibility: item.responsibility,
      userId: Number(item.userId ?? item.user_id), organizationId: Number(item.organizationId ?? item.organization_id ?? row.organization_id),
      userName: item.userName || item.user_name || null, username: item.username || null }))
      .filter(item => Number.isSafeInteger(item.userId) && item.userId > 0);
  }
  return all(connection, `SELECT pa.responsibility, pa.user_id AS userId, pa.organization_id AS organizationId,
      u.name AS userName, u.username
    FROM package_assignments pa JOIN users u ON u.id=pa.user_id
    WHERE pa.package_id=? AND pa.organization_id=?`, [row.package_id, row.organization_id]);
}

async function taskReviewDepartments(connection, task) {
  const assignments = (await effectiveTaskAssignments(connection, task))
    .filter(item => item.responsibility === 'department_reviewer');
  const userIds = [...new Set(assignments.map(item => Number(item.userId)).filter(Number.isSafeInteger))];
  if (!userIds.length) return [];
  const placeholders = userIds.map(() => '?').join(',');
  const organizationId = typeof task === 'object' ? task.organization_id :
    (await get(connection, 'SELECT organization_id FROM report_tasks WHERE id=?', [task]))?.organization_id;
  if (!organizationId) return [];
  return all(connection, `SELECT DISTINCT COALESCE(department.code,target.code) AS code
    FROM users reviewer JOIN organizations target ON target.id=?
    LEFT JOIN organizations department ON department.id=reviewer.organization_id
      AND department.organization_type='department' AND department.status='active'
    WHERE reviewer.id IN (${placeholders})`, [organizationId, ...userIds]);
}

module.exports = { hasTaskAssignment, taskResponsibilitiesForUser, effectiveTaskAssignments, taskReviewDepartments };
