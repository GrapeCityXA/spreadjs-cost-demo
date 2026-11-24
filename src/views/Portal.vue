<template>
  <div class="portal-layout" :class="{ 'compact-navigation': compactNavigation, 'designer-portal': isDesigner, 'designer-mobile': isDesignerMobile, 'dashboard-portal': isDashboard, 'dashboard-mobile': isDashboard && compactNavigation }">
    <a class="portal-skip-link" href="#portal-content" @click.prevent="skipToContent">跳到页面内容</a>
    <Sidebar ref="desktopSidebar" v-show="!compactNavigation" class="portal-sidebar" :class="{ 'portal-sidebar-collapsed': sidebarCollapsed }" @collapse-change="sidebarCollapsed = $event" />
    <el-drawer v-if="compactNavigation" id="portal-navigation-drawer" v-model="mobileNavigation" title="工作空间导航" direction="ltr" size="min(320px, calc(100vw - 32px))" class="portal-navigation-drawer designer-navigation-drawer" :class="{ 'dashboard-navigation-drawer': isDashboard }" @close-auto-focus="onNavigationReleased">
      <Sidebar class="mobile-sidebar" @navigate="mobileNavigation = false" />
    </el-drawer>

    <div class="portal-main">
      <TopHeader class="portal-header"><template #navigation><el-button ref="navigationToggle" v-if="compactNavigation" class="mobile-navigation-toggle" :aria-expanded="mobileNavigation" :aria-controls="mobileNavigation ? 'portal-navigation-drawer' : undefined" aria-label="打开工作空间导航" @click="mobileNavigation = true">导航</el-button></template></TopHeader>

      <div id="portal-content" ref="content" class="portal-content" role="region" tabindex="-1" aria-label="页面内容">
        <el-alert v-if="$route.query.retiredPage" class="retired-page-notice" type="info" show-icon :closable="false">
          <template #title>
            旧版「{{ $route.query.retiredPage }}」已下线，请使用当前功能入口。
            <button ref="retiredNoticeClose" class="retired-notice-close" type="button" aria-label="关闭旧版页面提示"
              :disabled="dismissingRetiredNotice" :aria-busy="dismissingRetiredNotice" @click="dismissRetiredNotice">
              <el-icon aria-hidden="true"><Close /></el-icon>
            </button>
          </template>
        </el-alert>
        <WorkflowReturnBar />
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in" @after-enter="onPageReady">
            <component :is="Component" />
          </transition>
        </router-view>
      </div>
    </div>
  </div>
</template>

<script>
import WorkflowReturnBar from '@/components/WorkflowReturnBar.vue'
import Sidebar from '@/components/Sidebar.vue'
import TopHeader from '@/components/TopHeader.vue'
import { SHOWCASE, stepFor } from '@/config/showcase'
import { markDemoStep } from '@/utils/demoProgress'
import { Close } from '@element-plus/icons-vue'
import { portalPageTitle, trackPortalNavigation, restorePortalScroll } from '@/utils/portalNavigation.js'
import '@/styles/portal-workbench.css'
import '@/styles/designer-layout.css'

export default {
  name: 'Portal',
  data() { return { sidebarCollapsed: false, smallViewport: window.matchMedia('(max-width: 767px)').matches, tabletViewport: window.matchMedia('(max-width: 1023px)').matches, mobileNavigation: false, dismissingRetiredNotice: false } },
  computed: {
    isDesigner() { return this.$route.path === '/portal/template-workbench' },
    isDesignerMobile() { return this.isDesigner && this.smallViewport },
    isDashboard() { return this.$route.path === '/portal/management-dashboard' },
    compactNavigation() { return this.tabletViewport }
  },
  mounted() {
    document.title = portalPageTitle(this.$route)
    this._stopNavigation = trackPortalNavigation(this.$router, () => this.$refs.content?.scrollTop || 0, plan => {
      this._stopRestore?.()
      document.title = portalPageTitle(plan.to)
      this._pendingNavigation = plan
      this._pageReady = false
      this._drawerClosing = this._drawerClosing || this.mobileNavigation
      this.mobileNavigation = false
      // A reused route component has no enter transition (filters and workflow tabs).
      if (plan.to.matched.at(-1)?.components.default === this._routeComponent) {
        this.$nextTick(this.onPageReady)
      }
      this._routeComponent = plan.to.matched.at(-1)?.components.default
    })
    this._routeComponent = this.$route.matched.at(-1)?.components.default
    this._mobileQuery = window.matchMedia('(max-width: 767px)')
    this._tabletQuery = window.matchMedia('(max-width: 1023px)')
    this._syncMobile = () => {
      const wasCompact = this.compactNavigation
      const focusWasNavigation = document.activeElement?.closest('.portal-sidebar, .portal-navigation-drawer, .mobile-navigation-toggle')
      this.smallViewport = this._mobileQuery.matches
      this.tabletViewport = this._tabletQuery.matches
      if (!this.compactNavigation) this.mobileNavigation = false
      if (wasCompact !== this.compactNavigation && focusWasNavigation) {
        this.$nextTick(() => {
          if (this.compactNavigation) this.$refs.navigationToggle?.$el.focus()
          else {
            const sidebar = this.$refs.desktopSidebar?.$el
            const link = sidebar?.querySelector('[aria-current="page"]') || sidebar?.querySelector('a')
            link?.focus()
          }
        })
      }
    }
    this._syncMobile()
    this._mobileQuery.addEventListener('change', this._syncMobile)
    this._tabletQuery.addEventListener('change', this._syncMobile)
  },
  beforeUnmount() {
    this._mobileQuery?.removeEventListener('change', this._syncMobile)
    this._tabletQuery?.removeEventListener('change', this._syncMobile)
    this._stopNavigation?.()
    this._stopRestore?.()
    this._pendingNavigation = null
  },
  components: {
    Close,
    Sidebar,
    WorkflowReturnBar,
    TopHeader
  },
  watch: {
    '$route.path': {
      immediate: true,
      handler(path) {
        if (!SHOWCASE) return
        const step = stepFor(path)
        if (step) markDemoStep(step.key)
      }
    }
  },
  methods: {
    focusContent() {
      const content = this.$refs.content
      const target = content?.querySelector('h1') || content
      if (!target) return
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
      target.focus({ preventScroll: true })
    },
    skipToContent() {
      this._stopRestore?.()
      this.focusContent()
      this.$refs.content.scrollTop = 0
    },
    onNavigationReleased() {
      // Element Plus restores the opener after this event; wait for that release.
      this.$nextTick(() => { this._drawerClosing = false; this.finishNavigation() })
    },
    onPageReady() { this._pageReady = true; this.finishNavigation() },
    finishNavigation() {
      const plan = this._pendingNavigation
      if (!plan || !this._pageReady || this._drawerClosing || this.mobileNavigation) return
      this._pendingNavigation = null
      if (plan.pageChanged || plan.isTraversal) this.focusContent()
      this._stopRestore = restorePortalScroll(this.$refs.content, plan.top)
    },
    async dismissRetiredNotice() {
      if (this.dismissingRetiredNotice) return
      const button = this.$refs.retiredNoticeClose
      const hadFocus = document.activeElement === button
      const ownsFocus = () => hadFocus && (document.activeElement === button || document.activeElement === document.body)
      const { retiredPage, ...query } = this.$route.query
      const { path, hash } = this.$route
      this.dismissingRetiredNotice = true
      try {
        const failure = await this.$router.replace({ path, query, hash })
        await this.$nextTick()
        if (!failure && this.$route.path === path && !this.$route.query.retiredPage && ownsFocus()) this.focusContent()
      } catch {
        this.$message.error('暂时无法关闭提示，请重试。')
      } finally {
        this.dismissingRetiredNotice = false
        await this.$nextTick()
        if (this.$refs.retiredNoticeClose && ownsFocus()) this.$refs.retiredNoticeClose.focus({ preventScroll: true })
      }
    }
  }
}
</script>

<style scoped>
.portal-skip-link {
  position: fixed;
  top: max(8px, env(safe-area-inset-top));
  left: max(12px, env(safe-area-inset-left));
  max-width: calc(100vw - 24px - env(safe-area-inset-left) - env(safe-area-inset-right));
  box-sizing: border-box;
  z-index: 4000;
  padding: 12px 16px;
  color: var(--portal-surface);
  background: var(--portal-focus);
  border-radius: 4px;
  transform: translateY(-200%);
}
.portal-skip-link:focus { transform: none; outline: 2px solid var(--portal-surface); outline-offset: -4px; }
.portal-content:focus-visible { outline: 2px solid var(--portal-focus); outline-offset: -2px; }
.portal-content :deep(h1[tabindex="-1"]:focus-visible) { outline: 2px solid var(--portal-focus); outline-offset: 4px; }
.retired-page-notice { width: auto; min-height: 48px; margin: 12px 24px; padding: 12px 52px 12px 16px; border: 1px solid var(--portal-line); background: var(--portal-surface); }
.retired-page-notice :deep(.el-alert__content) { min-width: 0; }
.retired-page-notice :deep(.el-alert__title) { color: var(--portal-muted); overflow-wrap: anywhere; line-height: 1.5; }
.retired-page-notice :deep(.el-alert__icon) { color: var(--portal-muted); }
.retired-notice-close { position: absolute; display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; top: 50%; right: 4px; transform: translateY(-50%); padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--portal-muted); font-size: 16px; cursor: pointer; }
.retired-notice-close:focus-visible { outline: 2px solid var(--portal-focus); outline-offset: -2px; }
.retired-notice-close:active:not(:disabled) { background: var(--portal-accent-surface); color: var(--portal-focus); }
.retired-notice-close:disabled { opacity: .6; cursor: wait; }
@media (hover: hover) and (pointer: fine) {
  .retired-notice-close:hover:not(:disabled) { background: var(--portal-paper); color: var(--portal-ink); }
}
.portal-layout {
  display: flex;
  width: 100%;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  font-family: var(--font-sans);
  font-size: 14px;
  color: var(--portal-ink);
}

.portal-sidebar {
  width: 220px;
  flex-shrink: 0;
}

.portal-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.portal-header {
  flex-shrink: 0;
}

.portal-content {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  padding-inline: env(safe-area-inset-left) env(safe-area-inset-right);
  padding-bottom: env(safe-area-inset-bottom);
  box-sizing: border-box;
  background: var(--portal-paper);
}

.portal-sidebar-collapsed { width: 64px; }
.designer-portal .portal-content { container-type: inline-size; container-name: designer-space; }
.compact-navigation .portal-header { padding-inline:max(8px, env(safe-area-inset-left)) max(8px, env(safe-area-inset-right)); gap:8px; }
.compact-navigation :deep(.header-left) { display:flex;align-items:center;gap:12px;min-width:0; }
.compact-navigation :deep(.header-left .el-breadcrumb) { min-width:0;overflow:hidden;white-space:nowrap; }
.compact-navigation :deep(.header-right) { gap:8px;min-width:0; }
.compact-navigation :deep(.user-info) { padding:0;gap:6px;min-width:0; }
.compact-navigation :deep(.user-detail) { min-width:0;max-width:clamp(5rem, 16vw, 10rem); }
.compact-navigation :deep(.user-name) { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.compact-navigation :deep(.user-role) { display:none; }
.compact-navigation :deep(.action-trigger),.compact-navigation :deep(.notification-trigger .el-button),.mobile-navigation-toggle { min-width:44px;min-height:44px; }
.compact-navigation :deep(.action-trigger) { justify-content:center; }
.mobile-navigation-toggle { flex-shrink:0; font-size:16px; }
.mobile-navigation-toggle:focus-visible { outline:2px solid var(--portal-focus);outline-offset:2px; }
.mobile-sidebar { height:100%;min-height:0; }
.mobile-sidebar :deep(.sidebar-footer) { display:none; }
.mobile-sidebar :deep(.sidebar-link) { font-size:16px;padding-inline:max(20px, env(safe-area-inset-left)) max(20px, env(safe-area-inset-right)); }
.mobile-sidebar :deep(.navigation-group) { font-size:14px;letter-spacing:normal; }
.mobile-sidebar :deep(.sidebar-menu) { overscroll-behavior-y:contain;padding-bottom:env(safe-area-inset-bottom); }
:deep(.portal-navigation-drawer) { max-width:100%;height:100vh;height:100dvh; }
:deep(.portal-navigation-drawer .el-drawer__body) { padding:0;min-height:0;overflow:hidden; }
:deep(.portal-navigation-drawer .el-drawer__header) { margin-bottom:0;gap:8px;padding:max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) 8px max(20px, env(safe-area-inset-left)); }
:deep(.portal-navigation-drawer .el-drawer__title) { min-width:0;color:var(--portal-ink, #2c1b26);font-size:16px;font-weight:600;line-height:1.5;overflow-wrap:anywhere; }
:deep(.portal-navigation-drawer .el-drawer__close-btn) { display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;margin:0; }
:deep(.portal-navigation-drawer .el-drawer__close-btn:focus-visible) { outline:2px solid var(--portal-focus);outline-offset:-2px; }
@media (max-width: 639px) {
  .retired-page-notice { margin-inline: 16px; }
  .compact-navigation :deep(.header-left .el-breadcrumb) { display:none; }
  .compact-navigation :deep(.header-left) { flex:0 0 auto; }
  .compact-navigation :deep(.header-right) { flex:1 1 auto; justify-content:flex-end; }
}
@media (max-width: 1023px), (any-pointer: coarse) {
  .retired-page-notice :deep(.el-alert__title) { font-size: 16px; }
}
@media (max-height: 480px) {
  .mobile-sidebar :deep(.sidebar-header) { display:none; }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .fade-enter-active, .fade-leave-active { transition: none; }
  :deep(.portal-navigation-drawer), :deep(.el-drawer-fade-enter-active), :deep(.el-drawer-fade-leave-active) { transition: none; }
}
</style>
