<template>
  <div ref="studioHost" class="report-studio" :class="{ 'monthly-report-studio': monthlyMode, 'studio-editor-open': edit }" :inert="generating" :aria-busy="generating">
    <ReportSheetDesigner v-if="edit" :key="`${edit}:${readOnly}`" :template-id="edit" :admin="state.capabilities.approve" :read-only="readOnly" @close="closeEditor" @saved="saved" />
    <template v-else>
      <header class="studio-header"><div><h1>{{ monthlyMode ? '月度参考报表' : '报表工作室' }}</h1></div><div class="actions"><template v-if="monthlyMode"><el-button v-if="!showcase" @click="router.push('/portal/monthly-reference-report?view=standard')">标准汇总</el-button><el-button @click="router.push('/portal/report-studio?section=templates')">报表模板</el-button></template><el-button :loading="loading" @click="load()">刷新</el-button><el-button v-if="showcase && state.capabilities.manage" type="primary" :disabled="loading || !published.length" @click="openForm('generate')">生成报表</el-button><el-button v-if="!showcase && state.capabilities.design && tab === 'templates'" type="primary" @click="openEditor('new')">新建报表模板</el-button><el-button v-if="!showcase && state.capabilities.manage && tab === 'schedules'" type="primary" :disabled="loading || !published.length" @click="openForm('schedule')">新建生成计划</el-button><el-button v-if="!showcase && state.capabilities.manage && tab === 'results'" type="primary" :disabled="loading || !published.length" @click="openForm('generate')">生成报表</el-button></div></header>

      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-alert v-if="!loading && !error && state.capabilities.manage && !published.length" title="暂无已发布的报表模板，请先在报表工作室发布模板，再生成报表。" type="info" :closable="false" show-icon />
      <nav class="studio-tabs" aria-label="报表工作室栏目"><el-button v-for="(label,key) in tabs" :key="key" :type="tab === key ? 'primary' : ''" :plain="tab !== key" :aria-pressed="tab === key" @click="changeTab(key)">{{ label }} <span class="tab-count">{{ count(key) }}</span></el-button><el-tooltip :content="showcase ? '设计报表布局 → 发布模板 → 选择模板和期间生成报表。模板不保存业务数据，生成成果固定版本和来源。' : '设计报表布局 → 发布模板 → 选择定稿数据 → 手动或按月生成。模板不保存业务数据，生成成果固定版本和来源。'"><el-button circle aria-label="报表工作室帮助"><el-icon><InfoFilled /></el-icon></el-button></el-tooltip></nav>
      <div v-if="showcase && tab === 'templates'" class="studio-tab-actions"><el-button v-if="state.capabilities.design" @click="openEditor('new')">新建报表模板</el-button></div>

      <AppDataTable v-if="tab === 'templates'" :data="state.templates" v-loading="loading" row-key="id" accessible responsive table-label="报表模板" class="studio-table studio-table-templates">
        <el-table-column prop="name" class-name="studio-title-cell" label="报表模板" min-width="220" /><el-table-column prop="version" label="版本" :width="monthlyMode ? 128 : 95"><template #default="{row}">V{{ row.version }}</template></el-table-column><el-table-column prop="status" label="状态" :width="monthlyMode ? 128 : 120"><template #default="{row}"><el-tag :type="tagType(row.status)">{{ labels[row.status] || '状态未知' }}</el-tag></template></el-table-column><el-table-column prop="created_at" class-name="studio-date-cell" label="创建时间" min-width="160"><template #default="{row}">{{ formatTime(row.created_at) }}</template></el-table-column>
        <el-table-column label="操作" :min-width="200"><template #default="{row}"><ReportStudioActions :section="tab" :row="row" :capabilities="state.capabilities" :busy="busy" :workflow-from="route.query.workflowFrom" @action="recordAction" /></template></el-table-column>
      <template #compact="{ rows, expanded }"><ReportStudioSummary v-if="compactSummary && !expanded" :section="tab" title="报表模板" :rows="rows" :capabilities="state.capabilities" :busy="busy" :workflow-from="route.query.workflowFrom" :labels="labels" :tag-type="tagType" :template-label="templateLabel" :format-time="formatTime" @action="recordAction" /></template></AppDataTable>
      <AppDataTable v-if="tab === 'schedules'" :data="state.schedules" v-loading="loading" row-key="id" accessible responsive table-label="生成计划" class="studio-table studio-table-schedules">
        <el-table-column prop="name" class-name="studio-title-cell" label="计划名称" min-width="200" /><el-table-column label="模板版本" :column-value="row => templateLabel(row.template_id)" min-width="160"><template #default="{row}">{{ templateLabel(row.template_id) }}</template></el-table-column><el-table-column label="生成时间（北京时间）" :column-value="row => `${row.day} 日 ${row.time}`" min-width="185"><template #default="{row}">每月 {{ row.day }} 日 {{ row.time }}</template></el-table-column><el-table-column label="报告期间" :column-value="row => row.month_offset" :width="monthlyMode ? 128 : 120"><template #default="{row}">{{ row.month_offset === -1 ? '上月' : '当月' }}</template></el-table-column><el-table-column prop="next_run" label="下次运行" min-width="180"><template #default="{row}">{{ formatTime(row.next_run) }}</template></el-table-column><el-table-column label="状态" :column-value="row => row.enabled" :width="monthlyMode ? 128 : 100"><template #default="{row}">{{ row.enabled ? '运行中' : '已暂停' }}</template></el-table-column><el-table-column label="操作" :min-width="110"><template #default="{row}"><ReportStudioActions :section="tab" :row="row" :capabilities="state.capabilities" :busy="busy" :workflow-from="route.query.workflowFrom" @action="recordAction" /></template></el-table-column>
      <template #compact="{ rows, expanded }"><ReportStudioSummary v-if="compactSummary && !expanded" :section="tab" title="生成计划" :rows="rows" :capabilities="state.capabilities" :busy="busy" :workflow-from="route.query.workflowFrom" :labels="labels" :tag-type="tagType" :template-label="templateLabel" :format-time="formatTime" @action="recordAction" /></template></AppDataTable>
      <AppDataTable v-if="tab === 'results'" :data="state.jobs" v-loading="loading" row-key="id" accessible responsive table-label="生成记录" :empty-text="showcase ? '还没有生成记录。点击右上角「生成报表」生成第一份报表；如无可用模板，请先到「报表模板」创建并发布。' : '暂无生成记录'" class="studio-table studio-table-results">
        <el-table-column prop="name" class-name="studio-title-cell" label="报表名称" min-width="180" /><el-table-column prop="query.periodCode" label="报告期间" :width="monthlyMode ? 128 : 125" /><el-table-column prop="version" label="模板版本" :width="monthlyMode ? 128 : 105"><template #default="{row}">V{{ row.version }}</template></el-table-column><el-table-column prop="status" label="状态" :width="monthlyMode ? 128 : 125"><template #default="{row}"><el-tag :type="tagType(row.status)">{{ labels[row.status] || '状态未知' }}</el-tag></template></el-table-column><el-table-column prop="created_at" class-name="studio-date-cell" label="生成时间" min-width="170"><template #default="{row}">{{ formatTime(row.created_at) }}</template></el-table-column><el-table-column prop="error_text" label="提示" min-width="160" show-overflow-tooltip /><el-table-column label="操作" :min-width="180"><template #default="{row}"><ReportStudioActions :section="tab" :row="row" :capabilities="state.capabilities" :busy="busy" :workflow-from="route.query.workflowFrom" @action="recordAction" /></template></el-table-column>
      <template #compact="{ rows, expanded }"><ReportStudioSummary v-if="compactSummary && !expanded" :section="tab" title="生成记录" :rows="rows" :capabilities="state.capabilities" :busy="busy" :workflow-from="route.query.workflowFrom" :labels="labels" :tag-type="tagType" :template-label="templateLabel" :format-time="formatTime" @action="recordAction" /></template></AppDataTable>
      <el-dialog class="studio-form-dialog" :class="{ 'monthly-reference-dialog': monthlyMode }" v-model="formOpen" :title="formMode === 'schedule' ? '新建生成计划' : '生成报表'" width="min(620px, calc(100vw - 32px))" :close-on-click-modal="!saving && !generating" :close-on-press-escape="!saving && !generating" :show-close="!saving && !generating" destroy-on-close>
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" show-icon /><el-form ref="generationForm" :disabled="saving" label-position="top" class="generation-form" @submit.prevent="submitForm"><el-form-item label="报表模板（固定已发布版本）" :error="formErrors.templateId"><el-select v-model="form.templateId" placeholder="请选择报表模板"><el-option v-for="t in published" :key="t.id" :label="`${t.name} · V${t.version}`" :value="t.id" /></el-select></el-form-item><el-form-item label="填报类型" :error="formErrors.reportTypeId"><el-select v-model="form.reportTypeId" :disabled="!!selectedSourceType" placeholder="请选择数据来源"><el-option v-for="t in state.reportTypes.filter(t=>t.cadence==='monthly')" :key="t.id" :label="t.name" :value="t.id" /></el-select></el-form-item><el-form-item v-if="!showcase" label="组织范围" :error="formErrors.organizationIds"><el-select v-model="form.organizationIds" multiple collapse-tags placeholder="请选择组织"><el-option v-for="o in state.organizations" :key="o.id" :label="o.name" :value="o.id" /></el-select></el-form-item>
          <el-form-item v-if="formMode==='generate'" label="报告期间" :error="formErrors.periodCode"><el-date-picker v-model="form.periodCode" type="month" value-format="YYYY-MM" placeholder="选择月份" /></el-form-item>
          <template v-else><el-form-item label="计划名称" :error="formErrors.name"><el-input v-model="form.name" maxlength="120" show-word-limit placeholder="留空则使用模板名称" /></el-form-item><div class="schedule-fields"><el-form-item label="每月几号" :error="formErrors.day"><el-input-number v-model="form.day" :min="1" :max="28" /></el-form-item><el-form-item label="北京时间" :error="formErrors.time"><el-time-select v-model="form.time" start="00:00" end="23:30" step="00:30" /></el-form-item><el-form-item label="生成哪个月" :error="formErrors.monthOffset"><el-select v-model="form.monthOffset"><el-option label="上月" :value="-1"/><el-option label="当月" :value="0"/></el-select></el-form-item></div></template>
        </el-form><el-alert :title="showcase ? '生成前检查填报任务是否全部定稿；未完成时记录失败原因，不生成缺项成果。Excel 同时包含具体填报表，PDF 保留设计的报表版式。' : '生成前检查所选组织的填报任务是否全部定稿；未完成时记录失败原因，不生成缺项成果。Excel 同时包含具体填报表，PDF 保留设计的报表版式。'" type="info" :closable="false"/><template #footer><el-button :disabled="saving || generating" @click="formOpen=false">取消</el-button><el-button type="primary" :loading="saving" :disabled="generating" @click="submitForm">{{ formMode==='schedule'?'创建计划':'开始生成' }}</el-button></template>
      </el-dialog>
      <el-dialog class="studio-preview-dialog" :class="{ 'monthly-reference-dialog': monthlyMode, 'monthly-reference-preview': monthlyMode }" v-model="previewOpen" :title="previewTitle" width="94%" top="4vh" destroy-on-close @close="cancelPreview"><p v-if="previewLoading" class="preview-status" role="status">正在加载报表与数据来源…</p><div v-else-if="previewError" class="preview-status"><el-alert :title="previewError" type="error" :closable="false" show-icon /><el-button @click="preview(previewRow)">重新加载预览</el-button></div><div v-if="manifest" class="provenance"><span>模板 V{{ manifest.version }}</span><span>{{ manifest.parameters?.periodCode || '未注明期间' }}</span><span>{{ manifest.rowCount }} 条定稿指标</span><span>{{ manifest.sourceSheetCount }} 张填报表</span><el-popover width="min(450px, calc(100vw - 32px))" trigger="click" popper-class="studio-source-popover"><template #reference><el-button link type="primary">查看数据来源</el-button></template><div class="studio-source-list"><p v-for="r in manifest.sourceRevisions" :key="r.revisionId">{{ showcase ? `任务 ${r.taskId}` : `${r.organizationName} · 任务 ${r.taskId}` }} · 修订 {{ r.revisionNumber }}（ID {{ r.revisionId }}）</p></div></el-popover></div><ReportResultPreview v-if="previewWorkbook && previewOpen" :key="previewKey" :workbook="previewWorkbook" /></el-dialog>
    </template>
    <Teleport to="body">
      <div v-if="generating" ref="generatingOverlay" class="report-generating-overlay" role="status" aria-live="polite"
        tabindex="-1" @keydown.tab.prevent @keydown.esc.prevent @keydown.enter.prevent>
        <div class="report-generating-card">
          <span class="report-generating-spinner" aria-hidden="true" />
          <strong>正在本地生成报表</strong>
          <p>{{ generationStage || '准备数据' }}，请勿关闭页面…</p>
        </div>
      </div>
    </Teleport>
  </div>
</template>
<script setup>
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount, defineAsyncComponent, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import AppDataTable from '@/components/AppDataTable'
import ReportStudioActions from '@/components/ReportStudioActions.vue'
import ReportStudioSummary from '@/components/ReportStudioSummary.vue'
import { InfoFilled } from '@element-plus/icons-vue'
import '@/styles/report-studio-layout.css'
import { reportStudioApi as api } from '@/api/reportStudio'
import { createWorkflowRequest, formatWorkflowDate } from '@/utils/workflowRequest'
import { emptyStudioState, normalizeStudioState, reconcileStudioState, observeStudioWidth, validateStudioForm, studioError, beijingMonth } from '@/utils/reportStudioState'
import { SHOWCASE, demoOrganization } from '@/config/showcase'
const showcase = SHOWCASE
const ReportSheetDesigner = defineAsyncComponent(() => import('@/components/ReportSheetDesigner.vue'))
const ReportResultPreview = defineAsyncComponent(() => import('@/components/ReportResultPreview.vue'))
const props = defineProps({ monthlyMode: Boolean })
const route = useRoute(), router = useRouter()
const state = shallowRef(emptyStudioState())
const studioHost = ref(null), studioWidth = ref(0)
// Match the content-width breakpoints in report-studio-layout.css.
const compactSummary = computed(() => studioWidth.value <= (tab.value === 'templates' ? 740 : 1130))
const loading = ref(false), saving = ref(false), generating = ref(false), generationStage = ref(''), generatingOverlay = ref(null), error = ref(''), formOpen = ref(false), formMode = ref('generate'), form = ref({})
const previewOpen = ref(false), previewWorkbook = shallowRef(null), previewTitle = ref(''), manifest = shallowRef(null)
const formErrors = ref({}), formError = ref(''), generationForm = ref(null), busy = ref(new Set())
const previewLoading = ref(false), previewError = ref(''), previewKey = ref(0)
const tab = computed(() => {
  const requested = route.query.section
  if (props.monthlyMode) return SHOWCASE ? 'results' : requested === 'schedules' ? 'schedules' : 'results'
  if (SHOWCASE) {
    if (!state.value.capabilities.manage) return 'templates'
    return requested === 'templates' ? 'templates' : 'results'
  }
  return ['templates', 'schedules', 'results'].includes(requested) ? requested : 'templates'
})
const edit = computed(() => !props.monthlyMode && route.query.edit ? String(route.query.edit) : '')
const readOnly = computed(() => route.query.readonly === 'true')
const tabs = computed(() => {
  if (props.monthlyMode) return SHOWCASE ? { results: '生成记录' } : { results: '生成记录', schedules: '生成计划' }
  if (SHOWCASE) return state.value.capabilities.manage ? { results: '生成记录', templates: '报表模板' } : { templates: '报表模板' }
  return state.value.capabilities.manage ? { templates: '报表模板', schedules: '生成计划', results: '生成记录' } : { templates: '报表模板' }
})
const labels = { draft:'草稿', in_review:'待审批', published:'已发布', rejected:'已退回', queued:'排队中', running:'生成中', complete:'已生成', failed:'生成失败' }
const published = computed(() => state.value.templates.filter(t => t.status === 'published'))
const showcaseOrganization = computed(() => demoOrganization(state.value.organizations || []))
const selectedSourceType = computed(() => published.value.find(t => t.id === form.value.templateId)?.sourceReportTypeId)
watch(selectedSourceType, id => { if (id) form.value.reportTypeId = id })
watch(form, () => { if (Object.keys(formErrors.value).length) formErrors.value = validateStudioForm(form.value, formMode.value, state.value) }, { deep: true })
let previousBodyOverflow = '', previousAppInert = false
watch(generating, async value => {
  if (typeof document === 'undefined') return
  const app = document.getElementById('app')
  if (value) {
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    if (app) { previousAppInert = app.inert; app.inert = true }
    await nextTick(); generatingOverlay.value?.focus()
  } else {
    document.body.style.overflow = previousBodyOverflow
    if (app) app.inert = previousAppInert
  }
})
let timer, disposed = false, denied = false, accessRevision = 0, previewController, previewRow
let stopWidthObserver = () => {}
const lifetime = new AbortController()
const tagType = status => ['complete','published'].includes(status) ? 'success' : ['failed','rejected'].includes(status) ? 'danger' : 'info'
const count = key => state.value[key === 'results' ? 'jobs' : key].length
const templateLabel = id => { const t=state.value.templates.find(t=>t.id===id); return t ? `${t.name} · V${t.version}` : `模板 #${id}` }
const formatTime = formatWorkflowDate
function handleAccessFailure(e) {
  if (![401, 403].includes(e?.status)) return
  denied = true; accessRevision++; clearTimeout(timer)
  state.value = emptyStudioState(); error.value = studioError(e)
  cancelPreview(); previewOpen.value = false
}
function schedulePoll() {
  clearTimeout(timer)
  if (showcase) return
  if (disposed || denied || document.hidden || edit.value) return
  const activeJobs = state.value.jobs.some(row => ['queued', 'running'].includes(row.status))
  timer = setTimeout(() => { void load(true) }, activeJobs && !error.value ? 5000 : 30000)
}
const listRequest = createWorkflowRequest({
  request: async signal => { const revision = accessRevision; return { state: normalizeStudioState(await api.list({ signal })), revision } },
  start: quiet => { clearTimeout(timer); if (!quiet) loading.value = true },
  success: result => { if (result.revision !== accessRevision) return; state.value = reconcileStudioState(state.value, result.state); error.value = ''; denied = false },
  failure: e => { if (e?.name !== 'AbortError') { error.value = studioError(e); handleAccessFailure(e) } },
  finish: () => { loading.value = false; schedulePoll() },
})
function load(quiet = false) { return listRequest.run(quiet === true) }
function changeTab(section) { return router.push({ path: route.path, query: { ...route.query, section }, hash: route.hash }) }
function openEditor(id, readonly = false) { return router.push({ path: route.path, query: { ...route.query, edit: String(id), readonly: readonly ? 'true' : undefined }, hash: route.hash }) }
function closeEditor() { const query = { ...route.query }; delete query.edit; delete query.readonly; return router.push({ path: route.path, query, hash: route.hash }) }
async function saved() { await closeEditor(); if (!disposed) await load() }
function openForm(mode, templateId) {
  if (saving.value || !state.value.capabilities.manage || !published.value.length) return
  const selected = published.value.find(t=>t.id===templateId) || published.value[0]
  formMode.value=mode
  form.value={ templateId:selected?.id, reportTypeId:selected?.sourceReportTypeId || state.value.reportTypes.find(t=>t.cadence==='monthly')?.id, organizationIds: SHOWCASE && showcaseOrganization.value ? [showcaseOrganization.value.id] : [], periodCode:beijingMonth(), day:5, time:'09:00', monthOffset:-1, name:'' }
  formErrors.value = {}; formError.value = ''; formOpen.value = true
}
async function submitForm() {
  if (saving.value || disposed) return
  if (!state.value.capabilities.manage) { formError.value = '当前账号无权生成报表，请刷新后确认权限。'; return }
  formErrors.value = validateStudioForm(form.value, formMode.value, state.value)
  if (Object.keys(formErrors.value).length) {
    await nextTick()
    generationForm.value?.$el.querySelector('.is-error input, .is-error [tabindex="0"]')?.focus()
    return
  }
  const mode = formMode.value
  const payload = { ...form.value, name: String(form.value.name || '').trim(), organizationIds: [...new Set(form.value.organizationIds)] }
  if (showcase && mode === 'generate') return generateShowcase(payload)
  saving.value = true; formError.value = ''
  try {
    await (mode === 'schedule' ? api.schedule(payload, { signal: lifetime.signal }) : api.generate(payload, { signal: lifetime.signal }))
    if (disposed) return
    formOpen.value = false
    ElMessage.success(mode === 'schedule' ? '计划已创建' : '已加入生成队列')
    await changeTab(mode === 'schedule' ? 'schedules' : 'results')
    await load()
  } catch (e) {
    if (!disposed && e?.name !== 'AbortError') { formError.value = studioError(e, true); handleAccessFailure(e) }
  } finally { if (!disposed) saving.value = false }
}
async function generateShowcase(payload) {
  saving.value = true; formError.value = ''; generating.value = true; generationStage.value = '准备数据'
  try {
    // Let the blocking overlay paint before SpreadJS takes the main thread.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const prepared = await api.renderData(payload, { signal: lifetime.signal })
    if (disposed) return
    generationStage.value = '渲染报表'
    const { generateReportInBrowser } = await import('@/utils/reportWorkbookGenerator')
    const rendered = await generateReportInBrowser(prepared, stage => { if (!disposed) generationStage.value = stage })
    if (disposed) return
    generationStage.value = '上传成果'
    const formData = new FormData()
    formData.append('templateId', String(payload.templateId))
    formData.append('reportTypeId', String(payload.reportTypeId))
    formData.append('periodCode', payload.periodCode)
    formData.append('organizationIds', JSON.stringify(payload.organizationIds))
    formData.append('manifest', JSON.stringify({ ...prepared.manifest, generatedAt: new Date().toISOString() }))
    formData.append('workbook', rendered.workbookBlob, 'workbook.json')
    formData.append('xlsx', rendered.xlsxBlob, 'report.xlsx')
    formData.append('pdf', rendered.pdfBlob, 'report.pdf')
    await api.uploadResult(formData, { signal: lifetime.signal })
    if (disposed) return
    formOpen.value = false
    ElMessage.success('报表已生成并保存')
    await changeTab('results')
    await load()
  } catch (e) {
    if (!disposed && e?.name !== 'AbortError') { formError.value = studioError(e, true); handleAccessFailure(e) }
  } finally {
    if (!disposed) { generating.value = false; generationStage.value = ''; saving.value = false }
  }
}
async function runAction(key, action, mutation = true) {
  if (disposed || busy.value.has(key)) return
  busy.value.add(key)
  try { await action() }
  catch (e) { if (!disposed && e?.name !== 'AbortError' && e !== 'cancel' && e !== 'close') { ElMessage.error(studioError(e, mutation)); handleAccessFailure(e) } }
  finally { busy.value.delete(key) }
}
function toggle(row) {
  if (!state.value.capabilities.manage) return
  return runAction(`schedule:${row.id}`, async () => { await api.toggle(row.id, !row.enabled, { signal: lifetime.signal }); if (!disposed) await load() })
}
function retry(row) {
  if (!state.value.capabilities.manage) return
  if (showcase) {
    if (!published.value.some(template => template.id === row.template_id)) { ElMessage.warning('模板已不可用'); return }
    openForm('generate', row.template_id)
    form.value.periodCode = row.query?.periodCode || beijingMonth()
    form.value.organizationIds = showcaseOrganization.value ? [showcaseOrganization.value.id] : []
    return
  }
  return runAction(`retry:${row.id}`, async () => {
    await api.generate({ ...row.query, templateId: row.template_id }, { signal: lifetime.signal })
    if (!disposed) { ElMessage.success('已加入生成队列'); await load() }
  })
}
function review(row, action) {
  if (!state.value.capabilities.approve) return
  return runAction(`review:${row.id}`, async () => {
    let note = ''
    if (action === 'reject') note = (await ElMessageBox.prompt('请输入退回原因', '退回报表模板', { inputPattern: /\S+/, inputErrorMessage: '请填写原因' })).value.trim()
    if (disposed) return
    await api.transition(row.id, action, note, { signal: lifetime.signal })
    if (!disposed) { ElMessage.success('审批已处理'); await router.push('/portal/workflow-center?view=todo') }
  })
}
function download(row, format) {
  return runAction(`download:${row.id}:${format}`, () => api.download(row.id, format, `${row.name}-${row.query?.periodCode || '未注明期间'}-v${row.version}`, { signal: lifetime.signal }), false)
}
function recordAction(action, row) {
  if (action === 'view') return openEditor(row.id, true)
  if (action === 'edit') return openEditor(row.id)
  if (action === 'generate') return openForm('generate', row.id)
  if (action === 'workflow') return router.push('/portal/workflow-center?view=todo&type=report_template')
  if (action === 'approve' || action === 'reject') return review(row, action)
  if (action === 'toggle') return toggle(row)
  if (action === 'retry') return retry(row)
  if (action === 'preview') return preview(row)
  if (action === 'xlsx' || action === 'pdf') return download(row, action)
}
function cancelPreview() {
  previewController?.abort(); previewController = undefined
  previewKey.value++; previewLoading.value = false; previewWorkbook.value = null; manifest.value = null
}
async function preview(row) {
  if (disposed || !row) return
  cancelPreview()
  const controller = new AbortController()
  previewController = controller; previewRow = row
  previewTitle.value = row.name || '报表预览'; previewOpen.value = true; previewLoading.value = true; previewError.value = ''
  try {
    const [workbook, job] = await Promise.all([api.workbook(row.id, { signal: controller.signal }), api.job(row.id, { signal: controller.signal })])
    if (disposed || controller !== previewController || !previewOpen.value) return
    if (!workbook || typeof workbook !== 'object' || !job?.manifest || typeof job.manifest !== 'object') throw new Error('报表成果或来源数据不完整，请重试。')
    previewWorkbook.value = workbook; manifest.value = job.manifest
  } catch (e) {
    if (!disposed && controller === previewController && e?.name !== 'AbortError') { controller.abort(); previewError.value = studioError(e); handleAccessFailure(e) }
  } finally { if (controller === previewController) previewLoading.value = false }
}
watch(previewOpen, open => { if (!open) cancelPreview() })
function visibilityChanged() { clearTimeout(timer); if (!document.hidden && !edit.value && !denied) void load(true) }
watch(edit, value => { clearTimeout(timer); if (!value && !disposed) void load(true) })
onMounted(() => {
  stopWidthObserver = observeStudioWidth(studioHost.value, width => { studioWidth.value = width })
  document.addEventListener('visibilitychange', visibilityChanged); void load()
})
onBeforeUnmount(() => {
  disposed = true; clearTimeout(timer); listRequest.dispose(); lifetime.abort(); cancelPreview()
  stopWidthObserver()
  document.removeEventListener('visibilitychange', visibilityChanged)
  document.body.style.overflow = previousBodyOverflow
  const app = document.getElementById('app')
  if (app) app.inert = previousAppInert
})
</script>
