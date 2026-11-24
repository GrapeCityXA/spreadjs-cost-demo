export const cleanAuditQuery = filters => Object.fromEntries(Object.entries(filters)
  .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])
  .filter(([, value]) => value !== '' && value != null))

export const sameQuery = (a, b) => JSON.stringify(cleanAuditQuery(a)) === JSON.stringify(cleanAuditQuery(b))

export function localDate() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function validateAdminForm(kind, form, { originalUsername, scope = () => null } = {}) {
  const errors = {}
  const required = (key, label) => { if (!String(form[key] ?? '').trim()) errors[key] = `请填写${label}` }
  if (kind === 'organization') {
    required('code', '组织编码'); required('name', '组织名称'); required('effectiveFrom', '生效日期')
    if (form.effectiveTo && form.effectiveTo < form.effectiveFrom) errors.effectiveTo = '失效日期不得早于生效日期'
  }
  if (kind === 'user') {
    required('username', '登录名'); required('name', '姓名')
    if (!form.organizationId) errors.organizationId = '请选择所属组织'
    if (!form.id && (form.password || '').length < 10) errors.password = '初始密码至少 10 位'
    if (form.id && (form.status === 'disabled' || form.username?.trim() !== originalUsername?.trim())) required('reason', '调整原因')
  }
  if (kind === 'roleDefinition') {
    required('name', '角色名称'); required('reason', '配置原因')
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(form.code || '')) errors.code = '使用 3–64 位小写字母、数字或下划线，并以字母开头'
    if (!form.capabilities?.length) errors.capabilities = '请至少选择一项职责权限'
  }
  if (kind === 'roles') {
    required('reason', '调整原因')
    const seen = new Set()
    for (const role of form.assignments) {
      if (!role.code || !scope(role.code) || (scope(role.code) !== 'global' && !role.organizationId)) {
        errors.assignments = '请选择角色，并为组织职责指定范围'; break
      }
      const key = `${role.code}:${scope(role.code) === 'global' ? '' : role.organizationId}`
      if (seen.has(key)) { errors.assignments = '同一角色和组织范围不能重复添加'; break }
      seen.add(key)
    }
  }
  if (kind === 'password') {
    if ((form.password || '').length < 10) errors.password = '新密码至少 10 位'
    required('reason', '重置原因')
  }
  return errors
}
