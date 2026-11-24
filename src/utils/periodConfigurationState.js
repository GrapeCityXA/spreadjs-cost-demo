const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const records = value => Array.isArray(value) && value.every(record)

export function readPeriodResources(value) {
  if (!record(value) || !['organizations', 'users', 'templates', 'fields', 'rules'].every(key => records(value[key]))) {
    throw new Error('配置资源返回不完整，请刷新重试。')
  }
  return { ...value, ruleThresholdDefaults: record(value.ruleThresholdDefaults) ? value.ruleThresholdDefaults : {} }
}

export function readPeriodList(value) {
  if (!records(value) || value.some(item => item.id == null || !records(item.organizations) || !records(item.targets) || !records(item.assignments) || !record(item.configuration))) {
    throw new Error('填报计划列表返回不完整，请刷新重试。')
  }
  return value
}

export function restorePeriodForm(base, saved) {
  if (!record(saved)) throw new Error('草稿内容不完整，请刷新后重新打开。')
  const copy = JSON.parse(JSON.stringify(saved))
  for (const key of ['targets', 'indicators', 'assignments']) {
    if (copy[key] != null && !records(copy[key])) throw new Error('草稿行数据不完整，请刷新后重新打开。')
  }
  for (const key of ['organizationIds', 'ruleVersionIds']) {
    if (copy[key] != null && !Array.isArray(copy[key])) throw new Error('草稿选项不完整，请刷新后重新打开。')
  }
  const result = { ...base, ...copy }
  for (const key of ['targets', 'indicators', 'assignments', 'organizationIds', 'ruleVersionIds']) result[key] = copy[key] ?? base[key]
  for (const key of ['deadlines', 'metricWeights', 'ruleThresholds', 'configuration']) {
    if (copy[key] != null && !record(copy[key])) throw new Error('草稿配置不完整，请刷新后重新打开。')
    result[key] = { ...base[key], ...copy[key] }
  }
  result.configuration.referenceCompanySheets = { ...(record(result.configuration.referenceCompanySheets) ? result.configuration.referenceCompanySheets : {}) }
  return result
}

export function periodError(error, fallback = '操作未完成，请稍后重试。') {
  return typeof error?.message === 'string' && error.message.trim() ? error.message : fallback
}

export function periodValidationErrors(result) {
  return Array.isArray(result?.errors) && result.errors.some(item => typeof item === 'string' && item.trim())
    ? result.errors.filter(item => typeof item === 'string').join('；') : '配置暂未通过校验，请检查周期、模板、组织和责任人后重试。'
}
