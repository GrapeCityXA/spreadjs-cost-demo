import { isNavigationFailure, NavigationFailureType } from 'vue-router'

const text = value => typeof value === 'string' ? value : ''

export function normalizeHeaderNotifications(response) {
  if (!response || !Array.isArray(response.notifications)) throw new Error('提醒数据格式异常，请刷新重试。')
  const seen = new Set()
  const notifications = response.notifications.flatMap(item => {
    if (!item || !['string', 'number'].includes(typeof item.id) || !String(item.id).trim() || seen.has(String(item.id))) return []
    seen.add(String(item.id))
    const payload = item.payload && typeof item.payload === 'object' ? item.payload : {}
    return [{ id: item.id, status: item.status === 'read' ? 'read' : 'unread', createdAt: text(item.createdAt),
      payload: Object.fromEntries(['label', 'description', 'organization', 'reportType', 'periodCode', 'deadlineAt', 'target'].map(key => [key, text(payload[key])])) }]
  })
  const count = Number(response.unreadCount)
  return { notifications, unreadCount: Number.isSafeInteger(count) && count >= 0 ? count : notifications.filter(item => item.status !== 'read').length }
}

export function headerNotificationTarget(value) {
  if (typeof value !== 'string' || !value.startsWith('/portal/') || /[\\\u0000-\u0020]/.test(value)) return null
  const url = new URL(value, 'https://header.invalid')
  if (url.origin !== 'https://header.invalid' || !/^\/portal\/(monthly-filling|monthly-review|quarterly-review|template|field-catalog|rule-catalog)(\/|$)/.test(url.pathname)) return null
  return url.pathname + url.search + url.hash
}

export function headerNotificationError(error) {
  if (error?.name === 'AbortError') return '加载提醒超时，请点击“刷新”重试。'
  if (error?.status === 401) return '登录已过期，请重新登录后查看提醒。'
  if (error?.status === 403) return '当前账户无权查看提醒，请联系管理员确认权限。'
  if (error?.status === 429) return '刷新过于频繁，请稍后重试。'
  return '未能加载提醒，请点击“刷新”重试。'
}

export async function headerRequest(send, timeoutMs = 15000) {
  const controller = new AbortController()
  let timer
  try {
    return await Promise.race([send(controller.signal), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new DOMException('Request timed out', 'AbortError')) }, timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

export async function openHeaderNotification({ id, api, router, isCurrent, isSessionCurrent }) {
  const response = normalizeHeaderNotifications(await headerRequest(signal => api.getNotifications(signal)))
  if (!isCurrent()) return { status: 'cancelled' }
  const current = response.notifications.find(item => String(item.id) === String(id))
  if (!current) return { status: 'missing' }
  const target = headerNotificationTarget(current.payload.target)
  if (!target) return { status: 'unavailable' }
  const failure = await router.push(target)
  if (failure && !isNavigationFailure(failure, NavigationFailureType.duplicated)) return { status: 'cancelled' }
  if (router.currentRoute.value.fullPath !== router.resolve(target).fullPath) return { status: 'unavailable' }
  if (!isSessionCurrent()) return { status: 'cancelled' }
  if (current.status !== 'read') {
    try { await headerRequest(signal => api.markNotificationRead(current.id, signal)) }
    catch { return { status: 'opened', readFailed: true } }
  }
  return { status: 'opened' }
}
