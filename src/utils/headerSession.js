const logoutRequests = new WeakMap()

// Only the public login route may accept this short-lived navigation intent.
export function isHeaderLogoutPending(router, token) {
  return logoutRequests.get(router)?.token === token && Boolean(token)
}

export async function logoutFromHeader(router, storage = localStorage, notify = () => {
  window.dispatchEvent(new Event('cost-report-session-updated'))
}) {
  if (logoutRequests.has(router)) return 'pending'
  const intent = { token: storage.getItem('token') }
  logoutRequests.set(router, intent)
  try {
    const failure = await router.replace('/login')
    if (failure || router.currentRoute.value.path !== '/login') return 'cancelled'
    if (storage.getItem('token') !== intent.token) return 'changed'
    storage.removeItem('token')
    storage.removeItem('userInfo')
    notify()
    return 'logged-out'
  } finally {
    logoutRequests.delete(router)
  }
}
