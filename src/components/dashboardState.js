export function dashboardError(error, subject) {
  if (error?.name === 'TimeoutError') return `${subject}请求超时，请重试。`
  if (error?.status === 401) return '登录已过期，请重新登录。'
  if (error?.status === 403) return `当前账号无权查看${subject}，请联系管理员确认权限。`
  if (error?.status === 404) return `${subject}已不存在或不可用，请刷新看板后重新选择。`
  if (error?.status === 429) return '请求过于频繁，请稍后重试。'
  return `${subject}加载失败，请检查网络后重试。`
}

export function sanitizeMetricConfig(saved) {
  const value = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  const id = key => ['string', 'number'].includes(typeof value[key]) && /^\d+$/.test(String(value[key])) ? value[key] : ''
  return {
    fieldId: id('fieldId'), reportTypeId: id('reportTypeId'), organizationId: id('organizationId'),
    period: typeof value.period === 'string' && value.period.length <= 30 ? value.period : '',
    operation: ['sum', 'average', 'latest'].includes(value.operation) ? value.operation : 'sum',
    group: ['organization', 'period'].includes(value.group) ? value.group : 'organization'
  }
}

export function reconcileMetricConfig(config, { fields, types, values }) {
  const same = (a, b) => String(a) === String(b)
  const next = sanitizeMetricConfig(config)
  const populatedTypes = new Set(values.map(v => String(v.reportTypeId)))
  const reportType = types.find(t => same(t.id, next.reportTypeId)) || types.find(t => populatedTypes.has(String(t.id))) || types[0]
  next.reportTypeId = reportType?.id ?? ''
  const typedValues = values.filter(v => same(v.reportTypeId, next.reportTypeId))
  const populatedFields = new Set(typedValues.map(v => String(v.fieldId)))
  const available = fields.filter(f => populatedFields.has(String(f.id)))
  const field = available.find(f => same(f.id, next.fieldId)) || available[0]
  next.fieldId = field?.id ?? ''
  const scoped = typedValues.filter(v => same(v.fieldId, next.fieldId))
  if (!scoped.some(v => v.period === next.period)) next.period = ''
  next.organizationId = scoped.find(v => same(v.organizationId, next.organizationId))?.organizationId ?? ''
  if (!['decimal', 'integer', 'number'].includes(field?.type)) next.operation = 'latest'
  return next
}

export function formatDashboardDate(value) {
  if (!value) return '未记录时间'
  const date = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value)
  return Number.isNaN(date.getTime()) ? '时间格式不可识别' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium', hour12: false
  }).format(date)
}
