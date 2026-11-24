<template>
  <DemoHome v-if="showcase" />
  <main v-else class="home-container" aria-labelledby="home-title">
    <el-alert v-if="$route.query.noPermission === 'true'" type="warning" show-icon :closable="false" role="alert"
      title="刚才的页面访问未获授权"
      :description="deniedDescription" />
    <div class="welcome-section">
      <h1 id="home-title" class="welcome-title">欢迎来到成本指标平台</h1>
      <p class="welcome-subtitle">{{ greeting }}</p>
    </div>

    <div v-if="identity.incomplete" class="home-feedback" role="alert">
      <p>登录信息暂不完整，请刷新页面重新核验；如仍无法读取，请通过右上角账户菜单重新登录。</p>
      <el-button @click="reloadPage">刷新页面</el-button>
    </div>
    <el-button v-if="identity.hasRoles" class="workflow-entry" type="primary" :loading="opening" :disabled="opening" @click="openWorkflow">进入流程中心 · 我的待办</el-button>
    <p v-if="opening" class="home-status" role="status">正在核验身份并打开流程中心…</p>
    <p v-if="navigationError" ref="navigationFeedback" class="home-feedback" role="alert" tabindex="-1">{{ navigationError }}</p>
    <section class="user-info-card" aria-labelledby="home-account-title">
      <el-card shadow="never">
        <template #header>
          <div class="card-header">
            <el-icon aria-hidden="true">
              <User />
            </el-icon>
            <h2 id="home-account-title">当前登录信息</h2>
          </div>
        </template>
        <dl class="info-grid">
          <div class="info-item">
            <dt class="label">用户名：</dt>
            <dd class="value"><bdi>{{ identity.name }}</bdi></dd>
          </div>
          <div class="info-item">
            <dt class="label">账号：</dt>
            <dd class="value"><bdi>{{ identity.username }}</bdi></dd>
          </div>
          <div class="info-item">
            <dt class="label">角色：</dt>
            <dd class="value"><bdi>{{ identity.roleLabel }}</bdi></dd>
          </div>
          <div class="info-item">
            <dt class="label">单独配置权限：</dt>
            <dd class="value"><bdi>{{ identity.permissionText }}</bdi></dd>
          </div>
        </dl>
        <p class="permission-note">此处列出账号单独配置的权限，角色和任务也会影响可操作范围。</p>
      </el-card>
    </section>

    <el-alert v-if="identity.noRoles" title="尚未分配协同填报角色" type="info" :closable="false"
      description="请联系系统管理员分配角色及任务后，再进入流程中心。" />
  </main>
</template>

<script>
import { User } from '@element-plus/icons-vue'
import { subscribeSessionUser } from '@/utils/authSession'
import { homeIdentity, deniedAccessDescription } from '@/utils/homeIdentity'
import DemoHome from './DemoHome.vue'
import { SHOWCASE } from '@/config/showcase'

export default {
  name: 'Home',
  components: {
    User,
    DemoHome
  },
  data() {
    return {
      showcase: SHOWCASE,
      userInfo: {},
      unsubscribeSession: null,
      greeting: '',
      opening: false,
      navigationError: ''
    }
  },
  computed: {
    identity() { return homeIdentity(this.userInfo) },
    deniedDescription() { return deniedAccessDescription(this.$route.query, this.identity.hasIdentity ? this.identity.username : '') }
  },
  mounted() {
    this._alive = true
    this.unsubscribeSession = subscribeSessionUser(user => { this.userInfo = user; this.navigationError = '' })
    this.setGreeting()
  },
  beforeUnmount() { this._alive = false; this.unsubscribeSession?.() },
  methods: {
    reloadPage() { window.location.reload() },
    async openWorkflow() {
      if (this.opening || !this.identity.hasRoles) return
      this.opening = true; this.navigationError = ''
      try {
        const failure = await this.$router.push('/portal/workflow-center?view=todo')
        if (this._alive && failure) this.showNavigationError()
      } catch { if (this._alive) this.showNavigationError() }
      finally { if (this._alive) this.opening = false }
    },
    showNavigationError() {
      this.navigationError = '暂时无法打开流程中心，请检查网络后重试；如仍无法进入，请刷新页面重新核验身份。'
      this.$nextTick(() => this.$refs.navigationFeedback?.focus())
    },
    setGreeting() {
      const hour = new Date().getHours()
      if (hour < 6) {
        this.greeting = '夜深了，注意休息'
      } else if (hour < 9) {
        this.greeting = '早上好，开始新的一天'
      } else if (hour < 12) {
        this.greeting = '上午好，工作顺利'
      } else if (hour < 14) {
        this.greeting = '中午好，记得休息'
      } else if (hour < 18) {
        this.greeting = '下午好，继续加油'
      } else {
        this.greeting = '晚上好，明天见'
      }
    }
  }
}
</script>

<style scoped>
.home-container {
  --el-color-primary: #941966;
  --el-color-primary-light-3: #7a1454;
  --el-color-primary-dark-2: #6f114b;
  container: home / inline-size;
  box-sizing: border-box;
  padding: 24px 16px max(24px, env(safe-area-inset-bottom));
  max-width: 1400px;
  margin: 0 auto;
  min-width: 0;
  font-size: 16px;
  overflow-wrap: anywhere;
}

.welcome-section {
  text-align: start;
  margin-bottom: 24px;
}

.welcome-title {
  font-size: 24px;
  font-weight: 600;
  color: #2c1b26;
  line-height: 1.4;
  text-wrap: balance;
  margin: 0 0 8px;
}

.welcome-subtitle {
  font-size: 16px;
  line-height: 1.6;
  margin: 0;
  color: var(--portal-muted, #6d5a65);
}

.user-info-card {
  margin-bottom: 24px;
}

.user-info-card :deep(.el-card) {
  border-color: var(--portal-line, #e8d9e1);
  border-radius: var(--portal-radius-panel, 8px);
}

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.card-header h2 { margin: 0; font-size: 16px; line-height: 1.5; }
.card-header .el-icon { color: var(--portal-muted, #6d5a65); flex-shrink: 0; }
.workflow-entry { width: 100%; min-height: 44px; height: auto; max-width: 100%; padding: 10px 16px; font-size: 16px; white-space: normal; margin-bottom: 24px; }
.workflow-entry :deep(span) { min-width: 0; overflow-wrap: anywhere; line-height: 1.5; }
.permission-note, .home-status { color: var(--portal-muted, #6d5a65); font-size: 14px; line-height: 1.6; margin: 16px 0 0; }
.permission-note { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--portal-line, #e8d9e1); text-wrap: pretty; }
.home-status { margin: 0 0 16px; }
.home-feedback { margin: 0 0 16px; padding: 16px; background: #fff5f4; color: #922419; border: 1px solid #e8b4ae; border-radius: 6px; line-height: 1.6; }
.home-feedback p { margin: 0 0 12px; }
.home-feedback .el-button { min-height: 44px; }
.home-container :is(button, [tabindex]):focus-visible { outline: 2px solid #941966; outline-offset: 2px; }
.home-container ::selection { color: #6f114b; background: var(--portal-accent-surface, #f8ebf3); }
.home-container :deep(.el-alert--warning.is-light) { color: #8a5300; }
.home-container :deep(.el-alert--info.is-light) { color: var(--portal-muted, #6d5a65); }
.home-container :deep(.el-alert) { margin-bottom: 24px; }
.home-container :deep(.el-alert__content) { min-width: 0; }
.home-container :deep(.el-alert__description) { font-size: 14px; line-height: 1.6; }
.user-info-card :deep(.el-card__header),
.user-info-card :deep(.el-card__body) { padding: 16px; }

.info-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 20px 32px;
  margin: 0;
}

.info-item {
  display: grid;
  align-content: start;
  min-width: 0;
  gap: 4px;
  line-height: 1.6;
}

.info-item .label {
  color: var(--portal-muted, #6d5a65);
  font-size: 14px;
}

.info-item .value {
  color: #2c1b26;
  font-weight: 500;
  min-width: 0;
  margin: 0;
}

/* Use the remaining workspace width, including changes to the navigation rail. */
@container home (min-width: 640px) {
  .welcome-title { font-size: 32px; }
  .workflow-entry { width: auto; }
  .info-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .user-info-card :deep(.el-card__header),
  .user-info-card :deep(.el-card__body) { padding: 20px 24px; }
  .user-info-card :deep(.el-card__header) { padding-block: 16px; }
}

@media (min-width: 768px) {
  .home-container { padding: 24px; }
}
</style>
