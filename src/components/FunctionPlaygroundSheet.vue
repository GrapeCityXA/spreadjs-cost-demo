<template>
  <div class="function-sheet">
    <div class="sheet-actions">
      <span class="sheet-identity"><template v-if="functionName"><span>已注册：</span><code>{{ functionName }}</code></template><template v-else>SpreadJS 公式试算</template></span>
      <el-button size="small" :type="busy ? 'default' : 'primary'" @click="busy ? stop() : ready ? applyCode() : initializeSheet()">{{ busy ? '停止试算' : ready ? '应用代码并计算' : '重试初始化' }}</el-button>
    </div>
    <p v-if="ready && appliedCode !== code" class="sheet-state" role="status">代码已修改，点击“应用代码并计算”更新表格中的函数。</p>
    <p v-else class="sheet-state" role="status">{{ message }}</p>
    <div ref="host" class="formula-sheet-host" aria-label="自定义公式试算表"></div>
    <p v-if="error" class="sheet-error" role="alert">{{ error }}</p>
    <p v-if="recoveryWarning" class="sheet-error" role="status">{{ recoveryWarning }}</p>
    <div v-if="argumentInfo" class="signature-info"><code>evaluate({{ argumentInfo.parameters.map(param => param.label).join(', ') }})</code><span>{{ argumentInfo.rest ? `可变参数，${argumentInfo.minArgs}–${argumentInfo.maxArgs} 个` : argumentInfo.minArgs === argumentInfo.maxArgs ? `${argumentInfo.maxArgs} 个参数` : `${argumentInfo.minArgs}–${argumentInfo.maxArgs} 个参数（含默认值）` }}</span></div>
    <div v-if="exampleFormula" class="example-formula"><code>{{ exampleFormula }}</code><el-button size="small" link type="primary" :disabled="busy || appliedCode !== code" @click="insertExample">填入当前单元格</el-button></div>
    <p class="sheet-help">双击单元格或直接键入公式，按 <kbd>Enter</kbd> 计算；参数可填写常量或单元格引用。参数数量按 <code>evaluate()</code> 自动设置。</p>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import GC from '@grapecity-software/spread-sheets'
import '@/utils/spreadjsLicense'
import '@grapecity-software/spread-sheets/styles/gc.spread.sheets.excel2013white.css'
import { observeWorkbookLayout } from '@/utils/observeWorkbookLayout'
import { functionPlaygroundApi } from '@/api'
import { normalizeTrialCells } from './functionPlaygroundState'

const props = defineProps({ code: String, initialCells: Array })
const emit = defineEmits(['changed'])
const host = ref(null), busy = ref(false), appliedCode = ref(''), functionName = ref(''), error = ref(''), message = ref('正在准备试算表…')
const argumentInfo = ref(null), exampleFormula = ref(''), ready = ref(false), recoveryWarning = ref('')
const recoveredCells = new Set()
let initializeExample = props.initialCells == null
let book, stopLayout, touchInput, controller, timer, currentRun = Promise.resolve(), disposed = false, painting = false, editing = false, dirty = false, revision = 0
const inputs = new Map((normalizeTrialCells(props.initialCells) || []).map(cell => [`${cell.row}:${cell.col}`, cell])), pendingCells = new Set()
let renderedPositions = new Set()
let renderedValuesKey = null
let calculationDueAt = 0
function updateRecoveryWarning() { recoveryWarning.value = recoveredCells.size ? `${[...recoveredCells].map(key => { const [row, col] = key.split(':').map(Number); return `${String.fromCharCode(65 + col)}${row + 1}` }).join('、')} 的公式无法恢复，已按文本保留。请修改这些单元格，再输入正确公式。` : '' }
function cells() { return [...inputs.values()].map(item => ({ ...item })) }
function readChanges() {
  if (!pendingCells.size) return
  const sheet = book.getActiveSheet()
  for (const key of pendingCells) {
    const [row, col] = key.split(':').map(Number)
    recoveredCells.delete(key)
    const formula = sheet.getFormula(row, col), value = sheet.getValue(row, col)
    if (formula) inputs.set(key, { row, col, formula })
    else if (value != null && value !== '') inputs.set(key, { row, col, value })
    else inputs.delete(key)
  }
  pendingCells.clear()
  updateRecoveryWarning()
  emit('changed', cells())
}
function schedule() {
  clearTimeout(timer)
  // Preserve the input debounce deadline while an earlier request is in flight.
  if (!disposed && ready.value && dirty && !editing && !busy.value) timer = setTimeout(() => calculate(), Math.max(0, calculationDueAt - Date.now()))
}
function bindSheet() {
  const sheet = book.getActiveSheet()
  sheet.bind(GC.Spread.Sheets.Events.CellChanged, (_, args) => {
    if (painting || !['value', 'formula'].includes(args.propertyName) || args.row < 0 || args.col < 0) return
    renderedValuesKey = null
    pendingCells.add(`${args.row}:${args.col}`); revision++; dirty = true; calculationDueAt = Date.now() + 350; message.value = '单元格已修改，等待计算…'; schedule()
  })
  sheet.bind(GC.Spread.Sheets.Events.EditStarting, () => { editing = true; clearTimeout(timer) })
  sheet.bind(GC.Spread.Sheets.Events.EditEnded, () => { editing = false; readChanges(); schedule() })
}
function validateResult(result) {
  if (!result || typeof result !== 'object') throw new Error('服务器未返回有效试算结果，请重试。')
  if (result.status) throw new Error(`${result.status}：${result.error || '试算未完成'}`)
  const info = result.argumentInfo
  if (!Array.isArray(result.values) || result.values.length > 300 || !Array.isArray(result.errors) || result.errors.some(item => typeof item !== 'string') ||
      typeof result.functionName !== 'string' || typeof result.exampleFormula !== 'string' || !Number.isFinite(result.durationMs) ||
      !info || !Array.isArray(info.parameters) || info.parameters.some(param => !param || typeof param.label !== 'string') ||
      !Number.isInteger(info.minArgs) || !Number.isInteger(info.maxArgs)) throw new Error('服务器返回的试算结果不完整，请重试。')
  const positions = new Set()
  for (const cell of result.values) {
    if (!cell || !Number.isInteger(cell.row) || !Number.isInteger(cell.col) || cell.row < 0 || cell.row >= 30 || cell.col < 0 || cell.col >= 10 ||
        !(cell.value == null || typeof cell.value === 'string' || typeof cell.value === 'boolean' || (typeof cell.value === 'number' && Number.isFinite(cell.value)))) throw new Error('服务器返回了无效的单元格结果，请重试。')
    const key = `${cell.row}:${cell.col}`
    if (positions.has(key)) throw new Error('服务器返回了重复的单元格结果，请重试。')
    positions.add(key)
  }
  if (result.seededCell && (result.seededCell.row !== 0 || result.seededCell.col !== 0 || typeof result.seededCell.formula !== 'string' || !result.seededCell.formula)) throw new Error('服务器返回的示例公式无效，请重试。')
}
function replaceValues(values, seededCell) {
  const valuesKey = JSON.stringify(values)
  if (valuesKey === renderedValuesKey && !seededCell) return
  renderedValuesKey = null
  const sheet = book.getActiveSheet(), next = new Map(values.map(cell => [`${cell.row}:${cell.col}`, cell]))
  painting = true
  sheet.suspendPaint()
  try {
    if (seededCell) sheet.setFormula(0, 0, seededCell.formula)
    // Update cached results in place. ignoreRecalc preserves formula text and the
    // worksheet's undo history; executable user code stays in the isolated engine.
    for (const key of new Set([...renderedPositions, ...next.keys()])) {
      const [row, col] = key.split(':').map(Number), value = next.get(key)?.value ?? null
      if (!Object.is(sheet.getValue(row, col), value)) sheet.setValue(row, col, value, GC.Spread.Sheets.SheetArea.viewport, true)
    }
    renderedPositions = new Set(next.keys())
    renderedValuesKey = valuesKey
  } finally { try { sheet.resumePaint() } finally { painting = false } }
}
async function performCalculation() {
  if (disposed || !ready.value || busy.value || editing || !dirty) return
  readChanges(); dirty = false; busy.value = true; error.value = ''; message.value = '正在计算公式…'
  const version = revision, code = appliedCode.value
  controller = new AbortController()
  const requestController = controller
  let timedOut = false
  const requestTimeout = setTimeout(() => { timedOut = true; requestController.abort() }, 30000)
  let onAbort
  const aborted = new Promise((_, reject) => { onAbort = () => reject(Object.assign(new Error('试算已停止'), { name: 'AbortError' })); requestController.signal.addEventListener('abort', onAbort, { once: true }) })
  try {
    const result = await Promise.race([functionPlaygroundApi.run({ mode: 'workbook', code, cells: cells(), initializeExample }, requestController.signal), aborted])
    if (disposed || requestController.signal.aborted) return
    if (version !== revision || code !== appliedCode.value || editing) { dirty = true; return }
    validateResult(result)
    replaceValues(result.values, result.seededCell)
    if (result.seededCell) { inputs.set('0:0', { row: 0, col: 0, formula: result.seededCell.formula }); emit('changed', cells()) }
    initializeExample = false
    argumentInfo.value = result.argumentInfo; exampleFormula.value = result.exampleFormula
    functionName.value = result.functionName
    error.value = result.errors.join('；')
    message.value = error.value ? '公式执行有错误，请检查代码。' : `计算完成 · ${result.durationMs.toFixed(2)} ms`
  } catch (cause) {
    if (!disposed && (timedOut || (!requestController.signal.aborted && version === revision && code === appliedCode.value))) {
      error.value = timedOut ? '试算超时，输入已保留。请点击“应用代码并计算”重试。' : `试算未完成：${cause?.message || '无法获取计算结果'}。输入已保留，请重试。`
      message.value = '表格可能仍含旧结果，请重新计算'
      functionName.value = ''; argumentInfo.value = null; exampleFormula.value = ''
    }
  } finally {
    clearTimeout(requestTimeout); requestController.signal.removeEventListener('abort', onAbort)
    busy.value = false; controller = null; schedule()
  }
}
function calculate() { if (!busy.value) currentRun = performCalculation(); return currentRun }
function applyCode() {
  if (disposed || !ready.value) return
  // Reuse the in-flight run only when it already represents these exact inputs.
  // Idle explicit runs always recalculate, including volatile custom functions.
  if (busy.value && !controller?.signal.aborted && !dirty && !pendingCells.size && appliedCode.value === props.code) return currentRun
  appliedCode.value = props.code; revision++; dirty = true; calculationDueAt = Date.now(); schedule()
}
function insertExample() {
  if (!ready.value || busy.value || appliedCode.value !== props.code) return
  try {
    const sheet = book.getActiveSheet()
    sheet.setFormula(sheet.getActiveRowIndex(), sheet.getActiveColumnIndex(), exampleFormula.value)
  } catch { error.value = '示例公式未能填入，原输入已保留。请检查公式或换一个单元格重试。' }
}
function stop() {
  dirty = false; revision++; clearTimeout(timer); controller?.abort()
  if (!disposed) { readChanges(); error.value = ''; message.value = '试算已停止，输入已保留。点击“应用代码并计算”可重新试算。' }
}
function releaseSheet() {
  ready.value = false
  stopLayout?.(); stopLayout = null
  touchInput?.removeEventListener('change', adaptTouchLayout); touchInput = null
  const previous = book; book = null; previous?.destroy()
}
function adaptTouchLayout() { if (book) { book.options.useTouchLayout = touchInput.matches; book.refresh() } }
function initializeSheet() {
  if (disposed || ready.value) return
  error.value = ''; message.value = '正在准备试算表…'
  try {
    book = new GC.Spread.Sheets.Workbook(host.value, { sheetCount: 1, enableAccessibility: true, calculationMode: GC.Spread.Sheets.CalculationMode.manual, newTabVisible: false, tabEditable: false, allowSheetReorder: false, allowContextMenu: false })
    // All formulas are evaluated by the isolated engine, never in this view.
    book.suspendCalcService()
    touchInput = window.matchMedia('(any-pointer: coarse)')
    adaptTouchLayout(); touchInput.addEventListener('change', adaptTouchLayout)
    const sheet = book.getActiveSheet(); sheet.name('试算'); sheet.setRowCount(30); sheet.setColumnCount(10)
    for (const [key, cell] of inputs) {
      if (cell.formula) {
        try { sheet.setFormula(cell.row, cell.col, cell.formula) }
        catch {
          const text = cell.formula.startsWith('=') ? cell.formula : `=${cell.formula}`
          sheet.setValue(cell.row, cell.col, text)
          inputs.set(key, { row: cell.row, col: cell.col, value: text }); recoveredCells.add(key)
        }
      } else sheet.setValue(cell.row, cell.col, cell.value)
    }
    updateRecoveryWarning()
    sheet.setActiveCell(0, 0); bindSheet()
    stopLayout = observeWorkbookLayout(host.value, book)
    ready.value = true; emit('changed', cells()); applyCode()
  } catch {
    releaseSheet()
    error.value = '试算表初始化失败，草稿输入已保留。请点击“重试初始化”。'
    message.value = '试算表尚未就绪'
  }
}
onMounted(initializeSheet)
onBeforeUnmount(() => {
  if (pendingCells.size) readChanges()
  disposed = true; stop(); releaseSheet()
})
defineExpose({ applyCode })
</script>

<style scoped>
.function-sheet { display:flex; flex-direction:column; flex:1; min-width:0; }
.signature-info,.example-formula { padding:12px 12px 0; display:flex; align-items:center; gap:8px 12px; flex-wrap:wrap; font-size:14px; line-height:1.6; }
.signature-info code,.example-formula code { font-family:var(--playground-code-font,Consolas,monospace); font-size:14px; white-space:pre-wrap; overflow-wrap:anywhere; min-width:0; max-width:100%; }
.signature-info { align-items:baseline; justify-content:space-between; }
.signature-info span { color:var(--portal-muted,#6d5a65); overflow-wrap:anywhere; }
.example-formula { justify-content:space-between; padding-block:8px; margin:8px 12px 0; padding-inline:0; border-block:1px solid var(--portal-line,#e8d9e1); }
.example-formula code { flex:1 1 15ch; }
.sheet-actions { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:8px; padding:12px; }
.sheet-identity { display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 4px; min-width:0; max-width:100%; font-size:14px; color:var(--portal-muted,#6d5a65); overflow-wrap:anywhere; }
.sheet-identity code { min-width:0; max-width:100%; color:var(--portal-ink,#2c1b26); font:600 14px/1.6 var(--playground-code-font,Consolas,monospace); overflow-wrap:anywhere; }
.sheet-actions .el-button { flex-shrink:0; min-width:132px; }
.sheet-state { min-block-size:1.6em; margin:0; padding:0 12px 12px; color:var(--portal-muted,#6d5a65); font-size:14px; line-height:1.6; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.formula-sheet-host { height:clamp(16rem,50vh,28rem); height:clamp(16rem,50svh,28rem); flex:none; min-width:0; border-block:1px solid var(--portal-line,#e8d9e1); }
.sheet-help { font-size:14px; color:var(--portal-muted,#6d5a65); line-height:1.8; padding:12px; margin:0; overflow-wrap:anywhere; }
.sheet-help code,.sheet-help kbd { font-family:var(--playground-code-font,Consolas,monospace); font-size:inherit; }
.sheet-error { color:#b42318; background:#fff5f4; border:1px solid #e8b4ae; font-size:14px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; padding:8px 12px; margin:8px 12px; border-radius:4px; }
@container function-playground (max-width:420px) {
  .sheet-identity { flex-basis:100%; }
  .sheet-actions .el-button { width:100%; }
  .example-formula { justify-content:flex-end; }
  .example-formula code { flex-basis:100%; }
}
@container function-playground (min-width:960px) {
  .function-sheet { min-height:580px; }
  .formula-sheet-host { height:410px; min-height:350px; flex:1; }
  .signature-info,.example-formula,.sheet-identity,.sheet-state,.sheet-help { font-size:12px; }
}
</style>
