<template>
  <header class="top-header">
    <div class="header-left">
      <slot name="navigation" />
      <nav class="el-breadcrumb header-breadcrumb" aria-label="面包屑">
        <router-link to="/portal/home">首页</router-link>
        <span v-if="currentBreadcrumb" aria-hidden="true">/</span>
        <span v-if="currentBreadcrumb" class="header-current-page" aria-current="page">{{ currentBreadcrumb }}</span>
      </nav>
    </div>

    <div class="header-right">
      <div ref="notificationAnchor" class="notification-anchor" @keydown.esc.stop.prevent="closeNotifications(true)">
          <el-badge :value="unreadCount" :max="99" :hidden="unreadCount === 0" class="notification-trigger">
            <el-button ref="notificationTrigger" circle plain :aria-label="`流程提醒，${unreadCount} 条未读`"
              aria-haspopup="dialog" :aria-expanded="notificationsOpen" :aria-controls="notificationsOpen ? 'header-notifications' : undefined"
              @click="toggleNotifications"><el-icon aria-hidden="true"><Bell /></el-icon></el-button>
          </el-badge>
        <section v-if="notificationsOpen" id="header-notifications" ref="notificationPanel" class="notification-panel" :style="notificationPosition"
          role="dialog" aria-labelledby="header-notifications-title" @keydown="onNotificationKeydown">
        <div class="notification-head"><strong id="header-notifications-title">流程提醒 <span>{{ unreadCount }} 条未读</span></strong>
          <div class="notification-tools"><el-button link :loading="notificationLoading" :disabled="notificationLoading" @click="loadNotifications">刷新</el-button>
            <button ref="notificationClose" type="button" class="notification-close" aria-label="关闭流程提醒" @click="closeNotifications(true)"><el-icon aria-hidden="true"><Close /></el-icon></button></div>
        </div>
        <div class="notification-body">
        <p class="notification-connection" role="status">{{ notificationStateLabel }}</p>
        <p v-if="notificationError" class="notification-error" role="alert">{{ notificationError }}</p>
        <p v-if="notificationLoading && !notifications.length" class="notification-empty" role="status">正在加载流程提醒…</p>
        <p v-if="notificationActionError" class="notification-error" role="alert">{{ notificationActionError }}</p>
        <div v-if="notifications.length" class="notification-list" :aria-busy="notificationLoading">
          <button v-for="item in notifications" :key="item.id" type="button" :class="['notification-item', { unread: item.status !== 'read' }]"
            :aria-disabled="notificationPending !== null" :aria-busy="notificationPending === item.id" @click="markNotificationRead(item)">
            <b>{{ item.payload.label || '流程提醒' }}<span v-if="item.status !== 'read'" class="notification-unread">未读</span></b>
            <span>{{ item.payload.description || (showcase ? [item.payload.reportType, item.payload.periodCode] : [item.payload.organization, item.payload.reportType, item.payload.periodCode]).filter(Boolean).join(' · ') }}</span>
            <small>提醒时间：{{ formatNotificationDate(item.createdAt) }}</small>
            <small v-if="item.payload.deadlineAt">截止时间：{{ formatNotificationDate(item.payload.deadlineAt) }}</small>
            <span class="notification-action">{{ notificationPending === item.id ? '正在打开详情…' : '查看详情' }}</span>
          </button>
        </div>
        <p v-else-if="!notificationLoading && !notificationError" class="notification-empty">暂无流程提醒。有新提醒时会显示在这里。</p>
        </div>
        </section>
      </div>
      <div class="user-info">
        <el-avatar :size="32" :style="{ background: userAvatarColor }">
          {{ Array.from(userName)[0] }}
        </el-avatar>
        <div class="user-detail">
          <span class="user-name" :title="userName">{{ userName }}</span>
          <span class="user-role" :title="roleLabel">{{ roleLabel }}</span>
        </div>
      </div>

      <el-dropdown trigger="click" placement="bottom-end" popper-class="header-account-menu" @command="handleCommand" @visible-change="visible => visible && closeNotifications()">
        <button type="button" class="action-trigger" aria-label="账户菜单" :disabled="logoutPending">
          <el-icon :size="18" aria-hidden="true">
            <ArrowDown />
          </el-icon>
        </button>
        <template #dropdown>
          <div class="header-account-content">
          <div id="header-account-identity" class="account-summary">
            <strong>{{ userName }}</strong>
            <p>角色：{{ roleLabel }}</p>
          </div>
          <el-dropdown-menu aria-describedby="header-account-identity">
            <el-dropdown-item command="logout">
              <el-icon><SwitchButton /></el-icon>
              退出登录
            </el-dropdown-item>
          </el-dropdown-menu>
          </div>
        </template>
      </el-dropdown>
    </div>
  </header>
</template>

<script>
import {
  ArrowDown,
  SwitchButton,
  Bell,
  Close
} from '@element-plus/icons-vue'
import { taskOperationsApi } from '../api'
import { subscribeSessionUser } from '@/utils/authSession'
import { connectNotificationFeed } from '@/utils/notificationFeed'
import { API_BASE_URL } from '@/api/base'
import { logoutFromHeader } from '@/utils/headerSession'
import { normalizeHeaderNotifications, headerNotificationError, headerRequest, openHeaderNotification } from '@/utils/headerNotifications'
import { SHOWCASE } from '@/config/showcase'

export default {
  name: 'TopHeader',
  components: {
    ArrowDown,
    SwitchButton,
    Bell,
    Close
  },
  data() {
    return {
      showcase: SHOWCASE,
      userInfo: {},
      disposed: false, logoutPending: false, notificationPending: null, notificationActionError: '', notificationAction: 0,
      unsubscribeSession: null,
      notifications: [],
      stopNotificationFeed: null, notificationToken: null, notificationState: 'connecting',
      notificationsOpen: false, notificationLoading: false, notificationError: '', notificationUnread: 0, notificationRequest: 0,
      notificationPosition: {}, notificationLayoutObserver: null,
      breadcrumbMap: {
        '/portal/home': '门户首页',
        '/portal/workflow-center': '流程中心',
        '/portal/template': '报表模板搭建',
        '/portal/template-workbench': '模板设计工作台',
        '/portal/task-progress': '进度与责任调度',
      }
    }
  },
  computed: {
    userName() { return typeof this.userInfo.name === 'string' && this.userInfo.name.trim() ? this.userInfo.name : '用户' },
    roleLabel() {
      const names = { system_admin: '系统管理员', template_designer: '模板设计者', subsidiary_filler: '填报人', subsidiary_submitter: '提交人', department_reviewer: '部门审核人', management: '管理人员', report_finalizer: '定稿人', score_editor: '评分人', organization_user_admin: '人员管理员', data_administrator: '数据管理员', business_rule_administrator: '规则管理员', business_rule_reviewer: '规则审核人' }
      const roles = Array.isArray(this.userInfo.roles) ? this.userInfo.roles : []
      const labels = [...new Set(roles.filter(role => role && typeof role === 'object').map(role => role.name || names[role.code] || role.code).filter(label => typeof label === 'string' && label))]
      if (labels.length) return labels.join('、')
      return '尚未分配角色'
    },
    currentBreadcrumb() {
      if (SHOWCASE && this.$route.path === '/portal/home') return '演示首页'
      return this.$route.meta.title || this.breadcrumbMap[this.$route.path] || ''
    },
    userAvatarColor() {
      const permissions = Array.isArray(this.userInfo.permissions) ? this.userInfo.permissions : []
      if (permissions.includes('template')) {
        return '#c14995'
      } else if (permissions.includes('report')) {
        return '#941966'
      } else {
        return '#74114f'
      }
    },
    unreadCount() { return this.notificationUnread },
    notificationStateLabel() { return ({ connecting: '正在连接提醒服务…', connected: '提醒自动更新', reconnecting: '自动更新已中断，正在重连；可点击“刷新”。', expired: '登录已过期，请重新登录后查看提醒。' })[this.notificationState] }
  },
  mounted() {
    this.unsubscribeSession = subscribeSessionUser(user => { this.userInfo = user || {}; this.startNotificationFeed() })
    document.addEventListener('pointerdown', this.onNotificationOutside)
    document.addEventListener('focusin', this.onNotificationOutside)
    window.addEventListener('resize', this.positionNotifications)
    this.notificationLayoutObserver = new ResizeObserver(this.positionNotifications)
    this.notificationLayoutObserver.observe(this.$el)
    this.notificationLayoutObserver.observe(this.$el.querySelector('.header-right'))
  },
  beforeUnmount() {
    this.unsubscribeSession?.()
    this.notificationRequest++
    this.disposed = true
    this.notificationAction++
    this.stopNotificationFeed?.()
    document.removeEventListener('pointerdown', this.onNotificationOutside)
    document.removeEventListener('focusin', this.onNotificationOutside)
    window.removeEventListener('resize', this.positionNotifications)
    this.notificationLayoutObserver?.disconnect()
  },
  methods: {
    async toggleNotifications() {
      if (this.notificationsOpen) return this.closeNotifications(true)
      this.notificationsOpen = true
      this.positionNotifications()
      this.notificationActionError = ''
      this.loadNotifications()
      await this.$nextTick()
      this.$refs.notificationClose?.focus()
    },
    closeNotifications(restoreFocus = false) {
      this.notificationsOpen = false
      if (restoreFocus) this.$refs.notificationTrigger?.$el?.focus()
    },
    positionNotifications() {
      if (!this.notificationsOpen) return
      const trigger = this.$refs.notificationTrigger?.$el
      if (!trigger) return
      this.notificationPosition = {
        '--notification-anchor-end': `${trigger.getBoundingClientRect().right}px`,
        '--notification-panel-top': `${this.$el.getBoundingClientRect().bottom + 8}px`
      }
    },
    onNotificationOutside(event) {
      if (this.notificationsOpen && !this.$refs.notificationAnchor?.contains(event.target)) this.closeNotifications()
    },
    onNotificationKeydown(event) {
      if (event.key !== 'Tab') return
      const buttons = [...this.$refs.notificationPanel.querySelectorAll('button:not(:disabled)')]
      if (event.shiftKey && event.target === buttons[0]) {
        event.preventDefault(); this.closeNotifications(true)
      } else if (!event.shiftKey && event.target === buttons.at(-1)) {
        event.preventDefault(); this.closeNotifications(); this.$el.querySelector('.action-trigger')?.focus()
      }
    },
    startNotificationFeed() {
      const token = localStorage.getItem('token')
      if (token === this.notificationToken) return
      this.stopNotificationFeed?.(); this.notificationToken = token; this.notificationRequest++
      this.notificationAction++; this.notificationPending = null; this.notificationActionError = ''
      this.notifications = []; this.notificationUnread = 0; this.notificationError = ''; this.notificationLoading = false
      if (!token) { this.closeNotifications(); return }
      const url = new URL(API_BASE_URL, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.pathname = `${url.pathname.replace(/\/$/, '')}/notifications/socket`; url.search = ''; url.hash = ''
      this.stopNotificationFeed = connectNotificationFeed({ url: url.href, token,
        onChange: () => { this.loadNotifications(); window.dispatchEvent(new Event('workflow-changed')) }, onState: state => { this.notificationState = state } })
      this.loadNotifications()
    },
    async loadNotifications() {
      const request = ++this.notificationRequest, token = localStorage.getItem('token')
      if (!token) return
      this.notificationLoading = true
      try {
        const response = normalizeHeaderNotifications(await headerRequest(signal => taskOperationsApi.getNotifications(signal)))
        if (request !== this.notificationRequest || token !== localStorage.getItem('token')) return
        this.notifications = response.notifications || []; this.notificationUnread = response.unreadCount || 0; this.notificationError = ''
      } catch (error) { if (request === this.notificationRequest && token === localStorage.getItem('token')) this.notificationError = headerNotificationError(error) }
      finally { if (request === this.notificationRequest) this.notificationLoading = false }
    },
    async markNotificationRead(item) {
      if (this.notificationPending !== null) return
      const token = localStorage.getItem('token'), action = ++this.notificationAction
      if (!token) { this.notificationActionError = '登录已过期，请重新登录后查看提醒。'; return }
      this.notificationPending = item.id
      this.notificationActionError = ''
      const isSessionCurrent = () => localStorage.getItem('token') === token
      const isCurrent = () => !this.disposed && action === this.notificationAction && isSessionCurrent()
      try {
        const result = await openHeaderNotification({ id: item.id, api: taskOperationsApi, router: this.$router, isCurrent, isSessionCurrent })
        if (!isCurrent()) return
        if (result.status === 'opened') {
          this.closeNotifications(true)
          if (result.readFailed) this.$message.warning('详情已打开，但未能标记为已读。请稍后重新打开这条提醒。')
          await this.loadNotifications()
        } else if (result.status === 'missing') {
          this.notificationActionError = '这条提醒已不可用，可能是事项或权限发生变化。请点击“刷新”更新列表。'
        } else if (result.status === 'unavailable') {
          this.notificationActionError = '暂时无法打开详情。请刷新后重试，或到流程中心查找该事项。'
        }
      } catch (error) { if (isCurrent()) this.notificationActionError = error?.name === 'AbortError' ? '打开详情超时，请重新选择这条提醒。' : '未能打开详情，请稍后重新选择这条提醒。' }
      finally { if (action === this.notificationAction) this.notificationPending = null }
    },
    formatNotificationDate(value) {
      if (!value) return '—'
      const date = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value)
      return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(date)
    },
    async handleCommand(command) {
      if (command === 'logout') {
        if (this.logoutPending) return
        this.logoutPending = true
        try {
        await this.$confirm(`退出当前账户“${this.userName}”吗？退出后需要重新登录。`, '退出登录', {
          confirmButtonText: '退出登录',
          cancelButtonText: '继续使用',
          type: 'warning'
        })
        const result = await logoutFromHeader(this.$router)
        if (result === 'logged-out') this.$message.success('已退出登录')
        else if (result === 'changed') this.$message.warning('登录状态已变化，请确认当前账户后重试。')
        } catch (error) {
          if (!['cancel', 'close'].includes(error)) this.$message.error('退出登录未完成，请稍后重试。')
        } finally { this.logoutPending = false }
      }
    }
  }
}
</script>

<style scoped>
.top-header {
  --header-height: 3.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 24px;
  height: calc(var(--header-height) + env(safe-area-inset-top));
  box-sizing: border-box;
  padding-top: env(safe-area-inset-top);
  gap: 16px;
  background: var(--portal-surface, #fff);
  border-bottom: 1px solid var(--portal-line, #e8d9e1);
  box-shadow: inset 0 3px 0 #941966, 0 2px 8px rgba(94, 12, 64, 0.05);
}

.header-left {
  flex: 1;
  min-width: 0;
}
.header-breadcrumb { display:flex; align-items:center; gap:8px; color:#6d5a65; font-size:.875rem; line-height:1.5; }
.header-breadcrumb a { flex:none; color:#2c1b26; font-weight:600; text-decoration:none; }
.header-breadcrumb a:hover { color:#941966; text-decoration:underline; text-underline-offset:3px; }
.header-breadcrumb a:focus-visible { outline:2px solid #941966; outline-offset:2px; }
.header-current-page { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

.header-right {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.notification-panel {
  --notification-panel-width:min(26rem, calc(100vw - max(12px, env(safe-area-inset-left)) - max(12px, env(safe-area-inset-right))));
  position:fixed;
  top:var(--notification-panel-top, calc(var(--header-height) + env(safe-area-inset-top) + 8px));
  left:clamp(max(12px, env(safe-area-inset-left)), calc(var(--notification-anchor-end) - var(--notification-panel-width)), calc(100vw - var(--notification-panel-width) - max(12px, env(safe-area-inset-right))));
  z-index:2000;
  width:var(--notification-panel-width);
  max-height:calc(100vh - var(--notification-panel-top) - max(12px, env(safe-area-inset-bottom)));
  max-height:calc(100dvh - var(--notification-panel-top) - max(12px, env(safe-area-inset-bottom)));
  box-sizing:border-box; display:flex; flex-direction:column; padding:12px;
  background:var(--el-bg-color-overlay, #fff); border:1px solid var(--el-border-color); border-radius:8px;
  box-shadow:0 8px 24px rgb(0 0 0 / 12%); overflow:hidden;
}
.notification-head { display:flex; flex:none; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; padding-bottom:8px; border-bottom:1px solid var(--el-border-color); color:var(--el-text-color-primary); font-size:1rem; }
.notification-head strong { min-width:0; overflow-wrap:anywhere; font-weight:600; line-height:1.5; }
.notification-head strong span { display:block; color:#6d5a65; font-size:.875rem; font-weight:400; }
.notification-tools { display:flex; flex:none; align-items:center; gap:4px; }
.notification-tools .el-button { color:var(--portal-focus, #941966); min-width:44px; min-height:44px; padding-inline:8px; font-size:.875rem; }
.notification-tools .el-button.is-disabled { color:var(--portal-muted, #6d5a65); cursor:wait; }
.notification-close { display:inline-flex; align-items:center; justify-content:center; width:44px; height:44px; border:0; border-radius:4px; background:transparent; color:#6d5a65; cursor:pointer; }
.notification-close .el-icon,.notification-trigger .el-icon { font-size:18px; }
.notification-body { min-height:0; max-height:30rem; overflow:auto; overscroll-behavior:contain; scrollbar-gutter:stable; touch-action:pan-y; }
.notification-list { min-width:0; }
.notification-item { display:flex; flex-direction:column; gap:4px; width:100%; padding:12px; border:0; border-bottom:1px solid var(--portal-line, #e8d9e1); background:var(--portal-surface, #fff); font-family:inherit; text-align:start; overflow-wrap:anywhere; cursor:pointer; }
.notification-item:last-child { border-bottom:0; }
.notification-item.unread { background:var(--portal-paper, #f8f3f6); }
.notification-item b { color:var(--portal-ink, #2c1b26); font-size:.875rem; font-weight:500; line-height:1.5; }
.notification-item.unread b { font-weight:600; }
.notification-item span,.notification-item small,.notification-empty { color:var(--portal-muted, #6d5a65); font-size:.875rem; line-height:1.5; }
.notification-item small { font-variant-numeric:tabular-nums; }
.notification-item .notification-unread { display:inline-block; margin-inline-start:8px; color:var(--portal-focus, #941966); font-size:.75rem; font-weight:600; }
.notification-empty { padding:20px 8px 6px; text-align:center; }
.notification-connection { margin:8px 0; color:#6d5a65; font-size:.875rem; line-height:1.5; }
.notification-error { color:#b42318; font-size:.875rem; line-height:1.5; overflow-wrap:anywhere; }
.notification-item .notification-action { margin-top:4px; color:var(--portal-focus, #941966); }
.notification-item[aria-disabled="true"] { cursor:progress; }
.notification-item:focus-visible,.notification-close:focus-visible,.action-trigger:focus-visible,.notification-trigger .el-button:focus-visible,.notification-tools .el-button:focus-visible { outline:2px solid var(--portal-focus, #941966); outline-offset:-2px; }
.notification-trigger .el-button { min-width:44px; min-height:44px; color:var(--portal-muted, #6d5a65); border-color:var(--portal-line, #e8d9e1); }
.notification-trigger :deep(.el-badge__content.is-fixed) { top:0; right:-6px; transform:none; }
.notification-trigger .el-button[aria-expanded="true"] { color:var(--portal-focus, #941966); border-color:var(--portal-focus, #941966); background:var(--portal-accent-surface, #f8ebf3); }
.notification-item:not([aria-disabled="true"]):active,.notification-close:active,.action-trigger:not(:disabled):active { background:var(--portal-accent-surface, #f8ebf3); }
.action-trigger:disabled { cursor:wait; color:var(--portal-muted, #6d5a65); background:var(--portal-paper, #f8f3f6); }
@media (hover: hover) and (pointer: fine) {
  .notification-item:not([aria-disabled="true"]):hover { background:var(--portal-accent-surface, #f8ebf3); }
  .notification-close:hover,.action-trigger:not(:disabled):hover { background:var(--portal-paper, #f8f3f6); }
  .notification-trigger .el-button:hover { color:var(--portal-focus, #941966); border-color:var(--portal-focus, #941966); }
}

.user-info {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-radius: 8px;
  background: var(--portal-paper, #f8f3f6);
  min-width: 0;
}
.user-info .el-avatar { flex:none; }

.user-detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: min(32vw, 400px);
}
.user-name,.user-role { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

.user-name {
  font-size: .875rem;
  font-weight: 500;
  color: #2c1b26;
  line-height: 1.4;
}

.user-role {
  font-size: .75rem;
  color: #6d5a65;
  line-height: 1.4;
}
.notification-anchor,.header-right > .el-dropdown { flex:none; }
.account-summary { padding:12px 16px; border-bottom:1px solid var(--el-border-color-light); overflow-wrap:anywhere; }
.account-summary strong { color:#2c1b26; font-size:.875rem; line-height:1.5; }
.account-summary p { margin:4px 0 0; color:#6d5a65; font-size:.875rem; line-height:1.5; }
:global(.header-account-menu) { max-width:calc(100vw - 24px); }
:global(.header-account-menu .el-scrollbar__wrap) { max-height:calc(100vh - 80px); max-height:calc(100dvh - 5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom)); overscroll-behavior:contain; }
.header-account-content { width:min(20rem, calc(100vw - 26px)); }
:global(.header-account-menu .el-dropdown-menu__item) { min-height:44px; padding-inline:16px; white-space:normal; font-size:.875rem; }

@media (max-width: 1023px), (any-pointer: coarse) {
  .notification-item { padding:16px 12px; gap:4px; }
  .notification-item b,.notification-item > span:not(.notification-unread),.notification-empty { font-size:1rem; }
  .notification-item .notification-unread,.notification-item small { font-size:.875rem; }
  .notification-tools .el-button,.account-summary strong { font-size:1rem; }
  :global(.header-account-menu .el-dropdown-menu__item) { font-size:1rem; }
}
@media (max-width: 639px) {
  .notification-body { max-height:none; }
}
@media (max-height: 480px) {
  .notification-head strong span { display:inline; margin-inline-start:8px; }
  .notification-head { padding-bottom:4px; }
}

.action-trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  color: #6d5a65;
}

@media (forced-colors: active) {
  .notification-item.unread { border:1px solid CanvasText; }
  .notification-item:focus-visible,.notification-close:focus-visible,.action-trigger:focus-visible,.notification-trigger .el-button:focus-visible,.notification-tools .el-button:focus-visible { outline-color:Highlight; }
}

:deep(.el-dropdown-menu__item) {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
