<template>
  <section class="report-designer" :class="{ 'is-readonly': readOnly }">
    <header class="design-toolbar">
      <div class="template-identity">
        <el-button class="back-button" @click="$emit('close')">返回列表</el-button>
        <div class="name-field">
          <label for="report-template-name" class="name-label">模板名称 <span id="report-name-hint">必填，最多 120 个字符</span></label>
          <el-input id="report-template-name" ref="nameInput" v-model="name" placeholder="输入报表模板名称" aria-label="报表模板名称" class="report-name" :class="{ 'is-invalid': !!nameError }" maxlength="120" :aria-invalid="!!nameError" :aria-describedby="nameError ? 'report-name-hint report-name-error' : 'report-name-hint'" :disabled="readOnly || loading || busy" @input="nameError = ''" />
          <p v-if="nameError" id="report-name-error" class="name-error" role="alert">{{ nameError }}</p>
        </div>
        <div class="template-status">
          <span class="version">{{ version ? `V${version}` : '新模板' }}</span>
          <span v-if="readOnly" class="version">只读预览</span>
        </div>
      </div>
      <div v-if="!readOnly" class="save-actions">
        <el-button :disabled="!!error || loading || busy || !source" :loading="operation === 'draft'" @click="save(false)">保存草稿</el-button>
        <el-button type="primary" :disabled="!!error || loading || busy || !source" :loading="operation === 'submit'" @click="save(true)">{{ admin ? '发布模板' : '提交审核' }}</el-button>
      </div>
    </header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-alert v-if="actionError" :title="actionError" type="error" :closable="false" show-icon />
    <div class="design-caption">
      <div class="source-control">
        <label for="report-source">业务数据来源</label>
        <el-select id="report-source" :model-value="reportTypeId" aria-label="业务数据来源" placeholder="选择填报类型" :disabled="loading || busy || readOnly || !!savedId" @change="changeSource">
          <el-option v-for="type in reportTypes" :key="type.id" :label="type.name" :value="type.id" />
        </el-select>
      </div>
      <div class="source-actions">
        <el-button link :disabled="loading || busy || !!error || !source" @click="refreshData">刷新设计数据</el-button>
        <el-button v-if="error" link :disabled="loading || busy" @click="retry">重新加载</el-button>
        <el-popover trigger="click" title="设计数据说明" :width="360" :popper-style="{ maxWidth: 'calc(100vw - 24px)' }" :popper-options="{ modifiers: [{ name: 'preventOverflow', options: { padding: 12, altAxis: true } }] }">
          <template #reference><el-button circle aria-label="设计数据说明"><el-icon><InfoFilled /></el-icon></el-button></template>
          <div class="design-help" tabindex="0" role="region" aria-label="设计数据说明内容">
            <p v-if="!legacy"><strong>字段来源：</strong>可使用所选填报类型中已批准的字段，在设计器的数据源面板中选择。</p>
            <p v-if="legacy"><strong>预览数据：</strong>此旧版模板最多读取 10 条可查看的定稿记录，无数据时预览为空。</p>
            <p v-else><strong>设计数据：</strong>每张表最多读取 10 行数据。缺失值会补入示例值，空表会提供一行示例数据，仅用于设计布局。</p>
            <p><strong>刷新作用：</strong>{{ legacy ? '重新读取预览数据，保留当前布局。' : '同步最新已批准字段和设计数据，保留当前布局。' }}</p>
            <p><strong>正式生成：</strong>使用真实定稿数据。保存模板不会保存设计区的示例数据。</p>
          </div>
        </el-popover>
      </div>
      <span class="source-status" role="status">{{ sourceStatus }}</span>
    </div>
    <p v-if="busy" class="operation-status" role="status">{{ operation === 'submit' ? (admin ? '正在保存并发布模板，请稍候…' : '正在保存并提交审核，请稍候…') : operation === 'draft' ? '正在保存草稿，请稍候…' : '正在刷新设计数据，当前布局会保留…' }}</p>
    <p v-if="!readOnly" id="designer-scroll-hint" class="workspace-hint">横向滚动工作区，可查看完整工具栏和属性面板。</p>
    <div class="designer-frame" v-loading="loading || busy" :aria-busy="loading || busy">
      <div class="designer-viewport" role="region" aria-label="报表工作区" tabindex="0" :aria-describedby="!readOnly ? 'designer-scroll-hint' : undefined">
        <div ref="host" class="designer-host" :inert="loading || busy || confirming || !!error" />
      </div>
    </div>
  </section>
</template>
<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { InfoFilled } from '@element-plus/icons-vue'
import GC from '@grapecity-software/spread-sheets'
import '@grapecity-software/spread-sheets-shapes'
import '@grapecity-software/spread-sheets-charts'
import '@grapecity-software/spread-sheets-print'
import '@grapecity-software/spread-sheets-tablesheet'
import '@grapecity-software/spread-sheets-datacharts-addon'
import '@grapecity-software/spread-sheets-reportsheet-addon'
import '@grapecity-software/spread-sheets-designer-resources-cn'
import * as GCD from '@grapecity-software/spread-sheets-designer'
import '@grapecity-software/spread-sheets/styles/gc.spread.sheets.excel2013white.css'
import '@grapecity-software/spread-sheets-designer/styles/gc.spread.sheets.designer.light.min.css'
import { designerLicense } from '@/utils/spreadjsLicense'
import { observeWorkbookLayout } from '@/utils/observeWorkbookLayout'
import { reportStudioApi as api } from '@/api/reportStudio'
import { sheetDesignFingerprint } from '@/template/sheetDesignState'
const props = defineProps({ templateId: String, admin: Boolean, readOnly: Boolean })
const emit = defineEmits(['close', 'saved'])
const host = ref(), name = ref('定稿指标月报'), version = ref(null), error = ref(''), loading = ref(true), busy = ref(false)
const source = ref(null), reportTypes = ref([]), reportTypeId = ref(null), savedId = ref(null), previewCount = ref(0)
const legacy = ref(false)
const nameInput = ref(), nameError = ref(''), actionError = ref(''), operation = ref(''), confirming = ref(false)
let designer, book, stopResize, existingTemplate, recoveryTemplate, recoveryMode = 'Design'
let disposed = false, catalogReady = false, baseline = null, allowLeave = false, leavePromise
const lifetime = new AbortController()
const requestOptions = { signal: lifetime.signal }
function assertAlive() { if (disposed) throw new DOMException('Editor closed', 'AbortError') }
function errorText(e, fallback) {
  if (e?.status === 401) return '登录已失效，请重新登录。'
  if (e?.status === 403) return '当前账号没有此操作的权限，请联系管理员确认。'
  if (e?.name === 'TimeoutError') return '请求超时，请检查网络后重试。'
  if (e instanceof TypeError && /fetch|network|load/i.test(e.message)) return '网络连接失败，请检查网络后重试。'
  return e?.message || fallback
}
function canOperate() { return !disposed && !busy.value && !loading.value && !confirming.value && !error.value && !!book }
function fingerprint(template) {
  return JSON.stringify({ name: name.value.trim(), source: template?.dataSource?.reportTypeId ?? reportTypeId.value,
    sheets: (template?.sheets || []).map(sheet => ({ name: sheet.name, content: sheetDesignFingerprint(sheet.json) })) })
}
function snapshot() {
  return { schemaVersion: legacy.value ? 1 : 2,
    ...(!legacy.value ? { dataSource: { reportTypeId: reportTypeId.value, columnMapping: source.value.columnMapping, tables: source.value.tables } } : {}),
    sheets: templateSheets() }
}
function finishEditing() {
  const sheet = book?.getActiveSheetTab()?.getTemplate?.()
  if (sheet && sheet.endEdit() === false) throw new Error('请先完成当前单元格的输入，再继续操作。')
}
function hasUnsavedChanges() {
  if (props.readOnly || allowLeave || baseline === null) return false
  try { finishEditing(); return fingerprint(error.value || loading.value ? recoveryTemplate : snapshot()) !== baseline }
  catch { return true }
}
async function confirmLeave() {
  if (allowLeave || disposed) return true
  if (busy.value || (loading.value && baseline !== null)) { ElMessage.info('操作尚未完成，请等待处理结果后再离开。'); return false }
  if (!hasUnsavedChanges()) return true
  if (leavePromise) return leavePromise
  confirming.value = true
  leavePromise = ElMessageBox.confirm('当前修改尚未保存。离开将丢弃这些修改。', '离开报表设计？', {
    confirmButtonText: '放弃修改并离开', cancelButtonText: '继续编辑', type: 'warning',
    closeOnClickModal: false, distinguishCancelAndClose: true,
  }).then(() => !disposed, () => false).finally(() => { confirming.value = false; leavePromise = null })
  return leavePromise
}
onBeforeRouteLeave(confirmLeave)
onBeforeRouteUpdate((to, from) => to.query.edit !== from.query.edit || to.query.readonly !== from.query.readonly ? confirmLeave() : true)
function beforeUnload(event) {
  if (!allowLeave && (busy.value || hasUnsavedChanges())) { event.preventDefault(); event.returnValue = '' }
}
const sourceStatus = computed(() => {
  if (loading.value) return '正在加载设计数据…'
  if (error.value) return '设计数据加载失败，请重新加载。'
  if (!source.value) return '选择填报类型后加载设计数据。'
  if (!source.value.canPreview) return legacy.value ? '无定稿数据查看权限，当前预览为空。' : '无定稿数据查看权限，使用示例数据设计。'
  if (legacy.value) return previewCount.value ? `预览用定稿记录 · ${previewCount.value} 条` : '暂无可预览的定稿数据。'
  return `设计用数据 · 共 ${previewCount.value} 行，缺失值以示例值显示`
})
function reports() {
  const sheets = Array.from({ length: book.getSheetTabCount() }, (_, i) => book.getSheetTab(i))
  if (book.getSheetCount() || !sheets.length || sheets.some(s => typeof s.getTemplate !== 'function')) throw new Error('模板只能包含报表页。请删除普通工作表和数据表，再通过“插入 → 报表”添加报表页。')
  return sheets
}
async function loadInitial() {
  loading.value = true; error.value = ''
  try {
    const [existing, catalog] = await Promise.all([props.templateId && props.templateId !== 'new' ? api.template(props.templateId, requestOptions) : null, api.list(requestOptions)])
    assertAlive()
    reportTypes.value = catalog.reportTypes.filter(t=>t.cadence==='monthly')
    if (existing) { name.value = existing.name; version.value = existing.version; savedId.value = existing.id; existingTemplate = existing.template }
    legacy.value = existingTemplate?.schemaVersion === 1
    reportTypeId.value = existingTemplate?.dataSource?.reportTypeId || reportTypes.value[0]?.id
    if (!reportTypeId.value) throw new Error('暂无月度填报类型。请先创建月度填报类型，再设计报表模板。')
    catalogReady = true
    await initialize(existingTemplate)
  } catch (e) { if (!disposed) error.value = errorText(e, '加载报表失败，请重试。') } finally { if (!disposed) loading.value = false }
}
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  void loadInitial()
})
function destroyDesigner() {
  stopResize?.(); stopResize = null
  if (designer) designer.destroy()
  else book?.destroy()
  designer = null; book = null
}
function schemaColumns(table) {
  return Object.fromEntries(table.columns.map(c=>[c.bindingName || c.key,{dataName:c.key,caption:c.label,dataType:c.dataType,...(c.key==='revisionId' && table.kind==='master'?{isPrimaryKey:true}:{})}]))
}
function columnName(table, key) { const column = table.columns.find(c=>c.key===key); return column?.bindingName || key }
function templateSheets() {
  // TemplateSheet JSON alone omits workbook-scoped named styles. Localize them
  // so saved/reopened templates keep their inherited styles without business rows.
  const workbookStyles = book.toJSON({ includeBindingSource: false }).namedStyles || []
  return reports().map(sheet => {
    const json = sheet.getTemplate().toJSON()
    const styles = new Map(workbookStyles.map(style => [style.name, style]))
    for (const style of json.namedStyles || []) styles.set(style.name, style)
    json.namedStyles = [...styles.values()]
    return { name: sheet.name(), json }
  })
}
function mergeSource(current, previous) {
  if (!previous) return current
  return { ...current, tables: current.tables.map(table => {
    const old = previous.tables?.find(t=>t.name===table.name)
    const names = new Map(table.columns.map(c=>{
      const saved = old?.columns.find(p=>p.key===c.key)
      return [c.key, saved ? saved.bindingName || saved.key : null]
    }))
    const used = new Set([...names.values()].filter(Boolean))
    return {...table,columns:table.columns.map(c=>{
      let bindingName = names.get(c.key)
      if (!bindingName) {
        const base = c.bindingName || c.key
        bindingName = base
        for (let n=1;used.has(bindingName);n++) bindingName = `${base}_${c.key}_${n}`
        used.add(bindingName)
      }
      return {...c,bindingName}
    })}
  })}
}
async function initialize(template, mode = props.readOnly ? 'PaginatedPreview' : 'Design') {
  recoveryTemplate = template; recoveryMode = mode
  loading.value = true; error.value = ''
  try {
    const current = await api.designSource(reportTypeId.value, requestOptions)
    assertAlive()
    source.value = mergeSource(current, template?.dataSource)
    destroyDesigner()
    if (props.readOnly) {
      book = new GC.Spread.Sheets.Workbook(host.value, { sheetCount: 0, enableAccessibility: true,
        allowContextMenu: false, newTabVisible: false, tabEditable: false, allowSheetReorder: false,
        allowUserDragDrop: false, allowUserDragFill: false, allowUserResize: false })
    } else {
      GCD.Spread.Sheets.Designer.LicenseKey = designerLicense
      designer = new GCD.Spread.Sheets.Designer.Designer(host.value, undefined, undefined, { sheetCount: 0, enableAccessibility: true })
      book = designer.getWorkbook()
    }
    const manager = book.dataManager()
    const definitions = legacy.value ? [{name:'ReportData',columns:[]}] : source.value.tables
    previewCount.value = 0
    for (const table of definitions) {
      const rows = await manager.addTable(table.name, { remote:{read:api.designRead(reportTypeId.value,table.name,legacy.value)}, ...(!legacy.value ? {schema:{columns:schemaColumns(table)}} : {}) }).fetch()
      assertAlive()
      previewCount.value += Array.isArray(rows) ? rows.length : 0
    }
    if (!legacy.value) for (const table of definitions.filter(t=>t.kind==='detail')) manager.addRelationship(manager.tables[table.name],columnName(table,'revisionId'),'master',manager.tables.ReportData,columnName(definitions.find(t=>t.name==='ReportData'),'revisionId'),table.name)
    for (const definition of template?.sheets || [{ name: '月度报表' }]) {
      const report = book.addSheetTab(book.getSheetTabCount(), definition.name, GC.Spread.Sheets.SheetType.reportSheet)
      if (!report) throw new Error('报表设计功能未能启动，请联系管理员检查报表组件及授权。')
      if (definition.json) { await report.loadTemplateAsync(definition.json); assertAlive() }
      else {
        const t = report.getTemplate(); t.setRowCount(8); t.setColumnCount(7)
        t.setValue(0, 0, '定稿指标月报'); t.addSpan(0, 0, 1, 6)
        t.getRange(0, 0, 1, 6).font('bold 20px Noto Sans SC').foreColor('#4b0b31')
        const columns = source.value.tables[0].columns
        const fields = [...columns.filter(c=>['organizationName','periodCode'].includes(c.key)),...columns.filter(c=>c.fieldId).slice(0,4)]
        fields.forEach((field, col) => { t.setColumnWidth(col, col===0?175:150); t.setValue(2,col,field.label+(field.unit?`（${field.unit}）`:'')); t.setTemplateCell(3,col,{type:'List',binding:`ReportData[${field.bindingName || field.key}]`}); if(field.dataType==='number')t.setFormatter(3,col,'#,##0.00') })
        t.getRange(2, 0, 1, 6).backColor('#e9f1f6').font('bold 12px Noto Sans SC')
        t.setRowHeight(0, 40); t.setRowHeight(2, 30)
      }
      await report.setRenderModeAsync(mode)
      assertAlive()
    }
    stopResize = observeWorkbookLayout(host.value, designer || book)
    if (baseline === null) baseline = fingerprint(snapshot())
    return true
  } catch (e) {
    if (!disposed) {
      error.value = `${errorText(e, '报表加载失败。')}${baseline !== null ? ' 当前设计已暂存，点击“重新加载”可恢复。离开或刷新页面会丢失未保存的修改。' : ' 解决问题后，点击“重新加载”再试。'}`
      destroyDesigner()
    }
    return false
  } finally { if (!disposed) loading.value = false }
}
async function retry() {
  if (disposed || loading.value || busy.value || confirming.value) return
  if (!catalogReady) return loadInitial()
  return initialize(recoveryTemplate, recoveryMode)
}
async function changeSource(id) {
  if (disposed || props.readOnly || savedId.value || loading.value || busy.value || confirming.value || id === reportTypeId.value) return
  confirming.value = true
  try {
    if (book || baseline !== null) await ElMessageBox.confirm('切换后将按新的填报类型重建报表，当前布局和未保存的修改会被清除。','切换业务数据来源？',{confirmButtonText:'清除当前设计并切换',cancelButtonText:'保留当前设计',type:'warning',closeOnClickModal:false})
    assertAlive()
    reportTypeId.value = id
    await initialize(null)
  } catch { /* Cancelling keeps the original source and design. */ }
  finally { if (!disposed) confirming.value = false }
}
async function refreshData() {
  if (!canOperate()) return
  busy.value = true
  operation.value = 'refresh'; actionError.value = ''
  try {
    finishEditing()
    const current = snapshot()
    const mode = props.readOnly ? 'PaginatedPreview' : book.getActiveSheetTab()?.renderMode?.() || 'Design'
    const restored = await initialize(current, mode)
    assertAlive()
    if (restored) ElMessage.success('设计数据已刷新，当前布局已保留')
  } catch (e) { if (!disposed) actionError.value = errorText(e, '读取数据失败，请重试。') }
  finally { if (!disposed) { busy.value = false; operation.value = '' } }
}
async function save(submit) {
  if (!canOperate() || props.readOnly) return
  const trimmedName = name.value.trim()
  if (!trimmedName || trimmedName.length > 120) {
    nameError.value = trimmedName ? '模板名称不能超过 120 个字符。' : '请填写报表模板名称。'
    nameInput.value?.focus(); return
  }
  busy.value = true; operation.value = submit ? 'submit' : 'draft'; actionError.value = ''
  let draftSaved = false
  try {
    finishEditing()
    const sheets = reports()
    for (const sheet of sheets) { await sheet.setRenderModeAsync('Design'); assertAlive() }
    const template = snapshot()
    const result = await api.save({ id: savedId.value, name: trimmedName, template }, requestOptions)
    assertAlive()
    savedId.value = result.id; name.value = trimmedName; baseline = fingerprint(template); draftSaved = true
    if (submit) { await api.transition(savedId.value, 'submit', undefined, requestOptions); assertAlive() }
    allowLeave = true
    ElMessage.success(submit ? props.admin ? '模板已发布，可用于生成报表' : '模板已提交审核，可在流程中心查看进度' : '草稿已保存，可在报表列表继续编辑'); emit('saved')
  } catch (e) {
    if (!disposed) {
      const uncertain = e.name === 'TimeoutError' || e instanceof TypeError
      const outcome = draftSaved
        ? (props.admin ? '草稿已保存，但尚未确认发布成功。' : '草稿已保存，但尚未确认提交审核成功。')
        : '尚未确认保存成功，当前设计仍保留在本页。'
      const next = uncertain
        ? '请在新页面打开报表工作室核实模板状态，确认后再重试，避免重复操作。'
        : '解决问题后可重试；离开或刷新页面会丢失未保存的修改。'
      actionError.value = `${outcome}${errorText(e, '操作未完成。')} ${next}`
    }
  } finally { if (!disposed) { busy.value = false; operation.value = '' } }
}
onBeforeUnmount(() => { disposed = true; lifetime.abort(); window.removeEventListener('beforeunload', beforeUnload); destroyDesigner() })
</script>
<style scoped>
.report-designer {
  container: report-designer / inline-size;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: calc(100vh - 56px);
  height: calc(100dvh - 56px);
  min-height: 720px;
  min-width: 0;
  padding: 16px;
  gap: 12px;
  color: var(--portal-ink, #2c1b26);
  --el-color-primary: #941966;
}
.save-actions, .template-status, .source-control, .source-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.design-toolbar { display: grid; grid-template-columns: auto minmax(160px, 420px) auto 1fr auto; align-items: center; gap: 4px 12px; min-width: 0; }
/* Shared rows keep actions aligned with the input, even when its label wraps or an error appears. */
.template-identity, .name-field { display: contents; }
.back-button { grid-area: 2 / 1; }
.name-label { grid-area: 1 / 2; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-size: 12px; line-height: 1.5; font-weight: 600; }
.name-label span { color: var(--portal-muted, #6d5a65); font-weight: normal; }
.design-help { max-height: min(360px, calc(100dvh - 100px)); overflow-y: auto; overscroll-behavior: contain; scrollbar-color: #8e9ba8 #f4ecef; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.design-help:focus-visible { outline: 2px solid var(--portal-focus, #941966); outline-offset: 2px; }
.design-help p { margin: 0 0 12px; }
.design-help p:last-child { margin-bottom: 0; }
.report-name { grid-area: 2 / 2; width: 100%; min-width: 0; }
.template-status { grid-area: 2 / 3; flex-wrap: wrap; }
.version { flex: none; color: var(--portal-muted, #6d5a65); font-size: 12px; }
.save-actions { grid-area: 2 / 5; }
.report-designer .el-button + .el-button { margin-left: 0; }
.name-error { grid-area: 3 / 2; margin: 0; color: #b42318; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.report-name.is-invalid :deep(.el-input__wrapper) { box-shadow: 0 0 0 1px #b42318 inset; }
.design-caption {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--portal-line, #e8d9e1);
}
.source-control { flex: 0 1 352px; }
.source-control label { flex: none; font-size: 12px; font-weight: 600; }
.source-control .el-select { flex: 1; min-width: 0; }
.source-actions { flex: none; }
.source-actions .el-button.is-circle { color: var(--portal-muted, #6d5a65); }
.source-status, .operation-status, .workspace-hint {
  color: var(--portal-muted, #6d5a65);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  min-width: 0;
}
.source-status { flex: 1 1 240px; }
.operation-status, .workspace-hint { margin: 0; }
.workspace-hint { display: none; }
.designer-frame {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 440px;
  border: 1px solid var(--portal-line, #e8d9e1);
  background: var(--portal-surface, #fff);
}
.designer-viewport {
  position: absolute;
  inset: 0;
  overflow: auto;
  overscroll-behavior-x: contain;
  scrollbar-color: #8e9ba8 #f4ecef;
}
/* Keep all native tools reachable instead of clipping SDK panels on small screens. */
.designer-host { width: 100%; height: 100%; }
.is-readonly .designer-host { min-width: 0; }
.report-designer :is(.el-button, .designer-viewport):focus-visible { outline: 2px solid var(--portal-focus, #941966); outline-offset: 2px; }
.report-designer :deep(input) { caret-color: var(--portal-focus, #941966); }
@container report-designer (max-width: 1100px) {
  .designer-host { min-width: 1200px; }
  .is-readonly .designer-host { min-width: 0; }
  .workspace-hint { display: block; }
  .source-status { flex-basis: 100%; }
}
@container report-designer (max-width: 680px) {
  .design-toolbar { grid-template-columns: auto minmax(0, 1fr); gap: 8px 12px; }
  .back-button { grid-area: 1 / 1; }
  .template-status { grid-area: 1 / 2; justify-content: flex-end; }
  .name-label { grid-area: 2 / 1 / auto / -1; }
  .report-name { grid-area: 3 / 1 / auto / -1; }
  .name-error { grid-area: 4 / 1 / auto / -1; }
  .save-actions { grid-area: 5 / 1 / auto / -1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .source-control { flex: 1 1 100%; }
  .source-actions { margin-inline-start: auto; }
  .source-status { flex: 1 1 160px; }
  .design-toolbar .el-button, .design-caption .el-button { min-height: 44px; }
  .design-caption .el-button.is-circle { width: 44px; }
  .design-toolbar :deep(.el-input__wrapper), .design-caption :deep(.el-select__wrapper) { min-height: 44px; box-sizing: border-box; }
  .name-field :deep(input) { font-size: 16px; }
}
@media (max-width: 800px) {
  .report-designer { height: auto; min-height: 0; padding: 12px; }
  .designer-frame { flex: none; height: max(560px, calc(100dvh - 280px)); }
}
@media (pointer: coarse) {
  .design-toolbar .el-button, .design-caption .el-button { min-height: 44px; }
  .design-caption .el-button.is-circle { width: 44px; }
}
</style>
