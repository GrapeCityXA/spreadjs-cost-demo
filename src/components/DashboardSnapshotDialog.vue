<template>
  <el-dialog class="dashboard-dialog snapshot-dialog" :model-value="open" width="94%" top="4vh" title="填报数据详情" destroy-on-close @close="$emit('close')">
    <div v-if="loading" role="status"><p>正在读取该版本的数据详情…</p><el-skeleton :rows="6" /></div>
    <el-alert v-else-if="error" :title="error" type="error" :closable="false"><el-button @click="loadDetail">重新加载详情</el-button></el-alert>
    <template v-else-if="detail">
      <div class="snapshot-meta"><strong>{{ detail.task.name }}</strong><span>{{ showcase ? detail.task.period : `${detail.task.organization} · ${detail.task.period}` }} · R{{ detail.revision.number }}</span><el-tag :type="detail.revision.effective ? 'success' : 'info'">{{ detail.revision.effective ? '当前有效定稿' : '提交版本快照' }}</el-tag></div>
      <el-tabs ref="tabsHost" v-model="tab" class="snapshot-tabs">
        <el-tab-pane label="已采集业务数据" name="values">
          <p class="dashboard-table-hint">左右滑动表格可查看全部列和操作。</p>
          <app-data-table accessible table-label="已采集业务数据" :data="detail.values" row-key="id" empty-text="此版本没有采集到业务字段">
            <el-table-column prop="name" label="指标" min-width="150" /><el-table-column prop="recordKey" label="记录" min-width="120" />
            <el-table-column :column-value="r => r.value" label="采集值" min-width="140" align="right" class-name="snapshot-value"><template #default="{ row }">{{ display(row.value) }}</template></el-table-column><el-table-column prop="unit" label="单位" />
            <el-table-column :column-value="r => r.formula ? '公式计算' : '填报采集'" label="取值方式"><template #default="{ row }">{{ row.formula ? '公式计算' : '填报采集' }}</template></el-table-column>
            <el-table-column prop="formula" label="来源公式" min-width="180"><template #default="{ row }"><code>{{ row.formula || '—' }}</code></template></el-table-column>
            <el-table-column label="原表位置" min-width="170"><template #default="{ row }"><el-button v-if="hasCell(row)" link type="primary" @click="locate(row)">{{ row.sheetName }}!{{ address(row) }}</el-button><span v-else>未记录坐标</span></template></el-table-column>
          </app-data-table>
          <div v-if="detail.functions.length" class="function-list"><strong>本模板引用的自定义函数</strong><span v-for="f in detail.functions" :key="f.versionId">{{ f.name }} · 版本 ID {{ f.versionId }} · {{ f.typeName }}</span><small>函数清单来自该任务固定的模板版本；具体调用见上方来源公式。</small></div>
        </el-tab-pane>
        <el-tab-pane label="提交检查记录" name="checks">
          <p v-if="detail.validation || detail.warnings.length" class="dashboard-table-hint">左右滑动表格可查看全部列和操作。</p>
          <p v-if="!detail.validation">此提交版本没有单元格检查记录，不能据此判断检查通过。</p>
          <template v-else><p>{{ checkLabels[detail.validation.status] }} · {{ detail.checkedBy }} · {{ formatDashboardDate(detail.checkedAt) }}（北京时间）</p><p>检查了 {{ detail.validation.checkedCount }} 个带数据验证的单元格；因不可见跳过 {{ detail.validation.skippedCount }} 个。结果来自提交人浏览器，属于此次提交版本。</p>
            <app-data-table accessible table-label="提交检查问题" :data="detail.validation.issues" empty-text="本次记录没有检查问题"><el-table-column prop="severity" label="级别"><template #default="{row}">{{ row.severity === 'error' ? '错误' : '提示' }}</template></el-table-column><el-table-column prop="message" label="原因" min-width="320" /><el-table-column label="定位"><template #default="{row}"><el-button v-if="hasCell(row)" link type="primary" @click="locate(row)">{{ row.sheetName }}!{{ address(row) }}</el-button><span v-else>未记录坐标</span></template></el-table-column></app-data-table>
          </template>
          <template v-if="detail.warnings.length"><h3>历史业务预警</h3><p>以下记录来自原业务预警规则，与上方单元格检查结果分别记录。</p><app-data-table accessible table-label="历史业务预警" :data="detail.warnings"><el-table-column prop="message" label="原因" /><el-table-column prop="explanation" label="填报说明" /><el-table-column :column-value="warningDisposition" label="审核处理"><template #default="{ row }">{{ warningDisposition(row) }}</template></el-table-column></app-data-table></template>
        </el-tab-pane>
        <el-tab-pane :label="detail.revision.effective ? '定稿原表与勾稽分析' : '提交原表与勾稽分析'" name="workbook">
          <div v-if="workbookLoading || workbookNotice" ref="workbookStatusHost" class="snapshot-workbook-status" tabindex="-1" :aria-busy="workbookLoading">
            <p v-if="workbookLoading" role="status">正在重新读取此版本的原表…</p>
            <template v-else>
              <el-alert :title="workbookNotice.title" :type="workbookNotice.missing ? 'info' : 'warning'" :closable="false" show-icon />
              <p>{{ workbookNotice.description }}</p>
            </template>
            <el-button v-if="workbookLoading || !workbookNotice?.missing" type="primary" :loading="workbookLoading" :disabled="workbookLoading" @click="reloadWorkbook">重新读取原表</el-button>
          </div>
          <DashboardWorkbookPreview v-else-if="tab === 'workbook' && detail.workbook" :key="detail.revision.id" :workbook="detail.workbook" :focus-cell="focusCell" frozen />
        </el-tab-pane>
      </el-tabs>
    </template>
  </el-dialog>
</template>
<script setup>
import '@/styles/dashboard-snapshot-layout.css'
import { ref, shallowRef, computed, nextTick, watch, onBeforeUnmount } from 'vue'
import { createDashboardRequest } from './dashboardRequest'
import { formatDashboardDate } from './dashboardState'
import { managementDashboardApi } from '@/api'
import DashboardWorkbookPreview from './DashboardWorkbookPreview.vue'
import { cellAddress } from '@/template/reportDependencies'
import { SHOWCASE } from '@/config/showcase'
const showcase = SHOWCASE
const props = defineProps({ open: Boolean, selection: Object })
defineEmits(['close'])
const request = createDashboardRequest('数据详情')
const workbookRequest = createDashboardRequest('原表')
const { loading: workbookLoading, error: workbookReloadError } = workbookRequest
const { loading, error } = request
const detail = shallowRef(null), tab = ref('values'), focusCell = shallowRef(null)
const tabsHost = ref(null), workbookStatusHost = ref(null)
const workbookNotice = computed(() => {
  if (!detail.value) return null
  const message = workbookReloadError.value || (typeof detail.value.workbookError === 'string' ? detail.value.workbookError.trim() : '')
  if (message) {
    const missing = !workbookReloadError.value && message === '此版本没有归档工作簿'
    return { title: message, missing, description: missing
      ? '此版本无法预览原表或定位单元格。您仍可查看已采集业务数据和提交检查记录。'
      : workbookReloadError.value
        ? '请按上方提示处理后重新读取原表。已读取的业务数据和检查记录仍可查看。'
        : '可重新读取此版本的原表；若仍失败，请联系管理员核对归档文件。已读取的业务数据和检查记录仍可查看。' }
  }
  const workbook = detail.value.workbook
  if (!workbook || typeof workbook !== 'object' || Array.isArray(workbook)) return {
    title: '此版本暂无可预览的原表', missing: false,
    description: '原表内容为空或格式不可识别。请重新读取；若仍不可用，请联系管理员核对归档文件。'
  }
  return null
})
const checkLabels = { passed: '已检查范围通过', warnings: '存在提示', errors: '存在错误', partial: '仅检查部分单元格', no_rules: '未配置单元格检查' }
const warningDisposition = row => ({ accepted: '已接受说明', correction_requested: '要求更正' })[row.disposition] || (row.disposition ? '未知处理状态' : '未记录处理结果')
const display = v => v == null ? '—' : typeof v === 'boolean' ? v ? '是' : '否' : String(v)
const hasCell = v => typeof v?.sheetName === 'string' && v.sheetName.trim() && Number.isSafeInteger(v.row) && Number.isSafeInteger(v.col) && v.row >= 0 && v.col >= 0
const address = v => cellAddress(v.row, v.col)
function locate(v) { if (!hasCell(v)) return; focusCell.value = { sheetName: v.sheetName, row: v.row, col: v.col }; tab.value = 'workbook' }
async function reloadWorkbook() {
  if (workbookLoading.value || loading.value || !props.open || !props.selection || !detail.value) return
  const selection = props.selection, currentDetail = detail.value
  const pending = workbookRequest.run(signal => managementDashboardApi.snapshot(selection.taskId, selection.revisionId, { signal }), result => {
    if (!result?.revision || String(result.revision.id) !== String(currentDetail.revision.id)) throw new Error('Invalid snapshot revision')
    detail.value = { ...currentDetail, workbook: result.workbook, workbookError: result.workbookError }
  })
  await nextTick()
  if (props.open && props.selection === selection && tab.value === 'workbook') workbookStatusHost.value?.focus()
  await pending
  await nextTick()
  if (props.open && props.selection === selection && tab.value === 'workbook') {
    if (workbookStatusHost.value) workbookStatusHost.value.focus()
    else tabsHost.value?.$el?.querySelector('[role="tab"][aria-selected="true"]')?.focus()
  }
}
function loadDetail() {
  workbookRequest.cancel(); workbookReloadError.value = ''
  request.cancel(); detail.value = null
  if (!props.open || !props.selection) return
  tab.value = ['values', 'checks', 'workbook'].includes(props.selection.tab) ? props.selection.tab : 'values'; focusCell.value = hasCell(props.selection.cell) ? props.selection.cell : null
  const selection = props.selection
  return request.run(signal => managementDashboardApi.snapshot(selection.taskId, selection.revisionId, { signal }), result => {
    if (!result?.task || !result.revision || !['values', 'functions', 'warnings'].every(key => Array.isArray(result[key]))) throw new Error('Invalid snapshot')
    detail.value = result
  })
}
watch(() => [props.open, props.selection], loadDetail, { immediate: true })
onBeforeUnmount(() => { request.cancel(); workbookRequest.cancel() })
</script>
<style scoped>
code { overflow-wrap: anywhere; }
p { font-size: 14px; line-height: 1.6; }
.snapshot-workbook-status { display: grid; justify-items: start; gap: 12px; min-width: 0; padding: 4px 0 16px; --el-color-warning: #8a5700; --el-color-warning-light-9: #fff8eb; --el-color-info: #6d5a65; }
.snapshot-workbook-status .el-alert { width: 100%; }
.snapshot-workbook-status p { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.snapshot-workbook-status .el-button { min-height: 44px; height: auto; white-space: normal; line-height: 1.5; }
.snapshot-workbook-status:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
</style>
