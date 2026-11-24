<template>
  <main ref="taskWorkspace" class="ops-page portal-workbench">
    <section class="page-intro">
      <div>
        <h1>进度与责任调度</h1>
        <p class="intro-copy">{{ showcase ? '查看任务进度，按需改派责任人或延长截止时间。周期激活后生成任务，尚未开始填报的任务也会列出。' : '查看各公司任务进度，按需改派责任人或延长截止时间。周期激活后生成任务，未开始填报的公司也会列出。' }}</p>
      </div>
      <p class="intro-aside">时间均按上海时区显示</p>
    </section>

    <section v-if="loaded" class="summary-grid" aria-label="任务汇总">
      <article class="summary-item"><span>任务总数</span><strong>{{ filteredTasks.length }}</strong><small>报告类型与周期筛选结果</small></article>
      <article class="summary-item"><span>未开始</span><strong>{{ filteredTasks.filter(task => !task.hasEdits && task.status === 'draft').length }}</strong><small>尚未编辑报表</small></article>
      <article class="summary-item urgent"><span>逾期任务</span><strong>{{ filteredTasks.filter(task => task.overdue).length }}</strong><small>包含逾期提交的任务</small></article>
      <article class="summary-item"><span>已提交 / 定稿</span><strong>{{ filteredTasks.filter(task => ['submitted', 'reviewing', 'finalized'].includes(task.status)).length }}</strong><small>含审核中任务</small></article>
    </section>

    <section class="work-panel">
      <header class="panel-head">
        <div><h2>{{ showcase ? '填报任务' : '公司任务' }}</h2><p>展开任务可查看责任人和预检结果。已定稿或已取消的任务不能改派或延期。</p></div>
        <div class="filters" role="group" aria-label="任务筛选">
          <label class="filter-field"><span>报告类型</span><el-select v-model="filters.reportTypeId" clearable placeholder="全部报告类型" aria-label="报告类型筛选"><el-option v-for="type in reportTypes" :key="type.reportTypeId" :label="type.reportTypeName" :value="type.reportTypeId" /></el-select></label>
          <label class="filter-field"><span>周期</span><el-input v-model="filters.period" clearable aria-label="周期筛选" placeholder="如 2026-09" /></label>
          <el-button :loading="loading" :disabled="busy" @click="load">刷新</el-button>
        </div>
      </header>
      <el-alert v-if="errorText" :title="errorText" type="error" show-icon :closable="false" />
      <p v-if="busy" role="status" class="operation-status">{{ saving ? '正在保存，请勿关闭或切换页面…' : '正在确认取消任务…' }}</p>
      <app-data-table accessible responsive virtual-filters :table-label="showcase ? '填报任务进度' : '公司任务进度'" v-loading="loading" :data="filteredTasks" row-key="id" class="task-table" :empty-text="emptyText" :aria-busy="loading">
        <el-table-column type="expand"><template #default="scope">
          <div class="task-detail">
            <div class="detail-block"><span>责任人</span><p v-for="assignment in scope.row.assignments" :key="`${assignment.responsibility}-${assignment.userId}`"><b>{{ responsibilityLabel(assignment.responsibility) }}</b>{{ assignment.userName || `用户 ${assignment.userId}` }}</p><small v-if="!scope.row.assignments.length">此任务尚未指定责任人</small></div>
            <div class="detail-block"><span>协作与预检</span><p>协作房间：{{ roomStatusLabel(scope.row) }}</p><p>在线：{{ scope.row.onlineUsers }} 人 · 最近编辑：{{ scope.row.lastEditor || '暂无' }}</p><p v-if="scope.row.precheck">预检：{{ scope.row.precheck.blockingCount }} 项阻断 / {{ scope.row.precheck.warningCount }} 项预警<span v-if="scope.row.precheck.stale"> · 数据已变更，请重新预检</span></p><p v-else>预检：暂无结果，请在填报页面运行预检</p></div>
            <div v-if="scope.row.cancellationReason" class="detail-block cancelled-detail"><span>取消记录</span><p>{{ scope.row.cancellationReason }}</p><small>{{ formatDate(scope.row.cancelledAt) }}</small></div>
            <div v-if="scope.row.submittedAt" class="detail-block"><span>提交记录</span><p>{{ scope.row.submittedBy || '未知提交人' }} · 修订版 {{ scope.row.revisionNumber || '—' }}</p><small>{{ formatDate(scope.row.submittedAt) }} · {{ scope.row.reviewState }}</small></div>
            <div v-if="scope.row.extensionReason" class="detail-block"><span>延期记录</span><p>{{ scope.row.extensionReason }}</p><small>由 {{ scope.row.extensionChangedBy || '管理员' }} 于 {{ formatDate(scope.row.extensionChangedAt) }} 调整</small></div>
          </div>
        </template></el-table-column>
        <el-table-column :column-value="reportPeriodValue" label="报告 / 周期" min-width="170"><template #default="scope"><div class="report-cell"><b>{{ scope.row.reportTypeName }}</b><span>{{ scope.row.periodCode }} · {{ scope.row.cadence === 'quarterly' ? '季度' : '月度' }}</span></div></template></el-table-column>
        <el-table-column v-if="!showcase" prop="organizationName" label="参与公司" min-width="165"><template #default="scope"><div class="org-cell"><b>{{ scope.row.organizationName }}</b><span>{{ scope.row.organizationCode }}</span></div></template></el-table-column>
        <el-table-column :column-value="statusLabel" label="进度状态" min-width="150"><template #default="scope"><el-tag size="small" effect="plain" :type="statusType(scope.row)">{{ statusLabel(scope.row) }}</el-tag></template></el-table-column>
        <el-table-column prop="lastEditedAt" label="最近编辑" min-width="145"><template #default="scope"><span>{{ scope.row.lastEditor || '—' }}</span><small class="table-sub">{{ scope.row.lastEditedAt ? formatDate(scope.row.lastEditedAt) : (scope.row.hasEdits ? '时间未知' : '暂无修改') }}</small></template></el-table-column>
        <el-table-column prop="deadlineAt" label="截止时间" min-width="155"><template #default="scope"><div :class="['deadline-cell', { overdue: scope.row.overdue }]"><b>{{ formatDate(scope.row.deadlineAt) }}</b><small v-if="scope.row.overdue">{{ ['submitted', 'reviewing', 'finalized'].includes(scope.row.status) ? '逾期提交' : '逾期未提交' }}</small><small v-else-if="scope.row.extensionReason">已延期</small></div></template></el-table-column>
        <el-table-column label="操作" width="180"><template #default="scope"><div class="row-actions"><el-button link type="primary" :disabled="busy || loading || Boolean(errorText) || !canReassign(scope.row)" @click="openReassign(scope.row)">改派</el-button><el-button link type="primary" :disabled="busy || loading || Boolean(errorText) || !canExtend(scope.row)" @click="openExtension(scope.row)">延期</el-button><el-dropdown v-if="!['finalized','cancelled','submitted','reviewing'].includes(scope.row.status)" @command="command => command === 'cancel' && cancelTask(scope.row)"><el-button link type="danger" :disabled="busy || loading || Boolean(errorText)">更多 <el-icon><ArrowDown /></el-icon></el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="cancel">取消任务</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div></template></el-table-column>

        <template #compact="{ rows, expanded }">
          <div v-if="!expanded && compactMode" class="task-compact" :aria-busy="loading">
            <p v-if="!rows.length" class="task-empty" role="status">{{ emptyText }}</p>
            <ol v-else class="task-records" aria-label="填报任务摘要">
              <li v-for="task in rows" :key="task.id" class="task-record">
                <div class="task-record-heading"><h3>{{ task.reportTypeName }}</h3><el-tag effect="plain" :type="statusType(task)">{{ statusLabel(task) }}</el-tag></div>
                <p class="task-record-period">{{ task.periodCode }} · {{ task.cadence === 'quarterly' ? '季度' : '月度' }}</p>
                <dl class="task-facts">
                  <div v-if="!showcase"><dt>参与公司</dt><dd>{{ task.organizationName }}<small>{{ task.organizationCode }}</small></dd></div>
                  <div><dt>截止时间</dt><dd :class="{ overdue: task.overdue }">{{ formatDate(task.deadlineAt) }}<small v-if="task.overdue">{{ ['submitted', 'reviewing', 'finalized'].includes(task.status) ? '逾期提交' : '逾期未提交' }}</small><small v-else-if="task.extensionReason">已延期</small></dd></div>
                </dl>
                <div class="row-actions"><el-button link type="primary" :disabled="busy || loading || Boolean(errorText) || !canReassign(task)" @click="openReassign(task)">改派</el-button><el-button link type="primary" :disabled="busy || loading || Boolean(errorText) || !canExtend(task)" @click="openExtension(task)">延期</el-button><el-dropdown v-if="!['finalized','cancelled','submitted','reviewing'].includes(task.status)" @command="command => command === 'cancel' && cancelTask(task)"><el-button link type="danger" :disabled="busy || loading || Boolean(errorText)">更多 <el-icon><ArrowDown /></el-icon></el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="cancel">取消任务</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div>
                <details class="task-record-detail" :open="expandedTaskDetails.has(task.id)" @toggle="toggleTaskDetails(task.id, $event)">
                  <summary>责任与进度详情</summary>
                  <template v-if="expandedTaskDetails.has(task.id)">
                  <p class="record-last-edit">最近编辑：{{ task.lastEditor || '—' }} · {{ task.lastEditedAt ? formatDate(task.lastEditedAt) : (task.hasEdits ? '时间未知' : '暂无修改') }}</p>
                  <div class="task-detail">
                    <div class="detail-block"><span>责任人</span><p v-for="assignment in task.assignments" :key="`${assignment.responsibility}-${assignment.userId}`"><b>{{ responsibilityLabel(assignment.responsibility) }}</b>{{ assignment.userName || `用户 ${assignment.userId}` }}</p><small v-if="!task.assignments.length">此任务尚未指定责任人</small></div>
                    <div class="detail-block"><span>协作与预检</span><p>协作房间：{{ roomStatusLabel(task) }}</p><p>在线：{{ task.onlineUsers }} 人 · 最近编辑：{{ task.lastEditor || '暂无' }}</p><p v-if="task.precheck">预检：{{ task.precheck.blockingCount }} 项阻断 / {{ task.precheck.warningCount }} 项预警<span v-if="task.precheck.stale"> · 数据已变更，请重新预检</span></p><p v-else>预检：暂无结果，请在填报页面运行预检</p></div>
                    <div v-if="task.cancellationReason" class="detail-block cancelled-detail"><span>取消记录</span><p>{{ task.cancellationReason }}</p><small>{{ formatDate(task.cancelledAt) }}</small></div>
                    <div v-if="task.submittedAt" class="detail-block"><span>提交记录</span><p>{{ task.submittedBy || '未知提交人' }} · 修订版 {{ task.revisionNumber || '—' }}</p><small>{{ formatDate(task.submittedAt) }} · {{ task.reviewState }}</small></div>
                    <div v-if="task.extensionReason" class="detail-block"><span>延期记录</span><p>{{ task.extensionReason }}</p><small>由 {{ task.extensionChangedBy || '管理员' }} 于 {{ formatDate(task.extensionChangedAt) }} 调整</small></div>
                  </div>
                  </template>
                </details>
              </li>
            </ol>
          </div>
        </template>
      </app-data-table>
    </section>

    <section class="work-panel reminder-panel">
      <header class="panel-head"><div><h2>报告类型提醒计划</h2><p>按报告类型统一设置填报提醒。平台内通知发送给尚未提交、未取消任务的当前填报人和提交人。</p></div></header>
      <div class="schedule-grid">
        <article v-for="schedule in reminderSchedules" :key="schedule.reportTypeId" class="schedule-card">
          <div class="schedule-title"><div><b>{{ schedule.reportTypeName }}</b><span>{{ schedule.cadence === 'quarterly' ? '季度' : '月度' }}报告</span></div><el-button text type="primary" :disabled="busy || loading || Boolean(errorText)" @click="editSchedule(schedule)">调整提醒</el-button></div>
          <p>{{ schedule.schedule.daysBefore.length ? `截止前 ${schedule.schedule.daysBefore.join('、')} 天提醒` : '不发送截止前提醒' }}</p>
          <div class="schedule-flags"><el-tag size="small" :type="schedule.schedule.deadlineMorning ? 'success' : 'info'">{{ schedule.schedule.deadlineMorning ? '截止日 9 点提醒' : '截止日不提醒' }}</el-tag><el-tag size="small" :type="schedule.schedule.dailyAfterExpiry ? 'warning' : 'info'">{{ schedule.schedule.dailyAfterExpiry ? '逾期每日 9 点提醒' : '逾期不重复提醒' }}</el-tag></div>
        </article>
        <div v-if="!reminderSchedules.length" class="empty-schedule" role="status">{{ loading ? '正在读取提醒计划…' : errorText ? '提醒计划暂不可用，请刷新重试。' : '暂无已启用的报告类型。启用报告类型后，可设置提醒时间。' }}</div>
      </div>
    </section>

    <el-dialog v-model="operationOpen" :title="operationTitle" class="task-operation-dialog" width="min(520px, calc(100vw - 24px))" :before-close="closeOperation" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" destroy-on-close>
      <p class="operation-context operation-subject">{{ selectedTask?.reportTypeName }} · {{ selectedTask?.periodCode }}<template v-if="!showcase"><br />{{ selectedTask?.organizationName }}</template></p>
      <el-alert v-if="operationError" :title="operationError" type="error" show-icon :closable="false" />
      <div v-if="assigneeError && operation === 'reassign'" class="assignee-error" role="alert">{{ assigneeError }}<el-button :disabled="saving" @click="loadAssignees">重试人员列表</el-button></div>
      <p v-if="operation === 'extend'" class="operation-context">当前截止时间：{{ formatDate(selectedTask?.deadlineAt) }}（上海时区）。新的截止时间必须晚于此时间。</p>
      <el-form label-position="top" :disabled="saving">
        <template v-if="operation === 'reassign'">
          <p class="operation-context">选择尚未完成的职责。{{ currentResponsibilityAssignments.length ? '每次替换一位责任人，其他责任人不受影响。' : '此职责尚无责任人，保存后将新增指派。' }}</p>
          <el-form-item label="需要改派的职责" :error="fieldErrors.responsibility"><el-select v-model="operationForm.responsibility" style="width:100%" @change="changeResponsibility"><el-option v-for="role in availableResponsibilities" :key="role.value" :label="role.label" :value="role.value" /></el-select></el-form-item>
          <el-form-item label="要替换的责任人" :error="fieldErrors.previousUserId"><el-select v-model="operationForm.previousUserId" clearable style="width:100%" :placeholder="currentResponsibilityAssignments.length ? '选择要替换的责任人' : '当前尚无责任人'"><el-option v-for="assignment in currentResponsibilityAssignments" :key="assignment.userId" :label="assignment.userName || `用户 ${assignment.userId}`" :value="assignment.userId" /></el-select></el-form-item>
          <el-form-item label="新责任人" :error="fieldErrors.userId"><el-select v-model="operationForm.userId" filterable :loading="assigneeLoading" :disabled="saving || assigneeLoading || Boolean(assigneeError)" no-data-text="没有符合此任务职责的可用账号" style="width:100%" placeholder="选择接替此职责的人员"><el-option v-for="user in users" :key="user.id" :label="`${user.name} · ${user.username}`" :value="user.id" /></el-select></el-form-item>
          <p class="operation-context">仅列出可承担此任务职责的有效账号。</p>
          <p v-if="!assigneeLoading && !assigneeError && !users.length" class="operation-context" role="status">没有可选人员，请核对账号状态和职责配置。</p>
        </template>
        <template v-else-if="operation === 'extend'">
          <el-form-item label="新的截止时间（上海时区）" :error="fieldErrors.deadlineAt"><el-date-picker v-model="operationForm.deadlineAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" format="YYYY-MM-DD HH:mm" placeholder="选择日期和时间" style="width:100%" /></el-form-item>
        </template>
        <el-form-item :label="operation === 'reassign' ? '改派原因' : '延期原因'" required :error="fieldErrors.reason"><el-input v-model="operationForm.reason" type="textarea" :rows="3" maxlength="2000" show-word-limit :placeholder="operation === 'reassign' ? '例如：原责任人岗位调整，由新责任人接手' : '例如：数据仍在核对，需延后提交'" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="busy" @click="closeOperation">取消</el-button><el-button type="primary" :loading="saving" :disabled="busy || (operation === 'reassign' && (assigneeLoading || Boolean(assigneeError)))" @click="saveOperation">{{ operation === 'reassign' ? '确认改派' : '确认延期' }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="scheduleOpen" class="task-operation-dialog" title="调整提醒计划" width="min(480px, calc(100vw - 24px))" :before-close="closeSchedule" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy">
      <p class="operation-context operation-subject">{{ selectedSchedule?.reportTypeName }}</p>
      <p class="operation-context">此计划适用于该报告类型下所有尚未提交、未取消的任务。时间均按上海时区计算。</p>
      <el-alert v-if="scheduleError" :title="scheduleError" type="error" show-icon :closable="false" />
      <el-form label-position="top" :disabled="saving">
        <el-form-item label="提前提醒天数（可多选）"><el-select v-model="scheduleForm.daysBefore" multiple placeholder="不选择则不提前提醒" style="width:100%"><el-option v-for="day in [1,2,3,5,7,14,30]" :key="day" :label="`${day} 天前`" :value="day" /></el-select></el-form-item>
        <p class="operation-context">按截止时间向前推算相应天数。清空天数仅关闭提前提醒，下方两项仍可单独开启。</p>
        <el-form-item><el-checkbox v-model="scheduleForm.deadlineMorning">截止日早上 9 点提醒</el-checkbox></el-form-item>
        <el-form-item><el-checkbox v-model="scheduleForm.dailyAfterExpiry">截止日次日起，每天早上 9 点提醒，直至提交或取消</el-checkbox></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="busy" @click="closeSchedule">取消</el-button><el-button type="primary" :loading="saving" :disabled="busy" @click="saveSchedule">保存提醒计划</el-button></template>
    </el-dialog>
  </main>
</template>

<script>
import { ArrowDown } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { taskOperationsApi } from '../api'
import { markRaw } from 'vue'
import { normalizeProgress, shanghaiDeadline } from '@/utils/taskProgressState'
import { SHOWCASE } from '@/config/showcase'

const taskDateFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' })

export default {
  name: 'TaskProgressWorkbench',
  components: { ArrowDown },
  data() {
    return { showcase: SHOWCASE, loading: false, saving: false, cancelling: false, loaded: false, disposed: false, loadSequence: 0, loadController: null,
      compactMode: true, layoutObserver: null,
      assigneeSequence: 0, assigneeController: null, assigneeLoading: false, assigneeError: '', operationError: '', scheduleError: '', fieldErrors: {},
      operationBaseline: '', scheduleBaseline: '', cancelReasons: {}, expandedTaskDetails: new Set(), errorText: '', tasks: [], reminderSchedules: [], users: [], filters: { reportTypeId: null, period: '' },
      operationOpen: false, operation: '', selectedTask: null, operationForm: { responsibility: 'filler', previousUserId: null, userId: null, deadlineAt: '', reason: '' },
      scheduleOpen: false, selectedSchedule: null, scheduleForm: { daysBefore: [], deadlineMorning: true, dailyAfterExpiry: true },
      responsibilityOptions: [{ value: 'filler', label: '填报人' }, { value: 'submitter', label: '提交人' },
        { value: 'department_reviewer', label: '部门审核人' }, { value: 'finalizer', label: '定稿人' }] }
  },
  computed: {
    busy() { return this.saving || this.cancelling },
    operationDirty() { return this.operationOpen && JSON.stringify(this.operationForm) !== this.operationBaseline },
    scheduleDirty() { return this.scheduleOpen && JSON.stringify(this.scheduleForm) !== this.scheduleBaseline },
    hasDraft() { return this.operationDirty || this.scheduleDirty },
    emptyText() { return this.loading ? '正在读取任务…' : this.errorText ? '任务暂不可用，请刷新重试' : this.tasks.length ? '没有符合筛选条件的任务，请调整或清除筛选。' : (this.showcase ? '暂无任务。周期激活后，填报任务会显示在这里。' : '暂无任务。周期激活后，各参与公司的任务会显示在这里。') },
    reportTypes() { return this.reminderSchedules },
    availableResponsibilities() { if (!this.canReassign(this.selectedTask)) return []; return ['submitted', 'reviewing'].includes(this.selectedTask?.status)
      ? this.responsibilityOptions.filter(item => !['filler', 'submitter'].includes(item.value)) : this.responsibilityOptions },
    currentResponsibilityAssignments() { return (this.selectedTask?.assignments || []).filter(item => item.responsibility === this.operationForm.responsibility) },
    filteredTasks() { const query = this.filters.period.trim().toLowerCase(); return this.tasks.filter(task => (!this.showcase || task.status !== 'cancelled')
      && (!this.filters.reportTypeId || Number(task.reportTypeId) === Number(this.filters.reportTypeId))
      && (!query || task.periodCode.toLowerCase().includes(query))) },
    operationTitle() { return this.operation === 'reassign' ? '改派责任人' : '延长任务截止时间' }
  },
  mounted() { this.observeWorkspace(); this.load(); window.addEventListener('beforeunload', this.warnBeforeUnload) },
  beforeRouteLeave() { return this.confirmLeave() },
  beforeUnmount() { this.disposed = true; this.loadSequence++; this.assigneeSequence++; this.loadController?.abort(); this.assigneeController?.abort(); this.layoutObserver?.disconnect(); window.removeEventListener('beforeunload', this.warnBeforeUnload) },
  methods: {
    observeWorkspace() {
      if (typeof ResizeObserver === 'undefined' || !this.$refs.taskWorkspace) return
      this.layoutObserver = markRaw(new ResizeObserver(entries => {
        if (!this.disposed) this.compactMode = entries[0].contentRect.width <= 1120
      }))
      this.layoutObserver.observe(this.$refs.taskWorkspace)
    },
    reportPeriodValue(row) { return `${row.reportTypeName} · ${row.periodCode}` },
    toggleTaskDetails(id, event) { if (event.target.open) this.expandedTaskDetails.add(id); else this.expandedTaskDetails.delete(id) },
    warnBeforeUnload(event) { if (this.busy || this.hasDraft) { event.preventDefault(); event.returnValue = '' } },
    async confirmLeave() {
      if (this.busy) { ElMessage.warning('正在处理任务，请完成后再离开。'); return false }
      if (!this.hasDraft) return true
      try { await ElMessageBox.confirm('尚未保存的修改将丢失。', '放弃未保存的修改？', { confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning' }); return !this.busy }
      catch { return false }
    },
    async closeOperation(done) {
      if (this.busy) return
      if (this.operationDirty && !await this.confirmLeave()) return
      if (this.busy || this.disposed) return
      this.operationOpen = false; this.assigneeSequence++; this.assigneeController?.abort()
      if (typeof done === 'function') done()
    },
    async closeSchedule(done) {
      if (this.busy) return
      if (this.scheduleDirty && !await this.confirmLeave()) return
      if (this.busy || this.disposed) return
      this.scheduleOpen = false; if (typeof done === 'function') done()
    },
    canReassign(task) { return Boolean(task && ['draft', 'submitted', 'reviewing'].includes(task.status)) },
    canExtend(task) { return this.canReassign(task) },
    async load() {
      if (this.disposed) return false
      const sequence = ++this.loadSequence
      this.loadController?.abort()
      const controller = markRaw(new AbortController()); this.loadController = controller
      this.loading = true; this.errorText = ''
      try {
        const progress = normalizeProgress(await taskOperationsApi.getProgress({ signal: controller.signal }))
        if (this.disposed || sequence !== this.loadSequence) return false
        const taskIds = new Set(progress.tasks.map(task => task.id))
        this.expandedTaskDetails = new Set([...this.expandedTaskDetails].filter(id => taskIds.has(id)))
        this.tasks = progress.tasks; this.reminderSchedules = progress.reminderSchedules; this.loaded = true
        return true
      } catch (error) { if (!this.disposed && sequence === this.loadSequence) this.errorText = error?.message || '读取任务进度失败，请刷新重试。'; return false }
      finally { if (sequence === this.loadSequence && !this.disposed) this.loading = false; if (this.loadController === controller) this.loadController = null }
    },
    async refreshAfterSave() {
      const refreshed = await this.load()
      if (!this.disposed && !refreshed && this.errorText) this.errorText = `操作已保存，但最新结果读取失败：${this.errorText} 请刷新确认，无需重复提交。`
    },
    statusLabel(task) { return this.statusPresentation(task).label },
    statusType(task) { return this.statusPresentation(task).type },
    statusPresentation(task) {
      if (task.status === 'cancelled') return { label: '已取消', type: 'info' }
      if (task.status === 'draft') return task.hasEdits ? { label: '填报中', type: 'warning' } : { label: '未开始', type: 'info' }
      return ({ submitted: { label: '待审核', type: 'primary' }, reviewing: { label: '审核中', type: 'warning' },
        finalized: { label: '已定稿', type: 'success' } })[task.status] || { label: '状态待确认', type: 'info' }
    },
    responsibilityLabel(value) { return ({ filler: '填报人', submitter: '提交人', department_reviewer: '部门审核人', scorer: '评分人', approver: '审批人', finalizer: '定稿人' })[value] || '未识别的职责' },
    roomStatusLabel(task) { return !task.roomCreated ? '尚未创建' : ({ open: '开放中', frozen: '已冻结', closed: '已关闭' })[task.roomStatus] || '状态待确认' },
    formatDate(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : taskDateFormatter.format(date) },
    openReassign(task) {
      if (this.busy || this.operationOpen || this.scheduleOpen || this.disposed || !this.canReassign(task)) return
      this.selectedTask = task; this.operation = 'reassign'; this.fieldErrors = {}; this.operationError = ''
      const responsibility = this.availableResponsibilities[0]?.value
      this.operationForm = { responsibility, previousUserId: (task.assignments || []).find(item => item.responsibility === responsibility)?.userId || null, userId: null, reason: '' }
      this.operationBaseline = JSON.stringify(this.operationForm); this.operationOpen = true; this.loadAssignees()
    },
    changeResponsibility(value) {
      if (this.busy) return
      this.operationForm.responsibility = value; this.operationForm.previousUserId = this.currentResponsibilityAssignments[0]?.userId || null
      this.operationForm.userId = null; this.fieldErrors = {}; this.loadAssignees()
    },
    async loadAssignees() {
      if (!this.operationOpen || this.operation !== 'reassign' || this.disposed) return
      const task = this.selectedTask, responsibility = this.operationForm.responsibility, sequence = ++this.assigneeSequence
      this.assigneeController?.abort(); const controller = markRaw(new AbortController()); this.assigneeController = controller
      this.users = []; this.operationForm.userId = null; this.assigneeLoading = true; this.assigneeError = ''
      const current = () => !this.disposed && sequence === this.assigneeSequence && this.operationOpen && this.selectedTask === task && this.operationForm.responsibility === responsibility
      try {
        const result = await taskOperationsApi.getAssignees(task.id, responsibility, { signal: controller.signal })
        if (!current()) return
        if (!Array.isArray(result?.users)) throw new Error('可选人员响应不完整，请重试。')
        this.users = result.users
      } catch (error) { if (current()) this.assigneeError = error?.message || '可选人员读取失败，请重试。' }
      finally { if (current()) this.assigneeLoading = false; if (this.assigneeController === controller) this.assigneeController = null }
    },
    openExtension(task) {
      if (this.busy || this.operationOpen || this.scheduleOpen || this.disposed || !this.canExtend(task)) return
      this.selectedTask = task; this.operation = 'extend'; this.operationError = ''; this.fieldErrors = {}
      this.operationForm = { deadlineAt: '', reason: '' }; this.operationBaseline = JSON.stringify(this.operationForm); this.operationOpen = true
    },
    async saveOperation() {
      if (this.busy || this.disposed || !this.operationOpen) return
      const task = this.selectedTask, form = { ...this.operationForm }, operation = this.operation
      this.fieldErrors = {}; this.operationError = ''
      if (!this.canReassign(task)) { this.operationError = '任务已结束或状态已变化，请刷新后重新选择。'; return }
      form.reason = String(form.reason || '').trim()
      if (!form.reason || form.reason.length > 2000) this.fieldErrors.reason = '请填写 1 至 2000 字的业务原因。'
      if (operation === 'reassign') {
        if (!this.availableResponsibilities.some(role => role.value === form.responsibility)) this.fieldErrors.responsibility = '当前职责不可改派。'
        if (this.assigneeLoading || this.assigneeError || !this.users.some(user => Number(user.id) === Number(form.userId))) this.fieldErrors.userId = '请选择列表中可用的新责任人。'
        const assignments = this.currentResponsibilityAssignments
        if (assignments.length && !assignments.some(item => Number(item.userId) === Number(form.previousUserId))) this.fieldErrors.previousUserId = '请选择要替换的当前责任人。'
        if (Number(form.userId) === Number(form.previousUserId)) this.fieldErrors.userId = '新责任人不能与当前责任人相同。'
      } else if (operation === 'extend') {
        const next = shanghaiDeadline(form.deadlineAt), previous = shanghaiDeadline(task.deadlineAt)
        if (!Number.isFinite(previous)) this.fieldErrors.deadlineAt = '当前截止时间无效，请刷新任务后重试。'
        else if (!Number.isFinite(next) || next <= previous) this.fieldErrors.deadlineAt = '新的截止时间必须晚于当前截止时间。'
        else form.deadlineAt = new Date(next).toISOString()
      } else return
      if (Object.keys(this.fieldErrors).length) return
      this.saving = true
      try {
        if (operation === 'reassign') await taskOperationsApi.reassign(task.id, form.responsibility, form.userId, form.reason, form.previousUserId)
        else await taskOperationsApi.extendDeadline(task.id, form.deadlineAt, form.reason)
        if (this.disposed) return
        if (this.selectedTask === task && this.operation === operation) { this.operationOpen = false; this.operationBaseline = '' }
        ElMessage.success(operation === 'reassign' ? '责任人已改派' : '任务截止时间已延长'); await this.refreshAfterSave()
      } catch (error) { if (!this.disposed && this.selectedTask === task) this.operationError = `${error?.message || '保存失败'}。输入已保留，请核对后重试。` }
      finally { this.saving = false }
    },
    async cancelTask(task) {
      if (this.busy || this.disposed || this.operationOpen || this.scheduleOpen || task.status !== 'draft') return
      this.cancelling = true
      try {
        const reason = await ElMessageBox.prompt(`取消“${task.reportTypeName} · ${task.periodCode}${showcase ? '' : ' · ' + task.organizationName}”的填报任务？取消后将标记为已取消，并停止后续填报提醒。请填写取消原因。`, '取消任务', { inputType: 'textarea', inputValue: this.cancelReasons[task.id] || '', inputValidator: value => Boolean(value?.trim()) && value.trim().length <= 2000 || '请填写 1 至 2000 字的取消原因', confirmButtonText: '取消任务', cancelButtonText: '保留任务', type: 'warning' })
        if (this.disposed) return
        this.cancelReasons[task.id] = reason.value.trim()
        this.saving = true
        await taskOperationsApi.cancel(task.id, reason.value.trim())
        if (this.disposed) return
        delete this.cancelReasons[task.id]
        ElMessage.success('任务已取消，后续填报提醒已停止'); await this.refreshAfterSave()
      } catch (error) { if (!this.disposed && error !== 'cancel' && error !== 'close') this.errorText = `取消未完成：${error?.message || '请稍后重试'}` }
      finally { this.cancelling = false; this.saving = false }
    },
    editSchedule(item) {
      if (this.busy || this.disposed || this.operationOpen || this.scheduleOpen) return
      this.selectedSchedule = item; this.scheduleError = ''
      this.scheduleForm = { daysBefore: [...item.schedule.daysBefore], deadlineMorning: item.schedule.deadlineMorning, dailyAfterExpiry: item.schedule.dailyAfterExpiry }
      this.scheduleBaseline = JSON.stringify(this.scheduleForm); this.scheduleOpen = true
    },
    async saveSchedule() {
      if (this.busy || this.disposed || !this.scheduleOpen) return
      const selected = this.selectedSchedule, form = { ...this.scheduleForm, daysBefore: [...this.scheduleForm.daysBefore] }
      if (form.daysBefore.some(day => !Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > 30)) { this.scheduleError = '提前提醒天数须为 1 至 30 的整数。'; return }
      this.saving = true; this.scheduleError = ''
      try {
        await taskOperationsApi.updateReminderSchedule(selected.reportTypeId, form)
        if (this.disposed) return
        selected.schedule = form
        if (this.selectedSchedule === selected) { this.scheduleOpen = false; this.scheduleBaseline = '' }
        ElMessage.success('提醒计划已保存'); await this.refreshAfterSave()
      } catch (error) { if (!this.disposed && this.selectedSchedule === selected) this.scheduleError = `${error?.message || '保存失败'}。输入已保留，请重试。` }
      finally { this.saving = false }
    }
  }
}
</script>

<style src="../styles/task-progress-layout.css"></style>
