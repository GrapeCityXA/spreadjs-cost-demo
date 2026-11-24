const db = require('../config/database');

// Custom roles combine existing workflow capabilities; organization-scoped
// capabilities retain their scope and still require task responsibility assignments.
const BUILTIN_ROLES = [
  ['system_admin', '系统管理员', 'global', '管理全部系统配置和数据'],
  ['organization_user_admin', '组织用户管理员', 'global', '管理组织、用户及组织职责分配'],
  ['management', '管理部门', 'global', '周期配置、责任调度、经营分析及管理审批'],
  ['data_administrator', '数据管理员', 'global', '治理和审批字段目录'],
  ['template_designer', '模板设计师', 'global', '设计模板、组件及提出字段提案'],
  ['business_rule_administrator', '业务规则管理员', 'global', '维护规则和公式草稿'],
  ['business_rule_reviewer', '业务规则复核员', 'global', '复核业务规则和公式'],
  ['subsidiary_filler', '组织填报人', 'organization', '编辑分配给自己的组织填报任务'],
  ['subsidiary_submitter', '组织提交人', 'organization', '提交、撤回分配的任务并查看编辑历史'],
  ['department_reviewer', '部门审核人', 'organization', '审核分配的任务及部门指标'],
  ['score_editor', '评分编辑人', 'organization', '编辑分配任务的评分'],
  ['report_finalizer', '报告定稿人', 'organization', '定稿分配的报告并查看参考报表'],
  ['leader', '领导查看', 'organization', '查看组织授权范围内的报表']
].map(([code, name, scopeType, description]) => ({ code, name, scopeType, description,
  builtin: true, status: 'active', capabilities: [code] }));

async function listRoleDefinitions() {
  const custom = await db._helpers.all(db, `SELECT code, name, description, scope_type AS scopeType,
    status, created_at AS createdAt, updated_at AS updatedAt FROM custom_roles ORDER BY created_at, code`);
  for (const role of custom) {
    role.builtin = false;
    role.capabilities = (await db._helpers.all(db,
      'SELECT capability_code FROM custom_role_capabilities WHERE role_code = ? ORDER BY capability_code',
      [role.code])).map(row => row.capability_code);
  }
  return [...BUILTIN_ROLES, ...custom];
}

async function validateAssignments(roles, actor) {
  const definitions = new Map((await listRoleDefinitions()).map(role => [role.code, role]));
  const seen = new Set();
  for (const assignment of roles) {
    const definition = definitions.get(assignment?.code);
    if (!definition || definition.status !== 'active') return { status: 400, error: '角色不存在或已停用' };
    if (definition.scopeType === 'global' && !actor.roles.some(role => role.code === 'system_admin')) {
      return { status: 403, error: '只有系统管理员可以授予系统级角色' };
    }
    const scope = assignment.organizationId;
    if (definition.scopeType === 'global' ? scope != null : !Number.isSafeInteger(Number(scope)) || Number(scope) <= 0) {
      return { status: 400, error: definition.scopeType === 'global' ? '系统级职责不能绑定组织范围' : '该角色必须绑定有效组织范围' };
    }
    const key = `${assignment.code}:${scope ?? 'global'}`;
    if (seen.has(key)) return { status: 400, error: '不能重复分配相同角色和组织范围' };
    seen.add(key);
  }
  return null;
}

module.exports = { BUILTIN_ROLES, listRoleDefinitions, validateAssignments };
