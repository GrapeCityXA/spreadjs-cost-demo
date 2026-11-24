<template>
  <section class="metric-panel" aria-labelledby="business-metric-title">
    <div class="metric-heading"><div><h2 id="business-metric-title">定稿业务指标</h2><p>{{ showcase ? '按所选报告类型和期间汇总当前有效的定稿数据，空值不计入。' : '按所选报告类型、期间和公司汇总当前有效的定稿数据，空值不计入。' }}</p></div><span>{{ result.unit || '按字段单位' }}</span></div>
    <div class="metric-controls">
      <label>报告类型<el-select popper-class="dashboard-select-options" v-model="config.reportTypeId" aria-label="指标报告类型" :placeholder="types.length ? '选择报告类型' : '暂无可用报告类型'"><el-option v-for="t in types" :key="t.id" :value="t.id" :label="t.name" /></el-select></label>
      <label>业务字段<el-select popper-class="dashboard-select-options" v-model="config.fieldId" filterable aria-label="业务指标字段" :disabled="!availableFields.length" placeholder="暂无定稿业务字段"><el-option v-for="f in availableFields" :key="f.id" :value="f.id" :label="f.name" /></el-select></label>
      <label>汇总方式<el-select popper-class="dashboard-select-options" v-model="config.operation" aria-label="指标汇总方式"><el-option value="sum" label="合计" :disabled="!numeric" /><el-option value="average" label="平均值" :disabled="!numeric" /><el-option value="latest" label="最新记录" /></el-select></label>
      <label v-if="!showcase">分组<el-select popper-class="dashboard-select-options" v-model="config.group" aria-label="指标分组"><el-option value="organization" label="按公司" /><el-option value="period" label="按期间" /></el-select></label>
      <label>期间<el-select popper-class="dashboard-select-options" v-model="config.period" clearable aria-label="指标期间" placeholder="全部期间"><el-option v-for="p in periods" :key="p" :value="p" :label="p" /></el-select></label>
      <label v-if="!showcase">公司<el-select popper-class="dashboard-select-options" v-model="config.organizationId" clearable aria-label="指标公司" placeholder="全部公司"><el-option v-for="o in organizations" :key="o.id" :value="o.id" :label="o.name" /></el-select></label>
    </div>
    <el-alert v-if="storageError" :title="storageError" type="warning" :closable="false" />
    <el-alert v-if="chartError" :title="chartError" type="warning" :closable="false" />
    <el-empty v-if="result.message" :description="result.message" :image-size="50"><el-button v-if="types.length && values.length" @click="Object.assign(config, reconcileMetricConfig({}, props))">重置指标筛选</el-button></el-empty>
    <div v-else class="metric-results" :class="{ 'has-chart': numeric && !chartError }">
      <p class="metric-caption">{{ field?.name }} · {{ operationLabels[config.operation] }} · {{ result.sources.length }} 条定稿记录<span>统计范围：{{ config.period || '全部期间' }}<template v-if="!showcase"> · {{ organizations.find(o => o.id === config.organizationId)?.name || '全部公司' }}</template></span><span v-if="config.operation === 'average'">按定稿记录计算平均值，空值不计入。</span><span v-if="config.operation === 'latest'">每组取最新期间、最近定稿的一条记录。</span></p>
      <div v-show="numeric && !chartError" ref="chartHost" class="metric-chart" role="img" :aria-label="`${field?.name || ''}定稿数据图表`" />
      <app-data-table accessible responsive table-label="定稿指标与来源" :data="result.rows" row-key="key" max-height="300">
        <template #compact="{ rows }"><div class="dashboard-compact-list" aria-label="定稿指标摘要">
          <p v-if="!rows.length" class="compact-empty">没有匹配的指标记录</p>
          <article v-for="row in rows" :key="row.key" class="dashboard-summary-row">
            <h3>{{ row.label }}</h3><p class="summary-value">{{ display(row.value) }} {{ result.unit }}</p><p class="summary-context">{{ row.count }} 条记录</p>
            <div class="summary-actions"><el-button @click="sources = row.sources">查看来源</el-button></div>
          </article>
        </div></template>
        <el-table-column prop="label" :label="config.group === 'period' ? '期间' : '公司'" />
        <el-table-column :column-value="r => r.value" label="指标值" :align="numeric ? 'right' : 'left'" :class-name="numeric ? 'dashboard-numeric-cell' : ''"><template #default="{ row }">{{ display(row.value) }} {{ result.unit }}</template></el-table-column>
        <el-table-column prop="count" label="记录数" align="right" class-name="dashboard-numeric-cell" />
        <el-table-column label="来源" class-name="dashboard-actions-cell"><template #default="{ row }"><el-button link type="primary" @click="sources = row.sources">查看来源</el-button></template></el-table-column>
      </app-data-table>
    </div>
    <el-dialog class="dashboard-dialog" :model-value="Boolean(sources)" title="指标数据来源" width="85%" @close="sources = null" destroy-on-close>
      <p class="dashboard-table-hint">左右滑动表格可查看全部列和操作。</p>
      <app-data-table accessible table-label="定稿指标与来源" :data="sources || []" max-height="440"><el-table-column v-if="!showcase" prop="organizationName" label="公司" /><el-table-column prop="period" label="期间" /><el-table-column prop="revisionNumber" label="定稿版本" align="right" class-name="dashboard-numeric-cell" /><el-table-column :column-value="r => r.value" label="采集值" :align="numeric ? 'right' : 'left'" :class-name="numeric ? 'dashboard-numeric-cell' : ''"><template #default="{ row }">{{ display(row.value) }}</template></el-table-column><el-table-column label="操作" class-name="dashboard-actions-cell"><template #default="{ row }"><el-button link type="primary" @click="$emit('inspect', row); sources = null">查看数据详情</el-button></template></el-table-column></app-data-table>
    </el-dialog>
  </section>
</template>
<script setup>
import { ref, reactive, computed, watch, onBeforeUnmount } from 'vue'
import { aggregateMetric } from './dashboardMetrics'
import { sanitizeMetricConfig, reconcileMetricConfig } from './dashboardState'
import { SHOWCASE } from '@/config/showcase'
const props = defineProps({ fields: Array, types: Array, values: Array })
defineEmits(['inspect'])
const chartHost = ref(), sources = ref(null), storageError = ref(''), chartError = ref('')
const chartVisible = ref(false)
let saved = {}, key = 'dashboard-metric', chart, observer, visibilityObserver, resizeFrame, drawVersion = 0, disposed = false
try { key += `:${JSON.parse(localStorage.getItem('userInfo') || '{}').id || 'local'}`; saved = JSON.parse(localStorage.getItem(key) || '{}') || {} } catch { storageError.value = '无法读取个人指标偏好，当前使用默认配置。' }
const config = reactive(sanitizeMetricConfig(saved))
const showcase = SHOWCASE
if (showcase) { config.group = 'period'; config.organizationId = null }
const field = computed(() => props.fields.find(f => f.id === config.fieldId)), numeric = computed(() => ['decimal','integer','number'].includes(field.value?.type))
const availableFields = computed(() => {
  const ids = new Set(props.values.filter(v => v.reportTypeId === config.reportTypeId).map(v => v.fieldId))
  return props.fields.filter(f => ids.has(f.id))
})
const scopedValues = computed(() => props.values.filter(v => v.reportTypeId === config.reportTypeId && v.fieldId === config.fieldId))
const periods = computed(() => [...new Set(scopedValues.value.map(v => v.period))].sort().reverse())
const organizations = computed(() => [...new Map(scopedValues.value.map(v => [v.organizationId, { id: v.organizationId, name: v.organizationName }])).values()])
const result = computed(() => aggregateMetric(props.values, config))
const operationLabels = { sum: '合计', average: '平均值', latest: '最新记录' }
const display = v => v == null ? '—' : typeof v === 'boolean' ? (v ? '是' : '否') : typeof v === 'number' ? v.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : String(v)
watch(() => [props.fields, props.types, props.values, config.reportTypeId, config.fieldId], () => {
  Object.assign(config, reconcileMetricConfig(config, props))
}, { immediate: true })
watch(config, () => { try { localStorage.setItem(key, JSON.stringify(config)) } catch { storageError.value = '个人指标偏好无法保存，刷新后可能需要重新选择。' } })
function disposeChart() {
  cancelAnimationFrame(resizeFrame)
  observer?.disconnect(); observer = null
  chart?.dispose(); chart = null
}
watch(chartHost, host => {
  visibilityObserver?.disconnect(); disposeChart()
  chartVisible.value = false
  if (!host) return
  if (typeof IntersectionObserver === 'undefined') { chartVisible.value = true; return }
  visibilityObserver = new IntersectionObserver(entries => {
    chartVisible.value = entries.some(entry => entry.isIntersecting)
  }, { rootMargin: '200px' })
  visibilityObserver.observe(host)
}, { flush: 'post' })
watch([result, chartHost, numeric, chartVisible], async () => {
  const version = ++drawVersion
  if (disposed) return
  if (!chartHost.value || !numeric.value || !result.value.rows.length) { disposeChart(); return }
  if (!chartVisible.value) return
  chartError.value = ''
  try {
    const { createMetricChart } = await import('./dashboardChart')
    if (disposed || version !== drawVersion) return
    if (!chart) {
      chart = createMetricChart(chartHost.value)
      observer = new ResizeObserver(entries => {
        const { width, height } = entries[0].contentRect
        cancelAnimationFrame(resizeFrame)
        resizeFrame = requestAnimationFrame(() => chart?.resize(width, height))
      })
      observer.observe(chartHost.value)
    }
    chart.update(result.value.rows)
  } catch {
    if (disposed || version !== drawVersion) return
    disposeChart()
    chartError.value = '图表暂时无法显示，仍可在下方表格查看指标和来源。'
  }
}, { flush: 'post' })
onBeforeUnmount(() => { disposed = true; drawVersion++; visibilityObserver?.disconnect(); disposeChart() })
</script>
<style scoped>
.metric-panel{padding:20px;border:1px solid var(--el-border-color);border-radius:9px;background:var(--el-bg-color)}.metric-heading{display:flex;justify-content:space-between;align-items:center}.metric-heading h2{margin:0;font-size:17px}.metric-heading p,.metric-heading>span,.metric-caption{font-size:13px;color:var(--el-text-color-regular);line-height:1.6}.metric-controls{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.metric-controls label{display:grid;gap:7px;font-size:13px}.metric-controls .el-select{width:100%}.metric-chart{height:290px;min-width:0}.metric-caption span{display:block}@media(max-width:800px){.metric-controls{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
