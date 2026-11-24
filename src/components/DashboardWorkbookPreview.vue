<template>
  <component v-if="preview" :is="preview" v-bind="$attrs" />
  <div v-else-if="error" class="workbook-module-error">
    <el-alert :title="error" type="error" :closable="false" show-icon />
    <el-button type="primary" @click="load">重试原表预览</el-button>
  </div>
  <p v-else class="workbook-module-status" role="status">正在加载原表预览…</p>
</template>

<script setup>
import { shallowRef, ref, onMounted, onBeforeUnmount } from 'vue'
defineOptions({ inheritAttrs: false })
const preview = shallowRef(null), error = ref('')
let disposed = false, attempt = 0, timer, pending = false
async function load() {
  if (disposed || pending) return
  const id = ++attempt
  pending = true; error.value = ''
  timer = setTimeout(() => {
    if (disposed || id !== attempt) return
    attempt++; pending = false
    error.value = '原表预览组件加载用时过长，请检查连接后重试。'
  }, 30000)
  try {
    const module = await import('./ReportResultPreview.vue')
    if (!disposed && id === attempt) preview.value = module.default
  } catch {
    if (!disposed && id === attempt) error.value = '原表预览组件加载失败，请重试；若仍失败，请刷新页面后重新打开详情。'
  } finally {
    if (id === attempt) { clearTimeout(timer); pending = false }
  }
}
onMounted(load)
onBeforeUnmount(() => { disposed = true; attempt++; clearTimeout(timer) })
</script>

<style scoped>
.workbook-module-status { margin: 4px 0 16px; font-size: 14px; line-height: 1.6; color: var(--el-text-color-regular); }
.workbook-module-error { display: grid; justify-items: start; gap: 12px; padding-block: 12px; --el-color-primary: var(--portal-focus, #941966); }
.workbook-module-error .el-alert { width: 100%; overflow-wrap: anywhere; }
.workbook-module-error .el-button { min-height: 44px; height: auto; white-space: normal; line-height: 1.5; }
.workbook-module-error .el-button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
</style>
