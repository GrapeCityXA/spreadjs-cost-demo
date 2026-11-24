const workflowTitles = {
  todo: '我的待办', initiated: '我发起的', handled: '我的已办',
  start: '发起流程', manage: '流程管理'
}

export function portalPageTitle(route) {
  const view = route.query.view
  const title = route.path === '/portal/workflow-center'
    ? (typeof view === 'string' && Object.hasOwn(workflowTitles, view) ? workflowTitles[view] : '流程中心')
    : route.meta.title || '工作空间'
  return `${title} · 成本指标平台`
}

export function isPortalPageChange(to, from) {
  return to.path !== from.path || (to.path === '/portal/workflow-center' && to.query.view !== from.query.view)
}

// Key by history entry, so visiting the same URL twice keeps two reading positions.
// Hooks observe successful navigation only; existing authentication guards stay authoritative.
export function trackPortalNavigation(router, getScrollTop, onNavigate) {
  const history = router.options.history
  const positions = new Map()
  let current = { position: history.state.position, route: router.currentRoute.value }
  let traversal = null
  const key = (position, route) => `${position}:${route.fullPath}`
  const stopHistory = history.listen((to) => {
    traversal = { position: history.state.position, to }
  })
  const stopBefore = router.beforeEach(() => {
    positions.set(key(current.position, current.route), getScrollTop())
    if (positions.size > 100) positions.delete(positions.keys().next().value)
  })
  const stopAfter = router.afterEach((to, from, failure) => {
    if (failure) {
      if (traversal?.to === to.fullPath) traversal = null
      return
    }
    const position = history.state.position
    const isTraversal = traversal?.position === position && traversal.to === to.fullPath
    const pageChanged = isPortalPageChange(to, from)
    const top = isTraversal ? positions.get(key(position, to)) ?? 0 : pageChanged ? 0 : getScrollTop()
    current = { position, route: to }
    traversal = null
    onNavigate({ to, top, pageChanged, isTraversal })
  })
  return () => { stopHistory(); stopBefore(); stopAfter(); positions.clear() }
}

// Wait briefly for asynchronously loaded content to become tall enough. User input
// always wins, and the caller cancels this observer on the next route/unmount.
export function restorePortalScroll(content, top, environment = window) {
  let observer
  let timer
  let stopped = false
  const events = ['wheel', 'touchstart', 'pointerdown', 'keydown']
  const stop = () => {
    stopped = true
    observer?.disconnect()
    environment.clearTimeout(timer)
    events.forEach(event => content.removeEventListener(event, stop))
  }
  const apply = () => {
    if (stopped) return
    content.scrollTop = top
    if (content.scrollHeight - content.clientHeight >= top - 1) stop()
  }
  events.forEach(event => content.addEventListener(event, stop, { passive: true }))
  if (environment.ResizeObserver) {
    observer = new environment.ResizeObserver(apply)
    observer.observe(content)
    Array.from(content.children).forEach(child => observer.observe(child))
  }
  timer = environment.setTimeout(stop, 5000)
  apply()
  return stop
}
