<template>
  <nav class="sidebar" :class="{ 'is-collapsed': isCollapse }" aria-label="工作空间导航">
    <div class="sidebar-header">
      <p class="system-title">成本指标平台</p>
      <p class="system-subtitle">协同填报工作空间</p>
    </div>

    <ul :id="menuId" class="sidebar-menu">
      <template v-for="group in navigationGroups" :key="group.label">
        <li v-if="group.label && !isCollapse" class="navigation-group" role="presentation">{{ group.label }}</li>
        <li v-for="item in group.items" :key="item.path">
          <router-link :to="item.path" custom v-slot="{ href, navigate }">
            <el-tooltip :content="item.label" :disabled="!isCollapse" placement="right" :trigger="['hover', 'focus']" :trigger-keys="[]">
              <a :href="href" class="el-menu-item sidebar-link" :class="{ 'is-active': activeMenu === item.path }"
                :aria-label="item.label" :aria-current="activeMenu === item.path ? 'page' : undefined" @click="selectNavigation($event, navigate)">
                <el-icon aria-hidden="true"><component :is="item.icon" /></el-icon>
                <span class="navigation-label">{{ item.label }}</span>
              </a>
            </el-tooltip>
          </router-link>
        </li>
      </template>

    </ul>

    <div class="sidebar-footer">
      <el-button :aria-label="isCollapse ? '展开导航' : '收起导航'" :aria-expanded="!isCollapse" :aria-controls="menuId" circle @click="toggleCollapse"><el-icon aria-hidden="true"><Expand v-if="isCollapse" /><Fold v-else /></el-icon></el-button>
    </div>
  </nav>
</template>

<script>
import { subscribeSessionUser } from '@/utils/authSession'
import { sidebarMenuPath, navigateSidebar } from '@/utils/sidebarNavigation'
import { SHOWCASE, demoAccess } from '@/config/showcase'
import {
  HomeFilled,
  Grid,
  DocumentCopy,
  Operation,
  DataLine,
  Expand,
  Fold,
  Calendar,
  DocumentChecked,
  UserFilled,
  CollectionTag,
  Download
} from '@element-plus/icons-vue'

let nextMenuId = 0

export default {
  name: 'Sidebar',
  emits: ['collapse-change', 'navigate'],
  components: {
    HomeFilled,
    Grid,
    DocumentCopy,
    Operation,
    DataLine,
    Expand,
    Fold,
    Calendar,
    DocumentChecked,
    UserFilled,
    CollectionTag,
    Download
  },
  data() {
    return {
      isCollapse: false,
      showcase: SHOWCASE,
      menuId: `workspace-navigation-${++nextMenuId}`,
      unsubscribeSession: null,
      userInfo: {}
    }
  },
  mounted() {
    this.unsubscribeSession = subscribeSessionUser(user => { this.userInfo = user })
  },
  beforeUnmount() { this.unsubscribeSession?.() },
  computed: {
    activeMenu() { return sidebarMenuPath(this.$route) },
    isCollaborativeUser() { return (this.userInfo.roles || []).length > 0 },
    showcaseNavigation() {
      const access = demoAccess(this.userInfo)
      const item = (path, label, icon) => ({ path: '/portal/' + path, label, icon })
      const groups = [
        { label: '', items: [item('home', '演示首页', 'HomeFilled'), item('guide', '项目导览', 'CollectionTag')] },
        { label: '演示主线', items: [
          access.design && item('template', '设计模板', 'Grid'),
          access.fill && item('monthly-filling', '协同填报', 'DocumentCopy'),
          access.review && item('monthly-review', '审核发布', 'DocumentChecked'),
          access.report && item('report-studio', '报表输出', 'DataLine')
        ].filter(Boolean) },
        { label: '配置', items: [
          access.fields && item('field-catalog', '业务字段目录', 'CollectionTag'),
          access.packages && item('period-configuration', '填报计划', 'Calendar')
        ].filter(Boolean) },
        { label: '流程中心', items: [
          access.flow && item('workflow-center?view=todo', '我的流程', 'DocumentChecked'),
          access.progress && item('task-progress', '流程进度', 'Operation')
        ].filter(Boolean) },
        { label: '更多', items: [
          access.finalized && item('finalized-data', '已定稿查看', 'DocumentChecked'),
          access.dashboard && item('management-dashboard', '经营指标仪表盘', 'DataLine')
        ].filter(Boolean) }
      ]
      return groups.filter(group => group.items.length)
    },
    navigationGroups() {
      if (this.showcase) return this.showcaseNavigation
      const item = (path, label, icon, visible = true) => visible ? { path: '/portal/' + path, label, icon } : null
      const top = [
        item('home', '门户首页', 'HomeFilled'),
        item('guide', '项目导览', 'CollectionTag'),
        item('management-dashboard', '经营指标仪表盘', 'DataLine', this.isCollaborativeUser && this.canSeeManagementDashboard),
      ]
      const workflow = [
        item('workflow-center?view=todo', '我的待办', 'DocumentChecked'),
        item('workflow-center?view=initiated', '我发起的', 'DocumentCopy'),
        item('workflow-center?view=handled', '我的已办', 'CollectionTag'),
        item('workflow-center?view=start', '发起流程', 'Calendar', this.canManagePeriods || this.canUseFieldCatalog || this.canUseRuleCatalog || this.hasPermission('template')),
        item('workflow-center?view=manage', '流程管理', 'Operation', this.canManagePeriods),
      ]
      const reports = [
        item('report-studio', '报表工作室', 'Grid', this.canSeeReferenceReport || this.hasPermission('template')),
        item('monthly-reference-report', '月度参考报表', 'DataLine', this.canSeeReferenceReport),
        item('finalized-data', '已定稿查看', 'DocumentChecked', this.canSeeFinalizedData),
        item('quarterly-reference-report', '季度参考报表', 'DataLine', this.canSeeQuarterlyReferenceReport),
      ]
      const administration = [
        item('historical-import', '历史月报导入', 'DocumentCopy', this.canImportHistory),
        item('original-data-exports', '原始数据与批量导出', 'Download', this.canExportOriginalData),
        item('organization-admin', '组织与用户', 'UserFilled', this.canAdminOrganizations),
      ]
      const common = [
        item('template', '报表模板搭建', 'Grid', this.hasPermission('template')),
        item('field-catalog', '业务字段目录', 'CollectionTag', this.canUseFieldCatalog),
        item('rule-catalog', '业务规则与公式', 'Operation', this.canUseRuleCatalog),
      ]
      const groups = [{ label: '', items: top }, { label: '业务逻辑管理', items: common }]
      if (this.isCollaborativeUser) groups.push(
        { label: '流程中心', items: workflow },
        { label: '报表', items: reports },
        { label: '系统管理', items: administration }
      )
      return groups.map(group => ({ ...group, items: group.items.filter(Boolean) })).filter(group => group.items.length)
    },
    canAdminOrganizations() {
      return (this.userInfo.roles || []).some(role => ['organization_user_admin', 'system_admin'].includes(role.code))
    },
    canUseFieldCatalog() {
      return (this.userInfo.roles || []).some(role => ['template_designer', 'data_administrator', 'system_admin'].includes(role.code))
    },
    canImportHistory() {
      return (this.userInfo.roles || []).some(role => ['data_administrator', 'system_admin'].includes(role.code))
    },
    canUseRuleCatalog() {
      return (this.userInfo.roles || []).some(role => ['business_rule_administrator', 'business_rule_reviewer', 'system_admin'].includes(role.code))
    },
    canManagePeriods() {
      return (this.userInfo.roles || []).some(role => ['management', 'system_admin'].includes(role.code))
    },
    canSeeReferenceReport() {
      return (this.userInfo.roles || []).some(role => role.code === 'system_admin'
        || (['management', 'report_finalizer'].includes(role.code) && role.organizationId == null))
    },
    canSeeQuarterlyReferenceReport() {
      return (this.userInfo.roles || []).some(role => role.code === 'system_admin' || role.code === 'report_finalizer')
    },
    canSeeFinalizedData() {
      return (this.userInfo.roles || []).some(role => ['department_reviewer', 'management', 'report_finalizer', 'system_admin'].includes(role.code))
    },
    canSeeManagementDashboard() {
      return (this.userInfo.roles || []).some(role => role.code === 'system_admin'
        || (['management', 'report_finalizer'].includes(role.code) && role.organizationId == null))
    },
    canExportOriginalData() {
      return (this.userInfo.roles || []).some(role => ['subsidiary_filler', 'subsidiary_submitter', 'management', 'system_admin'].includes(role.code))
    }
  },
  methods: {
    async selectNavigation(event, navigate) {
      try {
        if (await navigateSidebar(event, navigate)) this.$emit('navigate')
      } catch {
        this.$message.error('暂时无法打开该页面，请重试。')
      }
    },
    hasPermission(permission) {
      const permissions = this.userInfo.permissions || []
      const roles = this.userInfo.roles || []
      return permissions.includes(permission) || (permission === 'template' && roles.some(role => ['template_designer', 'system_admin'].includes(role.code)))
    },
    toggleCollapse() {
      this.isCollapse = !this.isCollapse
      this.$emit('collapse-change', this.isCollapse)
    }
  }
}
</script>

<style scoped>
.navigation-group { padding: 20px 20px 8px; color: rgba(255,255,255,.58); font-size: 12px; line-height: 1.5; letter-spacing: .06em; list-style: none; }
.sidebar {
  --sidebar-active: rgba(255, 255, 255, .16);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: linear-gradient(180deg, #9d1b6d 0%, #74114f 58%, #5f0e40 100%);
  color: #fff;
}

.sidebar-header {
  flex-shrink: 0;
  padding: 20px;
  text-align: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.16);
}

.system-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: #fff;
}

.system-subtitle {
  margin: 8px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.68);
}

.sidebar-menu {
  margin: 0;
  padding: 0;
  list-style: none;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior-y: contain;
  scroll-padding-block: 8px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,.35) transparent;
  padding: 4px 8px 12px;
  border: none;
  background: transparent;
}

.sidebar-link {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 50px;
  height: auto;
  margin: 2px 0;
  padding: 12px 12px;
  border-radius: 7px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 14px;
  line-height: 1.5;
  white-space: normal;
  text-decoration: none;
  transition: none;
}
.sidebar-link .el-icon { flex: none; width: 20px; margin: 0; font-size: 18px; }
.navigation-label { min-width: 0; overflow-wrap: anywhere; }
.sidebar-link:hover {
  background: rgba(255, 255, 255, 0.1);
}
.sidebar-link.is-active {
  background: var(--sidebar-active);
  color: #fff;
  font-weight: 600;
  box-shadow: inset 3px 0 0 #ffd0e7;
}
.sidebar-link:focus-visible { outline: 2px solid #fff; outline-offset: -4px; }
.sidebar-footer .el-button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.sidebar ::selection { color: #fff; background: var(--sidebar-active); }

:deep(.el-icon) {
  color: inherit;
}

.sidebar-footer {
  flex-shrink: 0;
  padding: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  text-align: center;
}

.sidebar-footer .el-button {
  width: 44px;
  height: 44px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  color: rgba(255, 255, 255, 0.85);
}

.sidebar-footer .el-button:hover {
  background: rgba(255, 255, 255, 0.2);
}

.is-collapsed .sidebar-header { padding: 20px 4px; }
.is-collapsed .system-title { font-size: 14px; line-height: 1.5; text-wrap: balance; }
.is-collapsed .system-subtitle { display: none; }
.is-collapsed .sidebar-footer { padding: 16px 0; }
.is-collapsed .sidebar-link { justify-content: center; padding-inline: 0; }
.is-collapsed .sidebar-menu { scrollbar-gutter: stable both-edges; }
.is-collapsed .sidebar-link.is-active .el-icon::after { content: ''; position: absolute; inset-inline: 4px; bottom: -6px; border-bottom: 2px solid currentColor; }
.is-collapsed .navigation-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (forced-colors: active) {
  .sidebar-link.is-active { outline: 1px solid Highlight; outline-offset: -1px; }
  .sidebar-link:focus-visible, .sidebar-footer .el-button:focus-visible { outline-color: Highlight; }
}
</style>
