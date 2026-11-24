import { workflowReturnLocation } from './workflowNavigation.js'
import { isNavigationFailure, NavigationFailureType } from 'vue-router'

const workflowViews = new Set(['todo', 'initiated', 'handled', 'manage', 'start'])

export function sidebarMenuPath(route) {
  if (route.path === '/portal/workflow-center') {
    const view = workflowViews.has(route.query?.view) ? route.query.view : 'todo'
    return `/portal/workflow-center?view=${view}`
  }
  const workflow = workflowReturnLocation(route)
  if (workflow) return `/portal/workflow-center?view=${workflow.query.view}`
  if (route.path === '/portal/template-workbench') return '/portal/template'
  return route.path
}

// Modified clicks retain the browser's native new-tab/window behavior.
export async function navigateSidebar(event, navigate) {
  if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  const failure = await navigate(event)
  return !failure || isNavigationFailure(failure, NavigationFailureType.duplicated)
}
