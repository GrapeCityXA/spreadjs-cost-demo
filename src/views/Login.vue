<template>
  <div class="login-page">
    <header class="login-header">
      <a class="login-logo" href="https://www.grapecity.com.cn/developer/spreadjs" target="_blank"
        rel="noopener noreferrer" aria-label="SpreadJS 产品首页">
        <img :src="spjsLogo" alt="SpreadJS" />
      </a>
      <nav class="login-nav" aria-label="SpreadJS 相关站点">
        <a href="https://www.grapecity.com.cn/developer/spreadjs" target="_blank" rel="noopener noreferrer">产品首页</a>
        <a class="is-active" href="https://www.grapecity.com.cn/developer/spreadjs/demo" target="_blank"
          rel="noopener noreferrer" aria-current="page">在线 Demo</a>
        <a href="https://demo.grapecity.com.cn/spreadjs/help/docs/" target="_blank" rel="noopener noreferrer">产品文档</a>
        <a href="https://demo.grapecity.com.cn/spreadjs/help/api/" target="_blank" rel="noopener noreferrer">API 参考</a>
        <a href="https://gcdn.grapecity.com.cn/showforum-230-1.html" target="_blank" rel="noopener noreferrer">技术社区</a>
      </nav>
      <div class="login-actions">
        <a class="login-cta is-primary" href="https://www.grapecity.com.cn/applyonline" target="_blank"
          rel="noopener noreferrer">预约技术顾问</a>
        <a class="login-cta" href="https://www.grapecity.com.cn/developer/spreadjs/download" target="_blank"
          rel="noopener noreferrer">立即试用</a>
      </div>
    </header>

    <main class="login-container" aria-labelledby="login-title">
      <el-card class="login-card" shadow="never">
        <div class="login-layout">
          <section class="login-intro">
            <p class="intro-eyebrow">SpreadJS 在线演示</p>
            <h1 id="login-title">成本指标协同填报</h1>
            <p class="intro-desc">围绕成本指标模板设计、协同填报、审核定稿与报表输出，完整演示一条线上填报链路。</p>
            <ol class="intro-steps">
              <li v-for="step in steps" :key="step.key">
                <span class="step-no">{{ step.no }}</span>
                <span class="step-text">
                  <strong>{{ step.label }}</strong>
                  <small>{{ step.hint }}</small>
                </span>
              </li>
            </ol>
            <p class="intro-note">选择右侧任一视角即可进入，无需输入账号密码。</p>
          </section>

          <section class="login-accounts" :aria-busy="loading">
            <header class="accounts-head">
              <h2>{{ showcase ? '选择演示视角' : '选择角色进入' }}</h2>
              <p>{{ showcase
                ? '不同视角对应不同的操作权限，退出后可随时切换。'
                : '两位填报人可在独立窗口登录，共同编辑同一任务。' }}</p>
            </header>

            <div class="account-list">
              <button v-for="account in loginAccounts" :key="account.username" type="button" class="account-item"
                :class="{ 'is-pending': loading && pendingUsername === account.username }" :disabled="loading"
                @click="quickLogin(account)">
                <span class="account-icon" aria-hidden="true">
                  <el-icon><component :is="account.icon" /></el-icon>
                </span>
                <span class="account-body">
                  <span class="account-heading">
                    <span class="account-name">{{ account.name }}</span>
                    <span class="account-role">{{ account.roleLabel }}</span>
                  </span>
                  <template v-if="!showcase">
                    <span class="account-username">{{ account.username }}</span>
                    <span class="account-password">密码：{{ account.password }}</span>
                  </template>
                  <span v-else-if="account.desc" class="account-desc">{{ account.desc }}</span>
                </span>
                <span class="account-arrow" aria-hidden="true">
                  <el-icon v-if="loading && pendingUsername === account.username" class="is-loading"><Loading /></el-icon>
                  <el-icon v-else><ArrowRight /></el-icon>
                </span>
              </button>
            </div>

            <p v-if="loginError" ref="loginError" class="login-error" role="alert" tabindex="-1">{{ loginError }}</p>
            <span class="sr-only" role="status">{{ loading ? '正在登录，请稍候。' : '' }}</span>

            <footer class="accounts-foot">
              <p class="foot-title">演示提示</p>
              <ul>
                <li><el-icon aria-hidden="true"><Monitor /></el-icon>建议使用最新版 Chrome / Edge 浏览器</li>
                <li><el-icon aria-hidden="true"><UserFilled /></el-icon>填报人一、二可同时登录，协同编辑同一任务</li>
                <li><el-icon aria-hidden="true"><RefreshLeft /></el-icon>演示数据会定时重置，可放心操作</li>
              </ul>
            </footer>
          </section>
        </div>
      </el-card>
    </main>
  </div>
</template>

<script>
import {
  Setting, EditPen, UserFilled, CircleCheck, Lock,
  ArrowRight, Loading, Monitor, RefreshLeft
} from '@element-plus/icons-vue'
import spjsLogo from '@/assets/spjs_logo.png'
import { authApi } from '@/api'
import { SHOWCASE, DEMO_IDENTITIES, DEMO_STEPS } from '@/config/showcase'

const IDENTITY_ICONS = {
  admin: Setting,
  filler: EditPen,
  filler2: UserFilled,
  reviewer: CircleCheck
}

export default {
  name: 'Login',
  components: {
    Setting,
    EditPen,
    UserFilled,
    CircleCheck,
    Lock,
    ArrowRight,
    Loading,
    Monitor,
    RefreshLeft
  },
  data() {
    return {
      showcase: SHOWCASE,
      spjsLogo,
      steps: DEMO_STEPS,
      acceptanceAccounts: [
        { username: 'browser-user', password: 'browser-password', name: '系统管理员', roleLabel: '系统管理', icon: Setting },
        { username: 'browser-designer', password: 'browser-designer-password', name: '模板设计者', roleLabel: '模板设计', icon: EditPen },
        { username: '组织填报人一', password: 'browser-scoped-password', name: '填报人一', roleLabel: '协同填报', icon: UserFilled },
        { username: 'browser-scoped-user-2', password: 'browser-scoped-password-2', name: '填报人二', roleLabel: '协同填报', icon: UserFilled },
        { username: 'browser-quarter-reviewer', password: 'browser-quarter-reviewer-password', name: '季度部门审核人', roleLabel: '审核与评分', icon: CircleCheck },
        { username: 'evidence-outsider', password: 'evidence-outsider-password', name: '范围外用户', roleLabel: '权限边界', icon: Lock }
      ],
      loading: false,
      pendingUsername: '',
      loginError: '',
      loginController: null,
      loginTimeout: null,
      disposed: false
    }
  },
  beforeUnmount() {
    this.disposed = true
    this.loginController?.abort()
    clearTimeout(this.loginTimeout)
  },
  computed: {
    loginAccounts() {
      if (!this.showcase) return this.acceptanceAccounts
      const names = { admin: '管理员', filler: '填报人一', filler2: '填报人二', reviewer: '审核人' }
      const roles = { admin: '模板设计', filler: '协同填报', filler2: '协同填报', reviewer: '审核定稿' }
      const descs = {
        admin: '维护模板与校验规则',
        filler: '与填报人二共同填写',
        filler2: '与填报人一共同填写',
        reviewer: '审核填报并定稿'
      }
      return DEMO_IDENTITIES.map(item => ({
        username: item.username,
        password: item.password,
        name: names[item.key] || item.label,
        roleLabel: roles[item.key] || item.label,
        desc: descs[item.key] || '',
        icon: IDENTITY_ICONS[item.key] || UserFilled
      }))
    }
  },
  methods: {
    quickLogin(account) {
      if (this.loading || this.disposed) return
      this.pendingUsername = account.username
      this.handleLogin(account.username, account.password)
    },
    async handleLogin(username, password) {
      if (this.loading || this.disposed) return
      this.loading = true
      this.loginError = ''
      let timedOut = false

      try {
        const controller = new AbortController()
        this.loginController = controller
        this.loginTimeout = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, 15000)
        const response = await authApi.login(username, password, { signal: controller.signal })
        if (this.disposed) return
        clearTimeout(this.loginTimeout)
        if (!response || typeof response.token !== 'string' || !response.token.trim() || !response.user?.id || !Array.isArray(response.user.roles)) {
          throw new Error('登录服务返回的信息不完整，请稍后重试。')
        }

        try {
          localStorage.setItem('token', response.token)
          localStorage.setItem('userInfo', JSON.stringify(response.user))
        } catch {
          try {
            if (localStorage.getItem('token') === response.token) {
              localStorage.removeItem('token')
              localStorage.removeItem('userInfo')
            }
          } catch { /* Storage may be unavailable entirely. */ }
          throw new Error('浏览器无法保存登录状态，请允许此站点存储数据后重试。')
        }

        const failure = await this.$router.push('/portal')
        if (failure || this.$route.path === '/login') {
          throw new Error('暂时无法打开工作空间，请稍后重试；若持续失败，请联系管理员。')
        }
        this.$message.success('登录成功')
      } catch (error) {
        if (this.disposed) return
        if (timedOut) this.loginError = '登录请求超时，请检查网络后重新点击。'
        else if (error.status === 401) this.loginError = '所选账号暂时无法登录，请稍后重试。'
        else if (error.status === 403) this.loginError = '此账号暂时无法登录，请联系管理员确认账号权限。'
        else if (error.status === 429) this.loginError = '登录尝试过于频繁，请稍后再试。'
        else if (error.status >= 500 || error.status === 404) this.loginError = '登录服务暂时不可用，请稍后重试。'
        else if (error instanceof TypeError) this.loginError = '无法连接登录服务，请检查网络后重试。'
        else if (error instanceof SyntaxError) this.loginError = '登录服务返回的信息无法读取，请稍后重试。'
        else this.loginError = error.message || '登录未完成，请稍后重试。'
        await this.$nextTick()
        this.$refs.loginError?.focus()
      } finally {
        clearTimeout(this.loginTimeout)
        this.loginController = null
        this.pendingUsername = ''
        this.loading = false
      }
    }
  }
}
</script>

<style scoped>
.login-page {
  --login-page-padding: 24px;
  --login-canvas: #f8f3f6;
  --login-surface: #ffffff;
  --login-text: #2c1b26;
  --login-text-secondary: #6d5a65;
  --login-text-label: #5a4652;
  --login-action: #941966;
  --login-action-hover: #7d1455;
  --login-action-active: #6f114b;
  --login-action-surface: #f8ebf3;
  --login-on-action: #ffffff;
  --login-role-text: #7d2a5e;
  --login-line: #e8d9e1;
  --login-control-line: #c9aeba;
  --login-disabled-surface: #f1e6ec;
  --login-disabled-text: #7c6a75;
  --login-error: #b42318;
  --login-error-surface: #fff4f2;
  --login-shadow: 0 18px 48px rgb(74 20 52 / 12%);
  --el-color-primary: var(--login-action);
  --el-color-danger: var(--login-error);
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(1200px 520px at 12% -10%, #f3e2ec 0%, transparent 60%),
    radial-gradient(900px 420px at 92% 108%, #f5e7ef 0%, transparent 55%),
    var(--login-canvas);
  color: var(--login-text);
  font-family: var(--font-sans);
}
.login-container {
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  scroll-padding-block: var(--login-page-padding);
  padding: max(var(--login-page-padding), env(safe-area-inset-top))
    max(var(--login-page-padding), env(safe-area-inset-right))
    max(var(--login-page-padding), env(safe-area-inset-bottom))
    max(var(--login-page-padding), env(safe-area-inset-left));
  scrollbar-color: var(--login-control-line) var(--login-canvas);
}
.login-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 28px;
  min-height: 76px;
  padding: 0 48px;
  background: var(--login-surface);
  border-bottom: 1px solid var(--login-line);
}
.login-logo { display: flex; align-items: center; flex-shrink: 0; text-decoration: none; }
.login-logo img { display: block; width: 150px; height: auto; }
.login-nav { display: flex; align-items: center; justify-content: flex-end; gap: 30px; min-width: 0; margin-left: auto; }
.login-nav a { position: relative; padding: 9px 0; color: var(--login-text-label); font-size: 14px; line-height: 1.5; text-decoration: none; white-space: nowrap; transition: color .15s; }
.login-nav a::after { content: ''; position: absolute; left: 0; right: 0; bottom: 1px; height: 2px; background: var(--login-action); transform: scaleX(0); transform-origin: left; transition: transform .18s ease; }
.login-nav a:hover, .login-nav a.is-active { color: var(--login-action); }
.login-nav a:hover::after, .login-nav a.is-active::after { transform: scaleX(1); }
.login-nav a:focus-visible { outline: 2px solid var(--login-action); outline-offset: 2px; }
.login-actions { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.login-cta { display: inline-flex; align-items: center; justify-content: center; min-height: 38px; padding: 0 16px; border: 1px solid var(--login-control-line); border-radius: 4px; color: var(--login-text); font-size: 13px; line-height: 1.4; text-decoration: none; white-space: nowrap; transition: border-color .15s, color .15s, background-color .15s; }
.login-cta:hover { border-color: var(--login-action); color: var(--login-action); background: var(--login-action-surface); }
.login-cta.is-primary { background: var(--login-action); border-color: var(--login-action); color: var(--login-on-action); }
.login-cta.is-primary:hover { background: var(--login-action-hover); border-color: var(--login-action-hover); color: var(--login-on-action); }
.login-cta:focus-visible { outline: 2px solid var(--login-action); outline-offset: 2px; }
.login-card {
  width: min(100%, 1040px);
  min-width: 0;
  flex-shrink: 0;
  margin: auto;
  border: 1px solid var(--login-line);
  background: var(--login-surface);
  border-radius: 16px;
  box-shadow: var(--login-shadow);
  overflow: hidden;
}
.login-page ::selection { color: var(--login-on-action); background: var(--login-action); }
.login-card :deep(.el-card__body) { padding: 0; }
.login-layout { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); }

/* 左侧介绍 */
.login-intro {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 36px 34px;
  color: #fff;
  background:
    radial-gradient(420px 260px at 105% -8%, rgb(255 255 255 / 16%) 0%, transparent 60%),
    radial-gradient(320px 260px at -18% 112%, rgb(255 255 255 / 10%) 0%, transparent 55%),
    linear-gradient(155deg, #54133b 0%, #7d1455 52%, #a5246f 100%);
}
.login-intro::after {
  content: '';
  position: absolute;
  right: -70px;
  bottom: -90px;
  width: 240px;
  height: 240px;
  border: 34px solid rgb(255 255 255 / 6%);
  border-radius: 50%;
  pointer-events: none;
}
.intro-eyebrow {
  margin: 0 0 12px;
  font-size: 12px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: rgb(255 255 255 / 72%);
}
.login-intro h1 { margin: 0; font-size: 28px; font-weight: 600; line-height: 1.35; letter-spacing: .01em; }
.intro-desc { margin: 10px 0 0; max-width: 34em; font-size: 14px; line-height: 1.7; color: rgb(255 255 255 / 84%); }
.intro-steps {
  list-style: none;
  margin: 18px 0 0;
  padding: 0;
  display: grid;
  gap: 2px;
}
.intro-steps li { display: flex; align-items: flex-start; gap: 12px; padding: 8px 0; border-top: 1px solid rgb(255 255 255 / 14%); }
.intro-steps li:last-child { border-bottom: 1px solid rgb(255 255 255 / 14%); }
.step-no { flex: none; font-size: 12px; font-weight: 600; line-height: 1.9; color: rgb(255 255 255 / 58%); font-variant-numeric: tabular-nums; }
.step-text { display: grid; gap: 2px; min-width: 0; }
.step-text strong { font-size: 14px; font-weight: 500; line-height: 1.6; }
.step-text small { font-size: 12px; line-height: 1.55; color: rgb(255 255 255 / 68%); }
.intro-note { margin: auto 0 0; padding-top: 18px; font-size: 12px; line-height: 1.6; color: rgb(255 255 255 / 64%); }

/* 右侧视角选择 */
.login-accounts { display: flex; flex-direction: column; padding: 36px 32px 32px; }
.accounts-head { margin-bottom: 20px; }
.accounts-head h2 { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.4; color: var(--login-text); }
.accounts-head p { margin: 6px 0 0; font-size: 13px; line-height: 1.6; color: var(--login-text-secondary); }
.account-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.account-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-width: 0;
  min-height: 76px;
  padding: 15px 16px;
  border: 1px solid var(--login-line);
  border-radius: 10px;
  background: var(--login-surface);
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: border-color .15s, background-color .15s, box-shadow .15s, transform .15s;
}
.account-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--login-action-surface);
  color: var(--login-action);
  font-size: 19px;
}
.account-body { display: grid; gap: 2px; min-width: 0; flex: 1; }
.account-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.account-name { min-width: 0; overflow-wrap: anywhere; color: var(--login-text); font-size: 15px; font-weight: 600; line-height: 1.5; }
.account-role { flex-shrink: 0; color: var(--login-role-text); background: var(--login-action-surface); border-radius: 4px; padding: 1px 6px; font-size: 11px; line-height: 1.6; white-space: nowrap; }
.account-username, .account-password { color: var(--login-text-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.account-desc { color: var(--login-text-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.account-arrow { flex: none; display: inline-flex; color: var(--login-control-line); font-size: 15px; transition: color .15s, transform .15s; }
@media (hover: hover) {
  .account-item:hover:not(:disabled) { border-color: var(--login-action); background: #fdf8fb; box-shadow: 0 8px 20px rgb(74 20 52 / 10%); transform: translateY(-1px); }
  .account-item:hover:not(:disabled) .account-arrow { color: var(--login-action); transform: translateX(2px); }
}
.account-item:active:not(:disabled) { border-color: var(--login-action-active); background: var(--login-action-surface); }
.account-item:focus-visible { outline: 2px solid var(--login-action); outline-offset: 2px; }
.account-item:disabled { cursor: wait; }
.account-item:disabled:not(.is-pending) { opacity: .6; background: var(--login-disabled-surface); }
.account-item.is-pending { border-color: var(--login-action); background: var(--login-action-surface); }
.account-item.is-pending .account-arrow { color: var(--login-action); transform: none; }
.login-error { margin: 16px 0 0; padding: 12px 14px; border: 1px solid var(--login-error); border-radius: 8px; background: var(--login-error-surface); color: var(--login-error); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.login-error:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.accounts-foot {
  margin-top: auto;
  padding: 14px 16px;
  border: 1px solid #f0e3ea;
  border-radius: 10px;
  background: #faf6f8;
}
.accounts-foot .foot-title { margin: 0 0 8px; color: var(--login-role-text); font-size: 12px; font-weight: 600; line-height: 1.5; }
.accounts-foot ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.accounts-foot li { display: flex; align-items: flex-start; gap: 8px; color: var(--login-text-secondary); font-size: 12px; line-height: 1.6; }
.accounts-foot li .el-icon { flex: none; margin-top: 3px; color: var(--login-control-line); font-size: 13px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }

@media (max-width: 1100px) {
  .login-page { --login-page-padding: 20px; }
  .login-header { padding: 0 32px; gap: 22px; }
  .login-logo img { width: 140px; }
  .login-nav { gap: 22px; }
  .login-cta { padding: 0 14px; }
  .login-intro { padding: 32px 28px; }
  .login-accounts { padding: 30px 24px 26px; }
}
@media (max-width: 1000px) {
  .login-nav { display: none; }
}
@media (max-width: 880px) {
  .login-layout { grid-template-columns: minmax(0, 1fr); }
  .login-intro { padding: 28px 28px 24px; }
  .login-intro::after { display: none; }
  .login-intro h1 { font-size: 24px; }
  .intro-desc { font-size: 13px; margin-top: 8px; }
  .intro-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 20px; margin-top: 16px; }
  .intro-steps li { padding: 8px 0; }
  .intro-steps li:nth-child(2) { border-top: 1px solid rgb(255 255 255 / 14%); }
  .intro-steps li:nth-last-child(-n + 2) { border-bottom: 1px solid rgb(255 255 255 / 14%); }
  .intro-note { padding-top: 16px; }
  .login-accounts { padding: 24px; }
}
@media (max-width: 760px) {
  .login-page { --login-page-padding: 16px; }
  .login-header { min-height: 64px; padding: 0 20px; gap: 12px; }
  .login-logo img { width: 128px; }
  .login-actions { gap: 8px; }
  .login-cta { min-height: 36px; padding: 0 12px; font-size: 12px; }
  .login-intro { padding: 24px 20px 20px; }
  .login-intro h1 { font-size: 22px; }
  .intro-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 16px; }
  .intro-steps li { padding: 7px 0; }
  .step-text small { display: none; }
  .intro-note { padding-top: 12px; }
  .login-accounts { padding: 20px; }
  .account-list { grid-template-columns: minmax(0, 1fr); }
  .account-item { min-height: 64px; padding: 12px 14px; }
}
@media (max-width: 480px) {
  .login-page { --login-page-padding: 12px; }
  .login-header { min-height: 60px; padding: 0 16px; }
  .login-logo img { width: 112px; }
  .login-cta:not(.is-primary) { display: none; }
  .login-cta.is-primary { min-height: 34px; padding: 0 11px; }
  .login-card { border-radius: 12px; }
  .login-intro { padding: 22px 18px 18px; }
  .accounts-head h2 { font-size: 18px; }
  .login-accounts { padding: 18px; }
}
@media (max-height: 700px) and (min-width: 881px) {
  .login-intro { padding: 28px 32px; }
  .intro-steps { margin-top: 16px; }
  .login-accounts { padding: 26px 28px; }
  .account-item { min-height: 64px; }
}
@media (forced-colors: active) {
  .account-item:focus-visible, .login-cta:focus-visible { outline-color: Highlight; }
}
@media (prefers-reduced-motion: reduce) {
  .account-item, .account-arrow, .login-nav a::after { transition: none; }
}
</style>
