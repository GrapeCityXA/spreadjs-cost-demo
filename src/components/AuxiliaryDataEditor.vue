<template>
  <div class="remote-auxiliary-editor">
    <el-form-item label="接口地址（URL）" required :error="fieldErrors.url">
      <el-input ref="urlInput" :model-value="modelValue.url" placeholder="https://example.com/api/reference-data"
        aria-required="true" :aria-invalid="!!fieldErrors.url" :aria-describedby="`${id}-url-hint${fieldErrors.url ? ` ${id}-url-error` : ''}`"
        @update:model-value="update('url', $event)" />
      <p :id="`${id}-url-hint`" class="remote-hint remote-field-hint">填写以 http:// 或 https:// 开头的完整地址，仅支持 GET 请求。</p>
      <template #error="{ error: message }"><div :id="`${id}-url-error`" class="el-form-item__error" role="alert">{{ message }}</div></template>
    </el-form-item>
    <el-form-item label="响应数据路径（可选）" :error="fieldErrors.dataPath">
      <div class="remote-config-row">
        <el-input ref="pathInput" :model-value="modelValue.dataPath" placeholder="例如：data.items"
          :aria-invalid="!!fieldErrors.dataPath" :aria-describedby="`${id}-path-hint${fieldErrors.dataPath ? ` ${id}-path-error` : ''}`"
          @update:model-value="update('dataPath', $event)" />
        <p :id="`${id}-path-hint`" class="remote-hint remote-field-hint">接口直接返回数组时留空；记录在 data 的 items 数组中时，填写 data.items。</p>
        <el-button :loading="loading" @click="preview">{{ error ? '重新读取并预览' : '读取并预览' }}</el-button>
      </div>
      <template #error="{ error: message }"><div :id="`${id}-path-error`" class="el-form-item__error" role="alert">{{ message }}</div></template>
    </el-form-item>
    <p class="remote-hint">预览仅供核对，不会保存模板。接口需允许浏览器跨域读取；本系统的登录令牌不会发送到该接口。</p>
    <el-alert v-if="error" title="数据预览失败" :description="error" type="error" :closable="false" />
    <p v-if="error" class="remote-hint remote-recovery">确认地址可访问、数据路径正确后，点击“重新读取并预览”。如受跨域限制，请联系接口提供方处理。</p>
    <p v-if="loading" class="remote-status" role="status">正在读取接口数据，最多等待 15 秒…</p>
    <p v-else-if="result" class="remote-status" role="status">
      <template v-if="result.rowCount === 0">未读取到可展示的记录。请确认接口有数据，并检查数据路径后重新读取。</template>
      <template v-else>已读取 {{ result.rowCount }} 条记录 · {{ result.columnCount }} 列，以下为只读预览。</template>
    </p>
    <div v-show="visible" ref="host" class="remote-preview" :aria-busy="loading" aria-label="辅助表数据只读预览"></div>
  </div>
</template>
<script setup>
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import GC from '@grapecity-software/spread-sheets'
import { bindAuxiliarySheet, disposeAuxiliaryData, normalizeAuxiliaryBinding } from '@/template/auxiliaryDataBinding'

const props = defineProps({ modelValue: { type: Object, required: true } })
const emit = defineEmits(['update:modelValue'])
const id = useId()
const host = ref(null), urlInput = ref(null), pathInput = ref(null)
const loading = ref(false), visible = ref(false), error = ref(''), result = ref(null), fieldErrors = ref({})
let session = null, generation = 0

function release(value) {
  if (!value || value.released) return
  value.released = true
  if (value.book) { disposeAuxiliaryData(value.book); value.book.destroy() }
  value.element.remove()
}
function destroy() {
  const previous = session
  session = null
  if (!previous) return
  previous.element.remove()
  if (previous.book) disposeAuxiliaryData(previous.book)
  // Detach now; a pending DataManager callback must settle before SDK destruction.
  if (!previous.pending) release(previous)
}
function reset() {
  generation++
  destroy()
  visible.value = false
  loading.value = false
  result.value = null
  error.value = ''
  fieldErrors.value = {}
}
function update(key, value) {
  reset()
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
watch(() => [props.modelValue.url, props.modelValue.dataPath], reset, { flush: 'sync' })

async function preview() {
  if (loading.value) return
  reset()
  const current = generation
  let config
  try { config = normalizeAuxiliaryBinding(props.modelValue) }
  catch (failure) {
    const field = failure.field === 'dataPath' ? 'dataPath' : 'url'
    fieldErrors.value = { [field]: failure.message }
    await nextTick()
    if (current === generation) (field === 'url' ? urlInput : pathInput).value?.focus()
    return
  }
  loading.value = true
  visible.value = true
  let owned
  try {
    await nextTick()
    if (current !== generation) return
    if (!host.value) throw new Error('预览区域尚未准备好，请重新读取')
    const element = document.createElement('div')
    element.style.cssText = 'width:100%;height:100%'
    owned = session = { element, book: null, pending: true, released: false }
    host.value.appendChild(element)
    const book = owned.book = new GC.Spread.Sheets.Workbook(element, { sheetCount: 1 })
    const value = await bindAuxiliarySheet(book, book.getActiveSheet(), { dataBinding: config, rowCount: 20, columnCount: 10 }, 0)
    if (current !== generation) return
    if (!value) throw new Error('预览已中断，请重新读取')
    result.value = value
    if (value.rowCount === 0) { visible.value = false; destroy() }
    else book.refresh()
  } catch (failure) {
    if (current === generation) {
      result.value = null
      error.value = failure?.message || '未能读取接口数据，请检查接口连接。'
      visible.value = false
      destroy()
    }
  } finally {
    if (owned) {
      owned.pending = false
      if (session !== owned) release(owned)
    }
    if (current === generation) loading.value = false
  }
}
onBeforeUnmount(reset)
</script>
<style scoped>
.remote-auxiliary-editor { min-width: 0; }
.remote-config-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'input action' 'hint hint'; align-items: start; gap: 6px 12px; width: 100%; min-width: 0; }
.remote-config-row > .el-input { grid-area: input; }
.remote-config-row > .el-button { grid-area: action; align-self: stretch; height: auto; margin: 0; }
.remote-config-row > .remote-field-hint { grid-area: hint; margin: 0; }
.remote-hint { font-size: 12px; color: var(--portal-muted, #6d5a65); line-height: 1.7; margin: 0 0 12px; }
.remote-field-hint { margin: 6px 0 0; width: 100%; overflow-wrap: anywhere; }
.remote-recovery { margin-top: 8px; }
.remote-preview { height: 260px; border: 1px solid var(--portal-line, #e8d9e1); border-radius: 4px; margin-top: 8px; }
.remote-status { margin: 16px 0 0; padding-top: 12px; border-top: 1px solid var(--portal-line, #e8d9e1); font-size: 14px; color: var(--portal-ink, #2c1b26); line-height: 1.6; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.remote-auxiliary-editor :deep(.el-alert__title), .remote-auxiliary-editor :deep(.el-alert__description), .el-form-item__error { overflow-wrap: anywhere; }
@media (max-width: 600px) {
  .remote-config-row { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'input' 'hint' 'action'; }
  .remote-config-row > .el-button { margin-top: 6px; min-height: 44px; }
}
</style>
