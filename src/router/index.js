import { createRouter, createWebHistory } from 'vue-router'
import { ElMessage } from 'element-plus/es/components/message/index'
import { authApi } from '../api'
import { refreshSessionUser } from '../utils/authSession'
import { retiredRoutes } from './retiredRoutes'
import { isHeaderLogoutPending } from '../utils/headerSession'
import { SHOWCASE, isShowcasePath } from '../config/showcase'

const routes = [
  ...retiredRoutes,
  {
    path: '/guide',
    name: 'Guide',
    component: () => import('../views/PublicGuide.vue'),
    meta: { title: '项目导览', public: true }
  },
  { path: '/portal/guide', redirect: '/guide' },
  {
    path: '/',
    redirect: '/guide'
  },
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/Login.vue')
  },
  {
    path: '/portal',
    redirect: '/portal/home'
  },
  {
    path: '/portal',
    component: () => import('../views/Portal.vue'),
    children: [
      { path: 'report-studio', name: 'ReportStudio', component: () => import('../views/ReportStudio.vue'), meta: { title: '报表工作室', requiresAuth: true, requiresAnyRole: ['system_admin', 'template_designer', 'management', 'report_finalizer'] } },
      { path: 'workflow-center', name: 'WorkflowCenter', component: () => import('../views/WorkflowCenter.vue'), meta: { requiresAuth: true } },
      {
        path: 'home',
        name: 'Home',
        component: () => import('../views/Home.vue'),
        meta: { title: '门户首页', requiresAuth: true }
      },
      {
        path: 'template',
        name: 'Template',
        component: () => import('../views/Template.vue'),
        meta: { title: '报表模板搭建', requiresAuth: true, requiresPermission: 'template' }
      },
      {
        path: 'template-workbench',
        name: 'DesignerWorkbench',
        component: () => import('../views/DesignerWorkbench.vue'),
        meta: { title: '模板设计工作台', requiresAuth: true, requiresPermission: 'template' }
      },
      {
        path: 'monthly-filling',
        name: 'MonthlyFillingWorkbench',
        component: () => import('../views/MonthlyFillingWorkbench.vue'),
        meta: { title: '月度协同填报', requiresAuth: true, requiresAnyRole: ['subsidiary_filler', 'subsidiary_submitter', 'department_reviewer', 'management', 'system_admin'] }
      },
      {
        path: 'monthly-review/:taskId?',
        name: 'MonthlyReviewWorkbench',
        component: () => import('../views/MonthlyReviewWorkbench.vue'),
        meta: { title: '月报审核与定稿', requiresAuth: true, requiresAnyRole: ['department_reviewer', 'report_finalizer', 'management', 'system_admin'] }
      },
      {
        path: 'quarterly-review/:taskId?',
        name: 'QuarterlyReviewWorkbench',
        component: () => import('../views/QuarterlyReviewWorkbench.vue'),
        meta: { title: '季度审核与评分', requiresAuth: true, requiresAnyRole: ['department_reviewer', 'score_editor', 'management', 'report_finalizer', 'system_admin'] }
      },
      {
        path: 'monthly-reference-report',
        name: 'MonthlyReferenceReport',
        component: () => import('../views/MonthlyReferenceReport.vue'),
        meta: { title: '月度参考报表', requiresAuth: true, requiresAnyRole: ['management', 'report_finalizer', 'system_admin'] }
      },
      {
        path: 'finalized-data',
        name: 'FinalizedDataList',
        component: () => import('../views/FinalizedDataList.vue'),
        meta: { title: '已定稿查看', requiresAuth: true, requiresAnyRole: ['department_reviewer', 'management', 'report_finalizer', 'system_admin'] }
      },
      {
        path: 'finalized-data/:taskId/:revisionId?',
        name: 'FinalizedDataWorkbench',
        component: () => import('../views/FinalizedDataWorkbench.vue'),
        meta: { title: '已定稿数据', requiresAuth: true, requiresAnyRole: ['department_reviewer', 'management', 'report_finalizer', 'system_admin'] }
      },
      {
        path: 'quarterly-reference-report',
        name: 'QuarterlyReferenceReport',
        component: () => import('../views/QuarterlyReferenceReport.vue'),
        meta: { title: '季度参考报表', requiresAuth: true, requiresAnyRole: ['report_finalizer', 'system_admin'] }
      },
      {
        path: 'management-dashboard',
        name: 'ManagementDashboard',
        component: () => import('../views/OperationsDashboard.vue'),
        meta: { title: '经营指标仪表盘', requiresAuth: true, requiresAnyRole: ['management', 'report_finalizer', 'system_admin'] }
      },
      {
        path: 'organization-admin',
        name: 'OrganizationAdmin',
        component: () => import('../views/OrganizationAdministration.vue'),
        meta: { title: '组织与用户', requiresAuth: true, requiresRole: 'organization_user_admin' }
      },
      {
        path: 'field-catalog',
        name: 'FieldCatalog',
        component: () => import('../views/FieldCatalog.vue'),
        meta: { title: '业务字段目录', requiresAuth: true, requiresAnyRole: ['template_designer', 'data_administrator'] }
      },
      {
        path: 'historical-import',
        name: 'HistoricalImportWorkbench',
        component: () => import('../views/HistoricalImportWorkbench.vue'),
        meta: { title: '历史月报导入', requiresAuth: true, requiresAnyRole: ['data_administrator'] }
      },
      {
        path: 'rule-catalog',
        name: 'RuleCatalog',
        component: () => import('../views/RuleCatalog.vue'),
        meta: { title: '业务规则与公式', requiresAuth: true, requiresAnyRole: ['business_rule_administrator', 'business_rule_reviewer'] }
      },
      {
        path: 'period-configuration',
        name: 'PeriodConfiguration',
        component: () => import('../views/PeriodConfiguration.vue'),
        meta: { title: '填报计划', requiresAuth: true, requiresAnyRole: ['management', 'system_admin'] }
      },
      {
        path: 'task-progress',
        name: 'TaskProgressWorkbench',
        component: () => import('../views/TaskProgressWorkbench.vue'),
        meta: { title: '进度与责任调度', requiresAuth: true, requiresAnyRole: ['management', 'system_admin'] }
      },
      {
        path: 'original-data-exports',
        name: 'OriginalDataExports',
        component: () => import('../views/OriginalDataExportWorkbench.vue'),
        meta: { title: '原始数据与批量导出', requiresAuth: true, requiresAnyRole: ['subsidiary_filler', 'subsidiary_submitter', 'management', 'system_admin'] }
      },
    ]
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

router.beforeEach(async (to, from, next) => {
  // Only explicitly public pages bypass session checks. Business routes retain
  // their existing authentication and server-verified permission checks.
  if (to.meta.public === true && !to.meta.requiresAuth) {
    next()
    return
  }

  if (typeof window === 'undefined') {
    next()
    return
  }

  const token = localStorage.getItem('token')
  if (!token) {
    if (to.path !== '/login') {
      next('/login')
    } else {
      next()
    }
    return
  }

  if (to.path === '/login') {
    next(isHeaderLogoutPending(router, token) ? undefined : '/portal/home')
    return
  }

  // 官网展示模式：只放行演示主线与支撑页面，其余业务页回到演示首页。
  if (SHOWCASE && to.path.startsWith('/portal') && !isShowcasePath(to.path)) {
    next({ path: '/portal/home', query: { showcaseBlocked: '1', page: String(to.meta.title || to.path) } })
    return
  }

  if (to.meta.requiresAuth) {
    try {
      const userInfo = await refreshSessionUser(() => authApi.getCurrentUser())
      const denied = () => next({ path: '/portal/home', query: {
        noPermission: 'true', page: to.meta.title || '目标页面', account: userInfo.username, ...(to.query.retiredPage ? { retiredPage: to.query.retiredPage } : {})
      } })

      if (to.meta.requiresPermission) {
        const permissions = userInfo.permissions || []
        const requiredPermission = to.meta.requiresPermission
        const roleAllowed = requiredPermission === 'template' && (userInfo.roles || []).some(role => ['template_designer', 'system_admin'].includes(role.code))

        if (!permissions.includes(requiredPermission) && !roleAllowed) {
          denied()
          return
        }
      }

      if (to.meta.requiresRole) {
        const roles = userInfo.roles || []
        if (!roles.some(role => role.code === to.meta.requiresRole || role.code === 'system_admin')) {
          denied()
          return
        }
      }

      if (to.meta.requiresAnyRole) {
        const roles = userInfo.roles || []
        if (!roles.some(role => to.meta.requiresAnyRole.includes(role.code) || role.code === 'system_admin')) {
          denied()
          return
        }
      }

      next()
    } catch (e) {
      if (e.status === 401 || !localStorage.getItem('token')) next('/login')
      else {
        ElMessage.error(e.message || '暂时无法核验登录权限，请重试')
        next(false)
      }
    }
  } else {
    next()
  }
})

export default router
