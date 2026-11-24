const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { hasRole } = require('../middleware/auth');
const { recordBusinessAudit, queryBusinessAudit, toCsv } = require('../services/businessAudit');
const { BUILTIN_ROLES, listRoleDefinitions, validateAssignments } = require('../services/roleCatalog');

const GLOBAL_ROLES = new Set(['system_admin', 'management', 'organization_user_admin', 'data_administrator', 'template_designer', 'business_rule_administrator', 'business_rule_reviewer']);
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));

function fail(res, error, fallback) {
  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.message?.includes('UNIQUE constraint failed')) return res.status(409).json({ error: '编码或记录已存在' });
  if (error.message?.includes('CHECK constraint failed')) return res.status(400).json({ error: '提交内容不符合约束' });
  console.error(fallback, error);
  return res.status(500).json({ error: fallback });
}

function validateDates(from, to) {
  const isCalendarDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  return isCalendarDate(from) && (to == null || (isCalendarDate(to) && to >= from));
}

async function assertAliasRangeAvailable(organizationId, alias, from, to) {
  const collision = await get(`SELECT id FROM organization_aliases
    WHERE organization_id = ? AND alias = ? AND COALESCE(effective_to, '9999-12-31') >= ?
      AND COALESCE(?, '9999-12-31') >= effective_from LIMIT 1`, [organizationId, alias, from, to]);
  if (collision) throw Object.assign(new Error('该组织的别名有效期与现有记录重叠'), { code: 'ALIAS_RANGE_CONFLICT' });
}

async function audit(actor, action, entityType, entityId, reason, details = {}) {
  await run(`INSERT INTO audit_logs (action, created_by, actor_user_id, organization_id, entity_type, entity_id, comment, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [action, actor.id, actor.id, actor.organizationId || null,
    entityType, String(entityId), reason || '', JSON.stringify(details)]);
  const version = details.businessVersion ?? (await get(`SELECT COALESCE(MAX(CAST(business_version AS INTEGER)), 0) + 1 AS nextVersion
    FROM business_audit_events WHERE object_type = ? AND object_id = ? AND outcome = 'success'`, [entityType, String(entityId)])).nextVersion;
  await recordBusinessAudit({ actor, action, objectType: entityType, objectId: entityId,
    organizationId: details.organizationId ?? actor.organizationId ?? null,
    businessVersion: String(version), before: details.before ?? null,
    after: details.after ?? details, reason, outcome: 'success' });
}

async function organizationExists(id) {
  return id === null || id === undefined ? null : get('SELECT id, status FROM organizations WHERE id = ?', [id]);
}

async function hasGlobalRoleAssignment(userId) {
  const roleCodes = [...GLOBAL_ROLES];
  const placeholders = roleCodes.map(() => '?').join(', ');
  return Boolean(await get(`SELECT 1 AS found FROM effective_user_roles WHERE user_id = ? AND role_code IN (${placeholders})
    AND effective_to IS NULL LIMIT 1`, [userId, ...roleCodes]));
}

exports.listOrganizations = async (req, res) => {
  try {
    const organizations = await all(`SELECT o.*, p.parent_organization_id AS parentOrganizationId,
      p.effective_from AS parentEffectiveFrom, p.effective_to AS parentEffectiveTo,
      (SELECT json_group_array(json_object('id', a.id, 'alias', a.alias, 'effectiveFrom', a.effective_from, 'effectiveTo', a.effective_to))
       FROM organization_aliases a WHERE a.organization_id = o.id) AS aliases
      FROM organizations o LEFT JOIN organization_relationships p
        ON p.child_organization_id = o.id AND p.effective_to IS NULL
      ORDER BY o.code`);
    res.json({ organizations: organizations.map(org => ({
      ...org, aliases: JSON.parse(org.aliases || '[]')
    })) });
  } catch (error) { fail(res, error, '读取组织列表失败'); }
};

exports.createOrganization = async (req, res) => {
  const { code, name, organizationType = 'company', status = 'active', effectiveFrom,
    effectiveTo = null, parentOrganizationId = null, alias } = req.body;
  if (!code?.trim() || !name?.trim() || !validateDates(effectiveFrom, effectiveTo)) {
    return res.status(400).json({ error: '组织编码、名称及有效日期格式必填，截止日期不得早于起始日期' });
  }
  if (!['company', 'subsidiary', 'department', 'group', 'other'].includes(organizationType) || !['active', 'disabled'].includes(status)) {
    return res.status(400).json({ error: '组织类型或状态无效' });
  }
  try {
    if (parentOrganizationId !== null) {
      const parent = await organizationExists(parentOrganizationId);
      if (!parent || parent.status !== 'active') return res.status(400).json({ error: '上级组织不存在或已停用' });
    }
    await run('BEGIN IMMEDIATE');
    const created = await run(`INSERT INTO organizations (code, name, organization_type, status, effective_from, effective_to)
      VALUES (?, ?, ?, ?, ?, ?)`, [code.trim(), name.trim(), organizationType, status, effectiveFrom, effectiveTo]);
    if (alias?.trim()) await run('INSERT INTO organization_aliases (organization_id, alias, effective_from, effective_to) VALUES (?, ?, ?, ?)',
      [created.lastID, alias.trim(), effectiveFrom, effectiveTo]);
    if (parentOrganizationId !== null) await run(`INSERT INTO organization_relationships
      (parent_organization_id, child_organization_id, effective_from, effective_to) VALUES (?, ?, ?, ?)`,
      [parentOrganizationId, created.lastID, effectiveFrom, effectiveTo]);
    const summary = { code: code.trim(), name: name.trim(), organizationType, status, effectiveFrom, effectiveTo, parentOrganizationId, alias: alias?.trim() || null };
    await audit(req.user, 'organization.create', 'organization', created.lastID, '', { organizationId: created.lastID, before: null, after: summary });
    await run('COMMIT');
    res.status(201).json({ organizationId: created.lastID });
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    fail(res, error, '创建组织失败');
  }
};

exports.updateOrganization = async (req, res) => {
  const id = Number(req.params.id);
  const { name, organizationType, status, effectiveFrom, effectiveTo, parentOrganizationId,
    alias, aliasEffectiveFrom, aliasEffectiveTo, reason } = req.body;
  if (!Number.isInteger(id)) return res.status(400).json({ error: '组织编号无效' });
  if (effectiveFrom !== undefined && !validateDates(effectiveFrom, effectiveTo ?? null)) return res.status(400).json({ error: '组织有效日期无效' });
  if (effectiveTo !== undefined && effectiveTo !== null && effectiveFrom === undefined) {
    const existing = await get('SELECT effective_from FROM organizations WHERE id = ?', [id]);
    if (!existing || !validateDates(existing.effective_from, effectiveTo)) return res.status(400).json({ error: '组织有效日期无效' });
  }
  try {
    const existing = await get('SELECT * FROM organizations WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: '组织不存在' });
    const nextFrom = effectiveFrom ?? existing.effective_from;
    const nextTo = effectiveTo === undefined ? existing.effective_to : effectiveTo;
    if (!validateDates(nextFrom, nextTo)) return res.status(400).json({ error: '组织有效日期无效' });
    if (status !== undefined && !['active', 'disabled'].includes(status)) return res.status(400).json({ error: '组织状态无效' });
    if (organizationType !== undefined && !['company', 'subsidiary', 'department', 'group', 'other'].includes(organizationType)) return res.status(400).json({ error: '组织类型无效' });
    if (parentOrganizationId !== undefined && parentOrganizationId !== null) {
      const parent = await organizationExists(parentOrganizationId);
      if (!parent || parent.status !== 'active' || Number(parentOrganizationId) === id) return res.status(400).json({ error: '上级组织无效' });
      const descendants = await all(`WITH RECURSIVE descendants(id) AS (
        SELECT child_organization_id FROM organization_relationships WHERE parent_organization_id = ? AND effective_to IS NULL
        UNION SELECT r.child_organization_id FROM organization_relationships r JOIN descendants d ON r.parent_organization_id = d.id WHERE r.effective_to IS NULL
      ) SELECT id FROM descendants`, [id]);
      if (descendants.some(row => row.id === Number(parentOrganizationId))) return res.status(400).json({ error: '组织层级不能形成循环' });
    }
    if (alias?.trim()) {
      const from = aliasEffectiveFrom || nextFrom;
      const to = aliasEffectiveTo === undefined ? nextTo : aliasEffectiveTo;
      if (!validateDates(from, to)) return res.status(400).json({ error: '别名有效日期无效' });
      await assertAliasRangeAvailable(id, alias.trim(), from, to);
    }
    let currentParent = await get(`SELECT parent_organization_id AS parentId, effective_from AS effectiveFrom
      FROM organization_relationships WHERE child_organization_id = ? AND effective_to IS NULL`, [id]);
    if (parentOrganizationId !== undefined) {
      if (currentParent && Number(currentParent.parentId) !== Number(parentOrganizationId) && nextFrom <= currentParent.effectiveFrom) {
        return res.status(400).json({ error: '调整上级组织时，新关系的生效日期必须晚于当前关系的起始日期' });
      }
    }
    const currentAliases = await all(`SELECT alias, effective_from AS effectiveFrom, effective_to AS effectiveTo
      FROM organization_aliases WHERE organization_id = ? ORDER BY effective_from, id`, [id]);
    await run('BEGIN IMMEDIATE');
    await run(`UPDATE organizations SET name = ?, organization_type = ?, status = ?, effective_from = ?, effective_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [name?.trim() || existing.name, organizationType || existing.organization_type, status || existing.status, nextFrom, nextTo, id]);
    if (parentOrganizationId !== undefined) {
      if (currentParent && Number(currentParent.parentId) !== Number(parentOrganizationId)) {
        await run('UPDATE organization_relationships SET effective_to = date(?, \'-1 day\') WHERE child_organization_id = ? AND effective_to IS NULL', [nextFrom, id]);
      }
      if (parentOrganizationId !== null && (!currentParent || Number(currentParent.parentId) !== Number(parentOrganizationId))) await run(`INSERT INTO organization_relationships
        (parent_organization_id, child_organization_id, effective_from, effective_to) VALUES (?, ?, ?, ?)`,
        [parentOrganizationId, id, nextFrom, nextTo]);
    }
    if (alias?.trim()) {
      const from = aliasEffectiveFrom || nextFrom;
      const to = aliasEffectiveTo === undefined ? nextTo : aliasEffectiveTo;
      await run('INSERT INTO organization_aliases (organization_id, alias, effective_from, effective_to) VALUES (?, ?, ?, ?)', [id, alias.trim(), from, to]);
    }
    const before = { code: existing.code, name: existing.name, organizationType: existing.organization_type, status: existing.status,
      effectiveFrom: existing.effective_from, effectiveTo: existing.effective_to,
      parentOrganizationId: currentParent?.parentId ?? null, aliases: currentAliases };
    const after = { name: name?.trim() || existing.name, organizationType: organizationType || existing.organization_type,
      status: status || existing.status, effectiveFrom: nextFrom, effectiveTo: nextTo,
      parentOrganizationId: parentOrganizationId === undefined ? currentParent?.parentId ?? null : parentOrganizationId,
      aliases: alias?.trim() ? [...currentAliases, { alias: alias.trim(), effectiveFrom: aliasEffectiveFrom || nextFrom,
        effectiveTo: aliasEffectiveTo === undefined ? nextTo : aliasEffectiveTo }] : currentAliases };
    await audit(req.user, 'organization.update', 'organization', id, reason, { organizationId: id, before, after });
    await run('COMMIT');
    res.json({ message: '组织信息已更新' });
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    if (error.code === 'ALIAS_RANGE_CONFLICT') return res.status(400).json({ error: error.message });
    fail(res, error, '更新组织失败');
  }
};

exports.listUsers = async (req, res) => {
  try {
    const users = await all(`SELECT u.id, u.username, u.name, u.email, u.organization_id AS organizationId,
      o.name AS organizationName, u.account_status AS status, u.created_at AS createdAt
      FROM users u LEFT JOIN organizations o ON o.id = u.organization_id ORDER BY u.username`);
    for (const user of users) user.roles = await all(`SELECT role_code AS code, organization_id AS organizationId,
      effective_from AS effectiveFrom, effective_to AS effectiveTo FROM user_roles
      WHERE user_id = ? AND effective_to IS NULL ORDER BY role_code`, [user.id]);
    const roleDefinitions = await listRoleDefinitions();
    res.json({ users, roles: roleDefinitions.filter(role => role.status === 'active').map(role => role.code), roleDefinitions });
  } catch (error) { fail(res, error, '读取用户列表失败'); }
};

exports.listRoles = async (req, res) => {
  try {
    res.json({ roles: await listRoleDefinitions(), canManage: hasRole(req.user, 'system_admin') });
  } catch (error) { fail(res, error, '读取角色失败'); }
};

exports.saveRole = async (req, res) => {
  const editing = req.method === 'PATCH';
  const code = editing ? req.params.code : req.body.code;
  const { name, description = '', scopeType, capabilities, status = 'active', reason } = req.body;
  if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(code)) return res.status(400).json({ error: '角色编码须为 3–64 位小写字母、数字或下划线，以字母开头' });
  if (BUILTIN_ROLES.some(role => role.code === code)) return res.status(400).json({ error: '内置角色不可覆盖或编辑' });
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || typeof description !== 'string' || description.length > 500) {
    return res.status(400).json({ error: '角色名称必填且最多 64 字，说明最多 500 字' });
  }
  if (!['global', 'organization'].includes(scopeType) || !['active', 'disabled'].includes(status)) return res.status(400).json({ error: '角色范围或状态无效' });
  if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some(code => !BUILTIN_ROLES.some(role => role.code === code && code !== 'system_admin' && role.scopeType === scopeType))) {
    return res.status(400).json({ error: '请选择与角色范围一致的职责权限；系统管理员不作为可组合权限' });
  }
  if (!reason?.trim()) return res.status(400).json({ error: '请填写角色配置原因' });
  try {
    const existing = (await listRoleDefinitions()).find(role => role.code === code);
    if (editing && !existing) return res.status(404).json({ error: '角色不存在' });
    if (!editing && existing) return res.status(409).json({ error: '角色编码已存在' });
    if (editing && scopeType !== existing.scopeType) return res.status(400).json({ error: '角色范围创建后不可更改，请新建另一范围的角色' });
    if (BUILTIN_ROLES.some(role => role.name === name.trim())) return res.status(409).json({ error: '角色名称与内置角色重复' });
    const after = { code, name: name.trim(), description: description.trim(), scopeType, status, capabilities: [...new Set(capabilities)] };
    await run('BEGIN IMMEDIATE');
    if (editing) await run(`UPDATE custom_roles SET name=?, description=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE code=?`,
      [after.name, after.description, status, code]);
    else await run(`INSERT INTO custom_roles(code,name,description,scope_type,status,created_by) VALUES(?,?,?,?,?,?)`,
      [code, after.name, after.description, scopeType, status, req.user.id]);
    await run('DELETE FROM custom_role_capabilities WHERE role_code=?', [code]);
    for (const capability of after.capabilities) await run('INSERT INTO custom_role_capabilities(role_code,capability_code) VALUES(?,?)', [code, capability]);
    await audit(req.user, editing ? 'role.update' : 'role.create', 'role', code, reason.trim(), { before: existing || null, after });
    await run('COMMIT');
    res.status(editing ? 200 : 201).json({ role: after, message: editing ? '角色已更新，新的请求将应用最新权限' : '角色已创建，可在用户账户中分配' });
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    fail(res, error, '保存角色失败');
  }
};

exports.createUser = async (req, res) => {
  const { username, name, password, organizationId, email = null, roles = [], reason = '' } = req.body;
  if (!username?.trim() || !name?.trim() || typeof password !== 'string' || password.length < 10) {
    return res.status(400).json({ error: '用户名、姓名必填，初始密码至少 10 位' });
  }
  if (!Number.isInteger(Number(organizationId)) || !Array.isArray(roles)) return res.status(400).json({ error: '所属组织和角色格式无效' });
  try {
    const invalid = await validateAssignments(roles, req.user);
    if (invalid) return res.status(invalid.status).json({ error: invalid.error });
    const org = await organizationExists(Number(organizationId));
    if (!org || org.status !== 'active') return res.status(400).json({ error: '所属组织不存在或已停用' });
    const hash = await bcrypt.hash(password, 12);
    await run('BEGIN IMMEDIATE');
    const user = await run(`INSERT INTO users (username, password, name, permissions, organization_id, email)
      VALUES (?, ?, ?, '[]', ?, ?)`, [username.trim(), hash, name.trim(), Number(organizationId), email]);
    await assignRoles(user.lastID, roles, req.user.id);
    await audit(req.user, 'user.create', 'user', user.lastID, reason, { organizationId: Number(organizationId), before: null,
      after: { username: username.trim(), name: name.trim(), email, organizationId: Number(organizationId), roles } });
    await run('COMMIT');
    res.status(201).json({ userId: user.lastID });
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    if (error.code === 'INVALID_ROLE_SCOPE') return res.status(400).json({ error: error.message });
    fail(res, error, '创建用户失败');
  }
};

async function assignRoles(userId, roles, grantedBy) {
  await run('UPDATE user_roles SET effective_to = CURRENT_TIMESTAMP WHERE user_id = ? AND effective_to IS NULL', [userId]);
  for (const role of roles) {
    const scope = role.organizationId == null ? null : Number(role.organizationId);
    if (scope !== null) {
      const organization = await organizationExists(scope);
      if (!organization || organization.status !== 'active') throw Object.assign(new Error('角色组织范围不存在或已停用'), { code: 'INVALID_ROLE_SCOPE' });
    }
    await run(`INSERT INTO user_roles (user_id, role_code, organization_id, granted_by)
      VALUES (?, ?, ?, ?)`, [userId, role.code, scope, grantedBy]);
  }
}

exports.updateUser = async (req, res) => {
  const userId = Number(req.params.id);
  const { username, name, email, organizationId, status, reason } = req.body;
  if (username !== undefined && (typeof username !== 'string' || !username.trim() || username.trim().length > 64)) {
    return res.status(400).json({ error: '登录账号不能为空，且最多 64 个字符' });
  }
  if (!Number.isInteger(userId)) return res.status(400).json({ error: '用户编号无效' });
  if (userId === req.user.id && status === 'disabled') return res.status(400).json({ error: '不能停用当前登录账户' });
  if (userId === req.user.id && organizationId !== undefined && Number(organizationId) !== Number(req.user.organizationId)) {
    return res.status(403).json({ error: '不能更改自己的所属组织' });
  }
  if (status !== undefined && !['active', 'disabled'].includes(status)) return res.status(400).json({ error: '账户状态无效' });
  try {
    const current = await get(`SELECT id, username, name, email, organization_id AS organizationId, account_status AS status
      FROM users WHERE id = ?`, [userId]);
    if (!current) return res.status(404).json({ error: '用户不存在' });
    if (username !== undefined && username.trim() !== current.username && !reason?.trim()) {
      return res.status(400).json({ error: '修改登录账号时请填写调整原因' });
    }
    if (!hasRole(req.user, 'system_admin') && await hasGlobalRoleAssignment(userId)) {
      return res.status(403).json({ error: '只有系统管理员可以管理系统级账户' });
    }
    const nextOrganizationId = organizationId === undefined ? current.organizationId : Number(organizationId);
    const org = await organizationExists(nextOrganizationId);
    if (!org || org.status !== 'active') return res.status(400).json({ error: '所属组织不存在或已停用' });
    await run('BEGIN IMMEDIATE');
    await run(`UPDATE users SET username = ?, name = ?, email = ?, organization_id = ?, account_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [username?.trim() || current.username, name?.trim() || current.name,
        email === undefined ? (await get('SELECT email FROM users WHERE id = ?', [userId])).email : email,
        nextOrganizationId, status || current.status, userId]);
    if (status === 'disabled') await run('UPDATE user_roles SET effective_to = CURRENT_TIMESTAMP WHERE user_id = ? AND effective_to IS NULL', [userId]);
    await audit(req.user, 'user.update', 'user', userId, reason, { organizationId: nextOrganizationId,
      before: { username: current.username, name: current.name, email: current.email, organizationId: current.organizationId, status: current.status },
      after: { username: username?.trim() || current.username, name: name?.trim() || current.name, email: email === undefined ? current.email : email,
        organizationId: nextOrganizationId, status: status || current.status } });
    await run('COMMIT');
    res.json({ message: '用户信息已更新' });
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    fail(res, error, '更新用户失败');
  }
};

exports.replaceUserRoles = async (req, res) => {
  const userId = Number(req.params.id);
  const { roles, reason } = req.body;
  if (!Number.isInteger(userId) || !Array.isArray(roles)) return res.status(400).json({ error: '用户编号或角色列表无效' });
  if (userId === req.user.id) return res.status(403).json({ error: '不能修改自己的角色' });
  if (!reason?.trim()) return res.status(400).json({ error: '角色调整原因必填' });
  try {
    const invalid = await validateAssignments(roles, req.user);
    if (invalid) return res.status(invalid.status).json({ error: invalid.error });
    const target = await get('SELECT id, organization_id AS organizationId FROM users WHERE id = ?', [userId]);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (!hasRole(req.user, 'system_admin') && await hasGlobalRoleAssignment(userId)) {
      return res.status(403).json({ error: '只有系统管理员可以管理系统级账户' });
    }
    await run('BEGIN IMMEDIATE');
    const beforeRoles = await all(`SELECT role_code AS code, organization_id AS organizationId FROM user_roles
      WHERE user_id = ? AND effective_to IS NULL ORDER BY role_code, organization_id`, [userId]);
    await assignRoles(userId, roles, req.user.id);
    await audit(req.user, 'user.roles.replace', 'user', userId, reason.trim(), { organizationId: target.organizationId,
      before: { roles: beforeRoles }, after: { roles } });
    await run('COMMIT');
    res.json({ message: '用户角色已更新' });
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    if (error.code === 'INVALID_ROLE_SCOPE') return res.status(400).json({ error: error.message });
    fail(res, error, '更新用户角色失败');
  }
};

exports.resetPassword = async (req, res) => {
  const userId = Number(req.params.id);
  const { password, reason } = req.body;
  if (!Number.isInteger(userId) || typeof password !== 'string' || password.length < 10) return res.status(400).json({ error: '新密码至少 10 位' });
  if (!reason?.trim()) return res.status(400).json({ error: '重置密码原因必填' });
  try {
    const target = await get('SELECT id, organization_id AS organizationId FROM users WHERE id = ?', [userId]);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (!hasRole(req.user, 'system_admin') && await hasGlobalRoleAssignment(userId)) {
      return res.status(403).json({ error: '只有系统管理员可以管理系统级账户' });
    }
    const hash = await bcrypt.hash(password, 12);
    await run('BEGIN IMMEDIATE');
    await run('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [hash, userId]);
    await audit(req.user, 'user.password.reset', 'user', userId, reason.trim(), { organizationId: target.organizationId,
      before: { passwordSet: true }, after: { passwordChanged: true } });
    await run('COMMIT');
    res.json({ message: '密码已重置' });
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    fail(res, error, '重置密码失败');
  }
};

exports.listAuditEvents = async (req, res) => {
  try {
    const events = await queryBusinessAudit(req.query, req.query.limit || 100);
    res.json({ events });
  } catch (error) {
    res.status(400).json({ error: error.message || '审计筛选条件无效' });
  }
};

exports.exportAuditEvents = async (req, res) => {
  try {
    const events = await queryBusinessAudit(req.query, null);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="business-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store'
    });
    res.send(toCsv(events));
  } catch (error) {
    res.status(400).json({ error: error.message || '审计筛选条件无效' });
  }
};
