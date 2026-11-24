<template>
  <main id="dashboard-content" tabindex="-1" class="operations-dashboard portal-workbench">
    <header class="operations-header">
      <div><h1>填报与数据看板</h1><p>从任务进度到定稿指标，查看处理情况与数据来源。</p></div>
      <div class="refresh-controls">
        <div class="refresh-meta">
          <small>{{ updated ? `更新于 ${updated}（北京时间）` : '尚未取得数据' }}<br>{{ autoRefresh ? (selection ? '查看详情期间暂停刷新' : '每 30 秒自动刷新') : '自动刷新已暂停' }}</small>
          <p class="dashboard-load-status" role="status">{{ loading ? (hasLoaded ? '正在刷新，暂时显示上次成功读取的数据。' : '正在读取看板数据，请稍候。') : error ? (hasLoaded ? '数据未更新，以下保留上次成功读取的结果。' : '看板数据尚未加载。') : hasLoaded ? '看板数据已更新。' : '' }}</p>
        </div>
        <div class="refresh-actions">
          <el-button :aria-pressed="!autoRefresh" @click="autoRefresh = !autoRefresh">{{ autoRefresh ? '暂停自动刷新' : '恢复自动刷新' }}</el-button>
          <el-button type="primary" plain :loading="loading" @click="load"><el-icon v-if="!loading" aria-hidden="true"><Refresh /></el-icon><span>立即刷新</span></el-button>
        </div>
      </div>
    </header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon><el-button :loading="loading" @click="load">重试加载</el-button></el-alert>
    <el-skeleton v-if="!hasLoaded && loading" :rows="6" />
    <template v-if="hasLoaded">
    <section class="overview-cards" aria-label="任务概况">
      <article><span>全部填报任务</span><strong>{{ data.tasks.length }}</strong><small>所有期间 · 当前可见范围</small></article>
      <article><span>进行中</span><strong>{{ activeTasks.length }}</strong><small>填报、审核、评分及定稿</small></article>
      <article><span>等待定稿</span><strong>{{ finalizingCount }}</strong><small>当前停留在定稿环节</small></article>
      <article><span>已完成</span><strong>{{ completedCount }}</strong><small>已完成正式定稿</small></article>
    </section>
    <div class="dashboard-task-grid">
    <DashboardTaskProgress :items="data.tasks" :can-manage="data.canManage" :invalid-count="data.invalidTaskCount" @retry="load" @inspect="inspectTask" />
    <section class="quality-panel" aria-labelledby="quality-heading">
      <div class="section-heading"><div><h2 id="quality-heading">数据检查情况</h2><p>展示最近提交版本。筛选仅针对单元格检查，历史业务预警单独列出；未记录不代表检查通过。</p></div><el-select popper-class="dashboard-select-options" v-model="qualityFilter" aria-label="单元格检查筛选"><el-option value="all" label="全部单元格检查" /><el-option value="issues" label="单元格有错误或提示" /><el-option value="missing" label="尚未提交／未记录检查" /><el-option value="passed" label="已检查范围通过" /></el-select></div>
      <app-data-table accessible responsive table-label="任务数据检查情况" :data="qualityRows" row-key="taskId" max-height="390" :empty-text="data.tasks.length ? '没有匹配的任务，请调整检查条件或表头筛选。' : '当前可见范围暂无填报任务。'">
        <template #compact="{ rows }"><div class="dashboard-compact-list" aria-label="数据检查摘要">
          <p v-if="!rows.length" class="compact-empty">{{ data.tasks.length ? '没有匹配的任务，请调整检查条件或表头筛选。' : '当前可见范围暂无填报任务。' }}</p>
          <article v-for="row in rows" :key="row.taskId" class="dashboard-summary-row">
            <h3>{{ row.name }}</h3><p class="summary-context">{{ showcase ? row.period : `${row.organization} · ${row.period}` }} · {{ row.submittedRevisionNumber ? `R${row.submittedRevisionNumber}` : '尚未提交' }}</p>
            <p><strong :class="{ 'needs-attention': ['errors','warnings'].includes(row.validation?.status) }">{{ qualityLabel(row) }}</strong></p>
            <p v-if="row.validation" class="summary-context">检查 {{ row.validation.checkedCount }} 格 · 未覆盖 {{ row.validation.skippedCount }} 格</p>
            <p v-if="row.legacyWarningCount" class="summary-context">历史业务预警 {{ row.legacyWarningCount }} 条</p>
            <div class="summary-actions"><el-button :disabled="!row.submittedRevisionId" @click="selection = { taskId: row.taskId, revisionId: row.submittedRevisionId, tab: 'checks' }">查看检查记录</el-button></div>
          </article>
        </div></template>
        <el-table-column prop="name" label="任务" min-width="170" /><el-table-column v-if="!showcase" prop="organization" label="公司" min-width="150" /><el-table-column prop="period" label="期间" width="125" />
        <el-table-column :column-value="r => r.submittedRevisionNumber || ''" label="最近提交" width="125"><template #default="{row}">{{ row.submittedRevisionNumber ? `R${row.submittedRevisionNumber}` : '尚未提交' }}</template></el-table-column>
        <el-table-column :column-value="r => qualityLabel(r)" label="检查结果" min-width="180"><template #default="{row}"><strong :class="{ 'needs-attention': ['errors','warnings'].includes(row.validation?.status) }">{{ qualityLabel(row) }}</strong><small v-if="row.validation" class="quality-meta">检查 {{ row.validation.checkedCount }} 格 · 未覆盖 {{ row.validation.skippedCount }} 格</small><small v-if="row.legacyWarningCount" class="quality-meta">历史业务预警 {{ row.legacyWarningCount }} 条</small></template></el-table-column>
        <el-table-column label="操作" width="130" class-name="dashboard-actions-cell"><template #default="{row}"><el-button link type="primary" :disabled="!row.submittedRevisionId" @click="selection = { taskId: row.taskId, revisionId: row.submittedRevisionId, tab: 'checks' }">查看检查记录</el-button></template></el-table-column>
      </app-data-table>
    </section>
    </div>
    <DashboardBusinessMetrics :fields="data.fields" :types="data.types" :values="data.values" @inspect="inspectValue" />
    <el-collapse v-if="!showcase && quarterPeriods.length" v-model="scoreOpen" @change="loadScores" class="score-panel">
      <el-collapse-item name="scores" title="季度评分与排名">
        <div class="score-filter"><el-select popper-class="dashboard-select-options" v-model="scorePeriod" aria-label="评分季度"><el-option v-for="p in quarterPeriods" :key="p" :value="p" :label="p" /></el-select><span>采用季度评分流程的正式定稿结果。</span></div>
        <el-alert v-if="scoreError" :title="scoreError" type="warning" :closable="false"><el-button :loading="scoreLoading" @click="loadScores">重新加载排名</el-button></el-alert>
        <p v-if="scoreLoading || (scoreError && scoresPeriod === scorePeriod)" role="status">{{ scoresPeriod === scorePeriod ? (scoreLoading ? '正在刷新排名，暂时显示上次成功读取的结果。' : '排名未更新，以下保留上次成功读取的结果。') : '正在读取所选季度排名…' }}</p>
        
        <app-data-table v-if="scoresPeriod === scorePeriod" accessible responsive table-label="季度评分与排名" :data="scores" empty-text="该季度没有评分排名">
          <template #compact="{ rows }"><div class="dashboard-compact-list" aria-label="季度排名摘要">
            <p v-if="!rows.length" class="compact-empty">该季度没有匹配的评分排名</p>
            <article v-for="(row, index) in rows" :key="row.organizationId || index" class="dashboard-summary-row">
              <h3>{{ row.organizationName }}</h3><p>排名 {{ row.rank ?? '—' }} · 总分 {{ row.totalScore ?? '—' }}</p>
              <p class="summary-context">上季排名 {{ row.previousRank ?? '—' }} · 排名变化 {{ row.rankMovement ?? '—' }}</p>
            </article>
          </div></template><el-table-column prop="organizationName" label="公司" /><el-table-column prop="rank" label="排名" align="right" class-name="dashboard-numeric-cell" /><el-table-column prop="totalScore" label="总分" align="right" class-name="dashboard-numeric-cell" /><el-table-column prop="previousRank" label="上季排名" align="right" class-name="dashboard-numeric-cell" /><el-table-column prop="rankMovement" label="排名变化" align="right" class-name="dashboard-numeric-cell" /></app-data-table>
      </el-collapse-item>
    </el-collapse>
    </template>
    <DashboardSnapshotDialog :open="Boolean(selection)" :selection="selection" @close="selection = null" />
  </main>
</template>
<script setup>
import '@/styles/dashboard-adaptation.css'
import '@/styles/dashboard-hardening.css'
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { createDashboardRequest } from '@/components/dashboardRequest'
import { reuseDashboardData } from '@/components/dashboardPerformance'
import { normalizeDashboardTasks } from '@/components/dashboardTaskState'
import { managementDashboardApi } from '@/api'
import DashboardTaskProgress from '@/components/DashboardTaskProgress.vue'
import DashboardBusinessMetrics from '@/components/DashboardBusinessMetrics.vue'
import DashboardSnapshotDialog from '@/components/DashboardSnapshotDialog.vue'
import { SHOWCASE } from '@/config/showcase'
const showcase = SHOWCASE
const overviewRequest = createDashboardRequest('看板数据'), scoreRequest = createDashboardRequest('季度排名')
const { loading, error } = overviewRequest
const { loading: scoreLoading, error: scoreError } = scoreRequest
const emptyData = () => ({ tasks: [], fields: [], types: [], values: [], canManage: false, invalidTaskCount: 0 })
const data = shallowRef(emptyData()), hasLoaded = ref(false), autoRefresh = ref(true), updated = ref(''), selection = shallowRef(null), qualityFilter = ref('all')
const scoreOpen = ref([]), scorePeriod = ref(''), scores = ref([]), scoresPeriod = ref('')
const labels = { passed: '已检查范围通过', partial: '仅检查部分单元格', no_rules: '未配置单元格检查', warnings: '存在提示', errors: '存在错误' }
const terminal = t => ['finalized','cancelled','canceled','closed'].includes(t.status)
const activeTasks = computed(() => data.value.tasks.filter(t => !terminal(t)))
const completedCount = computed(() => data.value.tasks.filter(t => t.status === 'finalized').length)
const finalizingCount = computed(() => activeTasks.value.filter(t => t.flow?.steps?.some(s => s.key === 'finalizing' && s.state === 'current')).length)
const qualityLabel = t => !t.submittedRevisionId ? '尚未提交' : !t.validation ? '未记录' : labels[t.validation.status] || '未记录'
const qualityRows = computed(() => data.value.tasks.filter(t => qualityFilter.value === 'all' || (qualityFilter.value === 'missing' ? !t.validation : qualityFilter.value === 'issues' ? ['errors','warnings'].includes(t.validation?.status) : t.validation?.status === 'passed')))
const quarterPeriods = computed(() => [...new Set(data.value.tasks.filter(t => t.kind === 'quarterly' && t.effectiveRevisionId).map(t => t.period))].sort().reverse())
function inspectTask(t) { selection.value = { taskId: t.taskId, revisionId: t.effectiveRevisionId || t.submittedRevisionId } }
function inspectValue(v) { selection.value = { taskId: v.taskId, revisionId: v.revisionId, tab: 'values', cell: { sheetName: v.sheetName, row: v.row, col: v.col } } }
let timer, disposed = false
async function load() {
  if (loading.value || disposed) return
  await overviewRequest.run(signal => managementDashboardApi.overview({ signal }), result => {
    if (!['tasks', 'fields', 'types', 'values'].every(key => Array.isArray(result?.[key]))) throw new Error('Invalid overview')
    const normalized = normalizeDashboardTasks(showcase ? result.tasks.filter(t => t.status !== 'cancelled' && t.status !== 'canceled') : result.tasks)
    data.value = reuseDashboardData(data.value, { ...result, tasks: normalized.tasks, invalidTaskCount: normalized.invalidCount, canManage: result.canManage === true }); hasLoaded.value = true
    updated.value = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date())
    const previous = scorePeriod.value
    if (!quarterPeriods.value.includes(previous)) scorePeriod.value = quarterPeriods.value[0] || ''
    else if (scoreOpen.value.length) loadScores()
  }, failure => {
    if ([401, 403].includes(failure?.status)) {
      hasLoaded.value = false; data.value = emptyData(); updated.value = ''; selection.value = null
      scoreRequest.cancel(); scores.value = []; scoresPeriod.value = ''
    }
  })
}
async function loadScores() {
  if (!scoreOpen.value.length || !scorePeriod.value) { scoreRequest.cancel(); return }
  const period = scorePeriod.value
  if (scoresPeriod.value !== period) { scores.value = []; scoresPeriod.value = '' }
  await scoreRequest.run(signal => managementDashboardApi.getDashboard({ period }, { signal }), result => {
    if (!Array.isArray(result?.ranking)) throw new Error('Invalid ranking')
    scores.value = result.ranking; scoresPeriod.value = period
  }, failure => {
    if ([401, 403].includes(failure?.status)) { scores.value = []; scoresPeriod.value = '' }
  })
}
watch(scorePeriod, loadScores)
onMounted(() => { load(); timer = setInterval(() => { if (autoRefresh.value && !document.hidden && !selection.value) load() }, 30000) })
onBeforeUnmount(() => { disposed = true; clearInterval(timer); overviewRequest.cancel(); scoreRequest.cancel() })
</script>
<style scoped>
.operations-dashboard{display:grid;gap:20px;color:var(--el-text-color-primary)}.operations-header,.section-heading{display:flex;justify-content:space-between;align-items:center;gap:20px}.operations-header h1{font-size:28px;margin:5px 0 10px}.operations-header p,.section-heading p{font-size:13px;color:var(--el-text-color-regular);margin:7px 0;line-height:1.6}.refresh-controls{display:flex;align-items:center;gap:14px}.refresh-controls small{color:var(--el-text-color-secondary);font-size:12px}.overview-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.overview-cards article{display:grid;gap:13px;padding:19px;border:1px solid var(--el-border-color);border-radius:9px;background:var(--el-bg-color)}.overview-cards span{font-size:13px;color:var(--el-text-color-regular)}.overview-cards strong{font-size:30px;font-variant-numeric:tabular-nums}.overview-cards small{font-size:12px;color:var(--el-text-color-secondary)}.quality-panel,.score-panel{padding:20px;border:1px solid var(--el-border-color);border-radius:9px;background:var(--el-bg-color);min-width:0}.section-heading{margin-bottom:16px}.section-heading h2{margin:0;font-size:17px}.section-heading .el-select{width:210px;flex-shrink:0}.quality-meta{display:block;color:var(--el-text-color-secondary);font-size:12px;margin-top:5px}.needs-attention{color:var(--el-color-warning-dark-2)}.score-filter{display:flex;gap:16px;align-items:center;margin-bottom:14px;font-size:13px}.score-filter .el-select{width:190px}.operations-dashboard :deep(.task-progress-card){margin-top:0}@media(max-width:900px){.operations-header{align-items:flex-start;flex-direction:column}.overview-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.section-heading{align-items:flex-start;flex-wrap:wrap}.refresh-controls{flex-wrap:wrap}}
</style>
