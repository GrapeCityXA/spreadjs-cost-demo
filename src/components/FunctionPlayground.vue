<template>
  <section class="function-playground" aria-label="SpreadJS Function Playground">
    <div class="playground-toolbar">
      <div class="playground-title"><h2>Function Playground</h2><span>SpreadJS 19.2.0 · 自定义公式试算</span></div>
      <div class="playground-actions"><span class="save-state" :class="{ 'is-error': saveError }" role="status" aria-live="polite">{{ saveState }}</span><el-button v-if="!readonly" :disabled="locked || draftConflict" @click="resetCode">重置代码</el-button></div>
    </div>
    <div v-if="draftConflict" class="playground-feedback" role="status">
      <p>发现与当前服务器版本不同的本地草稿。请选择要继续编辑的代码；选择前不会覆盖本地草稿。</p>
      <el-button @click="resolveConflict(true)">恢复本地草稿</el-button><el-button @click="resolveConflict(false)">使用服务器版本</el-button>
    </div>
    <div v-if="resetBackup !== null && !readonly" class="playground-feedback" role="status">
      <span>已保留替换前的代码。</span><el-button :disabled="locked || draftConflict" @click="restoreBackup">恢复替换前代码</el-button>
    </div>
    <div v-if="saveError" class="playground-feedback is-error" role="alert"><span>{{ saveError }}</span><el-button @click="persist">重试本地保存</el-button><el-button @click="downloadCode">下载代码备份</el-button></div>
    <div v-if="preparationError" class="playground-feedback" role="status"><span>{{ preparationError }}</span><el-button :disabled="locked || draftConflict" @click="prepareCode">重试代码检查</el-button></div>
    <FunctionSourceTools v-if="!draftConflict" ref="sourceTools" :code="code" :rule-id="ruleId" :disabled="readonly || locked" @update="setCode" @identity="identity = $event" />
    <nav class="playground-navigation" aria-label="公式工作区快捷定位">
      <el-button aria-label="前往代码编辑区" @click="focusPanel('code')">代码编辑</el-button>
      <el-button aria-label="前往公式试算区" @click="focusPanel('result')">公式试算</el-button>
    </nav>
    <div class="playground-grid">
      <section ref="codePanel" class="code-panel" aria-label="代码编辑区" tabindex="-1">
        <div class="panel-heading"><strong><span class="js-badge">JS</span> {{ identity.className || 'Function' }}.js</strong><span>JavaScript</span></div>
        <div v-show="editorReady" ref="editorHost" class="monaco-host" aria-label="Function 代码编辑器"></div>
        <textarea v-if="!editorReady" v-model="code" class="code-fallback" aria-label="Function 代码编辑器（基础模式）" :readonly="readonly || locked || draftConflict" spellcheck="false" @keydown.ctrl.enter.prevent="applyCode" @keydown.meta.enter.prevent="applyCode"></textarea>
        <div v-if="editorError" class="playground-feedback is-error" role="alert"><span>{{ editorError }}</span><el-button :loading="editorLoading" @click="loadEditor">重试加载</el-button></div>
        <div class="editor-foot"><span>{{ editorReady ? `入口类：${identity.className || '等待识别'}` : '基础编辑模式可用' }}</span><span class="editor-shortcut">Ctrl / ⌘ + Enter 应用代码</span><el-button class="compact-run" type="primary" :disabled="draftConflict || locked" @click="runAndShowResult">应用并查看试算</el-button></div>
      </section>
      <section ref="resultPanel" class="result-panel" aria-label="SpreadJS 试算区" tabindex="-1">
        <div class="panel-heading"><strong>SpreadJS 试算</strong><span>参数按 evaluate() 声明识别</span></div>
        <FunctionPlaygroundSheet v-if="!draftConflict" :key="sheetKey" ref="sheetPreview" :code="code" :initial-cells="sheetCells" @changed="sheetCells = $event" />
        <p v-else class="playground-feedback">选择草稿后即可试算。</p>
      </section>
    </div>
    <p class="playground-note">修改代码后点击“应用代码并计算”，在单元格中输入公式并按 Enter 试算。代码与试算输入自动保存在当前浏览器。</p>
  </section>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { defaultCode } from './functionPlaygroundDefaults'
import FunctionPlaygroundSheet from './FunctionPlaygroundSheet.vue'
import FunctionSourceTools from './FunctionSourceTools.vue'
import { functionPlaygroundApi } from '@/api'
import { normalizeTrialCells, playgroundStorageKey, resolveFunctionDraft } from './functionPlaygroundState'

const props = defineProps({ initialCode: String, templateCode: String, ruleId: Number, draftKey: String, readonly: Boolean, locked: Boolean })
const initialTemplate = props.templateCode || defaultCode
const sourceTools = ref(null), identity = ref({})
const editorHost = ref(null), editorReady = ref(false), editorLoading = ref(false), editorError = ref(''), code = ref(props.initialCode ?? initialTemplate)
const saveState = ref('尚未在本机保存'), saveError = ref(''), preparationError = ref(''), sheetPreview = ref(null), sheetCells = shallowRef(null), sheetKey = ref(0)
const draftConflict = ref(false), resetBackup = ref(null)
const codePanel = ref(null), resultPanel = ref(null)
let editor, model, changeSubscription, extraLib, layoutSubscription, saveTimer, preparationController, preparationTimer, disposed = false, previousDraft = {}, revision = 0
let baseCode = props.initialCode ?? initialTemplate
let lastSavedContent, lastSavedKey
let userId = 'current'
try { userId = JSON.parse(localStorage.getItem('userInfo') || '{}').id || userId } catch {}
let storageKey = playgroundStorageKey(userId, props.draftKey, props.readonly)
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
  if (saved && typeof saved.code === 'string') {
    previousDraft = saved
    const restored = resolveFunctionDraft(saved, baseCode, props.initialCode != null)
    if (!props.readonly) { code.value = restored.code; draftConflict.value = restored.conflict }
    sheetCells.value = props.readonly ? normalizeTrialCells(saved.sheetCells) : restored.cells
    resetBackup.value = typeof saved.resetBackup === 'string' ? saved.resetBackup : null
    saveState.value = draftConflict.value ? '本地草稿等待确认' : '已读取本地保存'
  }
} catch { saveError.value = '无法读取本地草稿。当前代码仍可编辑，请下载备份。' }
function persist() {
  clearTimeout(saveTimer)
  if (draftConflict.value) return false
  try {
    const content = JSON.stringify({ ...previousDraft, code: code.value, baseCode, sheetCells: sheetCells.value, resetBackup: resetBackup.value })
    if (content !== lastSavedContent || storageKey !== lastSavedKey || localStorage.getItem(storageKey) !== content) {
      localStorage.setItem(storageKey, content)
      lastSavedContent = content; lastSavedKey = storageKey
    }
    saveState.value = props.readonly ? '试算输入已在本机保存' : '已在本机保存'; saveError.value = ''
    return true
  } catch { saveState.value = '本地保存失败'; saveError.value = '浏览器未能保存当前内容。请重试或下载代码备份，避免关闭后丢失。'; return false }
}
watch(code, () => { revision++ }, { flush: 'sync' })
// The sheet emits immutable input snapshots; code edits need not traverse every cell.
watch([code, sheetCells, resetBackup], () => {
  if (draftConflict.value || disposed) return
  saveState.value = '保存中…'; clearTimeout(saveTimer); saveTimer = setTimeout(persist, 250)
}, { flush: 'sync' })
watch(() => props.readonly || props.locked || draftConflict.value, value => editor?.updateOptions({ readOnly: value }))
function cancelPreparation() { preparationController?.abort(); preparationController = null; clearTimeout(preparationTimer) }
async function prepareCode() {
  if (props.readonly || props.locked || draftConflict.value || disposed) return
  cancelPreparation()
  const controller = new AbortController(), startCode = code.value, startRevision = revision
  preparationController = controller; preparationError.value = ''
  preparationTimer = setTimeout(() => controller.abort(), 10000)
  try {
    const upgraded = await functionPlaygroundApi.serializationTemplate(startCode, controller.signal)
    if (disposed || controller.signal.aborted || startRevision !== revision || code.value !== startCode || props.locked) return
    if (typeof upgraded?.code !== 'string') throw new Error('服务器返回的代码无效')
    setCode(upgraded.code)
  } catch (error) {
    if (!disposed && preparationController === controller && startRevision === revision) {
      preparationError.value = error.name === 'AbortError' ? '代码检查超时，当前代码已保留，可以继续编辑或重试。' : '未能完成代码检查，当前代码已保留。请检查网络及代码后重试。'
    }
  } finally { if (preparationController === controller) { clearTimeout(preparationTimer); preparationController = null } }
}
async function loadEditor() {
  if (editorLoading.value || editorReady.value || disposed) return
  editorLoading.value = true
  try {
    const { createFunctionEditor } = await import('./functionPlaygroundMonaco')
    if (disposed) return
    const restoreFocus = document.activeElement?.classList.contains('code-fallback')
    const created = createFunctionEditor(editorHost.value, code.value, applyCode)
    editor = created.editor; model = created.model; extraLib = created.extraLib; layoutSubscription = created.layoutSubscription
    changeSubscription = editor.onDidChangeModelContent(() => { code.value = editor.getValue() })
    editor.updateOptions({ readOnly: props.readonly || props.locked || draftConflict.value })
    editorReady.value = true; editorError.value = ''
    await nextTick()
    if (!disposed) { editor.layout(); if (restoreFocus) editor.focus() }
  } catch { editorError.value = '增强编辑器加载失败，可继续使用基础编辑模式，或重试加载。' }
  finally { editorLoading.value = false }
}
onMounted(() => {
  window.addEventListener('pagehide', persist)
  loadEditor(); prepareCode()
})
onBeforeUnmount(() => {
  disposed = true; cancelPreparation(); persist(); window.removeEventListener('pagehide', persist)
  changeSubscription?.dispose(); layoutSubscription?.dispose(); editor?.dispose(); model?.dispose(); extraLib?.dispose()
})
function focusPanel(target) {
  const panel = target === 'code' ? codePanel.value : resultPanel.value
  panel?.scrollIntoView({ block: 'start', behavior: 'instant' })
  panel?.focus({ preventScroll: true })
}
function runAndShowResult() { applyCode(); focusPanel('result') }
function setCode(value) {
  code.value = value
  if (editor && editor.getValue() !== value) {
    editor.pushUndoStop()
    editor.executeEdits('playground', [{ range: model.getFullModelRange(), text: value }])
    editor.pushUndoStop()
  }
}
function resolveConflict(restore) {
  if (!draftConflict.value || props.locked) return
  if (restore) { setCode(previousDraft.code); sheetCells.value = normalizeTrialCells(previousDraft.sheetCells) }
  else { resetBackup.value = previousDraft.code; setCode(baseCode); sheetCells.value = null }
  draftConflict.value = false; sheetKey.value++; persist(); prepareCode()
}
function resetCode() {
  if (props.readonly || props.locked || draftConflict.value || code.value === initialTemplate) return
  cancelPreparation(); resetBackup.value = code.value; setCode(initialTemplate); persist()
}
function restoreBackup() {
  if (props.readonly || props.locked || draftConflict.value || resetBackup.value === null) return
  cancelPreparation(); const backup = resetBackup.value; resetBackup.value = code.value; setCode(backup); persist()
}
function applyCode() { if (!draftConflict.value) { cancelPreparation(); persist(); sheetPreview.value?.applyCode() } }
function downloadCode() {
  const url = URL.createObjectURL(new Blob([code.value], { type: 'text/javascript;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = `${identity.value.className || 'Function'}.js`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function markSaved(sourceCode, versionId) {
  if (disposed || props.readonly) return
  baseCode = sourceCode
  const oldKey = storageKey
  if (versionId != null) storageKey = playgroundStorageKey(userId, `version-${versionId}`)
  if (persist() && oldKey !== storageKey) { try { localStorage.removeItem(oldKey) } catch {} }
}
defineExpose({ getData: () => {
  if (draftConflict.value) throw new Error('请先选择恢复本地草稿或使用服务器版本')
  sourceTools.value?.assertReady()
  cancelPreparation()
  return { sourceCode: code.value, sheetCells: sheetCells.value }
}, markSaved, isDirty: () => code.value !== baseCode || draftConflict.value, getDraftSource: () => code.value })
</script>

<style scoped src="../styles/function-playground.css"></style>
