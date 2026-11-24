<template>
  <main class="finalized-detail portal-workbench">
    <header class="page-head">
      <div class="title-block"><div class="title-line"><el-button link class="back-button" @click="goBack">返回列表</el-button><h1>已定稿数据</h1></div><p v-if="detail">{{ showcase ? `${detail.task.reportTypeName} · ${detail.task.periodCode}` : `${detail.task.organizationName} · ${detail.task.reportTypeName} · ${detail.task.periodCode}` }}</p></div>
      <div class="head-actions"><el-button :disabled="!detail || loadingDetail" @click="download('finalized_xlsx')">下载 XLSX</el-button><el-button :disabled="!detail || loadingDetail" @click="download('finalized_pdf')">下载 PDF</el-button><el-button type="primary" :disabled="!detail || loadingDetail" @click="generationOpen = true">生成报表</el-button></div>
    </header>
    <div class="feedback" aria-live="polite"><p v-if="loadingDetail" role="status">正在读取定稿工作簿…</p><el-alert v-else-if="detailError" :title="detailError" type="error" :closable="false" show-icon><el-button @click="loadRevision">重新读取</el-button></el-alert></div>
    <section v-if="detail" class="detail-panel">
      <div class="revision-switcher"><label for="finalized-revision">查看修订</label><el-select id="finalized-revision" v-model="activeRevisionId" :disabled="loadingDetail" @change="loadRevision"><el-option v-for="revision in revisions" :key="revision.id" :label="`R${revision.revisionNumber} · ${formatDate(revision.finalizedAt)}${revision.isCurrentEffective ? ' · 当前有效' : ''}`" :value="revision.id" /></el-select><el-tag type="success">{{ detail.revision.isCurrentEffective ? '当前有效定稿' : '历史定稿' }}</el-tag></div>
      <section class="workbook-section" aria-label="定稿工作簿"><div class="section-heading"><h3>定稿工作簿</h3><span>只读查看 · 可展开勾稽分析</span></div><ReportResultPreview v-if="detail.workbook" :key="`${detail.task.id}-${detail.revision.id}`" :workbook="detail.workbook" frozen /></section>
      <section class="extra-data"><dl class="submission-meta"><div><dt>提交时间</dt><dd>{{ formatDate(detail.revision.submittedAt) }}</dd></div><div><dt>定稿时间</dt><dd>{{ formatDate(detail.revision.finalizedAt) }}</dd></div><div><dt>提交修订</dt><dd>R{{ detail.revision.number }}</dd></div></dl><section class="opinion-card" aria-label="审核意见"><h3>审核意见</h3><p v-if="!detail.opinions.length" class="muted">本修订没有记录审核意见。</p><article v-for="opinion in detail.opinions" :key="`${opinion.departmentCode}-${opinion.reviewItemKey}`" class="opinion-row"><div><strong>{{ opinion.departmentCode || '审核部门' }}</strong><el-tag size="small" :type="opinion.disposition === 'accept' ? 'success' : 'info'">{{ opinion.disposition === 'accept' ? '通过' : '已记录' }}</el-tag></div><p>{{ opinion.opinion || '—' }}</p><small>{{ formatDate(opinion.updatedAt) }}</small></article></section></section>
    </section>
    <el-dialog v-model="generationOpen" title="生成报表" width="96%" top="3vh" destroy-on-close class="generation-dialog"><ReportStudio v-if="generationOpen" monthly-mode /></el-dialog>
  </main>
</template>

<script setup>
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { collaborationApi } from '@/api'
import { SHOWCASE } from '@/config/showcase'
const showcase = SHOWCASE
const ReportResultPreview = defineAsyncComponent(() => import('@/components/ReportResultPreview.vue'))
const ReportStudio = defineAsyncComponent(() => import('./ReportStudio.vue'))
const route = useRoute(), router = useRouter()
const detail = ref(null), revisions = ref([]), activeRevisionId = ref(null), loadingDetail = ref(false), detailError = ref(''), generationOpen = ref(false)
let disposed = false, revisionController
const taskId = () => Number(route.params.taskId)
function formatDate(value) {
  if (!value) return '—'
  const raw = String(value)
  const date = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? new Date(raw.replace(' ', 'T') + 'Z')
    : new Date(raw)
  return Number.isNaN(date.getTime()) ? '时间不可用' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}
function goBack() { router.push({ name: 'FinalizedDataList' }) }
async function loadRevisions() { const id = taskId(); if (!Number.isSafeInteger(id) || id < 1) throw new Error('定稿任务编号无效'); const response = await collaborationApi.getFinalizedRevisions(id); revisions.value = Array.isArray(response.revisions) ? response.revisions : []; const requested = Number(route.params.revisionId); const selected = revisions.value.find(item => Number(item.id) === requested) || revisions.value.find(item => item.isCurrentEffective) || revisions.value[0]; if (!selected) throw new Error('该任务没有可查看的定稿修订'); activeRevisionId.value = selected.id }
async function loadRevision() { const id = taskId(); if (!id || !activeRevisionId.value || disposed) return; revisionController?.abort(); const controller = new AbortController(); revisionController = controller; loadingDetail.value = true; detailError.value = ''; try { const response = await collaborationApi.getFinalizedRevision(id, activeRevisionId.value, { signal: controller.signal }); if (!disposed && !controller.signal.aborted) detail.value = response } catch (error) { if (!disposed && error.name !== 'AbortError') detailError.value = error.message || '定稿工作簿加载失败，请重试。' } finally { if (!disposed && revisionController === controller) loadingDetail.value = false } }
async function download(type) { if (!detail.value) return; try { const blob = await collaborationApi.downloadFinalizedArtifact(taskId(), activeRevisionId.value, type); const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `${showcase ? '' : `${detail.value.task.organizationCode || '组织'}-`}${detail.value.task.periodCode}-R${detail.value.revision.number}.${type === 'finalized_pdf' ? 'pdf' : 'xlsx'}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) } catch (error) { detailError.value = error.message || '下载失败，请重试。' } }
async function load() { try { await loadRevisions(); await loadRevision() } catch (error) { detailError.value = error.message || '定稿数据加载失败，请重试。' } }
onMounted(load); onBeforeUnmount(() => { disposed = true; revisionController?.abort() })
</script>

<style scoped>
.finalized-detail{min-width:0;padding:16px 20px 24px;color:var(--portal-ink,#2c1b26)}.page-head{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--portal-line,#e8d9e1);padding-bottom:10px}.title-block{min-width:0}.title-line{display:flex;align-items:center;gap:10px}.page-head h1{margin:0;font-size:22px;line-height:1.25}.page-head p{margin:4px 0 0;color:var(--portal-muted,#6d5a65);font-size:13px}.back-button{padding:0;color:var(--portal-focus,#941966)}.head-actions{display:flex;flex-wrap:wrap;gap:8px}.feedback{display:grid;gap:6px;margin:8px 0}.feedback p{margin:0;color:var(--portal-muted,#6d5a65)}.detail-panel{min-width:0}.detail-head{display:none}.revision-switcher{display:flex;align-items:center;gap:8px;margin:10px 0}.revision-switcher label{color:var(--portal-muted,#6d5a65);font-size:13px}.revision-switcher .el-select{width:min(330px,100%)}.submission-meta{display:flex;flex-wrap:wrap;gap:12px 28px;margin:14px 0;padding:10px;background:var(--portal-paper,#f8f3f6);border-radius:6px}.submission-meta div{display:grid;gap:3px}.submission-meta dt{color:var(--portal-muted,#6d5a65);font-size:12px}.submission-meta dd{margin:0;font-size:13px;font-weight:600}.opinion-card{margin:14px 0 0;padding:12px;border:1px solid var(--portal-line,#e8d9e1);border-radius:6px}.opinion-card h3,.workbook-section h3{margin:0;font-size:15px}.opinion-row{margin-top:8px;padding-top:8px;border-top:1px solid var(--portal-line,#e8d9e1)}.opinion-row:first-of-type{border-top:0}.opinion-row>div{display:flex;align-items:center;gap:8px}.opinion-row p{margin:5px 0 2px;line-height:1.5;white-space:pre-wrap}.opinion-row small,.muted,.section-heading span{color:var(--portal-muted,#6d5a65);font-size:12px}.workbook-section{min-width:0}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}.extra-data{margin-top:14px}.generation-dialog :deep(.el-dialog__body){padding:0 20px 20px}.generation-dialog :deep(.report-studio){min-height:70vh}@media(max-width:800px){.finalized-detail{padding:12px 12px 20px}.page-head{align-items:flex-start;flex-direction:column}.head-actions{width:100%}.head-actions .el-button{flex:1}.revision-switcher{flex-wrap:wrap}}
</style>
