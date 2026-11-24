export const ruleTab = section => section === 'functions' ? 'formula' : section === 'anomaly' ? 'anomaly' : 'all'
export const copyRuleData = value => JSON.parse(JSON.stringify(value))

export function normalizeRules(response) {
  if (!Array.isArray(response?.rules)) throw new Error('规则目录返回格式异常，请重试。')
  return response.rules.map(row => {
    if (!row || !Number.isSafeInteger(Number(row.versionId)) || Number(row.versionId) <= 0 || !Number.isSafeInteger(Number(row.ruleId)) || Number(row.ruleId) <= 0) {
      throw new Error('规则目录包含无效的版本信息，请重试。')
    }
    return { ...row, versionId: Number(row.versionId), ruleId: Number(row.ruleId),
      displayName: typeof row.displayName === 'string' ? row.displayName : '未命名规则',
      code: typeof row.code === 'string' ? row.code : '',
      testCases: Array.isArray(row.testCases) ? row.testCases : [],
      parameters: row.parameters && typeof row.parameters === 'object' && !Array.isArray(row.parameters) ? row.parameters : {} }
  })
}

export function validateRuleIdentity(form) {
  const errors = {}
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(String(form.code || '').trim().toUpperCase())) errors.code = '请输入 2–64 位编码，以英文字母开头，仅含英文字母、数字或下划线。'
  if (!String(form.displayName || '').trim() || form.displayName.length > 120) errors.displayName = '请填写规则名称，最多 120 个字符。'
  return errors
}

export function ruleFailure(error, write = false) {
  const status = Number(error?.status)
  if (write && (!status || status >= 500 || status === 408)) return {
    uncertain: true, message: '尚未确认操作结果，输入已保留。请先到规则目录核对该编码和版本状态，不要重复提交；关闭后可刷新目录核对。'
  }
  if (error?.name === 'AbortError') return { message: '读取超时或已中断，请重试。' }
  if (!status && error?.name === 'TypeError') return { message: '无法连接规则服务，请检查网络后重试。' }
  if (status === 401) return { message: '登录已失效，请重新登录。' }
  if (status === 403) return { message: '当前账户无权执行此操作，请确认权限后重试。' }
  if (status === 404) return { message: '规则或版本已不可用，请刷新目录后重新查看。' }
  if (status === 409) return { message: error.message || '版本状态已变化，请刷新目录后重新打开。' }
  if (status === 429) return { message: '操作过于频繁，请稍后重试。' }
  return { message: status >= 500 ? '规则服务暂时不可用，请稍后重试。' : error?.message || '读取失败，请检查网络后重试。' }
}

// A timed-out write may have committed; callers must not automatically retry it.
export async function ruleRequest(fetcher, { signal, timeoutMs = 30000 } = {}) {
  const controller = new AbortController()
  let timer, abort
  const interrupted = new Promise((_, reject) => {
    abort = () => { controller.abort(); reject(Object.assign(new Error('请求已中断'), { name: 'AbortError' })) }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(abort, timeoutMs)
  })
  try {
    if (signal?.aborted) return await interrupted
    return await Promise.race([Promise.resolve().then(() => fetcher(controller.signal)), interrupted])
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
