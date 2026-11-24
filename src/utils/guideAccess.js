// Cached identity only controls which convenience links the guide displays.
// Entering a business route still requires the router's server identity check.
export function canShowGuideEntry(user, meta) {
  if (!user || typeof user !== 'object' || Array.isArray(user) || !user.id) return false
  const roles = Array.isArray(user.roles)
    ? user.roles.filter(role => role && typeof role.code === 'string').map(role => role.code)
    : []
  const permissions = Array.isArray(user.permissions)
    ? user.permissions.filter(permission => typeof permission === 'string')
    : []
  if (roles.includes('system_admin')) return true
  if (meta.requiresPermission && !permissions.includes(meta.requiresPermission)
    && !(meta.requiresPermission === 'template' && roles.includes('template_designer'))) return false
  if (meta.requiresRole && !roles.includes(meta.requiresRole)) return false
  return !meta.requiresAnyRole || meta.requiresAnyRole.some(role => roles.includes(role))
}
