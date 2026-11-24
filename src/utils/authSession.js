const sessionEvent = 'cost-report-session-updated'

export function readSessionUser() {
  try {
    if (!localStorage.getItem('token')) return {}
    return JSON.parse(localStorage.getItem('userInfo') || '{}') || {}
  }
  catch { return {} }
}

export function subscribeSessionUser(listener) {
  const update = () => listener(readSessionUser())
  const onStorage = event => {
    if (event.key == null || ['token', 'userInfo'].includes(event.key)) update()
  }
  window.addEventListener(sessionEvent, update)
  window.addEventListener('storage', onStorage)
  update()
  return () => {
    window.removeEventListener(sessionEvent, update)
    window.removeEventListener('storage', onStorage)
  }
}

// Route access uses the current server identity, not a possibly stale role cache.
export async function refreshSessionUser(getCurrentUser) {
  const token = localStorage.getItem('token')
  if (!token) throw Object.assign(new Error('请先登录'), { status: 401 })
  const { user } = await getCurrentUser()
  if (localStorage.getItem('token') !== token) {
    throw new Error('登录身份已变化，请重新打开目标页面')
  }
  if (!user?.id || !Array.isArray(user.roles)) throw new Error('无法读取当前登录身份，请重新登录')
  localStorage.setItem('userInfo', JSON.stringify(user))
  window.dispatchEvent(new Event(sessionEvent))
  return user
}
