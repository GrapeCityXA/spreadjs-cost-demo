<template>
  <main class="export-page portal-workbench">
    <section class="page-intro">
      <div>
        <h1>原始数据与批量导出</h1>
        <p class="intro-copy">下载原始字段明细（XLSX），或创建后台任务，将周期数据、定稿报表和附件打包为 ZIP。</p>
      </div>
      <p class="intro-note">数据保留方式：<strong>原值 · 可追溯</strong><span>每条记录保留字段、修订与来源坐标</span></p>
    </section>

    <el-alert v-if="errorText" class="page-alert" :title="errorText" type="error" show-icon :closable="false"><el-button :loading="loadingPeriods" @click="refreshPage">重新加载周期与公司</el-button></el-alert>
    <p v-if="loadingPeriods" class="scope-help" role="status">正在读取可导出的周期…</p>
    <p v-else-if="periodsLoaded && !periods.length && !errorText" class="scope-help" role="status">暂无可导出的周期。请联系管理员确认周期配置与数据访问权限。</p>

    <section class="export-grid">
      <article class="work-panel raw-panel">
        <h2>下载原始数据 XLSX</h2>
        <p class="panel-copy">每行对应一个字段值，保留字段编码、数据类型、单位、精度和填报来源。包含已提交过的历史修订，并非仅最新或已定稿数据。</p>
        <div class="form-row" role="group" aria-labelledby="raw-period-label" aria-describedby="raw-scope-help">
          <label id="raw-period-label" for="raw-period">周期与报告</label>
          <el-select id="raw-period" v-model="rawPackageId" filterable fit-input-width popper-class="export-select-menu" placeholder="选择周期与报告类型" :loading="loadingPeriods" :disabled="blocked || loadingPeriods || rawLoading || !periods.length" @change="loadOrganizations">
            <el-option v-for="item in periods" :key="item.packageId" :label="packageLabel(item)" :value="item.packageId" />
          </el-select>
        </div>
        <p id="raw-scope-help" class="scope-help">XLSX 按周期、报告类型和公司导出，不按配置版本筛选。<template v-if="canManageBulk">所选配置版本仅用于列出下方参与公司。</template></p>
        <div v-if="canManageBulk" class="form-row organization-filter" role="group" aria-labelledby="raw-company-label" aria-describedby="raw-company-help">
          <label id="raw-company-label" for="raw-organization">参与公司</label>
          <el-select id="raw-organization" v-model="organizationId" filterable clearable fit-input-width popper-class="export-select-menu" placeholder="全部授权公司" :loading="loadingOrganizations" :disabled="blocked || rawLoading || loadingPeriods || !organizationsReady">
            <el-option v-for="item in organizations" :key="item.id" :label="`${item.name} · ${item.code}`" :value="item.id" />
          </el-select>
        </div>
        <p v-if="canManageBulk" id="raw-company-help" class="scope-help">留空导出该周期、报告类型下的全部授权公司；选择公司后仅导出该公司。</p>
        <el-alert v-if="organizationError" :title="organizationError" type="error" :closable="false" show-icon><el-button :loading="loadingOrganizations" :disabled="blocked || loadingPeriods" @click="loadOrganizations">重试加载公司</el-button></el-alert>
        <el-alert v-if="rawError" :title="rawError" type="error" :closable="false" show-icon />
        <ul class="field-inventory" aria-label="原始数据包含的信息">
          <li>字段编码与显示名称</li>
          <li>来源公式、命名区域与坐标</li>
          <li>历史修订与提交人</li>
        </ul>
        <div class="panel-actions"><el-button type="primary" :disabled="!rawReady" :loading="rawLoading" @click="downloadRaw">
          <el-icon><Download /></el-icon>下载原始数据 XLSX
        </el-button></div>
      </article>

      <article v-if="canManageBulk" class="work-panel package-panel">
        <h2>生成周期 ZIP 包</h2>
        <p class="panel-copy">按所选配置版本打包各公司数据，包含原始数据、已有的定稿报表及已提交修订的附件。任务在后台处理。</p>
        <div class="form-row" role="group" aria-labelledby="package-period-label" aria-describedby="package-scope-help">
          <label id="package-period-label" for="package-period">配置版本</label>
          <el-select id="package-period" v-model="bulkPackageId" filterable fit-input-width popper-class="export-select-menu" placeholder="选择周期、报告类型与配置版本" :loading="loadingPeriods" :disabled="blocked || loadingPeriods || mutationBusy || !periods.length">
            <el-option v-for="item in periods" :key="item.packageId" :label="packageLabel(item)" :value="item.packageId" />
          </el-select>
        </div>
        <p id="package-scope-help" class="scope-help">包含此配置版本下的各公司，不受 XLSX 的公司筛选影响。创建后可离开页面，稍后返回下载。</p>
        <div class="package-preview">
          <div class="preview-icon"><el-icon><Files /></el-icon></div>
          <div><b>按公司分目录</b><span>原始数据 / 已有定稿报表 / 修订附件</span></div>
          <span class="zip-badge">ZIP</span>
        </div>
        <el-alert v-if="createError" :title="createError" type="error" :closable="false" show-icon><p>请先刷新下方任务列表，确认是否已创建任务，再决定是否重试。</p></el-alert>
        <div class="panel-actions"><el-button type="primary" :disabled="blocked || loadingPeriods || !!errorText || mutationBusy || !bulkPackageId" :loading="creating" @click="createPackage">
          <el-icon><FolderOpened /></el-icon>创建后台导出任务
        </el-button></div>
      </article>
    </section>

    <section v-if="canManageBulk" class="work-panel jobs-panel">
      <header class="jobs-heading">
        <div><h2>导出任务</h2><p class="scope-help">显示最近 100 条任务。重试会新建任务，沿用原任务的数据范围。</p></div>
        <el-button plain :disabled="blocked || mutationBusy" :loading="loadingJobs" @click="loadJobs"><el-icon><Refresh /></el-icon>刷新状态</el-button>
      </header>
      <el-alert v-if="jobsError" :title="jobsError" type="error" show-icon :closable="false"><p>{{ jobsLoaded ? '当前保留上次读取的任务，请点击“刷新状态”重试。' : '任务列表尚未读取成功，请点击“刷新状态”重试。' }}</p></el-alert>
      <p v-if="loadingJobs && !jobsLoaded" class="scope-help" role="status">正在读取导出任务…</p>
      <div v-if="jobs.length" class="job-list">
        <article v-for="job in visibleJobs" :key="job.id" class="job-row">
          <div class="job-main">
            <div class="job-title"><b>{{ job.periodCode }} · {{ job.reportType }} 周期数据包</b><el-tag size="small" effect="plain" :type="statusType(job.status)">{{ statusText(job.status) }}</el-tag></div>
            <div class="job-meta"><span>任务 #{{ job.id }}</span><span>创建于 <time>{{ formatDate(job.createdAt) }}</time><span class="timezone">（北京时间）</span></span></div>
            <el-progress v-if="['queued', 'running'].includes(job.status)" :aria-label="`任务 ${job.id} 生成进度`" :percentage="progressValue(job.progress)" :stroke-width="5" :show-text="false" />
            <small v-if="jobErrors[job.id]" class="job-error" role="alert">{{ jobErrors[job.id] }}</small>
            <small v-if="job.error" class="job-error">{{ job.error }}</small>
            <small v-else-if="job.expiresAt && job.status === 'complete'" class="expiry-note">可下载至 <time>{{ formatDate(job.expiresAt) }}</time><span class="timezone">（北京时间）</span></small>
            <small v-else-if="job.status === 'expired'" class="expiry-note">下载已过期，请在上方重新创建导出任务。</small>
          </div>
          <div class="job-actions">
            <el-button v-if="job.status === 'complete'" type="primary" plain :disabled="blocked" :loading="!!downloading[job.id]" :aria-label="`下载任务 ${job.id} 的 ZIP`" @click="downloadJob(job)"><el-icon><Download /></el-icon>下载 ZIP</el-button>
            <el-button v-else-if="job.status === 'failed'" type="warning" plain :disabled="blocked || mutationBusy" :loading="retrying === job.id" :aria-label="`重试生成任务 ${job.id}`" @click="retryJob(job)">重试生成</el-button>
            <span v-else-if="job.status === 'queued'" class="running-note">等待后台处理</span>
            <span v-else-if="job.status === 'running'" class="running-note">正在整理周期资料</span>
          </div>
        </article>
      </div>
      <div v-else-if="jobsLoaded && !loadingJobs && !jobsError" class="empty-jobs"><b>暂无导出任务</b><span>在上方选择配置版本，再点击“创建后台导出任务”。</span></div>
    </section>

    <footer class="retention-note"><el-icon class="retention-mark" aria-hidden="true"><InfoFilled /></el-icon><span>ZIP 包生成成功后可下载 7 天，请在到期前下载保存。导出与下载操作会记录在业务审计中。</span></footer>
  </main>
</template>

<script>
import { Download, Files, FolderOpened, Refresh, InfoFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { originalDataExportApi } from '@/api'
import { readSessionUser, subscribeSessionUser } from '@/utils/authSession'
import { canManageExports, exportJobState, exportTimestamp, formatExportDate, exportErrorMessage } from '@/utils/originalDataExportState'
import '@/styles/original-data-export-hardening.css'
import '@/styles/original-data-export-layout.css'

export default {
  name: 'OriginalDataExportWorkbench',
  components: { Download, Files, FolderOpened, Refresh, InfoFilled },
  data() {
    return { periods: [], rawPackageId: null, bulkPackageId: null, jobs: [], loadingPeriods: false, loadingJobs: false,
      rawLoading: false, creating: false, retrying: null, errorText: '', pollTimer: null, periodsLoaded: false, jobsLoaded: false, jobsError: '',
      organizations: [], organizationId: null, loadingOrganizations: false, organizationsReady: false, organizationError: '',
      rawError: '', createError: '', jobErrors: {}, downloading: {}, requests: {}, disposed: false, blocked: false, epoch: 0,
      sessionUser: readSessionUser(), now: Date.now(), clockTimer: null }
  },
  computed: {
    canManageBulk() { return canManageExports(this.sessionUser) },
    mutationBusy() { return this.creating || this.retrying != null },
    rawReady() { return !this.blocked && !this.errorText && !this.loadingPeriods && !this.loadingOrganizations && this.organizationsReady && !!this.rawPackageId && !this.rawLoading },
    visibleJobs() { return this.jobs.map(job => ({ ...job, status: exportJobState(job, this.now) })) }
  },
  mounted() {
    this.unsubscribeSession = subscribeSessionUser(user => {
      if (JSON.stringify(user) === JSON.stringify(this.sessionUser)) return
      this.sessionUser = user; this.epoch++; this.cancelRequests(); this.clearData()
      this.creating = false; this.retrying = null
      this.refreshPage()
    })
    this.refreshPage()
    document.addEventListener('visibilitychange', this.onVisibilityChange)
  },
  beforeUnmount() {
    this.disposed = true; this.epoch++; this.cancelRequests()
    this.unsubscribeSession?.(); document.removeEventListener('visibilitychange', this.onVisibilityChange)
  },
  methods: {
    beginRequest(key, timeout = 20000) {
      this.cancelRequest(key)
      const request = { controller: new AbortController(), timedOut: false }
      request.timer = setTimeout(() => { request.timedOut = true; request.controller.abort() }, timeout)
      this.requests[key] = request
      return request
    },
    isCurrent(key, request) { return !this.disposed && this.requests[key]?.controller === request.controller },
    cancelRequest(key) {
      const request = this.requests[key]
      if (request) { clearTimeout(request.timer); request.controller.abort(); delete this.requests[key] }
    },
    finishRequest(key, request) {
      clearTimeout(request.timer)
      if (this.requests[key]?.controller === request.controller) delete this.requests[key]
    },
    stopPolling() { clearTimeout(this.pollTimer); this.pollTimer = null },
    stopExpiryTimer() { clearTimeout(this.clockTimer); this.clockTimer = null },
    scheduleExpiry() {
      this.stopExpiryTimer()
      if (this.disposed || this.blocked || !this.canManageBulk || document.visibilityState === 'hidden') return
      this.now = Date.now()
      let nextExpiry = Infinity
      for (const job of this.jobs) {
        if (job.status !== 'complete') continue
        const expiry = exportTimestamp(job.expiresAt)
        if (expiry > this.now) nextExpiry = Math.min(nextExpiry, expiry)
      }
      // Only wake when a download expires; cap delays at the browser timer limit.
      if (Number.isFinite(nextExpiry)) this.clockTimer = setTimeout(() => this.scheduleExpiry(), Math.min(nextExpiry - this.now, 2147483647))
    },
    cancelRequests() {
      this.stopPolling(); this.stopExpiryTimer(); Object.keys(this.requests).forEach(key => this.cancelRequest(key))
      this.loadingPeriods = false; this.loadingOrganizations = false; this.loadingJobs = false; this.rawLoading = false; this.downloading = {}
    },
    clearData() {
      this.periods = []; this.organizations = []; this.jobs = []; this.rawPackageId = null; this.bulkPackageId = null; this.organizationId = null
      this.periodsLoaded = false; this.jobsLoaded = false; this.organizationsReady = false
      this.organizationError = ''; this.rawError = ''; this.createError = ''; this.jobErrors = {}; this.jobsError = ''
    },
    denyAccess(error) {
      if (![401, 403].includes(error?.status)) return
      this.blocked = true; this.epoch++; this.cancelRequests(); this.clearData()
      this.errorText = exportErrorMessage(error)
    },
    requestError(error, request, fallback) {
      return request?.timedOut ? '请求超时，请重试。' : exportErrorMessage(error, fallback)
    },
    async refreshPage() {
      const loadJobsInParallel = !this.blocked && this.canManageBulk
      await Promise.all([this.loadPeriods(), loadJobsInParallel ? this.loadJobs() : Promise.resolve()])
      // A successful permission retry may have unblocked the page.
      if (!loadJobsInParallel && !this.disposed && !this.blocked && this.canManageBulk) await this.loadJobs()
    },
    async loadPeriods() {
      if (this.disposed) return
      const request = this.beginRequest('periods')
      this.cancelRequest('organizations'); this.loadingOrganizations = false; this.organizationsReady = false
      this.loadingPeriods = true; this.errorText = ''
      try {
        const response = await originalDataExportApi.getPeriods(request.controller.signal)
        if (!this.isCurrent('periods', request)) return
        if (!Array.isArray(response?.periods) || response.periods.some(item => !item?.packageId)) throw new Error('周期数据格式异常，请重新加载。')
        clearTimeout(request.timer)
        this.periods = response.periods; this.periodsLoaded = true; this.blocked = false
        this.rawPackageId = this.periods.some(item => item.packageId === this.rawPackageId) ? this.rawPackageId : this.periods[0]?.packageId ?? null
        this.bulkPackageId = this.periods.some(item => item.packageId === this.bulkPackageId) ? this.bulkPackageId : this.periods[0]?.packageId ?? null
        await this.loadOrganizations()
      } catch (error) {
        if (this.isCurrent('periods', request)) { this.denyAccess(error); this.errorText = this.requestError(error, request, '读取周期失败，请重试。') }
      } finally { if (this.isCurrent('periods', request)) this.loadingPeriods = false; this.finishRequest('periods', request) }
    },
    async loadOrganizations() {
      if (this.disposed) return
      const request = this.beginRequest('organizations')
      this.organizationsReady = false; this.organizationId = null; this.organizations = []; this.organizationError = ''; this.rawError = ''
      this.loadingOrganizations = true
      try {
        if (!this.rawPackageId) return
        const response = await originalDataExportApi.getOrganizations(this.rawPackageId, request.controller.signal)
        if (!this.isCurrent('organizations', request)) return
        if (!Array.isArray(response?.organizations) || response.organizations.some(item => !item?.id)) throw new Error('公司数据格式异常，请重新加载。')
        this.organizations = response.organizations; this.organizationsReady = true
      } catch (error) {
        if (this.isCurrent('organizations', request)) { this.denyAccess(error); this.organizationError = this.requestError(error, request, '读取参与公司失败，请重试。') }
      } finally { if (this.isCurrent('organizations', request)) this.loadingOrganizations = false; this.finishRequest('organizations', request) }
    },
    async loadJobs() {
      if (this.disposed || this.blocked || this.mutationBusy || !this.canManageBulk) return
      this.stopPolling()
      const request = this.beginRequest('jobs')
      this.loadingJobs = true; this.jobsError = ''
      try {
        const response = await originalDataExportApi.getJobs(request.controller.signal)
        if (!this.isCurrent('jobs', request)) return
        if (!Array.isArray(response?.jobs) || response.jobs.some(item => !item?.id)) throw new Error('任务数据格式异常，请刷新状态。')
        this.jobs = response.jobs; this.jobsLoaded = true; this.scheduleExpiry()
      } catch (error) {
        if (this.isCurrent('jobs', request)) { this.denyAccess(error); this.jobsError = this.requestError(error, request, '读取导出任务失败') }
      } finally {
        if (this.isCurrent('jobs', request)) { this.loadingJobs = false; this.startPolling() }
        this.finishRequest('jobs', request)
      }
    },
    async downloadRaw() {
      if (!this.rawReady || this.disposed) return
      const selected = this.periods.find(item => item.packageId === this.rawPackageId)
      if (!selected || (this.organizationId != null && !this.organizations.some(org => org.id === this.organizationId))) return
      this.rawLoading = true; this.rawError = ''
      const request = this.beginRequest('raw', 120000)
      const params = { periodCode: selected.periodCode, reportTypeId: selected.reportTypeId }
      if (this.organizationId != null) params.organizationId = String(this.organizationId)
      try {
        const blob = await originalDataExportApi.downloadRawData(params, request.controller.signal)
        if (!this.isCurrent('raw', request)) return
        this.saveBlob(blob, `原始数据-${selected.periodCode}-${selected.reportTypeId}.xlsx`)
        ElMessage.success('已发起 XLSX 下载，请在浏览器下载列表查看')
      } catch (error) {
        if (this.isCurrent('raw', request)) { this.denyAccess(error); this.rawError = this.requestError(error, request, '原始数据导出失败，请重试。') }
      } finally { if (this.isCurrent('raw', request)) this.rawLoading = false; this.finishRequest('raw', request) }
    },
    async createPackage() { await this.submitJob() },
    async retryJob(job) { if (job?.status === 'failed') await this.submitJob(job) },
    async submitJob(job) {
      if (this.disposed || this.blocked || !this.canManageBulk || this.mutationBusy || this.loadingPeriods || (!job && (this.errorText || !this.periods.some(item => item.packageId === this.bulkPackageId)))) return
      const epoch = this.epoch
      const request = this.beginRequest('mutation', 30000)
      if (job) { this.retrying = job.id; delete this.jobErrors[job.id] } else { this.creating = true; this.createError = '' }
      this.stopPolling(); this.cancelRequest('jobs'); this.loadingJobs = false
      try {
        const result = job ? await originalDataExportApi.retryJob(job.id, request.controller.signal) : await originalDataExportApi.createJob(this.bulkPackageId, request.controller.signal)
        if (this.disposed || this.epoch !== epoch) return
        if (!result?.job?.id) throw new Error('未能确认任务结果，请先刷新任务列表，避免重复创建。')
        this.jobs = [result.job, ...this.jobs.filter(item => item.id !== result.job.id)]; this.jobsLoaded = true; this.jobsError = ''
        this.scheduleExpiry()
        ElMessage.success('导出任务已创建，可在任务列表查看进度')
      } catch (error) {
        if (!this.disposed && this.epoch === epoch) {
          this.denyAccess(error)
          const message = `${this.requestError(error, request, '未能确认任务结果。')} 请先刷新任务列表，确认结果后再重试。`
          if (job) this.jobErrors[job.id] = message; else this.createError = message
        }
      } finally {
        this.finishRequest('mutation', request)
        if (!this.disposed && this.epoch === epoch) { this.creating = false; this.retrying = null; this.startPolling() }
        else if (this.blocked) { this.creating = false; this.retrying = null }
      }
    },
    async downloadJob(job) {
      if (this.disposed || this.blocked || !this.canManageBulk || this.downloading[job.id] || exportJobState(job) !== 'complete') return
      this.downloading[job.id] = true; delete this.jobErrors[job.id]
      const key = `download:${job.id}`, request = this.beginRequest(key, 120000)
      try {
        const blob = await originalDataExportApi.downloadJob(job.id, request.controller.signal)
        if (!this.isCurrent(key, request)) return
        this.saveBlob(blob, `周期导出-${job.periodCode}.zip`); ElMessage.success('已发起 ZIP 下载，请在浏览器下载列表查看')
      } catch (error) {
        if (this.isCurrent(key, request)) {
          if (error.status === 410) job.status = 'expired'
          this.denyAccess(error); this.jobErrors[job.id] = this.requestError(error, request, '下载失败，请重试。')
          if (error.status === 410) {
            this.jobs = this.jobs.map(item => item.id === job.id ? { ...item, status: 'expired' } : item)
            this.scheduleExpiry()
          }
        }
      } finally { if (this.isCurrent(key, request)) delete this.downloading[job.id]; this.finishRequest(key, request) }
    },
    startPolling() {
      this.stopPolling()
      if (this.disposed || this.blocked || this.jobsError || !this.canManageBulk || document.visibilityState === 'hidden') return
      if (this.jobs.some(job => ['queued', 'running'].includes(job.status))) this.pollTimer = setTimeout(() => { this.pollTimer = null; this.loadJobs() }, 2500)
    },
    onVisibilityChange() {
      if (document.visibilityState === 'hidden') { this.stopPolling(); this.stopExpiryTimer() }
      else {
        this.scheduleExpiry()
        if (this.jobs.some(job => ['queued', 'running'].includes(job.status)) && !this.loadingJobs && !this.jobsError) this.loadJobs()
      }
    },
    saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob), anchor = document.createElement('a')
      try { anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click() }
      finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000) }
    },
    progressValue(value) { return Number.isFinite(Number(value)) ? Math.min(100, Math.max(0, Number(value))) : 0 },
    statusText(status) { return ({ queued: '排队中', running: '生成中', complete: '生成完成', failed: '生成失败', expired: '已过期' })[status] || '状态待确认' },
    packageLabel(item) { return `${item.periodCode} · ${item.reportType} · 配置 v${item.packageVersion}` },
    statusType(status) { return ({ queued: 'info', running: 'warning', complete: 'success', failed: 'danger', expired: 'info' })[status] || 'info' },
    formatDate: formatExportDate
  }
}

</script>
