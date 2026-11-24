<template>
  <main class="finalized-list portal-workbench">
    <header class="page-head"><div><h1>已定稿查看</h1><p>{{ showcase ? '按期间查看已审核、已定稿的历史数据。' : '按组织和期间查看已审核、已定稿的历史数据。' }}</p></div><el-button :loading="loading" @click="load">刷新</el-button></header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon><el-button @click="load">重新加载</el-button></el-alert>
    <el-table v-loading="loading" :data="tasks" row-key="id" class="finalized-table" empty-text="当前没有可查看的已定稿数据">
      <el-table-column prop="periodCode" label="期间" min-width="110" /><el-table-column v-if="!showcase" prop="organizationName" label="组织" min-width="180" show-overflow-tooltip /><el-table-column prop="reportTypeName" label="报表类型" min-width="180" show-overflow-tooltip />
      <el-table-column label="提交时间" min-width="170"><template #default="{ row }">{{ formatDate(row.submittedAt) }}</template></el-table-column><el-table-column label="定稿时间" min-width="170"><template #default="{ row }">{{ formatDate(row.finalizedAt) }}</template></el-table-column><el-table-column label="修订" width="90"><template #default="{ row }">R{{ row.revisionNumber || '—' }}</template></el-table-column>
      <el-table-column label="操作" fixed="right" width="210"><template #default="{ row }"><el-button link type="primary" @click="view(row)">查看</el-button><el-button link type="primary" :loading="busy === `${row.id}:xlsx`" @click="download(row, 'finalized_xlsx')">下载 XLSX</el-button><el-button link type="primary" :loading="busy === `${row.id}:pdf`" @click="download(row, 'finalized_pdf')">PDF</el-button></template></el-table-column>
    </el-table>
  </main>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { collaborationApi } from '@/api'
import { SHOWCASE } from '@/config/showcase'
const showcase = SHOWCASE
const router = useRouter(), tasks = ref([]), loading = ref(false), error = ref(''), busy = ref('')
let disposed = false, controller
function formatDate(value) {
  if (!value) return '—'
  const raw = String(value)
  const date = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? new Date(raw.replace(' ', 'T') + 'Z')
    : new Date(raw)
  return Number.isNaN(date.getTime()) ? '时间不可用' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}
async function load() { controller?.abort(); controller = new AbortController(); loading.value = true; error.value = ''; try { const response = await collaborationApi.getFinalizedTasks({ signal: controller.signal }); if (!disposed && !controller.signal.aborted) tasks.value = Array.isArray(response.tasks) ? response.tasks : [] } catch (e) { if (!disposed && e.name !== 'AbortError') error.value = e.message || '已定稿数据加载失败，请重试。' } finally { if (!disposed) loading.value = false } }
function view(row) { router.push({ name: 'FinalizedDataWorkbench', params: { taskId: row.id, revisionId: row.revisionId } }) }
async function download(row, type) { if (!row.revisionId) return; busy.value = `${row.id}:${type === 'finalized_pdf' ? 'pdf' : 'xlsx'}`; try { const blob = await collaborationApi.downloadFinalizedArtifact(row.id, row.revisionId, type); const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `${showcase ? '' : `${row.organizationName || '组织'}-`}${row.periodCode}-${type === 'finalized_pdf' ? '定稿报表.pdf' : '定稿报表.xlsx'}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) } catch (e) { error.value = e.message || '下载失败，请重试。' } finally { busy.value = '' } }
onMounted(load); onBeforeUnmount(() => { disposed = true; controller?.abort() })
</script>

<style scoped>
.finalized-list{min-width:0;padding:24px;color:var(--portal-ink,#2c1b26)}.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--portal-line,#e8d9e1)}.page-head h1{margin:0;font-size:26px}.page-head p{margin:8px 0 0;color:var(--portal-muted,#6d5a65);font-size:14px}.finalized-table{width:100%;border:1px solid var(--portal-line,#e8d9e1);border-radius:8px}.finalized-table :deep(.el-table__inner-wrapper::before){display:none}@media(max-width:900px){.finalized-list{padding:16px 12px 24px}.finalized-table :deep(.el-table__cell){padding:9px 0}.finalized-table :deep(.cell){white-space:nowrap}}
</style>
