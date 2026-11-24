<template>
  <section class="source-tools" aria-label="公式模板设置">
    <p class="source-intro">只需填写名称，并在 <code>evaluate</code> 中编写计算逻辑。基础结构已准备好。</p>
    <el-form label-position="top" class="source-names" :disabled="disabled || busy">
      <el-form-item label="函数名（公式中使用）">
        <el-input v-model="functionName" maxlength="64" placeholder="例如 MY_AMOUNT" @input="functionName = functionName.toUpperCase()" />
      </el-form-item>
      <el-form-item label="class 名（代码中的类）">
        <el-input v-model="className" maxlength="64" placeholder="例如 SalesAmount" />
      </el-form-item>
      <el-button :disabled="disabled || !namesChanged" :loading="busy" @click="applyNames">应用名称</el-button>
    </el-form>
    <p class="source-hint">{{ namesChanged ? `应用后同步更新代码；类名变化时类型名设为 CustomFunctions.${className || '类名'}。` : `序列化类型：${info.typeName || '等待识别'}。函数名和类名不能与其他公式重复。` }}</p>
    <div class="source-methods">
      <label for="function-method-select">添加可选方法</label>
      <select id="function-method-select" v-model="selectedMethod" aria-label="添加可选方法" :disabled="disabled || busy || !sourceCurrent" @change="addMethod($event.target.value)">
        <option disabled value="">{{ syncState === 'checking' ? '正在同步代码…' : syncState === 'error' ? '代码检查未完成' : '选择需要的方法' }}</option>
        <option v-for="item in methodOptions" :key="item.value" :value="item.value" :disabled="info.methods?.includes(item.value)">{{ item.label }} · {{ item.value }}{{ info.methods?.includes(item.value) ? '（已添加）' : '' }}</option>
      </select>
      <span class="source-hint">已默认包含 constructor、evaluate、toJSON、fromJSON</span>
    </div>
    <p v-if="methodHint" class="source-hint" role="status">{{ methodHint }}</p>
    <p v-if="syncState === 'checking'" class="source-hint" role="status">正在根据当前代码更新方法列表…</p>
    <p v-if="error || info.conflict" class="source-error" role="alert">{{ error || info.conflict }}</p>
    <p v-else-if="namesChanged" class="source-hint" role="status">名称尚未应用，请点击“应用名称”后保存。</p>
    <el-button v-if="syncState === 'error'" :disabled="busy" @click="inspect">重新同步方法列表</el-button>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { functionPlaygroundApi } from '@/api'

const props = defineProps({ code: String, ruleId: Number, disabled: Boolean })
const emit = defineEmits(['update', 'identity'])
const info = ref({}), functionName = ref(''), className = ref(''), selectedMethod = ref(''), error = ref(''), methodHint = ref(''), busy = ref(false)
const syncState = ref('checking')
const sourceCurrent = computed(() => syncState.value === 'ready' && info.value.code === props.code && Boolean(info.value.className))
const namesChanged = computed(() => functionName.value !== (info.value.functionName || '') || className.value !== (info.value.className || ''))
const methodOptions = [
  { value: 'description', label: '函数与参数说明', hint: '已添加说明模板，可填写函数用途和参数名称。' },
  { value: 'acceptsArray', label: '接收数组', hint: '参数索引从 0 开始；按需返回 true，让 evaluate 接收数组。' },
  { value: 'acceptsError', label: '自行处理错误值', hint: '返回 true 后，需要在 evaluate 中处理错误值。' },
  { value: 'acceptsMissingArgument', label: '处理缺失参数', hint: '返回 true 后，需要在 evaluate 中处理缺失参数；参数默认值仍会自动识别。' },
  { value: 'isVolatile', label: '随单元格变化重算', hint: '仅在确有需要时返回 true；工作簿任意单元格变化都会触发重算。' },
  { value: 'acceptsReference', label: '接收引用（仅试算）', hint: 'SpreadJS 支持引用对象，但当前平台发布流程不支持此能力。默认 false。' },
  { value: 'isContextSensitive', label: '求值上下文（仅试算）', hint: '改为 true 时需将 context 作为 evaluate 第一个参数。当前平台发布流程不支持此能力。' },
  { value: 'supportCalcWorker', label: 'Worker 执行（暂未启用）', hint: '当前平台未启用 Calc Worker。不能仅改成 true；还需插件及配置，计算逻辑须自包含且不能依赖实例属性或工作表 API。' },
]
let timer, requestTimer, controller, disposed = false, sequence = 0
function invalidateMethods() {
  // Never present a previous source snapshot as the current class structure.
  info.value = { ...info.value, methods: [], conflict: '' }
  syncState.value = 'checking'; selectedMethod.value = ''; methodHint.value = ''; error.value = ''
}
function accept(result) {
  info.value = result
  syncState.value = 'ready'
  functionName.value = result.functionName || ''; className.value = result.className || ''
  emit('identity', result)
}
async function inspect() {
  if (disposed) return
  clearTimeout(timer); clearTimeout(requestTimer)
  const code = props.code, request = ++sequence
  const startingName = functionName.value, startingClass = className.value
  controller?.abort(); controller = new AbortController()
  const activeController = controller
  invalidateMethods()
  let timedOut = false
  requestTimer = setTimeout(() => { timedOut = true; activeController.abort() }, 10000)
  try {
    const result = await functionPlaygroundApi.sourceTools({ code, ruleId: props.ruleId }, controller.signal)
    if (disposed || request !== sequence || code !== props.code) return
    if (startingName === functionName.value && startingClass === className.value) accept(result)
    else { info.value = result; syncState.value = 'ready'; emit('identity', result) }
    error.value = ''
  } catch (cause) {
    if (!disposed && request === sequence) {
      syncState.value = 'error'
      error.value = timedOut ? '方法列表同步超时，请重试。当前代码已保留。' : `模板检查：${cause.message}。方法列表将在代码修正后自动同步。`
    }
  } finally { if (request === sequence) { clearTimeout(requestTimer); controller = null } }
}
watch(() => props.code, code => {
  ++sequence; controller?.abort(); clearTimeout(timer); clearTimeout(requestTimer)
  // An insertion response already describes this exact source; manual edits,
  // deletions, undo and redo all invalidate it and trigger the same inspection.
  if (syncState.value === 'ready' && info.value.code === code) return
  invalidateMethods()
  timer = setTimeout(inspect, 200)
}, { immediate: true, flush: 'sync' })
async function change(changes) {
  if (props.disabled || busy.value) return false
  clearTimeout(timer); clearTimeout(requestTimer); controller?.abort(); ++sequence
  const code = props.code
  busy.value = true; error.value = ''
  try {
    const result = await functionPlaygroundApi.sourceTools({ code, changes, ruleId: props.ruleId })
    if (disposed || props.disabled) return false
    if (props.code !== code) throw new Error('代码已变化，请重新应用本次修改')
    accept(result); emit('update', result.code)
    return true
  } catch (cause) { if (!disposed) error.value = cause.message; return false }
  finally { busy.value = false }
}
async function applyNames() {
  if (await change({ functionName: functionName.value.trim().toUpperCase(), className: className.value.trim() })) {
    methodHint.value = '名称已写入代码。试算区已有公式请同步更新函数名，或应用代码后点击“填入当前单元格”使用新示例。'
  }
}
async function addMethod(method) {
  selectedMethod.value = ''
  if (!sourceCurrent.value) return
  if (namesChanged.value) { error.value = '请先应用名称，再添加可选方法'; return }
  if (await change({ method })) methodHint.value = methodOptions.find(item => item.value === method)?.hint || ''
}
function assertReady() {
  if (busy.value) throw new Error('正在更新模板，请稍候再保存')
  if (namesChanged.value) throw new Error('请先点击“应用名称”，将名称写入代码')
  if (info.value.code === props.code && info.value.conflict) throw new Error(info.value.conflict)
}
onBeforeUnmount(() => { disposed = true; ++sequence; clearTimeout(timer); clearTimeout(requestTimer); controller?.abort() })
defineExpose({ assertReady })
</script>

<style scoped>
.source-tools { margin-block: 16px; padding-block: 16px; border-block: 1px solid var(--portal-line, #e8d9e1); }
.source-intro { margin: 0 0 16px; line-height: 1.6; }
.source-names { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 12px; align-items: end; }
.source-names :deep(.el-form-item) { margin: 0; }
.source-names :deep(.el-button) { margin: 0; }
.source-hint { color: var(--portal-muted, #6d5a65); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; margin-block: 8px; }
.source-methods { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 16px; }
.source-methods select { width: 340px; min-width: 0; max-width: 100%; min-height: 44px; padding: 8px; border: 1px solid var(--input-line, #dcdfe6); border-radius: 4px; color: var(--portal-ink, #2c1b26); background: var(--portal-surface, #fff); font: inherit; }
.source-methods select:focus-visible { outline: 2px solid var(--portal-focus, #941966); outline-offset: 2px; }
.source-methods select:disabled { cursor: not-allowed; color: var(--portal-muted, #6d5a65); background: var(--portal-paper, #f8f3f6); }
.source-error { color: var(--error-text, #b42318); margin-bottom: 0; overflow-wrap: anywhere; }
code { font-family: var(--playground-code-font); }
@media (max-width: 700px) { .source-names { grid-template-columns: 1fr; } .source-methods { align-items: stretch; } .source-methods label, .source-methods select { width: 100%; } .source-methods select { font-size: 16px; } }
</style>
