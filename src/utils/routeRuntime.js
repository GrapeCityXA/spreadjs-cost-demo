// Share pending loads across navigations; a failed download can be retried.
function loadOnce(loader) {
  let pending
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(loader).catch(error => {
        pending = undefined
        throw error
      })
    }
    return pending
  }
}

export function createRouteRuntimeGuard({ loadUi, loadWorkbook, onError }) {
  const ui = loadOnce(loadUi)
  const workbook = loadOnce(loadWorkbook)
  return async to => {
    if (to.meta.public === true && !to.meta.requiresAuth) return
    try {
      await Promise.all([ui(), ...(to.meta.requiresAuth ? [workbook()] : [])])
    } catch (error) {
      onError(error)
      return false
    }
  }
}
