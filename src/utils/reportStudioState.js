export const emptyStudioState = () => ({ templates: [], schedules: [], jobs: [], organizations: [], reportTypes: [], capabilities: {} })

// List responses are immutable snapshots. Reuse unchanged rows and collections
// so polling does not invalidate table filtering, sorting and summary rendering.
const rowSignatures = new WeakMap()
function signature(row) {
  if (!rowSignatures.has(row)) rowSignatures.set(row, JSON.stringify(row))
  return rowSignatures.get(row)
}
export function reconcileStudioState(previous, incoming) {
  const next = { ...incoming }
  for (const key of ['templates', 'schedules', 'jobs', 'organizations', 'reportTypes']) {
    const before = previous[key]
    const byId = new Map(before.map(row => [String(row.id), row]))
    const rows = incoming[key].map(row => {
      const old = byId.get(String(row.id))
      return old && signature(old) === signature(row) ? old : row
    })
    next[key] = rows.length === before.length && rows.every((row, index) => row === before[index]) ? before : rows
  }
  if (JSON.stringify(previous.capabilities) === JSON.stringify(incoming.capabilities)) next.capabilities = previous.capabilities
  return Object.keys(next).every(key => next[key] === previous[key]) ? previous : next
}

export function observeStudioWidth(host, update, Observer = globalThis.ResizeObserver) {
  if (!host || !Observer) return () => {}
  const observer = new Observer(entries => {
    const entry = entries.find(item => item.target === host)
    if (entry) update(entry.contentRect.width)
  })
  observer.observe(host)
  return () => observer.disconnect()
}

export function normalizeStudioState(value) {
  const invalid = () => { throw new Error('报表列表数据格式异常，请刷新后重试。') }
  if (!value || !value.capabilities || typeof value.capabilities !== 'object') invalid()
  const next = emptyStudioState()
  for (const key of ['templates', 'schedules', 'jobs', 'organizations', 'reportTypes']) {
    if (!Array.isArray(value[key])) invalid()
    const ids = new Set()
    next[key] = value[key].map(row => {
      if (!row || !Number.isSafeInteger(Number(row.id)) || Number(row.id) < 1 || ids.has(String(row.id))) invalid()
      ids.add(String(row.id))
      return { ...row, ...(key === 'jobs' ? { query: row.query && typeof row.query === 'object' ? row.query : {} } : {}) }
    })
  }
  next.capabilities = Object.fromEntries(['design', 'manage', 'approve'].map(key => [key, value.capabilities[key] === true]))
  return next
}

export function validateStudioForm(form, mode, state) {
  const errors = {}
  const template = state.templates.find(t => t.id === form.templateId && t.status === 'published')
  if (!template) errors.templateId = '请选择已发布的报表模板'
  if (!state.reportTypes.some(t => t.id === form.reportTypeId && t.cadence === 'monthly')) errors.reportTypeId = '请选择有效的月度填报类型'
  if (template?.sourceReportTypeId && template.sourceReportTypeId !== form.reportTypeId) errors.reportTypeId = '填报类型须与模板的数据来源一致'
  if (!Array.isArray(form.organizationIds) || !form.organizationIds.length) errors.organizationIds = '请选择至少一个组织'
  else if (form.organizationIds.some(id => !state.organizations.some(o => o.id === id))) errors.organizationIds = '所选组织已不可用，请重新选择'
  if (mode === 'generate' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(form.periodCode || '')) errors.periodCode = '请选择有效的报告月份'
  if (mode === 'schedule') {
    if (String(form.name || '').trim().length > 120) errors.name = '计划名称最多 120 个字符'
    if (!Number.isInteger(form.day) || form.day < 1 || form.day > 28) errors.day = '请选择每月 1–28 日'
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time || '')) errors.time = '请选择有效的北京时间'
    if (![-1, 0].includes(form.monthOffset)) errors.monthOffset = '请选择上月或当月'
  }
  return errors
}

export function studioError(error, mutation = false) {
  if (error?.status === 401) return '登录已过期，请重新登录后继续。'
  if (error?.status === 403) return '当前账号无权执行此操作，请刷新或联系管理员确认权限。'
  if (error?.status === 429) return '操作过于频繁，请稍后重试。'
  if (mutation && (error?.name === 'TimeoutError' || error instanceof TypeError || error?.status >= 500 || error?.status === 200)) return '未能确认操作结果。请先刷新列表核对记录，避免重复提交。'
  if (error?.name === 'TimeoutError') return '加载超时，请检查网络后重试。'
  if (error instanceof TypeError) return '网络连接失败，请检查网络后重试。'
  return error?.message || '操作未完成，请刷新后重试。'
}

export function beijingMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(now)
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`
}
