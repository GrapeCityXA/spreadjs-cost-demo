<template>
  <main class="quarter-report portal-workbench">
    <header class="report-header">
      <div>
        <h1>季度参考报表</h1>
        <p class="lede">汇总一个已整包定稿季度的公司评价、指标评分、统一排名及月报来源修订。</p>
      </div>
    </header>
    <div class="report-controls" role="group" aria-label="季度报表查询与下载">
      <div class="query-controls">
        <label for="quarter-package">季度配置包</label>
        <el-select id="quarter-package" v-model="packageId" clearable filterable aria-label="选择季度配置包" placeholder="选择已定稿季度配置包" :loading="loadingTasks" :disabled="loadingTasks || !!exporting">
          <el-option v-for="item in packages" :key="item.packageId" :label="`${item.periodCode} · ${item.reportTypeName} · 配置包 #${item.packageId}`" :value="item.packageId" />
        </el-select>
        <el-button type="primary" :disabled="!packageId || loadingTasks || !!exporting" :loading="loadingReport" @click="loadReport">查看定稿报表</el-button>
      </div>
      <div v-if="report" class="summary-downloads" role="group" aria-label="汇总文件下载">
          <el-button :loading="exporting === 'summary-xlsx'" :disabled="!!exporting" @click="downloadSummary('xlsx')">下载汇总 XLSX</el-button>
          <el-button :loading="exporting === 'summary-pdf'" :disabled="!!exporting" @click="downloadSummary('pdf')">下载汇总 PDF</el-button>
      </div>
    </div>

    <el-alert v-if="tasksError" class="report-alert" type="error" :closable="false" show-icon :title="tasksError"><el-button :loading="loadingTasks" @click="loadPackages()">重新加载季度列表</el-button></el-alert>
    <el-alert v-if="errorText" class="report-alert" type="error" :closable="false" show-icon :title="errorText"><el-button v-if="packageId" :loading="loadingReport" :disabled="!!exporting" @click="loadReport">重新读取报表</el-button></el-alert>
    <p class="request-status" role="status" aria-live="polite">{{ loadingTasks ? '正在加载可查看的季度…' : loadingReport ? '正在读取季度定稿报表…' : exporting ? '正在生成下载文件，请稍候…' : '' }}</p>

    <template v-if="report">
      <section class="report-ribbon" aria-label="报表来源">
        <div><span>报告期间</span><strong>{{ report.package.periodCode }}</strong></div>
        <div><span>配置包 / 版本</span><strong>#{{ report.package.id }} · v{{ report.package.version }}</strong></div>
        <div><span>模板版本</span><strong>#{{ report.package.templateVersionId }}</strong></div>
        <div><span>已定稿公司</span><strong>{{ report.summary.companyCount }} 家</strong></div>
        <div class="source-stamp"><span>数据口径</span><strong>季度定稿时锁定的月报修订</strong></div>
      </section>

      <section class="ranking-panel">
        <div class="section-heading">
          <h2>统一排名</h2>
          <span class="quiet-note">总分按未四舍五入值排名；来源为季度整包定稿结果。</span>
        </div>
        <app-data-table :data="report.companies" row-key="id" stripe accessible responsive table-label="季度公司统一排名" class="ranking-table" empty-text="没有定稿公司">
          <el-table-column :column-value="row => row.ranking?.rank" label="名次" width="90" align="center"><template #default="{ row }"><span class="rank-badge">{{ row.ranking?.rank ?? '—' }}</span></template></el-table-column>
          <el-table-column :column-value="row => row.task.organizationName" label="公司" min-width="220"><template #default="{ row }"><strong>{{ row.task.organizationName }}</strong><small class="subline">{{ row.task.organizationCode }}</small></template></el-table-column>
          <el-table-column :column-value="row => row.task.revisionNumber" label="修订" width="135"><template #default="{ row }">#{{ row.task.revisionId }} · v{{ row.task.revisionNumber }}</template></el-table-column>
          <el-table-column :column-value="row => row.ranking?.totalScore ?? row.scoreSummary?.totalScore" label="总分" width="120" align="right"><template #default="{ row }">{{ amount(row.ranking?.totalScore ?? row.scoreSummary?.totalScore) }}</template></el-table-column>
          <el-table-column :column-value="row => row.ranking?.redemptionCoefficient" label="兑现系数" width="130" align="right"><template #default="{ row }">{{ amount(row.ranking?.redemptionCoefficient) }}</template></el-table-column>
          <el-table-column :column-value="row => row.monthlyDependencies.months.length" label="月报依赖" width="135" align="center"><template #default="{ row }"><el-tag size="small" type="success" effect="plain">{{ row.monthlyDependencies.months.length }} 个月 · 已齐全</el-tag></template></el-table-column>
          <el-table-column label="考核文件" width="180" align="center"><template #default="{ row }"><el-button link type="primary" :aria-label="`下载${row.task.organizationName}考核 XLSX`" :disabled="!!exporting" :loading="exporting === `company-${row.id}-xlsx`" @click="downloadCompany(row, 'xlsx')">XLSX</el-button><el-button link type="primary" :aria-label="`下载${row.task.organizationName}考核 PDF`" :disabled="!!exporting" :loading="exporting === `company-${row.id}-pdf`" @click="downloadCompany(row, 'pdf')">PDF</el-button></template></el-table-column>
          <el-table-column type="expand" width="54">
            <template #default="{ row }">
              <quarterly-company-detail :company="row" :format="detailFormatters" />
            </template>
          </el-table-column>
          <template #compact="{ rows }">
            <div class="company-summary">
              <details v-for="row in rows" :key="row.id" class="company-entry" :open="expandedCompanies.includes(row.id)" @toggle="toggleCompany(row.id, $event)">
                <summary>
                  <span class="rank-badge" :aria-label="`名次 ${row.ranking?.rank ?? '未提供'}`">{{ row.ranking?.rank ?? '—' }}</span>
                  <span class="company-identity"><strong>{{ row.task.organizationName }}</strong><small class="subline">{{ row.task.organizationCode }}</small></span>
                  <span class="company-score"><small>总分</small><strong>{{ amount(row.ranking?.totalScore ?? row.scoreSummary?.totalScore) }}</strong></span>
                  <span class="detail-cue">{{ expandedCompanies.includes(row.id) ? '收起明细' : '查看明细' }}</span>
                </summary>
                <template v-if="expandedCompanies.includes(row.id)">
                  <div class="company-meta">
                    <dl>
                      <div><dt>修订</dt><dd>#{{ row.task.revisionId }} · v{{ row.task.revisionNumber }}</dd></div>
                      <div><dt>兑现系数</dt><dd>{{ amount(row.ranking?.redemptionCoefficient) }}</dd></div>
                      <div><dt>月报依赖</dt><dd>{{ row.monthlyDependencies.months.length }} 个月 · 已齐全</dd></div>
                    </dl>
                    <div class="company-downloads" role="group" :aria-label="`${row.task.organizationName}考核文件`">
                      <el-button :aria-label="`下载${row.task.organizationName}考核 XLSX`" :disabled="!!exporting" :loading="exporting === `company-${row.id}-xlsx`" @click="downloadCompany(row, 'xlsx')">下载 XLSX</el-button>
                      <el-button :aria-label="`下载${row.task.organizationName}考核 PDF`" :disabled="!!exporting" :loading="exporting === `company-${row.id}-pdf`" @click="downloadCompany(row, 'pdf')">下载 PDF</el-button>
                    </div>
                  </div>
                  <quarterly-company-detail :company="row" :format="detailFormatters" />
                </template>
              </details>
              <p v-if="!rows.length" class="quiet-note">没有符合条件的定稿公司</p>
            </div>
          </template>
        </app-data-table>
      </section>
      <footer class="report-foot">生成于 {{ dateTime(report.generatedAt) }} · 配置包与源修订均为定稿快照<span v-if="report.source === 'DEMO_SYNTHETIC_ONLY'"> · DEMO 合成数据，仅用于功能验证，不代表正式审批结果</span></footer>
    </template>

    <el-empty v-else-if="!loadingTasks && !loadingReport && !tasksError && !errorText" class="empty-state" :description="packages.length ? '选择一个配置包查看其正式季度定稿数据' : '当前账号没有可查看的季度整包定稿任务'" :image-size="116" />
    <div ref="exportHost" class="export-host" aria-hidden="true" />
  </main>
</template>

<script>
import QuarterlyCompanyDetail from '@/components/QuarterlyCompanyDetail.vue'
import GC from '@grapecity-software/spread-sheets'
import '@grapecity-software/spread-sheets-io'
import '@grapecity-software/spread-sheets-print'
import '@grapecity-software/spread-sheets-pdf'
import { quarterlyReviewApi } from '@/api'
import { ensureSpreadPdfFonts } from '@/utils/spreadPdfFonts'

const excelFormulaErrorPattern = /^#(?:REF!|VALUE!|DIV\/0!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!|FIELD!|BLOCKED!|CONNECT!|GETTING_DATA|UNKNOWN!|CIRCULAR!)/i
const maxFormulaErrorCleanupPasses = 100
const getExcelFormulaError = value => {
  const candidate = typeof value === 'string' ? value
    : value && typeof value === 'object' ? value._error || value._calcError || value.error || value.result?.error || '' : ''
  return excelFormulaErrorPattern.test(candidate) ? candidate : ''
}

export default {
  name: 'QuarterlyReferenceReport',
  components: { QuarterlyCompanyDetail },
  computed: {
    detailFormatters() {
      return { amount: this.amount, percent: this.percent, categoryName: this.categoryName, reviewName: this.reviewName, scoreSourceName: this.scoreSourceName }
    }
  },
  data() {
    return { expandedCompanies: [], packages: [], packageId: null, report: null, loadingTasks: true, loadingReport: false, tasksError: '', errorText: '', exporting: '' }
  },
  mounted() { this.loadPackages(true) },
  beforeUnmount() {
    this._disposed = true
    this._tasksRequest?.abort()
    this.invalidateReport()
  },
  watch: {
    packageId: { flush: 'sync', handler() { this.invalidateReport() } }
  },
  methods: {
    toggleCompany(id, event) {
      this.expandedCompanies = event.target.open
        ? [...new Set([...this.expandedCompanies, id])]
        : this.expandedCompanies.filter(value => value !== id)
    },
    invalidateReport() {
      this.expandedCompanies = []
      this._reportRequest?.abort()
      this._reportRequest = null
      this.report = null; this.loadingReport = false; this.errorText = ''
    },
    async loadPackages(initial = false) {
      if (this._disposed || this.exporting) return
      this._tasksRequest?.abort()
      const request = this._tasksRequest = new AbortController()
      this.invalidateReport()
      this.loadingTasks = true; this.tasksError = ''
      const current = () => !this._disposed && this._tasksRequest === request && !request.signal.aborted
      try {
        const response = await quarterlyReviewApi.getTasks({ signal: request.signal })
        if (!current()) return
        if (!Array.isArray(response?.tasks)) throw new Error('季度任务列表格式不完整，请重试')
        const grouped = new Map()
        for (const task of response.tasks) {
          const id = Number(task?.packageId)
          if (task?.status !== 'finalized' || task.revisionStatus !== 'finalized' || !Number.isSafeInteger(id) || id <= 0) continue
          if (!grouped.has(id)) grouped.set(id, { packageId: id, periodCode: String(task.periodCode || '期间未提供'), reportTypeName: String(task.reportTypeName || '季度报表') })
        }
        this.packages = [...grouped.values()].sort((a, b) => b.periodCode.localeCompare(a.periodCode))
        const hasRequested = initial && this.$route.query.packageId != null || this.packageId != null
        const wanted = initial && this.$route.query.packageId != null ? Number(this.$route.query.packageId) : this.packageId
        this.packageId = this.packages.some(item => item.packageId === wanted) ? wanted : null
        if (hasRequested && !this.packageId) this.errorText = '指定配置包不在当前可查看的定稿列表中，请重新选择季度。'
        else if (!this.packageId && this.packages.length === 1) this.packageId = this.packages[0].packageId
      } catch (error) {
        if (current()) this.tasksError = `加载季度定稿任务失败：${error?.message || '请检查网络后重试'}`
      } finally { if (current()) this.loadingTasks = false }
      if (current() && !this.tasksError && this.packageId) await this.loadReport()
    },
    async loadReport() {
      if (!this.packageId || this.loadingTasks || this.exporting || this._disposed) return
      this.invalidateReport()
      const packageId = this.packageId
      const request = this._reportRequest = new AbortController()
      const current = () => !this._disposed && this._reportRequest === request && !request.signal.aborted && this.packageId === packageId
      this.loadingReport = true; this.errorText = ''; this.report = null
      try {
        const report = await quarterlyReviewApi.getPackageReport(packageId, { signal: request.signal })
        if (!current()) return
        this.validateReport(report, packageId)
        this.report = report
      } catch (error) { if (current()) this.errorText = `读取正式季度报表失败：${error?.message || '请检查网络后重试'}` }
      finally { if (current()) this.loadingReport = false }
    },
    validateReport(report, packageId) {
      if (Number(report?.package?.id) !== Number(packageId) || !report?.package?.periodCode || !report?.summary || !Array.isArray(report?.companies)) throw new Error('报表配置包或数据格式不匹配，请重新读取')
      for (const company of report.companies) {
        const dependencies = company?.monthlyDependencies
        if (!company?.task || !Array.isArray(company.indicators) || company.indicators.some(item => !item) || !Array.isArray(dependencies?.months) || dependencies.months.some(month => !month) || (company.adjustments != null && (!Array.isArray(company.adjustments) || company.adjustments.some(item => !item)))) throw new Error('公司明细数据不完整，请重新读取')
        for (const period of ['currentQuarter', 'yearToDate']) for (const metric of ['revenue', 'profit']) {
          if (!dependencies[period]?.[metric] || !Object.hasOwn(dependencies[period][metric], 'value')) throw new Error('月报汇总来源不完整，请重新读取')
        }
      }
    },
    amount(value) {
      if (value == null || value === '' || !Number.isFinite(Number(value))) return '—'
      return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value))
    },
    percent(value) {
      if (value == null || value === '' || !Number.isFinite(Number(value))) return '—'
      return `${(Number(value) * 100).toFixed(2)}%`
    },
    categoryName(value) { return ({ key_business: '重点业务', key_work: '重点工作', economic: '经济指标' })[value] || value || '—' },
    reviewName(value) { return ({ pending: '待审核', in_review: '审核中', approved: '已通过', returned: '已退回' })[value] || '—' },
    scoreSourceName(value) { return ({ manual: '人工评分', formula: '公式评分', exempt: '豁免满分' })[value] || '—' },
    dateTime(value) { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date) : '—' },
    saveBlob(blob, fileName) {
      if (this._disposed) return
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a')
      anchor.href = url; anchor.download = fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_'); anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    async createReferenceReportWorkbook(company, report) {
      const sourceSheets = report?.referenceWorkbook?.sheets
      if (!Array.isArray(sourceSheets) || sourceSheets.length !== 22) return null
      const host = this.$refs.exportHost
      host.style.width = '1500px'; host.style.height = '900px'
      const spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: sourceSheets.length, tabEditable: false, newTabVisible: false })
      try {
        const usedNames = new Set()
        for (const [index, source] of sourceSheets.entries()) {
          const sheet = spread.getSheet(index)
          let auxiliaryJson = source.type === 'auxiliary' ? source.auxiliary?.designerJson || source.designerJson : null
          const auxiliaryFormulaErrors = new Set()
          if (auxiliaryJson) {
            auxiliaryJson = JSON.parse(JSON.stringify(auxiliaryJson))
            // SpreadJS stores worksheet cells in data.dataTable. rowDataArray and
            // columnDataArray contain only row/column metadata, not cell values.
            for (const [rowKey, row] of Object.entries(auxiliaryJson.data?.dataTable || {})) {
              for (const [columnKey, cell] of Object.entries(row || {})) {
                if (!getExcelFormulaError(cell?.value)) continue
                auxiliaryFormulaErrors.add(`${Number(rowKey)}:${Number(columnKey)}`)
                cell.value = '—'
                delete cell.formula
              }
            }
          }
          const rowCount = Math.max(1, Number(source.rowCount) || Number(source.auxiliary?.rowCount) || 1)
          const columnCount = Math.max(1, Number(source.columnCount) || Number(source.auxiliary?.columnCount) || 1)
          const baseName = String(source.name || source.code || `Sheet${index + 1}`).slice(0, 31)
          let name = baseName; let suffix = 2
          while (usedNames.has(name)) name = `${baseName.slice(0, 26)} (${suffix++})`
          usedNames.add(name); sheet.name(name)
          sheet.setRowCount(rowCount, GC.Spread.Sheets.SheetArea.viewport)
          sheet.setColumnCount(columnCount, GC.Spread.Sheets.SheetArea.viewport)
          if (auxiliaryJson) {
            sheet.fromJSON(auxiliaryJson); sheet.name(name)
          }
          for (const section of source.sections || []) {
            if (!section.designerJson) continue
            const sourceSpread = new GC.Spread.Sheets.Workbook()
            try {
              const sourceSheet = sourceSpread.getActiveSheet()
              sourceSheet.fromJSON(section.designerJson)
              const startRow = Number(section.startRow) || 0
              const rows = Math.min(Number(section.rowCount) || 0, rowCount - startRow)
              const columns = Math.min(Number(section.columnCount) || columnCount, columnCount)
              if (section.type === 'body') for (let col = 0; col < columns; col += 1) {
                sheet.setColumnWidth(col, sourceSheet.getColumnWidth(col, GC.Spread.Sheets.SheetArea.viewport), GC.Spread.Sheets.SheetArea.viewport)
                if (!sourceSheet.getColumnVisible(col, GC.Spread.Sheets.SheetArea.viewport)) sheet.setColumnVisible(col, false, GC.Spread.Sheets.SheetArea.viewport)
              }
              for (let row = 0; row < rows; row += 1) {
                sheet.setRowHeight(startRow + row, sourceSheet.getRowHeight(row, GC.Spread.Sheets.SheetArea.viewport), GC.Spread.Sheets.SheetArea.viewport)
                if (!sourceSheet.getRowVisible(row, GC.Spread.Sheets.SheetArea.viewport)) sheet.setRowVisible(startRow + row, false, GC.Spread.Sheets.SheetArea.viewport)
                if (sourceSheet.getRowPageBreak(row)) sheet.setRowPageBreak(startRow + row, true)
                for (let col = 0; col < columns; col += 1) {
                  const formula = sourceSheet.getFormula(row, col); const value = sourceSheet.getValue(row, col)
                  if (formula) sheet.setFormula(startRow + row, col, formula)
                  else if (value !== null && value !== undefined) sheet.setValue(startRow + row, col, value)
                  const formatter = sourceSheet.getFormatter(row, col, GC.Spread.Sheets.SheetArea.viewport)
                  if (formatter != null) sheet.setFormatter(startRow + row, col, formatter, GC.Spread.Sheets.SheetArea.viewport)
                  const style = sourceSheet.getActualStyle(row, col, GC.Spread.Sheets.SheetArea.viewport)
                  if (style) sheet.setStyle(startRow + row, col, style, GC.Spread.Sheets.SheetArea.viewport)
                }
              }
              for (const span of sourceSheet.getSpans(new GC.Spread.Sheets.Range(0, 0, rows, columns), GC.Spread.Sheets.SheetArea.viewport) || []) {
                sheet.addSpan(startRow + span.row, span.col, span.rowCount, span.colCount, GC.Spread.Sheets.SheetArea.viewport)
              }
            } finally { sourceSpread.destroy() }
          }
          for (const cell of source.cells || source.auxiliary?.cells || []) {
            if (source.type === 'auxiliary') continue
            const row = Number(cell.row); const col = Number(cell.column ?? cell.col)
            if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= rowCount || col >= columnCount) continue
            if (cell.formula) sheet.setFormula(row, col, cell.formula)
            else if (Object.hasOwn(cell, 'value')) sheet.setValue(row, col, cell.value)
          }
          for (const address of auxiliaryFormulaErrors) {
            const [row, col] = address.split(':').map(Number)
            sheet.setFormula(row, col, null, GC.Spread.Sheets.SheetArea.viewport)
            sheet.setValue(row, col, '—')
          }
          const isVisible = sheet.visible()
          const scanRows = sheet.getRowCount(GC.Spread.Sheets.SheetArea.viewport)
          const scanColumns = sheet.getColumnCount(GC.Spread.Sheets.SheetArea.viewport)
          for (let row = 0; row < scanRows; row += 1) for (let col = 0; col < scanColumns; col += 1) {
            const value = sheet.getValue(row, col)
            if (!isVisible) continue
            if (typeof value !== 'string' || (value.length < 25 && !/[\r\n]/.test(value))) continue
            const existing = sheet.getStyle(row, col, GC.Spread.Sheets.SheetArea.viewport)
            const style = existing ? existing.clone() : new GC.Spread.Sheets.Style()
            style.wordWrap = true; sheet.setStyle(row, col, style, GC.Spread.Sheets.SheetArea.viewport)
          }
          if (!isVisible) continue
          const printInfo = sheet.printInfo(); printInfo.fitPagesWide(1); printInfo.bestFitRows(true); sheet.printInfo(printInfo)
        }
        const writeTable = (sheet, startRow, title, headers, rows, columnWidths = []) => {
          const width = Math.max(headers.length, ...rows.map(row => row.length))
          const paddedHeaders = [...headers, ...Array(Math.max(0, width - headers.length)).fill('')]
          const paddedRows = rows.map(row => [...row, ...Array(Math.max(0, width - row.length)).fill('')])
          const titleStyle = new GC.Spread.Sheets.Style(); titleStyle.font = 'bold 14px Microsoft YaHei'; titleStyle.backColor = '#e8f0eb'; titleStyle.foreColor = '#183536'; titleStyle.wordWrap = true
          const headerStyle = new GC.Spread.Sheets.Style(); headerStyle.font = 'bold 10px Microsoft YaHei'; headerStyle.backColor = '#195e58'; headerStyle.foreColor = '#ffffff'; headerStyle.wordWrap = true
          sheet.setRowCount(Math.max(sheet.getRowCount(GC.Spread.Sheets.SheetArea.viewport), startRow + rows.length + 3), GC.Spread.Sheets.SheetArea.viewport)
          sheet.setValue(startRow, 0, title)
          sheet.getRange(startRow, 0, 1, width).setStyle(titleStyle)
          sheet.setValue(startRow + 1, 0, '此区由平台结构化定稿数据生成；上方来源模板内容作为只读版式保留。')
          sheet.getRange(startRow + 1, 0, 1, width).setStyle(titleStyle)
          sheet.setArray(startRow + 2, 0, [paddedHeaders, ...paddedRows])
          sheet.getRange(startRow + 2, 0, 1, width).setStyle(headerStyle)
          sheet.getRange(startRow + 2, 0, rows.length + 1, width).wordWrap(true)
          sheet.setRowHeight(startRow, 28, GC.Spread.Sheets.SheetArea.viewport)
          sheet.setRowHeight(startRow + 1, 24, GC.Spread.Sheets.SheetArea.viewport)
          sheet.setRowHeight(startRow + 2, 30, GC.Spread.Sheets.SheetArea.viewport)
          for (let row = 0; row < rows.length; row += 1) {
            sheet.setRowHeight(startRow + row + 3, 24, GC.Spread.Sheets.SheetArea.viewport)
          }
          for (let col = 0; col < width; col += 1) if (!sheet.getColumnWidth(col)) sheet.setColumnWidth(col, columnWidths[col] || 125)
          const printInfo = sheet.printInfo()
          if (printInfo.rowEnd() >= 0) printInfo.rowEnd(Math.max(printInfo.rowEnd(), startRow + rows.length + 2))
          if (printInfo.columnEnd() >= 0) printInfo.columnEnd(Math.max(printInfo.columnEnd(), width - 1))
          if (rows.length > 100) printInfo.fitPagesTall(4)
          else if (rows.length >= 15) printInfo.fitPagesTall(2)
          sheet.printInfo(printInfo)
        }
        const companySheetByCode = new Map(sourceSheets.flatMap((sheet, index) => [[sheet.code, spread.getSheet(index)], [sheet.name, spread.getSheet(index)]]))
        const companies = company ? [company] : report.companies
        for (const item of companies) {
          const sheet = companySheetByCode.get(item.referenceSheetCode)
          if (!sheet) throw new Error(`找不到公司参考页：${item.referenceSheetCode || item.task.organizationName}`)
          const companyDefinition = sourceSheets.find(source => source.code === item.referenceSheetCode || source.name === item.referenceSheetCode)
          const usedRows = companyDefinition?.rowCount || 1
          const rows = []
          rows.push(['公司', `${item.task.organizationName}（${item.task.organizationCode}）`, '名次 / 季度总分', `${item.ranking?.rank ?? '—'} / ${item.ranking?.totalScore ?? item.scoreSummary?.totalScore ?? '—'}`])
          rows.push(['本季度收入 / 利润', `${item.monthlyDependencies.currentQuarter.revenue.value} / ${item.monthlyDependencies.currentQuarter.profit.value}`, '年初至今收入 / 利润', `${item.monthlyDependencies.yearToDate.revenue.value} / ${item.monthlyDependencies.yearToDate.profit.value}`])
          for (const indicator of item.indicators || []) rows.push(['考核指标', indicator.displayName, `${this.categoryName(indicator.category)} · 权重 ${this.percent(indicator.weight)}`, `审核 ${this.reviewName(indicator.review?.status)} · 得分 ${indicator.scoring?.score ?? '—'} · ${this.scoreSourceName(indicator.scoring?.source)}；${indicator.review?.opinion || ''}`])
          for (const adjustment of item.adjustments || []) rows.push(['奖励与扣罚', `${adjustment.adjustmentType} · ${adjustment.amount}`, `审批 ${adjustment.status}`, adjustment.reason])
          for (const month of item.monthlyDependencies.months || []) rows.push(['月报来源', month.periodCode, `修订 #${month.revisionId} · ${month.status}`, `收入 ${month.metrics?.revenue ?? '—'} · 利润 ${month.metrics?.profit ?? '—'}`])
          writeTable(sheet, usedRows + 2, report.source === 'DEMO_SYNTHETIC_ONLY' ? 'DEMO 合成季度定稿结果（非正式）' : '季度定稿平台结构化结果', ['内容类型', '项目或期间', '审核 / 汇总', '数值 / 说明'], rows, [130, 280, 220, 420])
        }
        if (!company) {
          const summarySheet = companySheetByCode.get('总表')
          const summaryDefinition = sourceSheets.find(sheet => sheet.code === '总表')
          const summaryRows = [...report.companies].sort((a, b) => (a.ranking?.rank ?? Infinity) - (b.ranking?.rank ?? Infinity))
            .map(item => [item.ranking?.rank ?? '—', item.task.organizationName, item.task.organizationCode, item.ranking?.totalScore ?? item.scoreSummary?.totalScore ?? '—', item.ranking?.redemptionCoefficient ?? '—', `#${item.task.revisionId} · v${item.task.revisionNumber}`])
          const summaryStartRow = (summaryDefinition?.rowCount || 1) + 2
          writeTable(summarySheet, summaryStartRow, report.source === 'DEMO_SYNTHETIC_ONLY' ? 'DEMO 合成季度公司排名（非正式）' : '季度定稿公司排名', ['名次', '公司', '组织编码', '总分', '兑现系数', '季度修订'], summaryRows, [56, 150, 115, 80, 90, 130])
          const sourceRows = report.companies.flatMap(item => item.monthlyDependencies.months.map(month => [item.task.organizationName,
            month.periodCode, `#${month.revisionId}`, month.metrics?.revenue ?? '—', month.metrics?.profit ?? '—', month.status || 'finalized']))
          writeTable(summarySheet, summaryStartRow + summaryRows.length + 5,
            report.source === 'DEMO_SYNTHETIC_ONLY' ? 'DEMO 合成月报来源追溯（非正式）' : '定稿月报来源追溯',
            ['公司', '期间', '月报修订', '营业收入', '利润总额', '来源状态'], sourceRows, [150, 95, 95, 105, 105, 100])
        }
        for (let pass = 0; pass < maxFormulaErrorCleanupPasses; pass += 1) {
          spread.calculate()
          let clearedErrorCount = 0
          for (const sheet of spread.sheets) {
            const rows = sheet.getRowCount(GC.Spread.Sheets.SheetArea.viewport)
            const columns = sheet.getColumnCount(GC.Spread.Sheets.SheetArea.viewport)
            for (let row = 0; row < rows; row += 1) for (let col = 0; col < columns; col += 1) {
              const value = sheet.getValue(row, col)
              const formula = sheet.getFormula(row, col)
              if (!getExcelFormulaError(value) && !(formula && /#REF!/i.test(formula))) continue
              if (formula) sheet.setFormula(row, col, null, GC.Spread.Sheets.SheetArea.viewport)
              sheet.setValue(row, col, '—', GC.Spread.Sheets.SheetArea.viewport)
              clearedErrorCount += 1
            }
          }
          if (clearedErrorCount === 0) break
          if (pass === maxFormulaErrorCleanupPasses - 1) throw new Error('参考工作簿公式错误清理未收敛')
        }
        return spread
      } catch (error) { spread.destroy(); throw error }
    },
    async exportReport({ company = null, type }) {
      if (this._disposed || this.exporting || this.loadingReport || !this.report || !['xlsx', 'pdf'].includes(type)) return
      // API results are read-only here. Keep this response reference for the entire job,
      // even if the visible report is cleared or replaced while an export callback waits.
      const report = this.report
      const isSummary = !company
      this.exporting = `${isSummary ? 'summary' : `company-${company.id}`}-${type}`
      let spread
      try {
        this.validateReport(report, this.packageId)
        if (company) {
          company = report.companies.find(item => item.id === company.id)
          if (!company) throw new Error('所选公司不在当前报表中，请重新读取报表')
        }
        if (type === 'pdf') await ensureSpreadPdfFonts(GC)
        if (this._disposed) return
        spread = await this.createReferenceReportWorkbook(company, report)
        if (this._disposed) return
        if (spread) {
          const sheetIndex = company ? report.referenceWorkbook.sheets.findIndex(sheet => sheet.code === company.referenceSheetCode || sheet.name === company.referenceSheetCode) : undefined
          if (company && sheetIndex < 0) throw new Error('找不到所选公司的参考页，请重新读取报表')
          const title = company ? `${company.task.organizationName} ${report.package.periodCode}季度考核` : `${report.package.periodCode}季度考核汇总`
          const blob = type === 'xlsx'
            ? await new Promise((resolve, reject) => spread.export(resolve, reject, { fileType: GC.Spread.Sheets.FileType.excel, includeBindingSource: false }))
            : await new Promise((resolve, reject) => spread.savePDF(resolve, reject, { title, author: '成本指标平台', creator: 'SpreadJS 19.1.4' }, sheetIndex))
          const safeName = company ? `${company.task.organizationCode}-${company.task.organizationName}-季度考核` : '季度考核汇总'
          if (!this._disposed) this.saveBlob(blob, `${safeName}-${report.package.periodCode}.${type}`)
          return
        }
        const host = this.$refs.exportHost
        host.style.width = '1500px'; host.style.height = '900px'
        spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1 })
        const sheet = spread.getActiveSheet()
        const title = isSummary ? `${report.package.periodCode}季度考核汇总` : `${company.task.organizationName} ${report.package.periodCode}季度考核`
        sheet.name(isSummary ? '季度汇总' : '公司考核')
        const heading = new GC.Spread.Sheets.Style(); heading.font = 'bold 18px Microsoft YaHei'; heading.foreColor = '#183536'; heading.backColor = '#e5efeb'; heading.hAlign = GC.Spread.Sheets.HorizontalAlign.center; heading.vAlign = GC.Spread.Sheets.VerticalAlign.center
        const header = new GC.Spread.Sheets.Style(); header.font = 'bold 10px Microsoft YaHei'; header.foreColor = '#ffffff'; header.backColor = '#195e58'; header.hAlign = GC.Spread.Sheets.HorizontalAlign.center; header.vAlign = GC.Spread.Sheets.VerticalAlign.center; header.wordWrap = true
        const section = new GC.Spread.Sheets.Style(); section.font = 'bold 11px Microsoft YaHei'; section.foreColor = '#254b40'; section.backColor = '#e9f0eb'
        const columns = isSummary ? 6 : 8
        sheet.setValue(0, 0, title); sheet.addSpan(0, 0, 1, columns); sheet.setStyle(0, 0, heading); sheet.setRowHeight(0, 36)
        let row = 2
        if (isSummary) {
          sheet.setArray(row, 0, [['名次', '公司', '组织编码', '季度总分', '兑现系数', '季度修订']]); sheet.getRange(row, 0, 1, columns).setStyle(header); row += 1
          const rankingRows = [...report.companies].sort((a, b) => (a.ranking?.rank ?? Infinity) - (b.ranking?.rank ?? Infinity)).map(item => [item.ranking?.rank ?? '—', item.task.organizationName, item.task.organizationCode, item.ranking?.totalScore ?? item.scoreSummary?.totalScore ?? null, item.ranking?.redemptionCoefficient ?? null, `#${item.task.revisionId} · v${item.task.revisionNumber}`])
          if (rankingRows.length) { sheet.setArray(row, 0, rankingRows); row += rankingRows.length }
          row += 2; sheet.setValue(row, 0, '季度定稿月报来源'); sheet.addSpan(row, 0, 1, columns); sheet.setStyle(row, 0, section); row += 1
          sheet.setArray(row, 0, [['公司', '期间', '月报修订', '营业收入', '利润总额', '来源状态']]); sheet.getRange(row, 0, 1, columns).setStyle(header); row += 1
          const sources = report.companies.flatMap(item => item.monthlyDependencies.months.map(month => [item.task.organizationName, month.periodCode, month.revisionId, month.metrics?.revenue ?? null, month.metrics?.profit ?? null, month.status || 'finalized']))
          if (sources.length) { sheet.setArray(row, 0, sources); row += sources.length }
        } else {
          sheet.setArray(row++, 0, [['公司', company.task.organizationName, '组织编码', company.task.organizationCode, '排名', company.ranking?.rank ?? '—', '总分', company.ranking?.totalScore ?? company.scoreSummary?.totalScore ?? null]])
          sheet.setArray(row++, 0, [['季度收入', company.monthlyDependencies.currentQuarter.revenue.value, '季度利润', company.monthlyDependencies.currentQuarter.profit.value, '年初至今收入', company.monthlyDependencies.yearToDate.revenue.value, '年初至今利润', company.monthlyDependencies.yearToDate.profit.value]])
          row += 1; sheet.setValue(row, 0, '指标审核与评分'); sheet.addSpan(row, 0, 1, columns); sheet.setStyle(row, 0, section); row += 1
          sheet.setArray(row, 0, [['指标', '类别', '权重', '部门审核', '审核意见', '得分', '评分方式']]); sheet.getRange(row, 0, 1, columns).setStyle(header); row += 1
          const indicatorRows = company.indicators.map(item => [item.displayName, this.categoryName(item.category), item.weight, this.reviewName(item.review?.status), item.review?.opinion || '', item.scoring?.score ?? null, this.scoreSourceName(item.scoring?.source)])
          if (indicatorRows.length) { sheet.setArray(row, 0, indicatorRows); row += indicatorRows.length }
          row += 2; sheet.setValue(row, 0, '收入与利润月报来源修订'); sheet.addSpan(row, 0, 1, columns); sheet.setStyle(row, 0, section); row += 1
          sheet.setArray(row, 0, [['期间', '月报修订', '状态', '营业收入', '', '利润总额', '']]); sheet.getRange(row, 0, 1, columns).setStyle(header); row += 1
          const sourceRows = company.monthlyDependencies.months.map(month => [month.periodCode, month.revisionId, month.status, month.metrics?.revenue ?? null, '', month.metrics?.profit ?? null, ''])
          if (sourceRows.length) { sheet.setArray(row, 0, sourceRows); row += sourceRows.length }
          if (company.adjustments?.length) {
            row += 2; sheet.setValue(row, 0, '奖励与扣罚'); sheet.addSpan(row, 0, 1, columns); sheet.setStyle(row, 0, section); row += 1
            sheet.setArray(row, 0, [['类型', '金额', '原因', '审批状态', '', '', '']]); sheet.getRange(row, 0, 1, columns).setStyle(header); row += 1
            const adjustmentRows = company.adjustments.map(item => [item.adjustmentType, item.amount, item.reason, item.status, '', '', '']); sheet.setArray(row, 0, adjustmentRows); row += adjustmentRows.length
          }
        }
        const widths = isSummary ? [70, 200, 140, 100, 110, 150] : [210, 100, 90, 105, 340, 90, 110, 100]
        widths.forEach((width, index) => sheet.setColumnWidth(index, width))
        sheet.getRange(0, 0, row, columns).wordWrap(true)
        sheet.options.gridline = { showVerticalGridline: false, showHorizontalGridline: false }
        const printInfo = new GC.Spread.Sheets.Print.PrintInfo()
        printInfo.orientation(GC.Spread.Sheets.Print.PrintPageOrientation.landscape); printInfo.fitPagesWide(1); printInfo.showGridLine(false)
        sheet.printInfo(printInfo)
        const blob = type === 'xlsx'
          ? await new Promise((resolve, reject) => spread.export(resolve, reject, { fileType: GC.Spread.Sheets.FileType.excel, includeBindingSource: false }))
          : await new Promise((resolve, reject) => spread.savePDF(resolve, reject, { title, author: '成本指标平台', creator: 'SpreadJS 19.1.4' }))
        const safeName = isSummary ? '季度考核汇总' : `${company.task.organizationCode}-${company.task.organizationName}-季度考核`
        if (!this._disposed) this.saveBlob(blob, `${safeName}-${report.package.periodCode}.${type}`)
      } catch (error) { if (!this._disposed) this.$message.error(`导出失败：${error?.errorMessage || error?.message || '请稍后重试'}`) }
      finally { try { spread?.destroy() } finally { if (!this._disposed) this.exporting = '' } }
    },
    downloadSummary(type) { return this.exportReport({ type }) },
    downloadCompany(company, type) { return this.exportReport({ company, type }) }
  }
}
</script>

<style scoped src="@/styles/quarterly-reference-report.css"></style>
