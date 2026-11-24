// 官网展示模式的唯一开关。默认关闭，不影响原有业务开发与销售演示。
// 启动方式：npm run dev:showcase / npm run build:showcase
export const SHOWCASE = import.meta.env.VITE_SHOWCASE === 'true' || import.meta.env.MODE === 'showcase'

// 展示模式只使用一个内部演示组织。前端不展示组织名称和选择器，
// 组织仅作为后端任务、权限和协作房间的作用域保留。
export const DEMO_ORGANIZATION_CODE = 'SUB_EAST'

export function demoOrganization(organizations = []) {
  return organizations.find(org => org.code === DEMO_ORGANIZATION_CODE) || organizations[0] || null
}

// 演示主线：四步。每步对应一个入口页面。
export const DEMO_STEPS = [
  { key: 'design', no: '01', label: '设计模板', path: '/portal/template', hint: '导入 Excel、拖入字段、配置校验与单元格权限' },
  { key: 'fill', no: '02', label: '协同填报', path: '/portal/monthly-filling', hint: '多人实时编辑同一张表，检查后提交' },
  { key: 'review', no: '03', label: '审核发布', path: '/portal/monthly-review', hint: '只读快照、审核意见、退回或定稿' },
  { key: 'report', no: '04', label: '报表输出', path: '/portal/report-studio', hint: 'ReportSheet 报表与 XLSX/PDF 导出' }
]

// 展示模式允许访问的页面。未列出的业务页面会回到演示首页，并提示不在演示范围。
export const SHOWCASE_PATHS = [
  '/portal/home',
  '/portal/guide',
  '/portal/template',
  '/portal/template-workbench',
  '/portal/field-catalog',
  '/portal/rule-catalog',
  '/portal/period-configuration',
  '/portal/monthly-filling',
  '/portal/monthly-review',
  '/portal/report-studio',
  '/portal/finalized-data',
  '/portal/management-dashboard',
  '/portal/task-progress',
  '/portal/workflow-center'
]

export function isShowcasePath(path) {
  return SHOWCASE_PATHS.some(allowed => path === allowed || path.startsWith(allowed + '/'))
}

// 每个页面用到的 SpreadJS 能力，显示在演示条上。
export const PAGE_CAPABILITIES = {
  '/portal/template': ['Designer', '模板版本', '发布检查'],
  '/portal/template-workbench': ['Designer', 'DataManager', '公式引擎', '单元格权限'],
  '/portal/monthly-filling': ['OT 协同', 'Presence', '公式引擎', '数据校验'],
  '/portal/monthly-review': ['工作簿快照', 'PDF', 'Excel IO'],
  '/portal/finalized-data': ['快照版本', 'PDF', 'Excel IO'],
  '/portal/report-studio': ['ReportSheet', 'PDF', 'Excel IO'],
  '/portal/management-dashboard': ['数据可视化'],
  '/portal/field-catalog': ['业务字段目录'],
  '/portal/rule-catalog': ['公式引擎', '数据校验']
}

export function capabilitiesFor(path) {
  return Object.entries(PAGE_CAPABILITIES).find(([prefix]) => path.startsWith(prefix))?.[1] || []
}

export function stepFor(path) {
  return DEMO_STEPS.find(step => path.startsWith(step.path)) || null
}

// 按当前身份判断演示入口是否可用；与路由守卫保持一致，避免"看得到但点不进去"。
export function demoAccess(user = {}) {
  const roles = Array.isArray(user.roles) ? user.roles : []
  const permissions = Array.isArray(user.permissions) ? user.permissions : []
  const has = codes => roles.some(role => role.code === 'system_admin' || codes.includes(role.code))
  const template = permissions.includes('template') || roles.some(role => ['template_designer', 'system_admin'].includes(role.code))
  return {
    design: template,
    fields: has(['template_designer', 'data_administrator']),
    packages: roles.some(role => role.code === 'system_admin'),
    fill: has(['subsidiary_filler', 'subsidiary_submitter', 'department_reviewer', 'management']),
    review: has(['department_reviewer', 'report_finalizer', 'management']),
    report: has(['template_designer', 'management', 'report_finalizer']),
    finalized: has(['department_reviewer', 'management', 'report_finalizer']),
    dashboard: has(['management', 'report_finalizer']),
    flow: roles.length > 0,
    progress: has(['management'])
  }
}

// 演示身份。密码只用于本地演示环境，账号由 server/scripts/seed-demo-users.cjs 创建。
export const DEMO_IDENTITIES = [
  { key: 'admin', label: '设计 / 管理员', username: 'demo-admin', password: 'demo123' },
  { key: 'filler', label: '填报人一', username: '组织填报人一', password: 'browser-scoped-password' },
  { key: 'filler2', label: '填报人二', username: 'browser-scoped-user-2', password: 'browser-scoped-password-2' },
  { key: 'reviewer', label: '审核 / 定稿', username: 'demo-reviewer', password: 'demo123' }
]
