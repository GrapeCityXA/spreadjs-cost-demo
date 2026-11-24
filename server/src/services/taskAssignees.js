const rolesByResponsibility = {
  filler: ['subsidiary_filler'], submitter: ['subsidiary_submitter'],
  department_reviewer: ['department_reviewer'], finalizer: ['report_finalizer']
};

// The picker and the write endpoint use the same scope and effective-date rules.
function listTaskAssignees(db, organizationId, responsibility, userId = null) {
  const roles = rolesByResponsibility[responsibility];
  if (!roles) return Promise.resolve([]);
  const sql = `SELECT u.id, u.name, u.username FROM users u
    WHERE u.account_status='active' ${userId == null ? '' : 'AND u.id=?'}
    AND EXISTS (SELECT 1 FROM effective_user_roles r WHERE r.user_id=u.id
      AND (r.role_code IN (${roles.map(() => '?').join(',')})
        AND (r.organization_id=? OR (r.role_code='department_reviewer' AND r.organization_id=u.organization_id
          AND EXISTS (SELECT 1 FROM organizations d WHERE d.id=r.organization_id AND d.organization_type='department'))))
      AND r.effective_from<=CURRENT_TIMESTAMP AND (r.effective_to IS NULL OR r.effective_to>CURRENT_TIMESTAMP))
    ORDER BY u.name, u.id`;
  return new Promise((resolve, reject) => db.all(sql, [...(userId == null ? [] : [userId]), ...roles, organizationId],
    (error, rows) => error ? reject(error) : resolve(rows)));
}

module.exports = { listTaskAssignees };
