<template>
  <main class="filling-page portal-workbench">
    <SignaturePad v-model="signatureDialog" :location="signatureLocation" :existing-image="signatureExistingImage" :busy="signatureSaving" :save="saveSignatureImage" />
    <DemoNextStep v-if="task && task.status === 'submitted'" text="本期已提交，切换到审核视角查看结果。" label="切换为审核人" role="reviewer" to="/portal/monthly-review" />
    <DemoNextStep v-if="task && task.status === 'draft' && isAssignedFiller && !isAssignedSubmitter" text="你负责的单元格已可编辑；填写完成后，由本期提交人核对并提交。" label="切换为提交人" role="filler" :to="`/portal/monthly-filling?taskId=${taskId}`" />
    <section v-if="!taskId" class="queue-view">
      <header class="queue-header">
        <div><span class="eyebrow">REPORTING WORKBENCH</span><h1>经营报告填报</h1><p>打开已分配的月报或季报任务，与同事在受控工作簿中完成填报。</p></div>
        <div class="queue-total"><strong>{{ tasks.length.toString().padStart(2, '0') }}</strong><span>可访问任务</span></div>
      </header>
      <div class="queue-toolbar"><span>分配给我的任务</span><el-button text @click="loadTasks"><el-icon><Refresh /></el-icon>刷新列表</el-button></div>
      <div v-if="loading" class="queue-loading">正在读取已分配任务…</div>
      <div v-else-if="tasks.length" class="task-grid">
        <article v-for="item in tasks" :key="item.id" class="task-card">
          <div class="task-card-top"><span class="task-period">{{ item.periodCode }}</span><el-tag :type="taskStatusType(item.status)" effect="plain" size="small">{{ taskStatusLabel(item.status) }}</el-tag></div>
          <h2>{{ showcase ? item.reportTypeName : item.organizationName }}</h2><p class="task-type">{{ showcase ? (item.cadence === 'quarterly' ? '季度填报' : '月度填报') : `${item.reportTypeName} · ${item.organizationCode}` }}</p>
          <div class="task-card-meta"><span>截止 {{ formatDate(item.deadlineAt) }}</span><span>{{ item.hasEdits ? '已有协作修改' : '尚未开始' }}</span></div>
          <div class="task-card-footer"><span v-if="item.lastEditor">最近由 {{ item.lastEditor }} 编辑</span><span v-else>等待开始填报</span><div><el-button v-if="['monthly', 'quarterly'].includes(item.cadence) && item.status === 'finalized'" type="warning" plain @click="prepareAdjustment(item)">调整已定稿数据</el-button><el-button type="primary" @click="openTask(item.id)">打开工作台 <el-icon><ArrowRight /></el-icon></el-button></div></div>
        </article>
      </div>
      <el-empty v-else description="当前没有分配给您的填报任务" />
      <p v-if="errorText" class="error-banner">{{ errorText }}</p>
      <el-dialog v-model="adjustmentDialogOpen" title="发起报告调整" width="min(560px, 92vw)" :close-on-click-modal="false">
        <p class="adjustment-dialog-hint">选择需要调整的已申报字段并说明原因。原定稿在调整获批并重新定稿前继续作为当前有效版本。</p>
        <el-checkbox-group v-model="adjustmentFieldCodes" class="adjustment-fields">
          <el-checkbox v-for="field in adjustmentFields" :key="field.fieldCode" :label="field.fieldCode">{{ field.displayName }} <small>{{ field.fieldCode }}</small></el-checkbox>
        </el-checkbox-group>
        <el-input v-model="adjustmentReason" type="textarea" :rows="3" maxlength="1000" show-word-limit placeholder="填写调整原因" />
        <template #footer><el-button @click="adjustmentDialogOpen = false">取消</el-button><el-button type="primary" :loading="adjustmentBusy" :disabled="!adjustmentFieldCodes.length || !adjustmentReason.trim()" @click="startAdjustment">创建更正草稿</el-button></template>
      </el-dialog>
    </section>

    <section v-else class="workbench-view">
      <header class="workbench-header">
        <div class="workbench-titleline"><el-button circle plain aria-label="返回任务列表" @click="backToQueue"><el-icon><ArrowLeft /></el-icon></el-button><div><span class="eyebrow">{{ showcase ? task?.periodCode : `${task?.organizationCode} / ${task?.periodCode}` }}</span><h1>{{ (showcase ? task?.reportTypeName : task?.organizationName) || '月度填报' }}<span class="title-divider">/</span>{{ task?.periodCode }}<el-tag :type="taskStatusType(task?.status)" effect="plain">{{ taskStatusLabel(task?.status) }}</el-tag></h1></div></div>
        <div class="collaboration-header-actions"><el-popover trigger="hover" placement="bottom-end" :width="260"><template #reference><button class="collaborator-avatars" aria-label="查看在线协作者"><span v-for="(person,index) in collaborators.slice(0,2)" :key="person.id || index" class="avatar" :style="{background: person.color || avatarColor(index)}">{{ (person.name || '?').slice(0,1) }}</span><span v-if="collaborators.length > 2" class="avatar overflow-avatar">+{{ collaborators.length - 2 }}</span><span v-if="!collaborators.length">暂无在线协作者</span></button></template><strong>当前在线 · {{ collaborators.length }} 人</strong><p v-for="(person,index) in collaborators" :key="person.id || index">{{ person.name || '协作者' }}{{ Number(person.id) === currentUserId ? '（我）' : '' }} · 正在协作</p><p v-if="!collaborators.length">当前没有在线编辑者</p></el-popover><el-button @click="shareTask">分享链接</el-button></div><div class="header-context"><span><small>报告类型</small>{{ task?.reportTypeName }}</span><span><small>模板版本</small>v{{ task?.templateVersion }}</span><span><small>计划版本</small>v{{ task?.packageVersion }}</span><span><small>截止时间</small>{{ formatDate(task?.deadlineAt) }}</span></div>
      </header>
      <div v-if="loading" class="loading-panel">正在打开协作房间…</div>
      <p v-if="errorText" class="error-banner" role="alert">{{ errorText }}</p>
      <el-button v-if="!loading && !ready && errorText" @click="loadTask">重新打开协作房间</el-button>
      <section v-if="rejectedChanges.length" class="error-banner" aria-label="未同步编辑记录">
        <strong>{{ recoveryRequired ? '编辑未保存，已暂停填报' : '未同步编辑记录（可复制后重新填写）' }}</strong>
        <p>以下编辑未确认保存。重新连接会读取服务器版本；记录会保留在本页供您复制，关闭或刷新页面前请先备份。</p>
        <details><summary>查看并复制未同步内容</summary><textarea :value="JSON.stringify(rejectedChanges, null, 2)" readonly aria-label="未同步内容" style="width:100%;min-height:120px" /></details>
        <el-button v-if="recoveryRequired" :loading="loading" :disabled="loading || pendingChangeSets > 0" @click="recoverRejectedChanges">重新连接并恢复服务器版本</el-button>
      </section>
      <div v-if="loading || ready" v-show="ready" class="workbench-layout">
        <section class="sheet-panel">
          <div class="sheet-toolbar">
            <div class="sheet-tools"><el-select v-model="selectedInput" class="locate-select" placeholder="定位填报项" size="small"><el-option v-for="mapping in inputMappings" :key="mapping.key" :label="mapping.displayName || mapping.fieldCode" :value="mapping.key"/></el-select><el-button text :disabled="!selectedInput" @click="locateInput">定位</el-button></div>
          <div class="sheet-toolbar-actions"><el-button v-if="isAssignedSubmitter && task?.status === 'draft'" type="primary" :loading="submissionBusy" :disabled="!canSubmit" @click="submitTask">提交本期数据</el-button></div>
          </div>
          <div class="submission-guidance" role="status">
            <strong>本期提交人：{{ submitterNames }}</strong>
            <span v-if="task?.status === 'draft'">{{ isAssignedSubmitter ? (submissionBlockers.join('；') || '预检已通过，可以提交本期数据。') : '填报人员完成录入后，由上述提交人核对并提交。' }}</span>
          </div>
          <div class="spread-frame"><div ref="spreadHost" class="spread-host" aria-label="协同填报工作簿"></div><div v-if="submissionBusy" class="submission-overlay" role="status">正在冻结协作房间并保存提交…</div></div>
          <footer class="sheet-foot"><span v-if="task?.status === 'draft' && room?.status === 'open'"><i class="legend-input"/>蓝色单元格为当前可填报区域</span><span v-else>当前修订只读</span><span><i class="legend-readonly"/>系统计算与模板内容</span><span class="foot-right">{{ room?.currentVersion || 0 }} 次协作变更 · {{ connectionState }}</span></footer>

        </section>
        <aside class="context-rail"><section v-if="isAssignedSubmitter" class="rail-card"><div class="rail-heading"><h2>编辑历史</h2><el-button text :loading="historyLoading" @click="loadHistory">刷新</el-button></div><p v-if="historyError" role="alert">{{ historyError }}</p><div class="edit-history-list"><article v-for="event in editHistory" :key="`${event.roomKey}:${event.version}`"><b>修订 {{ event.revisionNumber }} · 编辑版本 {{ event.version }}</b><p>{{ event.actorName || event.actorUsername || '系统初始化' }} · {{ formatDate(event.createdAt) }}</p><details v-if="event.changes?.length"><summary>查看 {{ event.changes.length }} 处修改</summary><p v-for="(change,index) in event.changes" :key="index">{{ change.bindingPath || `${columnLabel(change.col)}${change.row + 1}` }}{{ change.rowCount > 1 || change.colCount > 1 ? ` · ${change.rowCount} 行 × ${change.colCount} 列` : '' }}：{{ change.kind === 'clear' ? '清除内容' : change.kind === 'formula' ? '更新公式' : change.value == null ? '清空值' : change.value }}</p></details></article><p v-if="!historyLoading && !editHistory.length">暂无编辑历史</p></div></section>
          <section v-if="isAssignedSubmitter && timeline.length" class="rail-card lifecycle-card">
            <div class="rail-heading"><div><span class="eyebrow">REVISION HISTORY</span><h2>任务与修订时间线</h2></div><el-tag effect="plain" size="small">{{ taskStatusLabel(task?.status) }}</el-tag></div>
            <div class="timeline-list" aria-label="任务与修订时间线">
              <article v-for="event in timeline" :key="event.id" class="timeline-event">
                <span class="timeline-dot" :class="event.type"/>
                <div><b>{{ eventLabel(event.type) }}<small v-if="event.revisionNumber"> · 修订 {{ event.revisionNumber }}</small></b>
                  <span>{{ event.actorName || event.actorUsername }} · {{ formatDate(event.createdAt) }}</span>
                  <p v-if="event.reason">{{ event.reason }}</p>
                  <small v-if="event.remediationDeadline">整改期限：{{ formatDate(event.remediationDeadline) }}</small>
                </div>
              </article>
            </div>
          </section>
          <section v-if="quarterlyDependencies" class="rail-card quarterly-dependencies" aria-label="季度月报依赖">
            <div class="rail-heading"><div><span class="eyebrow">MONTHLY DEPENDENCIES</span><h2>月报定稿依赖</h2></div><el-tag :type="quarterlyDependencies.complete ? 'success' : 'warning'" effect="plain" size="small">{{ quarterlyDependencies.complete ? '可评分' : '待齐全' }}</el-tag></div>
            <p class="dependency-gate">{{ quarterlyDependencies.complete ? '所需月报均有当前有效定稿修订。' : '月报依赖未齐时仍可填写定性指标；评分与定稿须等待全部依赖完成。' }}</p>
            <div class="dependency-periods"><div v-for="month in quarterlyDependencies.months" :key="month.periodCode" class="dependency-period">
              <span><b>{{ month.periodCode }}</b><small>{{ dependencyStatusLabel(month.status) }}</small></span>
              <span class="dependency-value">{{ quarterlyValue(month.metrics.revenue) }}<small>收入</small></span>
              <span class="dependency-value">{{ quarterlyValue(month.metrics.profit) }}<small>利润</small></span>
              <small v-if="month.revisionId" class="dependency-revision">修订 #{{ month.revisionId }}</small>
            </div></div>
            <div class="quarter-totals"><div><span>本季度</span><b>收入 {{ quarterlyValue(quarterlyDependencies.currentQuarter.revenue.value) }}</b><b>利润 {{ quarterlyValue(quarterlyDependencies.currentQuarter.profit.value) }}</b></div><div><span>年初至今</span><b>收入 {{ quarterlyValue(quarterlyDependencies.yearToDate.revenue.value) }}</b><b>利润 {{ quarterlyValue(quarterlyDependencies.yearToDate.profit.value) }}</b></div></div>
            <small v-if="quarterlyDependencies.missingPeriods.length" class="dependency-missing">待补月份：{{ quarterlyDependencies.missingPeriods.map(item => `${item.periodCode}（${dependencyStatusLabel(item.status)}${item.missingMetrics?.length ? `，缺${item.missingMetrics.join('、')}` : ''}）`).join('、') }}</small>
            <div v-if="indicators.length" class="quarter-indicator-list"><span class="indicator-list-title">固定定性指标行</span><div v-for="indicator in indicators" :key="indicator.recordKey"><b>{{ indicator.displayName }}</b><small>{{ indicator.category === 'key_work' ? '重点工作' : '重点业务' }} · {{ indicator.recordKey }} · 最高 {{ indicator.maximumScore }} 分 · {{ indicator.namedArea || '未绑定命名区域' }}</small></div></div>
          </section>
          <section v-if="quarterlyAdjustmentImpacts.length" class="rail-card lifecycle-action adjustment-impact-card" aria-label="月报调整影响">
            <span class="eyebrow">MONTHLY REVISION IMPACT</span><h2>月报调整影响</h2>
            <article v-for="impact in quarterlyAdjustmentImpacts" :key="impact.id" class="impact-item">
              <b>{{ impact.changedFields.join('、') }}</b><p>{{ impact.adjustmentReason }}</p>
              <small v-if="impact.status === 'requires_adjustment'">本季度已定稿，请另行发起季度调整。</small>
              <el-button v-else-if="task?.status !== 'finalized'" size="small" type="primary" plain :loading="impactBusyId === impact.id" @click="confirmAdjustmentImpact(impact)">确认已核对差异</el-button>
            </article>
          </section>
          <section v-if="canWithdraw" class="rail-card lifecycle-action">
            <h2>发现提交内容需要修正？</h2><p>撤回会保留本次已提交修订，并从其工作簿创建新的草稿修订。</p>
            <el-input v-model="withdrawReason" aria-label="撤回原因" placeholder="填写撤回原因" maxlength="1000" show-word-limit />
            <el-button type="warning" :loading="lifecycleBusy" :disabled="!withdrawReason.trim()" @click="withdrawTask">撤回并开始更正</el-button>
          </section>
          <section v-if="canReview" class="rail-card lifecycle-action">
            <span class="eyebrow">REVIEW ACTION</span><h2>审核本次提交</h2>
            <el-input v-model="reviewOpinion" aria-label="审核意见" type="textarea" :rows="3" placeholder="填写审核意见或退回原因" maxlength="2000" />
            <el-date-picker v-model="remediationDeadline" aria-label="整改期限" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" placeholder="选择整改期限" />
            <div class="review-buttons"><el-button :loading="lifecycleBusy" :disabled="!reviewOpinion.trim()" @click="saveOpinion('comment')">保存意见并开始审核</el-button>
              <el-button type="warning" :loading="lifecycleBusy" :disabled="!reviewOpinion.trim() || !remediationDeadline" @click="saveOpinion('return')">退回并创建更正草稿</el-button></div>
          </section>
          <section v-if="canReview && anomalies.length" class="rail-card anomaly-review-card" aria-label="异常说明审核">
            <div class="rail-heading"><div><span class="eyebrow">ANOMALY REVIEW</span><h2>异常说明审核</h2></div><el-tag effect="plain" size="small">{{ anomalies.length }} 项</el-tag></div>
            <article v-for="anomaly in anomalies" :key="anomaly.id" class="anomaly-review-item">
              <div class="anomaly-review-heading"><b>{{ anomaly.fieldCode || anomaly.ruleCode }}</b><el-tag size="small" :type="anomaly.disposition === 'accepted' ? 'success' : anomaly.disposition === 'correction_requested' ? 'danger' : 'warning'">{{ anomalyDispositionLabel(anomaly.disposition) }}</el-tag></div>
              <p>{{ anomaly.message }}</p><blockquote>{{ anomaly.explanation }}</blockquote>
              <small>触发值：{{ displayEvidence(anomaly.triggeringValue) }} · 对照值：{{ displayEvidence(anomaly.comparisonValue) }}</small>
              <div v-if="!anomaly.disposition || anomalyBusyId === anomaly.id" class="anomaly-review-actions">
                <el-button size="small" :loading="anomalyBusyId === anomaly.id" @click="setAnomalyDisposition(anomaly, 'correction_requested')">要求补正说明</el-button>
                <el-button size="small" type="primary" :loading="anomalyBusyId === anomaly.id" @click="setAnomalyDisposition(anomaly, 'accepted')">接受说明</el-button>
              </div>
              <small v-else>处置人：{{ anomaly.reviewerName || '已记录' }}</small>
            </article>
          </section>
          <section class="rail-card progress-card"><span class="eyebrow">FILLING STATUS</span><h2>必填完整度</h2><div class="progress-total"><strong>{{ filledInputCount }}</strong><span>/ {{ requiredInputCount }} 项必填</span><el-progress :percentage="validationPercent" :show-text="false" :stroke-width="5"/></div><div class="validation-line" :class="validationPercent === 100 ? 'valid' : 'pending'"><i></i>{{ validationPercent === 100 ? '必填项已填写完整' : `还有 ${requiredInputCount - filledInputCount} 项必填内容待填写` }}</div>
            <div class="precheck-block"><div class="precheck-heading"><b>提交前检查</b><el-tag size="small" effect="plain" :type="precheckIsStale ? 'warning' : localValidationErrors.length ? 'danger' : 'success'">{{ precheckIsStale ? '结果待刷新' : precheck?.status === 'current' ? '最新结果' : '等待结果' }}</el-tag></div><div v-if="precheck" class="precheck-counts"><span><strong>{{ localValidationErrors.length }}</strong> 阻断</span><span><strong>{{ precheck.warningCount }}</strong> 预警</span><small>协作版本 {{ precheck.version }} / {{ room?.currentVersion || 0 }}</small></div>
              <section v-if="warningGroups.length" class="warning-explanations" aria-label="提交前异常说明">
                <h3>预警与异常说明</h3><p class="warning-explanation-hint">提交时必须为每项预警填写说明。同一规则下的预警可共用一条说明。</p>
                <article v-for="group in warningGroups" :key="group.key" class="warning-explanation-group">
                  <b>{{ group.warnings.length > 1 ? `${group.warnings.length} 项 · ` : '' }}{{ group.warnings[0].ruleCode || group.warnings[0].code }}</b>
                  <p v-for="warning in group.warnings" :key="warning.warningKey">{{ warning.message }}</p>
                  <el-input v-model="warningExplanations[group.key]" type="textarea" :rows="2" maxlength="2000" show-word-limit
                    :aria-label="`${group.warnings[0].ruleCode || group.warnings[0].code} 异常说明`" placeholder="说明异常原因或核查结果" />
                </article>
              </section>
              <ul v-if="localValidationErrors.length" class="precheck-issues"><li v-for="(issue,index) in localValidationErrors.slice(0, 5)" :key="`${issue.code}-${index}`" class="blocking">{{ issue.message }}</li></ul>
              <ul v-if="nativeValidationHints.length" class="precheck-issues"><li v-for="(item,index) in nativeValidationHints.slice(0,5)" :key="index">{{ item.message }}（可继续提交）</li></ul><small v-if="!localValidationErrors.length && !warningGroups.length && !nativeValidationHints.length" class="rule-hint">{{ precheckIsStale ? '工作簿已有新修改，正在更新预检结果。' : '当前版本未发现阻断或预警。' }}</small></div>
          <div v-if="calculations" class="calculation-block"><span>只读累计值 · {{ calculations.sampleDataLabel }}</span><div v-for="metric in calculationMetrics" :key="metric.key" class="calculation-row"><b>{{ metric.label }}</b><span>本年累计 <strong>{{ calculationValue(calculations.currentYearToDate[metric.key]) }}</strong><small v-if="calculations.targets[metric.key]?.cumulativeCompletionPercent != null">{{ calculations.targets[metric.key].cumulativeCompletionPercent.toFixed(1) }}%</small></span><span>上年累计 <strong>{{ calculationValue(calculations.priorYearToDate[metric.key]) }}</strong></span></div><small>{{ calculations.source.historyMessage || `历史数据截至：${calculations.source.historyAvailableThrough || '暂无匹配历史'}` }} · 单位：{{ calculations.unit }}</small></div>

          <div v-if="monthlyTargets.length" class="targets-block"><span>本月目标 · 配置快照</span><div v-for="target in monthlyTargets" :key="target.fieldCode"><b>{{ target.fieldCode }}</b><strong>{{ target.amount }} 万元</strong></div></div><div v-if="ruleThresholds" class="threshold-snapshot"><span>本期预警比例 · 管理员配置</span><div><b>同比 / 环比</b><strong>{{ ruleThresholds.yoyChangePercent }}% / {{ ruleThresholds.momChangePercent }}%</strong></div><div><b>目标完成率</b><strong>{{ ruleThresholds.targetCompletionMinPercent }}% – {{ ruleThresholds.targetCompletionMaxPercent }}%</strong></div></div><div class="input-list"><button v-for="mapping in inputMappings" :key="mapping.key" class="input-row" @click="selectInput(mapping)"><span class="input-state" :class="hasValue(mapping) ? 'done' : ''">{{ hasValue(mapping) ? '✓' : '·' }}</span><span><b>{{ mapping.displayName || mapping.fieldCode }}</b><small>{{ mapping.fieldCode }} · {{ mapping.namedArea }}</small></span><span class="input-value">{{ hasValue(mapping) ? '已填写' : '待填写' }}</span></button><p v-if="!inputMappings.length" class="empty-hint">当前发布模板没有配置可填报的主输入区域。</p></div></section>

          <section class="rail-note"><span>工作簿提示</span><p>{{ task?.status === 'draft' && room?.status === 'open' ? '蓝色单元格可录入；公式和模板结构为只读。' : '当前为只读修订；如需更正已定稿数据，请通过调整流程发起。' }}</p><span class="connection-pill" :class="connectionState === '已连接' ? 'connected' : ''"><i/>{{ connectionState }}</span></section>
        </aside>
      </div>
    </section>
  </main>
</template>

<script>
import { registerTemplateFunctions } from '@/template/managedFunctions'
import { restoreRevisionWorkbook } from '@/template/restoreRevisionWorkbook'
import { returnToWorkflow } from '@/utils/workflowNavigation'
import DemoNextStep from '@/components/DemoNextStep.vue'
import { loadTemplateWorkbook } from '@/template/composedTemplateWorkbook'
import { bindAuxiliaryData, disposeAuxiliaryData } from '@/template/auxiliaryDataBinding'
import '@grapecity-software/spread-sheets/styles/gc.spread.sheets.excel2013white.css'
import '@grapecity-software/spread-sheets-collaboration-addon'
import '@grapecity-software/spread-sheets-print'
import GC from '@grapecity-software/spread-sheets'
import { Client } from '@grapecity-software/js-collaboration-client'
import * as OT from '@grapecity-software/js-collaboration-ot-client'
import { type } from '@grapecity-software/spread-sheets-collaboration-client'
import { Presence } from '@grapecity-software/js-collaboration-presence-client'
import { bindPresence } from '@grapecity-software/spread-sheets-collaboration-client'
import { ArrowLeft, ArrowRight, Refresh, Search } from '@element-plus/icons-vue'
import { markRaw } from 'vue'
import { collaborationApi } from '@/api'
import { API_BASE_URL } from '@/api/base'
import { validateNativeCells } from '@/template/nativeValidator'
import { validateFillingValues } from '@/template/fillingValidation'
import { bindReportData, readBoundValue } from '@/template/dataBinding'
import { applyPermissionView, cellPermission, isBusinessValueChange, businessValueChanges } from '@/template/permissionView'
import SignaturePad from '@/components/SignaturePad.vue'
import signatureFilling from '@/template/signatureFilling'
import { SHOWCASE } from '@/config/showcase'

OT.TypesManager.register(type)
const WAITING_FOR_FILLER = '填报人尚未开始协作；工作簿会在其开始后自动更新。'

export default {
  name: 'MonthlyFillingWorkbench',
  components: { ArrowLeft, ArrowRight, Refresh, Search, SignaturePad, DemoNextStep },
  mixins: [signatureFilling],
  data() {
    return { showcase: SHOWCASE, taskId: null, tasks: [], task: null, room: null, progress: null, workbook: null, sharedDoc: null, connection: null,
      fieldDefinitions: [], validationRules: [], localValidationErrors: [], nativeValidationHints: [], submissionValidationReport: null, editHistory: [], historyLoading: false, historyError: '', presence: null, inputMappings: [], inputValues: {}, collaborators: [], precheck: null, calculations: null, anomalies: [], templateContract: null, warningExplanations: {}, anomalyBusyId: null, loading: false, ready: false, errorText: '', findText: '',
      selectedInput: '', zoomPercent: 100, connectionState: '连接中', refreshTimer: null, precheckTimer: null, currentUserId: 0,
      workbookResizeObserver: null, workbookResizeFrame: null, roomLoadGeneration: 0,
      permissionIndex: null, permissionIdentity: null, businessChangesBound: false, indicators: [], quarterlyDependencies: null, quarterlyAdjustmentImpacts: [], impactBusyId: null, evidenceAttachments: [], evidenceIndicatorCode: '', evidenceBusy: false,
      pendingChangeSets: 0, recoveryRequired: false, rejectedChanges: [], submissionBusy: false, submissionIdempotencyKey: null, timeline: [], revision: null, withdrawReason: '', reviewOpinion: '',
      remediationDeadline: '', lifecycleBusy: false, reviewItemVersion: 0, adjustmentDialogOpen: false, adjustmentFields: [],
      adjustmentFieldCodes: [], adjustmentReason: '', adjustmentTaskId: null, adjustmentBusy: false }
  },
  computed: {
    requiredMappings() { return this.inputMappings.filter(mapping => mapping.required) },
    monthlyTargets() { return (this.task?.configuration?.targets || []).filter(target => target.phase === 'monthly' && target.phasePeriod === this.task?.periodCode) },
    requiredInputCount() { return this.requiredMappings.length },
    filledInputCount() { return this.requiredMappings.filter(mapping => this.inputValues[mapping.key]).length },
    ruleThresholds() { return this.task?.configuration?.configuration?.ruleThresholds || null },
    precheckIsStale() { return !this.precheck || this.precheck.stale || Number(this.precheck.version) !== Number(this.room?.currentVersion || 0) },
    isAssignedSubmitter() { return this.permissionIdentity?.roles?.includes('subsidiary_submitter')
      && (this.task?.configuration?.assignments || []).some(item => item.responsibility === 'submitter' && Number(item.userId) === this.currentUserId) },
    isAssignedFiller() { return this.permissionIdentity?.roles?.includes('subsidiary_filler')
      && (this.task?.configuration?.assignments || []).some(item => item.responsibility === 'filler' && Number(item.userId) === this.currentUserId) },
    isAssignedReviewer() { return this.permissionIdentity?.roles?.includes('department_reviewer')
      && (this.task?.configuration?.assignments || []).some(item => item.responsibility === 'department_reviewer' && Number(item.userId) === this.currentUserId) },
    canUploadEvidence() { return this.task?.status === 'draft' && this.room?.status === 'open'
      && (this.permissionIdentity?.roles?.includes('subsidiary_filler') && (this.task?.configuration?.assignments || []).some(item => item.responsibility === 'filler' && Number(item.userId) === this.currentUserId)
        || this.permissionIdentity?.roles?.includes('subsidiary_submitter') && (this.task?.configuration?.assignments || []).some(item => item.responsibility === 'submitter' && Number(item.userId) === this.currentUserId)) },
    canWithdraw() { return this.isAssignedSubmitter && this.task?.status === 'submitted'
      && !this.timeline.some(event => event.type === 'reviewing' && Number(event.revisionId) === Number(this.revision?.id)) },
    canReview() { return this.isAssignedReviewer && ['submitted', 'reviewing'].includes(this.task?.status) },
    warningGroups() {
      if (this.task?.status !== 'draft' || this.room?.status !== 'open') return []
      const groups = new Map()
      for (const warning of this.precheck?.warnings || []) {
        const key = warning.ruleVersionId ? `version:${warning.ruleVersionId}` : `code:${warning.ruleCode || warning.code}`
        if (!groups.has(key)) groups.set(key, { key, ruleVersionId: warning.ruleVersionId || null,
          ruleCode: warning.ruleCode || warning.code, warnings: [] })
        groups.get(key).warnings.push(warning)
      }
      return [...groups.values()]
    },
    missingWarningExplanations() { return this.warningGroups.some(group => !String(this.warningExplanations[group.key] || '').trim()) },
    submitterNames() { return (this.task?.submitters || []).map(user => this.showcase ? user.name : `${user.name}（${user.username}）`).join('、') || '尚未分配，请联系系统管理员' },
    submissionBlockers() {
      const reasons = []
      if (this.room?.status !== 'open' || this.task?.status !== 'draft') reasons.push('任务当前不在填报状态')
      if (this.connectionState !== '已连接') reasons.push('等待协作连接恢复')
      if (this.pendingChangeSets) reasons.push('正在同步填报内容')
      if (this.recoveryRequired) reasons.push('存在未同步编辑，请先恢复服务器版本')
      if (this.precheckIsStale) reasons.push('正在更新提交前检查结果')
      if (this.localValidationErrors.length) reasons.push(`还有 ${this.localValidationErrors.length} 项填写问题，请按右侧提示补齐`)
      if (this.missingWarningExplanations) reasons.push('请在右侧“预警与异常说明”填写每项预警的原因或核查结果')
      if (this.submissionBusy) reasons.push('正在提交')
      return reasons
    },
    canSubmit() { return this.isAssignedSubmitter && this.submissionBlockers.length === 0 },
    calculationMetrics() { return [{ key: 'revenue', label: '营业收入' }, { key: 'profit', label: '利润总额' }] },
    validationPercent() { return this.requiredInputCount ? Math.round(this.filledInputCount * 100 / this.requiredInputCount) : 100 }
  },
  watch: { '$route.query.taskId': { immediate: true, handler(value) { this.taskId = value ? Number(value) : null; if (this.taskId) this.loadTask(); else { this.cleanup(); this.loadTasks() } } } },
  beforeUnmount() { this.cleanup() },
  methods: {
    async shareTask() {
      try { await navigator.clipboard.writeText(new URL(`${import.meta.env.BASE_URL}portal/monthly-filling?taskId=${this.taskId}`, window.location.origin).href); this.$message.success('链接已复制；对方登录有任务权限的账号后即可进入') }
      catch { this.$message.error('复制失败，请复制浏览器地址栏中的任务链接') }
    },
    async loadHistory() {
      if (!this.isAssignedSubmitter) return
      this.historyLoading = true; this.historyError = ''
      try { this.editHistory = (await collaborationApi.getTaskHistory(this.taskId)).versions || [] }
      catch (error) { this.historyError = error.message }
      finally { this.historyLoading = false }
    },
    async loadTasks() {
      if (this.taskId) return
      this.loading = true; this.errorText = ''
      try { this.tasks = (await collaborationApi.getMonthlyTasks()).tasks || [] }
      catch (error) { this.errorText = error.message }
      finally { this.loading = false }
    },
    async prepareAdjustment(item) {
      this.errorText = ''
      try {
        const result = await collaborationApi.getAdjustmentFields(item.id)
        this.adjustmentTaskId = item.id; this.adjustmentFields = result.fields || []
        this.adjustmentFieldCodes = []; this.adjustmentReason = ''; this.adjustmentDialogOpen = true
        if (!this.adjustmentFields.length) this.errorText = '当前有效修订没有可调整的结构化字段。'
      } catch (error) { this.errorText = error.message }
    },
    async startAdjustment() {
      if (this.adjustmentBusy) return
      this.adjustmentBusy = true
      try {
        const result = await collaborationApi.startMonthlyAdjustment(this.adjustmentTaskId, {
          fieldCodes: this.adjustmentFieldCodes, reason: this.adjustmentReason
        })
        this.adjustmentDialogOpen = false
        this.$router.push({ path: '/portal/monthly-filling', query: { taskId: result.taskId } })
      } catch (error) { this.errorText = error.message }
      finally { this.adjustmentBusy = false }
    },
    async confirmAdjustmentImpact(impact) {
      this.impactBusyId = impact.id
      try {
        await collaborationApi.confirmQuarterlyAdjustmentImpact(this.taskId, impact.id)
        this.quarterlyAdjustmentImpacts = this.quarterlyAdjustmentImpacts.filter(item => item.id !== impact.id)
        await this.loadTask()
      } catch (error) { this.errorText = error.message }
      finally { this.impactBusyId = null }
    },
    async loadTask() {
      this.cleanup(); this.loading = true; this.ready = false; this.errorText = ''; this.recoveryRequired = false
      const generation = this.roomLoadGeneration
      try {
        // Mount the host before either the collaborative or static Workbook is created.
        await this.$nextTick()
        const response = await collaborationApi.getMonthlyTask(this.taskId)
        if (generation !== this.roomLoadGeneration) return
        this.permissionIndex = response.manifest?.permissionIndex || null
        this.permissionIdentity = response.permissionIdentity
        this.task = response.task; this.room = response.room; this.progress = response.progress; this.timeline = response.timeline || []; this.revision = response.revision; this.anomalies = response.anomalies || []; this.indicators = response.indicators || []; this.quarterlyDependencies = response.quarterlyDependencies || null; this.quarterlyAdjustmentImpacts = response.quarterlyAdjustmentImpacts || []; this.templateContract = response.workbook
        const reviewDepartment = response.permissionIdentity?.departmentCodes?.[0]
        this.reviewItemVersion = Number(response.reviewItems?.find(item => item.reviewItemKey === 'monthly:submission'
          && item.departmentCode === reviewDepartment)?.version || 0)

        this.fieldDefinitions = response.fieldDefinitions || []; this.validationRules = response.validationRules || []; this.precheck = response.precheck || response.progress?.precheck || null; this.calculations = response.calculations || null
        const identity = JSON.parse(localStorage.getItem('userInfo') || '{}'); this.currentUserId = Number(identity.id)
        const isAssignedFiller = response.permissionIdentity?.roles?.includes('subsidiary_filler')
          && (this.task.configuration?.assignments || []).some(item => item.responsibility === 'filler' && Number(item.userId) === this.currentUserId)
        const isAssignedSubmitter = response.permissionIdentity?.roles?.includes('subsidiary_submitter')
          && (this.task.configuration?.assignments || []).some(item => item.responsibility === 'submitter' && Number(item.userId) === this.currentUserId)
        if (response.submittedWorkbook) await this.loadStaticWorkbook(response, response.submittedWorkbook)
        else if (response.seedWorkbook && !isAssignedFiller && !isAssignedSubmitter) await this.loadStaticWorkbook(response, response.seedWorkbook)
        else await this.connectWorkbook(response, identity, isAssignedFiller)
        if (generation !== this.roomLoadGeneration) return
        this.applyAnomalyHighlights(this.precheck?.warnings || this.anomalies)
        this.validateCurrentValues()
        this.ready = true
        this.bindSignatureCells()
        await this.loadHistory()
        if (generation !== this.roomLoadGeneration) return
        await this.$nextTick()
        this.observeWorkbookSize()
        if (!response.submittedWorkbook) this.refreshTimer = window.setInterval(this.refreshProgress, 7000)
      } catch (error) { if (generation === this.roomLoadGeneration) this.errorText = error.message }
      finally { if (generation === this.roomLoadGeneration) this.loading = false }
    },
    async connectWorkbook(response, identity, canEdit) {
      const token = localStorage.getItem('token')
      const apiAddress = new URL(API_BASE_URL, window.location.href)
      const websocketUrl = `${apiAddress.protocol === 'https:' ? 'wss:' : 'ws:'}//${apiAddress.host}`
      const client = new Client(websocketUrl, { path: `${import.meta.env.BASE_URL}collaboration/` })
      this.connection = markRaw(client.connect(response.room.roomKey, { auth: { token } }))
      this.sharedDoc = markRaw(new OT.SharedDoc(this.connection))
      this.workbook = markRaw(new GC.Spread.Sheets.Workbook(this.$refs.spreadHost, { sheetCount: 1 }))
      await registerTemplateFunctions(this.workbook, response.workbook)
      this.workbook.options.highlightInvalidData = true
      this.workbook.bind(GC.Spread.Sheets.Events.ValidationError, (_event,args) => {
        if(args.validator?.showErrorMessage()) this.$message.warning(args.validator.errorMessage() || '输入不符合单元格校验条件')
        args.validationResult = args.validator?.errorStyle() === 0 ? GC.Spread.Sheets.DataValidation.DataValidationResult.retry : GC.Spread.Sheets.DataValidation.DataValidationResult.forceApply
      })
      this.presence = markRaw(new Presence(this.connection))
      let creationAttempted = false
      this.sharedDoc.on('error', error => {
        // A losing create can also emit a late error after fetch has recovered it.
        // Its promise is handled below; edit failures still surface via submitOp.
        if (creationAttempted && error.code === OT.OTError.CODES.ERR_DOC_ALREADY_CREATED) return
        this.errorText = `协作连接异常：${error.message || error}`
      })
      this.connection.on('connect', () => { this.connectionState = '已连接' })
      this.connection.on('disconnect', () => { this.connectionState = '已断开' })
      this.connection.on('reconnect', () => { this.connectionState = '已连接'; this.queuePrecheck() })
      // A WebSocket upgrade can remain pending when a proxy omits this route.
      // Bound the initial subscription and close its resources before retrying.
      const connection = this.connection, sharedDocument = this.sharedDoc, presence = this.presence
      let connectionTimer
      try {
        await Promise.race([sharedDocument.subscribe(), new Promise((_, reject) => {
          connectionTimer = window.setTimeout(() => reject(new Error('协作连接超时，请检查网络或协作服务后重试。')), 15000)
        })])
      } catch (error) {
        try { presence.destroy() } catch {}
        try { sharedDocument.destroy() } catch {}
        try { connection.close() } catch {}
        throw error
      } finally { window.clearTimeout(connectionTimer) }
      if (this.connection !== connection) throw new Error('协作房间打开已取消')
      const templateSnapshot = await this.createTemplateSnapshot(response.workbook)
      if (this.connection !== connection) throw new Error('协作房间打开已取消')
      this.workbook.collaboration.fromSnapshot(templateSnapshot)
      this.configureInputs(response.workbook, response.manifest?.permissionIndex, response.permissionIdentity, canEdit)
      let seedValues = []
      const seedIntoEmptyRoom = response.seedWorkbook && canEdit && Number(this.sharedDoc.version || 0) <= 1
      if (seedIntoEmptyRoom) {
        const tableInputs = (response.workbook?.sheets || []).flatMap((definition, sheetIndex) =>
          (definition.mappings || []).filter(mapping => mapping.kind === 'table' && mapping.primary
            && mapping.permission === 'primary_input').map(mapping => ({ ...mapping, sheetIndex,
            row: Number(mapping.row), col: Number(mapping.col), rowCount: Math.max(1, Number(mapping.rowCount) || 1),
            colCount: Math.max(1, Number(mapping.colCount) || 1) })))
        const seedMappings = [...this.inputMappings, ...tableInputs]
        const importHost = document.createElement('div')
        const importWorkbook = new GC.Spread.Sheets.Workbook(importHost, { sheetCount: 1 })
        try {
          await registerTemplateFunctions(importWorkbook, response.workbook)
          await restoreRevisionWorkbook(importWorkbook, response.seedWorkbook)
          seedValues = seedMappings.flatMap(mapping => Array.from({ length: mapping.rowCount }, (_, rowOffset) =>
            Array.from({ length: mapping.colCount }, (_, colOffset) => {
              const row = mapping.row + rowOffset, col = mapping.col + colOffset
              return { ...mapping, row, col, rowCount: 1, colCount: 1,
                formula: importWorkbook.getSheet(mapping.sheetIndex)?.getFormula(row, col),
                value: importWorkbook.getSheet(mapping.sheetIndex)?.getValue(row, col) }
            })).flat())
        } finally { importWorkbook.destroy() }
      }
      let documentAvailable = Boolean(this.sharedDoc.type)
      if (!documentAvailable) {
        if (canEdit) {
          try {
            let initialSnapshot = templateSnapshot
            if (seedValues.length) {
              initialSnapshot = await this.createTemplateSnapshot(response.workbook, seedValues)
            }
            creationAttempted = true
            await this.sharedDoc.create(initialSnapshot, type.uri, {})
            seedValues = []
            documentAvailable = true
          }
          catch (error) {
            if (error.code !== OT.OTError.CODES.ERR_DOC_ALREADY_CREATED) throw error
            // Discard only this failed optimistic create, before the panel becomes
            // editable, and load the winner's latest snapshot and sheet identities.
            await this.sharedDoc.hardRollback()
            documentAvailable = Boolean(this.sharedDoc.type)
            if (!documentAvailable) throw new Error('协作房间初始化失败：并发创建后未能读取工作簿。')
          }
      } else this.errorText = WAITING_FOR_FILLER
      }
      if (documentAvailable) await this.bindBusinessChanges()
      const seedVersion = Number(this.sharedDoc?.version || 0)
      const seedWrites = seedValues.filter(mapping => {
        const sheet = this.workbook.getSheet(mapping.sheetIndex)
        if (mapping.formula) return sheet?.getFormula(mapping.row, mapping.col) !== mapping.formula
        const currentValue = sheet?.getValue(mapping.row, mapping.col)
        if (mapping.value === undefined || mapping.value === null || mapping.value === '') {
          return currentValue !== undefined && currentValue !== null && currentValue !== ''
        }
        return !Object.is(currentValue, mapping.value)
          && !(currentValue != null && String(currentValue) === String(mapping.value))
      })
      for (const mapping of seedWrites) {
        this.workbook.getSheet(mapping.sheetIndex)?.getRange(mapping.row, mapping.col, mapping.rowCount, mapping.colCount).locked(false)
      }
      if (seedWrites.length) this.workbook.collaboration.startBatchOp()
      try {
        for (const mapping of seedWrites) {
          if (mapping.formula) {
            this.workbook.getSheet(mapping.sheetIndex)?.setFormula(mapping.row, mapping.col, mapping.formula)
          } else {
            this.workbook.getSheet(mapping.sheetIndex)?.setValue(mapping.row, mapping.col, mapping.value ?? null)
          }
        }
      } finally { if (seedWrites.length) this.workbook.collaboration.endBatchOp() }
      if (seedWrites.length) await this.waitForSeedWrites(seedVersion, seedWrites)
      await bindAuxiliaryData(this.workbook, response.workbook, message => this.$message.warning(message))
      // Apply local cell locks only after writing seeds into the shared model.
      this.configureInputs(response.workbook, response.manifest?.permissionIndex, response.permissionIdentity, canEdit)
      this.permissionIndex = response.manifest?.permissionIndex || null
      this.permissionIdentity = response.permissionIdentity
      applyPermissionView(this.workbook, this.permissionIndex, this.permissionIdentity, canEdit && response.room.status === 'open')
      this.applyLocalProtection()
      this.refreshInputValues()
      const activeUser = { id: String(identity.id), name: identity.name || identity.username, color: this.avatarColor(Number(identity.id)), permission: {
        mode: canEdit && response.room.status === 'open' ? GC.Spread.Sheets.Collaboration.BrowsingMode.edit : GC.Spread.Sheets.Collaboration.BrowsingMode.view
      } }
      await bindPresence(this.workbook, this.presence, activeUser)
      const update = () => { this.collaborators = Object.values(this.presence.otherStates || {}).map(state => state.user || state).filter(item => item.id !== String(identity.id))
        this.collaborators.unshift({ id: String(identity.id), name: activeUser.name, color: activeUser.color }) }
      this.presence.on('add', update); this.presence.on('update', update); this.presence.on('remove', update); update()
      this.workbook.bind(GC.Spread.Sheets.Events.ValueChanged, () => { this.refreshInputValues(); this.queuePrecheck() })
    },
    async waitForSeedWrites(startingVersion, seedValues) {
      const expiresAt = Date.now() + 15_000
      while (Date.now() < expiresAt) {
        if (Number(this.sharedDoc?.version || 0) > startingVersion && this.pendingChangeSets === 0) return
        await new Promise(resolve => window.setTimeout(resolve, 25))
      }
      throw new Error(`原修订输入值未能同步到新的协作房间（协作版本 ${Number(this.sharedDoc?.version || 0)}，起始版本 ${startingVersion}，待提交 ${this.pendingChangeSets}）`)
    },
    async loadStaticWorkbook(response, workbookSnapshot) {
      this.workbook = markRaw(new GC.Spread.Sheets.Workbook(this.$refs.spreadHost, { sheetCount: 1 }))
      await registerTemplateFunctions(this.workbook, response.workbook)
      this.workbook.options.highlightInvalidData = true
      this.workbook.bind(GC.Spread.Sheets.Events.ValidationError, (_event,args) => {
        if(args.validator?.showErrorMessage()) this.$message.warning(args.validator.errorMessage() || '输入不符合单元格校验条件')
        args.validationResult = args.validator?.errorStyle() === 0 ? GC.Spread.Sheets.DataValidation.DataValidationResult.retry : GC.Spread.Sheets.DataValidation.DataValidationResult.forceApply
      })
      await this.buildWorkbook(response.workbook, false)
      await restoreRevisionWorkbook(this.workbook, workbookSnapshot)
      await bindAuxiliaryData(this.workbook, response.workbook, message => this.$message.warning(message))
      this.configureInputs(response.workbook, response.manifest?.permissionIndex, response.permissionIdentity, false)
      this.permissionIndex = response.manifest?.permissionIndex || null
      this.permissionIdentity = response.permissionIdentity
      applyPermissionView(this.workbook, this.permissionIndex, this.permissionIdentity, false)
      this.applyLocalProtection()
      this.connectionState = '只读历史修订'
      this.collaborators = []
    },
    async bindBusinessChanges() {
      if (this.businessChangesBound) return
      const document = this.sharedDoc
      this.workbook.collaboration.registerCollaborationType(type)
      this.workbook.collaboration.fromSnapshot(this.sharedDoc.data)
      this.workbook.collaboration.onChangeSet(async changeSet => {
        if (this.applyingRemoteChange || this.sharedDoc !== document) return
        const remoteSheetNames = new Set((this.templateContract?.sheets || []).filter(sheet => sheet.dataBinding).map(sheet => sheet.name))
        const remoteIds = new Set(Object.entries(document.data?.sheets || {}).filter(([, sheet]) => remoteSheetNames.has(sheet.name)).map(([id]) => id))
        const ops = businessValueChanges(changeSet, document.data, this.permissionIndex).filter(op => !remoteIds.has(op.sheetId)
          && (op.module !== 'dataManager' || document.data?.dataManager?.tables?.[op.payload?.tableId]?.name === 'reportData'))
        if (ops.length) {
          if (this.recoveryRequired) { this.rejectedChanges.push({ taskId: this.taskId, ops: JSON.parse(JSON.stringify(ops)) }); return }
          if (this.precheck) this.precheck.stale = true
          this.pendingChangeSets += 1
          try { await document.submitOp({ ...changeSet, ops }, { source: document.connection.id }) }
          catch (error) {
            if (this.sharedDoc !== document) return
            this.recoveryRequired = true
            this.rejectedChanges.push({ taskId: this.taskId, ops: JSON.parse(JSON.stringify(ops)) })
            this.errorText = `协作编辑被拒绝：${error.message || error}。已暂停填报，请保留未同步内容后重新连接。`
            this.applyingRemoteChange = true
            try { applyPermissionView(this.workbook, this.permissionIndex, this.permissionIdentity, false) }
            finally { this.applyingRemoteChange = false }
          }
          finally { if (this.sharedDoc === document) { this.pendingChangeSets = Math.max(0, this.pendingChangeSets - 1); this.refreshInputValues(); this.queuePrecheck() } }
        }
      })
      this.sharedDoc.on('op', (changeSet, source) => {
        if (this.sharedDoc !== document || source === document.connection.id || !this.workbook) return
        this.applyingRemoteChange = true
        try {
          this.workbook.collaboration.applyChangeSet({ ...changeSet, ops: changeSet?.ops?.filter(isBusinessValueChange) || [] })
          if (this.precheck) this.precheck.stale = true
          this.refreshInputValues(); this.queuePrecheck()
        } finally { this.applyingRemoteChange = false }
      })
      this.businessChangesBound = true
    },
    async recoverRejectedChanges() {
      if (this.loading || this.pendingChangeSets) return
      await this.loadTask()
      this.recoveryRequired = !this.ready
    },
    async createTemplateSnapshot(contract, seedValues = []) {
      // Painting a mounted host materializes header styles. Keep those local view
      // defaults and permission locks out of the published collaboration model.
      const model = new GC.Spread.Sheets.Workbook(document.createElement('div'), { sheetCount: 1 })
      try {
        await this.buildWorkbook(contract, false, model)
        await bindReportData(model, contract)
        for (const mapping of seedValues) {
          const sheet = model.getSheet(mapping.sheetIndex)
          if (mapping.formula) sheet?.setFormula(mapping.row, mapping.col, mapping.formula)
          else sheet?.setValue(mapping.row, mapping.col, mapping.value ?? null)
        }
        return JSON.parse(JSON.stringify(model.collaboration.toSnapshot()))
      } finally { model.destroy() }
    },
    async buildWorkbook(contract, canEdit, workbook = this.workbook) {
      await registerTemplateFunctions(workbook, contract)
      const definitions = contract?.sheets || []
      this.inputMappings = []
      if (!definitions.length) { this.inputMappings = []; return }
      if (contract.templateSnapshot) {
        workbook.collaboration.fromSnapshot(contract.templateSnapshot)
        await registerTemplateFunctions(workbook, contract)
        return
      }
      if (contract.designerSettings || definitions.some(item => item.sections?.some(section => section.designerJson))) await loadTemplateWorkbook(workbook, contract, { remoteData: false })
      else if (contract.designerJson) await workbook.fromJSON(contract.designerJson)
      workbook.suspendPaint()
      workbook.setSheetCount(Math.max(1, definitions.length))
      definitions.forEach((definition, index) => {
        const sheet = workbook.getSheet(index)
        if (!contract.designerJson && definition.designMode === 'direct' && definition.designerJson) sheet.fromJSON(definition.designerJson)
        sheet.name((definition.name || definition.code || `工作表${index + 1}`).slice(0, 31))
        if (definition.rowCount) sheet.setRowCount(definition.rowCount)
        if (definition.columnCount) sheet.setColumnCount(definition.columnCount)
        if (definition.tag != null) sheet.tag(definition.tag)
        for (const item of definition.rowTags || []) sheet.setTag(item.row, -1, item.tag)
        for (const item of definition.columnTags || []) sheet.setTag(-1, item.col, item.tag)
        for (const cell of definition.cells || []) {
          const row = Number(cell.row) || 0; const col = Number(cell.column ?? cell.col) || 0
          if (cell.formula) sheet.setFormula(row, col, cell.formula)
          else if (cell.value !== undefined) sheet.setValue(row, col, cell.value)
          if (cell.tag != null) sheet.setTag(row, col, cell.tag)
        }
        for (const mapping of definition.mappings || []) {
          if (!mapping.namedArea || !Number.isFinite(Number(mapping.row)) || !Number.isFinite(Number(mapping.col))) continue
          const row = Number(mapping.row); const col = Number(mapping.col)
          const rowCount = Math.max(1, Number(mapping.rowCount) || 1); const colCount = Math.max(1, Number(mapping.colCount) || 1)
          const name = String(mapping.namedArea).replace(/[^A-Za-z0-9_]/g, '_')
          const rangeFormula = `=$${this.columnLabel(col)}$${row + 1}${rowCount * colCount > 1 ? `:$${this.columnLabel(col + colCount - 1)}$${row + rowCount}` : ''}`
          try { sheet.addCustomName(name, rangeFormula, 0, 0, `${mapping.fieldCode} / ${mapping.permission}`, true) } catch {}
        }
      })
      workbook.resumePaint()
      if (!this.inputMappings.some(mapping => mapping.key === this.selectedInput)) this.selectedInput = this.inputMappings[0]?.key || ''
    },
    configureInputs(contract, permissionIndex, identity, canEdit) {
      this.inputMappings = []
      const userIdentity = identity
      for (const [index, definition] of (contract?.sheets || []).entries()) {
        const sheet = this.workbook.getSheet(index)
        for (const mapping of definition.mappings || []) {
          const row = Number(mapping.row); const col = Number(mapping.col)
          const rowCount = Math.max(1, Number(mapping.rowCount) || 1); const colCount = Math.max(1, Number(mapping.colCount) || 1)
          if (!Number.isFinite(row) || !Number.isFinite(col)) continue
          const inputRow = row + (mapping.kind === 'table' ? 1 : 0)
          const inputRowCount = Math.max(0, rowCount - (mapping.kind === 'table' ? 1 : 0))
          const fixedRecordInput = mapping.kind === 'table' && permissionIndex?.sheets?.[index]?.editableRanges?.some(range =>
            range.row === inputRow && range.col === col && range.rowCount === inputRowCount && range.colCount === colCount)
          const editable = canEdit && this.room?.status === 'open' && permissionIndex?.sheets?.[index]
            && cellPermission(permissionIndex.sheets[index], inputRow, col, userIdentity).editable
          if (mapping.kind === 'table') sheet.getRange(row, col, 1, colCount).locked(true)
          if (inputRowCount > 0) sheet.getRange(inputRow, col, inputRowCount, colCount).locked(!editable || (mapping.kind === 'table' && !fixedRecordInput))
          if ((mapping.kind === 'input' || fixedRecordInput) && mapping.primary && mapping.permission === 'primary_input') {
            if (permissionIndex?.sheets?.[index] && cellPermission(permissionIndex.sheets[index], inputRow, col, userIdentity).visibility !== 'visible') continue
            this.inputMappings.push({ ...mapping, key: `${index}:${mapping.namedArea}`, sheetIndex: index,
              row: inputRow, col, rowCount: inputRowCount, colCount,
              displayName: mapping.displayName || mapping.fieldName || mapping.fieldCode })
          }
        }
      }
      if (!this.inputMappings.some(mapping => mapping.key === this.selectedInput)) this.selectedInput = this.inputMappings[0]?.key || ''
    },
    applyLocalProtection() {
      for (let index = 0; index < this.workbook.getSheetCount(); index += 1) {
        const sheet = this.workbook.getSheet(index)
        sheet.options.protectionOptions = { allowSelectLockedCells: true, allowSelectUnlockedCells: true, allowFilter: false, allowSort: false,
          allowResizeRows: false, allowResizeColumns: false, allowEditObjects: false, allowDragInsertRows: false, allowDragInsertColumns: false,
          allowInsertRows: false, allowInsertColumns: false, allowDeleteRows: false, allowDeleteColumns: false, allowOutlineColumns: false,
          allowOutlineRows: false }
        sheet.options.isProtected = true
        sheet.options.allowUserZoom = true
      }
      this.workbook.options.allowUserZoom = true
      this.workbook.options.allowUserDragDrop = false
      this.workbook.options.allowContextMenu = false
      this.workbook.options.allowDragHeaderToMove = GC.Spread.Sheets.AllowDragHeaderToMove.none
    },
    columnLabel(column) { let value = column + 1; let label = ''; while (value) { const digit = (value - 1) % 26; label = String.fromCharCode(65 + digit) + label; value = Math.floor((value - 1) / 26) } return label },
    hasValue(mapping) {
      const sheet = this.workbook?.getSheet(mapping.sheetIndex)
      if (!sheet) return false
      const value = readBoundValue(sheet, mapping)
      return value !== null && value !== undefined && String(value).trim() !== ''
    },
    refreshInputValues() {
      this.inputValues = Object.fromEntries(this.inputMappings.map(mapping => [mapping.key, this.hasValue(mapping)]))
      this.validateCurrentValues()
    },
    validateCurrentValues() {
      const entries = (this.templateContract?.sheets || []).flatMap((sheet, sheetIndex) => {
        const worksheet = this.workbook?.getSheet(sheetIndex)
        return (sheet.mappings || []).map(mapping => ({
          ...mapping, dataType: this.fieldDefinitions.find(field => Number(field.id) === Number(mapping.fieldDefinitionId))?.type, precision: this.fieldDefinitions.find(field => Number(field.id) === Number(mapping.fieldDefinitionId))?.precision,
          calculated: Boolean(worksheet?.getFormula(mapping.row, mapping.col)),
          value: readBoundValue(worksheet, mapping)
        }))
      })
      const native = this.workbook ? validateNativeCells(this.workbook, (s,row,col) => {
        const rules = this.permissionIndex?.sheets?.[s]
        return !rules || cellPermission(rules,row,col,this.permissionIdentity).visibility === 'visible'
      }) : { errors: [], hints: [] }
      this.localValidationErrors = [...validateFillingValues(entries, this.validationRules), ...native.errors]
      this.nativeValidationHints = native.hints
      this.submissionValidationReport = { schemaVersion: 1, collaborationVersion: Number(this.room?.currentVersion),
        checkedCount: native.checkedCount || 0, skippedCount: native.skippedCount || 0,
        issues: [...this.localValidationErrors.map(i => ({ ...i, severity: 'error' })), ...native.hints.map(i => ({ ...i, severity: 'warning' }))] }
    },
    selectInput(mapping) { this.selectedInput = mapping.key; this.locateInput() },
    locateInput() {
      const mapping = this.inputMappings.find(item => item.key === this.selectedInput)
      if (!mapping || !this.workbook) return
      this.workbook.setActiveSheetIndex(mapping.sheetIndex)
      const sheet = this.workbook.getSheet(mapping.sheetIndex)
      sheet.setActiveCell(mapping.row, mapping.col)
      sheet.showCell(mapping.row, mapping.col, GC.Spread.Sheets.VerticalPosition.center, GC.Spread.Sheets.HorizontalPosition.center)
    },
    findNext() {
      const searchString = this.findText.trim()
      if (!searchString || !this.workbook) return
      const condition = new GC.Spread.Sheets.Search.SearchCondition()
      condition.searchString = searchString
      condition.searchOrder = GC.Spread.Sheets.Search.SearchOrder.zOrder
      condition.searchTarget = GC.Spread.Sheets.Search.SearchFoundFlags.cellText
      condition.searchFlags = GC.Spread.Sheets.Search.SearchFlags.ignoreCase
      condition.startSheetIndex = 0; condition.endSheetIndex = this.workbook.getSheetCount() - 1
      const sheet = this.workbook.getActiveSheet()
      condition.rowStart = sheet.getActiveRowIndex(); condition.columnStart = sheet.getActiveColumnIndex() + 1
      let result = null
      let wrapped = false
      const maximum = (this.permissionIndex?.sheets || []).reduce((total, item) => total + item.rowCount * item.columnCount, 0)
      for (let attempt = 0; attempt <= maximum; attempt += 1) {
        result = this.workbook.search(condition)
        if (!result || result.searchFoundFlag === GC.Spread.Sheets.Search.SearchFoundFlags.none) {
          if (wrapped) break
          wrapped = true; condition.startSheetIndex = 0; condition.rowStart = 0; condition.columnStart = 0
          continue
        }
        const rules = this.permissionIndex?.sheets?.[result.foundSheetIndex]
        if (!rules || cellPermission(rules, result.foundRowIndex, result.foundColumnIndex, this.permissionIdentity).visibility === 'visible') break
        condition.startSheetIndex = result.foundSheetIndex
        condition.rowStart = result.foundRowIndex
        condition.columnStart = result.foundColumnIndex + 1
      }
      if (!result || result.searchFoundFlag === GC.Spread.Sheets.Search.SearchFoundFlags.none) { this.$message.info('没有找到匹配内容'); return }
      this.workbook.setActiveSheetIndex(result.foundSheetIndex)
      const foundSheet = this.workbook.getActiveSheet()
      foundSheet.setActiveCell(result.foundRowIndex, result.foundColumnIndex)
      foundSheet.showCell(result.foundRowIndex, result.foundColumnIndex, GC.Spread.Sheets.VerticalPosition.center, GC.Spread.Sheets.HorizontalPosition.center)
    },
    setZoom(value) { this.workbook?.getActiveSheet().zoom(Number(value) / 100) },
    calculationValue(item) { return item?.complete ? Number(item.value).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : `历史不完整（${item?.monthsAvailable || 0}/${item?.monthsExpected || 0}月）` },
    queuePrecheck() {
      if (this.precheckTimer) window.clearTimeout(this.precheckTimer)
      this.precheckTimer = window.setTimeout(this.refreshProgress, 900)
    },
    async refreshProgress() {
      this.precheckTimer = null
      if (this.loading) return
      try { const response = await collaborationApi.getMonthlyTask(this.taskId); this.progress = response.progress; this.room = response.room
        this.fieldDefinitions = response.fieldDefinitions || []; this.validationRules = response.validationRules || []; this.precheck = response.precheck || response.progress?.precheck || null; this.calculations = response.calculations || this.calculations
        this.applyAnomalyHighlights(this.precheck?.warnings || this.anomalies)
        if (this.sharedDoc && !this.businessChangesBound && response.room.currentVersion > 0) {
          await this.loadTask()
        }
      }
      catch { /* Keep the last known room state while the browser reconnects. */ }
    },
    async submitTask() {
      this.validateCurrentValues()
      if (!this.canSubmit || this.submissionBusy) return
      try { await this.$confirm('提交后将冻结本期协作工作簿，并创建不可变业务修订。请确认预检结果和数据无误。', '提交本期数据', { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '继续填报' }) }
      catch { return }
        this.validateCurrentValues()
      if (!this.canSubmit || this.submissionBusy) return
      this.submissionBusy = true
      this.submissionIdempotencyKey ||= globalThis.crypto?.randomUUID?.() || `submit-${this.currentUserId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      try {
        const result = await collaborationApi.submitTask(this.taskId, { expectedVersion: Number(this.room.currentVersion), pendingChanges: this.pendingChangeSets,
          validationReport: this.submissionValidationReport,
          warningExplanations: this.warningGroups.map(group => ({ ruleVersionId: group.ruleVersionId, ruleCode: group.ruleCode,
            explanation: String(this.warningExplanations[group.key] || '').trim() })) }, this.submissionIdempotencyKey)
        this.submissionIdempotencyKey = null
        this.task.status = 'submitted'; this.room.status = 'closed'
        this.$message.success(`提交成功，业务修订 ${result.revisionNumber} 已生成。`); if (returnToWorkflow(this)) return
        await this.loadTask()
      } catch (error) { this.errorText = error.message }
      finally { this.submissionBusy = false }
    },
    async withdrawTask() {
      this.lifecycleBusy = true
      try {
        await collaborationApi.withdrawTask(this.taskId, this.withdrawReason)
        this.$message.success('已撤回；新的草稿修订已从本次提交创建。'); if (returnToWorkflow(this)) return
        await this.loadTask()
      } catch (error) { this.$message.error(error.message) }
      finally { this.lifecycleBusy = false }
    },
    async saveOpinion(disposition) {
      this.lifecycleBusy = true
      try {
        const result = await collaborationApi.saveReviewOpinion(this.taskId, { reviewItemKey: 'monthly:submission',
          expectedVersion: this.reviewItemVersion, disposition, opinion: this.reviewOpinion,
          remediationDeadline: this.remediationDeadline })
        this.reviewItemVersion = Number(result.reviewVersion || this.reviewItemVersion)
        this.$message.success(disposition === 'return' ? '已退回并创建新的更正草稿。' : '审核意见已保存，任务进入审核中。')
        await this.loadTask()
      } catch (error) { this.$message.error(error.message) }
      finally { this.lifecycleBusy = false }
    },
    async uploadEvidence(event) {
      const file = event.target.files?.[0]; event.target.value = ''
      if (!file) return
      this.evidenceBusy = true
      try {
        await collaborationApi.uploadEvidenceAttachment(this.taskId, file, this.evidenceIndicatorCode)

        this.$message.success('证据附件已上传并关联到当前修订。')
      } catch (error) { this.$message.error(error.message) }
      finally { this.evidenceBusy = false }
    },
    async downloadEvidence(attachment) {
      try {
        const blob = await collaborationApi.downloadEvidenceAttachment(this.taskId, attachment.id)
        const url = URL.createObjectURL(blob); const link = document.createElement('a')
        link.href = url; link.download = attachment.originalName; link.click(); URL.revokeObjectURL(url)
      } catch (error) { this.$message.error(error.message) }
    },
    formatBytes(value) { return Number(value) < 1024 * 1024 ? `${Math.ceil(Number(value) / 1024)} KB` : `${(Number(value) / (1024 * 1024)).toFixed(1)} MB` },
    scanStatusLabel(value) { return ({ pending: '待外部扫描', clean: '扫描通过', rejected: '扫描拒绝', error: '扫描器错误' })[value] || '扫描状态未知' },
    async setAnomalyDisposition(anomaly, disposition) {
      this.anomalyBusyId = anomaly.id
      try {
        await collaborationApi.saveAnomalyDisposition(this.taskId, anomaly.id, disposition)
        anomaly.disposition = disposition
        anomaly.reviewerName = JSON.parse(localStorage.getItem('userInfo') || '{}').name || '已记录'
        this.$message.success(disposition === 'accepted' ? '已接受异常说明。' : '已要求补正异常说明。')
      } catch (error) { this.$message.error(error.message) }
      finally { this.anomalyBusyId = null }
    },
    anomalyDispositionLabel(disposition) { return ({ accepted: '已接受', correction_requested: '要求补正' })[disposition] || '待审核' },
    displayEvidence(value) { return value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value) },
    applyAnomalyHighlights(issues) {
      if (!this.workbook) return
      const definitions = this.templateContract?.sheets || []
      for (const issue of issues || []) {
        if (issue.row == null || issue.column == null || !Number.isInteger(Number(issue.row)) || !Number.isInteger(Number(issue.column))) continue
        const sheetIndex = definitions.findIndex(sheet => sheet.code === issue.sheetCode)
        const sheet = sheetIndex >= 0 ? this.workbook.getSheet(sheetIndex) : this.workbook.getActiveSheet()
        if (!sheet) continue
        // Highlight only colors; replacing Style would reset locks and mask formatters.
        sheet.getCell(Number(issue.row), Number(issue.column)).backColor('#FFF1C2').foreColor('#704E14')
      }
    },
    eventLabel(type) { return ({ submitted: '已提交', reviewing: '审核开始', returned: '已退回', withdrawn: '已撤回', draft_created: '创建草稿', resubmitted: '重新提交' })[type] || type },
    dependencyStatusLabel(status) { return ({ finalized: '当前有效定稿', superseded: '已被替代', task_missing: '缺少月报任务', revision_pending: '尚未定稿', ambiguous_tasks: '存在多个来源任务' })[status] || status },
    quarterlyValue(value) { return value == null ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) },
    taskStatusLabel(status) { return ({ draft: '草稿', submitted: '已提交', reviewing: '审核中', returned: '已退回', finalized: '已定稿' })[status] || status || '草稿' },
    openTask(id) { this.$router.push({ path: '/portal/monthly-filling', query: { ...this.$route.query, taskId: id } }) },
    backToQueue() { if (!returnToWorkflow(this)) this.$router.push('/portal/workflow-center?view=todo') },
    formatDate(value) { if (!value) return '未设置'; const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) },
    taskStatusLabel(status) { return ({ draft: '填报中', submitted: '已提交', reviewing: '审核中', finalized: '已定稿', cancelled: '已取消' })[status] || '填报中' },
    taskStatusType(status) { return ({ draft: 'success', submitted: 'info', reviewing: 'warning', finalized: 'success', cancelled: 'info' })[status] || 'info' },
    avatarColor(index) { return ['#347c73', '#8c6948', '#6372a4', '#a25342'][index % 4] },
    observeWorkbookSize() {
      this.workbookResizeObserver = markRaw(new ResizeObserver(() => {
        if (this.workbookResizeFrame != null) window.cancelAnimationFrame(this.workbookResizeFrame)
        this.workbookResizeFrame = window.requestAnimationFrame(() => {
          this.workbookResizeFrame = null
          if (this.workbook && this.$refs.spreadHost?.clientHeight > 0) this.workbook.refresh()
        })
      }))
      this.workbookResizeObserver.observe(this.$refs.spreadHost)
    },
    cleanup() {
      this.signatureDialog = false; this.signatureTarget = null
      this.roomLoadGeneration++
      this.workbookResizeObserver?.disconnect()
      this.workbookResizeObserver = null
      if (this.workbookResizeFrame != null) window.cancelAnimationFrame(this.workbookResizeFrame)
      this.workbookResizeFrame = null
      if (this.refreshTimer) window.clearInterval(this.refreshTimer)
      if (this.precheckTimer) window.clearTimeout(this.precheckTimer)
      this.refreshTimer = null; this.precheckTimer = null
      try { this.presence?.destroy() } catch {}
      try { this.sharedDoc?.destroy() } catch {}
      try { this.connection?.close() } catch {}
      try { this.connection?.destroy() } catch {}
      if (this.workbook) disposeAuxiliaryData(this.workbook)
      try { this.workbook?.destroy() } catch {}
      this.presence = null; this.connection = null; this.sharedDoc = null; this.workbook = null; this.ready = false
      this.permissionIndex = null; this.permissionIdentity = null
      this.businessChangesBound = false; this.pendingChangeSets = 0
    }
  }
}
</script>

<style scoped>
.workbench-header { position:relative }
.collaboration-header-actions { position:absolute;right:0;top:16px;display:flex;align-items:center;gap:12px }
@media(max-width:800px) { .collaboration-header-actions { position:static;justify-content:flex-end } }
.collaborator-avatars { display:flex;align-items:center;border:0;background:transparent;cursor:pointer;gap:3px;padding:4px }
.collaborator-avatars .avatar { width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:white;font-size:13px }
.collaborator-avatars .overflow-avatar { background:#596981 }
.edit-history-list { max-height:240px;overflow:auto;font-size:12px }
.edit-history-list article { padding:8px 0;border-bottom:1px solid #e4e9ed }
.edit-history-list p { color:#66758b;margin:4px 0 }

.submission-guidance { display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 9px 14px; background: var(--portal-paper, #f4f8ff); border-bottom: 1px solid var(--line); font-size: 12px; line-height: 1.6; color: var(--portal-muted, #52657c); }
.submission-guidance strong { color: var(--portal-blue, #1677d2); }
.queue-header, .workbench-header { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
.queue-header { display: flex; justify-content: space-between; align-items: center; gap: 24px; }
.eyebrow { display: block; margin-bottom: 6px; font-size: 12px; font-weight: 600; letter-spacing: .06em; color: var(--portal-primary); }
.queue-header p { margin-top: 8px; color: var(--muted); }
.queue-total { display: grid; text-align: right; color: var(--muted); white-space: nowrap; }
.queue-total strong { color: var(--portal-primary); font-size: 28px; }
.queue-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; font-weight: 600; }
.task-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.task-card { min-width: 0; padding: 20px; border: 1px solid var(--line); }
.task-card-top, .task-card-meta, .task-card-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.task-period { color: var(--portal-primary); font-weight: 600; }
.task-card h2 { margin: 14px 0 6px; }
.task-type, .task-card-meta, .task-card-footer > span { color: var(--muted); font-size: 12px; }
.task-card-meta { flex-wrap: wrap; margin-top: 16px; }
.task-card-footer { flex-wrap: wrap; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
.task-card-footer > div { display: flex; flex-wrap: wrap; gap: 8px; }
.task-card-footer .el-button { margin-left: 0; }
.workbench-titleline { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.title-divider { padding: 0 12px; color: #c0c4cc; }
.header-context { display: flex; flex-wrap: wrap; gap: 12px 24px; margin: 16px 0 0 44px; color: var(--muted); font-size: 12px; }
.header-context small { margin-right: 8px; font-size: inherit; color: #909399; }
.workbench-layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; align-items: start; }
.sheet-panel { display: flex; flex-direction: column; min-width: 0; height: clamp(600px, calc(100vh - 230px), 850px); overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
.sheet-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border-bottom: 1px solid var(--line); }
.sheet-tools, .sheet-toolbar-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.sheet-toolbar .el-button { margin-left: 0; }
.find-control { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: #fff; border: 1px solid var(--line); border-radius: 4px; }
.find-control input { width: 130px; border: none; outline: none; font: inherit; }
.find-control:focus-within { border-color: var(--portal-primary); }
.locate-select { width: 160px; }
.zoom-control { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.zoom-control .el-slider { width: 90px; }
.zoom-control b { min-width: 36px; font-weight: 500; }
.spread-host { position: absolute; inset: 0; width: 100%; height: 100%; }
.sheet-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 10px 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.sheet-foot > span { display: inline-flex; align-items: center; gap: 6px; }
.legend-input, .legend-readonly { width: 9px; height: 9px; border-radius: 2px; background: #941966; }
.legend-readonly { background: #c0c4cc; }
.foot-right { margin-left: auto; }
.context-rail { min-width: 0; max-height: calc(100vh - 230px); overflow-y: auto; padding-right: 4px; }
.rail-card { margin-bottom: 12px; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
.rail-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.progress-total { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-top: 12px; color: var(--muted); }
.progress-total strong { font-size: 26px; color: var(--portal-primary); }
.progress-total .el-progress { flex-basis: 100%; }
.validation-line { display: flex; align-items: center; gap: 6px; margin-top: 10px; color: #e6a23c; font-size: 12px; }
.validation-line.valid { color: #529b2e; }
.validation-line i, .online-count i, .online-dot, .connection-pill i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.input-list { margin-top: 12px; }
.input-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 0; text-align: left; border: 0; border-top: 1px solid var(--line); background: #fff; color: var(--ink); cursor: pointer; }
.input-row:hover { background: #f8ebf3; }
.input-row > span:nth-child(2) { min-width: 0; flex: 1; }
.input-row b, .input-row small { display: block; overflow-wrap: anywhere; }
.input-row b { font-size: 12px; }
.input-row small, .input-value { font-size: 12px; color: var(--muted); }
.input-state { color: #909399; }
.input-state.done { color: #529b2e; }
.collaborator { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.avatar { display: grid; place-items: center; width: 32px; height: 32px; flex-shrink: 0; border-radius: 50%; color: #fff; }
.collaborator b, .collaborator small { display: block; font-size: 12px; }
.collaborator small { color: var(--muted); }
.online-count, .connection-pill { display: inline-flex; align-items: center; gap: 6px; color: #909399; font-size: 12px; }
.online-count, .online-dot, .connection-pill.connected { color: #529b2e; }
.online-dot { margin-left: auto; }
.edit-meta { display: grid; gap: 4px; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 12px; }
.edit-meta span, .edit-meta small, .empty-hint, .rail-note { color: var(--muted); font-size: 12px; }
.empty-hint { padding: 12px 0; }
.rail-note { padding: 12px; line-height: 1.7; }
.rail-note p { margin: 8px 0; }
.queue-loading, .loading-panel { padding: 40px; text-align: center; color: var(--muted); }
.error-banner { margin: 12px 0; padding: 12px 16px; border: 1px solid #fde2e2; border-radius: 4px; background: #fef0f0; color: #f56c6c; }
.adjustment-dialog-hint { margin-bottom: 16px; color: var(--muted); }
.adjustment-fields { display: grid; margin-bottom: 16px; }
@media (max-width: 1200px) {
  .workbench-layout { grid-template-columns: minmax(0, 1fr) 300px; }
  .sheet-tools .el-divider { display: none; }
}
@media (max-width: 900px) {
  .task-grid, .workbench-layout { grid-template-columns: 1fr; }
  .queue-header { align-items: flex-start; }
  .context-rail { max-height: none; overflow: visible; }
  .header-context { margin-left: 0; }
}
.rule-hint{display:block;margin:-2px 0 10px;color:#929e97;font-size:12px}.targets-block{background:#f7faf8;border:1px solid #e8efeb;border-radius:5px;padding:8px 9px;margin:8px 0}.targets-block>span,.calculation-block>span{font-size:12px;color:#7c8982}.targets-block>div{display:flex;justify-content:space-between;margin-top:6px;font-size:12px}.targets-block b{font-weight:600}.targets-block strong{font-weight:600;color:#2b6c62}.threshold-snapshot{background:#faf8f2;border:1px solid #eee5d5;border-radius:5px;padding:8px 9px;margin:8px 0}.threshold-snapshot>span{font-size:12px;color:#89724f}.threshold-snapshot>div{display:flex;justify-content:space-between;gap:8px;margin-top:6px;font-size:12px}.threshold-snapshot b{font-weight:500;color:#657168}.threshold-snapshot strong{font-weight:600;color:#755d35}.precheck-block,.calculation-block{padding:8px 9px;margin:8px 0;border:1px solid #e8efeb;border-radius:5px;background:#fff}.precheck-heading,.precheck-counts{display:flex;align-items:center;justify-content:space-between;gap:7px}.precheck-heading{font-size:12px}.precheck-counts{justify-content:flex-start;flex-wrap:wrap;margin-top:7px;color:#6c7972;font-size:12px}.precheck-counts strong{color:#263d35}.precheck-counts small{margin-left:auto;color:#9aa49e;font-size:12px}.precheck-issues{margin:7px 0 0;padding-left:14px;color:#7b6750;font-size:12px;line-height:1.5}.precheck-issues .blocking{color:#a84439}.precheck-issues .warning{color:#94713c}.calculation-row{display:grid;gap:4px;margin-top:10px;font-size:12px;color:#657168}.calculation-row>span{display:flex;flex-wrap:wrap;gap:3px}.calculation-row strong{color:#2b6c62;font-weight:600}.calculation-row small{color:#819188;font-size:12px}.calculation-block>small{display:block;margin-top:7px;color:#9aa49e;font-size:12px;line-height:1.4}
.quarterly-dependencies{margin-bottom:12px;border-color:#dce8df;background:linear-gradient(145deg,#fbfdf9,#f4f8f2)}.dependency-gate{margin:8px 0;color:#748277;font-size:12px;line-height:1.5}.dependency-periods{display:grid;gap:4px}.dependency-period{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:9px;padding:7px 0;border-top:1px solid #e8eee7}.dependency-period>span:first-child b,.dependency-period>span:first-child small{display:block}.dependency-period>span:first-child b{font-size:12px;color:#394d40}.dependency-period>span:first-child small,.dependency-value small,.dependency-revision{font-size:12px;color:#89968b}.dependency-value{display:grid;text-align:right;font-size:12px;color:#395f49}.dependency-value small{text-align:right}.dependency-revision{grid-column:1/-1;margin-top:-7px}.quarter-totals{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}.quarter-totals>div{display:grid;gap:4px;padding:8px;background:#fff;border:1px solid #e5ede4;border-radius:5px}.quarter-totals span,.indicator-list-title{font-size:12px;color:#818d82}.quarter-totals b{font-size:12px;color:#386148}.dependency-missing{display:block;margin-top:9px;color:#a06d30;font-size:12px;line-height:1.5}.quarter-indicator-list{display:grid;gap:6px;margin-top:10px;padding-top:9px;border-top:1px solid #e1eade}.quarter-indicator-list>div{display:grid;gap:3px}.quarter-indicator-list>div b{font-size:12px;color:#3a4e40}.quarter-indicator-list>div small{font:12px ui-monospace,monospace;color:#8b968c;overflow-wrap:anywhere}
.view-disclosure{margin:0;padding:7px 12px;background:#f5f8f6;color:#64766f;font-size:12px;line-height:1.5}
.spread-frame{position:relative;min-height:0;flex:1}.submission-overlay{position:absolute;inset:0;z-index:20;display:grid;place-items:center;background:rgba(255,255,255,.46);backdrop-filter:blur(1px);color:#52645b;font-size:13px;cursor:wait}
.evidence-card{margin-top:16px;padding:16px;border:1px solid #e7ece9;border-radius:12px;background:#fff}.evidence-upload{display:grid;gap:8px;margin:12px 0}.evidence-upload small,.evidence-item small{color:#78847e;font-size:12px;line-height:1.5}.evidence-file-button{display:block;padding:9px 12px;border:1px solid #cbd8d0;border-radius:8px;color:#176b4b;text-align:center;font-size:12px;cursor:pointer}.evidence-file-button.disabled{opacity:.6;cursor:wait}.evidence-file-button input{display:none}.evidence-list{display:grid;gap:7px}.evidence-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 0;border-top:1px solid #edf1ee}.evidence-item>div{min-width:0;display:grid;gap:3px}.evidence-item b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#273b31}.evidence-item small{display:block}
.warning-explanations{margin-top:8px;padding-top:8px;border-top:1px solid #f0dfbd}.warning-explanations h3{margin:0;color:#765323;font-size:12px}.warning-explanation-hint{margin:4px 0 8px;color:#8a785b;font-size:12px;line-height:1.5}.warning-explanation-group{padding:7px 0;border-top:1px solid #f5ead7}.warning-explanation-group>b{display:block;color:#765323;font-size:12px}.warning-explanation-group>p{margin:4px 0;color:#7c6850;font-size:12px;line-height:1.45}.warning-explanation-group :deep(.el-textarea__inner){font-size:12px}.anomaly-review-card{margin-bottom:12px}.anomaly-review-item{padding:9px 0;border-top:1px solid #e8efeb}.anomaly-review-heading{display:flex;align-items:center;justify-content:space-between;gap:7px}.anomaly-review-heading>b{font-size:12px;color:#32463c}.anomaly-review-item>p{margin:6px 0;color:#725d3c;font-size:12px;line-height:1.5}.anomaly-review-item blockquote{margin:5px 0;padding:6px 8px;background:#f6f8f6;border-left:2px solid #c5d6cb;color:#5e6c63;font-size:12px;white-space:pre-wrap}.anomaly-review-item>small{display:block;color:#87948d;font-size:12px;line-height:1.5;overflow-wrap:anywhere}.anomaly-review-actions{display:flex;gap:6px;margin-top:8px}.anomaly-review-actions .el-button{margin:0}
.lifecycle-card,.lifecycle-action{margin-bottom:12px}.timeline-list{display:grid;gap:12px;margin-top:13px}.timeline-event{display:grid;grid-template-columns:9px 1fr;gap:9px;position:relative}.timeline-dot{width:7px;height:7px;margin-top:4px;border-radius:50%;background:#778b80}.timeline-dot.returned{background:#c17b32}.timeline-dot.withdrawn{background:#6d82a1}.timeline-dot.resubmitted,.timeline-dot.submitted{background:#2b8a72}.timeline-event b,.timeline-event span,.timeline-event small{display:block}.timeline-event b{font-size:12px;color:#32463c}.timeline-event b small{display:inline;font-weight:500;color:#7c8982}.timeline-event span,.timeline-event small{margin-top:3px;color:#87948d;font-size:12px}.timeline-event p{margin:5px 0 0;color:#66766e;font-size:12px;line-height:1.5;white-space:pre-wrap}.lifecycle-action h2{margin:5px 0;font-size:13px}.lifecycle-action p{margin:0 0 9px;color:#74827a;font-size:12px;line-height:1.5}.lifecycle-action :deep(.el-date-editor){width:100%;margin-top:8px}.lifecycle-action>.el-button{width:100%;margin:9px 0 0}.review-buttons{display:grid;gap:7px;margin-top:8px}.review-buttons .el-button{margin:0}
</style>
