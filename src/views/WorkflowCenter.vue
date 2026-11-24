<template>
  <main class="workflow-page portal-workbench" :class="{ 'is-table-view': tableView }">
    <header class="workflow-header">
      <div><h1>{{ pageTitle }}</h1></div>
      <div class="header-actions"><el-button :loading="refreshing" @click="load(false)">刷新</el-button><el-button v-if="!showcase && canStart" type="primary" @click="changeView('start')">发起流程</el-button></div>
    </header>
    <nav aria-label="流程列表" class="workflow-tabs">
      <el-button v-for="tab in tabs" :key="tab.key" :type="view === tab.key ? 'primary' : 'default'" :plain="view !== tab.key" :aria-current="view === tab.key ? 'page' : undefined" @click="changeView(tab.key)">{{ tab.label }}<span class="tab-count">{{ counts[tab.key] || 0 }}</span></el-button>
    </nav>
    <div v-if="error" class="workflow-error" role="alert">
      <p>{{ error }}<span v-if="hasLoaded"> 当前显示上次成功读取的数据。</span></p>
      <el-button :loading="refreshing" @click="load(false)">重试加载</el-button>
    </div>
    <p v-if="loading" class="workflow-loading" role="status">正在读取流程列表与权限…</p>
    <section v-if="view === 'start'" class="start-section">
      <h2>选择要发起的业务</h2>
      <div class="start-grid"><article v-for="entry in starters" :key="entry.title" class="start-card"><h3>{{ entry.title }}</h3><p>{{ entry.description }}</p><el-button type="primary" plain @click="start(entry.target)">{{ entry.action }}</el-button></article></div>
      <el-empty v-if="!starters.length" description="当前账号没有可发起的业务，请联系系统管理员分配职责。" />
    </section>
    <template v-else>
      <div class="workflow-filter">
        <label>业务类型<el-select v-model="type" popper-class="workflow-select-options" clearable placeholder="全部业务" @change="updateFilters"><el-option v-for="(label,key) in typeLabels" :key="key" :label="label" :value="key" /></el-select></label>
        <label>状态<el-select v-model="status" popper-class="workflow-select-options" clearable placeholder="全部状态" @change="updateFilters"><el-option v-for="label in statusOptions" :key="label" :label="label" :value="label" /></el-select></label>
        <span class="result-count" aria-live="polite">{{ viewTitle }} · {{ hasLoaded ? `${displayedCount ?? filtered.length} 项` : '尚未读取' }}</span>
        <el-button class="workflow-view-toggle" :aria-pressed="tableView" @click="tableView = !tableView">{{ tableView ? '切换事项列表' : '切换完整表格' }}</el-button>
        <el-button v-if="view === 'manage' && canManage" text @click="start('/portal/task-progress')">进度与责任调度 →</el-button>
      </div>
      <el-alert v-if="view === 'manage' && hasLoaded && !canManage" title="当前账号没有流程管理权限" type="warning" :closable="false" />
      <app-data-table v-else-if="hasLoaded" :key="tableKey" accessible :table-label="`${viewTitle}流程事项`" :data="filtered" row-key="id" @filtered-count="displayedCount = $event" empty-text="暂无符合条件的事项">
        <template #compact="{ rows }">
          <div class="workflow-compact">
            <p class="workflow-list-hint">需要按列筛选或排序时，可切换完整表格。</p>
            <ul v-if="rows.length" class="workflow-items" :aria-label="`${viewTitle}事项列表`">
              <li v-for="row in rows" :key="row.id" class="workflow-item">
                <div class="workflow-item-main">
                  <div class="workflow-item-heading"><h3>{{ row.name }}<small v-if="row.version" class="version">v{{ row.version }}</small></h3></div>
                  <p class="workflow-item-context">{{ typeLabels[row.kind] || row.kind }}<template v-if="row.period && row.period !== '—'"> · {{ row.period }}</template><template v-if="!showcase && row.organization && row.organization !== '—'"> · {{ row.organization }}</template></p>
                </div>
                <div class="workflow-item-progress">
                  <el-tag :type="row.statusLabel === '已完成' ? 'success' : row.todo ? 'warning' : 'info'" effect="plain">{{ row.statusLabel }}</el-tag>
                  <p v-if="row.stage && row.stage !== '—' && row.stage !== row.statusLabel">{{ row.stage }}</p>
                  <p v-if="row.assignees && row.assignees !== '—'">处理人：{{ row.assignees }}</p>
                  <p v-if="row.deadline && row.deadline !== '—'">截止：{{ formatDate(row.deadline) }}</p>
                </div>
                <details class="workflow-item-details"><summary>更多信息<span class="sr-only">：{{ row.name }}</span></summary><dl class="workflow-item-facts"><dt>发起人</dt><dd>{{ row.initiator }}</dd><dt>当前环节</dt><dd>{{ row.stage }}</dd><dt>当前处理人</dt><dd>{{ row.assignees }}</dd><dt>截止时间</dt><dd>{{ formatDate(row.deadline) }}</dd></dl></details>
                <el-button class="workflow-item-action" :type="row.todo ? 'primary' : 'default'" :aria-label="`${row.todo ? '办理' : row.kind === 'period' ? '继续配置' : '查看'}：${row.name}`" @click="handle(row)">{{ row.todo ? '办理' : row.kind === 'period' ? '继续配置' : '查看' }}</el-button>
              </li>
            </ul>
            <el-empty v-else description="暂无符合条件的事项" />
          </div>
        </template>
        <el-table-column prop="name" label="事项名称" min-width="205"><template #default="{row}"><strong>{{ row.name }}</strong><small v-if="row.version" class="version">v{{ row.version }}</small></template></el-table-column>
        <el-table-column :column-value="row => typeLabels[row.kind] || row.kind" label="业务类型" min-width="135"><template #default="{row}">{{ typeLabels[row.kind] || row.kind }}</template></el-table-column>
        <el-table-column :column-value="row => showcase ? row.period : row.period + ' · ' + row.organization" :label="showcase ? '周期' : '周期／组织'" min-width="155"><template #default="{row}"><div>{{ row.period }}</div><small v-if="!showcase">{{ row.organization }}</small></template></el-table-column>
        <el-table-column prop="initiator" label="发起人" min-width="125" />
        <el-table-column prop="stage" label="当前环节" min-width="135" />
        <el-table-column prop="assignees" label="当前处理人" min-width="155" />
        <el-table-column prop="deadline" label="截止时间" min-width="155"><template #default="{row}">{{ formatDate(row.deadline) }}</template></el-table-column>
        <el-table-column prop="statusLabel" label="状态" min-width="120"><template #default="{row}"><el-tag :type="row.statusLabel === '已完成' ? 'success' : row.todo ? 'warning' : 'info'" effect="plain">{{ row.statusLabel }}</el-tag></template></el-table-column>
        <el-table-column label="操作" fixed="right" width="98"><template #default="{row}"><el-button link type="primary" :aria-label="`${row.todo ? '办理' : row.kind === 'period' ? '继续配置' : '查看'}：${row.name}`" @click="handle(row)">{{ row.todo ? '办理' : row.kind === 'period' ? '继续配置' : '查看' }}</el-button></template></el-table-column>
      </app-data-table>
    </template>
    <el-dialog v-model="detailOpen" class="workflow-detail" title="流程当前状态" width="min(520px, 90vw)">
      <el-descriptions v-if="detail" :column="1" border><el-descriptions-item label="事项">{{ detail.name }}</el-descriptions-item><el-descriptions-item :label="showcase ? '周期' : '周期／组织'">{{ showcase ? detail.period : `${detail.period} · ${detail.organization}` }}</el-descriptions-item><el-descriptions-item label="当前环节">{{ detail.stage }}</el-descriptions-item><el-descriptions-item label="当前处理人">{{ detail.assignees }}</el-descriptions-item><el-descriptions-item label="状态">{{ detail.statusLabel }}</el-descriptions-item></el-descriptions>
      <p>事项已流转到其他环节，当前账号无需办理。</p>
      <template #footer><el-button @click="detailOpen = false">关闭</el-button></template>
    </el-dialog>
  </main>
</template>
<script>
import { workflowApi } from '@/api'
import { createWorkflowRequest, normalizeWorkflowResult, workflowError, formatWorkflowDate } from '@/utils/workflowRequest'
import { SHOWCASE } from '@/config/showcase'
const typeLabels = { monthly: '月度填报', quarterly: '季度填报', field: '业务字段', rule: '业务规则', component: '组件搭建', template: '模板搭建', report_template: '报表模板', period: '填报计划' }
export default {
  name: 'WorkflowCenter',
  data: () => ({ showcase: SHOWCASE, items: [], counts: {}, loading: false, refreshing: false, hasLoaded: false, error: '', canManage: false, typeLabels, type: '', status: '', tableView: false, displayedCount: null, detail: null, detailOpen: false, roles: [] }),
  computed: {
    view() {
      const requested = ['todo','initiated','handled','manage','start'].includes(this.$route.query.view) ? this.$route.query.view : 'todo'
      return this.showcase && requested === 'start' ? 'todo' : requested
    },
    pageTitle() {
      if (!this.showcase) return '流程中心'
      if (this.view === 'manage') return '流程进度'
      if (this.view === 'start') return '发起流程'
      return '我的流程'
    },
    viewTitle() {
      if (this.showcase && this.view === 'manage') return '流程进度'
      return ({ todo: '我的待办', initiated: '我发起的', handled: '我的已办', manage: '流程管理' })[this.view] || '发起流程'
    },
    tabs() {
      if (this.showcase) return [{ key: 'todo', label: '待办' }, { key: 'initiated', label: '我发起的' }, { key: 'handled', label: '已办' }]
      return [{ key: 'todo', label: '我的待办' }, { key: 'initiated', label: '我发起的' }, { key: 'handled', label: '我的已办' }, ...(this.canManage ? [{ key: 'manage', label: '流程管理' }] : [])]
    },
    visible() { const rows = this.items.filter(row => row[this.view === 'manage' ? 'manageable' : this.view]); return this.showcase ? rows.filter(row => row.status !== 'cancelled' && row.statusLabel !== '已取消') : rows },
    statusOptions() { return [...new Set(this.visible.map(row => row.statusLabel))] },
    filtered() { return this.visible.filter(row => (!this.type || row.kind === this.type) && (!this.status || row.statusLabel === this.status)) },
    tableKey() { return JSON.stringify([this.view, this.type, this.status]) },
    canStart() { return this.starters.length > 0 },
    starters() {
      if (this.showcase) return []
      const has = codes => this.roles.some(r => r.code === 'system_admin' || codes.includes(r.code))
      return [
        has(['management']) && { title: '周期填报', description: this.showcase ? '选择模板、责任人和期限，检查后激活。' : '选择模板、参与组织、责任人和期限，检查后激活。月度、季度流程按周期包分配办理。', action: '配置并发起', target: '/portal/period-configuration?start=new' },
        has(['template_designer','data_administrator']) && { title: '业务字段', description: this.showcase ? '字段是业务口径的字典；管理员创建的字段直接生效。' : '提出字段或新版本，由系统管理员审批。管理员创建的字段直接生效。', action: this.showcase ? '新建字段' : '新建字段提案', target: '/portal/field-catalog?start=new' },
        !this.showcase && has(['business_rule_administrator']) && { title: '业务规则', description: '编写并测试规则，提交系统管理员审批。管理员提交时免审发布。', action: '新建业务规则', target: '/portal/rule-catalog?start=new' },
        has(['template_designer']) && { title: '组件与模板', description: '设计组件或完整模板，通过发布检查后提交。审批统一由系统管理员处理。', action: '进入模板搭建', target: '/portal/template?section=templates' },
        has(['template_designer']) && { title: '报表模板', description: '用 ReportSheet 设计报表布局，发布后按定稿数据手动或定时生成。', action: '设计报表模板', target: '/portal/report-studio?edit=new' },
      ].filter(Boolean)
    },
  },
  watch: {
    '$route.query': { immediate: true, handler(query) { this.type = typeof query.type === 'string' && Object.hasOwn(typeLabels, query.type) ? query.type : ''; this.status = typeof query.status === 'string' ? query.status : '' } },
    tableKey() { this.displayedCount = null },
  },
  created() {
    this._workflowRequest = createWorkflowRequest({
      request: signal => workflowApi.list(signal),
      start: quiet => { this.refreshing = true; this.loading = !quiet || !this.hasLoaded; this.error = '' },
      success: result => { Object.assign(this, normalizeWorkflowResult(result)); this.hasLoaded = true },
      failure: error => {
        this.error = workflowError(error)
        if ([401, 403].includes(error?.status)) { this.items = []; this.counts = {}; this.canManage = false; this.hasLoaded = false; this.detailOpen = false }
      },
      finish: () => { this.loading = false; this.refreshing = false },
    })
  },
  mounted() {
    try { const roles = JSON.parse(localStorage.getItem('userInfo') || '{}')?.roles; this.roles = Array.isArray(roles) ? roles.filter(role => role && typeof role.code === 'string') : [] } catch {}
    this.load(); window.addEventListener('workflow-changed', this.refreshQuietly)
    window.addEventListener('focus', this.refreshQuietly)
  },
  beforeUnmount() { this._workflowRequest.dispose(); window.removeEventListener('workflow-changed', this.refreshQuietly); window.removeEventListener('focus', this.refreshQuietly) },
  methods: {
    load(quiet = false) { return this._workflowRequest.run(quiet === true) },
    refreshQuietly() { this.load(true) },
    changeView(view) { this.$router.push({ path: '/portal/workflow-center', query: { view } }) },
    updateFilters() { this.$router.replace({ path: '/portal/workflow-center', query: { view: this.view, ...(this.type ? { type: this.type } : {}), ...(this.status ? { status: this.status } : {}) } }) },
    start(target) { this.navigate(target, this.view) },
    handle(row) { if (!row.target) { this.detail = row; this.detailOpen = true; return } this.navigate(row.target + (row.target.includes('?') ? '&' : '?') + 'workflowStage=' + encodeURIComponent(row.stage), this.view) },
    navigate(target, from) { const url = new URL(target, window.location.origin); this.$router.push({ path: url.pathname, query: { ...Object.fromEntries(url.searchParams), workflowFrom: from, ...(this.type ? { workflowType: this.type } : {}), ...(this.status ? { workflowStatus: this.status } : {}) } }) },
    formatDate: formatWorkflowDate,
  },
}
</script>
<style scoped>
.workflow-error { display:flex; align-items:center; flex-wrap:wrap; gap:12px; padding:12px 16px; margin-bottom:16px; border:1px solid #e8b4ae; border-radius:6px; background:#fff5f4; color:#b42318; }
.workflow-error p { flex:1 1 240px; margin:0; overflow-wrap:anywhere; }
.workflow-loading { color:var(--portal-muted); margin:0 0 16px; }
.workflow-page :deep(.accessible-data-table) { min-width:0; max-width:100%; }
/* Keep all nine columns inside the keyboard-focusable scroll region. */
.workflow-page :deep(.accessible-table-scroll > .app-data-table) { min-width:1283px; }
.workflow-page :deep(.accessible-table-scroll:focus-visible) { outline:2px solid var(--portal-focus); outline-offset:2px; }
.workflow-page :deep(.app-data-table .cell) { overflow-wrap:anywhere; max-width:36rem; }
.workflow-page :deep(.el-pagination) { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; margin-top:12px; }
:global(.workflow-detail .el-descriptions__content) { overflow-wrap:anywhere; word-break:break-word; }
.workflow-header { display:flex; align-items:center; justify-content:space-between; gap:16px; }
h1 { margin:0; }
.header-actions,.workflow-tabs { display:flex; gap:8px; flex-wrap:wrap; } .workflow-tabs { margin:24px 0; }
.workflow-tabs .el-button+.el-button { margin-left:0; } .tab-count { margin-left:8px; font-variant-numeric:tabular-nums; }
.workflow-filter { display:flex; gap:16px; align-items:end; flex-wrap:wrap; margin-bottom:16px; }
.workflow-filter label { display:grid; gap:8px; font-size:14px; color:var(--portal-muted); } .workflow-filter .el-select { width:180px; }
.result-count { margin:0 auto 8px 0; color:var(--portal-muted); font-size:14px; font-variant-numeric:tabular-nums; }
.version { margin-left:8px; } small { color:var(--portal-muted); } strong { font-weight:500; }
.start-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.start-card { background:var(--portal-paper,#fff); border:1px solid var(--portal-line,#e2e8f0); border-radius:8px; padding:24px; }
.start-card h3 { margin:0 0 12px; font-size:18px; } .start-card p { color:var(--portal-muted); line-height:1.7; min-height:48px; margin:0 0 20px; }
.start-section h2 { font-size:18px; margin:24px 0 16px; } .el-alert { margin-bottom:12px; }
@media(max-width:800px) { .start-grid { grid-template-columns:1fr; } .workflow-header { align-items:flex-start; } .workflow-filter .el-select { width:150px; } }
</style>
<style src="../styles/workflow-center-adaptation.css"></style>
<style src="../styles/workflow-center-polish.css"></style>
