<template>
  <main class="import-page" :class="{ 'import-table-view': tableView }">
    <header class="page-head">
      <div>
        <h1>历史月报导入</h1>
        <p>按标准表格导入已批准字段的月度数据。预览会检查组织、字段、类型、重复记录和已定稿保护。</p>
      </div>
      <el-button plain @click="downloadTemplate">下载导入结构 CSV</el-button>
    </header>

    <section class="panel guide-panel">
      <div class="section-title"><span class="step-index" aria-hidden="true">01</span><div><h2>导入结构</h2><p>在 Excel 中填写后另存为 XLSX。期间和月报类型在下方选择。</p></div></div>
      <dl class="import-structure">
        <div v-for="item in templateColumns" :key="item.column" class="import-structure-row">
          <dt>{{ item.column }}</dt>
          <dd>{{ item.description }}</dd>
          <dd class="import-structure-example"><span>示例：</span>{{ item.example }}</dd>
        </div>
      </dl>
      <p class="note">记录键没有子记录时留空。每行对应一个组织、一个字段和一个记录键；空白数据行会忽略。仅接受 XLSX，不能导入参考报表原件。</p>
    </section>

    <section class="panel setup-panel">
      <div class="section-title"><span class="step-index" aria-hidden="true">02</span><div><h2>选择批次</h2><p>只有数据管理员和系统管理员可以预览及确认导入。</p></div></div>
      <div v-if="optionsError" class="import-feedback" role="alert"><p>{{ optionsError }}</p><el-button :disabled="busy" @click="loadOptions">重新加载月报类型</el-button></div>
      <p v-else-if="phase === 'options'" role="status" class="note">正在加载月报类型…</p>
      <div v-else-if="optionsReady && !options.reportTypes.length" class="import-feedback" role="status"><p>暂无可用月报类型，请联系管理员配置后重新加载。</p><el-button :disabled="busy" @click="loadOptions">重新加载</el-button></div>
      <div class="form-grid">
        <el-form-item label="月报类型">
          <el-select v-model="reportTypeId" placeholder="选择月报类型" :disabled="busy || !optionsReady" class="wide" popper-class="historical-import-types">
            <el-option v-for="item in options.reportTypes" :key="item.id" :label="`${item.displayName}（${item.code}）`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="报告期间">
          <el-date-picker v-model="period" type="month" value-format="YYYY-MM" format="YYYY 年 MM 月" placeholder="选择月份" :disabled="busy" popper-class="historical-import-months" />
        </el-form-item>
        <el-form-item label="历史工作簿" for="historical-import-file" class="file-item">
          <input id="historical-import-file" ref="fileInput" type="file" accept=".xlsx" aria-describedby="historical-import-limits" :disabled="busy" @change="parseFile" />
        </el-form-item>
      </div>
      <p id="historical-import-limits" class="note">仅支持 XLSX，最多 20 MB、1 张工作表、10000 行数据；从 A1 开始填写四列表头，公式须先转为值。</p>
      <div v-if="selectedFile" class="file-summary"><el-icon><Document /></el-icon><span>{{ selectedFile.name }}</span><small>{{ formatSize(selectedFile.size) }}</small></div>
      <div v-if="failure" ref="feedback" class="import-feedback" role="alert" tabindex="-1"><p>{{ failure }}</p><el-button v-if="retryPreview" :disabled="!canPreview" @click="createPreview">重新校验文件</el-button></div>
      <p v-if="notice" class="note" role="status">{{ notice }}</p>
      <p v-if="operationLabel" class="note" role="status">{{ operationLabel }}</p>
      <div class="actions">
        <el-button :type="canConfirm ? 'default' : 'primary'" :loading="phase === 'preview'" :disabled="!canPreview" @click="createPreview">校验并生成预览</el-button>
        <el-button v-if="previewResult?.status === 'validated'" type="primary" :loading="phase === 'confirm'" :disabled="!canConfirm" @click="confirmImport">确认导入 {{ previewResult.summary.newRecords }} 条新记录</el-button>
      </div>
    </section>

    <section v-if="previewResult" class="panel preview-panel">
      <div class="section-title"><span class="step-index" aria-hidden="true">03</span><div><h2 ref="previewHeading" tabindex="-1">{{ receipt ? '导入结果' : '校验预览' }}</h2><p>{{ previewContext?.reportTypeName }} · {{ previewContext?.period }} · 批次 #{{ previewResult.batchId }}</p><p>{{ previewResult.sourceName }}</p></div>
        <el-tag :type="batchState.type">{{ batchState.label }}</el-tag>
      </div>
      <details :key="previewResult.batchId" class="batch-details"><summary>文件校验信息</summary><p>SHA-256 <code>{{ previewResult.sourceSha256 }}</code></p></details>
      <el-alert v-if="receipt" type="success" :closable="false" show-icon :title="`批次 #${previewResult.batchId} 已完成：写入 ${receipt.imported} 条记录，跳过 ${receipt.duplicates} 条重复记录。`" />
      <div v-else class="summary-grid">
        <div><b>{{ previewResult.summary.total }}</b><span>数据行</span></div>
        <div class="good"><b>{{ previewResult.summary.newRecords }}</b><span>新记录</span></div>
        <div class="warning"><b>{{ previewResult.summary.duplicates }}</b><span>重复记录</span></div>
        <div class="warning"><b>{{ previewResult.summary.warnings }}</b><span>警告</span></div>
        <div class="bad"><b>{{ previewResult.summary.blockingErrors }}</b><span>阻断错误</span></div>
      </div>
      <el-alert v-if="!receipt && previewResult.summary.blockingErrors" type="error" :closable="false" show-icon title="批次包含阻断错误，确认导入不会写入任何数据。请修正源表后重新预览。" />
      <p v-if="previewResult.status === 'validated' && !previewResult.summary.newRecords" class="note" role="status">没有可导入的新记录，无需确认。重复记录不会再次写入。</p>
      <div v-if="!receipt" class="import-view-tools">
        <p>逐行核对；切换表格可排序、筛选。</p>
        <el-button :aria-pressed="tableView" @click="tableView = !tableView">{{ tableView ? '切换逐行视图' : '切换表格视图' }}</el-button>
      </div>
      <app-data-table v-if="!receipt" :data="previewResult.rows" accessible virtual-filters table-label="历史导入校验明细" size="small" max-height="460" class="preview-table">
        <template #compact="{ rows, total }">
          <div class="import-compact">
            <p class="note" role="status">共 {{ total }} 条符合条件，本页 {{ rows.length }} 条。</p>
            <ul :key="rows[0]?.rowNumber ?? 'empty'" class="import-records" role="list" aria-label="历史导入逐行明细" tabindex="0">
              <li v-for="row in rows" :key="row.rowNumber" class="import-record">
                <div class="import-record-heading"><strong>源行 {{ row.rowNumber }}</strong><el-tag :type="row.status === 'new' ? 'success' : row.status === 'duplicate' ? 'warning' : 'danger'">{{ statusLabel(row.status) }}</el-tag></div>
                <dl class="import-record-facts">
                  <dt>组织编码</dt><dd>{{ displayValue(row.organizationCode) }}</dd>
                  <dt>字段编码</dt><dd>{{ displayValue(row.fieldCode) }}</dd>
                  <dt>值</dt><dd>{{ displayValue(row.value) }}</dd>
                  <dt>记录键</dt><dd>{{ displayValue(row.recordKey) }}</dd>
                </dl>
                <p class="import-record-note" :class="row.errors.length ? 'error-text' : row.warnings.length ? 'warning-text' : 'muted'">{{ rowExplanation(row) }}</p>
              </li>
            </ul>
            <p v-if="!rows.length" class="note">暂无匹配记录，可切换表格视图调整筛选条件。</p>
          </div>
        </template>
        <el-table-column prop="rowNumber" label="源行" width="75" />
        <el-table-column prop="organizationCode" label="组织编码" width="150" />
        <el-table-column prop="fieldCode" label="字段编码" width="150" />
        <el-table-column prop="recordKey" label="记录键" min-width="120" />
        <el-table-column prop="value" label="值" min-width="130" />
        <el-table-column :column-value="rowStatusLabel" label="判定" width="115">
          <template #default="{ row }"><el-tag :type="row.status === 'new' ? 'success' : row.status === 'duplicate' ? 'warning' : 'danger'">{{ statusLabel(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column :column-value="rowExplanation" label="说明" min-width="260">
          <template #default="{ row }"><span :class="row.errors.length ? 'error-text' : row.warnings.length ? 'warning-text' : 'muted'">{{ rowExplanation(row) }}</span></template>
        </el-table-column>
      </app-data-table>
    </section>

    <div ref="parserHost" class="parser-host" aria-hidden="true" inert></div>
  </main>
</template>

<script>
import { markRaw } from 'vue'
import GC from '@grapecity-software/spread-sheets'
import '@grapecity-software/spread-sheets-io'
import '@grapecity-software/spread-sheets/styles/gc.spread.sheets.excel2013white.css'
import { Document } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { historicalImportApi } from '@/api'
import { valueText } from '@/components/dataTableValues'
import { importFailure, runImportRequest, checkedImportPreview, importReceipt, importBatchState } from '@/utils/historicalImportState'
const EXPECTED_HEADERS = ['组织编码', '字段编码', '记录键', '值']
const CSV_HEADERS = ['组织编码', '字段编码', '记录键', '值']

export default {
  name: 'HistoricalImportWorkbench',
  components: { Document },
  data() {
    return {
      options: { reportTypes: [], organizations: [], fields: [] },
      reportTypeId: null,
      period: '',
      selectedFile: null,
      parsedRows: [],
      previewResult: null,
      phase: 'idle', optionsReady: false, optionsError: '', failure: '', notice: '', retryPreview: false,
      previewContext: null, receipt: null, tableView: false,
      templateColumns: [
        { column: '组织编码', description: '须与有效组织目录的编码完全一致。', example: 'SAMPLE_ORG_01' },
        { column: '字段编码', description: '须使用已批准且可编辑字段的稳定编码。', example: 'MONTHLY_REVENUE' },
        { column: '记录键', description: '同一组织同一字段下的子记录标识；无子记录时留空。', example: 'PRODUCT_A' },
        { column: '值', description: '按字段类型填写；小数请勿超过字段精度。', example: '1234.50' }
      ]
    }
  },
  computed: {
    busy() { return this.phase !== 'idle' },
    canPreview() { return !this.busy && this.optionsReady && Boolean(this.selectedFile && this.parsedRows.length && this.reportTypeId && /^\d{4}-(0[1-9]|1[0-2])$/.test(this.period)) },
    canConfirm() { return !this.busy && this.previewResult?.status === 'validated' && this.previewResult.summary.newRecords > 0 && !this.previewResult.summary.blockingErrors && this.contextMatches() },
    batchState() { return importBatchState(this.previewResult?.status) },
    operationLabel() { return ({ parsing: '正在读取工作簿，请稍候…', preview: '正在校验文件，请稍候…', confirm: '正在确认导入，请等待结果后再离开。' })[this.phase] || '' }
  },
  watch: {
    reportTypeId: { flush: 'sync', handler() { this.invalidatePreview() } },
    period: { flush: 'sync', handler() { this.invalidatePreview() } }
  },
  mounted() {
    this._alive = true
    window.addEventListener('beforeunload', this.beforeUnload)
    this.loadOptions()
  },
  beforeUnmount() {
    this._alive = false; this._controller?.abort(); this._parser?.destroy(); this._parser = null
    window.removeEventListener('beforeunload', this.beforeUnload)
  },
  beforeRouteLeave() {
    if (this.phase === 'confirm' || this.phase === 'prompt') { this.showFailure('请完成当前确认操作后再离开。'); return false }
    return true
  },
  methods: {
    displayValue: valueText,
    beforeUnload(event) { if (this.phase === 'confirm') { event.preventDefault(); event.returnValue = '' } },
    showFailure(message, retryPreview = false) {
      this.failure = message; this.retryPreview = retryPreview
      this.$nextTick(() => this.$refs.feedback?.focus())
    },
    invalidatePreview() {
      if (!this.previewResult) return
      this.previewResult = null; this.previewContext = null; this.receipt = null
      this.failure = ''; this.retryPreview = false
      this.notice = '导入条件已变更，请重新校验文件。'
    },
    contextMatches(context = this.previewContext) {
      return Boolean(context && context.file === this.selectedFile && context.reportTypeId === this.reportTypeId && context.period === this.period)
    },
    async loadOptions() {
      if (this.busy) return
      this.phase = 'options'; this.optionsError = ''; this.optionsReady = false
      const controller = this._controller = new AbortController()
      try {
        const options = await runImportRequest(signal => historicalImportApi.getOptions({ signal }), { signal: controller.signal })
        if (!this._alive) return
        if (!Array.isArray(options?.reportTypes)) throw new Error('月报类型数据不完整，请重新加载。')
        this.options = options; this.optionsReady = true
        if (!options.reportTypes.some(item => item.id === this.reportTypeId)) this.reportTypeId = options.reportTypes[0]?.id ?? null
      } catch (error) { if (this._alive) this.optionsError = importFailure(error, '读取月报类型失败，请重试。') }
      finally { if (this._alive) this.phase = 'idle' }
    },
    formatSize(size) { return size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB` },
    statusLabel(status) { return ({ new: '新记录', duplicate: '重复', blocking_error: '阻断错误' })[status] || status },
    rowStatusLabel(row) { return this.statusLabel(row.status) },
    rowExplanation(row) { return row.errors.length ? row.errors.join('；') : row.warnings.length ? row.warnings.join('；') : row.status === 'duplicate' ? '重复记录，本次导入将跳过' : '将写入草稿修订' },
    async parseFile(event) {
      if (this.busy) return
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      this.selectedFile = null
      this.parsedRows = []
      this.invalidatePreview(); this.failure = ''; this.notice = ''; this.retryPreview = false
      if (!/\.xlsx$/i.test(file.name)) return this.showFailure('请选择 XLSX 文件；CSV 文件请先在 Excel 中另存为 XLSX。')
      if (file.size > 20 * 1024 * 1024) return this.showFailure('XLSX 文件不能超过 20 MB，请拆分后重新选择。')
      if (!file.size) return this.showFailure('文件为空，请选择包含数据的 XLSX 文件。')
      this.phase = 'parsing'
      const controller = this._controller = new AbortController()
      let parser
      try {
        parser = this._parser = markRaw(new GC.Spread.Sheets.Workbook(this.$refs.parserHost, { sheetCount: 1 }))
        const extracted = await runImportRequest(signal => new Promise((resolve, reject) => {
          parser.import(file, () => {
            if (signal.aborted || !this._alive) return
            try {
              if (parser.getSheetCount() !== 1) throw new Error('标准导入文件必须只有一张工作表')
              const sheet = parser.getSheet(0)
              const range = sheet.getUsedRange(GC.Spread.Sheets.UsedRangeType.data)
              if (!range || range.row !== 0 || range.col !== 0 || range.colCount !== 4 || range.rowCount < 2 || range.rowCount > 10001) {
                throw new Error('数据须从 A1 开始，包含 4 列表头和 1 至 10000 行数据')
              }
              const cells = sheet.getArray(range.row, range.col, range.rowCount, range.colCount)
              const formulas = sheet.getArray(range.row, range.col, range.rowCount, range.colCount, true)
              if (JSON.stringify(cells[0]) !== JSON.stringify(EXPECTED_HEADERS)) throw new Error(`首行表头须为：${EXPECTED_HEADERS.join('、')}`)
              const rows = []
              for (let index = 1; index < cells.length; index += 1) {
                const row = cells[index] || []
                if (row.every(value => value == null || value === '')) continue
                if ((formulas[index] || []).some(value => typeof value === 'string' && value.startsWith('='))) {
                  throw new Error(`第 ${index + 1} 行含公式，请将公式结果复制为值后重试`)
                }
                rows.push({ rowNumber: index + 1, organizationCode: row[0], fieldCode: row[1], recordKey: row[2], value: row[3] })
              }
              resolve(rows)
            } catch (error) { reject(error) }
          }, error => reject(new Error(error?.errorMessage || error?.message || 'SpreadJS 无法读取该工作簿')),
          { fileType: GC.Spread.Sheets.FileType.excel })
        }), { signal: controller.signal })
        if (!this._alive) return
        if (!extracted.length) throw new Error('工作簿中没有可导入的数据行')
        this.selectedFile = file
        // File rows are read-only snapshots, replaced together on the next file.
        this.parsedRows = markRaw(extracted)
        this.notice = `已读取 ${extracted.length} 行，请校验并生成预览。`
      } catch (error) { if (this._alive) this.showFailure(importFailure(error, '无法读取工作簿，请检查文件后重试。')) }
      finally {
        if (this._parser === parser) { parser?.destroy(); this._parser = null }
        if (this._alive) this.phase = 'idle'
      }
    },
    async createPreview() {
      if (!this.canPreview) return
      this.phase = 'preview'; this.failure = ''; this.notice = ''; this.retryPreview = false
      this.previewResult = null; this.receipt = null
      const context = { file: this.selectedFile, reportTypeId: this.reportTypeId, period: this.period,
        reportTypeName: this.options.reportTypes.find(item => item.id === this.reportTypeId)?.displayName || '所选月报类型' }
      this.previewContext = context
      const controller = this._controller = new AbortController()
      try {
        const result = await runImportRequest(signal => historicalImportApi.preview({ reportTypeId: context.reportTypeId, periodCode: context.period,
          file: context.file, rows: this.parsedRows }, { signal }), { signal: controller.signal })
        if (!this._alive) return
        if (!this.contextMatches(context)) { this.notice = '导入条件已变更，请重新校验文件。'; return }
        const preview = checkedImportPreview(result)
        // Keep batch status reactive; individual preview rows are never edited.
        preview.rows = markRaw(preview.rows)
        this.previewResult = preview
        this.notice = result.summary.blockingErrors ? '预览完成：存在阻断错误，请检查下方明细并修正文件。' : '预览完成，请核对月报类型、期间和下方明细。'
        this.$nextTick(() => this.$refs.previewHeading?.focus())
      } catch (error) { if (this._alive) this.showFailure(importFailure(error, '校验失败，请重试。'), true) }
      finally { if (this._alive) this.phase = 'idle' }
    },
    async confirmImport() {
      if (!this.canConfirm) return
      const batch = this.previewResult, context = this.previewContext
      this.phase = 'prompt'; this.failure = ''; this.retryPreview = false
      try {
        await ElMessageBox.confirm(`将 ${batch.summary.newRecords} 条新记录导入「${context.reportTypeName}」的 ${context.period} 月报草稿（批次 #${batch.batchId}）。重复记录会跳过，已定稿报告不会被覆盖。`, '确认历史数据导入', { type: 'warning', confirmButtonText: '确认导入', cancelButtonText: '返回检查', closeOnClickModal: false, customClass: 'historical-import-confirm' })
      } catch { if (this._alive) this.phase = 'idle'; return }
      if (!this._alive) return
      if (this.previewResult !== batch || !this.contextMatches(context)) {
        this.phase = 'idle'; this.showFailure('导入条件已变更，请重新校验文件。', true); return
      }
      this.phase = 'confirm'
      const controller = this._controller = new AbortController()
      try {
        const result = await runImportRequest(signal => historicalImportApi.confirm(batch.batchId, { signal }), { signal: controller.signal })
        if (!this._alive || this.previewResult !== batch) return
        this.receipt = importReceipt(result)
        batch.status = 'imported'; this.notice = ''; batch.rows = []
        this.$nextTick(() => this.$refs.previewHeading?.focus())
        ElMessage.success(`导入完成，共写入 ${this.receipt.imported} 条记录`)
      } catch (error) {
        if (!this._alive || this.previewResult !== batch) return
        const knownFailure = [400, 401, 403, 404, 413, 422, 429].includes(error?.status)
        batch.status = knownFailure || error?.status === 409 ? 'stale' : 'uncertain'
        this.showFailure(batch.status === 'uncertain' || error?.status === 409
          ? `批次 #${batch.batchId} 的结果需要核对，提交可能已经生效。请重新校验文件，核对重复记录和错误明细后再决定是否导入。`
          : importFailure(error, '确认未完成，请重新校验文件。'), true)
      } finally { if (this._alive) this.phase = 'idle' }
    },
    downloadTemplate() {
      const content = `\uFEFF${CSV_HEADERS.join(',')}\r\n`
      const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = '历史月报导入结构.csv'
      anchor.click()
      URL.revokeObjectURL(url)
    }
  }
}
</script>

<style scoped>
.import-page { height: 100%; overflow: auto; padding: 28px 32px 48px; background: var(--portal-paper, #f8f3f6); color: var(--portal-ink, #2c1b26); }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin: 0 auto 24px; max-width: 1320px; }
h1 { margin: 0; font-size: 26px; line-height: 1.3; letter-spacing: -.02em; }
.page-head p, .section-title p { margin-top: 8px; color: var(--portal-muted, #6d5a65); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.page-head p { max-width: 72ch; }
.panel { max-width: 1320px; margin: 0 auto 16px; padding: 24px; border: 1px solid var(--portal-line, #e8d9e1); border-radius: var(--portal-radius-panel, 8px); background: var(--portal-surface, #fff); }
.section-title { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.step-index { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 4px; color: var(--portal-focus, #941966); background: var(--portal-accent-surface, #f8ebf3); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.section-title h2 { margin: 0; font-size: 16px; line-height: 1.5; }
.section-title p { margin-top: 3px; }
.note { margin-top: 12px; color: var(--portal-muted, #6d5a65); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.form-grid { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(200px, .7fr) minmax(240px, 1fr); gap: 16px; }
.form-grid :deep(.el-form-item) { display: block; margin: 0; }
.form-grid :deep(.el-form-item__label) { display: block; color: var(--portal-ink, #2c1b26); font-size: 14px; }
.wide, .form-grid :deep(.el-date-editor) { width: 100%; }
.file-item input { width: 100%; padding: 4px; border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 4px; color: var(--portal-muted, #6d5a65); }
.file-summary { display: flex; align-items: center; gap: 8px; margin-top: 16px; color: var(--portal-ink, #2c1b26); font-size: 14px; }
.file-summary span { min-width: 0; overflow-wrap: anywhere; }
.file-summary small { flex-shrink: 0; color: var(--portal-muted, #6d5a65); }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
.actions :deep(.el-button + .el-button) { margin-left: 0; }
.import-feedback { margin-block: 16px; padding: 16px; border: 1px solid #e8b4ae; border-radius: 6px; background: #fff5f4; color: #922419; overflow-wrap: anywhere; }
.import-feedback p { margin: 0; line-height: 1.6; }
.import-feedback :deep(.el-button) { margin-top: 12px; min-height: 44px; }
.import-feedback:focus-visible { outline: 2px solid var(--portal-focus, #941966); outline-offset: 2px; }
.preview-panel .section-title { align-items: flex-start; }
.preview-panel .section-title > div { min-width: 0; }
.preview-panel .section-title > span { flex-shrink: 0; }
.preview-panel .section-title > .el-tag { margin-left: auto; width: auto; height: auto; min-height: 28px; padding: 3px 8px; font-size: 14px; line-height: 1.5; }
.batch-details { margin: -8px 0 16px 44px; color: var(--portal-muted, #6d5a65); font-size: 14px; }
.batch-details summary { width: fit-content; padding-block: 8px; cursor: pointer; color: var(--portal-focus, #941966); line-height: 1.5; }
.batch-details p { margin: 4px 0 12px; line-height: 1.6; overflow-wrap: anywhere; }
.batch-details code { font-size: 12px; user-select: all; }
.summary-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 16px; }
.summary-grid > div { display: flex; align-items: baseline; gap: 8px; padding: 12px 16px; border-radius: 4px; background: var(--portal-paper, #f8f3f6); }
.summary-grid b { font-size: 20px; }
.summary-grid span { color: #718198; font-size: 12px; }
.summary-grid .good b { color: #287346; }.summary-grid .warning b { color: #8a5300; }.summary-grid .bad b { color: #b42318; }
.preview-table { margin-top: 14px; }
.error-text { color: #b42318; }.warning-text { color: #82570f; }.muted { color: var(--portal-muted, #6d5a65); }
.parser-host { position: fixed; top: 0; left: -10000px; width: 2px; height: 2px; overflow: hidden; }
@media (max-width: 850px) { .import-page { padding: 20px 14px 36px; }.panel { padding: 18px 14px; } }
</style>

<style src="@/styles/historical-import-adaptation.css"></style>
