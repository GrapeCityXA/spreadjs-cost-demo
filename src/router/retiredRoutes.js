// Retired URLs only point to current entry pages. Legacy record IDs are not
// forwarded: they belong to a different data model, not collaborative tasks.
export const retiredPages = [
  ['template-edit', '模板编辑', '/portal/template', { section: 'templates' }],
  ['monthly-reports', '月度报表管理', '/portal/workflow-center', { view: 'todo' }],
  ['monthly-report-edit', '月度报表编辑', '/portal/workflow-center', { view: 'todo' }],
  ['report-review', '报表审核', '/portal/workflow-center', { view: 'todo' }],
  ['report-list', '报表中心', '/portal/monthly-reference-report', { section: 'results' }],
  ['report-viewer', '报表查看器', '/portal/monthly-reference-report', { section: 'results' }],
  ['report-view', '报表查看', '/portal/monthly-reference-report', { section: 'results' }],
  ['report-edit', '报表编辑', '/portal/workflow-center', { view: 'todo' }],
  ['formula', '公共逻辑库', '/portal/rule-catalog', {}],
  ['data', '月度数据管理', '/portal/workflow-center', { view: 'todo' }],
  ['settings', '旧版系统设置', '/portal/organization-admin', {}],
].map(([path, title, destination, query]) => ({ path: `/portal/${path}`, title, destination, query }))
retiredPages.push({ path: '/prototype/core-pages', title: '核心页面方案原型', destination: '/portal/home', query: {} })

export const retiredRoutes = retiredPages.map(page => ({ path: page.path,
  redirect: () => ({ path: page.destination, query: { ...page.query, retiredPage: page.title } }) }))
