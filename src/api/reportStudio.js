import { API_BASE_URL as base } from './base'
async function request(path, init, { signal, timeoutMs = 30000 } = {}, binary = false) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  let timedOut = false
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; abort() }, timeoutMs)
  try {
    const response = await fetch(`${base}/report-studio${path}`, { ...init, signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` } })
    if (binary && response.ok) return await response.blob()
    let result
    try { result = await response.json() } catch (error) {
      if (controller.signal.aborted) throw error
      throw Object.assign(new Error('服务返回了无法读取的数据，请稍后刷新。'), { status: response.status })
    }
    if (!response.ok) throw Object.assign(new Error(typeof result?.error === 'string' ? result.error : '报表操作失败'), { status: response.status })
    return result
  } catch (error) {
    if (timedOut) throw Object.assign(new Error('请求超时'), { name: 'TimeoutError' })
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
function call(path, body, method = 'POST', options) {
  return request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, options)
}
async function upload(path, formData, { signal, timeoutMs = 120000 } = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  let timedOut = false
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; abort() }, timeoutMs)
  try {
    const response = await fetch(`${base}/report-studio${path}`, { method: 'POST', body: formData, signal: controller.signal,
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
    let result
    try { result = await response.json() } catch { throw Object.assign(new Error('服务返回了无法读取的数据，请稍后刷新。'), { status: response.status }) }
    if (!response.ok) throw Object.assign(new Error(typeof result?.error === 'string' ? result.error : '报表成果上传失败'), { status: response.status })
    return result
  } catch (error) {
    if (timedOut) throw Object.assign(new Error('报表成果上传超时，请重试'), { name: 'TimeoutError' })
    throw error
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
export const reportStudioApi = {
  list: options => call('', undefined, 'GET', options), template: (id, options) => call(`/templates/${id}`, undefined, 'GET', options),
  save: (body, options) => call('/templates', body, 'POST', options), transition: (id, action, note, options) => call(`/templates/${id}/${action}`, { note }, 'POST', options),
  generate: (body, options) => call('/jobs', body, 'POST', options),
  renderData: (body, options) => call('/render-data', body, 'POST', { timeoutMs: 120000, ...options }),
  uploadResult: (formData, options) => upload('/results', formData, options),
  designSource: (reportTypeId, options) => call(`/design-source/${reportTypeId}`, undefined, 'GET', options),
  designRead: (reportTypeId, tableName, legacy = false) => ({
    url: `${base}/report-studio/design-data/${reportTypeId}/${encodeURIComponent(tableName)}${legacy ? '?legacy=true' : ''}`,
    method: 'GET', options: { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }, cache: 'no-store' },
  }),
  schedule: (body, options) => call('/schedules', body, 'POST', options), toggle: (id, enabled, options) => call(`/schedules/${id}`, { enabled }, 'PATCH', options),
  job: (id, options) => call(`/jobs/${id}`, undefined, 'GET', options), workbook: (id, options) => call(`/jobs/${id}/json`, undefined, 'GET', options),
  async download(id, format, name, options) {
    const blob = await request(`/jobs/${id}/${format}`, { method: 'GET' }, { timeoutMs: 120000, ...options }, true)
    if (options?.signal?.aborted) return
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = `${name}.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  },
}
