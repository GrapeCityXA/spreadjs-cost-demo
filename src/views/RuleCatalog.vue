<template>
  <main class="rules-page portal-workbench">
    <header class="page-heading">
      <div>
        <h1>业务规则与公式</h1>
        <p v-if="activeTab !== 'formula'">可视化配置单元格校验、异常预警，或编写与测试 SpreadJS 自定义公式。</p>
      </div>
      <div v-if="activeTab !== 'formula'" class="heading-actions">
        <el-button :loading="loading" @click="refresh">刷新</el-button>
        <el-button v-if="isAdmin" type="primary" @click="openNew">新建规则</el-button>
      </div>
    </header>

    <section v-if="activeTab !== 'formula'" class="summary-row">
      <div><span>已发布版本</span><strong>{{ catalogLoaded ? publishedCount : '—' }}</strong></div>
      <div><span>待复核</span><strong>{{ catalogLoaded ? pendingCount : '—' }}</strong></div>
      <div><span>默认受治理规则</span><strong>{{ catalogLoaded ? seededCount : '—' }}</strong></div>
      <p>已发布规则保留版本记录，新版本不会改变已有任务。</p>
    </section>

    <div v-if="catalogError" class="catalog-feedback" role="alert"><p>{{ catalogError }}{{ catalogLoaded ? ' 当前显示上次成功读取的数据。' : '' }}</p><el-button :loading="loading" @click="refresh">重试读取</el-button></div>
    <p v-if="loading" role="status">正在读取规则目录…</p>
    <el-alert v-if="reviewError" :title="reviewError" type="error" :closable="false" />
    <el-alert v-if="$route.query.notificationVersionId" title="正在查看提醒对应的规则版本" type="info" @close="clearNotificationFilter" />
    <p v-if="activeTab !== 'formula'" class="rule-scroll-hint">点击规则名称查看详情；横向滑动表格可查看其余列和操作。</p>
    <el-tabs v-model="activeTab" class="rules-tabs" :before-leave="beforeTabLeave">
      <el-tab-pane label="全部版本" name="all">
        <app-data-table class="rule-catalog-table" :data="$route.query.notificationVersionId ? rules.filter(row => row.versionId === Number($route.query.notificationVersionId)) : rules" v-loading="loading" row-key="versionId" :empty-text="catalogEmptyText">
          <el-table-column :column-value="row => row.displayName" label="规则" min-width="240"><template #default="{ row }"><button type="button" class="rule-name-link" @click="openDetails(row)">{{ row.displayName }}</button><small class="subline">{{ row.code }} · {{ scopeLabel(row.scope) }}</small></template></el-table-column>
          <el-table-column :column-value="row => typeLabel(row.ruleType) + ' · ' + severityLabel(row.severity)" label="类别 / 严重级别" min-width="208"><template #default="{ row }">{{ typeLabel(row.ruleType) }}<small class="subline">{{ severityLabel(row.severity) }}</small></template></el-table-column>
          <el-table-column :column-value="row => row.version" label="版本" width="144"><template #default="{ row }"><el-tag effect="plain">V{{ row.version }}</el-tag><el-tag v-if="row.seeded" class="seed-tag" size="small" type="info">内置</el-tag></template></el-table-column>
          <el-table-column :column-value="row => statusLabel(row.status)" label="状态" width="144"><template #default="{ row }"><el-tag :type="statusType(row.status)" effect="plain">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
          <el-table-column :column-value="row => row.testCases.length" label="测试" width="144"><template #default="{ row }">{{ row.expression?.engine === 'spreadjs-function' ? '序列化验证' : `${row.testCases.length} 例` }}<small class="subline">{{ row.testedAt ? '已运行' : '未运行' }}</small></template></el-table-column>
          <el-table-column :column-value="row => (row.creatorName || (row.seeded ? '平台内置' : '未知')) + ' · ' + (row.reviewerName || (row.status === 'published' ? '管理员免审 / 内置' : '尚未审批'))" label="创建 / 复核" min-width="184"><template #default="{ row }">{{ row.creatorName || (row.seeded ? '平台内置' : '未知') }}<small class="subline">{{ row.reviewerName || (row.status === 'published' ? '管理员免审 / 内置' : '尚未审批') }}</small></template></el-table-column>
          <el-table-column label="操作" min-width="220" fixed="right"><template #default="{ row }">
            <el-button link type="primary" @click="openDetails(row)">详情</el-button>
            <el-button v-if="isAdmin && ['draft','rejected'].includes(row.status) && Number(row.createdBy) === userId" link type="primary" @click="openEdit(row)">编辑 / 测试</el-button>
            <el-button v-if="isAdmin && row.status === 'published' && isLatest(row)" link type="primary" @click="openSupersede(row)">提出新版本</el-button>
            <el-button v-if="canPublish(row)" :disabled="reviewPending !== null" link type="success" @click="publish(row)">复核并发布</el-button>
            <el-button v-if="canPublish(row)" :disabled="reviewPending !== null" link type="danger" @click="reject(row)">驳回</el-button>
          </template></el-table-column>
        </app-data-table>
      </el-tab-pane>
      <el-tab-pane label="异常规则" name="anomaly"><app-data-table class="rule-catalog-table" :data="byType('anomaly')" row-key="versionId" :empty-text="loading || catalogError ? catalogEmptyText : '暂无异常规则'"><el-table-column prop="displayName" label="名称" min-width="220"><template #default="{ row }"><button type="button" class="rule-name-link" @click="openDetails(row)">{{ row.displayName }}</button></template></el-table-column><el-table-column prop="code" label="编码" min-width="220"/><el-table-column :column-value="row => scopeLabel(row.scope) + ' · ' + severityLabel(row.severity)" label="范围 / 严重级别" min-width="208"><template #default="{ row }">{{ scopeLabel(row.scope) }} · {{ severityLabel(row.severity) }}</template></el-table-column><el-table-column :column-value="row => 'V' + row.version + ' · ' + statusLabel(row.status)" label="版本 / 状态" min-width="184"><template #default="{ row }">V{{ row.version }} · {{ statusLabel(row.status) }}</template></el-table-column><el-table-column label="操作" min-width="240"><template #default="{ row }"><el-button link type="primary" @click="openDetails(row)">详情</el-button><el-button v-if="canPublish(row)" :disabled="reviewPending !== null" link type="success" @click="publish(row)">复核并发布</el-button></template></el-table-column></app-data-table></el-tab-pane>
      <el-tab-pane label="自定义公式" name="formula" lazy><FunctionCatalog v-if="activeTab === 'formula'" ref="functionCatalog" :key="sessionToken" :rules="rules" :catalog-ready="catalogLoaded && !loading" :can-manage="isAdmin" :is-system-admin="isReviewer" :user-id="userId" @refresh="refresh" /></el-tab-pane>
    </el-tabs>

    <el-dialog class="rule-catalog-dialog rule-editor-dialog" v-model="formOpen" :title="formTitle" width="min(1100px, 95vw)" top="4vh" destroy-on-close :before-close="requestEditorClose">

      <el-alert v-if="editorError" :title="editorError" type="error" :closable="false" class="editor-feedback" />
      <p v-if="editorBusy" role="status">{{ editorBusyLabel }}，请稍候。</p>
      <el-form :model="form" :disabled="editorBusy || writeUncertain" :aria-busy="editorBusy" label-position="top" class="rule-form">
        <el-form-item label="规则编码" required :error="formErrors.code"><el-input v-model="form.code" :disabled="Boolean(form.ruleId)" maxlength="64" placeholder="例如 REVENUE_COMPLETION" /></el-form-item>
        <el-form-item label="中文名称" required :error="formErrors.displayName"><el-input v-model="form.displayName" :disabled="Boolean(form.ruleId)" maxlength="120" placeholder="例如：收入完成率" /></el-form-item>
        <el-form-item label="规则类型"><el-select v-model="form.ruleType" :disabled="Boolean(form.ruleId)" @change="onTypeChange"><el-option label="校验规则" value="validation"/><el-option label="异常规则" value="anomaly"/><el-option v-if="form.ruleId && form.ruleType === 'formula'" label="历史业务公式" value="formula"/></el-select></el-form-item>
        <el-form-item label="适用范围"><el-select v-model="form.scope" :disabled="form.ruleType !== 'validation' || form.native"><el-option v-for="option in scopeOptions" :key="option.value" :label="option.label" :value="option.value"/></el-select></el-form-item>
        <el-form-item v-if="!form.native" label="严重级别"><el-select v-model="form.severity" :disabled="form.ruleType === 'formula'"><el-option label="阻断错误" value="blocking"/><el-option label="警告" value="warning"/><el-option label="提示" value="info"/></el-select></el-form-item>
        <el-form-item label="说明" class="full-row"><el-input v-model="form.description" type="textarea" :rows="2" maxlength="2000" show-word-limit/></el-form-item>
        <div class="full-row" :inert="editorBusy || writeUncertain"><NativeValidatorEditor v-if="form.native" ref="nativeEditor" :key="editorKey" :expression="form.expression" :test-cases="form.testCases" @changed="invalidateTests"/><BusinessRuleEditor v-else ref="businessEditor" :key="editorKey" :initial-expression="form.expression" :initial-parameters="form.parameters" :test-cases="form.testCases" @changed="invalidateTests"/></div>
      </el-form>
      <div v-if="testResults.length" class="test-results"><strong>最近一次测试</strong><el-tag :type="lastTestPassed ? 'success' : 'danger'">{{ lastTestPassed ? '全部通过' : '存在差异' }}</el-tag><div v-for="result in testResults" :key="result.name" class="test-row"><span>{{ result.name }}</span><code>预期 {{ valueText(result.expected) }} · 实际 {{ valueText(result.actual) }}{{ result.error ? ` · ${result.error}` : '' }}</code><el-tag size="small" :type="result.passed ? 'success' : 'danger'">{{ result.passed ? '通过' : '失败' }}</el-tag></div></div>
      <template #footer><el-button :disabled="editorBusy" @click="requestEditorClose()">取消</el-button><el-button :loading="saving" :disabled="editorBusy || writeUncertain" @click="saveDraft">保存草稿</el-button><el-button type="primary" plain :loading="testing" :disabled="editorBusy || writeUncertain" @click="runTests">运行测试</el-button><el-button type="primary" :loading="submitting" :disabled="editorBusy || writeUncertain || !currentVersionId || !lastTestPassed" @click="submitForReview">{{ isReviewer ? '提交发布' : '提交复核' }}</el-button></template>
    </el-dialog>

    <el-dialog class="rule-catalog-dialog rule-details-dialog" v-model="detailsOpen" :title="`${detailRule?.displayName || ''} · V${detailRule?.version || ''}`" width="min(780px, 95vw)">
      <dl v-if="detailRule" class="rule-facts">
        <div><dt>规则编码</dt><dd>{{ detailRule.code }}</dd></div>
        <div><dt>状态</dt><dd>{{ statusLabel(detailRule.status) }}</dd></div>
        <div><dt>适用范围</dt><dd>{{ scopeLabel(detailRule.scope) }}</dd></div>
        <div><dt>严重级别</dt><dd>{{ severityLabel(detailRule.severity) }}</dd></div>
        <div><dt>创建人</dt><dd>{{ detailRule.creatorName || '平台内置' }}</dd></div>
        <div><dt>复核人</dt><dd>{{ detailRule.reviewerName || '尚未复核' }}</dd></div>
        <div class="full-row"><dt>说明</dt><dd>{{ detailRule.description || '无' }}</dd></div>
      </dl>
      <div v-if="detailRule" class="rule-detail-visual"><el-form disabled label-position="top"><NativeValidatorEditor v-if="detailRule.expression?.engine === 'spreadjs-validator'" :key="detailRule.versionId" :expression="detailRule.expression" :test-cases="detailRule.testCases"/><BusinessRuleEditor v-else :key="detailRule.versionId" :initial-expression="detailRule.expression" :initial-parameters="detailRule.parameters" :test-cases="detailRule.testCases"/></el-form></div>
      <el-alert v-if="previewResult !== null" class="preview-result" type="success" :closable="false" :title="`计算结果：${valueText(previewResult)}`"/>
      <template #footer><el-button v-if="detailRule?.status === 'published'" type="primary" plain @click="evaluateExample">试算样例</el-button><el-button v-if="detailRule" plain @click="openVersions(detailRule)">查看版本历史</el-button></template>
    </el-dialog>

    <el-dialog class="rule-catalog-dialog rule-versions-dialog" v-model="versionsOpen" :title="`${versionRule?.displayName || ''} · 版本历史`" width="min(800px, 95vw)"><app-data-table :data="versions" row-key="id"><el-table-column :column-value="row => row.version" label="版本" width="90"><template #default="{ row }">V{{ row.version }}</template></el-table-column><el-table-column :column-value="row => statusLabel(row.status)" prop="status" label="状态" width="120"><template #default="{ row }">{{ statusLabel(row.status) }}</template></el-table-column><el-table-column prop="creatorName" label="创建人"/><el-table-column prop="reviewerName" label="复核人"/><el-table-column prop="publishedAt" label="发布时间" min-width="180"/></app-data-table></el-dialog>
  </main>
</template>

<script>
import FunctionCatalog from '@/components/FunctionCatalog.vue'
import NativeValidatorEditor from '@/components/NativeValidatorEditor.vue'
import BusinessRuleEditor from '@/components/BusinessRuleEditor.vue'
import { isNativeRule, testNativeRule } from '@/template/nativeValidator'
import { returnToWorkflow } from '@/utils/workflowNavigation'
import { ruleCatalogApi } from '../api'
import { evaluateBusinessExpression } from '../utils/formulaEvaluator'
import { subscribeSessionUser } from '@/utils/authSession'
import { ruleTab, copyRuleData, normalizeRules, validateRuleIdentity, ruleFailure, ruleRequest } from '@/utils/ruleCatalogState'

const scopes = [
  { value: 'field', label: '字段级' }, { value: 'cross_field', label: '跨字段' },
  { value: 'cross_period', label: '跨期间' }, { value: 'aggregate', label: '汇总' },
  { value: 'anomaly', label: '异常' }, { value: 'business_formula', label: '业务公式' }
]
const blankForm = () => ({ ruleId: null, versionId: null, code: '', displayName: '', ruleType: 'validation', scope: 'field', severity: 'blocking', description: '', native: true, expression: null, parameters: {}, testCases: [] })

export default {
  name: 'RuleCatalog',
  components: { NativeValidatorEditor, BusinessRuleEditor, FunctionCatalog },
  data() {
    return { editorKey: 0, activeTab: this.$route.query.notificationVersionId ? 'all' : ruleTab(this.$route.query.section), rules: [], loading: false, saving: false, testing: false, submitting: false, formOpen: false, detailsOpen: false,
      disposed: false, catalogLoaded: false, catalogError: '', catalogRequest: 0, catalogController: null, unsubscribeSession: null, sessionToken: null,
      editorSession: 0, editorRevision: 0, editorReady: false, editorDirty: false, savedFingerprint: '', testedFingerprint: '', editorError: '', formErrors: {}, writeUncertain: false, closePromise: null,
      reviewPending: null, reviewError: '', versionsRequest: 0,
      versionsOpen: false, form: blankForm(), userId: 0, roles: [], testResults: [], lastTestPassed: false,
      detailRule: null, previewResult: null, versions: [], versionRule: null }
  },
  computed: {
    isAdmin() { return this.roles.some(role => ['system_admin', 'business_rule_administrator'].includes(role.code)) },
    isReviewer() { return this.roles.some(role => role.code === 'system_admin') },
    currentVersionId() { return this.form.versionId },
    editorBusy() { return this.saving || this.testing || this.submitting },
    editorBusyLabel() { return this.testing ? '正在保存并测试规则' : this.submitting ? '正在提交规则' : '正在保存草稿' },
    formContent() { const { ruleId, versionId, ...content } = this.form; return JSON.stringify(content) },
    catalogEmptyText() { return this.loading ? '正在读取规则目录…' : this.catalogError ? '规则目录读取失败，请重试' : this.$route.query.notificationVersionId ? '该提醒对应的规则版本已不可用或无权访问' : '暂无可访问的规则' },
    formTitle() { return this.form.versionId ? (this.form.ruleId ? '编辑规则草稿' : '新规则草稿') : '新建规则' },
    scopeOptions() { if(this.form.native) return [{value:'field',label:'单元格 / 区域'}]; return scopes.filter(scope => this.form.ruleType === 'validation' ? ['field', 'cross_field', 'cross_period', 'aggregate'].includes(scope.value) : this.form.ruleType === 'anomaly' ? scope.value === 'anomaly' : scope.value === 'business_formula') },
    publishedCount() { return this.rules.filter(rule => rule.status === 'published').length },
    pendingCount() { return this.rules.filter(rule => rule.status === 'pending_review').length },
    seededCount() { return this.rules.filter(rule => rule.seeded).length }
  },
  mounted() {
    this.unsubscribeSession = subscribeSessionUser(user => {
      const token = localStorage.getItem('token')
      this.userId = Number(user?.id) || 0
      this.roles = Array.isArray(user?.roles) ? user.roles.filter(role => role && typeof role.code === 'string') : []
      if (token === this.sessionToken) return
      this.sessionToken = token; this.editorSession++; this.editorReady = false; this.formOpen = false
      this.saving = false; this.testing = false; this.submitting = false; this.reviewPending = null
      this.rules = []; this.catalogLoaded = false; this.detailsOpen = false; this.versionsOpen = false
      this.refresh()
    })
    window.addEventListener('beforeunload', this.onBeforeUnload)
    if (this.$route.query.start === 'new' && this.isAdmin) this.openNew()
  },
  beforeUnmount() { this.disposed = true; this.editorSession++; this.catalogController?.abort(); this.unsubscribeSession?.(); window.removeEventListener('beforeunload', this.onBeforeUnload) },
  async beforeRouteLeave() { return this.allowEditorClose() },
  async beforeRouteUpdate(to, from) { if (to.fullPath === from.fullPath) return true; const allowed = await this.allowEditorClose(); if (allowed && this.formOpen) this.finishEditorClose(); return allowed },
  watch: {
    activeTab(value) { if (!this.$route.query.notificationVersionId) this.$router.replace({ query: { ...this.$route.query, section: value === 'formula' ? 'functions' : value } }) },
    '$route.query.section'(value) { this.activeTab = this.$route.query.notificationVersionId ? 'all' : ruleTab(value) },
    formContent: { flush: 'sync', handler() { if (this.editorReady && this.formOpen) this.invalidateTests() } },
    '$route.query.notificationVersionId'() { this.activeTab = this.$route.query.notificationVersionId ? 'all' : ruleTab(this.$route.query.section); this.refresh() }
  },
  methods: {
    async refresh() {
      const request = ++this.catalogRequest, token = localStorage.getItem('token')
      this.catalogController?.abort(); this.catalogController = new AbortController(); this.loading = true
      const current = () => !this.disposed && request === this.catalogRequest && token === localStorage.getItem('token')
      try {
        const rows = normalizeRules(await ruleRequest(signal => ruleCatalogApi.getCatalog(signal), { signal: this.catalogController.signal, timeoutMs: 15000 }))
        if (current()) { this.rules = rows; this.catalogLoaded = true; this.catalogError = '' }
      } catch (error) { if (current()) this.catalogError = ruleFailure(error).message }
      finally { if (current()) this.loading = false }
    },
    clearNotificationFilter() { const { notificationVersionId, ...query } = this.$route.query; this.$router.replace({ query }) },
    byType(type) { return this.rules.filter(rule => rule.ruleType === type) },
    typeLabel(type) { return ({ validation: '校验规则', anomaly: '异常规则', formula: '业务公式' })[type] || type },
    scopeLabel(scope) { return scopes.find(item => item.value === scope)?.label || scope },
    severityLabel(value) { return ({ blocking: '阻断', warning: '警告', info: '提示' })[value] || value },
    statusLabel(status) { return ({ draft: '草稿', pending_review: '待复核', published: '已发布', rejected: '已驳回', retired: '已停用' })[status] || status },
    statusType(status) { return ({ published: 'success', pending_review: 'warning', rejected: 'danger', draft: 'info' })[status] || 'info' },
    isLatest(row) { return !this.rules.some(other => other.ruleId === row.ruleId && other.version > row.version) },
    canPublish(row) { return this.isReviewer && this.$route.query.workflowFrom && row.status === 'pending_review' },
    valueText(value) { return value === undefined ? '无结果' : JSON.stringify(value) },
    onTypeChange(type) { this.form.native = type === 'validation'; this.form.expression = type === 'formula' ? { op: 'completion_rate', args: [{ field: 'actual' }, { field: 'target' }] } : { op: 'gte', args: [{ field: 'value' }, 0] }; this.form.testCases = []; this.editorKey++; this.invalidateTests(); this.form.scope = type === 'anomaly' ? 'anomaly' : type === 'formula' ? 'business_formula' : 'field'; this.form.severity = type === 'anomaly' ? 'warning' : type === 'formula' ? 'info' : 'blocking' },
    async beginEditor(form) {
      if (this.editorBusy || (this.formOpen && !await this.allowEditorClose())) return
      this.editorReady = false; const session = ++this.editorSession
      this.editorKey++; this.form = copyRuleData(form); this.formOpen = true
      this.editorRevision = 0; this.editorDirty = false; this.editorError = ''; this.formErrors = {}; this.writeUncertain = false
      this.lastTestPassed = false; this.testResults = []; this.testedFingerprint = ''
      await this.$nextTick()
      if (session !== this.editorSession || !this.formOpen || this.disposed) return
      this.savedFingerprint = this.editorFingerprint(); this.editorReady = true
    },
    openNew() { if (this.isAdmin) return this.beginEditor(blankForm()) },
    fromRow(row) { return { ruleId: row.ruleId, versionId: ['draft', 'rejected'].includes(row.status) ? row.versionId : null, code: row.code, displayName: row.displayName, ruleType: row.ruleType, scope: row.scope, severity: row.severity, description: row.description || '', native: isNativeRule(row.expression), expression: row.expression, parameters: row.parameters || {}, testCases: row.testCases || [] } },
    async openFunction(row, nextVersion = false) { this.activeTab = 'formula'; await this.$nextTick(); this.$refs.functionCatalog?.open(row, nextVersion) },
    openEdit(row) { if (row.expression?.engine === 'spreadjs-function') return this.openFunction(row); return this.beginEditor(this.fromRow(row)) },
    openSupersede(row) { if (row.expression?.engine === 'spreadjs-function') return this.openFunction(row, true); return this.beginEditor({ ...this.fromRow(row), versionId: null, ruleId: row.ruleId }) },
    editorFingerprint() { try { return JSON.stringify(this.payload()) } catch { return null } },
    invalidateTests() {
      if (!this.formOpen || !this.editorReady) return
      this.editorRevision++; this.lastTestPassed = false; this.testedFingerprint = ''; this.testResults = []
      const fingerprint = this.editorFingerprint()
      this.editorDirty = fingerprint === null || fingerprint !== this.savedFingerprint
      this.formErrors = {}
      if (this.editorError === '请先修正规则编码和名称。' && !Object.keys(validateRuleIdentity(this.form)).length) this.editorError = ''
    },
    onBeforeUnload(event) { if (this.formOpen && (this.editorDirty || this.editorBusy)) { event.preventDefault(); event.returnValue = '' } },
    async beforeTabLeave(next, previous) {
      if (previous !== 'formula' || next === previous) return true
      const catalog = this.$refs.functionCatalog
      if (catalog && !await catalog.allowLeave()) return false
      catalog?.finishClose()
      return true
    },
    async allowEditorClose() {
      if (this.$refs.functionCatalog && !await this.$refs.functionCatalog.allowLeave()) return false
      if (!this.formOpen) return true
      if (this.editorBusy) { this.$message.warning(`${this.editorBusyLabel}，请等待结果后再离开。`); return false }
      if (!this.editorDirty) return true
      if (this.closePromise) return this.closePromise
      const session = this.editorSession
      this.closePromise = this.$confirm('未保存的修改将丢失，是否放弃修改？', '离开规则编辑', { confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning', closeOnClickModal: false })
        .then(() => session === this.editorSession).catch(() => false)
      try { return await this.closePromise } finally { this.closePromise = null }
    },
    finishEditorClose() { this.editorSession++; this.editorReady = false; this.formOpen = false; this.editorDirty = false },
    async requestEditorClose(done) { if (await this.allowEditorClose()) { this.finishEditorClose(); if (typeof done === 'function') done() } },
    payload() { const data = this.form.native ? this.$refs.nativeEditor.getData() : this.$refs.businessEditor.getData(); return { ...data, code: this.form.code, displayName: this.form.displayName, ruleType: this.form.ruleType, scope: this.form.scope, severity: data.severity || this.form.severity, description: this.form.description } },
    captureEditor() {
      if (this.editorBusy || this.writeUncertain || !this.formOpen || !this.editorReady || !this.isAdmin) return null
      this.formErrors = validateRuleIdentity(this.form)
      if (Object.keys(this.formErrors).length) { this.editorError = '请先修正规则编码和名称。'; return null }
      try {
        const data = copyRuleData(this.payload())
        return { session: this.editorSession, revision: this.editorRevision, token: localStorage.getItem('token'), ruleId: this.form.ruleId, versionId: this.form.versionId, native: this.form.native, data, fingerprint: JSON.stringify(data) }
      } catch (error) { this.editorError = error.message || '请检查规则条件和测试样例。'; return null }
    },
    editorIsCurrent(context, includeRevision = false) {
      return !this.disposed && this.formOpen && context.session === this.editorSession && context.token === localStorage.getItem('token') && (!includeRevision || context.revision === this.editorRevision)
    },
    editorFailure(error, context, write = true) {
      if (!this.editorIsCurrent(context)) return
      const failure = ruleFailure(error, write)
      this.editorError = failure.message; this.writeUncertain = Boolean(failure.uncertain)
      this.lastTestPassed = false; this.testedFingerprint = ''
    },
    async ensureDraft(context) {
      const { data, ruleId, versionId } = context
      if (versionId) await ruleRequest(() => ruleCatalogApi.updateDraft(versionId, data))
      else {
        const created = await ruleRequest(() => ruleId ? ruleCatalogApi.createVersion(ruleId, data) : ruleCatalogApi.create(data))
        if (!Number.isSafeInteger(Number(created?.ruleId)) || !Number.isSafeInteger(Number(created?.versionId)) || Number(created.versionId) <= 0 || Number(created.ruleId) <= 0) throw new Error('保存结果缺少版本信息')
        context.ruleId = Number(created.ruleId); context.versionId = Number(created.versionId)
      }
      if (!this.editorIsCurrent(context)) return null
      this.form.ruleId = context.ruleId; this.form.versionId = context.versionId
      this.savedFingerprint = context.fingerprint
      this.editorDirty = this.editorFingerprint() !== context.fingerprint
      return context.versionId
    },
    async saveDraft() {
      const context = this.captureEditor(); if (!context) return
      this.saving = true; this.editorError = ''; this.lastTestPassed = false; this.testResults = []
      try {
        if (!await this.ensureDraft(context)) return
        this.$message.success(this.editorDirty ? '已保存此前的内容，当前修改尚未保存。' : '规则草稿已保存，请运行测试后提交。')
        await this.refresh()
      } catch (error) { this.editorFailure(error, context) }
      finally { if (context.session === this.editorSession) this.saving = false }
    },
    async runTests() {
      const context = this.captureEditor(); if (!context) return
      let testCases = context.data.testCases
      try {
        if (!Array.isArray(testCases) || !testCases.length) throw new Error('请至少添加一个测试样例。')
        if (context.native) {
          const local = testNativeRule(context.data.expression, testCases)
          if (local.some(result => result.error)) throw new Error(local.find(result => result.error).error)
          testCases = testCases.map((test, index) => ({ ...test, nativeActual: local[index].actual }))
        }
      } catch (error) { this.editorFailure(error, context, false); return }
      this.testing = true; this.editorError = ''; this.lastTestPassed = false; this.testResults = []
      try {
        const id = await this.ensureDraft(context)
        if (!id || !this.editorIsCurrent(context, true)) return
        const result = await ruleRequest(() => ruleCatalogApi.test(id, testCases))
        if (!this.editorIsCurrent(context, true) || this.editorFingerprint() !== context.fingerprint) return
        if (!Array.isArray(result?.results) || result.results.length !== testCases.length) throw Object.assign(new Error('测试结果不完整，请重新运行测试。'), { status: 422 })
        this.testResults = result.results.map((item, index) => {
          if (context.native) return item
          let parity = false
          try { parity = this.sameValue(item.actual, evaluateBusinessExpression(context.data.expression, context.data.testCases[index].input, context.data.parameters)) } catch {}
          return { ...item, passed: item.passed && parity, error: parity ? item.error : '浏览器与服务端结果不一致' }
        })
        this.lastTestPassed = result.passed === true && this.testResults.every(item => item.passed === true)
        this.testedFingerprint = this.lastTestPassed ? context.fingerprint : ''
        this.$message[this.lastTestPassed ? 'success' : 'warning'](this.lastTestPassed ? '规则测试全部通过' : '测试未通过，请检查条件与预期结果')
        await this.refresh()
      } catch (error) { this.editorFailure(error, context) }
      finally { if (context.session === this.editorSession) this.testing = false }
    },
    sameValue(left, right) { if (typeof left === 'number' && typeof right === 'number') return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right)); return JSON.stringify(left) === JSON.stringify(right) },
    async submitForReview() {
      const context = this.captureEditor(); if (!context) return
      if (!context.versionId || !this.lastTestPassed || context.fingerprint !== this.testedFingerprint) { this.invalidateTests(); this.editorError = '规则已变化，请重新运行测试后提交。'; return }
      this.submitting = true; this.editorError = ''
      try {
        const result = await ruleRequest(() => ruleCatalogApi.submit(context.versionId))
        if (!this.editorIsCurrent(context)) return
        this.submitting = false; this.finishEditorClose()
        this.$message.success(result.status === 'published' ? '规则已免审发布' : '规则已提交系统管理员审批')
        await this.refresh()
      } catch (error) { this.editorFailure(error, context) }
      finally { if (context.session === this.editorSession) this.submitting = false }
    },
    publish(row) { return this.reviewRule(row, 'publish') },
    reject(row) { return this.reviewRule(row, 'reject') },
    async reviewRule(row, action) {
      if (this.reviewPending !== null || !this.canPublish(row)) return
      const token = localStorage.getItem('token'), versionId = row.versionId
      const current = () => !this.disposed && token === localStorage.getItem('token')
      this.reviewPending = versionId; this.reviewError = ''
      try {
        const { value } = await this.$prompt(action === 'reject' ? '请填写驳回原因，创建者可据此修正。' : '复核说明（可选）', action === 'reject' ? '驳回规则版本' : '发布规则版本', {
          inputValidator: text => (String(text || '').length > 1000 ? '复核意见最多 1000 个字符' : action === 'reject' && !text?.trim() ? '请填写复核意见' : true)
        })
        if (!current()) return
        await ruleRequest(() => ruleCatalogApi[action](versionId, value?.trim() || ''))
        if (!current()) return
        this.$message.success(action === 'reject' ? '规则版本已驳回' : '规则版本已发布')
        if (!returnToWorkflow(this)) await this.refresh()
      } catch (error) { if (current() && !['cancel', 'close'].includes(error)) this.reviewError = ruleFailure(error, true).message }
      finally { if (current()) this.reviewPending = null }
    },
    async openDetails(row) { if (row.expression?.engine === 'spreadjs-function') return this.openFunction(row); this.detailRule = row; this.previewResult = null; this.detailsOpen = true },
    async openVersions(row) {
      const request = ++this.versionsRequest, token = localStorage.getItem('token')
      const current = () => !this.disposed && request === this.versionsRequest && token === localStorage.getItem('token') && this.detailsOpen && this.detailRule?.ruleId === row.ruleId
      try {
        const result = await ruleRequest(() => ruleCatalogApi.getVersions(row.ruleId))
        if (!current()) return
        if (!Array.isArray(result?.versions)) throw new Error('版本历史返回格式异常，请重试。')
        this.versionRule = row; this.versions = result.versions; this.versionsOpen = true
      } catch (error) { if (current()) this.$message.error(ruleFailure(error).message) }
    },
    async evaluateExample() { const first = this.detailRule?.testCases?.[0]; if (!first) return this.$message.warning('该版本没有测试样例'); try { if(isNativeRule(this.detailRule.expression)) { const result=testNativeRule(this.detailRule.expression,[first])[0]; if(result.error) throw new Error(result.error); this.previewResult=result.actual } else { const result = await ruleCatalogApi.evaluate(this.detailRule.versionId, first.input); this.previewResult = result.result } } catch (error) { this.$message.error(error.message || '试算失败') }
    }
  }
}
</script>

<style src="../styles/rule-catalog.css"></style>
