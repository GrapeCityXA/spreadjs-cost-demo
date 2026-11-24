<template>
  <main class="catalog-page field-catalog-page portal-workbench" :class="{ 'field-table-view': tableView }">
    <header class="page-heading">
      <div>
        <h1>业务字段目录</h1>
        <p>{{ showcase ? '字段是业务口径的字典；模板中的单元格绑定字段后，填报数据按字段存储。' : '系统管理员创建字段后直接生效；其他人员提交提案，批准后生效。审批在流程中心办理，只有已批准字段可用于发布模板。' }}</p>
      </div>
      <div class="heading-actions">
        <el-button :loading="loading" @click="refresh">刷新</el-button>
        <el-button type="primary" :disabled="accessDenied" @click="openNew">{{ showcase ? '新建字段' : '新建字段提案' }}</el-button>
      </div>
    </header>

    <section v-if="!showcase" class="summary-row">
      <div><span>已批准字段</span><strong>{{ catalog.loaded ? fields.length : '—' }}</strong><small v-if="catalog.error">{{ catalog.loaded ? '数据未更新' : '读取失败' }}</small></div>
      <div><span>待审批提案</span><strong>{{ draftList.loaded ? pendingCount : '—' }}</strong><small v-if="draftList.error">{{ draftList.loaded ? '数据未更新' : '读取失败' }}</small></div>
      <div class="summary-note"><details><summary>字段存储说明</summary><p>字段审批不会创建业务数据库列；结构化值写入通用 typed value 模型。</p></details></div>
    </section>

    <div v-for="entry in readErrors" :key="entry.key" class="field-read-error" role="alert"><p>{{ entry.state.error }}<span v-if="entry.state.loaded"> 当前显示上次成功读取的数据。</span></p><el-button :loading="entry.state.loading" @click="retryList(entry.key)">重试{{ entry.label }}</el-button></div>
    <p v-if="loading" class="field-read-status" role="status">正在读取字段目录与提案…</p>
    <el-alert v-if="$route.query.draftId" title="正在查看提醒对应的字段提案" type="info" @close="clearDraftFilter" />
    <el-tabs v-model="activeTab" class="catalog-tabs" :class="{ 'showcase-catalog': showcase }">
      <el-tab-pane label="已批准字段" name="catalog">
        <div v-if="catalog.loaded" class="field-view-tools"><span>筛选和排序可在完整表格中操作。</span><el-button :aria-pressed="tableView" @click="tableView = !tableView">{{ tableView ? '切换字段列表' : '切换完整表格' }}</el-button></div>
        <app-data-table v-if="catalog.loaded" accessible table-label="已批准业务字段" class="field-catalog-table" :data="fields" row-key="id" empty-text="暂无符合条件的已批准字段">
          <template #compact="{ rows, total }">
            <div class="field-compact"><p class="field-list-count" role="status">符合条件的字段：{{ total }} 项</p>
              <ul v-if="rows.length" class="field-items" aria-label="已批准字段列表">
                <li v-for="row in rows" :key="row.id" class="field-item">
                  <div class="field-item-heading"><h3>{{ row.displayName }}</h3><span v-if="!showcase" class="field-item-badge">V{{ row.version }}</span></div>
                  <p class="field-item-code">{{ row.code }}</p>
                  <p class="field-item-meta">{{ typeLabel(row.type) }} · {{ row.unit || '无单位' }}</p>
                  <details><summary>字段属性<span class="field-sr-only">：{{ row.displayName }}</span></summary><dl class="field-item-facts"><dt>精度</dt><dd>{{ row.precision }} 位</dd><dt>编辑方式</dt><dd>{{ row.editable ? '可编辑' : '只读' }}</dd><dt>适用范围</dt><dd>{{ applicabilityLabel(row.applicability) }}</dd></dl></details>
                  <div v-if="isAdmin && !showcase" class="field-item-actions"><el-button :disabled="accessDenied" :aria-label="`查看版本：${row.displayName}`" @click="openVersions(row)">查看版本</el-button><el-button :disabled="accessDenied" :aria-label="`提出新版本：${row.displayName}`" @click="openSupersede(row)">提出新版本</el-button></div>
                </li>
              </ul><el-empty v-else description="暂无符合条件的已批准字段" />
            </div>
          </template>
          <el-table-column prop="code" label="字段编码" min-width="170" />
          <el-table-column prop="displayName" label="中文名称" min-width="150"><template #default="{ row }"><strong class="field-name">{{ row.displayName }}</strong></template></el-table-column>
          <el-table-column :column-value="row => typeLabel(row.type) + ' · ' + (row.unit || '无单位')" label="类型 / 单位" min-width="170"><template #default="{ row }">{{ typeLabel(row.type) }}<small class="subline">{{ row.unit || '无单位' }}</small></template></el-table-column>
          <el-table-column :column-value="row => row.precision + ' 位 · ' + (row.editable ? '可编辑' : '只读')" label="精度 / 编辑" min-width="135"><template #default="{ row }">{{ row.precision }} 位<small class="subline">{{ row.editable ? '可编辑' : '只读' }}</small></template></el-table-column>
          <el-table-column v-if="!showcase" :column-value="row => row.version" label="版本" width="100"><template #default="{ row }"><span class="field-item-badge">V{{ row.version }}</span></template></el-table-column>
          <el-table-column :column-value="row => applicabilityLabel(row.applicability)" label="适用范围" min-width="190"><template #default="{ row }">{{ applicabilityLabel(row.applicability) }}</template></el-table-column>
          <el-table-column v-if="isAdmin && !showcase" label="操作" width="180" fixed="right"><template #default="{ row }"><el-button link type="primary" :disabled="accessDenied" :aria-label="`查看版本：${row.displayName}`" @click="openVersions(row)">版本</el-button><el-button link type="primary" :disabled="accessDenied" :aria-label="`提出新版本：${row.displayName}`" @click="openSupersede(row)">提出新版本</el-button></template></el-table-column>
        </app-data-table>
      </el-tab-pane>

      <el-tab-pane label="字段提案" name="drafts">
        <div v-if="draftList.loaded" class="field-view-tools"><span>筛选和排序可在完整表格中操作。</span><el-button :aria-pressed="tableView" @click="tableView = !tableView">{{ tableView ? '切换提案列表' : '切换完整表格' }}</el-button></div>
        <p v-if="draftList.loaded && $route.query.draftId && !visibleDrafts.length" class="field-read-status" role="status">未找到此提醒对应的提案，或当前账号无权查看。可关闭上方提醒筛选，查看可访问的提案。</p>
        <app-data-table v-if="draftList.loaded" :key="String($route.query.draftId || 'all')" accessible table-label="业务字段提案" class="field-drafts-table" :data="visibleDrafts" row-key="id" empty-text="暂无符合条件的字段提案">
          <template #compact="{ rows, total }">
            <div class="field-compact"><p class="field-list-count" role="status">符合条件的提案：{{ total }} 项</p>
              <ul v-if="rows.length" class="field-items" aria-label="字段提案列表">
                <li v-for="row in rows" :key="row.id" class="field-item">
                  <div class="field-item-heading"><h3>{{ row.proposal.displayName }}</h3><el-tag :type="statusType(row.status)" effect="plain">{{ statusLabel(row.status) }}</el-tag></div>
                  <p class="field-item-code">{{ row.code }}</p><p class="field-item-meta">{{ typeLabel(row.proposal.type) }} · {{ row.proposal.unit || '无单位' }}</p>
                  <dl class="field-item-facts"><dt>提出人</dt><dd>{{ row.creatorName }}<small>{{ row.creatorUsername }}</small></dd><dt>审核意见</dt><dd>{{ row.reviewNote }}</dd></dl>
                  <div v-if="canEdit(row) || (isSystemAdmin && $route.query.workflowFrom && row.status === 'pending')" class="field-item-actions">
                    <el-button v-if="canEdit(row)" :disabled="accessDenied || reviewing" :aria-label="`修正提案：${row.proposal.displayName}`" @click="openEdit(row)">修正</el-button>
                    <template v-if="isSystemAdmin && $route.query.workflowFrom && row.status === 'pending'"><el-button type="primary" :disabled="accessDenied || reviewing" :aria-label="`批准提案：${row.proposal.displayName}`" @click="approve(row)">批准</el-button><el-button :disabled="accessDenied || reviewing" :aria-label="`驳回提案：${row.proposal.displayName}`" @click="reject(row)">驳回</el-button></template>
                  </div>
                </li>
              </ul><el-empty v-else description="暂无符合条件的字段提案" />
            </div>
          </template>
          <el-table-column prop="code" label="字段编码" min-width="160" />
          <el-table-column :column-value="row => row.proposal.displayName" label="提案字段" min-width="210"><template #default="{ row }"><strong>{{ row.proposal.displayName }}</strong><small class="subline">{{ typeLabel(row.proposal.type) }} · {{ row.proposal.unit || '无单位' }}</small></template></el-table-column>
          <el-table-column :column-value="row => row.creatorName" label="提出人" min-width="145"><template #default="{ row }">{{ row.creatorName }}<small class="subline">{{ row.creatorUsername }}</small></template></el-table-column>
          <el-table-column :column-value="row => statusLabel(row.status)" label="状态" width="110"><template #default="{ row }"><el-tag :type="statusType(row.status)" effect="plain">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
          <el-table-column prop="reviewNote" label="审核意见" min-width="180" />
          <el-table-column label="操作" min-width="220" fixed="right"><template #default="{ row }">
            <el-button v-if="canEdit(row)" link type="primary" :disabled="accessDenied || reviewing" :aria-label="`修正提案：${row.proposal.displayName}`" @click="openEdit(row)">修正</el-button>
            <template v-if="isSystemAdmin && $route.query.workflowFrom && row.status === 'pending'">
              <el-button link type="success" :disabled="accessDenied || reviewing" :aria-label="`批准提案：${row.proposal.displayName}`" @click="approve(row)">批准</el-button>
              <el-button link type="danger" :disabled="accessDenied || reviewing" :aria-label="`驳回提案：${row.proposal.displayName}`" @click="reject(row)">驳回</el-button>
            </template>
          </template></el-table-column>
        </app-data-table>
        <div class="tab-note">草稿和驳回的提案不会出现在已批准目录中。驳回后，提出人可以修正并重新提交。</div>
      </el-tab-pane>
    </el-tabs>

    <field-proposal-dialog ref="fieldProposal" :is-system-admin="isSystemAdmin" @saved="onFieldSaved" />

    <el-dialog v-model="versionsOpen" class="field-versions-dialog" :class="{ 'field-table-view': versionTableView }" :title="`${versionField?.displayName || ''} · 版本历史`" width="min(760px, calc(100vw - 32px))" @close="closeVersions">
      <p v-if="versionList.loading" class="field-read-status" role="status">正在读取此字段的版本历史…</p>
      <div v-if="versionList.error" class="field-read-error" role="alert"><p>{{ versionList.error }}</p><el-button :loading="versionList.loading" @click="retryVersions">重试版本历史</el-button></div>
      <div v-if="versionList.loaded" class="field-view-tools"><span>筛选和排序可在完整表格中操作。</span><el-button :aria-pressed="versionTableView" @click="versionTableView = !versionTableView">{{ versionTableView ? '切换版本列表' : '切换完整表格' }}</el-button></div>
      <app-data-table v-if="versionList.loaded" :key="versionField.id" accessible :table-label="`${versionField.displayName}的版本历史`" class="field-versions-table" :data="versions" row-key="version" empty-text="暂无版本记录">
        <template #compact="{ rows, total }"><div class="field-compact"><p class="field-list-count" role="status">符合条件的版本：{{ total }} 项</p>
          <ul v-if="rows.length" class="field-items" aria-label="字段版本列表"><li v-for="row in rows" :key="row.version" class="field-item">
            <div class="field-item-heading"><h3>{{ row.snapshot.displayName }}</h3><span class="field-item-badge">V{{ row.version }}</span></div>
            <p class="field-item-code">{{ row.snapshot.code }}</p><p class="field-item-meta">{{ typeLabel(row.snapshot.type) }} · {{ row.snapshot.unit || '无单位' }}</p>
            <dl class="field-item-facts"><dt>提出人</dt><dd>{{ row.creatorName }}</dd><dt>批准人</dt><dd>{{ row.approverName }}</dd><dt>批准时间</dt><dd>{{ formatDate(row.approvedAt) }}</dd></dl>
          </li></ul><el-empty v-else description="暂无符合条件的版本记录" />
        </div></template>
        <el-table-column :column-value="row => row.version" prop="version" label="版本" width="85"><template #default="{ row }">V{{ row.version }}</template></el-table-column>
        <el-table-column :column-value="row => row.snapshot.displayName" label="字段定义" min-width="280"><template #default="{ row }"><strong>{{ row.snapshot.displayName }}</strong><small class="subline">{{ row.snapshot.code }} · {{ typeLabel(row.snapshot.type) }} · {{ row.snapshot.unit || '无单位' }}</small></template></el-table-column>
        <el-table-column :column-value="row => row.creatorName" prop="creatorName" label="提出人" min-width="120" />
        <el-table-column prop="approverName" label="批准人" min-width="120" />
        <el-table-column prop="approvedAt" label="批准时间" min-width="170"><template #default="{ row }">{{ formatDate(row.approvedAt) }}</template></el-table-column>
      </app-data-table>
    </el-dialog>
  </main>
</template>

<script>
import { returnToWorkflow } from '@/utils/workflowNavigation'
import { fieldCatalogApi } from '../api'
import FieldProposalDialog from '@/components/FieldProposalDialog.vue'

import { fieldProposalTypes as fieldTypes } from '@/components/fieldProposalState'
import { emptyFieldList, createFieldReader } from '@/utils/fieldCatalogState'
import { formatWorkflowDate } from '@/utils/workflowRequest'
import { SHOWCASE } from '@/config/showcase'

export default {
  name: 'FieldCatalog',
  components: { FieldProposalDialog },
  beforeRouteLeave() { return this.$refs.fieldProposal?.canLeave() ?? true },
  data() {
    return { showcase: SHOWCASE, activeTab: 'catalog', catalog: emptyFieldList(), draftList: emptyFieldList(), versionList: emptyFieldList(),
      versionsOpen: false, versionField: null, fieldTypes, reviewing: false, tableView: false, versionTableView: false,
      userId: null, roles: [] }
  },
  computed: {
    fields() { return this.catalog.rows },
    drafts() { return this.draftList.rows },
    versions() { return this.versionList.rows },
    loading() { return this.catalog.loading || this.draftList.loading },
    accessDenied() { return this.catalog.denied || this.draftList.denied },
    readErrors() { return [{ key: 'catalog', label: '字段目录', state: this.catalog }, { key: 'drafts', label: '字段提案', state: this.draftList }].filter(entry => entry.state.error) },
    visibleDrafts() { return this.$route.query.draftId ? this.drafts.filter(row => row.id === Number(this.$route.query.draftId)) : this.drafts },
    isSystemAdmin() { return this.roles.some(role => role.code === 'system_admin') },
    isAdmin() { return this.roles.some(role => ['system_admin', 'data_administrator'].includes(role.code)) },
    pendingCount() { return this.drafts.filter(draft => draft.status === 'pending').length }
  },
  created() {
    this._catalogReader = createFieldReader(this.catalog, { request: signal => fieldCatalogApi.getCatalog(signal), kind: 'catalog', onDenied: () => this.closeVersions() })
    this._draftReader = createFieldReader(this.draftList, { request: signal => fieldCatalogApi.getDrafts(signal), kind: 'drafts', onDenied: () => this.closeVersions() })
  },
  mounted() {
    if (this.$route.query.draftId) this.activeTab = 'drafts'
    try {
      const user = JSON.parse(localStorage.getItem('userInfo') || '{}')
      this.userId = Number(user.id)
      this.roles = Array.isArray(user.roles) ? user.roles.filter(role => role && typeof role.code === 'string') : []
    } catch {}
    this.refresh()
    if (this.$route.query.start === 'new') this.openNew()
  },
  beforeUnmount() { this._disposed = true; this._catalogReader.dispose(); this._draftReader.dispose(); this._versionReader?.dispose() },
  watch: { '$route.query.draftId'(value) { if (value) this.activeTab = 'drafts'; this.refresh() } },
  methods: {
    refresh() { return Promise.all([this._catalogReader.run(), this._draftReader.run()]) },
    retryList(key) { return (key === 'catalog' ? this._catalogReader : this._draftReader).run() },
    clearDraftFilter() { const { draftId, ...query } = this.$route.query; this.$router.replace({ query }) },
    formatDate(value) { return value === '—' ? '—' : formatWorkflowDate(value) },
    typeLabel(type) { return fieldTypes.find(item => item.value === type)?.label || type },
    statusLabel(status) { return ({ pending: '待审批', approved: '已批准', rejected: '已驳回' })[status] || status },
    statusType(status) { return ({ pending: 'warning', approved: 'success', rejected: 'danger' })[status] || 'info' },
    applicabilityLabel(value) { return Object.keys(value || {}).length ? JSON.stringify(value) : '全部适用' },
    canEdit(row) { return Number(row.createdBy) === this.userId && ['pending', 'rejected'].includes(row.status) },
    openNew() { if (!this.accessDenied) this.$refs.fieldProposal.open() },
    openEdit(draft) { if (!this.accessDenied && !this.reviewing && this.canEdit(draft)) this.$refs.fieldProposal.open(draft.proposal, draft) },
    openSupersede(field) { if (!this.accessDenied && this.isAdmin) this.$refs.fieldProposal.open(field, { supersedesFieldId: field.id }) },
    async onFieldSaved(result) {
      this.activeTab = result.status === 'approved' ? 'catalog' : 'drafts'
      await this.refresh()
    },
    async approve(draft) {
      if (this.reviewing || this.accessDenied || !this.isSystemAdmin || !this.$route.query.workflowFrom || draft.status !== 'pending') return
      this.reviewing = true
      try {
        await this.$confirm(`批准字段「${draft.proposal.displayName}」并加入已批准目录？`, '批准字段提案', { type: 'warning' })
        if (this._disposed) return
        await fieldCatalogApi.approveDraft(draft.id)
        if (this._disposed) return
        this.$message.success('字段已批准'); if (returnToWorkflow(this)) return
        await this.refresh()
      } catch (error) { if (!this._disposed && error !== 'cancel' && error !== 'close') this.$message.error(error.message || '批准结果未确认，请刷新提案状态后再操作。') }
      finally { this.reviewing = false }
    },
    async reject(draft) {
      if (this.reviewing || this.accessDenied || !this.isSystemAdmin || !this.$route.query.workflowFrom || draft.status !== 'pending') return
      this.reviewing = true
      try {
        const { value } = await this.$prompt('请说明驳回原因，提出人可据此修正。', '驳回字段提案', { inputPlaceholder: '填写审核意见', inputValidator: value => Boolean(value?.trim()) || '请填写驳回原因' })
        if (this._disposed) return
        await fieldCatalogApi.rejectDraft(draft.id, value)
        if (this._disposed) return
        this.$message.success('字段提案已驳回'); if (returnToWorkflow(this)) return
        await this.refresh()
      } catch (error) { if (!this._disposed && error !== 'cancel' && error !== 'close') this.$message.error(error.message || '驳回结果未确认，请刷新提案状态后再操作。') }
      finally { this.reviewing = false }
    },
    openVersions(field) {
      if (this.accessDenied || !this.isAdmin) return
      this._versionReader?.dispose()
      this.versionList = emptyFieldList()
      this.versionField = field
      this.versionTableView = false
      this.versionsOpen = true
      this._versionReader = createFieldReader(this.versionList, { request: signal => fieldCatalogApi.getVersions(field.id, signal), kind: 'versions' })
      return this._versionReader.run()
    },
    retryVersions() { if (this.versionsOpen && this.versionField) return this.openVersions(this.versionField) },
    closeVersions() { this._versionReader?.dispose(); this._versionReader = null; this.versionsOpen = false; this.versionList = emptyFieldList() }
  }
}
</script>

<style scoped>
.page-heading { display:flex; justify-content:space-between; }
h1 { margin:0 0 8px; }
.page-heading p { margin:0; max-width:72ch; }
.heading-actions { display:flex; }
.summary-row { display:grid; grid-template-columns:180px 180px minmax(0,1fr); margin-bottom:24px; border:1px solid var(--portal-line); }
.summary-row>div { padding:12px 16px; border-right:1px solid var(--portal-line); }
.summary-row>div:last-child { border:0; }
.summary-row span { display:block; color:var(--portal-muted); font-size:14px; }
.summary-row strong { display:block; margin-top:4px; color:var(--portal-ink); font-size:20px; font-weight:600; font-variant-numeric:tabular-nums; }
.summary-row .summary-note { align-self:center; color:var(--portal-muted); font-size:14px; }
.catalog-tabs { border:1px solid var(--portal-line); padding:0 16px 16px; }
.showcase-catalog :deep(.el-tabs__header) { display:none; }
.showcase-catalog { padding-top:14px; }
.catalog-tabs :deep(.el-tabs__item) { height:52px; }
.subline { display:block; margin-top:4px; color:var(--portal-muted,#6d5a65); font-size:14px; }
.tab-note { margin:16px 0 0; color:var(--portal-muted); font-size:14px; }
@media(max-width:850px) { .page-heading{align-items:flex-start;flex-direction:column}.catalog-tabs{padding:0 12px 12px} }
</style>
<style src="../styles/field-catalog-hardening.css"></style>
<style src="../styles/field-catalog-adaptation.css"></style>
<style src="../styles/field-catalog-polish.css"></style>
