const roleNames = {
  system_admin: '系统管理员', template_designer: '模板设计者', subsidiary_filler: '填报人',
  subsidiary_submitter: '提交人', department_reviewer: '部门审核人', management: '管理人员',
  report_finalizer: '定稿人', score_editor: '评分人', organization_user_admin: '人员管理员',
  data_administrator: '数据管理员', business_rule_administrator: '规则管理员', business_rule_reviewer: '规则审核人'
}
const permissionNames = {
  template: '模板搭建', edit: '报表编辑', formula: '公式维护', comment: '批注管理', view: '报表查看',
  report: '报表填报', review: '报表审核', finalize: '报表定稿', score: '报表评分'
}
const text = value => typeof value === 'string' ? value.trim() : ''

// Presentation only. Route guards and server policies remain the authority for access.
export function homeIdentity(value) {
  const user = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const hasIdentity = Number.isSafeInteger(user.id) && user.id > 0 && Boolean(text(user.username))
  const rolesKnown = Array.isArray(user.roles) && user.roles.every(role => role && typeof role === 'object' && text(role.code))
  const permissionsKnown = Array.isArray(user.permissions) && user.permissions.every(item => text(item))
  const roles = rolesKnown ? [...new Set(user.roles.map(role => text(role.name) || roleNames[text(role.code)] || `未命名角色（${text(role.code)}）`))] : []
  const permissions = permissionsKnown ? [...new Set(user.permissions.map(item => permissionNames[text(item)] || `其他权限（${text(item)}）`))] : []
  return {
    hasIdentity, incomplete: !hasIdentity || !rolesKnown || !permissionsKnown,
    hasRoles: hasIdentity && rolesKnown && roles.length > 0,
    noRoles: hasIdentity && rolesKnown && roles.length === 0,
    name: hasIdentity ? text(user.name) || '未提供姓名' : '暂不可用',
    username: hasIdentity ? text(user.username) : '暂不可用',
    roleLabel: !hasIdentity || !rolesKnown ? '暂未能读取角色' : roles.join('、') || '尚未分配角色',
    permissionText: !hasIdentity || !permissionsKnown ? '暂未能读取权限配置' : permissions.join('、') || '未单独配置'
  }
}

export function deniedAccessDescription(query, username) {
  const firstText = value => text(Array.isArray(value) ? value.find(item => text(item)) : value)
  const account = firstText(query?.account) || username || '当前账号'
  const page = firstText(query?.page) || '目标页面'
  return `该次访问使用账号 ${account}，没有访问「${page}」的权限。请从右上角退出后切换有相应职责的账号，再打开目标页面；也可联系管理员核对角色。`
}
