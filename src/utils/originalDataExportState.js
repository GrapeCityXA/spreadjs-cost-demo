const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' })

export function exportTimestamp(value) {
  if (!value) return NaN
  const text = String(value).trim()
  // SQLite CURRENT_TIMESTAMP is UTC, but omits the timezone suffix.
  return Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text)
}

export function formatExportDate(value) {
  const time = exportTimestamp(value)
  return Number.isFinite(time) ? formatter.format(time) : '—'
}

export function canManageExports(user) {
  return Array.isArray(user?.roles) && user.roles.some(role => role && ['system_admin', 'management'].includes(role.code) && role.organizationId == null)
}

export function exportJobState(job, now = Date.now()) {
  return job.status === 'complete' && exportTimestamp(job.expiresAt) <= now ? 'expired' : job.status
}

export function exportErrorMessage(error, fallback) {
  if (error?.status === 401) return '登录已失效，请重新登录。'
  if (error?.status === 403) return '当前账户无权执行此操作，请联系管理员确认权限。'
  if (error?.status === 429) return '操作过于频繁，请稍后重试。'
  if (error?.status === 410) return '下载已过期，请重新创建导出任务。'
  if (error?.status >= 500) return '服务暂时不可用，请稍后重试。'
  if (error instanceof TypeError) return '网络连接失败，请检查连接后重试。'
  return error?.message || fallback
}
