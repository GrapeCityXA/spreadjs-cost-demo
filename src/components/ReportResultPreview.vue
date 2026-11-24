<template>
  <section class="result-preview" :aria-busy="loading">
    <div class="preview-header">
      <div class="preview-instructions">
        <p ref="statusHost" class="workbook-preview-status" role="status" tabindex="-1">{{ loading ? '正在读取原表，请稍候…' : ready ? '原表仅供查看，可选择和复制单元格。' : loadError ? '原表暂不可用。' : '' }}</p>
        <p v-if="ready" class="preview-guidance">选择单元格，查看公式和引用关系</p>
      </div>
      <el-button v-if="ready" :aria-expanded="analysisOpen" :aria-controls="analysisId" @click="analysisOpen = !analysisOpen">{{ analysisOpen ? '收起勾稽分析' : '勾稽分析' }}</el-button>
    </div>
    <el-alert v-if="locationError" class="preview-location-error" :title="locationError" type="warning" :closable="false" show-icon />
    <div v-if="loadError" class="preview-failure">
      <el-alert :title="loadError" type="error" :closable="false" show-icon />
      <el-button type="primary" @click="load(true)">重新加载原表</el-button>
    </div>
    <div v-show="!loadError" :class="{ 'preview-pending': !ready }" :inert="!ready" :aria-hidden="!ready">
      <div class="preview-layout" :class="{ 'with-analysis': analysisOpen, 'analysis-expanded': graphExpanded }">
        <div ref="host" class="report-preview" aria-label="报表工作簿" tabindex="-1" />
        <aside v-show="analysisOpen" :id="analysisId" class="dependency-panel" aria-label="勾稽分析">
          <div class="analysis-heading"><h3>勾稽分析</h3><div class="analysis-heading-actions"><el-button class="return-to-workbook" text @click="returnToWorkbook">返回原表</el-button><el-button v-if="!listView" text @click="resetGraph">重置视图</el-button><el-button v-if="!listView" text :aria-pressed="graphExpanded" @click="graphExpanded = !graphExpanded">{{ graphExpanded ? '还原预览' : '放大关系图' }}</el-button></div></div>
          <el-radio-group v-model="direction" size="small" aria-label="追踪方向"><el-radio-button value="precedents">引用来源</el-radio-button><el-radio-button value="dependents">影响去向</el-radio-button><el-radio-button value="both">双向追踪</el-radio-button></el-radio-group>
          <div v-if="current" class="cell-detail" aria-live="polite">
            <div class="cell-identity"><span>当前单元格</span><strong class="cell-address">{{ current.address }}</strong></div>
            <div><span>当前值</span><output>{{ current.displayValue }}</output></div>
            <div><span>公式</span><code>{{ current.formula ? `=${current.formula.replace(/^=/, '')}` : '无公式（已保存的值）' }}</code></div>
            <el-button v-if="current.key !== origin?.key" size="small" @click="traceCurrent">以此单元格继续追踪</el-button>
          </div>
          <div class="graph-heading"><span>分析起点：{{ origin?.address || '未选择' }}</span><el-button type="primary" text size="small" @click="listView = !listView">{{ listView ? '关系图' : '关系清单' }}</el-button></div>
          <div v-show="!listView" ref="chartHost" class="dependency-chart" role="img" :aria-label="graphDescription" />
          <ul v-show="listView" class="dependency-list" role="list" aria-label="单元格引用关系清单">
            <li v-for="node in nodes" :key="node.id">
              <button type="button" :aria-current="node.id === currentRelationId ? 'location' : undefined" @click="locate(node)" :style="{ '--node-depth': node.depth }">
                <span class="relation-heading"><strong>{{ node.address }}</strong><small v-if="node.id === currentRelationId" class="relation-current">当前单元格</small></span>
                <span>{{ node.kind === 'root' ? '分析起点' : `第 ${node.depth} 层 · ${node.kind === 'precedents' ? '引用来源' : '影响去向'}` }} · {{ node.displayValue }}</span>
                <small v-if="node.kind !== 'root'">直接关系：{{ node.relation }}</small>
                <small v-if="node.depth > 1">追踪路径：{{ node.pathText }}</small>
                <small v-if="node.note">{{ node.note }}</small>
              </button>
            </li>
          </ul>
          <p v-if="!listView && nodes.length > 16" class="analysis-hint">关系较多，可缩放查看，或切换关系清单阅读完整路径。</p>
          <p v-if="emptyMessage" class="analysis-hint">{{ emptyMessage }}</p>
          <p v-for="notice in analysis.notices" :key="notice" class="analysis-notice" role="status">{{ notice }}</p>
          <p v-if="chartError" class="analysis-notice" role="status">{{ chartError }}</p>
          <el-alert v-if="error" :title="error" type="error" :closable="false"><el-button @click="retryAnalysis">重试勾稽分析</el-button></el-alert>
          <p class="analysis-hint analysis-footnote">{{ listView ? '点击清单项可定位原单元格。' : '点击图中节点可定位原单元格。' }}仅展示已保存的公式关系；绑定值和定稿快照不能据此反推原始填报位置。</p>
        </aside>
      </div>
    </div>
  </section>
</template>
<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount, useId } from 'vue'
import GC from '@grapecity-software/spread-sheets'
import * as echarts from 'echarts/core'
import { TreeChart } from 'echarts/charts'
import { TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { LabelLayout } from 'echarts/features'
import '@/utils/spreadjsLicense'
import '@grapecity-software/spread-sheets/styles/gc.spread.sheets.excel2013white.css'
import { observeWorkbookLayout } from '@/utils/observeWorkbookLayout'
import { dependencyCell, dependencyRows, reportDependencies } from '@/template/reportDependencies'
import { loadTemplateWorkbook } from '@/template/composedTemplateWorkbook'
import { prepareTemplateFunctions } from '@/template/managedFunctions'
import { hasPreviewSheets, protectWorkbookPreview } from '@/utils/workbookPreview'
echarts.use([TreeChart, TooltipComponent, CanvasRenderer, LabelLayout])
const props = defineProps({ workbook: Object, frozen: Boolean, focusCell: Object, initialAnalysisOpen: { type: Boolean, default: true } })
const analysisId = `workbook-analysis-${useId()}`
const host = ref(), chartHost = ref(), analysisOpen = ref(props.initialAnalysisOpen), graphExpanded = ref(false), listView = ref(false), direction = ref('precedents')
const current = shallowRef(null), origin = shallowRef(null), analysis = shallowRef({ root: null, notices: [], count: 0 }), error = ref('')
const locationError = ref(''), currentRelationId = ref(null)
const loading = ref(true), ready = ref(false), loadError = ref(''), chartError = ref(''), statusHost = ref()
let book, chart, stop, observer, frame, activeLoad, navigating = false, disposed = false
let chartFrame = null, analysisDirty = true, chartDirty = true
const nodes = computed(() => dependencyRows(analysis.value.root))
function returnToWorkbook() {
  graphExpanded.value = false
  nextTick(() => host.value?.scrollIntoView({ block: 'start', behavior: 'auto' }))
  host.value?.focus({ preventScroll: true })
}
const emptyMessage = computed(() => {
  if (error.value || analysis.value.notices.length || !origin.value || nodes.value.length > 1) return ''
  if (direction.value === 'both') return '没有找到此单元格的引用来源或影响去向。'
  if (direction.value === 'dependents') return '没有找到引用此单元格的公式。'
  return origin.value.formula ? '没有可追踪的单元格引用；常量公式或不可解析的引用也可能出现此情况。' : '此单元格没有保留公式，无法通过公式关系追踪上游来源。'
})
const graphDescription = computed(() => origin.value
  ? `单元格公式依赖树。分析起点：${origin.value.address}，当前值：${origin.value.displayValue}。已整理 ${nodes.value.length} 个关系节点（同一单元格可能经不同路径出现）。可切换关系清单查看详情并使用键盘定位。`
  : '单元格公式依赖树。请先选择单元格；可切换关系清单使用键盘定位。')
// Keep resize/view toggles separate from tree replacement so roam and collapsed
// nodes survive. Coalesce observer and Vue updates into one visible-frame paint.
function schedulePaint() {
  if (disposed || chartFrame !== null) return
  chartFrame = requestAnimationFrame(() => { chartFrame = null; paint() })
}
function resetGraph() { chartDirty = true; schedulePaint() }
function paint() {
  if (!ready.value || !analysisOpen.value || listView.value || disposed || !chartHost.value?.clientWidth || !chartHost.value?.clientHeight) return
  try {
    if (!chart) { chart = echarts.init(chartHost.value); chart.on('click', ({ data }) => locate(data)); chartDirty = true }
    chart.resize()
    if (!chartDirty) return
    // notMerge still reuses TreeView. Clear its nodes/edges before replacing the
    // tree, avoiding stale edges and the ECharts tree removal error on switching.
    chart.clear()
    const decorate = node => ({ ...node, symbol: node.note ? 'diamond' : node.children?.length ? 'emptyCircle' : 'circle', symbolSize: node.kind === 'root' ? 13 : 9,
      itemStyle: { color: node.kind === 'root' ? '#4b0b31' : node.kind === 'dependents' ? '#15803d' : '#941966' }, children: node.children?.map(decorate) })
    const compactGraph = chartHost.value.clientWidth < 480
    chart.setOption({ animation: false, aria: { enabled: false },
      tooltip: { trigger: 'item', renderMode: 'richText', confine: true, formatter: ({ data }) => data.group ? data.name : `${data.address}\n值：${data.displayValue}\n${data.formula ? `公式：=${data.formula}` : '无公式'}${data.note ? `\n${data.note}` : ''}` },
      series: [{ type: 'tree', data: analysis.value.root ? [decorate(analysis.value.root)] : [], top: 28, bottom: 28, left: compactGraph ? 64 : 80, right: compactGraph ? 64 : 125,
        orient: 'LR', roam: true, expandAndCollapse: true, initialTreeDepth: 2,
        label: { position: 'top', verticalAlign: 'bottom', align: 'center', fontSize: 14, lineHeight: 20, width: compactGraph ? 100 : 140, overflow: 'truncate', formatter: ({ data }) => data.group ? data.name : `${data.sheetName}!${data.address.split('!').at(-1)}\n${data.displayValue}` },
        labelLayout: { hideOverlap: true },
        lineStyle: { color: '#94a3b8', width: 1.4 }, emphasis: { focus: 'ancestor' } }],
    }, true)
    chartDirty = false
    chartError.value = ''
  } catch {
    chart?.dispose(); chart = null
    listView.value = true
    chartError.value = '关系图暂时无法显示，可使用关系清单查看并定位单元格。'
  }
}
function rebuild() {
  analysisDirty = true
  if (!ready.value || !book || !origin.value || !analysisOpen.value) return
  try { analysis.value = reportDependencies(book, origin.value, direction.value); error.value = '' }
  catch { error.value = '暂时无法读取此单元格的公式关系，请重试或选择其他单元格。'; analysis.value = { root: null, notices: [], count: 0 } }
  analysisDirty = false; chartDirty = true
  nextTick(schedulePaint)
}
function traceCurrent() {
  if (!current.value) return
  origin.value = current.value; currentRelationId.value = '0'; rebuild()
}
function retryAnalysis() { if (origin.value) rebuild(); else selectionChanged() }
function selectionChanged() {
  if (navigating || disposed || !ready.value) return
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    if (!book || disposed) return
    try {
      const sheet = book.getActiveSheet()
      const cell = sheet && dependencyCell(book, sheet.name(), sheet.getActiveRowIndex(), sheet.getActiveColumnIndex())
      if (!cell) throw new Error('Unavailable selection')
      current.value = cell; locationError.value = ''
      traceCurrent()
    } catch {
      current.value = null; origin.value = null; currentRelationId.value = null
      analysis.value = { root: null, notices: [], count: 0 }
      error.value = '无法读取当前单元格，请重试勾稽分析或在原表中重新选择。'
      analysisDirty = false; chartDirty = true
      nextTick(schedulePaint)
    }
  })
}
function locate(node) {
  if (!ready.value || !node || node.group || !book) return false
  try {
    const cell = dependencyCell(book, node.sheetName, node.row, node.col)
    if (!cell) {
      locationError.value = '目标单元格不存在或超出原表范围，请在原表中重新选择。'
      return false
    }
    const sheet = book.getSheetFromName(cell.sheetName)
    cancelAnimationFrame(frame); navigating = true
    book.setActiveSheet(cell.sheetName); sheet.setActiveCell(cell.row, cell.col)
    sheet.showCell(cell.row, cell.col, GC.Spread.Sheets.VerticalPosition.center, GC.Spread.Sheets.HorizontalPosition.center)
    current.value = cell; currentRelationId.value = node.id ?? null; locationError.value = ''
    return true
  } catch {
    locationError.value = '暂时无法定位该单元格，请重试或在原表中重新选择。'
    return false
  } finally { navigating = false }
}
watch(direction, () => { currentRelationId.value = current.value?.key === origin.value?.key ? '0' : null; rebuild() })
function focusSource() {
  if (props.focusCell && locate(props.focusCell)) traceCurrent()
}
watch(() => props.focusCell, focusSource)
watch(graphExpanded, () => nextTick(schedulePaint))
watch(analysisOpen, open => {
  if (!open) graphExpanded.value = false
  if (open && analysisDirty) rebuild()
  // Workbook sizing is already handled by observeWorkbookLayout.
  nextTick(schedulePaint)
})
watch(listView, () => nextTick(schedulePaint))
function releasePreview() {
  ready.value = false
  cancelAnimationFrame(frame)
  cancelAnimationFrame(chartFrame); chartFrame = null
  analysisDirty = true; chartDirty = true
  stop?.(); stop = null
  observer?.disconnect(); observer = null
  chart?.dispose(); chart = null
  if (activeLoad) {
    clearTimeout(activeLoad.timer)
    activeLoad.retired = true
    activeLoad.element.remove()
    // Loading cannot be cancelled; wait for it to settle before destroying its instance.
    if (!activeLoad.pending) activeLoad.book?.destroy()
    activeLoad = null
  }
  book = null
}
async function load(focusStatus = false) {
  if (disposed || (focusStatus && loading.value)) return
  releasePreview()
  loading.value = true; loadError.value = ''; error.value = ''; chartError.value = ''; locationError.value = ''; currentRelationId.value = null
  current.value = null; origin.value = null; analysis.value = { root: null, notices: [], count: 0 }
  const run = { pending: true, retired: false, element: document.createElement('div'), book: null }
  activeLoad = run
  const isCurrent = () => !disposed && activeLoad === run && !run.retired
  run.element.style.height = '100%'
  run.timer = setTimeout(() => {
    if (!isCurrent()) return
    releasePreview(); loading.value = false
    loadError.value = '读取原表用时过长，请检查连接后重新加载。'
  }, 45000)
  try {
    await nextTick()
    if (!isCurrent()) return
    if (focusStatus) statusHost.value?.focus()
    if (!hasPreviewSheets(props.workbook)) {
      loadError.value = '该版本没有可预览的工作表，请关闭详情并重新选择版本。'
      return
    }
    // Snapshot support must register its workbook initialization hooks before
    // constructing the preview, including when opening this route directly.
    const snapshotLoader = props.workbook.collaborationInfo || props.workbook.activeSheetId
      ? await import('@/template/restoreRevisionWorkbook') : null
    if (!isCurrent()) return
    host.value.append(run.element)
    const instance = run.book = new GC.Spread.Sheets.Workbook(run.element)
    if (props.workbook?.schemaVersion === 1 && Array.isArray(props.workbook.sheets)) {
      await loadTemplateWorkbook(instance, props.workbook, { remoteData: false })
    } else {
      await prepareTemplateFunctions(props.workbook)
      if (!isCurrent()) return
      if (props.workbook.collaborationInfo || props.workbook.activeSheetId) {
        if (props.frozen) instance.suspendCalcService()
        try { await snapshotLoader.restoreRevisionWorkbook(instance, props.workbook) }
        finally { if (props.frozen) instance.resumeCalcService(false) }
      } else {
        await instance.fromJSON(props.workbook, { doNotRecalculateAfterLoad: props.frozen || props.workbook?.reportSourceFormulas?.frozen })
      }
    }
    if (!isCurrent()) return
    protectWorkbookPreview(instance)
    book = instance; ready.value = true; loading.value = false
    await nextTick()
    if (!isCurrent()) return
    stop = observeWorkbookLayout(host.value, book)
    observer = new ResizeObserver(schedulePaint); observer.observe(chartHost.value)
    book.bind(GC.Spread.Sheets.Events.SelectionChanged, selectionChanged)
    book.bind(GC.Spread.Sheets.Events.ActiveSheetChanged, selectionChanged)
    if (props.focusCell) focusSource()
    else selectionChanged()
  } catch {
    if (isCurrent()) loadError.value = '原表未能完整加载，请重试。若仍失败，请关闭详情后重新打开。'
  } finally {
    clearTimeout(run.timer)
    run.pending = false
    if (isCurrent()) {
      loading.value = false
      if (loadError.value) releasePreview()
    } else { run.book?.destroy(); run.element.remove() }
  }
}
watch(() => props.workbook, () => { if (host.value) load() })
onMounted(() => {
  // Choose the initial view once; later resizes retain the user's selection.
  listView.value = host.value?.closest('.result-preview')?.clientWidth < 1050
  return load()
})
onBeforeUnmount(() => { disposed = true; releasePreview() })
</script>
<style scoped>
.result-preview {
  container: workbook-preview / inline-size;
  min-width: 0;
  --preview-control-height: 44px;
  --preview-body-size: 16px;
  --preview-note-size: 14px;
  --preview-action-size: 16px;
  --el-color-primary: var(--portal-focus, #941966);
  --el-text-color-primary: var(--portal-ink, #2c1b26);
  --el-text-color-secondary: var(--portal-muted, #6d5a65);
  color: var(--el-text-color-primary);
}
.preview-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; margin-block: 4px 16px; }
.preview-instructions { flex: 1 1 260px; min-width: 0; }
.workbook-preview-status { margin: 0; color: var(--el-text-color-regular); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.preview-guidance { margin: 4px 0 0; color: var(--el-text-color-secondary); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.workbook-preview-status:empty { display: none; }
.workbook-preview-status:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.preview-location-error { --el-alert-title-font-size: 14px; --el-color-warning: var(--portal-ink, #2c1b26); margin-bottom: 12px; overflow-wrap: anywhere; }
.preview-failure { display: grid; justify-items: start; gap: 12px; padding-block: 12px; }
.preview-failure .el-alert { width: 100%; overflow-wrap: anywhere; }
.preview-pending { visibility: hidden; pointer-events: none; }
.analysis-heading, .graph-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.graph-heading > span { flex: 1 1 180px; min-width: 0; overflow-wrap: anywhere; }
.preview-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; }
.preview-layout.with-analysis.analysis-expanded { grid-template-columns: minmax(0, 1fr); }
.preview-layout.analysis-expanded .report-preview { display: none; }
.preview-layout.analysis-expanded .dependency-panel { width: 100%; }
.report-preview:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.analysis-heading-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.report-preview { scroll-margin-block: 16px; box-sizing: border-box; min-width: 0; height: clamp(280px, 42dvh, 440px); overflow: hidden; border: 1px solid var(--el-border-color); border-radius: 6px; }
.dependency-panel { box-sizing: border-box; min-width: 0; display: flex; flex-direction: column; gap: 16px; border: 1px solid var(--el-border-color); border-radius: 6px; padding: 16px; background: var(--el-bg-color); scrollbar-color: var(--el-border-color-darker) var(--el-fill-color-light); }
.analysis-heading h3 { font-size: 16px; font-weight: 600; line-height: 1.5; margin: 0; }
.cell-detail { background: var(--el-fill-color-light); border-radius: 4px; padding: 12px; display: grid; gap: 8px; font-size: var(--preview-body-size); line-height: 1.6; }
.cell-address { font-family: inherit; font-weight: 600; overflow-wrap: anywhere; }
.cell-detail output { font-variant-numeric: tabular-nums; }
.cell-detail > div { display: grid; grid-template-columns: 3em minmax(0, 1fr); gap: 8px; }
.cell-detail output, .cell-detail code { min-width: 0; overflow-wrap: anywhere; }
.cell-detail span { color: var(--el-text-color-secondary); }
.cell-detail > .cell-identity { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; padding-bottom: 8px; border-bottom: 1px solid var(--el-border-color-lighter); }
.cell-identity > span { flex-shrink: 0; font-size: var(--preview-note-size); }
.cell-identity > strong { min-width: 0; }
.graph-heading { font-size: var(--preview-note-size); line-height: 1.6; color: var(--el-text-color-secondary); }
.dependency-chart { flex: 1 1 auto; min-height: 280px; width: 100%; min-width: 0; }
.dependency-list { margin: 0; padding: 0; list-style: none; min-width: 0; max-height: none; overflow: visible; scrollbar-color: var(--el-border-color-darker) var(--el-fill-color-light); }
.dependency-list > li { min-width: 0; }
.dependency-list > li:last-child button { border-bottom: 0; }
.dependency-panel > *:not(.dependency-chart) { flex-shrink: 0; }
.dependency-list button { box-sizing: border-box; display: grid; gap: 4px; width: 100%; min-height: 44px; text-align: start; border: 0; border-bottom: 1px solid var(--el-border-color-lighter); background: transparent; padding: 12px; padding-inline-start: calc(12px + min(var(--node-depth, 0), 3) * 8px); cursor: pointer; color: var(--el-text-color-primary); overflow-wrap: anywhere; font: inherit; font-size: var(--preview-body-size); line-height: 1.6; scroll-margin-block: 12px; }
.dependency-list button:hover { background: var(--el-fill-color-light); }
.dependency-list button[aria-current="location"] { background: var(--portal-accent-surface, #f8ebf3); }
.dependency-list button[aria-current="location"] strong { color: var(--el-color-primary); }
.dependency-list strong { font-family: inherit; font-weight: 600; color: var(--el-text-color-primary); }
.dependency-list .relation-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; font-size: inherit; }
.relation-heading strong { min-width: 0; }
.dependency-list .relation-current { flex-shrink: 0; color: var(--el-color-primary); font-weight: 600; }
.dependency-list button:active { background: var(--portal-accent-surface, #f8ebf3); }
.dependency-list button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
.dependency-list span, .dependency-list small { font-size: var(--preview-note-size); color: var(--el-text-color-secondary); }
.analysis-hint, .analysis-notice { font-size: var(--preview-note-size); line-height: 1.6; margin: 0; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.analysis-notice { color: var(--el-color-warning-dark-2); }
.analysis-footnote { border-top: 1px solid var(--el-border-color-lighter); padding-top: 12px; }

.result-preview ::selection { background: var(--portal-accent-surface, #f8ebf3); color: var(--portal-ink, #2c1b26); }
.result-preview :deep(.el-button) { min-width: 44px; min-height: var(--preview-control-height); height: auto; padding-block: 8px; white-space: normal; font-size: var(--preview-action-size); line-height: 1.5; }
.result-preview :deep(.el-button + .el-button) { margin-inline-start: 0; }
.result-preview :deep(.el-button > span) { min-width: 0; overflow-wrap: anywhere; }
.result-preview :deep(.el-radio-group) { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; width: 100%; }
.result-preview :deep(.el-radio-button) { min-width: 0; }
.result-preview :deep(.el-radio-button__inner) { box-sizing: border-box; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; min-height: var(--preview-control-height); padding: 8px 4px; border: 1px solid var(--el-border-color); border-radius: 4px; white-space: normal; overflow-wrap: anywhere; font-size: var(--preview-action-size); line-height: 1.5; }
.result-preview :deep(.el-radio-button.is-active .el-radio-button__inner) { border-color: var(--el-color-primary); box-shadow: none; }
.result-preview :deep(.el-button:focus-visible), .result-preview :deep(.el-radio-button__original-radio:focus-visible + .el-radio-button__inner) { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
@container workbook-preview (max-width: 479px) {
  .dependency-panel { padding: 12px; }
  .cell-detail > div { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .dependency-list button { padding-inline: 8px; }
  .graph-heading > span { flex-basis: 100%; }
}
@container workbook-preview (min-width: 1050px) {
  .preview-layout { height: clamp(480px, 70dvh, 820px); }
  .preview-layout.with-analysis { grid-template-columns: minmax(0, 1fr) minmax(400px, 40%); }
  .report-preview { height: 100%; }
  .dependency-panel { min-height: 0; overflow: auto; scrollbar-gutter: stable; }
  .return-to-workbook { display: none; }
}
@media (min-width: 1100px) and (hover: hover) and (pointer: fine) {
  .result-preview { --preview-control-height: 32px; --preview-action-size: 14px; --preview-body-size: 14px; }
}
@media (any-pointer: coarse) {
  .result-preview { --preview-control-height: 44px; --preview-action-size: 16px; --preview-body-size: 16px; }
}
@container workbook-preview (max-width: 1049px) {
  .preview-header, .preview-layout, .preview-failure { --preview-control-height: 44px; --preview-action-size: 16px; --preview-body-size: 16px; }
}
@media (max-height: 500px) {
  .report-preview { height: max(240px, 65dvh); }
}
</style>
