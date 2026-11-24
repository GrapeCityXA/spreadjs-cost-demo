const views = new Set(['todo', 'initiated', 'handled', 'manage', 'start'])
export function workflowReturnLocation(route) {
  if (!views.has(route?.query?.workflowFrom)) return null
  return { path: '/portal/workflow-center', query: { view: route.query.workflowFrom,
    ...(route.query.workflowType ? { type: route.query.workflowType } : {}),
    ...(route.query.workflowStatus ? { status: route.query.workflowStatus } : {}) } }
}
export function returnToWorkflow(vm) {
  const location = workflowReturnLocation(vm.$route)
  if (location) { vm.$router.push(location); return true }
  return false
}
