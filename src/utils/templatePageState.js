// Retain workflow context without leaking an old editor/version selection.
export function templateWorkflowQuery(route, extra = {}) {
  const query = route?.query || {}
  return { ...Object.fromEntries(['workflowFrom', 'workflowType', 'workflowStatus']
    .filter(key => typeof query[key] === 'string').map(key => [key, query[key]])), ...extra }
}

export function templateCellError(formula, value, CalcError) {
  if (typeof formula === 'string' && /#REF!/i.test(formula)) return true
  // SpreadJS returns CalcError objects for evaluated formula failures.
  if (CalcError && value instanceof CalcError) return true
  return typeof value === 'string' && /^#(?:REF!|VALUE!|DIV\/0!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!)(?:$|\s)/i.test(value)
}

export function templateWriteError(error, action) {
  if (!error?.status) return `${action}结果尚未确认，请先刷新列表核对状态，避免重复操作。`
  if (error.status === 409) return '版本状态已变化，请刷新列表后重新确认。'
  if (error.status === 401) return '登录已过期，请重新登录。'
  if (error.status === 403) return '没有操作权限，请联系模板维护人或管理员。'
  if (error.status === 429) return '操作过于频繁，请稍后重试。'
  return String(error.message || `${action}失败，请稍后重试。`)
}
