<template>
  <section class="task-progress-card" :aria-labelledby="headingId" :aria-busy="loading" v-loading="loading">
    <div class="progress-heading">
      <div><h2 :id="headingId">全部填报任务进度</h2><p>查看当前账号可见的月报、季报任务及各阶段进度。</p></div>
      <el-button @click="$router.push({ path: '/portal/workflow-center', query: { view: canManage ? 'manage' : 'todo' } })">进入流程中心</el-button>
    </div>
    <div class="progress-filters">
      <div class="progress-filter-fields">
      <div class="progress-field progress-field-search">
        <label :for="`${headingId}-search`">搜索任务</label>
        <el-input :id="`${headingId}-search`" v-model="search" clearable :placeholder="showcase ? '任务名称或任务编号' : '任务名称、公司或任务编号'" :aria-label="showcase ? '搜索任务或任务编号' : '搜索任务、公司或任务编号'" />
      </div>
      <div class="progress-field">
        <label :for="`${headingId}-period`">填报期间</label>
        <el-select :id="`${headingId}-period`" :popper-class="items ? 'dashboard-select-options' : undefined" v-model="period" clearable placeholder="全部期间" aria-label="填报期间"><el-option v-for="p in periods" :key="p" :value="p" :label="p" /></el-select>
      </div>
      <div class="progress-field">
        <label :for="`${headingId}-kind`">填报类型</label>
        <el-select :id="`${headingId}-kind`" :popper-class="items ? 'dashboard-select-options' : undefined" v-model="kind" clearable placeholder="全部类型" aria-label="填报类型"><el-option value="monthly" label="月报" /><el-option value="quarterly" label="季报" /></el-select>
      </div>
      <div class="progress-field progress-field-status">
        <label :for="`${headingId}-status`">进度状态</label>
        <el-select :id="`${headingId}-status`" :popper-class="items ? 'dashboard-select-options' : undefined" v-model="status" clearable placeholder="全部状态" aria-label="填报进度状态"><el-option value="active" label="进行中" /><el-option value="finalized" label="已完成" /><el-option value="stopped" label="已取消／结束" /></el-select>
      </div>
      </div>
      <div class="progress-filter-meta">
      <span class="task-count" aria-live="polite">{{ countLabel }}</span>
      <el-button v-if="search || period || kind || status || columnFiltersActive" @click="clearFilters">清除全部筛选</el-button>
      </div>
    </div>
    <p v-if="filterNotice" role="status" class="progress-feedback">{{ filterNotice }}</p>
    <el-alert v-if="invalidCount" :title="`有 ${invalidCount} 项任务信息不完整或重复，暂未显示。`" type="warning" :closable="false" show-icon><el-button text :loading="loading" @click="retry">重新加载任务</el-button></el-alert>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon><el-button text :loading="loading" @click="load">重新加载任务</el-button></el-alert>
    <app-data-table v-if="!error" ref="progressTable" :accessible="Boolean(items)" :responsive="Boolean(items)" table-label="全部填报任务进度" :data="filtered" @filtered-count="matchedCount = $event" @filters-active="columnFiltersActive = $event" row-key="taskId" max-height="560" class="progress-table" :empty-text="emptyText">
      <template v-if="items" #compact="{ rows }">
        <div class="dashboard-compact-list" aria-label="填报任务摘要">
          <p v-if="!rows.length" class="compact-empty">{{ emptyText }}</p>
          <article v-for="row in rows" :key="row.taskId" class="dashboard-summary-row">
            <h3>{{ row.name }}</h3><p class="summary-context">{{ showcase ? (row.period || '期间未记录') : `${row.organization} · ${row.period || '期间未记录'}` }}</p>
            <p class="summary-context">任务 #{{ row.taskId }} · {{ taskKindLabel(row.kind) }} · {{ row.stage }}</p>
            <p v-if="row.flow?.notice" class="summary-notice">{{ row.flow.notice }}</p>
            <p v-else-if="!terminal(row)">当前处理人：{{ row.assignees }}</p>
            <details v-if="row.flow?.steps?.length" class="compact-flow"><summary>查看各阶段进度</summary>
              <ol><li v-for="step in row.flow.steps" :key="step.key" :aria-current="step.state === 'current' ? 'step' : undefined"><span>{{ step.label }}</span><span>{{ stepLabels[step.state] }}</span></li></ol>
            </details>
            <div class="summary-actions">
              <div class="task-action">
                <el-button :disabled="!row.target" :aria-describedby="!row.target ? `${headingId}-compact-task-${row.taskId}` : undefined" @click="$router.push(row.target)">查看任务</el-button>
                <small v-if="!row.target" :id="`${headingId}-compact-task-${row.taskId}`" class="task-action-hint">暂无可跳转页面</small>
              </div>
              <div class="task-action">
                <el-button :disabled="!row.effectiveRevisionId && !row.submittedRevisionId" :aria-describedby="`${headingId}-compact-data-${row.taskId}`" @click="$emit('inspect', row)">数据详情</el-button>
                <small :id="`${headingId}-compact-data-${row.taskId}`" class="task-action-hint">{{ dataVersionLabel(row) }}</small>
              </div>
            </div>
          </article>
        </div>
      </template>
      <el-table-column prop="name" label="填报任务" min-width="192"><template #default="{ row }"><strong>{{ row.name }}</strong><small class="task-number">任务 #{{ row.taskId }} · {{ taskKindLabel(row.kind) }}</small></template></el-table-column>
      <el-table-column v-if="!showcase" prop="organization" label="公司" min-width="160" />
      <el-table-column prop="period" label="期间" width="152"><template #default="{ row }">{{ row.period || '期间未记录' }}</template></el-table-column>
      <el-table-column :column-value="row => row.stage" label="流程进度" min-width="460">
        <template #default="{ row }">
          <ol v-if="row.flow.steps.length" class="flow-steps" :aria-label="`${row.name}：${row.flow.notice || row.stage}`">
            <li v-for="(step, i) in row.flow?.steps || []" :key="step.key" :class="step.state" :aria-current="step.state === 'current' ? 'step' : undefined">
              <span class="step-dot" aria-hidden="true">{{ step.state === 'done' ? '✓' : i + 1 }}</span>
              <span class="step-label">{{ step.label }}</span>
              <span class="step-status">{{ stepLabels[step.state] }}</span>
            </li>
          </ol>
          <p v-else class="flow-stage">{{ row.stage }}</p>
          <p v-if="row.flow?.notice" class="flow-notice">{{ row.flow.notice }}</p>
          <p v-else-if="!terminal(row)" class="flow-assignees">当前处理人：{{ row.assignees }}</p>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120" class-name="dashboard-actions-cell"><template #default="{ row }">
        <div class="task-action">
          <el-button link type="primary" :disabled="!row.target" :aria-describedby="!row.target ? `${headingId}-table-task-${row.taskId}` : undefined" @click="$router.push(row.target)">查看任务</el-button>
          <small v-if="!row.target" :id="`${headingId}-table-task-${row.taskId}`" class="task-action-hint">暂无可跳转页面</small>
        </div>
        <div v-if="items" class="task-action">
          <el-button link type="primary" :disabled="!row.effectiveRevisionId && !row.submittedRevisionId" :aria-describedby="`${headingId}-table-data-${row.taskId}`" @click="$emit('inspect', row)">数据详情</el-button>
          <small :id="`${headingId}-table-data-${row.taskId}`" class="task-action-hint">{{ dataVersionLabel(row) }}</small>
        </div>
      </template></el-table-column>
    </app-data-table>
  </section>
</template>

<script setup>
import '@/styles/dashboard-task-layout.css'
import { ref, computed, watch, onMounted, onBeforeUnmount, useId } from 'vue'
import { workflowApi } from '@/api'
import { createDashboardRequest } from './dashboardRequest'
import { normalizeDashboardTasks, taskKindLabel } from './dashboardTaskState'
import { SHOWCASE } from '@/config/showcase'
const showcase = SHOWCASE
const props = defineProps({ items: Array, canManage: Boolean, invalidCount: { type: Number, default: 0 } })
const emit = defineEmits(['inspect', 'retry'])
const headingId = `task-progress-${useId()}`
const request = createDashboardRequest('任务进度')
const { loading, error } = request
const localItems = ref([]), localCanManage = ref(false)
const normalized = computed(() => normalizeDashboardTasks(props.items ?? localItems.value))
const tasks = computed(() => normalized.value.tasks)
const invalidCount = computed(() => normalized.value.invalidCount + (Number.isSafeInteger(props.invalidCount) && props.invalidCount > 0 ? props.invalidCount : 0))
const canManage = computed(() => props.items !== undefined ? props.canManage === true : localCanManage.value)
const search = ref(''), period = ref(''), kind = ref(''), status = ref(''), filterNotice = ref('')
const progressTable = ref(), matchedCount = ref(0), columnFiltersActive = ref(false)
function clearFilters() {
  search.value = ''; period.value = ''; kind.value = ''; status.value = ''; filterNotice.value = ''
  progressTable.value?.clearFilters()
}
const stepLabels = { done: '已完成', current: '当前阶段', pending: '待进行', stopped: '已停止', unknown: '状态未识别' }
const stopped = row => ['cancelled', 'canceled', 'closed'].includes(row.status)
const terminal = row => row.status === 'finalized' || stopped(row)
const dataVersionLabel = row => row.effectiveRevisionId ? '当前生效版本' : row.submittedRevisionId ? '最近提交版本' : '暂无已提交版本'
const periods = computed(() => [...new Set(tasks.value.map(t => t.period).filter(Boolean))].sort().reverse())
watch(periods, values => {
  if (period.value && !values.includes(period.value)) {
    period.value = ''
    filterNotice.value = '所选期间已无可显示任务，已切换为全部期间。'
  }
})
watch(period, value => { if (value) filterNotice.value = '' })
const query = computed(() => search.value.trim().toLowerCase())
const filtered = computed(() => tasks.value.filter(t => (!period.value || t.period === period.value) && (!kind.value || t.kind === kind.value)
  && (!status.value || (status.value === 'active' ? !terminal(t) : status.value === 'stopped' ? stopped(t) : t.status === 'finalized'))
  && (!query.value || `${t.name} ${t.organization} ${t.taskId}`.toLowerCase().includes(query.value))))
const countLabel = computed(() => {
  const count = props.items ? matchedCount.value : filtered.value.length
  return count === tasks.value.length ? `${invalidCount.value ? '可显示' : '共'} ${count} 项任务` : `符合条件 ${count} 项，共 ${tasks.value.length} 项`
})
const emptyText = computed(() => loading.value ? '正在读取任务进度…' : tasks.value.length ? '没有符合条件的任务，可调整条件或清除全部筛选。' : invalidCount.value ? '任务记录暂时无法显示，请重新加载。' : '当前账号暂无可查看的填报任务。')
let disposed = false, mounted = false
async function load() {
  if (props.items !== undefined || loading.value || disposed) return
  await request.run(signal => workflowApi.list(signal), result => {
    if (!Array.isArray(result?.items) || typeof result.canManage !== 'boolean') throw new Error('Invalid workflow response')
    localItems.value = result.items.filter(row => row == null || row.taskId !== undefined || ['monthly', 'quarterly'].includes(row.kind))
    localCanManage.value = result.canManage
  }, failure => {
    if ([401, 403].includes(failure?.status)) { localItems.value = []; localCanManage.value = false }
  })
}
function retry() { if (props.items !== undefined) emit('retry'); else load() }
watch(() => props.items !== undefined, supplied => {
  request.cancel(); error.value = ''; localItems.value = []; localCanManage.value = false
  if (!supplied && mounted) load()
}, { flush: 'sync' })
onMounted(() => { mounted = true; load() })
onBeforeUnmount(() => { disposed = true; request.cancel() })
defineExpose({ load })
</script>

<style scoped>
.task-progress-card{--el-color-primary:#941966;--el-color-primary-dark-2:#941966;--el-color-warning-dark-2:#8a5800;--el-text-color-secondary:#6d5a65}
.progress-feedback,.flow-stage{font-size:14px;line-height:1.6;color:var(--el-text-color-regular);overflow-wrap:anywhere}
.flow-stage{margin:8px 0}
.progress-heading>div,.flow-steps li{min-width:0}
.task-progress-card :is(h2,p,strong,.step-label,.step-status){overflow-wrap:anywhere}
.task-progress-card>.el-alert{margin-block-end:12px}
.task-progress-card>.el-alert--warning{color:var(--el-color-warning-dark-2)}
.task-progress-card>.el-alert--error{color:#b42318}
.task-progress-card{margin-top:16px;padding:16px;background:var(--el-bg-color);border:1px solid var(--el-border-color);border-radius:var(--portal-radius-panel,8px);min-width:0}
.progress-heading{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px}.progress-heading h2{margin:0;font-size:16px;line-height:24px;color:var(--el-text-color-primary)}.progress-heading p{margin:8px 0 0;font-size:14px;line-height:1.6;color:var(--el-text-color-regular)}
.task-count{color:var(--el-text-color-regular)}
.task-number{display:block;font-size:12px;color:var(--el-text-color-secondary);margin-top:4px}.progress-table strong{font-weight:600}.flow-steps{display:flex;list-style:none;padding:0;margin:8px 0;min-width:400px;gap:0}.flow-steps li{position:relative;flex:1;display:flex;align-items:center;flex-direction:column;text-align:center;font-size:12px;line-height:1.5;isolation:isolate}.flow-steps li:not(:last-child)::after{content:'';position:absolute;top:11px;left:calc(50% + 13px);width:calc(100% - 26px);height:2px;background:var(--el-border-color);z-index:-1}.flow-steps li.done::after{background:var(--el-color-success)}
.step-dot{display:grid;place-items:center;width:24px;height:24px;border:1px solid var(--el-border-color);border-radius:50%;background:var(--el-fill-color-light);color:var(--el-text-color-regular);box-sizing:border-box;font-weight:600}.step-label{margin-top:4px;color:var(--el-text-color-regular)}.step-status{font-size:12px;color:var(--el-text-color-secondary)}.done .step-dot{color:var(--el-color-success-dark-2);border-color:var(--el-color-success);background:var(--el-color-success-light-9)}.current .step-dot{background:var(--el-color-primary);border-color:var(--el-color-primary);color:#fff;box-shadow:0 0 0 3px var(--el-color-primary-light-8)}.current .step-label,.current .step-status{font-weight:600;color:var(--el-color-primary-dark-2)}.stopped .step-dot{border-style:dashed}.flow-notice,.flow-assignees{margin:8px 0 4px;font-size:12px;line-height:1.5;color:var(--el-text-color-regular)}.flow-notice{color:var(--el-color-warning-dark-2)}
@media(max-width:700px){.task-progress-card{padding:12px}}
</style>

