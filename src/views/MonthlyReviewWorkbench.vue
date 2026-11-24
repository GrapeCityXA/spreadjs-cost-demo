<template>
  <main class="review-workbench portal-workbench">
    <header class="masthead">
      <div>
        <h1>月报审核与定稿</h1>
        <p class="subhead">查看提交快照、记录审核意见，并在全部关口通过后发布正式版本。</p>
      </div>
      <div class="header-state"><span class="state-dot" />审核工作台 <span class="divider">/</span> 静态档案</div>
    </header>

    <DemoNextStep text="审核通过并定稿后，下一步是查看输出的报表。" label="下一步：报表输出" to="/portal/report-studio" />

    <div class="page-feedback" aria-live="polite">
      <p v-if="workbookLoading" role="status">正在加载所选任务的审核资料与工作簿…</p>
      <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
      <el-button v-if="loadError && activeTaskId" :disabled="!!busyAction" @click="reloadTask">重新加载审核资料</el-button>
      <el-alert v-if="actionError" :title="actionError" type="error" :closable="false" show-icon />
      <el-alert v-if="actionSuccess" :title="actionSuccess" type="success" :closable="false" show-icon />
      <p v-if="busyAction" role="status">正在处理，请稍候。完成后可切换任务或离开页面。</p>
      <p v-else-if="hasDraft">有未保存内容，切换任务或离开前请先保存。</p>
    </div>
    <div class="workbench-grid">
      <aside class="task-rail" :class="{ 'queue-collapsed': activeTaskId && !queueExpanded }" aria-label="月报任务">
        <div class="rail-heading">
          <h2>待审核与已定稿 <span class="task-count">{{ tasks.length }} 项</span></h2>
          <div class="rail-actions">
            <el-button v-if="activeTaskId" class="queue-toggle" :aria-expanded="queueExpanded" aria-controls="review-task-list" @click="queueExpanded = !queueExpanded">{{ queueExpanded ? '收起任务' : '切换任务' }}</el-button>
            <el-button text :loading="loadingTasks" :disabled="!!busyAction" aria-label="刷新任务" @click="loadTasks"><el-icon><Refresh /></el-icon></el-button>
          </div>
        </div>
        <el-alert v-if="tasksError" :title="tasksError" type="error" :closable="false" show-icon />
        <el-button v-if="tasksError" :disabled="!!busyAction" @click="loadTasks">重试加载任务</el-button>
        <p v-if="loadingTasks" class="empty-rail" role="status">正在加载任务…</p>
        <div v-if="tasksReady && !tasksError && !tasks.length && !loadingTasks" class="empty-rail">目前没有分配给你的月报任务。</div>
        <div id="review-task-list" class="task-list">
        <button v-for="task in tasks" :key="task.id" class="task-card" :disabled="!!busyAction" :aria-pressed="Number(activeTaskId) === Number(task.id)" :class="{ selected: Number(activeTaskId) === Number(task.id) }" @click="selectTask(task)">
          <div class="task-card-top"><span class="period">{{ task.periodCode }}</span><el-tag size="small" :type="statusType(task.status)">{{ statusLabel(task.status) }}</el-tag></div>
          <strong>{{ showcase ? task.reportTypeName : task.organizationName }}</strong><span class="report-name">{{ showcase ? task.periodCode : task.reportTypeName }}</span>
          <span class="revision-line">修订 {{ task.revisionNumber || '—' }} <template v-if="task.deadlineAt">· 截止 {{ formatDate(task.deadlineAt) }}</template></span>
        </button>
        </div>
      </aside>

      <section v-if="detail" class="review-main">
        <div class="briefing">
          <div class="briefing-title"><div><h2>{{ showcase ? detail.task.reportTypeName : detail.task.organizationName }}</h2><p class="report-context">{{ detail.task.reportTypeName }} · {{ detail.task.periodCode }}</p></div><el-tag :type="statusType(detail.task.status)">{{ statusLabel(detail.task.status) }}</el-tag></div>
          <dl class="briefing-meta">
            <div><dt>业务修订</dt><dd>R{{ detail.revision.number }}</dd></div>
            <div><dt>提交时间</dt><dd>{{ formatDate(detail.revision.submittedAt) }}</dd></div>
            <div><dt>模板版本</dt><dd>V{{ detail.task.configuration?.templateVersion || '—' }}</dd></div>
            <div><dt>协作版本</dt><dd>{{ detail.revision.collaborationVersion ?? '—' }}</dd></div>
          </dl>
          <p class="snapshot-note">填报内容来自已提交的不可变快照。<template v-if="detail.auxiliaryContract?.sheets?.some(sheet => sheet.dataBinding)">辅助表显示接口当前数据，仅供只读参考，不计入填报指标。</template>审核页面不会加入协作房间，批注与处置记录单独保存。</p>
        </div>

        <section v-if="detail.adjustment" class="review-section adjustment-review">
          <div class="section-heading"><div class="section-intro"><h3>月报调整申请</h3><p>来源修订 R{{ detail.adjustment.sourceRevisionId }}；当前修订只有完成审批和定稿后才会取代原有效版本。</p></div><el-tag :type="detail.adjustment.status === 'applied' ? 'success' : 'warning'">{{ adjustmentStatusLabel(detail.adjustment.status) }}</el-tag></div>
          <p><b>调整原因：</b>{{ detail.adjustment.reason }}</p>
          <p><b>调整字段：</b>{{ detail.adjustment.changedFields.join('、') || '待提交后确认' }}</p>
          <div v-if="detail.adjustment.canDecide && detail.adjustment.status === 'management_approval'" class="adjustment-decision">
            <label class="field-label" for="adjustment-note">管理审批意见</label><el-input id="adjustment-note" :disabled="!taskReady || !!busyAction" v-model="adjustmentDecisionNote" type="textarea" :rows="2" maxlength="2000" placeholder="填写管理审批意见" />
            <div class="adjustment-actions"><el-button type="success" :loading="decidingAdjustment" :disabled="!taskReady || !!busyAction || !adjustmentDecisionNote.trim()" @click="decideAdjustment('approve')">批准调整</el-button>
            <el-button type="danger" plain :loading="decidingAdjustment" :disabled="!taskReady || !!busyAction || !adjustmentDecisionNote.trim()" @click="decideAdjustment('reject')">驳回并保留原定稿</el-button></div>
          </div>
        </section>
        <div class="sheet-toolbar"><div><strong>提交工作簿</strong><small>只读视图</small></div><div class="toolbar-actions"><el-button size="small" @click="printWorkbook" :disabled="!canExport">打印</el-button><el-button size="small" :loading="busyAction === 'xlsx'" @click="downloadExport('xlsx')" :disabled="!canExport">下载 XLSX</el-button><el-button size="small" :loading="busyAction === 'pdf'" @click="downloadExport('pdf')" :disabled="!canExport">下载 PDF</el-button></div></div>
        <el-alert v-for="message in auxiliaryErrors" :key="message" :title="message" type="warning" :closable="false" show-icon />
        <el-button v-if="auxiliaryErrors.length" size="small" :loading="workbookLoading" :disabled="!!busyAction" @click="reloadTask">重试加载辅助表</el-button>
        <div v-if="workbookLoading" class="workbook-loading"><el-icon class="is-loading"><Loading /></el-icon> 正在加载静态工作簿…</div>
        <div ref="workbook" class="workbook-surface" :class="{ hidden: workbookLoading || !workbookReady }" aria-label="月度报表静态工作簿" />

        <section class="review-section">
          <div class="section-heading"><div class="section-intro"><h3>审核结论</h3><p>每个审核部门共用一条月报审核事项，版本冲突时需刷新后再提交。</p></div><el-tag v-if="myOpinion" :type="myOpinion.disposition === 'accept' ? 'success' : 'info'">意见版本 V{{ myOpinion.version }}</el-tag><el-tag v-else type="info">尚未记录</el-tag></div>
          <p v-if="detail.revision.status === 'finalized'" class="readonly-note">本修订已定稿，审核意见仅供查看。</p>
          <p v-else-if="!canReview" class="readonly-note">当前任务没有可用的审核权限，仅可查看。</p>
          <label class="field-label" for="review-opinion">审核意见</label>
          <el-input id="review-opinion" v-model="opinionText" type="textarea" :rows="3" maxlength="2000" show-word-limit placeholder="记录对本月报的审核结论或补充说明" :disabled="!canEditReview" />
          <div class="opinion-actions">
            <div class="save-actions">
            <el-button type="primary" :loading="savingOpinion" :disabled="!canEditReview || !opinionText.trim()" @click="saveOpinion('accept')">通过并保存意见</el-button>
            <el-button :loading="savingOpinion" :disabled="!canEditReview || !opinionText.trim()" @click="saveOpinion('comment')">保存意见</el-button>
            </div>
            <div class="return-actions"><div class="deadline-field"><label class="field-label" for="review-deadline">整改截止时间（退回时必填）</label><el-date-picker popper-class="monthly-review-deadline" id="review-deadline" v-model="remediationDeadline" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" placeholder="选择日期和时间" :disabled="!canEditReview" /></div>
            <el-button type="warning" plain :loading="savingOpinion" :disabled="!canEditReview || !opinionText.trim() || !remediationDeadline" @click="saveOpinion('return')">退回整改</el-button></div>
          </div>
          <div v-if="detail.opinions.length" class="opinion-history"><h4 class="history-label">部门记录</h4><div v-for="item in detail.opinions" :key="`${item.departmentCode}-${item.reviewItemKey}`" class="opinion-row"><b>{{ item.departmentCode }}</b><span>{{ item.opinion }}</span><el-tag size="small" :type="item.disposition === 'accept' ? 'success' : 'info'">{{ item.disposition === 'accept' ? '通过' : '已记录' }} · V{{ item.version }}</el-tag></div></div>
        </section>

        <section v-if="detail.anomalies.length" class="review-section anomaly-section">
          <div class="section-heading"><div class="section-intro"><h3>异常与校验</h3><p>未处置警告、要求更正的项目或阻断错误都会阻止定稿。</p></div><span class="count-pill">{{ detail.anomalies.length }} 项</span></div>
          <article v-for="anomaly in detail.anomalies" :key="anomaly.id" class="anomaly-row">
            <div class="anomaly-copy"><div><b>{{ anomaly.fieldCode || anomaly.ruleCode || '校验项目' }}</b><el-tag size="small" :type="anomaly.severity === 'error' ? 'danger' : anomaly.disposition === 'accepted' ? 'success' : anomaly.disposition === 'correction_requested' ? 'danger' : 'warning'">{{ anomaly.severity === 'error' ? '阻断' : anomaly.disposition === 'accepted' ? '已接受' : anomaly.disposition === 'correction_requested' ? '要求更正' : '待处理' }}</el-tag></div><p>{{ anomaly.message }}</p><blockquote v-if="anomaly.explanation">填报说明：{{ anomaly.explanation }}</blockquote></div>
            <div v-if="canReview && anomaly.severity !== 'error' && !anomaly.disposition && detail.revision.status !== 'finalized'" class="anomaly-actions"><el-button size="small" type="success" plain :disabled="!canEditReview" @click="setAnomaly(anomaly, 'accepted')">接受说明</el-button><el-button size="small" type="danger" plain :disabled="!canEditReview" @click="setAnomaly(anomaly, 'correction_requested')">要求更正</el-button></div>
          </article>
        </section>

        <section v-if="detail.attachments.length" class="review-section evidence-section">
          <div class="section-heading"><div class="section-intro"><h3>提交证据</h3><p>证据与本次业务修订绑定。</p></div></div>
          <button v-for="file in detail.attachments" :key="file.id" class="evidence-link" :disabled="!taskReady || !!busyAction" @click="downloadEvidence(file)"><span class="file-badge">{{ file.originalName.split('.').pop().toUpperCase() }}</span><span><b>{{ file.originalName }}</b><small>{{ file.indicatorCode || '任务级证据' }} · {{ formatBytes(file.byteSize) }}</small></span><el-icon class="download-mark"><Download /></el-icon></button>
        </section>

        <section v-if="canFinalize || revisions.length || historyError || historyLoading" class="finalization-section">
          <div class="finalization-copy"><div><h3>正式定稿</h3><p>发布本修订的工作簿、XLSX、PDF、结构化数据和版本清单；历史版本继续保留。</p><div v-if="detail.revision.status === 'finalized'" class="current-effective"><span class="state-dot" />当前有效修订 R{{ detail.revision.number }}</div></div></div>
          <el-button v-if="canFinalize && detail.revision.status !== 'finalized'" type="primary" size="large" :loading="finalizing" :disabled="!canExport || hasDraft" @click="finalize">生成正式文件并定稿</el-button>
          <p v-if="historyLoading" class="history-loading" role="status">正在加载历史定稿…</p>
          <div v-if="historyError" class="history-error"><el-alert :title="historyError" type="warning" :closable="false" show-icon /><el-button :disabled="!!busyAction" @click="loadHistory()">重新加载历史定稿</el-button></div>
          <div v-if="revisions.length" class="history-list"><div class="history-title">历史定稿 <span>{{ revisions.length }}</span></div><article v-for="revision in revisions" :key="revision.id" class="history-item"><div><b>R{{ revision.revisionNumber }}</b><el-tag v-if="revision.isCurrentEffective" size="small" type="success">当前有效</el-tag><small>{{ formatDate(revision.finalizedAt) }}</small></div><div class="history-downloads"><button v-for="kind in artifactKinds" :key="kind.type" :aria-label="`下载修订 R${revision.revisionNumber} 的${kind.label}文件`" :disabled="!taskReady || !!busyAction" @click="downloadHistoric(revision, kind.type)">{{ kind.label }}</button></div></article></div>
        </section>
      </section>
      <section v-else-if="!workbookLoading && !loadError" class="welcome-panel"><h2>选择一项月报任务</h2><p>打开后将从业务存储中读取已提交的静态工作簿。审核过程不会连接实时填报房间。</p></section>
    </div>
  </main>
</template>

<script>
import { returnToWorkflow } from '@/utils/workflowNavigation'
import DemoNextStep from '@/components/DemoNextStep.vue'
import { markRaw } from 'vue'
import { Refresh, Download, Loading } from '@element-plus/icons-vue'
import { observeWorkbookLayout } from '@/utils/observeWorkbookLayout'
import { prepareTemplateFunctions } from '@/template/managedFunctions'
import { loadReviewSnapshot } from '@/utils/monthlyReviewLoading'
import { bindAuxiliaryData, disposeAuxiliaryData } from '@/template/auxiliaryDataBinding'
import { ensureSpreadPdfExport } from '@/utils/spreadPdfFonts'
import { ensureSpreadIo } from '@/utils/spreadIo'
import { reviewTaskId, readReviewTasks, readReviewDetail, reviewError } from '@/utils/monthlyReviewState'
import GC from '@grapecity-software/spread-sheets'
import '@grapecity-software/spread-sheets-print'
import { collaborationApi } from '../api'
import { SHOWCASE } from '@/config/showcase'

export default {
  name: 'MonthlyReviewWorkbench',
  components: { Refresh, Download, Loading, DemoNextStep },
  data() {
    return { showcase: SHOWCASE, queueExpanded: false, tasks: [], activeTaskId: null, detail: null, revisions: [], opinionText: '', remediationDeadline: '',
      loadingTasks: false, tasksReady: false, tasksError: '', loadError: '', historyError: '', historyLoading: false, historyRequest: 0, actionError: '', actionSuccess: '',
      workbookLoading: false, workbookReady: false, busyAction: '', spread: null, stopWorkbookLayout: null,
      artifactKinds: [{ type: 'finalized_xlsx', label: 'XLSX' }, { type: 'finalized_pdf', label: 'PDF' },
        { type: 'structured_data_json', label: '数据' }, { type: 'version_manifest_json', label: '版本' }],
      adjustmentDecisionNote: '', savedOpinionText: '', auxiliaryErrors: [], reviewRequest: 0, listRequest: 0, alive: true }
  },
  computed: {
    taskReady() { return !!this.detail && Number(this.detail.task.id) === this.activeTaskId && this.workbookReady && !this.workbookLoading && !this.loadError },
    canReview() { return this.tasksReady && !this.loadingTasks && !this.tasksError && Boolean(this.tasks.find(task => Number(task.id) === this.activeTaskId)?.canReview) },
    canFinalize() { return this.tasksReady && !this.loadingTasks && !this.tasksError && this.tasks.find(task => Number(task.id) === this.activeTaskId)?.canFinalize === true },
    canEditReview() { return this.taskReady && this.canReview && !this.busyAction && this.detail.revision.status !== 'finalized' },
    canExport() { return this.taskReady && !this.auxiliaryErrors.length && !this.busyAction },
    myOpinion() { return this.detail?.myOpinion || null },
    hasDraft() { return this.opinionText !== this.savedOpinionText || !!this.remediationDeadline || !!this.adjustmentDecisionNote.trim() },
    savingOpinion() { return this.busyAction === 'opinion' },
    finalizing() { return this.busyAction === 'finalize' },
    decidingAdjustment() { return this.busyAction === 'adjustment' }
  },
  watch: { '$route.params.taskId': { immediate: true, handler(value) { this.openTask(value) } } },
  mounted() { this.loadTasks(); window.addEventListener('beforeunload', this.warnBeforeUnload) },
  beforeRouteUpdate() { return this.confirmLeave() },
  beforeRouteLeave() { return this.confirmLeave() },
  beforeUnmount() {
    this.alive = false; this.reviewRequest++; this.listRequest++
    this.listController?.abort(); this.reviewController?.abort(); this.historyController?.abort()
    window.removeEventListener('beforeunload', this.warnBeforeUnload)
    this.destroySpread()
  },
  methods: {
    warnBeforeUnload(event) { if (this.hasDraft || this.busyAction) { event.preventDefault(); event.returnValue = '' } },
    async confirmLeave() {
      if (this.busyAction) { this.actionError = '当前操作尚未完成，请完成后再切换任务或离开页面。'; return false }
      if (!this.hasDraft) return true
      try {
        await this.$confirm('尚有未保存的审核意见、整改期限或审批意见。离开将放弃这些内容。', '放弃未保存内容？', {
          confirmButtonText: '放弃并继续', cancelButtonText: '继续填写', type: 'warning', closeOnClickModal: false })
        return true
      } catch { return false }
    },
    async loadTasks() {
      if (!this.alive || this.loadingTasks || this.busyAction) return
      const request = ++this.listRequest, controller = new AbortController()
      this.listController?.abort(); this.listController = controller
      this.loadingTasks = true; this.tasksError = ''
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        const response = await collaborationApi.getMonthlyReviewTasks({ signal: controller.signal })
        if (!this.alive || request !== this.listRequest) return
        this.tasks = readReviewTasks(response); this.tasksReady = true
      } catch (error) { if (this.alive && request === this.listRequest) this.tasksError = reviewError(error, '任务列表加载失败，请重试。') }
      finally { clearTimeout(timer); if (request === this.listRequest) this.loadingTasks = false }
    },
    async selectTask(task) {
      if (this.busyAction) return
      if (this.activeTaskId === Number(task.id)) return this.reloadTask()
      await this.$router.replace({ name: 'MonthlyReviewWorkbench', params: { taskId: task.id }, query: this.$route.query })
    },
    async reloadTask() { if (await this.confirmLeave()) await this.openTask(this.activeTaskId) },
    async loadHistory(taskId = this.activeTaskId, reviewRequest = this.reviewRequest) {
      if (!this.alive || !taskId || taskId !== this.activeTaskId || reviewRequest !== this.reviewRequest) return
      const request = ++this.historyRequest, controller = new AbortController()
      this.historyController?.abort(); this.historyController = controller
      this.historyLoading = true; this.historyError = ''
      const current = () => this.alive && request === this.historyRequest && reviewRequest === this.reviewRequest && taskId === this.activeTaskId
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        const history = await collaborationApi.getFinalizedRevisions(taskId, { signal: controller.signal })
        if (!current()) return
        if (!Array.isArray(history?.revisions) || history.revisions.some(item => !reviewTaskId(item?.id))) throw new Error('历史定稿数据不完整，请重新加载。')
        this.revisions = history.revisions
      } catch (error) { if (current()) this.historyError = reviewError(error, '历史定稿加载失败，请重试。') }
      finally { clearTimeout(timer); if (current()) this.historyLoading = false }
    },
    async openTask(value, { internal = false } = {}) {
      if (!this.alive || (this.busyAction && !internal)) return
      const taskId = reviewTaskId(value), request = ++this.reviewRequest
      this.reviewController?.abort(); this.historyController?.abort(); this.historyRequest++; this.historyLoading = false; this.destroySpread()
      this.activeTaskId = taskId; this.detail = null; this.revisions = []; this.auxiliaryErrors = []
      this.opinionText = ''; this.savedOpinionText = ''; this.remediationDeadline = ''; this.adjustmentDecisionNote = ''
      this.workbookReady = false; this.workbookLoading = false; this.loadError = ''; this.historyError = ''; this.actionError = ''; this.actionSuccess = ''
      if (!taskId) { if (value != null && value !== '') this.loadError = '任务编号无效，请从任务队列重新选择。'; return }
      this.workbookLoading = true
      const controller = new AbortController(); this.reviewController = controller
      const timer = setTimeout(() => controller.abort(), 30000)
      const current = () => this.alive && request === this.reviewRequest
      try {
        const [response, { restoreRevisionWorkbook }] = await Promise.all([
          collaborationApi.getMonthlyReview(taskId, { signal: controller.signal }), loadReviewSnapshot()
        ])
        if (!current()) return
        const detail = readReviewDetail(response, taskId)
        void this.loadHistory(taskId, request)
        this.detail = detail; this.opinionText = detail.myOpinion?.opinion || ''; this.savedOpinionText = this.opinionText
        await this.$nextTick()
        if (!current()) return
        const spread = markRaw(new GC.Spread.Sheets.Workbook(this.$refs.workbook, { sheetCount: 1, tabEditable: false,
          newTabVisible: false, allowSheetReorder: false, allowUserResize: false, allowUserZoom: true,
          allowUserDragDrop: false, allowUserDragFill: false, allowUndo: false, allowContextMenu: false }))
        this.spread = spread
        await prepareTemplateFunctions(detail.workbook)
        if (!current()) return
        await restoreRevisionWorkbook(spread, detail.workbook)
        if (!current()) return
        await bindAuxiliaryData(spread, detail.auxiliaryContract, message => { if (current()) this.auxiliaryErrors.push(message) })
        if (!current()) return
        for (let index = 0; index < spread.getSheetCount(); index++) {
          const sheet = spread.getSheet(index)
          sheet.getRange(-1, -1, -1, -1).locked(true)
          sheet.options.isProtected = true
          sheet.options.protectionOptions = { allowSelectLockedCells: true, allowSelectUnlockedCells: true,
            allowSort: false, allowFilter: false, allowResizeRows: false, allowResizeColumns: false,
            allowEditObjects: false, allowDragInsertRows: false, allowDragInsertColumns: false,
            allowInsertRows: false, allowInsertColumns: false, allowDeleteRows: false, allowDeleteColumns: false,
            allowOutlineRows: false, allowOutlineColumns: false, allowUsePivotTable: false }
        }
        this.workbookReady = true

      } catch (error) {
        if (current()) { this.loadError = reviewError(error, '审核资料加载失败，请重试。'); this.workbookReady = false; this.destroySpread() }
      } finally {
        clearTimeout(timer)
        if (current()) {
          this.workbookLoading = false; await this.$nextTick()
          if (current() && this.workbookReady && this.spread) this.stopWorkbookLayout = observeWorkbookLayout(this.spread.getHost(), this.spread)
        }
      }
    },
    destroySpread() {
      this.stopWorkbookLayout?.(); this.stopWorkbookLayout = null
      const spread = this.spread; this.spread = null; this.workbookReady = false
      if (!spread) return
      // An in-flight export owns the control until its callback settles.
      if (spread === this.exportWorkbook) this.retiredWorkbook = spread
      else { disposeAuxiliaryData(spread); spread.destroy() }
    },
    beginAction(kind) {
      if (!this.alive || !this.taskReady || this.busyAction) return null
      this.busyAction = kind; this.actionError = ''; this.actionSuccess = ''
      return { taskId: this.activeTaskId, revisionId: this.detail.revision.id, request: this.reviewRequest, spread: this.spread,
        organizationCode: this.detail.task.organizationCode, organizationName: this.detail.task.organizationName,
        periodCode: this.detail.task.periodCode, includeBindingSource: Boolean(this.detail.auxiliaryContract?.sheets?.some(sheet => sheet.dataBinding)) }
    },
    actionCurrent(context) { return this.alive && context.request === this.reviewRequest && context.taskId === this.activeTaskId && context.revisionId === this.detail?.revision.id },
    assertAction(context) { if (!this.actionCurrent(context)) throw new Error('任务已切换，操作已取消。') },
    actionFailed(context, error) { if (this.actionCurrent(context)) this.actionError = reviewError(error, '操作失败，请重试。') },
    finishAction() {
      if (this.retiredWorkbook) { disposeAuxiliaryData(this.retiredWorkbook); this.retiredWorkbook.destroy(); this.retiredWorkbook = null }
      this.exportWorkbook = null; this.busyAction = ''
    },
    saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob), anchor = document.createElement('a')
      anchor.href = url; anchor.download = filename; anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    async exportXlsx(context) {
      await ensureSpreadIo(); this.assertAction(context)
      return new Promise((resolve, reject) => context.spread.export(resolve, reject,
        { fileType: GC.Spread.Sheets.FileType.excel, includeBindingSource: context.includeBindingSource }))
    },
    async exportPdf(context) {
      await ensureSpreadPdfExport(GC); this.assertAction(context)
      return new Promise((resolve, reject) => context.spread.savePDF(resolve, reject,
        { title: `${this.showcase ? context.periodCode : `${context.organizationName}-${context.periodCode}`}`, author: '成本指标平台', creator: '成本指标平台' }))
    },
    async downloadExport(type) {
      if (!['xlsx', 'pdf'].includes(type) || !this.canExport) return
      const context = this.beginAction(type); if (!context) return
      this.exportWorkbook = context.spread
      try {
        const blob = type === 'xlsx' ? await this.exportXlsx(context) : await this.exportPdf(context)
        this.assertAction(context); this.saveBlob(blob, `${this.showcase ? '' : `${context.organizationCode}-`}${context.periodCode}.${type}`)
        this.actionSuccess = '文件已生成，下载已开始。'
      } catch (error) { this.actionFailed(context, error) } finally { this.finishAction() }
    },
    printWorkbook() {
      if (!this.canExport) return
      const context = this.beginAction('print'); if (!context) return
      try { context.spread.print() } catch (error) { this.actionFailed(context, error) } finally { this.finishAction() }
    },
    async saveOpinion(disposition) {
      if (!this.canEditReview || !['accept', 'comment', 'return'].includes(disposition)) return
      if (disposition === 'return' && this.adjustmentDecisionNote.trim()) { this.actionError = '请先处理或清空管理审批意见，再退回整改。'; return }
      const opinion = this.opinionText.trim(), deadline = this.remediationDeadline
      if (!opinion || opinion.length > 2000) { this.actionError = '请填写不超过 2000 字的审核意见。'; return }
      if (disposition === 'return' && (!deadline || !Number.isFinite(new Date(deadline).getTime()) || new Date(deadline).getTime() <= Date.now())) {
        this.actionError = '退回整改前，请选择晚于当前时间的整改截止时间。'; return
      }
      const context = this.beginAction('opinion'); if (!context) return
      const payload = { reviewItemKey: 'monthly:submission', expectedVersion: Number(this.myOpinion?.version || 0), disposition, opinion,
        ...(disposition === 'return' ? { remediationDeadline: deadline } : {}) }
      try {
        const result = await collaborationApi.saveReviewOpinion(context.taskId, payload)
        if (!this.actionCurrent(context)) return
        this.opinionText = opinion; this.savedOpinionText = opinion; this.remediationDeadline = ''
        if (disposition === 'return') {
          this.destroySpread(); this.detail = null; this.revisions = []; this.opinionText = ''; this.savedOpinionText = ''
          this.actionSuccess = '已退回并创建新的更正修订。'
        } else {
          const saved = { reviewItemKey: result.reviewItemKey, departmentCode: result.departmentCode || this.detail.reviewDepartmentCode,
            opinion, disposition, version: result.reviewVersion }
          this.detail.myOpinion = saved
          this.detail.opinions = [...this.detail.opinions.filter(item => item.departmentCode !== saved.departmentCode || item.reviewItemKey !== saved.reviewItemKey), saved]
          this.detail.task.status = 'reviewing'
          this.tasks = this.tasks.map(task => Number(task.id) === context.taskId ? { ...task, status: 'reviewing' } : task)
          this.actionSuccess = '审核意见已保存。'
        }
        if (!this.hasDraft) { this.busyAction = ''; if (returnToWorkflow(this)) return }
      } catch (error) { this.actionFailed(context, error) } finally { this.finishAction() }
      if (this.alive && context.taskId === this.activeTaskId && disposition === 'return') await this.loadTasks()
    },
    async setAnomaly(anomaly, disposition) {
      if (!this.canEditReview || !this.detail.anomalies.includes(anomaly) || anomaly.severity === 'error' || anomaly.disposition
        || !['accepted', 'correction_requested'].includes(disposition)) return
      const context = this.beginAction('anomaly'); if (!context) return
      try {
        await collaborationApi.saveAnomalyDisposition(context.taskId, anomaly.id, disposition)
        if (this.actionCurrent(context)) { anomaly.disposition = disposition; this.actionSuccess = '异常处置已保存。' }
      } catch (error) { this.actionFailed(context, error) } finally { this.finishAction() }
    },
    async decideAdjustment(decision) {
      if (!this.taskReady || !this.detail.adjustment?.canDecide || this.detail.adjustment.status !== 'management_approval'
        || !['approve', 'reject'].includes(decision)) return
      const note = this.adjustmentDecisionNote.trim()
      if (!note || note.length > 2000) { this.actionError = '请填写不超过 2000 字的管理审批意见。'; return }
      if (this.opinionText !== this.savedOpinionText || this.remediationDeadline) { this.actionError = '请先保存审核意见，再处理调整申请。'; return }
      const context = this.beginAction('adjustment'); if (!context) return
      try {
        await collaborationApi.decideMonthlyAdjustment(context.taskId, { decision, note })
        if (!this.actionCurrent(context)) return
        this.adjustmentDecisionNote = ''
        await this.openTask(context.taskId, { internal: true })
        if (!this.alive) return
        this.actionSuccess = decision === 'approve' ? '调整已批准；等待定稿后更新当前有效版本。' : '调整已驳回；原定稿继续有效。'
        this.busyAction = ''; returnToWorkflow(this)
      } catch (error) { this.actionFailed(context, error) } finally { this.finishAction() }
      if (this.alive) await this.loadTasks()
    },
    async finalize() {
      if (!this.canFinalize || !this.canExport || this.detail.revision.status === 'finalized') return
      if (this.hasDraft) { this.actionError = '请先保存审核或审批意见，再生成正式文件。'; return }
      const context = this.beginAction('finalize'); if (!context) return
      this.exportWorkbook = context.spread
      try {
        // Serialize exports so a failed callback never releases a control still in use.
        const xlsx = await this.exportXlsx(context); this.assertAction(context)
        const pdf = await this.exportPdf(context); this.assertAction(context)
        await collaborationApi.finalizeMonthlyTask(context.taskId, xlsx, pdf)
        if (!this.actionCurrent(context)) return
        await this.openTask(context.taskId, { internal: true })
        if (!this.alive) return
        this.actionSuccess = '月报已定稿，正式文件和版本清单已归档。'
        this.busyAction = ''; returnToWorkflow(this)
      } catch (error) { this.actionFailed(context, error) } finally { this.finishAction() }
      if (this.alive) await this.loadTasks()
    },
    async downloadEvidence(file) {
      if (!this.detail?.attachments.includes(file)) return
      const context = this.beginAction('attachment'); if (!context) return
      const filename = file.originalName
      try { const blob = await collaborationApi.downloadEvidenceAttachment(context.taskId, file.id); this.assertAction(context); this.saveBlob(blob, filename) }
      catch (error) { this.actionFailed(context, error) } finally { this.finishAction() }
    },
    async downloadHistoric(revision, artifactType) {
      if (!this.revisions.includes(revision) || !this.artifactKinds.some(kind => kind.type === artifactType)) return
      const context = this.beginAction('history'); if (!context) return
      const filename = `R${revision.revisionNumber}-${artifactType}.${artifactType.endsWith('xlsx') ? 'xlsx' : artifactType.endsWith('pdf') ? 'pdf' : 'json'}`
      try { const blob = await collaborationApi.downloadFinalizedArtifact(context.taskId, revision.id, artifactType); this.assertAction(context); this.saveBlob(blob, filename) }
      catch (error) { this.actionFailed(context, error) } finally { this.finishAction() }
    },
    formatDate(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间不可用' : date.toLocaleString('zh-CN', { hour12: false }) },
    formatBytes(value) { const size = Number(value); return !Number.isFinite(size) || size < 0 ? '大小未知' : size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB` },
    statusLabel(status) { return ({ submitted: '待审核', reviewing: '审核中', finalized: '已定稿' })[status] || status || '未知' },
    adjustmentStatusLabel(status) { return ({ draft: '调整草稿', department_review: '部门审核', management_approval: '管理审批', approved: '待定稿', applied: '已应用', rejected: '已驳回' })[status] || status },
    statusType(status) { return status === 'finalized' ? 'success' : status === 'reviewing' ? 'warning' : 'info' }
  }
}

</script>

<style scoped>
/* The workspace, not the browser viewport, decides when the task rail fits. */
.review-workbench.portal-workbench {
  container: review-workspace / inline-size;
  --el-color-primary: var(--portal-focus);
  --el-color-primary-dark-2: #7a1454;
  min-width: 0;
}
.portal-layout .portal-content > .review-workbench.portal-workbench { max-width: none; padding: 20px; }
.masthead { display:flex; align-items:flex-end; justify-content:space-between; flex-wrap:wrap; gap:12px 24px; border-bottom:1px solid var(--line); }
.masthead h1 { margin:0; font-size:24px; line-height:1.4; }
.subhead { margin:8px 0 0; color:var(--muted); font-size:14px; }
.header-state { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:12px; white-space:nowrap; }
.state-dot { display:inline-block; flex-shrink:0; width:6px; height:6px; border-radius:50%; background:#308454; }
.divider { color:var(--line); }
.page-feedback { display:grid; gap:8px; margin-top:12px; }
.page-feedback:empty { display:none; }
.page-feedback p { margin:0; color:var(--muted); font-size:13px; }
.page-feedback>.el-button { justify-self:start; margin:0; }
.workbench-grid { display:grid; grid-template-columns:minmax(0,1fr); gap:16px; align-items:start; margin-top:16px; }
.review-workbench.portal-workbench .task-rail { position:static; min-width:0; padding:12px; max-height:none; border:1px solid var(--line); border-radius:8px; overflow:visible; }
.rail-heading { display:flex; justify-content:space-between; align-items:center; gap:8px; }
.review-workbench.portal-workbench .task-rail .rail-heading h2 { margin:0; font-size:14px; }
.task-count { margin-left:4px; color:var(--muted); font-size:12px; font-weight:400; font-variant-numeric:tabular-nums; }
.rail-actions { display:flex; align-items:center; gap:4px; flex-shrink:0; }
.rail-actions>.el-button { margin:0; min-width:36px; min-height:36px; }
.task-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr)); gap:8px; max-height:260px; overflow-y:auto; overscroll-behavior:contain; padding:4px; margin:8px -4px -4px; scrollbar-width:thin; scrollbar-color:#b6c1cd transparent; }
.queue-collapsed .task-list { display:none; }
.task-card { display:grid; align-content:start; gap:4px; min-width:0; width:100%; padding:12px; text-align:left; color:var(--ink); background:var(--portal-surface); border:1px solid var(--line); border-radius:4px; cursor:pointer; font:inherit; overflow-wrap:anywhere; }
.task-card-top { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; }
.period { font-size:14px; font-weight:600; font-variant-numeric:tabular-nums; }
.task-card strong { font-size:14px; font-weight:600; }
.report-name,.revision-line { color:var(--muted); font-size:12px; line-height:1.6; }
.empty-rail { margin:0; padding:16px 0; color:var(--muted); font-size:13px; }
.review-main { container: review-detail / inline-size; min-width:0; border:1px solid var(--line); border-radius:8px; }
.briefing { padding:20px; }
.briefing-title { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.briefing-title>div { min-width:0; }
.briefing-title h2 { margin:0; font-size:20px; overflow-wrap:anywhere; }
.report-context { margin:4px 0 0; color:var(--muted); font-size:14px; overflow-wrap:anywhere; }
.briefing-meta { max-width:960px; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px 24px; margin:16px 0; font-size:12px; }
.briefing-meta dt { color:var(--muted); margin-bottom:4px; }
.briefing-meta dd { margin:0; color:var(--ink); font-weight:600; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
.snapshot-note { margin:0; padding:12px; color:var(--muted); font-size:12px; line-height:1.7; border-radius:4px; }
.sheet-toolbar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; padding:12px 20px; border-block:1px solid var(--line); }
.sheet-toolbar>div:first-child { display:flex; align-items:center; gap:8px; }
.sheet-toolbar strong { font-size:14px; }.sheet-toolbar small { color:var(--muted); font-size:12px; }
.toolbar-actions { display:flex; gap:8px; flex-wrap:wrap; }
.toolbar-actions>.el-button { min-height:32px; }
.workbook-surface { width:100%; min-width:0; height:clamp(360px,60vh,720px); height:clamp(360px,60dvh,720px); background:white; }
.workbook-surface.hidden { display:none; }
.workbook-loading { display:grid; min-height:220px; place-content:center; gap:8px; color:var(--muted); font-size:14px; }
.review-section { padding:24px 20px; border-top:1px solid var(--line); overflow-wrap:anywhere; }
.section-heading { display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:8px 16px; margin-bottom:16px; }
.section-heading>.section-intro { flex:1; min-width:min(240px,100%); }
.section-heading h3,.finalization-copy h3 { margin:0 0 4px; font-size:14px; }
.section-heading p,.finalization-copy p { margin:0; max-width:75ch; color:var(--muted); font-size:13px; line-height:1.6; }
.field-label { display:block; margin-bottom:8px; color:var(--ink); font-size:14px; font-weight:600; }
.readonly-note { margin:0 0 12px; color:var(--muted); font-size:13px; }
.opinion-actions { display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:20px 24px; margin-top:16px; }
.save-actions,.adjustment-actions { display:flex; flex-wrap:wrap; gap:8px; }
.adjustment-actions { margin-top:12px; }
.return-actions { display:flex; align-items:flex-end; flex-wrap:wrap; gap:8px; }
.deadline-field { min-width:0; }.deadline-field :deep(.el-date-editor) { width:220px; max-width:100%; }
.review-workbench :is(.toolbar-actions,.save-actions,.return-actions,.adjustment-actions,.anomaly-actions)>.el-button { margin:0; }
.opinion-history { display:grid; gap:8px; margin-top:24px; padding-top:16px; border-top:1px solid var(--line); }
.history-label { margin:0; color:var(--muted); font-size:13px; font-weight:600; }
.opinion-row { display:grid; grid-template-columns:minmax(96px,160px) minmax(0,1fr) auto; align-items:start; gap:12px; padding-block:12px; border-top:1px solid var(--line); font-size:13px; }
.opinion-row>span:not(.el-tag) { color:var(--muted); line-height:1.6; white-space:pre-wrap; }
.count-pill { color:var(--muted); font-size:12px; white-space:nowrap; }
.anomaly-row { display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:12px 24px; padding:16px 0; border-top:1px solid var(--line); }
.anomaly-copy { flex:1; min-width:min(280px,100%); }.anomaly-copy>div { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.anomaly-copy b { font-size:13px; }.anomaly-copy p { margin:8px 0 0; color:var(--muted); font-size:13px; white-space:pre-wrap; }
.anomaly-copy blockquote { margin:8px 0 0; padding:8px 12px; border-left:1px solid #b88634; background:#faf7ef; color:#70552e; font-size:13px; white-space:pre-wrap; }
.anomaly-actions { display:flex; flex-wrap:wrap; gap:8px; }
.evidence-link { display:flex; align-items:center; gap:12px; width:100%; min-width:0; padding:12px 0; text-align:left; color:var(--ink); background:transparent; border:0; border-top:1px solid var(--line); cursor:pointer; }
.file-badge { flex-shrink:0; width:40px; padding:8px 4px; overflow:hidden; color:var(--muted); background:var(--paper); border-radius:4px; font-size:12px; text-align:center; font-weight:600; }
.evidence-link>span:nth-child(2) { display:grid; min-width:0; flex:1; gap:4px; }.evidence-link b { font-size:13px; overflow-wrap:anywhere; }.evidence-link small { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
.download-mark { flex-shrink:0; color:var(--portal-focus); font-size:18px; }
.finalization-section { display:grid; grid-template-columns:minmax(0,1fr); gap:16px; padding:24px 20px; border-top:1px solid var(--line); border-radius:0 0 8px 8px; overflow-wrap:anywhere; }
.finalization-section>.el-button { justify-self:start; margin:0; }
.current-effective { display:flex; align-items:center; gap:8px; margin-top:12px; color:#307347; font-size:13px; }
.history-list { grid-column:1/-1; border-top:1px solid var(--line); }
.history-title { display:flex; justify-content:space-between; padding:16px 0 8px; color:var(--ink); font-size:13px; font-weight:600; }.history-title span { color:var(--muted); }
.history-item { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px 16px; padding:12px 0; border-top:1px solid var(--line); }
.history-item>div:first-child { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }.history-item b { font-size:14px; }.history-item small { color:var(--muted); font-size:12px; }
.history-downloads { display:flex; flex-wrap:wrap; gap:4px; }.history-downloads button { min-width:44px; min-height:36px; padding:8px; color:var(--portal-focus); background:transparent; border:0; font-size:13px; cursor:pointer; }
.history-loading { grid-column:1/-1; margin:0; color:var(--muted); font-size:13px; }
.history-error { grid-column:1/-1; display:grid; gap:8px; }.history-error>.el-button { justify-self:start; }
.welcome-panel { min-width:0; min-height:280px; padding:32px; display:flex; flex-direction:column; justify-content:center; border:1px solid var(--line); border-radius:8px; }
.welcome-panel h2 { margin:0; font-size:20px; }.welcome-panel p { max-width:65ch; margin:12px 0 0; color:var(--muted); line-height:1.7; }
.task-card:disabled,.evidence-link:disabled,.history-downloads button:disabled { cursor:not-allowed; opacity:.6; }
.task-card:focus-visible,.evidence-link:focus-visible,.history-downloads button:focus-visible { outline:2px solid var(--portal-focus); outline-offset:2px; }
.review-workbench :deep(.el-textarea__inner) { resize:vertical; min-height:100px; line-height:1.6; }
.review-workbench :deep(.el-button--primary) { --el-button-bg-color:var(--portal-focus); --el-button-border-color:var(--portal-focus); --el-button-hover-bg-color:#7a1454; --el-button-hover-border-color:#7a1454; --el-button-active-bg-color:#6f114b; --el-button-active-border-color:#6f114b; }
/* Local state colors retain the portal palette with readable text. */
.review-workbench :deep(.el-tag--success) { --el-tag-text-color:#236449; }
.review-workbench :deep(.el-tag--warning) { --el-tag-text-color:#87531e; }
.review-workbench :deep(.el-tag--danger) { --el-tag-text-color:#b42318; }
.review-workbench :deep(.el-tag--info) { --el-tag-text-color:#6d5a65; }
.review-workbench :deep(.el-button--success:not(.is-disabled)) { --el-button-text-color:#fff; --el-button-bg-color:#236449; --el-button-border-color:#236449; --el-button-hover-bg-color:#1c513b; --el-button-hover-border-color:#1c513b; --el-button-active-bg-color:#174430; --el-button-active-border-color:#174430; }
.review-workbench :deep(.el-button--success.is-plain:not(.is-disabled)) { --el-button-text-color:#236449; --el-button-bg-color:#f0f9eb; --el-button-border-color:#a7c4b4; }
.review-workbench :deep(.el-button--danger.is-plain:not(.is-disabled)) { --el-button-text-color:#b42318; --el-button-border-color:#e8b4ae; --el-button-hover-bg-color:#a32118; --el-button-hover-border-color:#a32118; --el-button-active-bg-color:#8e1c14; --el-button-active-border-color:#8e1c14; }
.review-workbench :deep(.el-button--warning.is-plain:not(.is-disabled)) { --el-button-text-color:#87531e; --el-button-border-color:#d9bb98; --el-button-hover-bg-color:#87531e; --el-button-hover-border-color:#87531e; --el-button-active-bg-color:#714518; --el-button-active-border-color:#714518; }
.review-workbench :deep(.el-textarea.is-disabled .el-textarea__inner) { color:var(--muted); -webkit-text-fill-color:var(--muted); }
.review-workbench :deep(.el-input__inner::placeholder),.review-workbench :deep(.el-textarea__inner::placeholder) { color:#73767a; }
.review-workbench :deep(.el-textarea .el-input__count) { color:var(--muted); background:transparent; }
.review-workbench :deep(.el-button:focus-visible) { outline:2px solid var(--portal-focus); outline-offset:2px; }
.review-workbench :deep(.el-textarea__inner),.review-workbench :deep(.el-input__inner) { caret-color:var(--portal-focus); }
.review-workbench ::selection { background:#f0c6dd; color:#4b0b31; }
.header-state .state-dot { background:var(--muted); }
.history-downloads button { border-radius:4px; text-underline-offset:3px; }
.history-downloads button:not(:disabled):active,.evidence-link:not(:disabled):active { background:#f0c6dd; }
@container review-workspace (min-width:900px) {
  .workbench-grid { grid-template-columns:240px minmax(0,1fr); }
  .review-workbench.portal-workbench .task-rail { position:sticky; top:16px; }
  .task-list,.queue-collapsed .task-list { display:grid; grid-template-columns:minmax(0,1fr); max-height:calc(100dvh - 184px); }
  .queue-toggle { display:none; }
}
@container review-detail (min-width:820px) {
  .finalization-section { grid-template-columns:minmax(0,1fr) auto; align-items:start; }
}
@container review-detail (max-width:640px) {
  .briefing { padding:16px; }.briefing-meta { grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px 16px; }
  .review-section,.finalization-section { padding:20px 16px; }.sheet-toolbar { padding:12px 16px; }
  .opinion-actions { display:grid; grid-template-columns:minmax(0,1fr); }
  .return-actions { padding-top:16px; border-top:1px solid var(--line); }.deadline-field { flex:1; }.deadline-field :deep(.el-date-editor) { width:100%; }
  .opinion-row { grid-template-columns:minmax(0,1fr) auto; }.opinion-row>span:not(.el-tag) { grid-row:2; grid-column:1/-1; }
}
@container review-workspace (max-width:540px) {
  .header-state { display:none; }.rail-heading { flex-wrap:wrap; }.rail-actions { margin-left:auto; }
  .task-list { grid-template-columns:minmax(0,1fr); max-height:240px; }
  .welcome-panel { padding:24px 16px; min-height:220px; }
  .review-workbench :deep(.el-button),.history-downloads button { min-height:44px; }
  .review-workbench :deep(.el-textarea__inner),.review-workbench :deep(.el-input__inner) { font-size:16px; }
  .deadline-field :deep(.el-date-editor) { min-height:44px; }
  .toolbar-actions { width:100%; }.toolbar-actions>.el-button { flex:1; padding-inline:8px; }
  .save-actions { display:grid; grid-template-columns:minmax(0,1fr); }.return-actions { display:grid; grid-template-columns:minmax(0,1fr); }
  .anomaly-actions { width:100%; }.anomaly-actions>.el-button { flex:1; }
  .adjustment-actions { display:grid; grid-template-columns:minmax(0,1fr); }.finalization-section>.el-button { justify-self:stretch; }
  .workbook-surface { height:clamp(300px,55dvh,480px); }
}
@media(max-width:620px) { .portal-layout .portal-content > .review-workbench.portal-workbench { padding:16px 12px max(16px,env(safe-area-inset-bottom)); } }
@media(pointer:coarse) { .review-workbench :deep(.el-button),.history-downloads button,.deadline-field :deep(.el-date-editor) { min-height:44px; }.review-workbench :deep(.el-textarea__inner),.review-workbench :deep(.el-input__inner) { font-size:16px; } }
@media(hover:hover) { .task-card:not(:disabled):hover,.evidence-link:not(:disabled):hover,.history-downloads button:not(:disabled):hover { background:var(--portal-accent-surface); } }
</style>

<style>
/* The date panel is teleported outside the workspace container. */
.monthly-review-deadline .el-date-picker { width:min(322px, calc(100vw - 26px)); }
.monthly-review-deadline .el-picker-panel__content { width:auto; margin-inline:12px; }
.monthly-review-deadline .el-picker-panel__body-wrapper { max-height:calc(100dvh - 32px); overflow-y:auto; }
@media(max-width:540px), (pointer:coarse) {
  .monthly-review-deadline .el-picker-panel__icon-btn { min-width:36px; min-height:44px; margin-top:0; }
  .monthly-review-deadline .el-picker-panel__footer .el-button { min-width:44px; min-height:44px; }
  .monthly-review-deadline .el-input__inner { font-size:16px; }
}
</style>
