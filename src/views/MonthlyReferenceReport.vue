<template>
  <ReportStudio v-if="!standardView" monthly-mode />
  <main v-else class="reference-page portal-workbench">
    <header class="page-head">
      <div>
        <h1>月度标准汇总</h1>
        <p class="lede">按所选配置版本读取参与组织、目标值和有效定稿数据。缺少来源的月份显示为不完整。</p>
      </div>
        <el-button @click="$router.push('/portal/monthly-reference-report')">按发布模板生成</el-button>
    </header>
      <div class="period-controls" role="group" aria-label="标准汇总查询条件">
        <div class="query-field"><label for="monthly-report-type">报表类型</label>
        <el-select id="monthly-report-type" v-model="reportTypeId" aria-label="报表类型" placeholder="选择月报类型" :loading="typesLoading" :disabled="typesLoading || !!exporting">
          <el-option v-for="type in reportTypes" :key="type.id" :label="type.displayName" :value="type.id" />
        </el-select></div>
        <div class="query-field"><label for="monthly-report-period">报告月份</label>
        <el-date-picker id="monthly-report-period" v-model="periodCode" aria-label="报告月份" :disabled="!!exporting" type="month" value-format="YYYY-MM" format="YYYY 年 M 月" placeholder="选择报告月份" /></div>
        <div class="query-field"><label for="monthly-report-version">配置版本</label>
        <el-select id="monthly-report-version" v-model="configurationPackageId" aria-label="配置版本" placeholder="选择配置版本" :loading="versionsLoading" :disabled="!versionsReady || versionsLoading || !!versionsError || !!exporting">
          <el-option v-for="version in versions" :key="version.id" :value="version.id" :label="`V${version.version} · 配置包 #${version.id}`" />
        </el-select></div>
        <el-button type="primary" :loading="loading" :disabled="!canQuery || !!exporting" @click="loadReport">查看标准汇总</el-button>
      </div>

    <div class="report-feedback" aria-live="polite" aria-atomic="true">
      <p v-if="versionsLoading" role="status">正在加载配置版本…</p>
      <el-alert v-else-if="versionsError" :title="versionsError" type="error" :closable="false" show-icon>
        <el-button @click="loadVersions">重新加载版本</el-button>
      </el-alert>
      <p v-else-if="versionsReady && !versions.length">此报表类型和月份暂无已生成任务的配置版本，请先完成期间配置并激活。</p>
      <p v-else-if="versions.length > 1 && !configurationPackageId">存在多个配置版本，请选择本次汇总使用的版本。</p>
      <p v-if="typesLoading" role="status">正在加载报表类型…</p>
      <el-alert v-else-if="typesError" type="error" :closable="false" show-icon :title="typesError">
        <el-button @click="loadReportTypes">重新加载类型</el-button>
      </el-alert>
      <p v-else-if="typesReady && !reportTypes.length">暂无可用的月报类型，请联系管理员配置月报类型后重新加载。<el-button @click="loadReportTypes">重新加载类型</el-button></p>
      <el-alert v-if="reportError" title="标准汇总加载失败" type="error" :closable="false" show-icon>
        <span class="feedback-line">{{ reportError }}</span><span v-if="report" class="feedback-line">下方保留上次成功加载的报表。</span>
        <el-button :disabled="!canQuery || loading || !!exporting" @click="loadReport">重试查询</el-button>
      </el-alert>
      <p v-if="loading" role="status">正在加载标准汇总{{ report ? '，下方保留上次结果' : '' }}…</p>
      <p v-else-if="queryChanged" role="status">查询条件已更改，下方仍为 {{ report.reportType.name }} · {{ report.periodCode }} · V{{ report.configurationVersion }} 的结果。请点击“查看标准汇总”更新。</p>
      <el-alert v-if="exportError" title="导出失败" :description="exportError" type="error" :closable="false" show-icon />
      <p v-if="exporting" role="status">正在导出 {{ report.periodCode }} 报表，请稍候…</p>
    </div>

    <section v-if="report" class="report-body" :aria-busy="loading">
      <el-alert v-if="isSyntheticDemo" class="demo-note" type="warning" :closable="false" show-icon
        title="DEMO 合成数据，仅用于功能验证，不代表正式审批结果" />
      <div class="report-meta">
        <div><span class="meta-label">报表类型</span><strong>{{ report.reportType?.name }}</strong></div>
        <div><span class="meta-label">报告期间</span><strong>{{ report.periodCode }}</strong></div>
        <div><span class="meta-label">配置版本</span><strong>V{{ report.configurationVersion }}<small> · #{{ report.configurationPackageId }}</small></strong></div>
        <div><span class="meta-label">参与组织</span><strong>{{ report.finalizedOrganizations }}<small> / {{ report.participatingOrganizations }} 家已定稿</small></strong></div>
        <div class="export-actions">
          <el-button :disabled="!report.rows.length || !!exporting || loading" :loading="exporting === 'xlsx'" @click="download('xlsx')">下载 XLSX</el-button>
          <el-button type="primary" plain :disabled="!report.rows.length || !!exporting || loading" :loading="exporting === 'pdf'" @click="download('pdf')">下载 PDF</el-button>
        </div>
      </div>

      <p class="summary-scope">{{ summaryScope }}</p>
      <section class="metric-totals" :aria-label="summaryScope">
        <article v-for="metric in metricDefinitions" :key="metric.key" class="total-card">
          <h3 class="total-heading">{{ metric.label }}累计</h3>
          <strong>{{ amount(summaryMetrics[metric.key].currentYearToDate.value) }}</strong>
          <p v-if="summaryMissingReason(metric.key)" class="missing-reason">{{ summaryMissingReason(metric.key) }}</p>
          <div class="total-foot"><span>上年同期 {{ amount(summaryMetrics[metric.key].priorYearToDate.value) }}</span>
            <span>{{ percent(summaryMetrics[metric.key].cumulativeCompletionRate) }} 完成</span></div>
          <el-progress :aria-label="`${metric.label}累计目标完成率`" :percentage="progressValue(summaryMetrics[metric.key].cumulativeCompletionRate)" :show-text="false" :stroke-width="4" :color="metric.key === 'revenue' ? '#1a766b' : '#c07b37'" />
        </article>
      </section>

      <el-alert v-if="!report.scoringAvailable || !report.rankingAvailable || !report.consolidationAvailable" class="rule-note" type="info" :closable="false" show-icon>
        <template #title>部分计算项尚未配置</template>
        <span v-if="!report.scoringAvailable || !report.rankingAvailable">当前发布配置没有完整评分规则；报表不会推测得分或名次。 </span>
        <span v-if="!report.consolidationAvailable">组织合并口径尚未核定，因此不展示跨组织合计。 </span>
        累计金额由月度定稿值计算，缺月显示为不完整。
        仅使用所选配置包关联的数据，不自动拼接其他配置版本或月份的定稿值。
      </el-alert>

      <section class="traceability-shell" aria-label="报表口径与来源追溯">
        <div class="table-heading"><h2>口径与来源追溯</h2></div>
        <dl class="report-provenance">
          <div><dt>数据来源</dt><dd>{{ isSyntheticDemo ? 'DEMO 合成月度记录与修订号' : '当前有效月报定稿修订' }}</dd></div>
          <div><dt>配置包</dt><dd>#{{ report.configurationPackageId }} · v{{ report.configurationVersion }}</dd></div>
          <div><dt>模板版本</dt><dd>#{{ report.templateVersionId }}</dd></div>
          <div class="provenance-wide"><dt>参与组织范围</dt><dd>{{ report.traceability?.organizationScope?.reason }} 源表第 5–16 行仅为候选范围；第 17 行“生态水务”暂缓纳入。</dd></div>
          <div class="provenance-wide"><dt>合计状态</dt><dd>{{ report.traceability?.consolidation?.reason || '按已发布的组织合并规则汇总。' }}{{ !report.consolidationAvailable ? ' 合计暂不展示。' : '' }}</dd></div>
          <div class="provenance-wide"><dt>源表调整</dt><dd>{{ report.traceability?.sourceWorkbookAdjustments?.reason }} 候选单元格：{{ report.traceability?.sourceWorkbookAdjustments?.candidateCells?.join('、') }}。</dd></div>
          <div class="provenance-wide"><dt>控亏完成率</dt><dd>{{ report.traceability?.controlLossCompletion?.reason }}</dd></div>
          <div class="provenance-wide"><dt>修订追溯</dt><dd>每个组织列出构成本年累计及上年同期比较的定稿期间和修订 ID；每月只取当前有效定稿修订。</dd></div>
        </dl>
      </section>



      <section class="table-shell">
        <div class="table-heading"><h2>组织经营明细</h2>
          <span class="unit-label">金额单位：配置字段口径</span></div>
        <p class="monthly-table-hint">可在表格内左右滚动，查看全部指标与修订信息。</p>
        <app-data-table :data="report.rows" stripe border row-key="organizationId" class="report-table" max-height="min(70vh, 680px)">
          <el-table-column prop="organizationCode" label="组织编码" width="145" fixed="left" />
          <el-table-column prop="organizationName" label="组织名称" min-width="170" fixed="left" />
          <el-table-column :column-value="row => row.reportRevisionId" label="本期修订" width="120" align="center"><template #default="scope">{{ scope.row.reportRevisionId ?? '—' }}</template></el-table-column>
          <el-table-column v-for="metric in metricDefinitions" :key="metric.key" :column-group="true" :label="metric.label" align="center">
            <el-table-column :column-value="row => row.metrics[metric.key].currentMonth" :label="reportMonthLabel" min-width="132" align="right" show-overflow-tooltip>
              <template #default="scope">{{ amount(scope.row.metrics[metric.key].currentMonth) }}</template>
            </el-table-column>
            <el-table-column :column-value="row => row.metrics[metric.key].priorYearSameMonth" label="上年同期" min-width="132" align="right" show-overflow-tooltip>
              <template #default="scope">{{ amount(scope.row.metrics[metric.key].priorYearSameMonth) }}</template>
            </el-table-column>
            <el-table-column :column-value="row => row.metrics[metric.key].currentYearToDate.value" label="本年累计" min-width="132" align="right" show-overflow-tooltip>
              <template #default="scope"><span :class="{ incomplete: !scope.row.metrics[metric.key].currentYearToDate.complete }">{{ amount(scope.row.metrics[metric.key].currentYearToDate.value) }}</span></template>
            </el-table-column>
            <el-table-column :column-value="row => row.metrics[metric.key].cumulativeTarget" label="累计目标" min-width="132" align="right" show-overflow-tooltip>
              <template #default="scope">{{ amount(scope.row.metrics[metric.key].cumulativeTarget) }}</template>
            </el-table-column>
            <el-table-column :column-value="row => row.metrics[metric.key].cumulativeCompletionRate" label="完成率" min-width="120" align="right">
              <template #default="scope">{{ percent(scope.row.metrics[metric.key].cumulativeCompletionRate) }}</template>
            </el-table-column>
            <el-table-column :column-value="row => row.metrics[metric.key].yearOverYearChange" label="同比" min-width="120" align="right">
              <template #default="scope">{{ percent(scope.row.metrics[metric.key].yearOverYearChange) }}</template>
            </el-table-column>
            <el-table-column :column-value="row => row.metrics[metric.key].currentYearToDate.monthsAvailable + '/' + row.metrics[metric.key].currentYearToDate.monthsExpected" label="月份完整" min-width="120" align="center">
              <template #default="scope"><el-tag size="small" :type="scope.row.metrics[metric.key].currentYearToDate.complete ? 'success' : 'warning'">{{ scope.row.metrics[metric.key].currentYearToDate.monthsAvailable }}/{{ scope.row.metrics[metric.key].currentYearToDate.monthsExpected }}</el-tag></template>
            </el-table-column>
          </el-table-column>
          <el-table-column :column-value="row => row.sourceRevisions.length" label="来源修订" min-width="190" align="left">
            <template #default="scope">
              <el-popover trigger="click" placement="top" :width="300" popper-class="monthly-reference-popover">
                <template #reference><el-button link class="revision-trace" :aria-label="`查看${scope.row.organizationName}的来源修订`">{{ scope.row.sourceRevisions.length }} 个月 · 查看 ID</el-button></template>
                <div class="revision-popover-body">
                  <p class="revision-title">{{ scope.row.organizationName }} · 来源修订</p>
                  <ul v-if="scope.row.sourceRevisions.length" class="revision-list">
                    <li v-for="source in scope.row.sourceRevisions" :key="`${source.periodCode}-${source.revisionId}`"><span>{{ source.periodCode }}</span><strong>#{{ source.revisionId }}</strong></li>
                  </ul>
                  <p v-else class="revision-content">{{ revisionTrace(scope.row) }}</p>
                </div>
              </el-popover>
            </template>
          </el-table-column>
          <el-table-column :column-value="row => row.totalScore" label="总分" width="120" align="right"><template #default="scope">{{ amount(scope.row.totalScore) }}</template></el-table-column>
          <el-table-column :column-value="row => row.rank" label="排名" width="120" align="center"><template #default="scope">{{ scope.row.rank ?? '—' }}</template></el-table-column>
          <template #empty>该期间没有可展示的组织明细，请检查参与组织配置。</template>
        </app-data-table>
      </section>
    </section>

    <el-empty v-else-if="!loading && !reportError && !typesError && !versionsError && !versionsLoading && typesReady && reportTypes.length" description="选择报表类型、报告月份和配置版本后生成汇总" :image-size="110" />
  </main>
</template>

<script>
import { defineAsyncComponent } from 'vue'
import { monthlyReferenceReportApi, periodConfigurationApi } from '@/api'
import { validMonthlyPeriod, monthlyNumber, readMonthlyReport, monthlyError } from '@/utils/monthlyReferenceState'
import '@/styles/monthly-reference-adaptation.css'

const numeric = monthlyNumber
const amountFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

export default {
  name: 'MonthlyReferenceReport',
  components: { ReportStudio: defineAsyncComponent(() => import('./ReportStudio.vue')) },
  data() {
    const now = new Date()
    return { reportTypes: [], reportTypeId: null, periodCode: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      report: null, loadedQuery: null, loading: false, exporting: false,
      typesLoading: false, typesReady: false, typesError: '', reportError: '', exportError: '',
      versions: [], configurationPackageId: null, versionsLoading: false, versionsReady: false, versionsError: '', versionScope: '',
      metricDefinitions: [{ key: 'revenue', label: '营业收入' }, { key: 'profit', label: '利润总额' }] }
  },
  created() { this._alive = true; this._session = 0; this._versionRequest = 0 },
  mounted() { if (this.standardView) this.loadReportTypes() },
  beforeUnmount() { this._alive = false; this.cancelPending() },
  watch: {
    standardView(value) { this.cancelPending(); if (value) { if (!this.typesReady) this.loadReportTypes(); else this.loadVersions() } },
    reportTypeId() { this.loadVersions() },
    periodCode() { this.loadVersions() }
  },
  computed: {
    canQuery() { return validMonthlyPeriod(this.periodCode) && this.reportTypes.some(type => type.id === this.reportTypeId) && !this.typesLoading && !this.typesError
      && this.versionsReady && !this.versionsLoading && !this.versionsError && this.versionScope === `${this.reportTypeId}:${this.periodCode}`
      && this.versions.some(version => version.id === this.configurationPackageId) },
    queryChanged() { return !!this.report && (this.periodCode !== this.loadedQuery?.periodCode || this.reportTypeId !== this.loadedQuery?.reportTypeId || this.configurationPackageId !== this.loadedQuery?.configurationPackageId) },
    reportMonthLabel() { return validMonthlyPeriod(this.report?.periodCode) ? `${this.report.periodCode.slice(5)}月` : '本月' },
    standardView() { return this.$route.query.view === 'standard' },
    isSyntheticDemo() { return this.report?.source === 'DEMO_SYNTHETIC_ONLY' },
    singleOrganization() { return this.report?.rows?.length === 1 ? this.report.rows[0] : null },
    summaryMetrics() { return this.singleOrganization?.metrics || this.report?.totals },
    summaryScope() {
      return this.singleOrganization
        ? `${this.singleOrganization.organizationName} · 单组织累计（来源：有效定稿修订）`
        : '配置范围组织合计'
    }
  },
  methods: {
    cancelPending() {
      this._session++
      this._typeController?.abort(); this._reportController?.abort()
      this._versionRequest++; this._versionController?.abort(); this.versionsLoading = false; this.versionsReady = false
      this.typesLoading = false; this.loading = false
    },
    async loadVersions() {
      const request = ++this._versionRequest, session = this._session
      this._versionController?.abort()
      this.versions = []; this.configurationPackageId = null; this.versionsError = ''; this.versionsReady = false; this.versionsLoading = false; this.versionScope = ''
      if (!this._alive || !this.standardView || !validMonthlyPeriod(this.periodCode) || !this.reportTypes.some(type => type.id === this.reportTypeId)) return
      const period = this.periodCode, type = this.reportTypeId, controller = new AbortController()
      const current = () => this._alive && session === this._session && request === this._versionRequest && period === this.periodCode && type === this.reportTypeId
      this._versionController = controller; this.versionsLoading = true
      const timeout = setTimeout(() => controller.abort(), 30000)
      try {
        const response = await monthlyReferenceReportApi.getVersions(period, type, { signal: controller.signal })
        if (!current()) return
        if (!Array.isArray(response?.versions) || response.versions.some(version => !version || !Number.isSafeInteger(version.id) || version.id < 1 || !Number.isSafeInteger(version.version) || version.version < 1)) throw new Error('配置版本数据不完整，请重新加载。')
        this.versions = response.versions; this.versionsReady = true; this.versionScope = `${type}:${period}`
        if (this.versions.length === 1) this.configurationPackageId = this.versions[0].id
      } catch (error) { if (current()) this.versionsError = monthlyError(error, '配置版本加载失败，请重试。') }
      finally { clearTimeout(timeout); if (request === this._versionRequest) this.versionsLoading = false }
    },
    async loadReportTypes() {
      if (this.typesLoading || !this._alive) return
      const session = this._session, controller = new AbortController()
      this._typeController = controller; this.typesLoading = true; this.typesError = ''
      const timeout = setTimeout(() => controller.abort(), 30000)
      try {
        const response = await periodConfigurationApi.getReportTypes({ signal: controller.signal })
        if (!this._alive || session !== this._session) return
        if (!Array.isArray(response?.reportTypes) || response.reportTypes.some(item => !item || item.id == null || typeof item.displayName !== 'string')) throw new Error('报表类型数据不完整，请重新加载。')
        this.reportTypes = response.reportTypes.filter(item => item.cadence === 'monthly')
        this.typesReady = true
        if (!this.reportTypes.some(item => item.id === this.reportTypeId)) this.reportTypeId = null
        if (this.reportTypes.length === 1) this.reportTypeId = this.reportTypes[0].id
      } catch (error) { if (this._alive && session === this._session) this.typesError = monthlyError(error, '报表类型加载失败，请重试。') }
      finally { clearTimeout(timeout); if (session === this._session) this.typesLoading = false }
    },
    summaryMissingReason(metric) {
      const row = this.singleOrganization
      if (!row && !this.report.consolidationAvailable) return '尚未配置组织合并口径，请查看下方各组织明细。'
      if (row && !row.reportRevisionId) return '本期尚无有效定稿，请先完成审核和正式定稿，再生成报表。'
      const total = this.summaryMetrics[metric].currentYearToDate
      if (total.complete) return ''
      if (row && this.summaryMetrics[metric].currentMonth == null) {
        return `当前定稿修订 #${row.reportRevisionId} 缺少可用的本月${metric === 'revenue' ? '营业收入' : '利润总额'}值；请核对定稿数据及字段映射。`
      }
      return row ? `累计所需月份不完整（${total.monthsAvailable}/${total.monthsExpected} 月），请补齐缺失月份的定稿数据。`
        : '部分组织的定稿数据不完整，请查看下方各组织明细。'
    },
    async loadReport() {
      if (!this.canQuery || this.loading || this.exporting || !this._alive) return
      const query = { periodCode: this.periodCode, reportTypeId: this.reportTypeId, configurationPackageId: this.configurationPackageId }
      const session = this._session, controller = new AbortController()
      this._reportController = controller; this.loading = true; this.reportError = ''; this.exportError = ''
      const timeout = setTimeout(() => controller.abort(), 30000)
      try {
        const response = await monthlyReferenceReportApi.getReport(query.periodCode, query.reportTypeId, { signal: controller.signal, configurationPackageId: query.configurationPackageId })
        if (!this._alive || session !== this._session) return
        this.report = readMonthlyReport(response, query); this.loadedQuery = query
      } catch (error) { if (this._alive && session === this._session) this.reportError = monthlyError(error, '报表加载失败，请检查网络后重试。') }
      finally { clearTimeout(timeout); if (session === this._session) this.loading = false }
    },
    amount(value) { const number = numeric(value); return number == null ? '—' : amountFormatter.format(number) },
    percent(value) { const number = numeric(value); return number == null ? '—' : `${(number * 100).toFixed(2)}%` },
    progressValue(value) { const number = numeric(value); return number == null ? 0 : Math.max(0, Math.min(100, number * 100)) },
    revisionTrace(row) {
      const sources = row.sourceRevisions || []
      if (!sources.length) return '没有匹配到可用于本年累计计算的当前有效定稿修订。'
      return sources.map(source => `${source.periodCode} #${source.revisionId}`).join('；')
    },
    saveBlob(blob, extension, periodCode) {
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `月度参考报表-${periodCode}.${extension}`; anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    async download(type) {
      if (!['pdf', 'xlsx'].includes(type) || !this._alive || this.loading || this.exporting || !this.report?.rows.length) return
      const report = JSON.parse(JSON.stringify(this.report)), session = this._session
      const assertActive = () => { if (!this._alive || session !== this._session) throw new Error('导出已取消') }
      this.exporting = type; this.exportError = ''
      try {
        const { exportMonthlyReference } = await import('@/utils/monthlyReferenceExport')
        assertActive()
        const blob = await exportMonthlyReference(report, type, {
          amount: this.amount, percent: this.percent, revisionTrace: this.revisionTrace,
          metricDefinitions: this.metricDefinitions
        }, assertActive)
        assertActive()
        this.saveBlob(blob, type, report.periodCode)
      } catch (error) {
        if (this._alive && session === this._session) this.exportError = error?.errorMessage || error?.message || '请稍后重试。'
      } finally { this.exporting = false }
    }
  }
}
</script>

<style scoped>
.reference-page { --ink: #2c1b26; --muted: #6d5a65; --line: #e8d9e1; --paper: #fbfcfa; min-height: 100%; padding: 30px clamp(18px, 3vw, 44px) 42px; color: var(--ink); background: radial-gradient(ellipse at 92% 0%, rgba(194, 218, 205, .36), transparent 34%), #f3f6f2; }
.page-head { display: flex; align-items: end; justify-content: space-between; gap: 24px; padding: 12px 0 24px; border-bottom: 1px solid var(--line); }
h1, h2, p { margin-top: 0; }
h1 { margin-bottom: 8px; font-size: clamp(25px, 3vw, 34px); }
.lede { max-width: 640px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.7; }
.period-controls { display: flex; align-items: end; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
.query-field { display: grid; gap: 6px; min-width: 0; width: 240px; max-width: 100%; }
.query-field label { color: var(--portal-muted); font-size: 14px; }
.query-field :deep(.el-select), .query-field :deep(.el-date-editor.el-input) { width: 100%; }
.report-feedback { margin-top: 16px; overflow-wrap: anywhere; }
.report-feedback:empty { display: none; }
.report-feedback > * + * { margin-top: 12px; }
.report-feedback p { margin-bottom: 8px; }
.report-feedback :deep(.el-alert__content) { min-width: 0; }
.report-feedback :deep(.el-alert--error) { color: #a12731; background: #fff1f0; }
.report-feedback :deep(.el-alert--error .el-alert__description) { color: inherit; }
.feedback-line { display: block; margin-bottom: 8px; }
.report-body { padding-top: 20px; }
.report-meta > div, .total-card { min-width: 0; overflow-wrap: anywhere; }
.total-foot { flex-wrap: wrap; gap: 8px; }
.revision-content { white-space: normal; overflow-wrap: anywhere; line-height: 1.6; }
.revision-title { color: #2c1b26; font-weight: 600; line-height: 1.6; }
.revision-list { list-style: none; margin: 12px 0 0; padding: 0; font-variant-numeric: tabular-nums; }
.revision-list li { display: flex; justify-content: space-between; gap: 16px; padding-block: 8px; border-top: 1px solid #e8d9e1; }
.revision-list strong { font-weight: 600; }
.revision-trace:focus-visible { outline: 2px solid var(--portal-focus); outline-offset: 2px; }
.report-meta { display: flex; align-items: center; gap: 34px; min-height: 56px; padding: 0 2px 20px; }
.report-meta > div:not(.export-actions) { display: grid; gap: 4px; }
.meta-label { color: var(--portal-muted); font-size:12px; }
.report-meta strong { font-size: 14px; }
.report-meta small { color: var(--portal-muted); font-weight: 400; }
.export-actions { margin-left: auto; display: flex; gap: 8px; }
.rule-note { margin: 0 0 18px; border: 1px solid #d5e2e1; background: rgba(255,255,255,.75); }
.demo-note { margin: 0 0 18px; }
.traceability-shell { margin: 0 0 20px; padding: 16px 18px 18px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.82); }
.revision-trace { color: #35665d; text-decoration: underline dotted; text-underline-offset: 3px; cursor: pointer; }
.metric-totals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 20px; }
.summary-scope { color: var(--muted); font-size: 13px; margin-bottom: 10px; }
.missing-reason { color: #87531e; font-size: 13px; line-height: 1.6; margin-bottom: 12px; }
.total-card { padding: 18px 20px 14px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.9); box-shadow: 0 7px 22px rgba(25, 62, 49, .035); }
.total-heading, .total-foot { display: flex; align-items: center; justify-content: space-between; color: var(--muted); }
.total-heading { margin: 0 0 12px; font-size: 14px; font-weight: 600; line-height: 1.5; }
.total-card > strong { display: block; margin-bottom: 9px; font-size: 27px; font-variant-numeric: tabular-nums; letter-spacing: -.04em; }
.total-foot { margin-bottom: 12px; font-size:12px; }
.table-shell { padding: 18px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); box-shadow: 0 8px 24px rgba(25, 62, 49, .035); }
.table-heading { display: flex; align-items: end; justify-content: space-between; padding: 0 0 14px; }
.table-heading h2 { margin: 0; font-size: 18px; }
.unit-label { color: var(--portal-muted); font-size:12px; }
.report-table { --el-table-header-bg-color: #eaf1ed; --el-table-header-text-color: #36534d; --el-table-border-color: #dfe7e2; --el-table-row-hover-bg-color: #f3f8f4; }
.incomplete { color: #87531e; font-weight: 600; }
.report-table, .report-meta, .total-foot { font-variant-numeric: tabular-nums; }
.report-table :deep(td.is-right .cell) { white-space: nowrap; }
.report-table :deep(.el-tag--warning) { --el-tag-text-color: #87531e; }
.report-table :deep(.el-tag--success) { --el-tag-text-color: #236449; }
.demo-note.el-alert--warning.is-light { color: #87531e; --el-alert-bg-color: #fff8ed; }
.rule-note.el-alert--info.is-light { color: var(--portal-muted); background: var(--portal-surface); }
.demo-note :deep(.el-alert__description), .rule-note :deep(.el-alert__description) { color: inherit; }
.reference-page :deep(.el-button:focus-visible) { outline: 2px solid var(--portal-focus); outline-offset: 3px; }
.reference-page :deep(.el-button--primary:not(.is-disabled)) { --el-button-bg-color: var(--portal-focus); --el-button-border-color: var(--portal-focus); --el-button-hover-bg-color: #7a1454; --el-button-hover-border-color: #7a1454; --el-button-active-bg-color: #6f114b; --el-button-active-border-color: #6f114b; }
.reference-page :deep(.el-button--primary.is-plain:not(.is-disabled)) { --el-button-text-color: var(--portal-focus); --el-button-bg-color: var(--portal-accent-surface); }
@media (max-width: 1020px) { .page-head { align-items: start; flex-direction: column; } .period-controls { justify-content: flex-start; } }
@media (max-width: 700px) { .report-meta { align-items: start; gap: 16px; flex-wrap: wrap; } .export-actions { width: 100%; margin-left: 0; } .metric-totals { grid-template-columns: 1fr; } .table-shell, .traceability-shell { padding: 12px; } }
</style>
