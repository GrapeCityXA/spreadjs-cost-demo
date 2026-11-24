<template>
  <main class="demo-home" aria-labelledby="demo-home-title">
    <el-alert v-if="blocked" type="info" show-icon :closable="false" class="blocked"
      title="该功能不在官网演示范围内"
      :description="blockedDescription" />

    <section class="hero">
      <p class="eyebrow">SpreadJS · 成本指标报表</p>
      <h1 id="demo-home-title">在浏览器里，走完一条真实的报表流程</h1>
      <p class="lede">从导入 Excel 设计模板，到多人实时协同填报，再到审核定稿和生成报表。每一步都是真实运行的系统，不是录屏。</p>
      <div class="hero-actions">
        <el-button type="primary" size="large" @click="go(continueStep)">{{ hasProgress ? '继续演示' : '开始完整流程' }}</el-button>
        <el-button v-if="fillStep" size="large" plain @click="go(fillStep)">3 分钟：直接看协同填报</el-button>
      </div>
      <p class="hero-note">演示数据会定时重置；协同体验请复制任务链接，用另一个浏览器窗口以其他账号登录。</p>
    </section>

    <section class="steps" aria-label="演示步骤">
      <article v-for="(step, index) in availableSteps" :key="step.key" class="step-card" :class="{ visited: visited.includes(step.key) }">
        <div class="step-top">
          <span class="step-no">{{ step.no }}</span>
          <span v-if="visited.includes(step.key)" class="step-state done">已浏览</span>
          <span v-else-if="index === firstUnvisitedIndex" class="step-state next">从这里开始</span>
        </div>
        <h2>{{ step.label }}</h2>
        <p>{{ step.hint }}</p>
        <div class="step-caps">
          <span v-for="cap in capabilitiesFor(step.path)" :key="cap">{{ cap }}</span>
        </div>
        <div class="step-foot">
          <button type="button" class="step-link" @click="go(step)">{{ visited.includes(step.key) ? '再看一次' : '进入' }} →</button>
        </div>
      </article>
    </section>

    <p v-if="availableSteps.length < steps.length" class="view-note">当前视角只显示可操作的步骤；其他步骤请退出后选择对应身份。</p>

    <section class="facts" aria-label="演示说明">
      <div class="fact">
        <h3>真实服务端</h3>
        <p>登录、权限、任务与协同都由常驻服务处理，配置和填报数据存在数据库里，多端看到同一份。</p>
      </div>
      <div class="fact">
        <h3>真实协同</h3>
        <p>同一任务可以多人同时编辑，操作通过 WebSocket 实时同步，在线状态与选区可见。</p>
      </div>
      <div class="fact">
        <h3>模板与数据分离</h3>
        <p>模板只保留结构和绑定，填报数据按任务装配；提交后形成不可变版本，供审核与报表使用。</p>
      </div>
    </section>

    <div class="home-foot">
      <button type="button" class="reset-link" title="只清除本地已浏览标记，不重置服务端数据" @click="resetProgress">重置演示进度</button>
    </div>
  </main>
</template>

<script>
import { DEMO_STEPS, capabilitiesFor, demoAccess } from '@/config/showcase'
import { readSessionUser } from '@/utils/authSession'
import { readDemoProgress, resetDemoProgress } from '@/utils/demoProgress'

export default {
  name: 'DemoHome',
  data() {
    return { steps: DEMO_STEPS, visited: [], userInfo: readSessionUser() }
  },
  computed: {
    access() { return demoAccess(this.userInfo) },
    availableSteps() { return this.steps.filter(step => this.access[step.key]) },
    fillStep() { return this.availableSteps.find(step => step.key === 'fill') },
    firstUnvisitedIndex() { return this.availableSteps.findIndex(step => !this.visited.includes(step.key)) },
    continueStep() { return this.firstUnvisitedIndex >= 0 ? this.availableSteps[this.firstUnvisitedIndex] : this.availableSteps[0] },
    hasProgress() { return this.visited.some(key => this.access[key]) },
    blocked() { return this.$route.query.showcaseBlocked === '1' },
    blockedDescription() {
      const page = typeof this.$route.query.page === 'string' ? this.$route.query.page : ''
      return page ? `「${page}」属于支撑功能，官网版默认收起。请从下面的主线步骤继续体验。` : '请从下面的主线步骤继续体验。'
    }
  },
  mounted() {
    this.visited = readDemoProgress()
    this._onProgress = () => { this.visited = readDemoProgress() }
    window.addEventListener('demo-progress-changed', this._onProgress)
  },
  beforeUnmount() { window.removeEventListener('demo-progress-changed', this._onProgress) },
  methods: {
    capabilitiesFor,
    go(step) { if (step) this.$router.push(step.path).catch(() => {}) },
    resetProgress() {
      resetDemoProgress()
      this.visited = []
    }
  }
}
</script>

<style scoped>
.demo-home {
  max-width: 1180px;
  margin: 0 auto;
  padding: 34px 24px 48px;
  color: var(--portal-ink, #2c1b26);
}
.blocked { margin-bottom: 22px; }
.hero {
  position: relative;
  overflow: hidden;
  max-width: none;
  padding: 38px 40px 34px;
  border-radius: 18px;
  background: linear-gradient(135deg, #941966 0%, #74114f 62%, #5a0c3d 100%);
  color: #fff;
  box-shadow: 0 22px 50px rgb(94 12 64 / 22%);
}
.hero::after {
  content: '';
  position: absolute;
  right: -90px;
  top: -150px;
  width: 360px;
  height: 360px;
  border-radius: 50%;
  background: rgb(255 255 255 / 8%);
  pointer-events: none;
}
.eyebrow {
  margin: 0 0 10px;
  font-family: "IBM Plex Mono", ui-monospace, monospace;
  font-size: 11px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: #f4b7d8;
}
.hero h1 {
  margin: 0;
  font-size: clamp(28px, 3.6vw, 40px);
  line-height: 1.2;
  letter-spacing: -.01em;
  text-wrap: balance;
  color: #fff;
}
.lede {
  margin: 14px 0 0;
  max-width: 62ch;
  font-size: 16px;
  line-height: 1.75;
  color: rgb(255 255 255 / 82%);
}
.hero-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
.hero-actions :deep(.el-button--primary) {
  --el-button-bg-color: #fff;
  --el-button-border-color: #fff;
  --el-button-text-color: #74114f;
  --el-button-hover-bg-color: #f8ebf3;
  --el-button-hover-border-color: #f8ebf3;
  --el-button-hover-text-color: #5f0e40;
}
.hero-actions :deep(.el-button.is-plain) {
  --el-button-bg-color: transparent;
  --el-button-border-color: rgb(255 255 255 / 48%);
  --el-button-text-color: #fff;
  --el-button-hover-bg-color: rgb(255 255 255 / 12%);
  --el-button-hover-border-color: rgb(255 255 255 / 75%);
  --el-button-hover-text-color: #fff;
}
.hero-note { margin: 14px 0 0; font-size: 12.5px; color: rgb(255 255 255 / 62%); }

.steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 14px;
  margin-top: 38px;
}
.step-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 420px;
  padding: 18px 18px 14px;
  background: #fff;
  border: 1px solid var(--portal-line, #e8d9e1);
  border-radius: 9px;
}
.step-card.visited { border-color: #d8a9c4; background: #fffafc; }
.step-top { display: flex; align-items: center; justify-content: space-between; min-height: 20px; }
.step-no {
  font-family: "IBM Plex Mono", ui-monospace, monospace;
  font-size: 11px;
  letter-spacing: .12em;
  color: #941966;
}
.step-state { font-size: 11px; padding: 1px 7px; border-radius: 3px; }
.step-state.done { color: #941966; background: #f6e7f0; }
.step-state.next { color: #8a5a12; background: #f7ecd9; }
.step-card h2 { margin: 12px 0 0; font-size: 17px; line-height: 1.4; }
.step-card p { margin: 7px 0 0; font-size: 13px; line-height: 1.65; color: var(--portal-muted, #6d5a65); flex: 1; }
.step-caps { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 12px; }
.step-caps span {
  font-size: 11px;
  color: #7d2a5e;
  border: 1px solid #e6c9da;
  border-radius: 3px;
  padding: 1px 6px;
}
.step-foot { margin-top: 14px; padding-top: 11px; border-top: 1px solid var(--portal-line, #e8d9e1); }
.step-link {
  border: 0;
  background: none;
  padding: 0;
  color: #941966;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.step-link:hover { text-decoration: underline; }

.facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  margin-top: 30px;
  border: 1px solid var(--portal-line, #e8d9e1);
  border-radius: 9px;
  background: #fdf8fb;
  box-shadow: 0 1px 2px rgb(148 25 102 / 4%);
}
.fact { padding: 16px 18px; border-left: 1px solid var(--portal-line, #e8d9e1); }
.fact:first-child { border-left: 0; }
.fact h3 { margin: 0 0 6px; font-size: 13.5px; }
.fact p { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--portal-muted, #6d5a65); }
.home-foot { display: flex; justify-content: flex-end; margin-top: 16px; }
.view-note { margin: 14px 0 0; font-size: 12px; color: var(--portal-muted, #6d5a65); }
.reset-link {
  border: 0;
  background: none;
  padding: 4px 0;
  color: var(--portal-muted, #6d5a65);
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.reset-link:hover { color: var(--portal-ink, #2c1b26); }
.reset-link:focus-visible { outline: 2px solid #941966; outline-offset: 2px; }

@media (max-width: 1023px) {
  .demo-home { padding: 28px 20px 44px; }
}
@media (max-width: 640px) {
  .demo-home { padding: 24px 16px 40px; }
  .steps, .facts { grid-template-columns: 1fr; }
  .fact { border-left: 0; border-top: 1px solid var(--portal-line, #e8d9e1); }
  .fact:first-child { border-top: 0; }
}
</style>
