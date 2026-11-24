<template>
  <main class="workbench portal-workbench" :class="{ 'has-field-panel': fieldDrawer, 'has-inspector-panel': inspectorDrawer }">
    <header class="workbench-head">
      <div class="title-block">
        <el-button class="workbench-back" link :disabled="saving || submitting" @click="$router.push(isTemplateDesign ? '/portal/template?section=templates' : '/portal/template?section=components')"><el-icon aria-hidden="true"><ArrowLeft /></el-icon><span>返回模板与组件</span></el-button>
        <h1><span class="design-title" :title="form.name">{{ form.name || (isTemplateDesign ? '新建完整模板' : '新建组件') }}</span> <el-tag :type="statusType" effect="plain">{{ statusText }}</el-tag></h1>
      </div>
      <div class="head-actions">
        <div class="editor-actions" role="group" aria-label="编辑面板">
          <el-button ref="fieldPanelTrigger" :disabled="saving || submitting" :type="fieldDrawer ? 'primary' : 'default'" plain :aria-expanded="fieldDrawer" aria-controls="designer-field-panel" @click="toggleFieldDrawer">字段目录</el-button>
          <el-button ref="inspectorPanelTrigger" :disabled="saving || submitting" :type="inspectorDrawer ? 'primary' : 'default'" plain :aria-expanded="inspectorDrawer" aria-controls="designer-cell-panel" @click="toggleInspector">单元格属性</el-button>
          <input ref="xlsxInput" type="file" accept=".xlsx" hidden @change="importLocalWorkbook" />
          <el-select v-if="importSheets.length > 1" v-model="activeImportSheet" size="small" class="import-sheet-select" aria-label="切换导入的工作表" :disabled="!versionId || saving || submitting" @change="selectImportedSheet">
            <el-option v-for="sheet in importSheets" :key="sheet.index" :label="`${sheet.name} · ${sheet.savedVersionId ? '已保存草稿' : '草稿工作表'}`" :value="sheet.index" :disabled="Boolean(sheet.savedVersionId) && sheet.index !== activeImportSheet" />
          </el-select>
        </div>
        <div class="document-actions" role="group" aria-label="文档操作">
          <el-button :disabled="!designerReady || saving || submitting" :loading="pdfExporting" @click="previewPdf">预览 PDF</el-button>
          <el-button v-if="isDraft && canEdit" :loading="saving" :disabled="submitting || !designerReady" @click="saveDraft">保存草稿</el-button>
          <el-button v-if="isDraft && canEdit" type="primary" :loading="submitting" :disabled="saving || !designerReady" @click="submitDraft">{{ roles.some(role => role.code === 'system_admin') ? '提交发布' : '提交审核' }}</el-button>
        </div>
      </div>
    </header>

    <section class="component-bar" :inert="saving || submitting">
      <el-form inline class="meta-form">
        <el-form-item :label="isTemplateDesign ? '模板名称' : '组件名称'"><el-input v-model="form.name" :disabled="!canEdit || Boolean(component)" :placeholder="isTemplateDesign ? '例如：月度经营报表' : '例如：月报主体'" /></el-form-item>
        <el-form-item v-if="!isTemplateDesign" label="稳定编码"><el-input v-model="form.code" :disabled="!canEdit || Boolean(component)" placeholder="例如 monthly_body" /></el-form-item>
        <el-form-item v-if="!isTemplateDesign" label="区域"><el-select v-model="form.componentType" :disabled="!canEdit || Boolean(component)"><el-option label="Header 页眉" value="header" /><el-option label="Body 主体" value="body" /><el-option label="Footer 页脚" value="footer" /></el-select></el-form-item>
        <el-form-item v-if="isTemplateDesign" label="适用范围"><el-select v-model="templateFactory" filterable :disabled="!canEdit"><el-option label="全部组织" value="ALL" /><el-option v-for="org in templateOrganizations" :key="org.id" :label="org.name" :value="org.code" /></el-select></el-form-item>
      </el-form>
      <div class="owner">维护人：{{ directTemplate?.ownerName || component?.ownerName || currentUserName }}<span v-if="canEdit"> · 当前由你维护</span></div>
    </section>

    <section ref="studioGrid" class="studio-grid" :inert="saving || submitting" :aria-busy="saving || submitting">
      <aside ref="fieldPanel" v-show="fieldDrawer" id="designer-field-panel" class="side-panel field-panel" tabindex="-1" aria-label="字段目录">
        <div class="panel-heading"><h2>字段目录</h2><div class="panel-actions"><el-button class="return-to-canvas" text @click="showDesignPanel('canvasPanel')">返回画布</el-button><el-button text @click="loadCatalog" :loading="loading">刷新</el-button><el-button class="panel-close" text aria-label="关闭字段目录" @click="closeDesignPanel('fieldPanel')"><el-icon><Close /></el-icon></el-button></div></div>
        <el-input v-model="fieldSearch" aria-label="搜索字段名称或编码" placeholder="搜索字段名称或编码" clearable />
        <el-alert v-if="catalogError" :title="catalogError" type="error" :closable="false" show-icon><el-button link @click="loadCatalog" :loading="loading">重新加载目录</el-button></el-alert>
        <el-tabs v-model="fieldTab" class="field-tabs">
          <el-tab-pane label="已批准" name="approved" />
          <el-tab-pane :label="`草稿 ${drafts.length}`" name="drafts" />
          <el-tab-pane label="最近使用" name="recent" />
          <el-tab-pane label="自定义公式" name="formulas" />
        </el-tabs>
        <div class="field-list">
          <template v-if="fieldTab === 'approved'">
            <section v-for="group in groupedFields" :key="group.name" class="field-group">
              <h3>{{ group.name }} <small>{{ group.items.length }}</small></h3>
              <CatalogInsertButton v-for="field in group.items" :key="field.id" :disabled="!canEdit"
                :title="field.displayName" :glyph="fieldGlyph(field)" :description="[field.code, field.type, field.unit].filter(Boolean).join(' · ')" @select="injectField(field)" />
            </section>
            <el-empty v-if="!groupedFields.length" description="没有匹配的已批准字段" :image-size="64" />
          </template>
          <template v-else-if="fieldTab === 'drafts'">
            <div v-for="draft in filteredDrafts" :key="draft.id" class="field-card draft-card"><span class="field-glyph">草</span><span class="field-copy"><strong>{{ draft.proposal?.displayName || draft.code }}</strong><small>{{ draft.code }} · {{ draft.status === 'pending' ? '待审批' : '已驳回' }}</small></span><el-tag size="small" type="warning" effect="plain">不可映射</el-tag></div>
            <el-empty v-if="!filteredDrafts.length" description="暂无字段草稿" :image-size="64" />
          </template>
          <template v-else-if="fieldTab === 'formulas'">
            <CatalogInsertButton v-for="rule in filteredBusinessFormulas" :key="rule.versionId" class="formula-card" :disabled="!canEdit" :title="rule.displayName" :description="`${rule.code} · v${rule.version}`" glyph="ƒ" action="添加计算" tone="info" @select="injectFormula(rule)" />
            <el-empty v-if="!filteredBusinessFormulas.length" description="暂无已发布自定义公式" :image-size="64" />
          </template>
          <template v-else>
            <CatalogInsertButton v-for="field in recentFields" :key="field.id" :disabled="!canEdit" :title="field.displayName" :description="`${field.code} · ${field.type}`" :glyph="fieldGlyph(field)" @select="injectField(field)" />
            <el-empty v-if="!recentFields.length" description="从已批准目录添加字段后会显示在这里" :image-size="64" />
          </template>
        </div>
        <div class="insertion-target" :class="{ ready: selectedTargetCell }">
          <span class="target-mark">{{ selectedTargetCell ? '↳' : '◎' }}</span>
          <span><strong>{{ selectedTargetCell ? `目标 R${selectedTargetCell.row + 1}C${selectedTargetCell.col + 1}` : '先选择目标单元格' }}</strong><small>{{ selectedTargetCell ? '点击字段或公式即可添加到此处' : '在中间画布单击一个单元格' }}</small></span>
        </div>
        <el-button class="draft-create" plain @click="openFieldDraft">＋ 新建字段提案</el-button>
        <p class="panel-hint">草稿字段不会进入映射；批准后会自动出现在此目录。</p>
      </aside>

      <section ref="canvasPanel" class="canvas-panel" tabindex="-1" aria-label="设计画布">
        <div ref="designerFrame" class="designer-frame">
          <div ref="designerHost" class="designer-mount"></div>
          <div v-if="!canEdit" class="readonly-cover">此版本不能由当前用户编辑</div>
        </div>
        <div class="canvas-footer"><span><i class="dot approved-dot"></i>已批准字段映射</span><span><i class="dot calc-dot"></i>计算 / 系统字段</span><span><i class="dot issue-dot"></i>结构异常</span><span class="footer-spacer"></span><span>{{ mappings.length }} 个映射 · {{ occurrenceCount }} 处字段出现</span></div>
      </section>

      <aside ref="inspectorPanel" v-show="inspectorDrawer" id="designer-cell-panel" class="side-panel inspector-panel" tabindex="-1" aria-label="单元格属性">
        <div class="panel-heading"><h2>单元格属性</h2><div class="panel-actions"><el-button class="return-to-canvas" text @click="showDesignPanel('canvasPanel')">返回画布</el-button><el-button class="panel-close" text aria-label="关闭单元格属性" @click="closeDesignPanel('inspectorPanel')"><el-icon><Close /></el-icon></el-button></div></div>
        <el-breadcrumb separator="/" class="property-navigation" aria-label="单元格属性分类">
          <el-breadcrumb-item v-for="item in inspectorSections" :key="item.mode"><button type="button" :aria-current="inspectorMode === item.mode ? 'page' : undefined" :class="{ active: inspectorMode === item.mode }" @click="switchInspector(item.mode)">{{ item.label }}</button></el-breadcrumb-item>
        </el-breadcrumb>
        <div class="inspector-content">
          <div v-if="inspectorMode === 'all' && issues.length" class="mapping-health" :class="issues.length ? 'has-issues' : 'healthy'"><strong>{{ issues.length ? `${issues.length} 项结构问题` : '结构检查通过' }}</strong><small>{{ issues.length ? '保存前请检查下面的映射状态' : '未发现截断、重叠或悬空映射' }}</small></div>
          <div v-if="inspectorMode === 'all'" class="mapping-list">
            <button v-for="mapping in mappings" :key="mapping.id" class="mapping-row" :class="{ selected: selectedMapping?.id === mapping.id, invalid: mapping.issue }" @click="selectMapping(mapping)">
              <span class="mapping-mark">{{ mapping.kind === 'table' ? '▦' : mapping.kind === 'calc' ? 'ƒ' : '↳' }}</span><span class="mapping-copy"><strong>{{ mapping.displayName || mapping.fieldCode }}</strong><small>{{ mapping.fieldCode }} · {{ mapping.namedArea }}</small><small v-for="(occurrence, index) in mapping.occurrences" :key="`${occurrence.sheet}-${occurrence.row}-${occurrence.col}-${index}`">{{ occurrence.sheet }} · R{{ occurrence.row + 1 }}C{{ occurrence.col + 1 }} · {{ occurrence.rowCount }}×{{ occurrence.colCount }}</small></span><el-tag v-if="mapping.issue" size="small" type="danger">异常</el-tag>
            </button>
            <el-empty v-if="!mappings.length" description="选择画布单元格后，从左侧目录添加字段" :image-size="60" />
          </div>
          <template v-if="inspectorMode === 'cell' && selectedMapping">
            <div class="property-head"><h3>{{ selectedMapping.displayName || selectedMapping.fieldCode }}</h3><el-button text type="danger" :disabled="!canEdit" @click="removeMapping(selectedMapping)">移除</el-button></div>
            <el-form label-position="top" size="small" class="property-form">
              <el-form-item :label="selectedMapping.bindingPath ? '数据绑定路径' : '命名区域（旧版）'"><el-input :model-value="selectedMapping.bindingPath || selectedMapping.namedArea" disabled /></el-form-item>
              <el-form-item label="输入权限"><el-select v-model="selectedMapping.permission" :disabled="!canEdit || selectedMapping.kind === 'calc'" @change="updateMapping"><el-option label="可编辑 · Primary Input" value="primary_input" /><el-option label="只读引用" value="read_only" /><el-option label="系统计算" value="system" /></el-select></el-form-item>
              <el-button plain type="primary" size="small" :disabled="!canEdit" @click="openPermissions">配置角色可见性与编辑范围</el-button>
              <div class="property-pair"><el-form-item label="必填"><el-switch v-model="selectedMapping.required" :disabled="!canEdit" @change="updateMapping" /></el-form-item><el-form-item label="主输入"><el-switch v-model="selectedMapping.primary" :disabled="!canEdit || selectedMapping.permission !== 'primary_input'" @change="updateMapping" /></el-form-item></div>
              <el-form-item v-if="!selectedMapping.bindingPath" label="区域行数 × 列数"><div class="dimensions"><el-input-number v-model="selectedMapping.rowCount" :min="selectedMapping.kind === 'table' ? 2 : 1" :max="form.rowCount" :disabled="!canEdit" @change="updateMapping" /><span>×</span><el-input-number v-model="selectedMapping.colCount" :min="1" :max="form.columnCount" :disabled="!canEdit || selectedMapping.kind === 'table'" @change="updateMapping" /></div></el-form-item>
              <el-form-item label="数字格式"><el-input v-model="selectedMapping.format" :disabled="!canEdit" placeholder="例如 #,##0.00" @change="updateMapping" /></el-form-item>
              <el-form-item v-if="selectedMapping.ruleVersionIds?.length" label="历史业务校验"><el-select v-model="selectedMapping.ruleVersionIds" multiple filterable :disabled="!canEdit || selectedMapping.kind === 'calc'" placeholder="选择已发布字段规则" @change="updateMapping"><el-option v-for="rule in applicableValidationRules" :key="rule.versionId" :label="`${rule.displayName} · v${rule.version}`" :value="rule.versionId" /></el-select></el-form-item>
              <el-form-item v-if="selectedMapping.kind === 'calc'" label="公式来源"><el-input :model-value="selectedMapping.formulaSource || '业务公式'" disabled /></el-form-item>
              <el-form-item v-else label="单元格公式">
                <el-input v-model="cellFormulaDraft" :disabled="!canEdit || selectedMapping.kind === 'table'" placeholder="留空表示用户填写；例如 =B2*C2" @change="applyCellFormula" />
                <p class="panel-hint">公式结果会作为该字段的值保存；引用其他已绑定字段所在的单元格。</p>
              </el-form-item>
              <el-form-item label="权限 Tag"><el-input :model-value="selectedTagJson" type="textarea" :rows="5" readonly /></el-form-item>
            </el-form>
            <div v-if="selectedMapping.issue" class="issue-text">{{ selectedMapping.issue }}</div>
          </template>
          <section v-if="inspectorMode === 'all'" class="component-palette">
            <div class="property-head"><h3>兼容组件</h3><el-tag size="small" effect="plain">{{ regionLabel[form.componentType] }}</el-tag></div>
            <p class="panel-hint">先在画布选中插入位置，再点击组件。系统会检查尺寸、重叠和已有内容。</p>
            <CatalogInsertButton v-for="item in compatibleComponents" :key="item.versionId" variant="component" :disabled="!canEdit" :title="item.metadata?.name || item.code" :description="`${item.code} · v${item.version} · ${item.workbook?.rowCount}×${item.workbook?.columnCount}`" glyph="▦" @select="injectComponent(item)" />
            <small v-if="!compatibleComponents.length" class="empty-note">暂无已发布的 {{ regionLabel[form.componentType] }} 组件</small>
          </section>
          <section v-if="inspectorMode === 'cell'" class="native-validation-panel">
            <div class="property-head"><h3>单元格数据校验</h3></div><p class="panel-hint">当前单元格：{{ nativeValidatorSummary }}</p>
            <el-select v-model="selectedNativeRuleId" aria-label="选择已发布的数据校验" filterable clearable placeholder="选择已发布的数据校验" :disabled="!canEdit" style="width:100%"><el-option v-for="rule in nativeRuleOptions" :key="rule.versionId" :label="`${rule.displayName} · v${rule.version}`" :value="rule.versionId"/></el-select>
            <div class="native-rule-actions"><el-button type="primary" plain :disabled="!canEdit || !selectedNativeRuleId" @click="applySelectedNativeRule">应用到选中区域</el-button><el-button :disabled="!canEdit" @click="clearSelectedNativeRule">清除校验</el-button></div>
            <p class="panel-hint">无需绑定字段。每个单元格保留一条原生校验，应用时替换原有校验。</p>
            <el-button text type="primary" @click="openRuleCatalog">管理校验规则</el-button>
          </section>
          <PermissionPanel v-if="inspectorMode === 'permissions'" :form="permissionForm" :options="permissionOptions"
            :scope="permissionScope" :target="permissionTargetLabel" :mixed="permissionMixed" :disabled="!canEdit"
            :loading="permissionOptionsLoading" :load-error="permissionOptionsError" :dirty="hasPermissionDraft()" :detached="permissionDraftDetached" :validation="permissionValidation"
            @retry="loadPermissionOptions" @convert="convertLegacyPermissions" @change="permissionValidation = ''" @discard="discardPermissionDraft" @return-selection="returnToPermissionDraft" @scope="setPermissionScope" @apply="applyCellPermission" @clear="clearScopePermission" />
          <section v-if="inspectorMode === 'signature'" class="signature-properties">
            <h3>签名单元格</h3><p class="panel-hint">{{ signatureTargetLabel }}</p>
            <el-switch :model-value="signatureEnabled" :disabled="!canEdit || !selectedTargetCell" aria-label="启用手写签名" active-text="启用手写签名" @change="setSignatureCell" />
            <p class="panel-hint">填报时点击此单元格打开签名画板，完成后在单元格内显示签名图片。</p>
            <el-button text type="primary" @click="openPermissions('cell')">设置谁可以签名</el-button>
          </section>
        </div>
      </aside>
    </section>

    <field-proposal-dialog ref="fieldProposal" :is-system-admin="isSystemAdmin"
      width="min(620px, calc(100% - 32px))" @saved="onFieldProposalSaved" />

    <el-dialog v-model="pdfPreviewDialog" title="PDF 成品预览" width="92vw" destroy-on-close @closed="releasePdfPreview">
      <iframe v-if="pdfPreviewUrl" :src="pdfPreviewUrl" class="pdf-preview-frame" title="组件 PDF 预览" />
      <template #footer><el-button @click="pdfPreviewDialog = false">关闭</el-button><a v-if="pdfPreviewUrl" :href="pdfPreviewUrl" :download="`${form.code || 'component'}-preview.pdf`" class="el-button el-button--primary">下载 PDF</a></template>
    </el-dialog>
  </main>
</template>

<script>
import { registerTemplateFunctions, functionDescriptor, collectFunctionRefs } from '@/template/managedFunctions'
import { shiftFormula } from '@/template/formulaShift'
import { disposeAuxiliaryData } from '@/template/auxiliaryDataBinding'
import { markRaw } from 'vue'
import { ArrowLeft, Close } from '@element-plus/icons-vue'
import directTemplateWorkbench from '@/template/directTemplateWorkbench'
import permissionDesigner from '@/template/permissionDesigner'
import signatureDesigner from '@/template/signatureDesigner'
import designerSafety from '@/template/designerSafety'
import { readCellTag, SIGNATURE_FORMAT } from '@/template/signatureCell'
import { isNativeRule, applyNativeRule } from '@/template/nativeValidator'
import PermissionPanel from '@/components/PermissionPanel.vue'
import CatalogInsertButton from '@/components/CatalogInsertButton.vue'
import FieldProposalDialog from '@/components/FieldProposalDialog.vue'
import { permissionKeys } from '@/template/permissionRules'
import { observeWorkbookLayout } from '@/utils/observeWorkbookLayout'
import '@grapecity-software/spread-sheets/styles/gc.spread.sheets.excel2013white.css'
import '@grapecity-software/spread-sheets-designer/styles/gc.spread.sheets.designer.light.min.css'
import '@grapecity-software/spread-sheets-designer-resources-cn'
import '@grapecity-software/spread-sheets-io'
import '@grapecity-software/spread-sheets-print'
import * as GCD from '@grapecity-software/spread-sheets-designer'
import GC from '@grapecity-software/spread-sheets'
import { fieldCatalogApi, ruleCatalogApi, templateGovernanceApi } from '@/api'
import { designerLicense } from '@/utils/spreadjsLicense'
import { ensureSpreadPdfExport } from '@/utils/spreadPdfFonts'

GCD.Spread.Sheets.Designer.LicenseKey = designerLicense

const normalizeCode = value => String(value || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g, '')
const copyMappings = mappings => JSON.parse(JSON.stringify(mappings))

export default {
  name: 'DesignerWorkbench',
  components: { PermissionPanel, CatalogInsertButton, FieldProposalDialog, ArrowLeft, Close },
  mixins: [directTemplateWorkbench, permissionDesigner, signatureDesigner, designerSafety],
  data() {
    const user = JSON.parse(localStorage.getItem('userInfo') || '{}')
    return {
      userId: Number(user.id), currentUserName: user.name || user.username || '当前用户', roles: user.roles || [],
      designer: null, spread: null, stopDesignerLayout: null, spreadOptions: { sheetCount: 1 },
      fields: [], drafts: [], components: [], rules: [], loading: false, catalogError: '', saving: false, submitting: false,
      selectedNativeRuleId: null, nativeValidatorSummary: '尚未设置', fieldSearch: '', fieldTab: 'approved', recentCodes: JSON.parse(localStorage.getItem('designerRecentFields') || '[]'),
      component: null, sourceComponent: null, versionId: null, componentId: null, isDraft: true, canEdit: true, mappings: [], selectedMapping: null, designerReady: false,
      selectedTargetCell: null, gridHost: null, fieldDrawer: false, inspectorDrawer: false, inspectorMode: 'cell', permissionForm: null, cellFormulaDraft: '',
      inspectorSections: [{ mode: 'all', label: '映射检查器' }, { mode: 'cell', label: '当前单元格' }, { mode: 'permissions', label: '填报权限' }, { mode: 'signature', label: '签名单元格' }],
      form: { name: '', code: '', componentType: 'body', rowCount: 8, columnCount: 6 }, importedFromXlsx: false,
      importedWorkbookJson: null, importedWorkbookName: '', importSheets: [], activeImportSheet: 0, nativeValidations: [],
      pdfPreviewDialog: false, pdfPreviewUrl: '', pdfExporting: false,
      regionLabel: { header: 'Header 页眉', body: 'Body 主体', footer: 'Footer 页脚' },
      mappingAuditTimer: 0, undoAvailable: false, redoAvailable: false
    }
  },
  computed: {
    statusText() { const status = this.directTemplate?.status || this.component?.status; return ({ draft: '草稿', rejected: '已退回', in_review: '审核中', published: '已发布', superseded: '已替代' })[status] || '新建草稿' },
    statusType() { return this.component?.status === 'rejected' ? 'danger' : 'info' },
    isSystemAdmin() { return this.roles.some(role => role.code === 'system_admin') },
    occurrenceCount() { return this.mappings.reduce((sum, item) => sum + item.occurrences.length, 0) },
    unregisteredValidationCount() { return 0 },
    issues() { return this.mappings.filter(item => item.issue) },
    filteredDrafts() { const q = this.fieldSearch.trim().toLowerCase(); return this.drafts.filter(item => !q || `${item.code} ${item.proposal?.displayName || ''}`.toLowerCase().includes(q)) },
    filteredBusinessFormulas() { const q = this.fieldSearch.trim().toLowerCase(); return this.businessFormulas.filter(item => !q || `${item.code} ${item.displayName}`.toLowerCase().includes(q)) },
    businessFormulas() { return this.rules.filter(rule => rule.expression?.engine === 'spreadjs-function' && rule.status === 'published') },
    nativeRuleOptions() { return this.rules.filter(rule => rule.status === 'published' && isNativeRule(rule.expression)) },
    applicableValidationRules() { return this.rules.filter(rule => rule.ruleType === 'validation' && rule.scope === 'field' && rule.status === 'published' && !isNativeRule(rule.expression)) },
    compatibleComponents() { return this.components.filter(item => (this.isTemplateDesign || item.componentType === this.form.componentType) && item.status === 'published' && item.versionId !== this.component?.versionId) },
    visibleFields() { const q = this.fieldSearch.trim().toLowerCase(); return this.fields.filter(item => !q || `${item.code} ${item.displayName} ${item.type}`.toLowerCase().includes(q)) },
    groupedFields() {
      const groups = new Map()
      for (const field of this.visibleFields) {
        const group = field.applicability?.group || field.applicability?.category || '未分类'
        if (!groups.has(group)) groups.set(group, [])
        groups.get(group).push(field)
      }
      return [...groups.entries()].map(([name, items]) => ({ name, items }))
    },
    recentFields() { return this.recentCodes.map(code => this.fields.find(field => field.code === code)).filter(Boolean).filter(field => !this.fieldSearch || `${field.code} ${field.displayName}`.toLowerCase().includes(this.fieldSearch.toLowerCase())) },
    selectedTagJson() {
      const mapping = this.selectedMapping
      if (!mapping) return ''
      const rawTag = this.spread?.getActiveSheet()?.getTag(mapping.row, mapping.col)
      if (rawTag == null) return '（当前单元格没有 Tag）'
      if (typeof rawTag === 'string') {
        try { return JSON.stringify(JSON.parse(rawTag), null, 2) }
        catch { return rawTag }
      }
      return JSON.stringify(rawTag, null, 2)
    },
  },
  async mounted() {
    this.versionId = Number(this.$route.query.versionId) || null
    const sourceId = Number(this.$route.query.sourceId) || null
    if (sourceId) await this.createVersionFrom(sourceId)
    await this.loadCatalog()
    await this.loadPermissionOptions()
    if (this.isTemplateDesign) await this.loadDirectTemplate()
    else await this.loadComponent()
    await this.$nextTick()
    await this.initDesigner()
    this.focusIssueMapping()
    this.rememberSavedDesign()
    window.addEventListener('beforeunload', this.warnUnsavedDesign)
  },
  async beforeRouteLeave() {
    if (await this.$refs.fieldProposal?.canLeave() === false) return false
    return this.confirmDesignerLeave()
  },
  beforeUnmount() {
    this._designerDisposed = true
    window.removeEventListener('beforeunload', this.warnUnsavedDesign)
    if (this.spread) disposeAuxiliaryData(this.spread)
    this.stopDesignerLayout?.()
    this.releasePdfPreview()
    this.removeGridListeners()
    this.removeDirectSheetListeners()
    if (this.designer) this.designer.destroy()
    this.designer = null
  },
  methods: {
    refreshHistoryState() {
      this.undoAvailable = Boolean(this.spread?.undoManager().canUndo())
      this.redoAvailable = Boolean(this.spread?.undoManager().canRedo())
    },
    registerMappingCommand() {
      // The sheet transaction and the platform mapping manifest form one user action.
      // Keep them on the native stack so keyboard, ribbon and page buttons agree.
      this.spread.commandManager().register('costReportMapping', {
        canUndo: true,
        execute: (spread, options, isUndo) => {
          const commands = GC.Spread.Sheets.Commands
          const sheet = spread.getSheetFromName(options.sheetName)
          if (this.isTemplateDesign && sheet !== spread.getActiveSheet()) {
            for (let index = 0; index < spread.getSheetCount(); index++) if (spread.getSheet(index) === sheet) spread.setActiveSheetIndex(index)
          }
          spread.suspendPaint()
          try {
            if (isUndo) commands.undoTransaction(spread, options)
            else {
              commands.startTransaction(spread, options)
              try {
                for (const mapping of options.before) {
                  sheet.removeCustomName(mapping.namedArea)
                  if (mapping.row < sheet.getRowCount() && mapping.col < sheet.getColumnCount()) {
                    const raw = sheet.getTag(mapping.row, mapping.col)
                    let tag
                    try { tag = typeof raw === 'string' ? JSON.parse(raw) : raw } catch {}
                    if (tag?.mappingId === mapping.id || mapping.bindingPath && sheet.getBindingPath(mapping.row, mapping.col) === mapping.bindingPath) {
                      if (mapping.bindingPath) sheet.setBindingPath(mapping.row, mapping.col, null)
                      sheet.setTag(mapping.row, mapping.col, JSON.stringify({ schemaVersion: 1, platform: 'cost-report-cell-permission-v1',
                        ...(tag.signature ? { signature: tag.signature } : {}),
                        ...Object.fromEntries(permissionKeys.map(key => [key, tag[key]])) }))
                      const style = sheet.getStyle(mapping.row, mapping.col)
                      if (style) { style.watermark = tag.signature ? '点击签名' : ''; sheet.setStyle(mapping.row, mapping.col, style) }
                    }
                  }
                }
                for (const cell of options.cells || []) {
                  if (Object.hasOwn(cell, 'value')) sheet.setValue(cell.row, cell.column, cell.value)
                  if (cell.formula) sheet.setFormula(cell.row, cell.column, cell.formula)
                  if (readCellTag(cell.tag).signature?.version === 1) {
                    sheet.setTag(cell.row, cell.column, cell.tag)
                    sheet.setFormatter(cell.row, cell.column, SIGNATURE_FORMAT)
                    const style = sheet.getStyle(cell.row, cell.column) || new GC.Spread.Sheets.Style()
                    style.watermark = '点击签名'; sheet.setStyle(cell.row, cell.column, style)
                  }
                }
                if (options.dimensions) {
                  sheet.setRowCount(options.dimensions.rows, GC.Spread.Sheets.SheetArea.viewport)
                  sheet.setColumnCount(options.dimensions.columns, GC.Spread.Sheets.SheetArea.viewport)
                }
                for (const mapping of options.after) if (mapping.row < sheet.getRowCount() && mapping.col < sheet.getColumnCount()) {
                  this.writeMapping(mapping, { initialize: options.initializeIds.includes(mapping.id), sheet })
                }
              } finally { commands.endTransaction(spread, options) }
            }
            this.mappings = copyMappings(isUndo ? options.before : options.after).map(item => this.hydrateMapping(item))
            this.form.rowCount = sheet.getRowCount(GC.Spread.Sheets.SheetArea.viewport)
            this.form.columnCount = sheet.getColumnCount(GC.Spread.Sheets.SheetArea.viewport)
            this.selectedMapping = this.mappings.find(item => item.id === (isUndo ? options.beforeSelected : options.afterSelected)) || null
            this.reconcileMappings()
          } finally {
            spread.resumePaint()
            queueMicrotask(() => this.refreshHistoryState())
          }
          return true
        }
      })
    },
    changeMappings(next, selectedId = null, initializeIds = [], cells = [], dimensions = null) {
      if (!this.canEdit || !this.spread) return
      const sheet = this.spread.getActiveSheet()
      if (sheet.isEditing() && !sheet.endEdit()) return
      this.spread.commandManager().execute({ cmd: 'costReportMapping', sheetName: this.spread.getActiveSheet().name(),
        before: copyMappings(this._committedMappings || []), after: copyMappings(next),
        beforeSelected: this._committedSelectedId, afterSelected: selectedId, initializeIds, cells, dimensions })
      this.refreshHistoryState()
    },
    async loadCatalog() {
      if (this.loading) return
      this.loading = true
      this.catalogError = ''
      try {
        const [catalog, draftList, componentList, ruleCatalog] = await Promise.all([fieldCatalogApi.getCatalog(), fieldCatalogApi.getDrafts(), templateGovernanceApi.getComponents(), ruleCatalogApi.getCatalog()])
        this.fields = catalog.fields || []
        this.drafts = draftList.drafts || []
        this.components = componentList.components || []
        this.rules = ruleCatalog.rules || []
        this.reconcileFields()
      } catch (error) { this.catalogError = `读取治理目录失败：${error.message}。请重新加载，当前设计不会丢失。` }
      finally { this.loading = false }
    },
    async createVersionFrom(sourceId) {
      try {
        const source = this.components.find(item => Number(item.id) === sourceId)
        if (!source) { await this.loadCatalog(); }
        const row = this.components.find(item => Number(item.id) === sourceId)
        if (!row) throw new Error('组件不存在')
        const created = await templateGovernanceApi.createComponentVersion(row.id, { rowCount: row.workbook.rowCount, columnCount: row.workbook.columnCount, cells: row.workbook.cells || [], metadata: row.metadata || {} })
        this.versionId = created.versionId
        this.$router.replace({ query: { versionId: String(created.versionId) } })
      } catch (error) { this.$message.error(`创建组件新版本失败：${error.message}`) }
    },
    async loadComponent() {
      if (!this.versionId) return
      try {
        if (!this.components.length) await this.loadCatalog()
        this.component = this.components.find(item => Number(item.versionId) === this.versionId)
        if (!this.component) throw new Error('组件版本不存在或无权查看')
        this.isDraft = this.component.status === 'draft'
        this.canEdit = this.isDraft && (Number(this.component.ownerId) === this.userId || this.isSystemAdmin)
        this.form = { name: this.component.metadata?.name || this.component.code, code: this.component.code, componentType: this.component.componentType,
          rowCount: Number(this.component.workbook?.rowCount) || 8, columnCount: Number(this.component.workbook?.columnCount) || 6 }
        this.componentId = this.component.id
        this.mappings = (this.component.metadata?.mappings || []).map(mapping => this.hydrateMapping(mapping))
        this.nativeValidations = (this.component.metadata?.nativeValidations || []).map(item => ({ ...item }))
        if (this.designerReady) await this.applyComponentToDesigner()
        this.reconcileMappings()
      } catch (error) { this.canEdit = false; this.$message.error(`加载组件草稿失败：${error.message}`) }
    },
    async initDesigner() {
      if (this.designer || !this.$refs.designerHost) return
      const host = this.$refs.designerHost
      const permissionCommands = this.permissionMenuCommands()
      const config = { ...GCD.Spread.Sheets.Designer.DefaultConfig,
        contextMenu: [...Object.keys(permissionCommands), ...GCD.Spread.Sheets.Designer.DefaultConfig.contextMenu],
        commandMap: { ...GCD.Spread.Sheets.Designer.DefaultConfig.commandMap, ...permissionCommands } }
      this.designer = markRaw(new GCD.Spread.Sheets.Designer.Designer(host, config, undefined, this.spreadOptions))
      this.spread = markRaw(this.designer.getWorkbook())
      this.stopDesignerLayout = observeWorkbookLayout(host, this.designer)
      this.spread.options.allowUndo = true
      this.registerMappingCommand()
      this.registerPermissionCommand()
      this.designerReady = true
      await this.applyComponentToDesigner()
      this.$nextTick(() => this.attachGridListeners())
    },
    async applyComponentToDesigner() {
      if (!this.spread) return
      if (this.isTemplateDesign) return this.applyDirectTemplateToDesigner()
      this.spread.suspendPaint()
      try {
        const sheet = this.spread.getActiveSheet()
        sheet.name(this.form.componentType.toUpperCase())
        await registerTemplateFunctions(this.spread, this.component?.metadata)
        if (this.component?.metadata?.designerJson) {
          if (this.component.metadata.designerJsonScope === 'worksheet') sheet.fromJSON(this.component.metadata.designerJson)
          else await this.spread.fromJSON(this.component.metadata.designerJson)
        }
        else {
          sheet.setRowCount(this.form.rowCount, GC.Spread.Sheets.SheetArea.viewport)
          sheet.setColumnCount(this.form.columnCount, GC.Spread.Sheets.SheetArea.viewport)
          for (const cell of this.component?.workbook?.cells || []) {
            if (Object.hasOwn(cell, 'value')) sheet.setValue(cell.row, cell.column, cell.value)
            if (cell.formula) sheet.setFormula(cell.row, cell.column, cell.formula)
          }
        }
        this.restoreTagsAndNames()
      } finally { this.spread.resumePaint() }
      this.reconcileMappings()
      this.spread.undoManager().clear()
      this.refreshHistoryState()
      if (this.designerReady) this.attachGridListeners()
    },
    attachGridListeners() {
      if (!this.spread) return
      this.removeGridListeners()
      this.gridHost = this.spread.getHost()
      if (!this.gridHost) return
      this.gridHost.addEventListener('pointerup', this.captureInsertionTarget)
      const sheet = this.spread.getActiveSheet()
      const events = GC.Spread.Sheets.Events
      this._boundSheet = sheet
      this._mappingScanPending = false
      this._sheetHandlers = [[events.RowChanged, true], [events.ColumnChanged, true], [events.RangeChanged, false], [events.CellChanged, false]].map(([type, scanTags]) => {
        const handler = () => {
          this._mappingScanPending = this._mappingScanPending || scanTags
          window.clearTimeout(this.mappingAuditTimer)
          this.mappingAuditTimer = window.setTimeout(() => {
            const shouldScan = this._mappingScanPending
            this._mappingScanPending = false
            this.reconcileMappings(shouldScan)
            this.refreshHistoryState()
            this.refreshVisibleCellProperties()
          }, 160)
        }
        sheet.bind(type, handler)
        return [type, handler]
      })
      const selectionHandler = () => {
        this.syncSelectedCell(sheet.getActiveRowIndex(), sheet.getActiveColumnIndex())
      }
      sheet.bind(events.SelectionChanged, selectionHandler)
      this._sheetHandlers.push([events.SelectionChanged, selectionHandler])
      sheet.bind(events.EnterCell, selectionHandler)
      this._sheetHandlers.push([events.EnterCell, selectionHandler])
    },
    removeGridListeners() {
      if (this.gridHost) {
        this.gridHost.removeEventListener('pointerup', this.captureInsertionTarget)
      }
      if (this.spread && this._sheetHandlers) for (const [type, handler] of this._sheetHandlers) this._boundSheet?.unbind(type, handler)
      window.clearTimeout(this.mappingAuditTimer)
    },
    resizeGrid() {
      const sheet = this.spread?.getActiveSheet()
      if (!sheet) return
      this.changeMappings(this.mappings, this.selectedMapping?.id, [], [], { rows: this.form.rowCount, columns: this.form.columnCount })
    },
    fieldGlyph(field) { return ({ decimal: '₊', integer: '#', date: '◷', datetime: '◷', boolean: '✓', enum: '≡', organization_reference: '⌂', user_reference: '◎' })[field.type] || 'T' },
    fieldKind() { return 'input' },
    hitTarget(event) {
      if (!this.spread) return null
      const rect = this.spread.getHost().getBoundingClientRect()
      const hit = this.spread.hitTest(event.clientX - rect.left, event.clientY - rect.top)
      const info = hit?.worksheetHitInfo
      if (!info || info.row == null || info.col == null || info.hitTestType !== 3) return null
      return { row: info.row, col: info.col }
    },
    captureInsertionTarget(event) {
      const target = this.hitTarget(event)
      if (target) {
        this.syncSelectedCell(target.row, target.col)
        if (event.button === 0 && !this.inspectorDrawer) this.switchInspector('cell')
      }
    },
    syncSelectedCell(row, col) {
      if (row < 0 || col < 0) return
      this.selectedTargetCell = { row, col }
      this.selectedMapping = this.mappings.find(mapping => row >= mapping.row && row < mapping.row + mapping.rowCount
        && col >= mapping.col && col < mapping.col + mapping.colCount) || null
      this.syncCellFormula()
      this.refreshVisibleCellProperties()
    },
    refreshVisibleCellProperties() {
      // A large selection can contain tens of thousands of permission targets.
      // Read only the visible inspector; reopening always reads the current sheet.
      if (!this.inspectorDrawer) return
      if (this.inspectorMode === 'permissions') this.loadCellPermissions()
      else if (this.inspectorMode === 'signature') this.loadSignatureCell()
      else if (this.inspectorMode === 'cell') { this.readCurrentNativeValidator(); this.syncCellFormula() }
    },
    toggleInspector() {
      if (this.saving || this.submitting) return
      if (this.inspectorDrawer) this.closeDesignPanel('inspectorPanel')
      else { this.switchInspector(this.inspectorMode); this.showDesignPanel('inspectorPanel') }
    },
    toggleFieldDrawer() {
      if (this.saving || this.submitting) return
      if (this.fieldDrawer) this.closeDesignPanel('fieldPanel')
      else { this.fieldDrawer = true; this.showDesignPanel('fieldPanel') }
    },
    closeDesignPanel(name) {
      if (this.saving || this.submitting) return
      if (name === 'fieldPanel') this.fieldDrawer = false
      else if (name === 'inspectorPanel') this.inspectorDrawer = false
      else return
      const request = this._panelFocusRequest = (this._panelFocusRequest || 0) + 1
      this.$nextTick(() => {
        if (this._designerDisposed || request !== this._panelFocusRequest) return
        const trigger = this.$refs[`${name}Trigger`]
        const element = trigger?.$el || trigger
        element?.focus()
      })
    },
    showDesignPanel(name) {
      const request = this._panelFocusRequest = (this._panelFocusRequest || 0) + 1
      this.$nextTick(() => {
        if (this._designerDisposed || this.saving || this.submitting || request !== this._panelFocusRequest) return
        if (name === 'fieldPanel' && !this.fieldDrawer || name === 'inspectorPanel' && !this.inspectorDrawer) return
        const panel = this.$refs[name]
        if (!panel) return
        if (this.$refs.studioGrid && getComputedStyle(this.$refs.studioGrid).display === 'grid') {
          panel.scrollIntoView({ block: 'nearest', behavior: 'auto' })
        }
        // Focus the named region, not an input: touch users should not get a
        // keyboard just for opening a panel. Tab continues inside this region.
        panel.focus({ preventScroll: true })
      })
    },
    switchInspector(mode) {
      this.inspectorMode = mode
      this.inspectorDrawer = true
      this.refreshVisibleCellProperties()
    },
    insertionTarget() {
      if (!this.canEdit) { this.$message.warning('当前版本为只读'); return null }
      if (this.isTemplateDesign && this.directSheetState(this.spread.getActiveSheet()).definition?.auxiliary?.dataBinding) {
        this.$message.warning('接口辅助表为只读，请在工作表组成中调整接口配置'); return null
      }
      if (!this.selectedTargetCell) { this.$message.warning('请先在画布单击目标单元格'); return null }
      return this.selectedTargetCell
    },
    injectField(field) {
      const target = this.insertionTarget()
      if (!target) return
      this.placeField(field, target.row, target.col)
    },
    async injectFormula(rule) {
      const target = this.insertionTarget()
      if (!target) return
      try {
        const descriptor = functionDescriptor(rule)
        const refs = collectFunctionRefs(this.spread.toJSON({ includeBindingSource: false }))
        if (refs.some(item => item.name === descriptor.name && item.versionId !== descriptor.versionId)) throw new Error('该函数已有其他版本，请在新的模板版本中统一使用同一个函数版本')
        const parameters = rule.expression.parameters || []
        const count = parameters.some(p => p.rest) ? parameters.length + 1 : parameters.length
        const example = `=${descriptor.name}(${Array.from({ length: count }, (_, i) => (i + 1) * 10).join(',')})`
        const { value } = await this.$prompt('填写公式参数，可使用常量或单元格引用。', `${rule.displayName} · V${rule.version}`, { inputValue: example, inputPlaceholder: example })
        await registerTemplateFunctions(this.spread, descriptor)
        this.spread.getActiveSheet().setFormula(target.row, target.col, value)
        this.markDraftDirty()
        this.$message.success('函数已添加到模板，保存时会记录当前版本和实例属性')
      } catch (error) { if (error !== 'cancel' && error !== 'close') this.$message.error(error.message) }
    },
    injectComponent(component) {
      const target = this.insertionTarget()
      if (target) this.placeComponent(component, target.row, target.col)
    },
    placeField(field, row, col) {
      if (readCellTag(this.spread.getActiveSheet().getTag(row, col)).signature && !['short_text','long_text'].includes(field.type)) {
        this.$message.warning('签名单元格只能绑定文本字段'); return
      }
      if (!this.fields.some(item => item.id === field.id)) { this.$message.warning('字段草稿或未批准字段不能用于映射'); return }
      if (this.mappings.some(item => row >= item.row && row < item.row + item.rowCount && col >= item.col && col < item.col + item.colCount)) {
        this.$message.warning('当前单元格已绑定指标，请在单元格属性面板中查看或移除绑定')
        this.switchInspector('cell')
        return
      }
      const kind = this.fieldKind(field)
      const rows = 1
      const cols = 1
      if (rows < 1 || col + cols > this.form.columnCount) return this.$message.warning('目标区域超出当前组件网格')
      const id = `${field.id}-${row}-${col}-${Date.now()}`
      let cellRule = null
      try { cellRule = JSON.parse(this.spread.getActiveSheet().getTag(row, col) || 'null') } catch {}
      if (cellRule?.platform !== 'cost-report-cell-permission-v1') cellRule = null
      const primary = kind === 'input' && (!cellRule?.permission || cellRule.permission === 'primary_input') && field.editable !== false && !this.mappings.some(item => item.fieldCode === field.code && item.primary)
      const namedArea = this.uniqueNamedArea(kind === 'input' ? 'INPUT' : kind === 'table' ? 'TABLE' : 'CALC', field.code)
      const mapping = {
        id, fieldDefinitionId: field.id, fieldVersion: field.version, fieldCode: field.code, displayName: field.displayName,
        kind, namedArea, bindingPath: field.code, bindingVersion: 2,
        row, col, rowCount: rows, colCount: cols, permission: kind === 'input' ? (primary ? 'primary_input' : 'read_only') : kind === 'calc' ? 'system' : 'read_only',
        ...Object.fromEntries(permissionKeys.filter(key => key !== 'permission' && cellRule?.[key] !== undefined).map(key => [key, cellRule[key]])),
        visibility: cellRule?.visibility || 'visible', hiddenForRoles: cellRule?.hiddenForRoles || [], maskedForRoles: cellRule?.maskedForRoles || [], editableForRoles: primary ? cellRule?.editableForRoles || (cellRule?.editableForUsers || cellRule?.editableForDepartments ? [] : ['subsidiary_filler']) : [],
        required: false, primary,
        format: field.type === 'decimal' ? (Number(field.precision) > 0 ? `#,##0.${'0'.repeat(Number(field.precision))}` : '#,##0') : '',
        ruleCodes: [], ruleVersionIds: [], ruleCodesText: '', formulaSource: null,
        occurrences: [{ sheet: this.form.componentType.toUpperCase(), row, col, rowCount: rows, colCount: cols }], issue: ''
      }
      this.changeMappings([...this.mappings, mapping], mapping.id, [mapping.id])
      this.recentCodes = [field.code, ...this.recentCodes.filter(code => code !== field.code)].slice(0, 8)
      localStorage.setItem('designerRecentFields', JSON.stringify(this.recentCodes))
      this.reconcileMappings()
    },
    uniqueNamedArea(prefix, code, exceptId = null) {
      const base = `${prefix}_${normalizeCode(code)}`
      const used = name => this.mappings.some(mapping => mapping.id !== exceptId && mapping.namedArea === name)
      let result = base, suffix = 2
      while (used(result)) result = `${base}_${suffix++}`
      return result
    },
    placeFormula(rule, row, col) {
      if (!this.businessFormulas.some(item => Number(item.versionId) === Number(rule.versionId))) return this.$message.warning('仅可映射已发布的业务公式')
      const id = `formula-${rule.versionId}-${row}-${col}-${Date.now()}`
      const mapping = { id, fieldDefinitionId: null, fieldVersion: null, fieldCode: rule.code, displayName: rule.displayName,
        sourceType: 'business_formula', kind: 'calc', namedArea: this.uniqueNamedArea('CALC', rule.code), row, col, rowCount: 1, colCount: 1,
        permission: 'system', required: false, primary: false, format: '', ruleCodes: [], ruleVersionIds: [],
        formulaSource: rule.code, formulaVersionId: rule.versionId, formulaExpression: rule.expression, formulaParameters: rule.parameters || {},
        occurrences: [{ sheet: this.form.componentType.toUpperCase(), row, col, rowCount: 1, colCount: 1 }], issue: '' }
      this.changeMappings([...this.mappings, mapping], mapping.id, [mapping.id])
      this.reconcileMappings()
    },
    writeMapping(mapping, { initialize = false, sheet = this.spread.getActiveSheet() } = {}) {
      const signature = readCellTag(sheet.getTag(mapping.row, mapping.col)).signature
      const tag = mapping.bindingPath ? { schemaVersion: 1, platform: 'cost-report-cell-permission-v1',
        ...Object.fromEntries(permissionKeys.map(key => [key, mapping[key]]))
      } : { schemaVersion: 1, platform: 'cost-report-mapping-v1', mappingId: mapping.id, fieldDefinitionId: mapping.fieldDefinitionId,
        fieldVersion: mapping.fieldVersion, fieldCode: mapping.fieldCode, namedArea: mapping.namedArea, kind: mapping.kind,
        permission: mapping.permission, visibility: mapping.visibility || 'visible', hiddenForRoles: mapping.hiddenForRoles || [], maskedForRoles: mapping.maskedForRoles || [],
        editableForRoles: mapping.editableForRoles || [], required: Boolean(mapping.required), primary: Boolean(mapping.primary),
        ruleCodes: mapping.ruleCodes || [], ruleVersionIds: mapping.ruleVersionIds || [], formulaSource: mapping.formulaSource || null,
        formulaVersionId: mapping.formulaVersionId || null, formulaExpression: mapping.formulaExpression || null,
        formulaParameters: mapping.formulaParameters || {}, rowCount: mapping.rowCount, colCount: mapping.colCount,
        datasetColumns: mapping.datasetColumns || [] }
      for (const key of permissionKeys) if (mapping[key] !== undefined) tag[key] = mapping[key]
      if (signature) tag.signature = signature
      if (initialize && mapping.kind === 'table' && mapping.datasetColumns?.length) {
        mapping.datasetColumns.forEach((column, index) => sheet.setValue(mapping.row, mapping.col + index, column.displayName))
        for (let r = 1; r < mapping.rowCount; r += 1) for (let c = 0; c < mapping.colCount; c += 1) {
          sheet.setFormula(mapping.row + r, mapping.col + c, null)
          sheet.setValue(mapping.row + r, mapping.col + c, null)
        }
      } else if (initialize && mapping.kind === 'input') {
        // Keep a formula already authored in the cell; only clear placeholder content.
        if (!sheet.getFormula(mapping.row, mapping.col)) sheet.setValue(mapping.row, mapping.col, null)
      }
      const style = sheet.getStyle(mapping.row, mapping.col) || new GC.Spread.Sheets.Style()
      style.watermark = signature ? '点击签名' : mapping.displayName || mapping.fieldCode
      if (signature) style.formatter = SIGNATURE_FORMAT
      sheet.setStyle(mapping.row, mapping.col, style)
      sheet.setTag(mapping.row, mapping.col, JSON.stringify(tag))
      if (mapping.bindingPath) sheet.setBindingPath(mapping.row, mapping.col, mapping.bindingPath)
      if (mapping.format && !signature) sheet.setFormatter(mapping.row, mapping.col, mapping.format)
      const ref = this.rangeFormula(mapping.row, mapping.col, mapping.rowCount, mapping.colCount)
      const existing = sheet.getCustomName(mapping.namedArea)
      if (!existing) sheet.addCustomName(mapping.namedArea, ref, 0, 0, `字段 ${mapping.fieldCode}；${mapping.permission}`, true)
      else sheet.removeCustomName(mapping.namedArea)
      if (existing) sheet.addCustomName(mapping.namedArea, ref, 0, 0, `字段 ${mapping.fieldCode}；${mapping.permission}`, true)
    },
    rangeFormula(row, col, rowCount, colCount) {
      const colLabel = value => { let label = ''; for (let n = value + 1; n; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + ((n - 1) % 26)) + label; return label }
      const first = `$${colLabel(col)}$${row + 1}`
      const last = `$${colLabel(col + colCount - 1)}$${row + rowCount}`
      return `=${first}${rowCount * colCount > 1 ? `:${last}` : ''}`
    },
    hydrateMapping(source) { const item = { ...source, visibility: source.visibility || 'visible', hiddenForRoles: [...(source.hiddenForRoles || [])], maskedForRoles: [...(source.maskedForRoles || [])], editableForRoles: [...(source.editableForRoles || (source.permission === 'primary_input' && !source.editableForUsers && !source.editableForDepartments ? ['subsidiary_filler'] : []))], ruleCodes: [...(source.ruleCodes || [])], ruleVersionIds: [...(source.ruleVersionIds || [])], occurrences: source.occurrences?.length ? source.occurrences : [{ sheet: this.form.componentType.toUpperCase(), row: source.row, col: source.col, rowCount: source.rowCount, colCount: source.colCount }] }; item.ruleCodesText = item.ruleCodes.join(', '); return item },
    restoreTagsAndNames() {
      const sheet = this.spread.getActiveSheet()
      for (const mapping of this.mappings) {
        // Old drafts stored the catalog display name as input data. Remove only
        // that known placeholder, preserving real text, numbers and formulas.
        if (this.canEdit && mapping.kind === 'input' && !sheet.getFormula(mapping.row, mapping.col)
          && sheet.getValue(mapping.row, mapping.col) === mapping.displayName) sheet.setValue(mapping.row, mapping.col, null)
        this.writeMapping(mapping)
      }
    },
    reconcileFields() {
      if (!this.mappings.length || !this.fields.length) return
      this.mappings = this.mappings.map(mapping => {
        if (mapping.sourceType === 'business_formula') return { ...mapping, displayName: mapping.displayName || mapping.formulaSource }
        const current = this.fields.find(field => Number(field.id) === Number(mapping.fieldDefinitionId))
        return current ? { ...mapping, displayName: current.displayName, fieldVersion: current.version } : { ...mapping, issue: '字段已从已批准目录移除，映射悬空' }
      })
    },
    reconcileMappings(scanTags = false) {
      const sheet = this.spread?.getActiveSheet()
      if (!sheet) return
      const rows = sheet.getRowCount(GC.Spread.Sheets.SheetArea.viewport)
      const cols = sheet.getColumnCount(GC.Spread.Sheets.SheetArea.viewport)
      // Native Designer row/column edits bypass the old form controls. Keep the
      // payload rectangle and insertion bounds aligned with the grid we inspect.
      this.form.rowCount = rows
      this.form.columnCount = cols
      const anchors = new Map()
      if (scanTags) for (const mapping of this.mappings.filter(item => item.bindingPath)) {
        if (sheet.getBindingPath(mapping.row, mapping.col) === mapping.bindingPath) continue
        const matches = []
        for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++)
          if (sheet.getBindingPath(row, col) === mapping.bindingPath) matches.push({ row, col })
        if (matches.length === 1) anchors.set(mapping.id, matches[0])
      }
      if (scanTags) for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
        const raw = sheet.getTag(row, col)
        if (!raw) continue
        try {
          const tag = typeof raw === 'string' ? JSON.parse(raw) : raw
          if (tag?.mappingId) anchors.set(tag.mappingId, { row, col })
        } catch {}
      }
      this.mappings = this.mappings.map(mapping => {
        const moved = anchors.get(mapping.id)
        if (moved && (moved.row !== mapping.row || moved.col !== mapping.col)) {
          const next = { ...mapping, row: moved.row, col: moved.col,
            occurrences: [{ sheet: this.form.componentType.toUpperCase(), row: moved.row, col: moved.col, rowCount: mapping.rowCount, colCount: mapping.colCount }] }
          this.writeMapping(next)
          mapping = next
        }
        let issue = ''
        if (mapping.row < 0 || mapping.col < 0 || mapping.row + mapping.rowCount > rows || mapping.col + mapping.colCount > cols) issue = '命名区域超出当前网格，结构编辑已截断此映射'
        else {
          const tag = moved && scanTags ? JSON.stringify({ mappingId: mapping.id }) : sheet.getTag(mapping.row, mapping.col)
          let stored = null
          try { stored = typeof tag === 'string' ? JSON.parse(tag) : tag } catch {}
          if (mapping.bindingPath ? sheet.getBindingPath(mapping.row, mapping.col) !== mapping.bindingPath : !stored || stored.mappingId !== mapping.id) issue = '字段绑定丢失，或起始单元格已移动，请重新绑定'
        }
        return { ...mapping, issue }
      })
      for (let a = 0; a < this.mappings.length; a += 1) for (let b = a + 1; b < this.mappings.length; b += 1) {
        const left = this.mappings[a], right = this.mappings[b]
        const overlap = left.row < right.row + right.rowCount && left.row + left.rowCount > right.row && left.col < right.col + right.colCount && left.col + left.colCount > right.col
        if (overlap) { left.issue = left.issue || `与 ${right.fieldCode} 的区域重叠`; right.issue = right.issue || `与 ${left.fieldCode} 的区域重叠` }
      }
      if (this.selectedMapping) this.selectedMapping = this.mappings.find(item => item.id === this.selectedMapping.id) || null
      this._committedMappings = copyMappings(this.mappings)
      this._committedSelectedId = this.selectedMapping?.id || null
      if (this.isTemplateDesign) this.rememberDirectSheet()
    },
    selectMapping(mapping) {
      const sheet = this.spread?.getActiveSheet()
      if (!sheet || !mapping) return
      this.selectedMapping = mapping
      this.selectedTargetCell = { row: mapping.row, col: mapping.col }
      sheet.setActiveCell(mapping.row, mapping.col)
      this.syncCellFormula()

    },
    focusIssueMapping() {
      const cellRow = Number(this.$route.query.cellRow)
      const cellCol = Number(this.$route.query.cellCol)
      if (Number.isInteger(cellRow) && cellRow >= 0 && Number.isInteger(cellCol) && cellCol >= 0 && this.spread) {
        this.focusValidation({ row: cellRow, col: cellCol })
        return
      }
      const mappingId = this.$route.query.mappingId
      if (mappingId == null || !this.spread) return
      const mapping = this.mappings.find(item => String(item.id) === String(mappingId))
      if (mapping) this.selectMapping(mapping)
      else this.$message.warning('报告中的映射已不在此组件版本中，请检查组件变更')
    },
    syncCellFormula() {
      const mapping = this.selectedMapping, sheet = this.spread?.getActiveSheet()
      const formula = mapping && sheet ? sheet.getFormula(mapping.row, mapping.col) : ''
      this.cellFormulaDraft = formula ? `=${String(formula).replace(/^=/, '')}` : ''
    },
    applyCellFormula() {
      const mapping = this.selectedMapping
      if (!this.canEdit || !mapping || mapping.kind === 'calc' || mapping.kind === 'table') return
      const sheet = this.spread?.getActiveSheet()
      if (!sheet) return
      const value = String(this.cellFormulaDraft || '').trim()
      try {
        if (!value) {
          sheet.setFormula(mapping.row, mapping.col, null)
          this.$message.success('已清除单元格公式，恢复用户填写')
        } else {
          if (!value.startsWith('=')) {
            this.$message.warning('单元格公式需要以 = 开头，例如 =B2*C2')
            this.syncCellFormula()
            return
          }
          sheet.setFormula(mapping.row, mapping.col, value)
          this.$message.success('单元格公式已更新')
        }
        this.markDraftDirty()
        this.updateMapping()
        this.$nextTick(() => this.syncCellFormula())
      } catch (error) {
        this.$message.error(`公式设置失败：${error.message || '请检查公式引用'}`)
        this.syncCellFormula()
      }
    },
    updateMapping() {
      const mapping = this.selectedMapping
      if (!mapping) return
      if (mapping.kind === 'table' && !mapping.datasetColumns?.length) {
        mapping.kind = 'input'
        this.$message.warning('重复数据集需要通过目录拖放向导配置固定列契约')
      }
      if (mapping.permission === 'primary_input') {
        const existingPrimary = this.mappings.find(other => other !== mapping && other.fieldCode === mapping.fieldCode && other.primary)
        if (existingPrimary) { mapping.permission = 'read_only'; mapping.primary = false; this.$message.warning('此字段已有 Primary Input，当前重复映射保持只读') }
        else mapping.primary = true
      }
      if (mapping.primary) for (const other of this.mappings) if (other !== mapping && other.fieldCode === mapping.fieldCode) { other.primary = false; other.permission = 'read_only' }
      mapping.kind = mapping.kind || 'input'
      const prefix = mapping.kind === 'input' ? 'INPUT' : mapping.kind === 'table' ? 'TABLE' : 'CALC'
      mapping.namedArea = this.uniqueNamedArea(prefix, mapping.fieldCode, mapping.id)
      mapping.ruleVersionIds = [...new Set((mapping.ruleVersionIds || []).map(Number))]
      mapping.ruleCodes = this.rules.filter(rule => mapping.ruleVersionIds.includes(Number(rule.versionId))).map(rule => rule.code)
      if (mapping.kind === 'calc') { mapping.permission = 'system'; mapping.primary = false; mapping.ruleVersionIds = []; mapping.ruleCodes = [] }
      else if (mapping.permission !== 'primary_input') mapping.primary = false
      if (mapping.permission === 'primary_input' && !mapping.primary && this.mappings.some(item => item !== mapping && item.fieldCode === mapping.fieldCode && item.primary)) mapping.permission = 'read_only'
      mapping.occurrences = [{ sheet: this.form.componentType.toUpperCase(), row: mapping.row, col: mapping.col, rowCount: mapping.rowCount, colCount: mapping.colCount }]
      this.changeMappings(this.mappings, mapping.id)
    },
    removeMapping(mapping) {
      this.changeMappings(this.mappings.filter(item => item.id !== mapping.id))
    },
    async placeComponent(component, row, col) {
      if (!this.isTemplateDesign && component.componentType !== this.form.componentType) return this.$message.warning('组件类型与当前目标区域不兼容')
      if ((!this.isTemplateDesign && component.workbook.columnCount !== this.form.columnCount) || row + component.workbook.rowCount > this.form.rowCount || col + component.workbook.columnCount > this.form.columnCount) return this.$message.warning('组件尺寸超出目标区域')
      const sheet = this.spread.getActiveSheet()
      const occupied = component.workbook.cells?.some(cell => sheet.getValue(row + cell.row, col + cell.column) != null)
      if (occupied) return this.$message.warning('目标区域已有内容，无法覆盖；请选择空白单元格')
      const sourceMappings = Array.isArray(component.metadata?.mappings) ? component.metadata.mappings : []
      const collisions = sourceMappings.some(source => this.mappings.some(existing =>
        row + Number(source.row || 0) < existing.row + existing.rowCount && row + Number(source.row || 0) + Number(source.rowCount || 1) > existing.row &&
        col + Number(source.col || 0) < existing.col + existing.colCount && col + Number(source.col || 0) + Number(source.colCount || 1) > existing.col))
      if (collisions) return this.$message.warning('组件映射与目标区域的已有映射重叠，无法插入')
      try { await registerTemplateFunctions(this.spread, [this.spread.toJSON({ includeBindingSource: false }), component.metadata]) } catch (error) { return this.$message.error(error.message) }
      const before = copyMappings(this.mappings)
      const initializeIds = []
      for (const source of sourceMappings) {
        const targetRow = row + Number(source.row || 0), targetCol = col + Number(source.col || 0)
        const baseName = `${source.namedArea}_${normalizeCode(component.code)}`
        let namedArea = baseName, suffix = 2
        while (this.mappings.some(mapping => mapping.namedArea === namedArea)) namedArea = `${baseName}_${suffix++}`
        const mapping = this.hydrateMapping({ ...source, id: `${source.id || source.fieldCode}-${targetRow}-${targetCol}-${Date.now()}`,
          namedArea, row: targetRow, col: targetCol, occurrences: [{ sheet: this.form.componentType.toUpperCase(), row: targetRow, col: targetCol,
            rowCount: Number(source.rowCount) || 1, colCount: Number(source.colCount) || 1 }], issue: '' })
        const hasPrimary = this.mappings.some(existing => existing.fieldCode === mapping.fieldCode && existing.primary && existing.permission === 'primary_input')
        if (mapping.primary && hasPrimary) { mapping.primary = false; mapping.permission = 'read_only' }
        this.mappings.push(mapping)
        initializeIds.push(mapping.id)
      }
      this._committedMappings = before
      this.changeMappings(this.mappings, initializeIds[0] || null, initializeIds,
        (component.workbook.cells || []).map(cell => {
          const sourceRow = Number(cell.row) || 0
          const sourceColumn = Number(cell.column ?? cell.col) || 0
          const targetRow = row + sourceRow
          const targetColumn = col + sourceColumn
          return { ...cell, row: targetRow, column: targetColumn,
            ...(cell.formula ? { formula: shiftFormula(cell.formula, sourceRow, sourceColumn, targetRow, targetColumn, sheet) } : {}) }
        }))
      this.$message.success(`${component.metadata?.name || component.code} 已插入到目标区域`)
    },
    exportCells(sheet = this.spread.getActiveSheet()) {
      const output = []
      const rows = sheet.getRowCount(GC.Spread.Sheets.SheetArea.viewport)
      const cols = sheet.getColumnCount(GC.Spread.Sheets.SheetArea.viewport)
      for (let row = 0; row < rows; row += 1) for (let column = 0; column < cols; column += 1) {
        const value = sheet.getValue(row, column)
        const formula = sheet.getFormula(row, column)
        const tag = sheet.getTag(row, column)
        const bindingPath = sheet.getBindingPath(row, column)
        if ((value !== null && value !== undefined && value !== '') || formula || tag || bindingPath) output.push({ row, column, ...(bindingPath ? { bindingPath } : {}), ...(formula ? { formula } : { value }), ...(tag ? { tag } : {}) })
      }
      return output
    },
    exportPermissionTags(sheet = this.spread.getActiveSheet()) {
      const rows = [], columns = []
      for (let row = 0; row < sheet.getRowCount(); row += 1) {
        const tag = sheet.getTag(row, -1)
        if (tag != null) rows.push({ row, tag: typeof tag === 'string' ? tag : JSON.stringify({ ...tag, schemaVersion: 1 }) })
      }
      for (let col = 0; col < sheet.getColumnCount(); col += 1) {
        const tag = sheet.getTag(-1, col)
        if (tag != null) columns.push({ col, tag: typeof tag === 'string' ? tag : JSON.stringify({ ...tag, schemaVersion: 1 }) })
      }
      const tag = sheet.tag()
      return { sheet: tag == null ? null : typeof tag === 'string' ? tag : JSON.stringify({ ...tag, schemaVersion: 1 }), rows, columns }
    },
    importLocalWorkbook(event) {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file || !this.spread) return
      if (!/\.xlsx$/i.test(file.name)) return this.$message.warning('请选择 .xlsx 文件')
      if (file.size > 10 * 1024 * 1024) {
        return this.$message.warning(`工作簿超过支持上限 10 MB（当前 ${(file.size / (1024 * 1024)).toFixed(2)} MB）。请压缩或拆分文件后重试；如仍需导入，请联系模板管理员。`)
      }
      this.spread.import(file, () => {
        try {
          const sheetCount = this.spread.getSheetCount()
          if (!sheetCount) throw new Error('工作簿中没有可导入的工作表')
          this.importedWorkbookJson = this.spread.toJSON()
          this.importedWorkbookName = file.name
          this.importSheets = Array.from({ length: sheetCount }, (_, index) => ({ index, name: this.spread.getSheet(index)?.name() || `工作表 ${index + 1}` }))
          this.activeImportSheet = 0
          this.importedFromXlsx = true
          this.activateImportedSheet(0).catch(error => this.$message.error(`切换导入工作表失败：${error.message}`))
          this.$message.warning(`已打开 ${sheetCount} 张工作表。每张表须分别保存为组件草稿；字段和原生校验仍须治理后才能发布`)
        } catch (error) { this.$message.error(`打开 XLSX 失败：${error.message}`) }
      }, error => this.$message.error(`打开 XLSX 失败：${error.errorMessage || error.message || '文件无法读取'}`), { fileType: GC.Spread.Sheets.FileType.excel })
    },
    selectImportedSheet(index) {
      return this.activateImportedSheet(Number(index)).catch(error => this.$message.error(`切换导入工作表失败：${error.message}`))
    },
    async activateImportedSheet(index) {
      if (!this.importedWorkbookJson || !this.spread || !this.importSheets[index]) return
      await this.spread.fromJSON(this.importedWorkbookJson)
      this.spread.setActiveSheetIndex(index)
      const sheet = this.spread.getSheet(index)
      const sourceRows = sheet.getRowCount(GC.Spread.Sheets.SheetArea.viewport)
      const sourceColumns = sheet.getColumnCount(GC.Spread.Sheets.SheetArea.viewport)
      const baseName = this.importedWorkbookName.replace(/\.[^.]+$/, '').trim()
      const sheetSlug = normalizeCode(this.importSheets[index].name).toLowerCase().replace(/_+/g, '_').slice(0, 24) || `sheet_${index + 1}`
      const codeBase = baseName.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[^a-z]+/, 'import_').slice(0, 38) || 'import_workbook'
      this.versionId = null
      this.componentId = null
      this.component = null
      this.isDraft = true
      this.canEdit = true
      this.$router.replace({ query: {} })
      this.form = { ...this.form, name: `${baseName} · ${this.importSheets[index].name}（导入草稿）`.slice(0, 120), code: `${codeBase}_${sheetSlug}`.slice(0, 64),
        rowCount: sourceRows, columnCount: sourceColumns }
      this.mappings = []
      this.selectedMapping = null
      this.selectedTargetCell = null
      this.nativeValidations = this.collectNativeValidations()
      this.reconcileMappings(true)
    },
    focusValidation(validation) {
      const sheet = this.spread?.getActiveSheet()
      if (!sheet || !Number.isInteger(Number(validation.row)) || !Number.isInteger(Number(validation.col))) return
      const row = Number(validation.row), col = Number(validation.col)
      sheet.setActiveCell(row, col)
      sheet.showCell(row, col, GC.Spread.Sheets.VerticalPosition.top, GC.Spread.Sheets.HorizontalPosition.left)
    },
    markDraftDirty() { this.isDraft = true },
    openRuleCatalog() {
      const route = this.$router.resolve('/portal/rule-catalog')
      window.open(route.href, '_blank', 'noopener')
    },
    inspectWorkbookReferences() {
      const errors = []
      for (let sheetIndex = 0; sheetIndex < this.spread.getSheetCount(); sheetIndex += 1) {
        const sheet = this.spread.getSheet(sheetIndex)
        const rows = sheet.getRowCount(GC.Spread.Sheets.SheetArea.viewport)
        const cols = sheet.getColumnCount(GC.Spread.Sheets.SheetArea.viewport)
        for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
          const formula = sheet.getFormula(row, col)
          const value = sheet.getValue(row, col)
          if ((formula && /#REF!/i.test(formula)) || (typeof value === 'string' && /^#(?:REF!|VALUE!|DIV\/0!|NAME\?|N\/A|NUM!|NULL!)/i.test(value))) errors.push(`${sheet.name()}!R${row + 1}C${col + 1}`)
        }
      }
      if (errors.length) this.$message.error(`预览已阻止：发现 ${errors.length} 个公式引用或计算错误，例如 ${errors.slice(0, 3).join('、')}`)
      return errors
    },
    showPreviewBlob(blob, extension) {
      if (!blob?.size) return this.$message.error(`${extension.toUpperCase()} 预览未生成内容`)
      const url = URL.createObjectURL(blob)
      if (extension === 'pdf') {
        this.releasePdfPreview()
        this.pdfPreviewUrl = url
        this.pdfPreviewDialog = true
        return
      }
      const link = document.createElement('a')
      link.href = url
      link.target = '_blank'
      link.download = `${(this.form.code || 'template-preview').replace(/[^a-z0-9_-]/gi, '_')}-preview.${extension}`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      this.$message.success(`${extension.toUpperCase()} 预览文件已生成`)
    },
    releasePdfPreview() {
      if (this.pdfPreviewUrl) URL.revokeObjectURL(this.pdfPreviewUrl)
      this.pdfPreviewUrl = ''
    },
    previewXlsx() {
      if (!this.spread || this.inspectWorkbookReferences().length) return
      this.spread.export(blob => this.showPreviewBlob(blob, 'xlsx'), error => this.$message.error(`XLSX 预览失败：${error.errorMessage || error.message || '导出失败'}`), { fileType: GC.Spread.Sheets.FileType.excel, includeBindingSource: false })
    },
    async previewPdf() {
      if (!this.designerReady || !this.spread || this.pdfExporting || this.saving || this.submitting || this.inspectWorkbookReferences().length) return
      this.pdfExporting = true
      let pdfSpread
      try {
        await ensureSpreadPdfExport(GC)
        if (this._designerDisposed) return
        // Export a snapshot: preview print settings must not change the editable draft.
        pdfSpread = new GC.Spread.Sheets.Workbook()
        await pdfSpread.fromJSON(this.spread.toJSON())
        for (const sheet of pdfSpread.sheets) {
          const printInfo = sheet.printInfo()
          // Empty inputs (including watermark-only fields) still need a printable page.
          printInfo.useMax(false)
          if (printInfo.rowStart() < 0) printInfo.rowStart(0)
          if (printInfo.columnStart() < 0) printInfo.columnStart(0)
          if (printInfo.rowEnd() < 0) printInfo.rowEnd(sheet.getRowCount() - 1)
          if (printInfo.columnEnd() < 0) printInfo.columnEnd(sheet.getColumnCount() - 1)
          sheet.printInfo(printInfo)
        }
        const blob = await new Promise((resolve, reject) => pdfSpread.savePDF(resolve, reject, {
          title: this.form.name || '模板预览', creator: '成本指标平台'
        }))
        if (!this._designerDisposed) this.showPreviewBlob(blob, 'pdf')
      } catch (error) { if (!this._designerDisposed) this.$message.error(`PDF 预览失败：${error.errorMessage || error.message || '导出失败'}`) }
      finally { pdfSpread?.destroy(); this.pdfExporting = false }
    },
    readCurrentNativeValidator() {
      const sheet=this.spread?.getActiveSheet()
      const validator=sheet?.getDataValidator(sheet.getActiveRowIndex(),sheet.getActiveColumnIndex())
      this.nativeValidatorSummary=validator ? `${['任意值','整数','小数','列表','日期','时间','文本长度','自定义公式'][validator.type()] || '数据校验'} · ${validator.errorMessage() || '已设置'}` : '尚未设置'
    },
    applySelectedNativeRule() {
      const rule = this.nativeRuleOptions.find(item => item.versionId === this.selectedNativeRuleId)
      const sheet = this.spread?.getActiveSheet()
      if (!rule || !sheet || !this.canEdit) return
      try { applyNativeRule(sheet, sheet.getSelections(), rule.expression); this.spread.options.highlightInvalidData = true; this.collectNativeValidations(); this.readCurrentNativeValidator(); this.markDraftDirty(); this.$message.success('已应用到选中区域，保存模板后生效') } catch(error) { this.$message.error(error.message) }
    },
    clearSelectedNativeRule() {
      const sheet = this.spread?.getActiveSheet()
      if (!sheet || !this.canEdit) return
      for (const range of sheet.getSelections()) sheet.setDataValidator(Math.max(0,range.row),Math.max(0,range.col),range.row < 0 ? sheet.getRowCount() : range.rowCount,range.col < 0 ? sheet.getColumnCount() : range.colCount,null)
      this.collectNativeValidations(); this.readCurrentNativeValidator(); this.markDraftDirty(); this.$message.success('已清除选中区域的数据校验')
    },
    collectNativeValidations(sheet = this.spread.getActiveSheet(), previous = this.nativeValidations) {
      const validations = []
      for (let row = 0; row < sheet.getRowCount(); row += 1) for (let col = 0; col < sheet.getColumnCount(); col += 1) {
        if (!sheet.getDataValidator(row, col)) continue
        validations.push({ cell: `${row + 1},${col + 1}`, row, col, validator: sheet.getDataValidator(row, col).toJSON() })
      }
      if (sheet === this.spread.getActiveSheet()) this.nativeValidations = validations
      return validations
    },
    async saveDraft(returnToList = true) {
      if (this.hasPermissionDraft()) {
        this.switchInspector('permissions')
        this.showDesignPanel('inspectorPanel')
        this.$message.warning('还有未应用的权限修改，请先应用或放弃修改，再保存模板')
        return false
      }
      if (this.isTemplateDesign) return this.saveDirectTemplate(returnToList)
      if (this.saving || !this.canEdit) return false
      if (!this.spread) { this.$message.warning('设计器尚未初始化'); return false }
      const active = this.spread.getActiveSheet()
      if (active.isEditing() && !active.endEdit()) return false
      this.reconcileMappings()
      const payload = { rowCount: this.form.rowCount, columnCount: this.form.columnCount, cells: this.exportCells(), metadata: {
        name: this.form.name.trim(), mappings: this.mappings.map(({ ruleCodesText, issue, ...mapping }) => ({ ...mapping, ruleCodes: mapping.ruleCodes || [] })),
        designerJson: this.importedFromXlsx ? this.spread.getActiveSheet().toJSON({ includeBindingSource: false }) : this.spread.toJSON({ includeBindingSource: false }),
        designerJsonScope: this.importedFromXlsx ? 'worksheet' : 'workbook', schemaVersion: 1,
        managedFunctions: collectFunctionRefs(this.spread.toJSON({ includeBindingSource: false })),
        permissionTags: this.exportPermissionTags(),
        importedFromXlsx: this.importedFromXlsx,
        nativeValidations: this.collectNativeValidations()
      } }
      if (!payload.metadata.name) { this.$message.warning('请填写组件名称'); return false }
      this.saving = true
      try {
        if (this.versionId) await templateGovernanceApi.updateComponentVersion(this.versionId, payload)
        else {
          if (!/^[a-z][a-z0-9_-]{1,63}$/.test(this.form.code)) { this.$message.warning('稳定编码须为小写字母开头的英文编码'); return false }
          const created = await templateGovernanceApi.createComponent({ ...payload, code: this.form.code, componentType: this.form.componentType, name: this.form.name })
          this.versionId = created.versionId
          this.componentId = created.componentId
          this.$router.replace({ query: { versionId: String(created.versionId) } })
        }
        if (this.importedFromXlsx && this.importSheets[this.activeImportSheet]) this.importSheets[this.activeImportSheet].savedVersionId = this.versionId
        this.$message.success('组件草稿已保存')
        await this.loadCatalog()
        await this.loadComponent()
        this.rememberSavedDesign()
        if (returnToList) await this.$router.push('/portal/template?section=components')
        return true
      } catch (error) { this.$message.error(`保存组件草稿失败：${error.message}`); return false }
      finally { this.saving = false }
    },
    async submitDraft() {
      if (this.submitting || this.saving) return
      if (this.isTemplateDesign) return this.submitDirectTemplate()
      this.submitting = true
      try {
      if (this.issues.length) return this.$message.warning('请先修复 Mapping Inspector 中的结构异常')
      if (!await this.saveDraft(false)) return
      if (!this.versionId) return
        const result = await templateGovernanceApi.submitComponent(this.component?.id || this.componentId, this.versionId)
        this.$message.success(result.status === 'published' ? '组件已免审发布' : '组件已提交系统管理员审批')
        this.$router.push('/portal/template?section=components')
      } catch (error) { this.$message.error(`提交审核失败：${error.message}`) }
      finally { this.submitting = false }
    },
    undo() { if (!this.canEdit || !this.spread) return; const sheet = this.spread.getActiveSheet(); if (sheet.isEditing() && !sheet.endEdit()) return; this.spread.undoManager().undo(); this.reconcileMappings(true); this.refreshHistoryState() },
    redo() { if (!this.canEdit || !this.spread) return; const sheet = this.spread.getActiveSheet(); if (sheet.isEditing() && !sheet.endEdit()) return; this.spread.undoManager().redo(); this.reconcileMappings(true); this.refreshHistoryState() },
    openFieldDraft() { this.$refs.fieldProposal.open() },
    async onFieldProposalSaved(result) {
      this.fieldTab = result.status === 'approved' ? 'approved' : 'drafts'
      await this.loadCatalog()
    }
  }
}
</script>

<style scoped src="@/styles/designer-workbench.css"></style>
