// Keep request ownership separate from visible loading indicators.
export function createWorkflowRequest({ request, start, success, failure, finish, timeoutMs = 15000 }) {
  let active, disposed = false, queued = false
  function cancel() { active?.controller.abort(); active = null; queued = false }
  async function run(quiet = false) {
    if (disposed) return
    if (active && quiet) { queued = true; return }
    if (active) cancel()
    const current = { controller: new AbortController() }
    active = current
    start(quiet)
    let timedOut = false
    const aborted = new Promise((_, reject) => current.controller.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error(), { name: timedOut ? 'TimeoutError' : 'AbortError' }))
    }, { once: true }))
    const timer = setTimeout(() => { timedOut = true; current.controller.abort() }, timeoutMs)
    try {
      const result = await Promise.race([request(current.controller.signal), aborted])
      if (active === current && !disposed) success(result)
    } catch (error) {
      if (active === current && !disposed) failure(error)
    } finally {
      clearTimeout(timer)
      if (active === current && !disposed) {
        active = null; finish()
        if (queued) { queued = false; void run(true) }
      }
    }
  }
  return { run, dispose() { disposed = true; cancel() } }
}

export function workflowError(error) {
  if (error?.name === 'TimeoutError') return '流程列表加载超时，请重试。'
  if (error?.name === 'InvalidWorkflowResponse') return '流程数据格式异常，请重试；若仍失败，请联系管理员。'
  if (error?.status === 401) return '登录已过期，请重新登录。'
  if (error?.status === 403) return '当前账号无权读取流程列表，请联系管理员确认权限。'
  if (error?.status === 429) return '刷新过于频繁，请稍后重试。'
  return '流程列表加载失败，请检查网络后重试。'
}

export function normalizeWorkflowResult(result) {
  const invalid = () => { throw Object.assign(new Error(), { name: 'InvalidWorkflowResponse' }) }
  if (!result || !Array.isArray(result.items) || typeof result.canManage !== 'boolean') invalid()
  const ids = new Set()
  const items = result.items.map(row => {
    if (!row || !['number', 'string'].includes(typeof row.id) || !String(row.id) || ids.has(String(row.id))) invalid()
    ids.add(String(row.id))
    const next = { ...row }
    for (const key of ['name', 'kind', 'period', 'organization', 'initiator', 'stage', 'assignees', 'statusLabel']) {
      next[key] = typeof row[key] === 'string' && row[key].trim() ? row[key] : '—'
    }
    next.deadline = typeof row.deadline === 'string' ? row.deadline : null
    next.target = typeof row.target === 'string' ? row.target : null
    next.version = ['number', 'string'].includes(typeof row.version) ? row.version : null
    return next
  })
  const counts = Object.fromEntries(['todo', 'initiated', 'handled', 'manage'].map(key =>
    [key, items.filter(row => row[key === 'manage' ? 'manageable' : key]).length]))
  return { items, counts, canManage: result.canManage }
}

export function formatWorkflowDate(value) {
  if (typeof value !== 'string' || !value.trim()) return '—'
  const date = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? value.replace(' ', 'T') + 'Z' : value)
  return Number.isNaN(date.getTime()) ? '时间格式异常' : date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  })
}
