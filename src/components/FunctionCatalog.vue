<template>
  <section ref="root" class="function-catalog">
    <div v-if="!editing" class="catalog-actions"><span>在此管理自定义公式及其版本；发布后才能添加到模板。</span><div><el-button @click="$emit('refresh')">刷新</el-button><el-button v-if="canManage" type="primary" :disabled="!catalogReady" @click="open()">新建自定义公式</el-button></div></div>
    <app-data-table v-if="!editing" class="rule-catalog-table function-catalog-table" accessible responsive table-label="自定义公式目录" :data="functions" row-key="versionId" :empty-text="!catalogReady ? '尚未取得公式目录，请稍候；若一直无结果，可点击“刷新”。' : canManage ? '暂无自定义公式，点击“新建自定义公式”开始编写。' : '暂无可用的已发布公式'">
      <el-table-column prop="displayName" label="名称" min-width="140"><template #default="{ row }"><el-button link type="primary" class="function-name" @click="open(row)">{{ row.displayName }}</el-button></template></el-table-column>
      <el-table-column prop="code" label="编码" min-width="148" />
      <el-table-column label="函数 / 类型" min-width="210"><template #default="{ row }"><code>{{ row.expression.functionName || '尚无函数名' }}</code><small>{{ row.expression.typeName || '尚无类型信息' }}</small></template></el-table-column>
      <el-table-column prop="version" label="版本" width="140" />
      <el-table-column label="状态" width="140" :column-value="row => statusLabel(row.status)"><template #default="{ row }"><el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
      <el-table-column prop="creatorName" label="创建人" width="156" />
      <el-table-column label="操作" min-width="230" fixed="right"><template #default="{ row }"><div class="function-table-actions"><el-button link type="primary" @click="open(row)">{{ editable(row) ? '修改' : '查看 / 试算' }}</el-button><el-button v-if="canManage && row.status === 'published'" link type="primary" @click="open(row, true)">新建版本</el-button><el-button link @click="download(row)" title="下载此版本的公式定义（JSON 文件）">下载定义</el-button></div></template></el-table-column>
      <template #compact="{ rows, total, expanded }">
        <p v-if="expanded" class="function-scroll-hint">横向滚动查看全部列；聚焦表格后可用左右方向键浏览。</p>
        <div v-else class="function-summary">
          <p v-if="!rows.length" class="function-empty">{{ !catalogReady ? '尚未取得公式目录，请稍候；若一直无结果，可点击“刷新”。' : functions.length && !total ? '没有符合筛选条件的公式，请展开表格调整筛选。' : canManage ? '暂无自定义公式，点击“新建自定义公式”开始编写。' : '暂无可用的已发布公式' }}</p>
          <ul v-else class="function-records" aria-label="自定义公式摘要列表">
            <li v-for="row in rows" :key="row.versionId" class="function-record">
              <div class="function-record-heading">
                <el-button link type="primary" class="function-name" @click="open(row)">{{ row.displayName }}</el-button>
                <span class="function-record-state"><span>V{{ row.version }}</span><el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag></span>
              </div>
              <p class="function-record-code">{{ row.code }}</p>
              <div class="function-record-actions">
                <el-button type="primary" plain @click="open(row)">{{ editable(row) ? '修改' : '查看 / 试算' }}</el-button>
                <el-button v-if="canManage && row.status === 'published'" @click="open(row, true)">新建版本</el-button>
                <el-button link class="function-download" @click="download(row)" title="下载此版本的公式定义（JSON 文件）">下载定义</el-button>
              </div>
              <details class="function-record-details"><summary>函数与创建信息</summary><dl>
                <div><dt>函数</dt><dd><code>{{ row.expression.functionName || '尚无函数名' }}</code></dd></div>
                <div><dt>类型标识</dt><dd>{{ row.expression.typeName || '尚无类型信息' }}</dd></div>
                <div><dt>创建人</dt><dd>{{ row.creatorName || '—' }}</dd></div>
              </dl></details>
            </li>
          </ul>
        </div>
      </template>
    </app-data-table>
    <template v-else>
      <div class="catalog-actions function-editor-actions"><el-button :disabled="busy" @click="close">返回公式列表</el-button><div><el-tag v-if="form.version" :type="statusType(form.status)">V{{ form.version }} · {{ statusLabel(form.status) }}</el-tag><el-button v-if="!readOnly" :loading="saving && stage === '保存草稿'" :disabled="busy || uncertain" @click="save(false)">保存草稿</el-button><el-button v-if="!readOnly" type="primary" :loading="saving && stage !== '保存草稿'" :disabled="busy || uncertain" @click="save(true)">{{ isSystemAdmin ? '保存并发布' : '提交管理员审批' }}</el-button></div></div>
      <p class="function-editor-help">{{ editorHelp }}</p>
      <div v-if="feedback" class="function-catalog-feedback">
        <el-alert :title="feedback" :type="feedbackType" :role="errorMessage ? 'alert' : 'status'" :closable="false" show-icon />
        <div v-if="uncertain" class="recovery-actions">
          <el-button :loading="checking" :disabled="saving" @click="reconcile">核对保存结果</el-button>
          <el-button :disabled="busy" @click="downloadDraft">下载草稿备份</el-button>
        </div>
      </div>
      <el-form label-position="top" class="function-meta" :disabled="readOnly || busy || uncertain" @submit.prevent>
        <el-form-item label="公式编码" required :error="errors.code">
          <el-input v-model="form.code" :disabled="Boolean(form.ruleId) || readOnly || busy || uncertain" maxlength="64" aria-required="true" :aria-invalid="Boolean(errors.code)" :aria-describedby="errors.code ? 'function-code-help function-code-error' : 'function-code-help'" placeholder="例如 SALES_AMOUNT" @input="clearError('code')" />
          <template #error="{ error }"><div id="function-code-error" class="el-form-item__error">{{ error }}</div></template>
          <p id="function-code-help" class="field-help">{{ form.ruleId ? '编码已固定，后续版本沿用此编码。' : '2–64 位，以英文字母开头，仅含字母、数字或下划线；保存时转为大写，首次保存后不能修改。' }}</p>
        </el-form-item>
        <el-form-item label="公式名称" required :error="errors.displayName">
          <el-input v-model="form.displayName" :disabled="Boolean(form.ruleId) || readOnly || busy || uncertain" maxlength="120" aria-required="true" :aria-invalid="Boolean(errors.displayName)" :aria-describedby="errors.displayName ? 'function-name-help function-name-error' : 'function-name-help'" placeholder="例如 含税金额" @input="clearError('displayName')" />
          <p id="function-name-help" class="field-help">{{ form.ruleId ? '名称已固定，后续版本沿用此名称。' : '最多 120 个字符，首次保存后不能修改。' }}</p>
          <template #error="{ error }"><div id="function-name-error" class="el-form-item__error">{{ error }}</div></template>
        </el-form-item>
        <el-form-item class="function-description" label="用途说明（选填）" :error="errors.description">
          <el-input v-model="form.description" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" maxlength="2000" :aria-invalid="Boolean(errors.description)" :aria-describedby="errors.description ? 'function-description-error' : undefined" placeholder="说明公式适用的业务场景及参数含义，最多 2000 个字符" @input="clearError('description')" />
          <template #error="{ error }"><div id="function-description-error" class="el-form-item__error">{{ error }}</div></template>
        </el-form-item>
      </el-form>
      <el-alert v-if="form.reviewNote" class="function-review-note" title="审批说明" :description="form.reviewNote" type="info" :closable="false" />
      <FunctionPlayground ref="playground" :key="editorKey" :initial-code="form.expression?.sourceCode" :template-code="newTemplate" :rule-id="form.ruleId" :draft-key="form.versionId ? `version-${form.versionId}` : form.ruleId ? `new-version-${form.ruleId}` : undefined" :readonly="readOnly" :locked="busy || uncertain" />
    </template>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import FunctionPlayground from './FunctionPlayground.vue'
import { unusedFunctionTemplate } from './functionPlaygroundDefaults'
import { ruleCatalogApi } from '@/api'
import { normalizeRules, validateRuleIdentity, ruleFailure, ruleRequest } from '@/utils/ruleCatalogState'
const props = defineProps({ rules: { type: Array, default: () => [] }, catalogReady: { type: Boolean, default: true }, canManage: Boolean, isSystemAdmin: Boolean, userId: Number })
const emit = defineEmits(['refresh'])
const functions = computed(() => props.rules.filter(row => row?.expression?.engine === 'spreadjs-function'))
const labels = { draft: '草稿', published: '已发布', pending_review: '待审批', rejected: '已驳回', retired: '已停用' }
const statusLabel = status => labels[status] || '状态待确认'
const statusType = status => ({ published: 'success', pending_review: 'warning', rejected: 'danger' })[status] || 'info'
const editing = ref(false), readOnly = ref(false), saving = ref(false), checking = ref(false), editorKey = ref(0), playground = ref(null), form = ref({}), root = ref(null)
const newTemplate = ref(''), errors = ref({}), errorMessage = ref(''), notice = ref(''), stage = ref(''), uncertain = ref(false)
const editorHelp = computed(() => {
  if (readOnly.value) {
    if (form.value.status === 'pending_review') return '此版本正在等待审批，当前可查看源码和试算。'
    if (form.value.status === 'published' && props.canManage) return '此版本已发布，可查看源码和试算。如需修改，请返回列表选择“新建版本”。'
    return '此版本只读，可查看源码和试算。'
  }
  const action = props.isSystemAdmin ? '“保存并发布”会先验证公式，通过后发布。' : '“提交管理员审批”会先保存并验证公式，通过后送交系统管理员审批。'
  return `${form.value.ruleId && !form.value.versionId ? '正在创建新版本，不会修改已有发布版本。' : ''}“保存草稿”仅保存当前内容，不会发布。${action}`
})
const busy = computed(() => saving.value || checking.value)
const feedbackType = computed(() => busy.value ? 'info' : uncertain.value ? 'warning' : errorMessage.value ? 'error' : notice.value ? 'success' : 'info')
const feedback = computed(() => busy.value ? `${checking.value ? '正在核对保存结果' : `正在${stage.value}`}…` : errorMessage.value || notice.value)
let disposed = false, baseline = '', closePromise = null, controller = null, pendingWrite = null
const metadata = () => JSON.stringify([form.value.code || '', form.value.displayName || '', form.value.description || ''])
const dirty = () => editing.value && !readOnly.value && (metadata() !== baseline || Boolean(playground.value?.isDirty?.()))
const editable = row => props.canManage && ['draft', 'rejected'].includes(row.status) && Number(row.createdBy) === Number(props.userId)
const currentSession = token => !disposed && localStorage.getItem('token') === token
function beforeUnload(event) {
  if (editing.value && (busy.value || uncertain.value || dirty())) { event.preventDefault(); event.returnValue = '' }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => { disposed = true; controller?.abort(); window.removeEventListener('beforeunload', beforeUnload) })
async function allowLeave() {
  if (!editing.value) return true
  if (busy.value) { ElMessage.warning('操作仍在进行，请等待结果后再离开。'); return false }
  if (!uncertain.value && !dirty()) return true
  if (closePromise) return closePromise
  closePromise = ElMessageBox.confirm(uncertain.value
    ? '服务器可能已经保存或提交此版本，离开不会撤销该操作。建议先核对保存结果或下载草稿备份；离开后请刷新目录，避免重复创建。'
    : '当前修改尚未保存到规则目录。离开会丢失未保存的编码、名称和用途说明；源码的本机备份不能替代保存草稿。要离开吗？', '离开公式编辑', {
    confirmButtonText: uncertain.value ? '仍然离开' : '放弃填写并离开', cancelButtonText: uncertain.value ? '返回核对' : '继续编辑', type: 'warning', closeOnClickModal: false
  }).then(() => !disposed).catch(() => false)
  try { return await closePromise } finally { closePromise = null }
}
async function open(row, newVersion = false) {
  if (disposed || busy.value || !await allowLeave() || disposed) return
  if ((!row || newVersion) && (!props.canManage || !props.catalogReady)) return
  form.value = row ? JSON.parse(JSON.stringify(row)) : { code: '', displayName: '', description: '' }
  form.value.description = String(form.value.description || '')
  newTemplate.value = unusedFunctionTemplate(props.rules, row?.ruleId)
  readOnly.value = row ? !newVersion && !editable(row) : !props.canManage
  if (newVersion) { form.value.versionId = null; form.value.status = 'draft'; form.value.version = null; form.value.reviewNote = '' }
  errors.value = {}; errorMessage.value = ''; notice.value = ''; uncertain.value = false; pendingWrite = null
  baseline = metadata(); editorKey.value++; editing.value = true
}
function finishClose() { editing.value = false; emit('refresh') }
async function close() { if (await allowLeave()) finishClose() }
function clearError(field) { if (errors.value[field]) { const next = { ...errors.value }; delete next[field]; errors.value = next } }
async function validate() {
  errors.value = validateRuleIdentity(form.value)
  if (errors.value.displayName) errors.value.displayName = '请填写公式名称，最多 120 个字符。'
  if (String(form.value.description || '').length > 2000) errors.value.description = '用途说明最多 2000 个字符。'
  if (!Object.keys(errors.value).length) return true
  errorMessage.value = '请修正标记的字段后再保存。'
  await nextTick(); root.value?.querySelector('[aria-invalid="true"]')?.focus()
  return false
}
function acceptSaved(sourceCode) {
  form.value.status = 'draft'; form.value.reviewNote = ''
  baseline = metadata(); playground.value?.markSaved(sourceCode, form.value.versionId)
}
async function save(submit) {
  if (busy.value || readOnly.value || uncertain.value || !props.canManage || !editing.value || disposed) return
  if (!await validate()) return
  // Validation yields to Vue; recheck before acquiring the write lock.
  if (busy.value || uncertain.value || disposed) return
  let data
  try { data = playground.value.getData() } catch (error) { errorMessage.value = error?.message || '编辑器尚未就绪，请稍后重试。'; return }
  saving.value = true; stage.value = '保存草稿'; errorMessage.value = ''; notice.value = ''
  const token = localStorage.getItem('token')
  controller = new AbortController()
  form.value.code = String(form.value.code).trim().toUpperCase(); form.value.displayName = String(form.value.displayName).trim(); form.value.description = String(form.value.description || '').trim()
  const payload = { code: form.value.code, displayName: form.value.displayName, description: form.value.description,
    ruleType: 'formula', scope: 'business_formula', severity: 'info', parameters: {}, testCases: [],
    expression: { engine: 'spreadjs-function', schemaVersion: 1, sourceCode: data.sourceCode } }
  pendingWrite = { payload, versionId: form.value.versionId, ruleId: form.value.ruleId, userId: Number(props.userId),
    knownIds: props.rules.map(row => Number(row.versionId)), stage: '保存草稿' }
  let saved = false
  try {
    if (form.value.versionId) await ruleRequest(signal => ruleCatalogApi.updateDraft(form.value.versionId, payload, signal), { signal: controller.signal })
    else {
      const created = await ruleRequest(signal => form.value.ruleId ? ruleCatalogApi.createVersion(form.value.ruleId, payload, signal) : ruleCatalogApi.create(payload, signal), { signal: controller.signal })
      if (!currentSession(token)) return
      if (!Number.isSafeInteger(created?.versionId) || created.versionId <= 0 || !Number.isSafeInteger(created?.ruleId) || created.ruleId <= 0) throw new Error('保存响应缺少版本信息')
      Object.assign(form.value, created)
    }
    if (!currentSession(token)) return
    pendingWrite.versionId = form.value.versionId; pendingWrite.ruleId = form.value.ruleId
    acceptSaved(data.sourceCode); saved = true
    if (submit) {
      stage.value = pendingWrite.stage = '验证公式'
      await ruleRequest(signal => ruleCatalogApi.test(form.value.versionId, [], signal), { signal: controller.signal })
      if (!currentSession(token)) return
      stage.value = pendingWrite.stage = '提交公式'
      const result = await ruleRequest(signal => ruleCatalogApi.submit(form.value.versionId, signal), { signal: controller.signal })
      if (!currentSession(token)) return
      if (!['published', 'pending_review'].includes(result?.status)) throw new Error('提交响应缺少状态信息')
      ElMessage.success(result.status === 'published' ? '自定义公式已发布，可在模板设计中添加' : '已提交系统管理员审批，发布后可添加到模板')
    } else ElMessage.success('草稿已保存，尚未发布')
    pendingWrite = null; finishClose()
  } catch (error) {
    if (!currentSession(token)) return
    const failure = ruleFailure(error, true)
    uncertain.value = Boolean(failure.uncertain)
    errorMessage.value = uncertain.value ? `${saved ? '草稿已保存。' : ''}尚未确认${stage.value}是否完成。输入已保留，请点击“核对保存结果”，暂勿重复提交。`
      : `${saved ? '草稿已保存；' : ''}${stage.value}未完成：${failure.message}`
  } finally { if (currentSession(token)) { saving.value = false; controller = null } }
}
async function reconcile() {
  if (busy.value || !uncertain.value || !pendingWrite || disposed) return
  checking.value = true; errorMessage.value = ''
  const token = localStorage.getItem('token'), attempt = pendingWrite
  controller = new AbortController()
  try {
    const rows = normalizeRules(await ruleRequest(signal => ruleCatalogApi.getCatalog(signal), { signal: controller.signal, timeoutMs: 15000 }))
    if (!currentSession(token)) return
    const matches = rows.filter(row => Number(row.createdBy) === attempt.userId && row.code === attempt.payload.code &&
      (attempt.versionId ? row.versionId === Number(attempt.versionId) : !attempt.knownIds.includes(row.versionId) && (!attempt.ruleId || row.ruleId === Number(attempt.ruleId))) &&
      row.expression?.sourceCode === attempt.payload.expression.sourceCode && String(row.description || '') === attempt.payload.description && row.displayName === attempt.payload.displayName)
    const match = matches.length === 1 ? matches[0] : null
    // A still-draft status cannot establish that a timed-out submit has finished.
    const resolved = match && (attempt.stage === '提交公式' ? ['published', 'pending_review'].includes(match.status) : ['draft', 'published', 'pending_review'].includes(match.status))
    if (!resolved) { errorMessage.value = '仍无法确认此版本的处理结果，暂不能再次保存或提交。请稍后重新核对，或下载草稿备份后返回列表检查。'; return }
    Object.assign(form.value, { ruleId: match.ruleId, versionId: match.versionId, version: match.version, status: match.status, reviewNote: match.reviewNote || '' })
    baseline = metadata(); playground.value?.markSaved(attempt.payload.expression.sourceCode, match.versionId)
    readOnly.value = !editable(match); uncertain.value = false; pendingWrite = null
    notice.value = `已确认 V${match.version}：${statusLabel(match.status)}。${match.status === 'draft' ? '草稿已保存，尚未发布；可继续编辑或提交。' : match.status === 'published' ? '已发布，可添加到模板，无需再次提交。' : '正在等待系统管理员审批，无需再次提交。'}`
    emit('refresh')
  } catch (error) { if (currentSession(token)) errorMessage.value = `核对未完成：${ruleFailure(error).message} 当前输入仍保留。` }
  finally { if (currentSession(token)) { checking.value = false; controller = null } }
}
function downloadJson(value, filename) {
  try {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch { ElMessage.error('下载失败，请重试；当前输入仍保留。') }
}
function downloadDraft() {
  downloadJson({ code: form.value.code, displayName: form.value.displayName, description: form.value.description,
    ruleId: form.value.ruleId, versionId: form.value.versionId, status: 'unconfirmed_local_backup',
    definition: { engine: 'spreadjs-function', sourceCode: pendingWrite?.payload.expression.sourceCode ?? playground.value?.getDraftSource?.() ?? '' } }, '自定义公式-本机草稿.json')
}
function download(row) { downloadJson({ code: row.code, displayName: row.displayName, version: row.version, definition: row.expression }, `${String(row.code || 'function').replace(/[^A-Za-z0-9_-]/g, '_')}-v${row.version}.json`) }
defineExpose({ open, allowLeave, finishClose })
</script>

<style scoped src="../styles/function-catalog-layout.css"></style>
