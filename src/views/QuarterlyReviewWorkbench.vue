<template>
  <main class="quarterly-review portal-workbench">
    <header class="masthead">
      <div><h1>季度审核与评分</h1><p class="subhead">查看已提交报表，按指标审核、评分，并处理奖惩审批。</p></div>
      <el-button text :loading="loading" aria-label="刷新季度任务列表" @click="loadTasks">刷新列表</el-button>
    </header>

    <div class="workbench-grid" :class="{ 'without-queue': !tasks.length }">
      <aside v-if="tasks.length" class="task-rail" aria-label="季度任务列表">
        <div class="rail-heading"><div><h2>季度任务</h2></div><span class="count-pill">{{ tasks.length }}</span></div>
        <div v-if="listError" class="empty-state" role="alert">{{ listError }}<el-button text @click="loadTasks">重试任务列表</el-button></div>
        <div class="task-list">
        <button v-for="task in tasks" :key="task.id" type="button" class="task-card" :disabled="busy" :aria-current="Number(activeTaskId) === Number(task.id) ? 'true' : undefined" :class="{ selected: Number(activeTaskId) === Number(task.id) }" @click="selectTask(task)">
          <div class="task-card-top"><b>{{ task.periodCode }}</b><el-tag size="small" :type="statusType(task.status)">{{ statusLabel(task.status) }}</el-tag></div>
          <strong>{{ task.organizationName }}</strong><small>{{ task.reportTypeName }} · R{{ task.revisionNumber || '—' }}</small>
        </button>
        </div>
      </aside>

      <section v-if="detail" :key="detail.task.id" class="review-content" :aria-busy="workbookLoading || busy">
        <div v-if="detailError" class="review-notice" role="alert">{{ detailError }}<el-button :disabled="busy" @click="retryDetail">重新载入任务</el-button></div>
        <div v-if="actionError" class="review-notice" role="alert">{{ actionError }}<el-button :disabled="busy" @click="refreshDetail">刷新最新结果</el-button></div>
        <p v-if="busy" class="review-status" role="status">{{ processingMessage }}</p>
        <p v-else-if="hasDraft" class="review-status">有未保存内容：请保存对应指标，或提交奖惩审批后再离开。</p>
        <p v-if="detail.revision.status === 'finalized'" class="review-status">此修订已定稿，可查看和下载，不能继续修改。</p>
        <div class="briefing">
          <div class="briefing-title"><div><h2>{{ detail.task.organizationName }}</h2><p class="briefing-context">{{ detail.task.reportTypeName }} · {{ detail.task.periodCode }}</p></div><el-tag :type="statusType(detail.task.status)">{{ statusLabel(detail.task.status) }}</el-tag></div>
          <div class="briefing-meta"><span>提交修订 <b>R{{ detail.revision.number }}</b></span><span>提交时间 <b>{{ formatDate(detail.revision.submittedAt) }}</b></span><span>模板配置 <b>V{{ detail.task.packageVersion }}</b></span><span>协作版本 <b>{{ detail.revision.collaborationVersion ?? '—' }}</b></span></div>
          <p class="snapshot-note">以下报表保留提交时的内容，仅供核对；保存审核意见和评分不会修改报表数据。</p>
        </div>

        <section v-if="detail.dataAdjustment" class="panel data-adjustment-panel">
          <div class="panel-heading"><div><h3>季度数据更正申请</h3></div><el-tag :type="detail.dataAdjustment.status === 'applied' ? 'success' : detail.dataAdjustment.status === 'rejected' ? 'danger' : 'warning'">{{ adjustmentStatusLabel(detail.dataAdjustment.status) }}</el-tag></div>
          <p>{{ detail.dataAdjustment.reason }}</p>
          <small>涉及字段：{{ (detail.dataAdjustment.changedFields || []).join('、') || '—' }} · 审核部门：{{ (detail.dataAdjustment.requiredDepartments || []).join('、') || '—' }}</small>
          <div v-if="detail.permissions.isApprover && detail.dataAdjustment.status === 'management_approval'" class="button-row">
            <el-button size="small" type="success" :disabled="actionsLocked" :loading="adjustmentDecisionBusy" @click="decideDataAdjustment('approve')">批准季度更正</el-button>
            <el-button size="small" type="danger" plain :disabled="actionsLocked" :loading="adjustmentDecisionBusy" @click="decideDataAdjustment('reject')">驳回季度更正</el-button>
          </div>
          <p v-if="detail.dataAdjustment.status === 'approved'" class="adjustment-next-step">管理审批已通过；完成受影响指标评分后，可由配置包定稿人重新计算整包排名并定稿。</p>
        </section>

        <section v-if="detail.quarterlyDependencies" class="panel dependency-panel" :class="{ incomplete: !detail.quarterlyDependencies.complete }">
          <div class="panel-heading"><div><h3>收入与利润的月报来源</h3></div><el-tag :type="detail.quarterlyDependencies.complete ? 'success' : 'warning'">{{ detail.quarterlyDependencies.complete ? '已齐全' : '未齐全' }}</el-tag></div>
          <div class="dependency-grid"><span>本季度收入 <b>{{ money(detail.quarterlyDependencies.currentQuarter?.revenue?.value) }}</b></span><span>本季度利润 <b>{{ money(detail.quarterlyDependencies.currentQuarter?.profit?.value) }}</b></span><span>年初至今收入 <b>{{ money(detail.quarterlyDependencies.yearToDate?.revenue?.value) }}</b></span><span>年初至今利润 <b>{{ money(detail.quarterlyDependencies.yearToDate?.profit?.value) }}</b></span></div>
          <small v-if="!detail.quarterlyDependencies.complete">月报来源未齐全，暂不能评分、提交奖惩或定稿。请先核对以下月份：{{ (detail.quarterlyDependencies.missingPeriods || []).map(item => `${item.periodCode}（${dependencyStatusLabel(item.status, item.missingMetrics)}）`).join('、') || '缺少有效来源数据，请联系月报负责人核对。' }}</small>
        </section>

        <div class="review-layout">
          <section class="panel workbook-panel">
            <div class="panel-heading"><div><h3>已提交报表</h3></div><small>仅供查看</small></div>
            <div v-if="workbookLoading" class="workbook-loading" role="status">正在加载已提交报表…</div>
            <div ref="workbookHost" class="workbook-surface" :class="{ hidden: workbookLoading }" aria-label="已提交的季度报表，只读" />
          </section>

          <aside class="scoring-column">
            <section class="panel indicator-panel">
              <div class="panel-heading"><div><h3>{{ detail.permissions.isManagementReader ? '指标审核与评分' : '待我审核的指标' }}</h3></div><span class="count-pill">{{ detail.indicators.length }}</span></div>
              <article v-for="item in detail.indicators" :key="item.id" class="indicator-card">
                <div class="indicator-title"><div><small>{{ item.code }} · {{ item.configuration.category === 'key_work' ? '重点工作' : '重点业务' }}</small><b>{{ item.displayName }}</b></div><el-tag size="small" :type="reviewType(item.review.status)">{{ reviewLabel(item.review.status) }}</el-tag></div>
                <p class="indicator-meta">权重 {{ number(item.weight) }}% <span>最高分 {{ number(item.configuration.maximumScore) }}</span><span v-if="item.configuration.exempt || item.configuration.isExempt">豁免，按满分计</span><span v-if="item.scoring?.score != null">得分 <b>{{ number(item.scoring.score) }}</b></span></p>
                <template v-if="detail.permissions.canReview && Number(item.configuration.reviewerUserId) === currentUserId && isAdjustmentIndicator(item)">
                  <label class="review-label" :for="`review-opinion-${item.id}`">审核意见（必填）</label>
                  <el-input :id="`review-opinion-${item.id}`" v-model="reviewDrafts[item.id]" :disabled="actionsLocked" :aria-label="`${item.displayName}：审核意见`" type="textarea" :rows="3" maxlength="2000" placeholder="填写审核依据或需整改事项，最多 2000 字" />
                  <label class="review-label" :for="`review-deadline-${item.id}`">整改截止时间（退回时必填）</label>
                  <el-date-picker popper-class="quarterly-review-date-popper" :id="`review-deadline-${item.id}`" v-model="reviewDeadlineDrafts[item.id]" :disabled="actionsLocked" :aria-label="`${item.displayName}：整改截止时间`" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" placeholder="选择晚于当前时间的日期" />
                  <div class="button-row"><el-button size="small" :disabled="actionsLocked" @click="saveReview(item, 'in_review')">标记为审核中</el-button><el-button size="small" type="success" :disabled="actionsLocked" @click="saveReview(item, 'approved')">审核通过</el-button><el-button size="small" type="warning" :disabled="actionsLocked || !reviewDeadlineDrafts[item.id]" @click="saveReview(item, 'returned')">退回整改</el-button></div>
                </template>
                <template v-if="detail.permissions.isScorer && isAdjustmentIndicator(item) && !item.configuration.scoreFormulaVersionId && !item.configuration.formulaVersionId && !item.configuration.exempt && !item.configuration.isExempt">
                  <label class="review-label" :for="`review-score-${item.id}`">指标得分（0–{{ number(item.configuration.maximumScore) }}）</label>
                  <div class="score-row"><el-input-number :id="`review-score-${item.id}`" v-model="scoreDrafts[item.id]" :disabled="actionsLocked || !detail.quarterlyDependencies?.complete" :min="0" :max="Number(item.configuration.maximumScore)" :precision="4" controls-position="right" :aria-label="`${item.displayName}：指标得分`" /><el-button size="small" type="primary" :loading="pendingAction === `score:${item.id}`" :disabled="actionsLocked || !detail.quarterlyDependencies?.complete || scoreDrafts[item.id] == null" @click="saveScore(item)">保存评分</el-button></div>
                </template>
                <div v-else-if="item.scoring?.scoreSource === 'formula'" class="automatic-score">自动评分 · 公式版本 {{ item.scoring.formulaVersionId }}</div>
                <div v-else-if="item.scoring?.scoreSource === 'exempt'" class="automatic-score">豁免项，满分 {{ number(item.scoring.score) }}</div>
              </article>
            </section>

            <section v-if="detail.anomalies?.length" class="panel anomaly-panel">
              <div class="panel-heading"><div><h3>数据异常处理</h3></div><span class="count-pill">{{ detail.anomalies.length }}</span></div>
              <article v-for="anomaly in detail.anomalies" :key="anomaly.id" class="anomaly-item"><div><b>{{ anomaly.fieldCode || anomaly.ruleCode || '校验项目' }}</b><el-tag size="small" :type="anomaly.disposition === 'accepted' ? 'success' : anomaly.disposition === 'correction_requested' ? 'danger' : 'warning'">{{ anomaly.disposition === 'accepted' ? '已接受' : anomaly.disposition === 'correction_requested' ? '要求更正' : '待处理' }}</el-tag></div><p>{{ anomaly.message }}</p><div v-if="detail.permissions.canReview && anomaly.severity !== 'error' && !anomaly.disposition" class="button-row"><el-button size="small" type="success" plain :disabled="actionsLocked" @click="setAnomaly(anomaly, 'accepted')">接受说明</el-button><el-button size="small" type="danger" plain :disabled="actionsLocked" @click="setAnomaly(anomaly, 'correction_requested')">要求更正</el-button></div></article>
            </section>

            <section v-if="detail.attachments?.length" class="panel evidence-panel">
              <div class="panel-heading"><div><h3>提交附件</h3></div></div>
              <button v-for="file in detail.attachments" :key="file.id" type="button" class="evidence-link" :aria-label="`下载附件：${file.originalName}`" @click="downloadEvidence(file)"><span><b>{{ file.originalName }}</b><small>{{ file.indicatorCode || '任务级附件' }} · {{ bytes(file.byteSize) }}</small></span><el-icon aria-hidden="true"><Download /></el-icon></button>
            </section>

            <section v-if="detail.permissions.isManagementReader" class="panel total-panel">
              <div class="panel-heading"><div><h3>组织总分与奖惩</h3></div></div>
              <div v-if="detail.scoreSummary" class="score-total"><b>{{ Number(detail.scoreSummary.totalScore).toFixed(2) }}</b><small>指标加权 {{ Number(detail.scoreSummary.indicatorSubtotal).toFixed(2) }} · 奖励 {{ number(detail.scoreSummary.rewards) }} · 惩罚 {{ number(detail.scoreSummary.penalties) }}</small></div>
              <el-divider v-if="detail.permissions.isScorer" />
              <template v-if="detail.permissions.isScorer">
                <p class="review-help">奖惩金额填写正数（0.01–10000）；选择奖励或惩罚后提交审批。</p>
                <div class="adjustment-form">
                  <div class="adjustment-field"><label class="review-label" for="quarterly-adjustment-type">奖惩类型</label><el-select id="quarterly-adjustment-type" v-model="adjustmentType" :disabled="actionsLocked" aria-label="奖惩类型"><el-option label="奖励" value="reward" /><el-option label="惩罚" value="penalty" /></el-select></div>
                  <div class="adjustment-field"><label class="review-label" for="quarterly-adjustment-amount">奖惩金额</label><el-input-number id="quarterly-adjustment-amount" v-model="adjustmentAmount" :disabled="actionsLocked" :min="0.01" :max="10000" :precision="2" controls-position="right" aria-label="奖惩金额" /></div>
                  <div class="adjustment-field adjustment-reason"><label class="review-label" for="quarterly-adjustment-reason">奖惩原因</label><el-input id="quarterly-adjustment-reason" v-model="adjustmentReason" :disabled="actionsLocked" aria-label="奖惩原因" maxlength="1000" placeholder="说明奖惩依据及相关事项，最多 1000 字" /></div>
                  <el-button class="adjustment-submit" type="primary" size="small" :loading="pendingAction === 'adjustment:create'" :disabled="actionsLocked || !detail.quarterlyDependencies?.complete || !adjustmentReason.trim()" @click="addAdjustment">提交奖惩审批</el-button>
                </div>
              </template>
              <div v-for="adjustment in detail.adjustments" :key="adjustment.id" class="adjustment-item"><div><b>{{ adjustment.adjustmentType === 'reward' ? '奖励' : '惩罚' }} {{ number(adjustment.amount) }}</b><el-tag size="small" :type="adjustment.status === 'approved' ? 'success' : adjustment.status === 'rejected' ? 'danger' : 'warning'">{{ adjustment.status === 'approved' ? '已批准' : adjustment.status === 'rejected' ? '已驳回' : '待审批' }}</el-tag></div><p>{{ adjustment.reason }}</p><small v-if="adjustment.decisionNote">审批说明：{{ adjustment.decisionNote }}</small><div v-if="detail.permissions.isApprover && adjustment.status === 'pending'" class="button-row"><el-button size="small" type="success" :disabled="actionsLocked" @click="decideAdjustment(adjustment, 'approved')">批准奖惩</el-button><el-button size="small" type="danger" plain :disabled="actionsLocked" @click="decideAdjustment(adjustment, 'rejected')">驳回奖惩</el-button></div></div>
              <p v-if="detail.permissions.canFinalize" id="quarterly-finalize-hint" class="review-help">{{ finalizationHint }}</p>
              <el-button v-if="detail.permissions.canFinalize" class="finalize-button" type="primary" :loading="finalizing" :disabled="actionsLocked || hasDraft || !spread || !detail.quarterlyDependencies?.complete" aria-describedby="quarterly-finalize-hint" @click="finalize">统一定稿并生成排名</el-button>
              <div v-if="rankings.length" class="rank-list"><h4>统一排名</h4><div v-for="row in rankings" :key="row.organizationId"><b>{{ row.rank }}</b><span>{{ row.organizationName }}<small v-if="row.redemptionCoefficient != null">兑换系数 {{ number(row.redemptionCoefficient) }}</small></span><strong>{{ Number(row.totalScore).toFixed(2) }}</strong></div></div>
              <div v-if="detail.officialArtifacts?.length" class="rank-list"><h4>正式归档</h4><button v-for="artifact in detail.officialArtifacts" :key="artifact.artifactType" type="button" class="artifact-download" :aria-label="`下载${artifactLabel(artifact.artifactType)}`" @click="downloadOfficialArtifact(artifact)">{{ artifactLabel(artifact.artifactType) }} <el-icon aria-hidden="true"><Download /></el-icon></button></div>
            </section>
          </aside>
        </div>
      </section>
      <section v-else class="welcome-panel">
        <template v-if="workbookLoading"><h2 role="status">正在加载审核资料…</h2><p>正在读取任务和提交快照。</p></template>
        <template v-else-if="detailError"><h2>任务暂时无法打开</h2><p role="alert">{{ detailError }}</p><el-button @click="retryDetail">重新载入任务</el-button></template>
        <template v-else-if="listError"><h2>任务列表读取失败</h2><p>请重试加载任务列表。</p><el-button @click="loadTasks">重试任务列表</el-button></template>
        <template v-else-if="loading"><h2 role="status">正在加载季度任务…</h2></template>
        <template v-else-if="!tasks.length"><h2>暂无可审核的季度任务</h2><p>任务提交并分配给你后，会显示在这里。</p></template>
        <template v-else><h2>选择一项季度任务</h2><p>选择任务后，核对已提交报表，再处理指标审核、评分和奖惩审批。</p></template>
      </section>
    </div>
  </main>
</template>

<script>
import { workflowApi } from '@/api'
import { returnToWorkflow } from '@/utils/workflowNavigation'
import { markRaw } from 'vue'
import { Download } from '@element-plus/icons-vue'
import { observeWorkbookLayout } from '@/utils/observeWorkbookLayout'
import { prepareTemplateFunctions } from '@/template/managedFunctions'
import { restoreRevisionWorkbook } from '@/template/restoreRevisionWorkbook'
import GC from '@grapecity-software/spread-sheets'
import '@grapecity-software/spread-sheets-io'
import '@grapecity-software/spread-sheets-print'
import '@grapecity-software/spread-sheets-pdf'
import { collaborationApi, quarterlyReviewApi } from '../api'

export default {
  name: 'QuarterlyReviewWorkbench',
  components: { Download },
  data() { return { tasks: [], activeTaskId: null, detail: null, spread: null, stopWorkbookLayout: null, loading: false, workbookLoading: false,
    finalizing: false, refreshing: false, adjustmentDecisionBusy: false, pendingAction: '', listError: '', detailError: '', actionError: '', requestSequence: 0, listSequence: 0, disposed: false,
    reviewDrafts: {}, reviewDeadlineDrafts: {}, scoreDrafts: {}, adjustmentType: 'reward', adjustmentAmount: 0.01,
    adjustmentReason: '', rankings: [], listController: null, detailController: null } },
  computed: {
    currentUserId() { try { return Number(JSON.parse(localStorage.getItem('userInfo') || '{}').id) } catch { return 0 } },
    busy() { return Boolean(this.pendingAction || this.finalizing || this.adjustmentDecisionBusy || this.refreshing) },
    processingMessage() {
      if (this.finalizing) return '正在生成各组织的正式文件并统一定稿，请勿关闭或切换页面。'
      if (this.refreshing) return '正在更新审核结果，未保存的输入会保留。'
      if (this.adjustmentDecisionBusy) return '正在处理季度数据更正审批…'
      if (this.pendingAction.startsWith('review:')) return '正在保存指标审核结果…'
      if (this.pendingAction.startsWith('score:')) return '正在保存指标评分…'
      if (this.pendingAction === 'adjustment:create') return '正在提交奖惩申请…'
      if (this.pendingAction.startsWith('adjustment:')) return '正在保存奖惩审批结果…'
      return '正在保存异常处理结果…'
    },
    finalizationHint() {
      if (this.detail?.revision.status === 'finalized') return '当前修订已定稿，正式报表可在下方下载。'
      if (this.hasDraft) return '请先保存指标内容或提交奖惩审批，再进行统一定稿。'
      if (this.detailError) return '请先重新载入任务，确认提交内容后再定稿。'
      if (this.workbookLoading || !this.spread) return '请等待已提交报表加载完成，再进行定稿。'
      if (!this.detail?.quarterlyDependencies?.complete) return '月报来源未齐全，暂不能定稿。请核对上方列出的月份。'
      return '将检查本配置包内所有组织的审核、评分、审批和月报来源；满足条件后统一定稿，生成排名及正式 XLSX、PDF 文件。'
    },
    actionsLocked() { return this.busy || this.workbookLoading || Boolean(this.detailError) || !this.detail || this.detail.revision.status === 'finalized' },
    hasDraft() {
      return Boolean(this.adjustmentReason.trim()) || (this.detail?.indicators || []).some(item =>
        String(this.reviewDrafts[item.id] || '') !== String(item.review?.opinion || '') ||
        String(this.reviewDeadlineDrafts[item.id] || '') !== String(item.review?.remediationDeadline || '') ||
        (this.scoreDrafts[item.id] ?? null) !== (item.scoring?.score == null ? null : Number(item.scoring.score)))
    }
  },
  watch: { '$route.params.taskId': { immediate: true, handler(value) { this.openTask(value ? Number(value) : null) } } },
  mounted() { this.loadTasks(); window.addEventListener('beforeunload', this.warnBeforeUnload) },
  beforeRouteUpdate(to, from) { return to.params.taskId === from.params.taskId || this.confirmLeave() },
  beforeRouteLeave() { return this.confirmLeave() },
  beforeUnmount() { this.disposed = true; this.requestSequence++; this.listSequence++; this.listController?.abort(); this.detailController?.abort(); window.removeEventListener('beforeunload', this.warnBeforeUnload); if (!this.finalizing) this.destroySpread() },
  methods: {
    warnBeforeUnload(event) { if (this.hasDraft || this.busy) { event.preventDefault(); event.returnValue = '' } },
    async confirmLeave() {
      if (this.busy) { this.$message.warning('正在保存或定稿，请完成后再切换任务。'); return false }
      if (!this.hasDraft) return true
      try { await this.$confirm('有未保存的审核意见、评分或奖惩原因。离开将放弃这些内容。', '放弃未保存内容？',
        { confirmButtonText: '放弃并离开', cancelButtonText: '继续填写', type: 'warning' }); return true }
      catch { return false }
    },
    async runAction(key, work) {
      if (this.actionsLocked) return
      this.pendingAction = key; this.actionError = ''
      try { await work(Number(this.detail.task.id)) }
      catch (error) { if (!this.disposed) this.actionError = error?.message || '操作未完成，请检查输入后重试。' }
      finally { this.pendingAction = '' }
    },
    async returnWhenStageDone() {
      if (!this.$route.query.workflowFrom || this.hasDraft || this.disposed) return
      const sequence = this.requestSequence
      try {
        const result = await workflowApi.list()
        if (this.disposed || sequence !== this.requestSequence || this.hasDraft || this.actionError || this.detailError) return
        const item = result.items.find(row => row.taskId === Number(this.activeTaskId))
        if (!item?.todo || (this.$route.query.workflowStage && item.stage !== this.$route.query.workflowStage)) { this.pendingAction = ''; returnToWorkflow(this) }
      } catch { if (!this.disposed) this.actionError = '操作已保存，但流程状态读取失败。请刷新结果后返回流程中心，无需重复提交。' }
    },
    async loadTasks() {
      const sequence = ++this.listSequence
      this.listController?.abort()
      const controller = markRaw(new AbortController()); this.listController = controller
      this.loading = true; this.listError = ''
      try { const result = await quarterlyReviewApi.getTasks({ signal: controller.signal }); if (!this.disposed && sequence === this.listSequence) this.tasks = result.tasks || [] }
      catch (error) { if (!this.disposed && sequence === this.listSequence) this.listError = error?.message || '任务列表读取失败，请重试。' }
      finally { if (this.listController === controller) this.listController = null; if (!this.disposed && sequence === this.listSequence) this.loading = false }
    },
    async selectTask(task) { if (this.busy || Number(this.activeTaskId) === Number(task.id)) return; await this.$router.replace({ name: 'QuarterlyReviewWorkbench', params: { taskId: task.id }, query: this.$route.query }) },
    async retryDetail() { if (!this.busy && await this.confirmLeave()) await this.openTask(this.activeTaskId) },
    async openTask(taskId) {
      const sequence = ++this.requestSequence
      this.detailController?.abort(); this.detailController = null
      const current = () => !this.disposed && sequence === this.requestSequence
      this.activeTaskId = taskId; this.detail = null; this.rankings = []; this.detailError = ''; this.actionError = ''
      this.reviewDrafts = {}; this.reviewDeadlineDrafts = {}; this.scoreDrafts = {}; this.adjustmentReason = ''
      this.adjustmentType = 'reward'; this.adjustmentAmount = 0.01
      this.workbookLoading = taskId != null; this.destroySpread()
      if (taskId == null) return
      let workbook, controller
      try {
        if (!Number.isSafeInteger(taskId) || taskId <= 0) throw new Error('任务编号无效，请从任务列表重新选择。')
        controller = markRaw(new AbortController()); this.detailController = controller
        const detail = await quarterlyReviewApi.getTask(taskId, { signal: controller.signal })
        if (!current()) return
        this.detail = detail
        this.rankings = this.detail.rankings || []
        this.reviewDrafts = Object.fromEntries(this.detail.indicators.map(item => [item.id, item.review?.opinion || '']))
        this.reviewDeadlineDrafts = Object.fromEntries(this.detail.indicators.map(item => [item.id, item.review?.remediationDeadline || '']))
        this.scoreDrafts = Object.fromEntries(this.detail.indicators.map(item => [item.id, item.scoring?.score == null ? null : Number(item.scoring.score)]))
        await this.$nextTick()
        await prepareTemplateFunctions(detail.workbook)
        if (!current()) return
        workbook = markRaw(new GC.Spread.Sheets.Workbook(this.$refs.workbookHost, { sheetCount: 1, tabEditable: false,
          newTabVisible: false, allowSheetReorder: false, allowUserResize: false, allowUserZoom: true,
          allowUserDragDrop: false, allowUserDragFill: false, allowUndo: false, allowContextMenu: false }))
        await restoreRevisionWorkbook(workbook, detail.workbook)
        if (!current()) return
        for (let index = 0; index < workbook.getSheetCount(); index++) {
          const sheet = workbook.getSheet(index)
          sheet.getRange(-1, -1, -1, -1).locked(true)
          sheet.options.isProtected = true
          sheet.options.protectionOptions = { allowSelectLockedCells: true, allowSelectUnlockedCells: true,
            allowSort: false, allowFilter: false, allowResizeRows: false, allowResizeColumns: false,
            allowEditObjects: false, allowDragInsertRows: false, allowDragInsertColumns: false,
            allowInsertRows: false, allowInsertColumns: false, allowDeleteRows: false, allowDeleteColumns: false,
            allowOutlineRows: false, allowOutlineColumns: false, allowUsePivotTable: false }
        }
        this.spread = workbook; workbook = null
      } catch (error) { if (current()) this.detailError = `加载季度审核资料失败：${error?.message || '请重试'}` }
      finally {
        if (this.detailController === controller) this.detailController = null
        workbook?.destroy()
        if (current()) {
          this.workbookLoading = false
          await this.$nextTick()
          if (current() && this.spread) this.stopWorkbookLayout = observeWorkbookLayout(this.spread.getHost(), this.spread)
        }
      }
    },
    destroySpread() { this.stopWorkbookLayout?.(); this.stopWorkbookLayout = null; if (this.spread) { this.spread.destroy(); this.spread = null } },
    async refreshDetail() {
      const previous = this.detail, sequence = this.requestSequence
      if (!previous || this.refreshing) return
      this.refreshing = true; this.actionError = ''
      try {
        const next = await quarterlyReviewApi.getTask(previous.task.id, { includeWorkbook: false })
        if (this.disposed || sequence !== this.requestSequence) return
        if (next.revision.id !== previous.revision.id) {
          this.detailError = '任务已有新的提交修订。请先保留未保存内容，再重新载入。'; return
        }
        // Only replace pristine fields; other indicators may still contain unsaved work.
        const previousIndicators = new Map(previous.indicators.map(item => [item.id, item]))
        for (const item of next.indicators) {
          const old = previousIndicators.get(item.id)
          if (!old || String(this.reviewDrafts[item.id] || '') === String(old.review?.opinion || '')) this.reviewDrafts[item.id] = item.review?.opinion || ''
          if (!old || String(this.reviewDeadlineDrafts[item.id] || '') === String(old.review?.remediationDeadline || '')) this.reviewDeadlineDrafts[item.id] = item.review?.remediationDeadline || ''
          if (!old || (this.scoreDrafts[item.id] ?? null) === (old.scoring?.score == null ? null : Number(old.scoring.score))) this.scoreDrafts[item.id] = item.scoring?.score == null ? null : Number(item.scoring.score)
        }
        this.detail = { ...next, workbook: previous.workbook }; this.rankings = next.rankings || []
        await this.loadTasks()
      } catch (error) { if (!this.disposed && sequence === this.requestSequence) this.actionError = `最新结果读取失败：${error?.message || '请重试刷新结果'}。未保存输入已保留；请先刷新确认结果，避免重复提交。` }
      finally { this.refreshing = false }
    },
    async saveReview(item, status) {
      await this.runAction(`review:${item.id}`, async taskId => {
        const opinion = String(this.reviewDrafts[item.id] || '').trim(), deadline = this.reviewDeadlineDrafts[item.id]
        if (!opinion || opinion.length > 2000) throw new Error('请填写审核意见，最多 2000 字。')
        if (status === 'returned' && (!deadline || !Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now())) throw new Error('请填写晚于当前时间的整改截止时间。')
        const result = await quarterlyReviewApi.saveReview(taskId, item.id, { status,
        expectedVersion: Number(item.review?.version || 0), opinion,
        ...(status === 'returned' ? { remediationDeadline: this.reviewDeadlineDrafts[item.id] } : {}) })
        if (this.disposed) return
        this.reviewDrafts[item.id] = opinion
        item.review = { ...item.review, status, version: result.version, opinion,
          remediationDeadline: status === 'returned' ? deadline : null }; this.$message.success('指标审核结果已保存'); await this.returnWhenStageDone()
      })
    },
    async saveScore(item) {
      await this.runAction(`score:${item.id}`, async taskId => {
        if (!this.detail.quarterlyDependencies?.complete) throw new Error('月报依赖未齐全，暂不能保存评分。')
        const score = this.scoreDrafts[item.id], maximum = Number(item.configuration.maximumScore)
        if (score == null || !Number.isFinite(Number(score)) || Number(score) < 0 || !Number.isFinite(maximum) || Number(score) > maximum) throw new Error(`请填写 0 至 ${this.number(maximum)} 之间的有效得分。`)
        const result = await quarterlyReviewApi.saveScore(taskId, item.id, { score,
        expectedVersion: Number(item.scoring?.version || 0) })
        if (this.disposed) return
        item.scoring = { ...item.scoring, ...result, score: Number(score), scoreSource: 'manual' }; await this.refreshDetail(); this.$message.success('评分已保存'); await this.returnWhenStageDone()
      })
    },
    async addAdjustment() {
      await this.runAction('adjustment:create', async taskId => {
        if (!this.detail.quarterlyDependencies?.complete) throw new Error('月报依赖未齐全，暂不能提交奖惩。')
        const amount = Number(this.adjustmentAmount), reason = this.adjustmentReason.trim()
        if (!reason || !Number.isFinite(amount) || amount < 0.01 || amount > 10000) throw new Error('请填写奖惩原因和 0.01 至 10000 之间的金额。')
        await quarterlyReviewApi.addAdjustment(taskId, { adjustmentType: this.adjustmentType, amount, reason })
        if (this.disposed) return
        this.adjustmentReason = ''; await this.refreshDetail(); this.$message.success('奖惩申请已提交，等待审批')
      })
    },
    async decideAdjustment(item, decision) {
      await this.runAction(`adjustment:${item.id}`, async taskId => {
        await quarterlyReviewApi.decideAdjustment(taskId, item.id, { decision }); if (this.disposed) return
        await this.refreshDetail(); this.$message.success(decision === 'approved' ? '奖惩已批准' : '奖惩已驳回'); await this.returnWhenStageDone()
      })
    },
    isAdjustmentIndicator(item) { return !this.detail?.dataAdjustment
      || (this.detail.dataAdjustment.affectedIndicatorIds || []).includes(Number(item.id)) },
    async decideDataAdjustment(decision) {
      if (this.actionsLocked) return
      const taskId = this.detail.task.id
      this.adjustmentDecisionBusy = true
      try {
        const title = decision === 'approve' ? '批准季度数据更正' : '驳回季度数据更正'
        const { value } = await this.$prompt('请填写本次管理审批意见。', title,
          { inputPlaceholder: '记录审批意见', inputValidator: value => Boolean(value?.trim()) || '请填写审批意见' })
        await collaborationApi.decideMonthlyAdjustment(taskId, { decision, note: value.trim() })
        if (this.disposed) return
        await this.refreshDetail()
        this.$message.success(decision === 'approve' ? '季度更正已批准，可进入整包重定稿' : '季度更正已驳回，原定稿继续生效'); this.adjustmentDecisionBusy = false; if (!this.hasDraft) returnToWorkflow(this)
      } catch (error) { if (error !== 'cancel' && error !== 'close') this.$message.error(error.message || '处理季度更正失败') }
      finally { this.adjustmentDecisionBusy = false }
    },
    async setAnomaly(item, disposition) {
      await this.runAction(`anomaly:${item.id}`, async taskId => {
        await collaborationApi.saveAnomalyDisposition(taskId, item.id, disposition); if (this.disposed) return
        item.disposition = disposition; this.$message.success('异常处置已保存')
      })
    },
    async exportWorkbookArtifacts(workbookJson) {
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:800px;overflow:hidden'
      document.body.appendChild(host)
      let workbook
      try {
        workbook = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1, tabEditable: false, newTabVisible: false })
        await prepareTemplateFunctions(workbookJson)
        await restoreRevisionWorkbook(workbook, workbookJson)
        const xlsx = await new Promise((resolve, reject) => workbook.export(resolve, reject,
          { fileType: GC.Spread.Sheets.FileType.excel, includeBindingSource: false }))
        const pdf = await new Promise((resolve, reject) => workbook.savePDF(resolve, reject,
          { author: '成本指标平台', creator: 'SpreadJS 19.1.4' }))
        return { xlsx, pdf }
      } finally { if (workbook) workbook.destroy(); host.remove() }
    },
    async downloadEvidence(file) {
      try { const blob = await collaborationApi.downloadEvidenceAttachment(this.activeTaskId, file.id); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = file.originalName; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000) }
      catch (error) { this.$message.error(error.message) }
    },
    async downloadOfficialArtifact(artifact) {
      const detail = this.detail
      try {
        const blob = await collaborationApi.downloadFinalizedArtifact(detail.task.id, detail.revision.id, artifact.artifactType)
        const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url
        link.download = `${detail.task.organizationCode}-${detail.task.periodCode}-${artifact.artifactType}${artifact.artifactType.endsWith('xlsx') ? '.xlsx' : artifact.artifactType.endsWith('pdf') ? '.pdf' : '.json'}`
        link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      } catch (error) { this.$message.error(error.message) }
    },
    async finalize() {
      if (this.actionsLocked || !this.spread) return
      if (this.hasDraft) { this.actionError = '请先保存审核意见、评分和奖惩原因，再定稿。'; return }
      const taskId = this.detail.task.id, selectedDetail = this.detail, workbook = this.spread
      this.finalizing = true; this.actionError = ''
      try {
        const selectedTask = this.tasks.find(task => Number(task.id) === Number(taskId))
        const packageTasks = this.tasks.filter(task => Number(task.packageId) === Number(selectedTask?.packageId))
        if (!packageTasks.length) throw new Error('未找到此季度配置包内的组织任务')
        const form = new FormData()
        for (const task of packageTasks) {
          if (this.disposed) return
          const detail = Number(task.id) === Number(taskId) ? selectedDetail : await quarterlyReviewApi.getTask(task.id)
          const exported = Number(task.id) === Number(taskId)
            ? await (async () => ({
              xlsx: await new Promise((resolve, reject) => workbook.export(resolve, reject,
                { fileType: GC.Spread.Sheets.FileType.excel, includeBindingSource: false })),
              pdf: await new Promise((resolve, reject) => workbook.savePDF(resolve, reject,
                { author: '成本指标平台', creator: 'SpreadJS 19.1.4' }))
            }))()
            : await this.exportWorkbookArtifacts(detail.workbook)
          form.append('artifacts', exported.xlsx, `${task.id}.xlsx`)
          form.append('artifacts', exported.pdf, `${task.id}.pdf`)
        }
        if (this.disposed) return
        const result = await quarterlyReviewApi.finalize(taskId, form)
        if (this.disposed) return
        this.rankings = result.rankings || []
        this.$message.success(`季度已定稿，当前组织排名第 ${result.ranking} 名，正式归档已生成`); this.finalizing = false; if (returnToWorkflow(this)) return
        await this.refreshDetail()
      }
      catch (error) { if (!this.disposed) this.actionError = `季度定稿未完成：${error?.message || '请稍后重试'}` }
      finally { this.finalizing = false; if (this.disposed) this.destroySpread() }
    },
    statusLabel(status) { return ({ submitted: '待审核', reviewing: '审核中', finalized: '已定稿' })[status] || status || '未知' },
    dependencyStatusLabel(status, missingMetrics = []) {
      if (status === 'finalized' && missingMetrics.length) return `已定稿，但缺少${missingMetrics.map(metric => ({ revenue: '收入', profit: '利润' })[metric] || '来源数值').join('、')}`
      return ({ task_missing: '尚无月报任务', ambiguous_tasks: '存在多个候选任务，请核对来源', revision_pending: '尚无有效定稿', superseded: '原定稿已被替代', finalized: '已定稿' })[status] || '来源待核对'
    },
    adjustmentStatusLabel(status) { return ({ draft: '草稿', department_review: '部门审核', management_approval: '管理审批', approved: '已批准待定稿', applied: '已应用', rejected: '已驳回' })[status] || status || '未知' },
    statusType(status) { return status === 'finalized' ? 'success' : status === 'reviewing' ? 'warning' : 'info' },
    reviewLabel(status) { return ({ pending: '待处理', in_review: '审核中', approved: '已通过', returned: '已退回' })[status] || status },
    reviewType(status) { return status === 'approved' ? 'success' : status === 'returned' ? 'danger' : status === 'in_review' ? 'warning' : 'info' },
    money(value) { return value == null ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) },
    number(value) { return value == null || value === '' ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 4 }) },
    bytes(value) { return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB` },
    artifactLabel(type) { return ({ finalized_workbook_json: '报表快照（JSON）', finalized_xlsx: '正式报表（XLSX）', finalized_pdf: '正式报表（PDF）', structured_data_json: '原始数据（JSON）', version_manifest_json: '版本清单（JSON）' })[type] || type },
    formatDate(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false }) }
  }
}
</script>

<style scoped>

.review-notice { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px; margin-bottom: 12px; border: 1px solid var(--portal-line); border-radius: var(--portal-radius-panel); background: var(--portal-surface); overflow-wrap: anywhere; }
.review-status, .review-label { color: var(--portal-muted); font-size: 14px; line-height: 1.6; }
.review-label { display: block; margin: 10px 0 5px; }
.task-card:disabled { cursor: wait; opacity: .65; }
.task-card:focus-visible, .evidence-link:focus-visible, .artifact-download:focus-visible { outline: 2px solid var(--portal-focus); outline-offset: 2px; }
.task-card strong, .task-card small, .indicator-title, .evidence-link > span, .review-notice { min-width: 0; overflow-wrap: anywhere; }
.indicator-card :deep(.el-date-editor) { max-width: 100%; }
.quarterly-review .welcome-panel { min-height: 220px; }

.data-adjustment-panel{border:1px solid var(--portal-line)}.data-adjustment-panel>p{margin:4px 0 8px;font-size:12px;line-height:1.6}.data-adjustment-panel>small,.adjustment-next-step{color:var(--muted);font-size:12px;line-height:1.5}.adjustment-next-step{margin-top:9px!important}
.masthead,.briefing-title,.rail-heading,.panel-heading,.task-card-top,.indicator-title,.indicator-title>div,.anomaly-item>div:first-child,.adjustment-item>div:first-child{display:flex;align-items:center;justify-content:space-between;gap:12px}.masthead{align-items:flex-end;padding-bottom:21px;border-bottom:1px solid var(--line)}.masthead h1{margin:0;font:500 32px Arial,"Microsoft YaHei",sans-serif}.subhead{margin:7px 0 0;color:var(--muted);font-size:12px}.workbench-grid{display:grid;grid-template-columns:220px minmax(0,1fr);gap:18px;padding-top:18px}.task-rail{align-self:start;position:sticky;top:14px;max-height:calc(100vh - 40px);overflow:auto;padding:14px;background:#ffffffb8;border:1px solid var(--line);border-radius:9px}.rail-heading{margin-bottom:10px}.rail-heading h2{margin:0;font:500 17px Arial,"Microsoft YaHei",sans-serif}.count-pill{padding:3px 8px;border:1px solid var(--line);border-radius:99px;color:var(--portal-muted);font-size:12px}.task-card{display:grid;width:100%;gap:5px;margin:6px 0;padding:10px;text-align:left;color:inherit;background:#fff;border:1px solid var(--line);border-radius:7px;cursor:pointer}.task-card.selected{border-color:var(--portal-primary);box-shadow:0 0 0 2px #286a5010}.task-card strong{font-size:12px}.task-card small{color:var(--muted);font-size:12px}.task-card-top>b{color:var(--portal-focus);font:600 12px/1.5 Arial,"Microsoft YaHei",sans-serif}.empty-state{padding:20px 8px;color:var(--muted);font-size:12px;line-height:1.6}.review-content{min-width:0}.briefing,.panel,.welcome-panel{background:#ffffffd9;border:1px solid var(--line);border-radius:9px;box-shadow:0 6px 20px #1e3d2b07}.briefing{padding:15px 18px;margin-bottom:12px}.briefing h2{margin:0;font:500 21px Arial,"Microsoft YaHei",sans-serif}.briefing-meta{display:flex;flex-wrap:wrap;gap:10px 22px;margin-top:13px;color:var(--muted);font-size:12px}.briefing-meta b{color:var(--portal-ink);font-weight:600}.snapshot-note{margin:12px 0 0;padding:8px 10px;background:var(--portal-paper);color:var(--portal-muted);border-radius:5px;font-size:12px}.panel{padding:13px;margin-bottom:12px}.panel-heading{margin-bottom:11px}.panel-heading h3{margin:0;font:500 15px Arial,"Microsoft YaHei",sans-serif}.panel-heading>small{color:var(--muted);font-size:12px}.dependency-panel{border:1px solid var(--portal-line)}.dependency-grid{display:grid;grid-template-columns:repeat(4,minmax(100px,1fr));gap:8px}.dependency-grid span{display:grid;gap:5px;padding:9px;background:var(--portal-paper);border-radius:5px;color:var(--muted);font-size:12px}.dependency-grid b{color:var(--portal-ink);font-size:12px}.dependency-panel>small{display:block;margin-top:8px;color:#87531e;font-size:12px}.review-layout{display:grid;grid-template-columns:minmax(360px,1.1fr) minmax(320px,.9fr);align-items:start;gap:12px}.workbook-panel{position:sticky;top:14px}.workbook-surface{height:min(72vh,760px);min-height:460px;background:#fff;border:1px solid var(--line);border-radius:5px;overflow:hidden}.workbook-surface.hidden{visibility:hidden;height:0;min-height:0}.workbook-loading{padding:35px;text-align:center;color:var(--muted)}.scoring-column{min-width:0}.indicator-card,.anomaly-item,.adjustment-item{padding:10px 0;border-top:1px solid var(--portal-line)}.indicator-card:first-of-type,.anomaly-item:first-of-type{border-top:0}.indicator-title>div{align-items:flex-start;flex-direction:column;gap:3px}.indicator-title small{color:var(--portal-muted);font:12px/1.6 Arial,"Microsoft YaHei",sans-serif}.indicator-title b{font-size:12px}.indicator-meta{display:flex;flex-wrap:wrap;gap:6px 12px;margin:8px 0;color:var(--muted);font-size:12px}.indicator-meta b{color:var(--portal-focus)}.button-row{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}.score-row{display:flex;align-items:center;gap:7px;margin-top:8px}.score-row :deep(.el-input-number){width:130px}.automatic-score{margin-top:7px;color:var(--portal-muted);font-size:12px}.anomaly-item>b,.anomaly-item p,.adjustment-item p{margin:5px 0;color:var(--portal-muted);font-size:12px;line-height:1.55}.anomaly-item>div:first-child b,.adjustment-item>div:first-child b{font-size:12px}.evidence-link{display:flex;width:100%;align-items:center;justify-content:space-between;padding:9px 0;text-align:left;background:transparent;border:0;border-top:1px solid var(--portal-line);color:inherit;cursor:pointer}.evidence-link b,.evidence-link small{display:block}.evidence-link b{font-size:12px}.evidence-link small,.adjustment-item small{margin-top:4px;color:var(--muted);font-size:12px}.score-total{display:grid;gap:3px;padding:9px;background:#f8ebf3;border-radius:6px}.score-total>b{color:var(--portal-focus);font:600 24px Arial,"Microsoft YaHei",sans-serif}.score-total small{color:var(--muted);font-size:12px}.adjustment-form{display:grid;grid-template-columns:1fr 1fr;gap:6px}.adjustment-form :deep(.el-input){grid-column:1/-1}.adjustment-item>div:first-child{justify-content:flex-start}.finalize-button{width:100%;margin-top:12px}.rank-list{margin-top:13px;padding-top:10px;border-top:1px solid var(--line)}.rank-list>div{display:grid;grid-template-columns:24px 1fr 60px;gap:7px;padding:5px 0;border-bottom:1px solid var(--portal-line);font-size:12px}.rank-list>div>b{color:var(--portal-focus)}.rank-list strong{text-align:right}.welcome-panel{display:grid;align-content:center;justify-items:center;min-height:60vh;padding:40px;text-align:center}.welcome-panel h2{margin:8px;font:500 24px Arial,"Microsoft YaHei",sans-serif}.welcome-panel p{color:var(--muted);font-size:12px}@media(max-width:1100px){.review-layout{grid-template-columns:1fr}.workbook-panel{position:static}.workbook-surface{height:55vh}}@media(max-width:760px){.workbench-grid{grid-template-columns:1fr}.task-rail{position:static;max-height:260px}.dependency-grid{grid-template-columns:1fr 1fr}.masthead{align-items:flex-start;flex-direction:column}.masthead h1{font-size:26px}}
</style>

<style scoped src="../styles/quarterly-review-layout.css"></style>
