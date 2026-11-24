const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const validMonthlyPeriod = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
export const monthlyNumber = value => {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
const invalid = () => { throw new Error('报表数据不完整，请重试；若仍失败，请联系管理员检查报表配置。') }
export function readMonthlyReport(value, query) {
  if (!object(value) || value.periodCode !== query.periodCode || !object(value.reportType)
    || String(value.reportType.id) !== String(query.reportTypeId) || !Array.isArray(value.rows)
    || !object(value.totals)
    || (query.configurationPackageId != null && String(value.configurationPackageId) !== String(query.configurationPackageId))) invalid()
  const metrics = values => {
    if (!object(values)) invalid()
    for (const key of ['revenue', 'profit']) {
      const metric = values[key]
      if (!object(metric)) invalid()
      for (const period of ['currentYearToDate', 'priorYearToDate']) {
        const total = metric[period]
        if (!object(total) || typeof total.complete !== 'boolean'
          || !Number.isInteger(total.monthsAvailable) || total.monthsAvailable < 0
          || !Number.isInteger(total.monthsExpected) || total.monthsExpected < total.monthsAvailable) invalid()
      }
    }
  }
  metrics(value.totals)
  const ids = new Set()
  for (const row of value.rows) {
    if (!object(row) || row.organizationId == null || ids.has(String(row.organizationId))
      || !Array.isArray(row.sourceRevisions)
      || row.sourceRevisions.some(source => !object(source) || !validMonthlyPeriod(source.periodCode) || source.revisionId == null)) invalid()
    ids.add(String(row.organizationId))
    metrics(row.metrics)
  }
  if (value.traceability?.sourceWorkbookAdjustments?.candidateCells != null
    && !Array.isArray(value.traceability.sourceWorkbookAdjustments.candidateCells)) invalid()
  // Detach results from the response object; inputs never mutate a displayed report.
  return JSON.parse(JSON.stringify(value))
}
export function monthlyError(error, fallback) {
  if (error?.name === 'AbortError') return '请求超时，请检查网络后重试。'
  if (error?.status === 403) return '没有查看此报表的权限，请联系管理员。'
  if (error?.status === 429) return '请求较频繁，请稍后重试。'
  return error?.message || fallback
}
