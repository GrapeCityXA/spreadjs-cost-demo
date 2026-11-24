<template>
  <main ref="templatePage" class="governance-page portal-workbench template-library" :class="{ 'template-compact': compactList }">
    <header class="page-heading">
      <div>
        <h1>模板与组件</h1>
      </div>
      <el-radio-group :model-value="activeSection" aria-label="模板与组件分区" @change="changeSection"><el-tooltip content="管理可复用的 Header、Body、Footer 区域及其版本。" placement="top" :show-after="250" popper-class="template-help-tooltip" :trigger="['hover', 'focus']" :trigger-keys="[]"><el-radio-button value="components">组件库</el-radio-button></el-tooltip><el-tooltip content="查看直接设计或组件组合的多工作表模板。发布后不可修改，需要调整时创建新版本。" placement="top" :show-after="250" popper-class="template-help-tooltip" :trigger="['hover', 'focus']" :trigger-keys="[]"><el-radio-button value="templates">模板版本</el-radio-button></el-tooltip></el-radio-group>
    </header>

    <DemoNextStep text="模板设计完成后，下一步是发起填报任务。" label="下一步：发起填报" to="/portal/period-configuration" />

    <nav class="library-navigation" aria-label="模板与组件导航"><el-breadcrumb separator="/"><el-breadcrumb-item>模板与组件</el-breadcrumb-item><el-breadcrumb-item>{{ activeSection === 'components' ? '组件库' : '模板版本' }}</el-breadcrumb-item></el-breadcrumb>
      <div class="heading-actions">
        <el-tooltip v-if="activeSection === 'components'" content="设计可复用组件。其他 XLSX 可通过 Designer 文件菜单导入，导入后需配置字段映射和权限。" placement="top" :show-after="250" popper-class="template-help-tooltip" :trigger="['hover', 'focus']" :trigger-keys="[]"><el-button type="primary" :loading="openingWorkbench" @click="openWorkbench({ new: 'true' })">新建组件</el-button></el-tooltip>
        <input ref="quarterlyReferenceInput" type="file" accept=".xlsx" hidden @change="importQuarterlyReference" />
        <el-tooltip v-if="activeSection === 'templates' && !showcase" content="仅适用于项目指定的季度考核样例，导入后生成草稿；其他 XLSX 请通过 Designer 文件菜单导入。" placement="top" :show-after="250" popper-class="template-help-tooltip" :trigger="['hover', 'focus']" :trigger-keys="[]"><el-button :loading="importingReference" @click="$refs.quarterlyReferenceInput.click()">导入季度参考工作簿为 Draft</el-button></el-tooltip>
        <el-tooltip v-if="activeSection === 'templates'" content="按需选择已发布组件，组合为多工作表模板。" placement="top" :show-after="250"><el-button @click="openTemplateDialog">从组件组合</el-button></el-tooltip>
        <el-tooltip v-if="activeSection === 'templates'" content="直接打开 Designer 设计完整模板，可自由添加工作表、字段和填报权限。" placement="top" :show-after="250" popper-class="template-help-tooltip" :trigger="['hover', 'focus']" :trigger-keys="[]"><el-button type="primary" :loading="openingWorkbench" @click="openWorkbench({ mode: 'template', new: 'true' })">新建模板</el-button></el-tooltip>
      </div>
    </nav>
    <p v-if="openingWorkbench" role="status">正在打开设计器，首次加载可能需要一些时间，请稍候…</p>
    <el-alert v-if="workbenchError" class="template-status" :title="workbenchError" type="error" :closable="false" show-icon />
    <p v-if="Object.values(actionBusy).some(Boolean)" role="status">正在提交操作，请稍候…</p>
    <el-alert v-if="$route.query.notificationVersionId" title="正在查看提醒对应的版本" type="info" @close="changeSection(activeSection)" />
    <el-alert v-if="actionError" class="template-status" :title="actionError" type="error" :closable="false" show-icon>
      <el-button link @click="reload">刷新列表并核对</el-button>
    </el-alert>
    <section v-if="activeSection === 'components'" class="governance-section">
      <div class="section-heading">
        <h2>组件库</h2>
        <el-tag effect="plain">{{ componentsLoaded ? `${componentsFilteredCount} / ${components.length} 个版本` : componentsLoading ? '加载中…' : '加载失败' }}</el-tag>
      </div>
      <el-alert v-if="componentsError" :title="componentsError" type="error" :closable="false" show-icon><el-button link :loading="componentsLoading" @click="reload">重新加载</el-button></el-alert>
      <app-data-table accessible responsive virtual-filters filter-class-name="template-library-filter" table-label="组件版本" class="template-library-table" @filtered-count="componentsFilteredCount = $event" v-loading="componentsLoading" element-loading-text="正在加载组件…" :aria-busy="componentsLoading" :data="$route.query.notificationVersionId ? components.filter(row => row.versionId === Number($route.query.notificationVersionId)) : components" row-key="versionId" :empty-text="componentsLoading ? '正在加载组件…' : componentsError ? '组件列表加载失败，请重试。' : '暂无可访问的组件版本。'">
        <el-table-column :column-value="row => row.metadata?.name || row.code" label="组件" min-width="220">
          <template #default="{ row }"><strong>{{ row.metadata?.name || row.code }}</strong><small class="subline">{{ row.code }}</small></template>
        </el-table-column>
        <el-table-column :column-value="row => typeLabel[row.componentType]" label="类型" width="110"><template #default="{ row }">{{ typeLabel[row.componentType] }}</template></el-table-column>
        <el-table-column :column-value="row => row.version" label="版本" width="90"><template #default="{ row }">v{{ row.version }}</template></el-table-column>
        <el-table-column :column-value="row => row.ownerName" label="维护人" min-width="145"><template #default="{ row }">{{ row.ownerName }}<small v-if="row.ownerId === userId" class="owner-mark">你</small></template></el-table-column>
        <el-table-column :column-value="row => statusLabel[row.status] || row.status" label="状态" width="115"><template #default="{ row }"><el-tag :type="statusType[row.status] || 'info'">{{ statusLabel[row.status] || row.status }}</el-tag></template></el-table-column>
        <el-table-column label="操作" min-width="245">
          <template #default="{ row }"><TemplateRecordActions kind="component" :row="row" :maintain="canMaintain(row.ownerId)" :admin="isSystemAdmin" :workflow-from="$route.query.workflowFrom" :busy="rowBusy('component', row)" :modifying-version-id="modifyingTemplateVersionId" @action="(action, record) => recordAction('component', action, record)" /></template>
        </el-table-column>
        <template #compact="{ rows, expanded }"><TemplateRecordSummary v-if="compactList && !expanded" kind="component" :rows="rows" :status-type="statusType" :status-label="statusLabel" :type-label="typeLabel" :scope-label="scopeLabel" :can-maintain="canMaintain" :row-busy="rowBusy" :user-id="userId" :admin="isSystemAdmin" :workflow-from="$route.query.workflowFrom" :modifying-version-id="modifyingTemplateVersionId" :loading="componentsLoading" :error="componentsError" @action="(action, record) => recordAction('component', action, record)" /></template>
      </app-data-table>
    </section>

    <section v-if="activeSection === 'templates'" class="governance-section">
      <div class="section-heading">
        <h2>模板版本</h2>
        <el-tag effect="plain">{{ templatesLoaded ? `${templatesFilteredCount} / ${templates.length} 个版本` : templatesLoading ? '加载中…' : '加载失败' }}</el-tag>
      </div>
      <el-alert v-if="templatesError" :title="templatesError" type="error" :closable="false" show-icon><el-button link :loading="templatesLoading" @click="reload">重新加载</el-button></el-alert>
      <app-data-table accessible responsive virtual-filters filter-class-name="template-library-filter" table-label="模板版本" class="template-library-table" @filtered-count="templatesFilteredCount = $event" v-loading="templatesLoading" element-loading-text="正在加载模板…" :aria-busy="templatesLoading" :data="$route.query.notificationVersionId ? templates.filter(row => row.versionId === Number($route.query.notificationVersionId)) : templates" row-key="versionId" :empty-text="templatesLoading ? '正在加载模板…' : templatesError ? '模板列表加载失败，请重试。' : '暂无可访问的模板版本。'">
        <el-table-column :column-value="row => row.name" label="模板" min-width="210"><template #default="{ row }"><strong>{{ row.name }}</strong><small v-if="scopeLabel(row.factory)" class="subline">{{ scopeLabel(row.factory) }}</small></template></el-table-column>
        <el-table-column :column-value="row => row.version" label="版本" width="85"><template #default="{ row }">v{{ row.version }}</template></el-table-column>
        <el-table-column :column-value="row => row.sheetCount || 0" label="工作表" width="100"><template #default="{ row }">{{ row.sheetCount || 0 }} 张</template></el-table-column>
        <el-table-column :column-value="row => row.ownerName" label="维护人" min-width="145"><template #default="{ row }">{{ row.ownerName }}<small v-if="row.ownerId === userId" class="owner-mark">你</small></template></el-table-column>
        <el-table-column :column-value="row => statusLabel[row.status] || row.status" label="状态" width="115"><template #default="{ row }"><el-tag :type="statusType[row.status] || 'info'">{{ statusLabel[row.status] || row.status }}</el-tag></template></el-table-column>
        <el-table-column label="操作" min-width="280">
          <template #default="{ row }"><TemplateRecordActions kind="template" :row="row" :maintain="canMaintain(row.ownerId)" :admin="isSystemAdmin" :workflow-from="$route.query.workflowFrom" :busy="rowBusy('template', row)" :modifying-version-id="modifyingTemplateVersionId" @action="(action, record) => recordAction('template', action, record)" /></template>
        </el-table-column>
        <template #compact="{ rows, expanded }"><TemplateRecordSummary v-if="compactList && !expanded" kind="template" :rows="rows" :status-type="statusType" :status-label="statusLabel" :type-label="typeLabel" :scope-label="scopeLabel" :can-maintain="canMaintain" :row-busy="rowBusy" :user-id="userId" :admin="isSystemAdmin" :workflow-from="$route.query.workflowFrom" :modifying-version-id="modifyingTemplateVersionId" :loading="templatesLoading" :error="templatesError" @action="(action, record) => recordAction('template', action, record)" /></template>
      </app-data-table>
    </section>

    <el-dialog v-model="templateDialog" class="template-composition-dialog" top="5vh" :title="templateForm.versionId ? `编辑模板 v${templateForm.version}` : '从组件组合模板'" width="min(900px, calc(100% - 32px))" :before-close="closeComposition" :close-on-click-modal="false" :show-close="!savingTemplate" destroy-on-close @closed="endComponentDrag">
      <div v-if="Object.keys(compositionErrors).length" class="composition-error-summary" role="alert">
        <strong>请修正以下 {{ Object.keys(compositionErrors).length }} 项后再保存</strong>
        <ul><li v-for="(message, path) in compositionErrors" :key="path"><button type="button" @click="focusCompositionField(path)">{{ message }}</button></li></ul>
      </div>
      <el-alert v-if="compositionSaveError" ref="compositionSaveNotice" tabindex="-1" class="composition-status" :title="compositionSaveError" type="error" :closable="false" show-icon><p>填写内容已保留。{{ saveOutcomeUnknown ? '请先核对模板版本列表，避免重复新建。' : '修正问题后，可再次点击保存。' }}</p><template v-if="saveOutcomeUnknown"><a :href="templateListHref" target="_blank" rel="noopener">在新页面核对模板版本</a><el-button @click="saveOutcomeUnknown = false; compositionSaveError = ''">已核对未保存，允许重试</el-button></template></el-alert>
      <p v-if="savingTemplate" role="status" class="composition-status">{{ compositionSaveSlow ? '保存仍在处理中，请稍候；请勿重复提交或关闭页面。' : '正在保存模板，请稍候…' }}</p>
      <el-form ref="compositionForm" :model="templateForm" :disabled="savingTemplate" label-position="top" @submit.prevent="saveTemplate(false)">
        <div class="form-grid template-meta-form">
          <el-form-item label="模板名称" required :error="compositionErrors.name" data-composition-field="name"><el-input v-model="templateForm.name" :aria-invalid="Boolean(compositionErrors.name)" /></el-form-item>
          <el-form-item v-if="!showcase" label="适用范围"><el-select v-model="templateForm.factory" popper-class="composition-select-menu" filterable placeholder="选择适用组织"><el-option label="全部组织" value="ALL" /><el-option v-for="org in organizations" :key="org.id" :label="`${org.name} · ${org.code}`" :value="org.code" /><el-option v-if="templateForm.factory && templateForm.factory !== 'ALL' && !organizations.some(org => org.code === templateForm.factory)" :label="`${templateForm.factory}（原有范围）`" :value="templateForm.factory" /></el-select></el-form-item>
          <el-form-item label="描述" class="span-two"><el-input v-model="templateForm.description" /></el-form-item>
        </div>
        <div class="sheet-heading" data-composition-field="sheets"><h3>工作表组成 <small>{{ templateForm.sheets.length }} / 30</small></h3><el-button size="small" :disabled="savingTemplate || templateForm.sheets.length >= 30" @click="addSheet">添加工作表</el-button></div>
        <p v-if="componentsLoading" class="composition-status" role="status">正在加载可用组件…</p>
        <el-alert v-else-if="componentsError" class="composition-status" :title="componentsError" type="error" :closable="false" show-icon><el-button :loading="componentsLoading" @click="loadCompositionComponents">重新加载组件</el-button></el-alert>
        <el-alert v-else-if="!publishedComponents().length" class="composition-status" title="暂无已发布组件" description="业务工作表需要已发布的 Body 组件。请先在组件库发布组件，再重新加载；也可以添加只读辅助工作表。" type="info" :closable="false" show-icon><el-button @click="loadCompositionComponents">重新加载组件</el-button></el-alert>
        <p class="composition-touch-hint">在每张工作表下方选择组件；业务工作表必须选择 Body 组件。</p>
        <div v-if="!componentsLoading && !componentsError && publishedComponents().length" class="component-drag-palette" aria-label="已发布组件拖放区">
          <span class="palette-label">拖入任意业务工作表，组件会按 Header / Body / Footer 类型自动归位，无需对准区域。</span>
          <button v-for="component in publishedComponents()" :key="component.versionId" type="button" class="component-drag-card" :disabled="savingTemplate" :draggable="!savingTemplate" @dragstart="startTemplateComponentDrag($event, component)" @dragend="endComponentDrag" @click="explainComponentSelection">
            <el-tag size="small" effect="plain">{{ typeLabel[component.componentType] }}</el-tag><strong>{{ component.metadata?.name || component.code }}</strong><small>v{{ component.version }} · {{ component.workbook?.columnCount }} 列</small>
          </button>
          <span v-if="!publishedComponents().length" class="palette-label">暂无已发布组件</span>
        </div>
        <div v-for="(sheet, index) in templateForm.sheets" :key="sheet.key" class="sheet-card" :class="{ 'sheet-drop-active': templateDropTarget.startsWith(`${sheet.key}:`) }" @dragover="overTemplateSheet($event, sheet)" @dragleave="clearTemplateDropTarget" @drop="dropTemplateComponent($event, sheet)">
          <div class="sheet-row-title"><strong>工作表 {{ index + 1 }}</strong><el-button link type="danger" :disabled="savingTemplate || templateForm.sheets.length <= 1" @click="removeSheet(index)">移除</el-button></div>
          <div class="sheet-controls">
            <el-form-item label="工作表名称" required :error="compositionErrors[`sheets.${index}.name`]" :data-composition-field="`sheets.${index}.name`"><el-input v-model="sheet.name" :aria-invalid="Boolean(compositionErrors[`sheets.${index}.name`])" :aria-label="`工作表 ${index + 1} 名称`" :disabled="savingTemplate || Boolean(sheet.inlineWorkbook)" placeholder="名称" /></el-form-item>
            <el-form-item label="稳定编码" required :error="compositionErrors[`sheets.${index}.code`]" :data-composition-field="`sheets.${index}.code`"><el-input v-model="sheet.code" :aria-invalid="Boolean(compositionErrors[`sheets.${index}.code`])" :aria-label="`工作表 ${index + 1} 稳定编码`" :disabled="savingTemplate || Boolean(sheet.inlineWorkbook)" placeholder="稳定编码" /></el-form-item>
            <el-form-item label="工作表类型"><el-select v-model="sheet.type" :aria-label="`工作表 ${index + 1} 类型`" popper-class="composition-select-menu" :disabled="savingTemplate || Boolean(sheet.inlineWorkbook)" placeholder="类型" @change="onSheetTypeChanged(sheet)"><el-option label="业务工作表" value="business" /><el-option label="只读辅助工作表" value="auxiliary" /></el-select></el-form-item>
          </div>
          <el-alert v-if="sheet.inlineWorkbook" title="已详细修改：此工作表保留 Designer 设计，不能再拖拽或替换组件。请点击下方“详细修改”继续编辑。" type="info" :closable="false" show-icon />
          <div v-else-if="sheet.type === 'business'" class="component-selects">
            <div class="composition-column-head" aria-hidden="true"><span></span><span v-for="letter in ['A', 'B', 'C', 'D', 'E', 'F']" :key="letter">{{ letter }}</span></div>
            <div v-for="(type, regionIndex) in ['header', 'body', 'footer']" :key="type" class="component-drop-slot" :data-region="type" :data-composition-field="`sheets.${index}.${type}VersionId`" :class="{ 'drop-target': !savingTemplate && templateDropTarget === `${sheet.key}:${type}` }">
              <span class="composition-row-head" aria-hidden="true">{{ regionIndex + 1 }}</span>
              <div class="component-region-content">
              <span class="slot-label"><strong>{{ typeLabel[type] }} · {{ { header: '表头', body: '主体', footer: '表尾' }[type] }}</strong><span>{{ type === 'body' ? '必选' : '可选' }}</span></span>
              <el-select v-model="sheet[`${type}VersionId`]" filterable :disabled="savingTemplate || componentsLoading || Boolean(componentsError)" :aria-invalid="Boolean(compositionErrors[`sheets.${index}.${type}VersionId`])" :aria-describedby="compositionErrors[`sheets.${index}.${type}VersionId`] ? `composition-${index}-${type}-error` : undefined" :aria-label="`工作表 ${index + 1} ${typeLabel[type]} 组件${type === 'body' ? '（必选）' : '（可选）'}`" popper-class="composition-select-menu" :clearable="type !== 'body'" :placeholder="`${typeLabel[type]} 组件${type === 'body' ? '（必选）' : '（可选）'}`" @change="validateComponentSelection(sheet)"><el-option v-for="c in publishedComponents(type)" :key="c.versionId" :label="componentOption(c)" :value="c.versionId" /></el-select>
              <p v-if="templateDropTarget === `${sheet.key}:${type}`" class="component-snap-hint" role="status">松开即可放入 {{ typeLabel[type] }} 区域</p>
              <p v-if="compositionErrors[`sheets.${index}.${type}VersionId`]" :id="`composition-${index}-${type}-error`" class="composition-field-error">{{ compositionErrors[`sheets.${index}.${type}VersionId`] }}</p>
              </div>
            </div>
          </div>
          <div v-else class="auxiliary-editor" :data-composition-field="`sheets.${index}.auxiliary`">
            <p v-if="compositionErrors[`sheets.${index}.auxiliary`]" class="composition-field-error" role="alert">{{ compositionErrors[`sheets.${index}.auxiliary`] }}</p>
            <el-radio-group v-model="sheet.auxiliary.sourceMode"><el-radio-button value="fixed">固定内容</el-radio-button><el-radio-button value="remote">接口数据</el-radio-button></el-radio-group>
            <AuxiliaryDataEditor v-if="sheet.auxiliary.sourceMode === 'remote'" v-model="sheet.auxiliary.dataBinding" class="auxiliary-editor" />
            <template v-else>
            <p class="form-hint">填写报表标题、填报说明等固定内容，随模板版本保存；填报人员只能查看，不能在任务中修改。</p>
            <div class="auxiliary-grid-size"><label>行数<el-input-number v-model="sheet.auxiliary.rowCount" :aria-label="`工作表 ${index + 1} 行数`" :min="1" :max="200" /></label><label>列数<el-input-number v-model="sheet.auxiliary.columnCount" :aria-label="`工作表 ${index + 1} 列数`" :min="1" :max="100" /></label></div>
            <el-form-item label="辅助表固定内容（标题、说明等，JSON）">
              <el-input v-model="sheet.auxiliary.cellsJson" type="textarea" :rows="4" placeholder='例如：[ { "row": 0, "column": 0, "value": "填报说明" } ]' />
            </el-form-item>
            </template>
          </div>
        </div>
      </el-form>
      <template #footer><div class="composition-actions"><el-button :disabled="savingTemplate" @click="closeComposition()">取消</el-button><el-button :loading="savingTemplate" :disabled="saveOutcomeUnknown" @click="saveTemplate(false)">保存草稿</el-button><el-tooltip content="保存当前工作表组成并进入 Designer。只锁定实际修改并保存过的工作表，其他工作表仍可组合调整。" placement="top"><el-button type="primary" :loading="savingTemplate" :disabled="saveOutcomeUnknown" @click="saveTemplate(true)">详细修改</el-button></el-tooltip></div></template>
    </el-dialog>

    <el-dialog v-model="previewDialog" class="template-preview-dialog template-state-dialog" title="成品模板预览" width="94vw" destroy-on-close @opened="onPreviewOpened" @close="closeTemplatePreview">
      <p v-if="previewTemplate" class="preview-owner">维护人：{{ previewTemplate?.ownerName }} · v{{ previewTemplate?.version }} · {{ statusLabel[previewTemplate?.status] }}</p>
      <el-alert v-if="previewErrors.length" type="error" :closable="false" show-icon :title="`预览发现 ${previewErrors.length} 项问题：${previewErrors.slice(0, 3).join('；')}`" />
      <el-alert v-if="previewFailure" class="template-status" :title="previewFailure" type="error" :closable="false" show-icon><el-button link @click="viewTemplate(previewRow)">重新加载预览</el-button></el-alert>
      <p v-if="previewLoading" role="status" aria-live="polite">正在加载工作簿并检查映射与公式，请稍候…</p>
      <div ref="templatePreviewHost" v-loading="previewLoading" :aria-busy="previewLoading" class="template-preview-host"></div>
      <p v-if="previewReady && !previewErrors.length" class="preview-footnote">必填映射锚点和单元格公式检查已完成。分页截断请在 PDF 中确认。</p>
      <p v-else-if="previewErrors.length" class="preview-footnote">请在 Designer 中修复以上问题，再重新打开预览；当前不能导出。</p>
      <template #footer>
        <el-button @click="previewDialog = false">关闭</el-button>
        <el-button :disabled="!previewReady || previewLoading || !!previewFailure || !previewSpread || previewErrors.length > 0" :loading="xlsxExporting" @click="exportTemplateXlsx">{{ xlsxExporting ? '正在准备 XLSX…' : '导出 XLSX 预览' }}</el-button>
        <el-button type="primary" :disabled="!previewReady || previewLoading || !!previewFailure || !previewSpread || previewErrors.length > 0" :loading="pdfExporting" @click="exportTemplatePdf">打开 PDF 预览</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="pdfPreviewDialog" class="template-pdf-dialog" title="PDF 成品预览" width="92vw" destroy-on-close @closed="releasePdfPreview">
      <iframe v-if="pdfPreviewUrl" :src="pdfPreviewUrl" class="pdf-preview-frame" title="模板 PDF 预览" />
    </el-dialog>

    <el-dialog v-model="publicationDialog" class="template-state-dialog" title="模板发布检查" width="min(780px, calc(100% - 32px))" @close="closePublication">
      <p v-if="publicationLoading" role="status">正在检查模板发布条件…</p>
      <el-alert v-if="publicationError" :title="publicationError" type="error" :closable="false" show-icon><el-button link @click="checkPublication(publicationRow)">重新检查</el-button></el-alert>
      <template v-if="publicationReport">
        <el-alert :title="publicationReport.passed ? '全部发布门禁已通过' : `有 ${publicationReport.issues.length} 项需要修复`" :type="publicationReport.passed ? 'success' : 'error'" :closable="false" show-icon />
        <app-data-table accessible table-label="发布检查结果" :data="publicationReport.checks" size="small" class="publication-checks">
          <el-table-column prop="label" label="检查项" />
          <el-table-column :column-value="row => row.passed ? '通过' : row.issues.length + ' 项阻断'" label="结果" width="110"><template #default="{ row }"><el-tag :type="row.passed ? 'success' : 'danger'">{{ row.passed ? '通过' : `${row.issues.length} 项阻断` }}</el-tag></template></el-table-column>
        </app-data-table>
        <app-data-table accessible table-label="发布检查问题" v-if="publicationReport.issues.length" :data="publicationReport.issues" size="small" max-height="280" class="publication-issues">
          <el-table-column prop="message" label="问题" min-width="300" />
          <el-table-column :column-value="row => (row.sheet || '模板') + (row.namedArea ? ' · ' + row.namedArea : '')" label="位置" min-width="150"><template #default="{ row }">{{ row.sheet || '模板' }}{{ row.namedArea ? ` · ${row.namedArea}` : '' }}</template></el-table-column>
          <el-table-column label="操作" width="150"><template #default="{ row }">
            <el-button v-if="row.componentVersionId" link type="primary" @click="openIssue(row)">打开对象</el-button>
            <el-button v-for="(target, index) in row.objects || []" :key="`${target.componentVersionId}:${target.cell || index}`" link type="primary" @click="openIssue(row, target)">{{ target.cell ? `定位 ${target.cell}` : '打开组件' }}</el-button>
            <el-button v-if="row.code === 'version_metadata_invalid'" link type="primary" @click="openIssue(row)">编辑模板</el-button>
          </template></el-table-column>
        </app-data-table>
        <div class="role-preview-bar">
          <strong>角色预览</strong>
          <el-select v-model="previewRole" aria-label="预览角色" size="small" @change="loadRolePreview"><el-option label="填报人" value="subsidiary_filler" /><el-option label="管理部门" value="management" /><el-option label="审核人" value="department_reviewer" /></el-select>
        </div>
        <p v-if="roleLoading" role="status">正在加载所选角色的权限…</p>
        <el-alert v-if="roleError" :title="roleError" type="error" :closable="false" show-icon><el-button link @click="loadRolePreview">重新加载角色预览</el-button></el-alert>
        <app-data-table accessible table-label="角色权限预览" v-if="rolePreviewData" :data="rolePreviewRows" size="small" max-height="220">
          <el-table-column prop="sheetName" label="工作表" width="130" />
          <el-table-column prop="fieldCode" label="字段 / 区域" min-width="180" />
          <el-table-column prop="visibility" label="可见性" width="110" />
          <el-table-column prop="editability" label="编辑状态" width="110" />
        </app-data-table>
      </template>
      <template #footer><el-button @click="publicationDialog = false">关闭</el-button></template>
    </el-dialog>
    <el-dialog v-model="reviewDialog" title="退回修改" width="min(480px, calc(100% - 32px))" class="template-review-dialog template-state-dialog" :close-on-click-modal="false" :close-on-press-escape="!reviewSaving" :show-close="!reviewSaving" :before-close="closeReview">
      <p class="review-object">{{ reviewTarget?.name }} · v{{ reviewTarget?.version }}</p>
      <el-form label-position="top" @submit.prevent="submitRejection">
        <el-form-item label="退回原因" required :error="reviewValidation">
          <el-input ref="reviewReason" v-model="reviewNote" aria-label="退回原因" :aria-invalid="!!reviewValidation" :disabled="reviewSaving" type="textarea" :rows="4" maxlength="500" show-word-limit placeholder="请说明需要修改的内容，便于维护人处理。" />
        </el-form-item>
      </el-form>
      <el-alert v-if="reviewError" :title="reviewError" type="error" :closable="false" show-icon />
      <template #footer><el-button :disabled="reviewSaving" @click="closeReview()">取消</el-button><el-button v-if="reviewOutcomeUnknown" @click="reviewDialog = false; reload()">刷新列表并核对</el-button><el-button v-else type="primary" :loading="reviewSaving" @click="submitRejection">确认退回</el-button></template>
    </el-dialog>
    <div ref="quarterlyImportHost" class="quarterly-import-host" aria-hidden="true" />
  </main>
</template>

<script>
import { returnToWorkflow } from '@/utils/workflowNavigation'
import { markRaw } from 'vue'
import { createWorkflowRequest } from '@/utils/workflowRequest'
import { readSessionUser } from '@/utils/authSession'
import { templateWorkflowQuery, templateWriteError } from '@/utils/templatePageState'
import { scanTemplateFormulaErrors } from '@/utils/templatePreviewScan'
import { MAX_COMPOSITION_SHEETS, nextSheetIndex, compositionFingerprint, validateComposition, compositionRequestError, readCompositionComponents } from '@/components/compositionState'
import GC from '@grapecity-software/spread-sheets'
import '@grapecity-software/spread-sheets/styles/gc.spread.sheets.excel2013white.css'
import { ensureSpreadIo } from '@/utils/spreadIo'
import '@grapecity-software/spread-sheets-print'
import { templateGovernanceApi } from '@/api'
import DemoNextStep from '@/components/DemoNextStep.vue'
import quarterlyReferenceProfile from '../../shared/quarterly-reference-profile.json'
import { SHOWCASE } from '@/config/showcase'
import { ensureSpreadPdfExport } from '@/utils/spreadPdfFonts'
import { observeWorkbookLayout } from '@/utils/observeWorkbookLayout'
import { loadTemplateWorkbook } from '@/template/composedTemplateWorkbook'
import AuxiliaryDataEditor from '@/components/AuxiliaryDataEditor.vue'
import TemplateRecordActions from '@/components/TemplateRecordActions.vue'
import TemplateRecordSummary from '@/components/TemplateRecordSummary.vue'
import { normalizeAuxiliaryBinding, disposeAuxiliaryData } from '@/template/auxiliaryDataBinding'

const blankAuxiliary = () => ({ rowCount: 1, columnCount: 1, cellsJson: '[]', sourceMode: 'fixed', dataBinding: { engine: 'datamanager', url: '', dataPath: '' } })
const blankSheet = (index = 0) => ({ key: `${Date.now()}-${index}-${Math.random()}`, code: index === 0 ? 'main' : `sheet_${index + 1}`, name: index === 0 ? '业务数据' : `工作表 ${index + 1}`, type: 'business', headerVersionId: null, bodyVersionId: null, footerVersionId: null, auxiliary: blankAuxiliary() })

export default {
  name: 'Template',
  components: { AuxiliaryDataEditor, TemplateRecordActions, TemplateRecordSummary, DemoNextStep },
  data() {
    const user = readSessionUser()
    return {
      showcase: SHOWCASE,
      userId: Number(user.id),
      isSystemAdmin: (Array.isArray(user.roles) ? user.roles : []).some(role => role.code === 'system_admin'),
      organizations: [], components: [], templates: [],
      compactList: false, componentsFilteredCount: 0, templatesFilteredCount: 0,
      actionBusy: {}, actionUnknown: {}, actionError: '',
      openingWorkbench: false, workbenchError: '',
      reviewDialog: false, reviewTarget: null, reviewNote: '', reviewValidation: '', reviewError: '', reviewSaving: false, reviewOutcomeUnknown: false,
      previewRow: null, previewLoading: false, previewReady: false, previewFailure: '',
      publicationRow: null, publicationLoading: false, publicationError: '', roleLoading: false, roleError: '',
      componentsLoading: true, templatesLoading: true, componentsLoaded: false, templatesLoaded: false,
      componentsError: '', templatesError: '',
      draggingTemplateComponent: null, templateDropTarget: '',
      templateDialog: false, previewDialog: false, previewTemplate: null, previewSpread: null, previewErrors: [], pdfPreviewDialog: false, pdfPreviewUrl: '', pdfExporting: false, xlsxExporting: false,
      publicationDialog: false, publicationReport: null, previewRole: 'subsidiary_filler', rolePreviewData: null,
      typeLabel: { header: 'Header', body: 'Body', footer: 'Footer' },
      statusLabel: { draft: '草稿', in_review: '审核中', published: '已发布', superseded: '已替代', rejected: '已退回' },
      statusType: { draft: 'info', in_review: 'warning', published: 'success', superseded: 'info', rejected: 'danger' },
      templateForm: { templateId: null, versionId: null, version: null, name: '', description: '', factory: '', sheets: [blankSheet()] },
      compositionBaseline: '', validationAttempted: false, componentSelectionChecked: false,
      compositionSaveError: '', compositionSaveSlow: false, saveOutcomeUnknown: false,
      importingReference: false, stopPreviewLayout: null, modifyingTemplateVersionId: null, savingTemplate: false
    }
  },
  async mounted() {
    // 1000px table + 40px section padding + 2px section border.
    this._listLayoutObserver = new ResizeObserver(([entry]) => { this.compactList = entry.contentRect.width <= 1042 })
    this._listLayoutObserver.observe(this.$refs.templatePage)
    window.addEventListener('beforeunload', this.protectCompositionUnload)
    window.addEventListener('blur', this.endComponentDrag)
    await this.reload()
    if (this._templateDisposed) return
    const editVersionId = Number(this.$route.query.editVersionId)
    const row = this.templates.find(item => Number(item.versionId) === editVersionId)
    if (row) await this.editTemplate(row)
  },
  computed: {
    templateListHref() { return `${import.meta.env.BASE_URL}portal/template?section=templates` },
    compositionDirty() { return this.templateDialog && compositionFingerprint(this.templateForm) !== this.compositionBaseline },
    compositionErrors() {
      if (!this.validationAttempted && !this.componentSelectionChecked) return {}
      const errors = this.checkComposition()
      return this.validationAttempted ? errors : Object.fromEntries(Object.entries(errors).filter(([path]) => path.endsWith('VersionId')))
    },
    activeSection() { return this.$route.query.section === 'components' ? 'components' : 'templates' },
    rolePreviewRows() { return (this.rolePreviewData?.sheets || []).flatMap(sheet => (sheet.mappings || []).map(mapping => ({ sheetName: sheet.name, fieldCode: mapping.fieldCode, visibility: mapping.visibility, editability: mapping.editability }))) }
  },
  watch: { '$route.query.notificationVersionId'() { this.reload() } },
  async beforeRouteLeave() { return this.allowCompositionLeave() },
  async beforeRouteUpdate() { return this.allowCompositionLeave() },
  beforeUnmount() {
    this._templateDisposed = true
    this._listLayoutObserver?.disconnect()
    this._componentController?.abort()
    Object.values(this._templateReads || {}).forEach(read => read.dispose())
    clearTimeout(this._compositionSaveTimer)
    window.removeEventListener('beforeunload', this.protectCompositionUnload)
    window.removeEventListener('blur', this.endComponentDrag)
    this.destroyTemplatePreview()
    this.releasePdfPreview()
  },
  methods: {
    recordAction(kind, action, row) {
      if (action === 'approve' || action === 'reject') return kind === 'component' ? this.reviewComponent(row, action) : this.reviewTemplate(row, action)
      const method = kind === 'component'
        ? { edit: 'openComponentWorkbench', submit: 'submitComponent', version: 'createComponentVersionInWorkbench' }[action]
        : { edit: 'editTemplate', submit: 'submitTemplate', version: 'createTemplateVersion', check: 'checkPublication', preview: 'viewTemplate' }[action]
      if (method) return this[method](row)
    },
    changeSection(section) {
      return this.$router.replace({ query: templateWorkflowQuery(this.$route, { section }), hash: this.$route.hash })
    },
    async openWorkbench(query) {
      if (this.openingWorkbench || this._templateDisposed) return
      this.openingWorkbench = true
      this.workbenchError = ''
      try {
        return await this.$router.push({ path: '/portal/template-workbench', query: templateWorkflowQuery(this.$route, query) })
      } catch (error) {
        if (!this._templateDisposed) this.workbenchError = '设计器加载失败，请检查网络后重新点击；若仍无法打开，请刷新页面后重试。'
      } finally {
        this.openingWorkbench = false
      }
    },
    cancelRead(key) { this._templateReads?.[key]?.dispose() },
    runRead(key, options) {
      if (this._templateDisposed) return Promise.resolve()
      this.cancelRead(key)
      this._templateReads ||= {}
      const read = createWorkflowRequest({ start() {}, finish() {}, ...options })
      this._templateReads[key] = read
      return read.run()
    },
    rowBusy(kind, row) { return !!(this.actionBusy[`${kind}:${row.versionId}`] || this.actionUnknown[`${kind}:${row.versionId}`]) },
    async runRowAction(kind, row, action) {
      const key = `${kind}:${row.versionId}`
      if (this.rowBusy(kind, row) || this._templateDisposed) return
      this.actionBusy[key] = true
      this.actionError = ''
      try {
        const id = kind === 'component' ? row.id : row.templateId
        const noun = kind === 'component' ? '组件' : '模板'
        const result = action === 'submit'
          ? await templateGovernanceApi[kind === 'component' ? 'submitComponent' : 'submitTemplate'](id, row.versionId)
          : await templateGovernanceApi[kind === 'component' ? 'reviewComponent' : 'reviewTemplate'](id, row.versionId, { action })
        if (this._templateDisposed) return
        this.$message.success(result.status === 'published' ? `${noun}已发布` : `${noun}已提交审核`)
        this.actionBusy[key] = false
        if (action !== 'submit' && returnToWorkflow(this)) return
        await this.reload()
      } catch (error) {
        if (!this._templateDisposed) {
          this.actionUnknown[key] = !error.status
          this.actionError = templateWriteError(error, action === 'submit' ? '提交审核' : '批准发布')
        }
      } finally { this.actionBusy[key] = false }
    },
    openRejection(kind, row) {
      if (this.rowBusy(kind, row) || this.reviewDialog) return
      this.reviewTarget = { kind, row, name: row.name || row.metadata?.name || row.code, version: row.version }
      this.reviewNote = this.reviewValidation = this.reviewError = ''
      this.reviewOutcomeUnknown = false
      this.reviewDialog = true
    },
    closeReview(done) {
      if (this.reviewSaving) return
      this.reviewDialog = false
      if (typeof done === 'function') done()
    },
    async submitRejection() {
      if (this.reviewSaving || this.reviewOutcomeUnknown || !this.reviewTarget) return
      const note = this.reviewNote.trim()
      this.reviewValidation = !note ? '请填写退回原因。' : note.length > 500 ? '退回原因不能超过 500 字。' : ''
      if (this.reviewValidation) { this.$refs.reviewReason?.focus(); return }
      const { kind, row } = this.reviewTarget
      this.reviewSaving = true
      this.reviewError = ''
      try {
        await templateGovernanceApi[kind === 'component' ? 'reviewComponent' : 'reviewTemplate'](kind === 'component' ? row.id : row.templateId, row.versionId, { action: 'reject', note })
        if (this._templateDisposed) return
        this.reviewDialog = false
        this.$message.success('已退回维护人修改')
        this.reviewSaving = false
        if (!returnToWorkflow(this)) await this.reload()
      } catch (error) {
        if (!this._templateDisposed) {
          this.reviewOutcomeUnknown = !error.status || error.status === 409
          if (this.reviewOutcomeUnknown) this.actionUnknown[`${kind}:${row.versionId}`] = true
          this.reviewError = templateWriteError(error, '退回')
        }
      } finally { this.reviewSaving = false }
    },
    checkComposition() { return validateComposition(this.templateForm, { components: this.components, componentsReady: this.componentsLoaded && !this.componentsLoading && !this.componentsError, validateBinding: normalizeAuxiliaryBinding }) },
    resetCompositionState() {
      this.compositionBaseline = compositionFingerprint(this.templateForm)
      this.validationAttempted = this.componentSelectionChecked = false
      this.compositionSaveError = ''
      this.saveOutcomeUnknown = false
      this.endComponentDrag()
    },
    async focusCompositionField(path) {
      await this.$nextTick()
      const fields = this.$refs.compositionForm?.$el.querySelectorAll('[data-composition-field]') || []
      const target = [...fields].find(element => element.dataset.compositionField === path)
      target?.scrollIntoView({ block: 'center', behavior: 'auto' })
      target?.querySelector('input:not([disabled]), textarea:not([disabled]), button:not([disabled])')?.focus({ preventScroll: true })
    },
    protectCompositionUnload(event) { if (this.compositionDirty || this.savingTemplate) { event.preventDefault(); event.returnValue = '' } },
    async confirmCompositionDiscard() {
      if (!this._compositionDiscard) this._compositionDiscard = this.$confirm('当前修改尚未保存，放弃后无法恢复。', '放弃未保存的修改？', { confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning', customClass: 'composition-confirm', closeOnClickModal: false }).then(() => true, () => false).finally(() => { this._compositionDiscard = null })
      return this._compositionDiscard
    },
    async allowCompositionLeave() {
      if (this.reviewSaving || Object.values(this.actionBusy).some(Boolean)) { this.$message.info('正在提交操作，请等待完成。'); return false }
      if (this.savingTemplate) { this.$message.info('正在保存，请等待保存完成。'); return false }
      if (this.compositionDirty && !await this.confirmCompositionDiscard()) return false
      this.templateDialog = false
      return true
    },
    async closeComposition(done) {
      if (!await this.allowCompositionLeave()) return
      if (typeof done === 'function') done()
    },
    endComponentDrag() { this.draggingTemplateComponent = null; this.templateDropTarget = '' },
    explainComponentSelection() { this.$message.info('请在目标工作表的 Header、Body 或 Footer 下拉框中选择此组件，也可拖动到对应区域。') },
    validateComponentSelection() { this.componentSelectionChecked = true },
    async loadCompositionComponents() {
      const request = this._componentRequest = (this._componentRequest || 0) + 1
      this._componentController?.abort()
      const controller = this._componentController = new AbortController()
      this.componentsLoading = true
      this.componentsError = ''
      const current = () => !this._templateDisposed && request === this._componentRequest
      try {
        const response = await readCompositionComponents(signal => templateGovernanceApi.getComponents(signal), controller.signal)
        if (current()) { this.components = response.components || []; this.componentsLoaded = true }
      } catch (error) { if (current() && !controller.signal.aborted) this.componentsError = compositionRequestError(error, '加载组件') }
      finally { if (current()) this.componentsLoading = false }
    },
    scopeLabel(scope) { if (this.showcase) return ''; return scope === 'ALL' ? '全部组织' : this.organizations.find(org => org.code === scope)?.name || scope || '未设置范围' },
    canMaintain(ownerId) { return this.userId === Number(ownerId) || this.isSystemAdmin },
    async reload() {
      await Promise.all([
        this.loadCompositionComponents(),
        this.runRead('templates', {
          request: signal => templateGovernanceApi.getTemplates(signal),
          start: () => { this.templatesLoading = true; this.templatesError = '' },
          success: response => {
            if (!Array.isArray(response?.templates) || !Array.isArray(response?.organizations)) throw new Error('Invalid response')
            this.templates = response.templates
            this.organizations = response.organizations
            this.templatesLoaded = true
          },
          failure: error => { this.templatesError = compositionRequestError(error, '加载模板列表') },
          finish: () => { this.templatesLoading = false }
        })
      ])
      if (!this._templateDisposed && !this.templatesError && !this.componentsError) {
        this.actionUnknown = {}; this.actionError = ''
      }
    },
    publishedComponents(type) { return this.components.filter(c => (!type || c.componentType === type) && c.status === 'published') },
    componentOption(c) { return `${c.metadata?.name || c.code} · ${c.code} · v${c.version}` },
    startTemplateComponentDrag(event, component) {
      if (this.savingTemplate || this.componentsLoading || this.componentsError) { event.preventDefault(); return }
      this.draggingTemplateComponent = component
      event.dataTransfer.effectAllowed = 'copy'
      event.dataTransfer.setData('application/x-cost-template-component', String(component.versionId))
    },
    clearTemplateDropTarget(event) {
      if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget)) this.templateDropTarget = ''
    },
    overTemplateSheet(event, sheet) {
      const component = this.draggingTemplateComponent
      if (this.savingTemplate || this.componentsLoading || this.componentsError || sheet.inlineWorkbook || sheet.type !== 'business' || !component || component.status !== 'published') return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      this.templateDropTarget = `${sheet.key}:${component.componentType}`
    },
    dropTemplateComponent(event, sheet) {
      if (!this.draggingTemplateComponent && !event.dataTransfer?.types?.includes('application/x-cost-template-component')) return
      event.preventDefault()
      event.stopPropagation()
      if (this.savingTemplate || this.componentsLoading || this.componentsError) { this.endComponentDrag(); return }
      const versionId = Number(event.dataTransfer.getData('application/x-cost-template-component'))
      const component = this.components.find(item => Number(item.versionId) === versionId) || this.draggingTemplateComponent
      this.endComponentDrag()
      if (sheet.inlineWorkbook) return this.$message.warning('此工作表已详细修改，请在 Designer 中继续编辑')
      if (sheet.type !== 'business') return this.$message.warning('请拖入业务工作表，辅助工作表不使用组件')
      if (!component) return
      const type = component.componentType
      if (component.status !== 'published' || !['header', 'body', 'footer'].includes(type)) return this.$message.warning('请选择已发布的 Header、Body 或 Footer 组件')
      if (type !== 'body') {
        const body = this.components.find(item => Number(item.versionId) === Number(sheet.bodyVersionId))
        if (body && Number(body.workbook?.columnCount) !== Number(component.workbook?.columnCount)) return this.$message.warning(`${this.typeLabel[type]} 列数必须与 Body 列网格一致`)
      } else {
        for (const regionType of ['header', 'footer']) {
          const region = this.components.find(item => Number(item.versionId) === Number(sheet[`${regionType}VersionId`]))
          if (region && Number(region.workbook?.columnCount) !== Number(component.workbook?.columnCount)) return this.$message.warning(`Body 列数必须与已选 ${this.typeLabel[regionType]} 网格一致`)
        }
      }
      sheet[`${type}VersionId`] = component.versionId
      this.validateComponentSelection()
      this.$message.success(`已自动放入 ${this.typeLabel[type]}：${component.metadata?.name || component.code} v${component.version}`)
    },
    openComponentWorkbench(row) { this.openWorkbench({ versionId: row.versionId }) },
    createComponentVersionInWorkbench(row) { this.openWorkbench({ sourceId: row.id }) },
    submitComponent(row) { return this.runRowAction('component', row, 'submit') },
    reviewComponent(row, action) { return action === 'reject' ? this.openRejection('component', row) : this.runRowAction('component', row, action) },
    openTemplateDialog() {
      this.templateForm = { templateId: null, versionId: null, version: null, name: '', description: '', factory: '', sheets: [blankSheet()] }
      this.resetCompositionState()
      this.templateDialog = true
    },
    editTemplate(row) {
      return this.runRead('editor', {
        request: signal => templateGovernanceApi.getTemplateVersion(row.versionId, signal),
        success: response => {
        const t = response?.template
        if (!t) throw new Error('Invalid response')
        if (t.manifest?.designMode === 'direct') {
          return this.openWorkbench({ mode: 'template', templateVersionId: String(t.id) })
        }
        if (!Array.isArray(t.sheets)) throw new Error('Invalid response')
        this.templateForm = { templateId: t.template_id, versionId: t.id, version: t.version, name: t.name, description: t.description || '', factory: t.factory || '', sheets: (t.sheets || []).map(sheet => ({
          key: `${sheet.id}-${Math.random()}`, code: sheet.sheet_code, name: sheet.display_name, type: sheet.sheet_type,
          inlineWorkbook: sheet.auxiliary?.inlineWorkbook || null, permissionTag: sheet.auxiliary?.permissionTag || null,
          headerVersionId: sheet.header_component_version_id, bodyVersionId: sheet.body_component_version_id, footerVersionId: sheet.footer_component_version_id,
          auxiliary: { rowCount: sheet.auxiliary?.rowCount || 1, columnCount: sheet.auxiliary?.columnCount || 1,
            sourceMode: sheet.auxiliary?.dataBinding ? 'remote' : 'fixed', dataBinding: sheet.auxiliary?.dataBinding || blankAuxiliary().dataBinding,
            cellsJson: JSON.stringify(sheet.auxiliary?.cells || [], null, 2), designerJson: sheet.auxiliary?.designerJson || null,
            permissionTag: sheet.auxiliary?.permissionTag || null }
        })) }
        this.resetCompositionState()
        this.templateDialog = true
        },
        failure: error => { this.actionError = compositionRequestError(error, '打开模板编辑') }
      })
    },
    addSheet() { if (!this.savingTemplate && this.templateForm.sheets.length < MAX_COMPOSITION_SHEETS) this.templateForm.sheets.push(blankSheet(nextSheetIndex(this.templateForm.sheets))) },
    async removeSheet(index) {
      if (this.savingTemplate || this.templateForm.sheets.length <= 1) return
      const sheet = this.templateForm.sheets[index]
      try { await this.$confirm(`将移除工作表“${sheet.name || index + 1}”及其当前配置。`, '移除工作表？', { confirmButtonText: '移除工作表', cancelButtonText: '保留工作表', type: 'warning', customClass: 'composition-confirm', closeOnClickModal: false }) }
      catch { return }
      if (this.savingTemplate) return
      const currentIndex = this.templateForm.sheets.findIndex(item => item.key === sheet.key)
      if (currentIndex >= 0 && this.templateForm.sheets.length > 1) this.templateForm.sheets.splice(currentIndex, 1)
    },
    onSheetTypeChanged(sheet) {
      if (!sheet.auxiliary) sheet.auxiliary = blankAuxiliary()
      this.endComponentDrag()
    },
    async saveTemplate(openDesigner = false) {
      if (this.savingTemplate || this.saveOutcomeUnknown) return
      this.validationAttempted = true
      const errors = this.checkComposition()
      if (Object.keys(errors).length) { this.focusCompositionField(Object.keys(errors)[0]); return }
      this.savingTemplate = true
      this.compositionSaveError = ''
      this.compositionSaveSlow = false
      this._compositionSaveTimer = setTimeout(() => { this.compositionSaveSlow = true }, 10000)
      try {
        const sheets = this.templateForm.sheets.map(({ code, name, type, headerVersionId, bodyVersionId, footerVersionId, auxiliary, inlineWorkbook, permissionTag }) => {
          if (inlineWorkbook) return { code, name, type, inlineWorkbook }
          let auxiliaryContent = { rowCount: 1, columnCount: 1, cells: [] }
          if (type === 'auxiliary' && auxiliary.sourceMode === 'remote') auxiliaryContent = { rowCount: 20, columnCount: 10, cells: [], dataBinding: normalizeAuxiliaryBinding(auxiliary.dataBinding) }
          else if (type === 'auxiliary') auxiliaryContent = { rowCount: auxiliary.rowCount, columnCount: auxiliary.columnCount,
            cells: JSON.parse(auxiliary.cellsJson || '[]'), designerJson: auxiliary.designerJson || null, permissionTag: auxiliary.permissionTag || null }
          return { code, name, type, headerVersionId: type === 'business' ? headerVersionId : null, bodyVersionId: type === 'business' ? bodyVersionId : null, footerVersionId: type === 'business' ? footerVersionId : null, auxiliary: auxiliaryContent, permissionTag }
        })
        const payload = { name: this.templateForm.name, description: this.templateForm.description, factory: this.templateForm.factory, sheets, designerJson: null, templateSnapshot: null }
        if (this.templateForm.versionId) await templateGovernanceApi.updateTemplateVersion(this.templateForm.versionId, payload)
        else {
          const created = await templateGovernanceApi.createTemplate(payload)
          this.templateForm.versionId = created.versionId
          this.templateForm.templateId = created.templateId
        }
        this.compositionBaseline = compositionFingerprint(this.templateForm)
        this.$message.success('模板草稿已保存')
        this.templateDialog = false
        this.savingTemplate = false
        if (openDesigner) return this.openWorkbench({ mode: 'template', templateVersionId: String(this.templateForm.versionId) })
        await this.reload()
      } catch (error) {
        this.saveOutcomeUnknown = !error.status && !this.templateForm.versionId
        this.compositionSaveError = this.saveOutcomeUnknown ? '保存结果未确认，连接可能已中断。' : compositionRequestError(error, '保存模板')
        await this.$nextTick()
        this.$refs.compositionSaveNotice?.$el.scrollIntoView({ block: 'nearest' })
        this.$refs.compositionSaveNotice?.$el.focus({ preventScroll: true })
      }
      finally { clearTimeout(this._compositionSaveTimer); this.savingTemplate = false; this.compositionSaveSlow = false }
    },
    async importQuarterlyReference(event) {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (this.importingReference || !file || !/\.xlsx$/i.test(file.name)) return
      if (file.name !== quarterlyReferenceProfile.sourceName) return this.$message.error('请选择项目根目录中的季度考核参考工作簿')
      this.importingReference = true
      let spread
      try {
        await ensureSpreadIo()
        if (this._templateDisposed) return
        const host = this.$refs.quarterlyImportHost
        host.style.width = '1500px'; host.style.height = '900px'
        spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1 })
        await new Promise((resolve, reject) => spread.import(file, resolve, reject, { fileType: GC.Spread.Sheets.FileType.excel }))
        if (spread.getSheetCount() !== 22) throw new Error(`参考工作簿应有 22 张工作表，实际为 ${spread.getSheetCount()} 张`)
        const importedNames = Array.from({ length: spread.getSheetCount() }, (_, index) => spread.getSheet(index).name())
        if (importedNames.some((name, index) => name !== quarterlyReferenceProfile.sheetNames[index])) throw new Error('工作表名称或顺序与已登记的季度参考工作簿不一致')
        const sourceSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))]
          .map(value => value.toString(16).padStart(2, '0')).join('')
        if (sourceSha256 !== quarterlyReferenceProfile.sha256) throw new Error('参考工作簿文件内容与已登记的源文件不一致')
        const sheets = []
        for (let index = 0; index < spread.getSheetCount(); index += 1) {
          const sheet = spread.getSheet(index)
          let rowCount = sheet.getRowCount(GC.Spread.Sheets.SheetArea.viewport)
          let columnCount = sheet.getColumnCount(GC.Spread.Sheets.SheetArea.viewport)
          const rangeTypes = GC.Spread.Sheets.UsedRangeType.data | GC.Spread.Sheets.UsedRangeType.formula | GC.Spread.Sheets.UsedRangeType.span
          const contentRange = sheet.getUsedRange(rangeTypes)
          const contentRowEnd = contentRange ? contentRange.row + contentRange.rowCount : 1
          const contentColumnEnd = contentRange ? contentRange.col + contentRange.colCount : 1
          if (rowCount > 200) {
            if (contentRowEnd > 200) throw new Error(`工作表“${sheet.name()}”存在第 200 行以后的有效内容，无法完整迁移`)
            rowCount = Math.max(1, contentRowEnd)
            sheet.setRowCount(rowCount, GC.Spread.Sheets.SheetArea.viewport)
          }
          if (columnCount > 100) {
            if (contentColumnEnd > 100) throw new Error(`工作表“${sheet.name()}”存在第 100 列以后的有效内容，无法完整迁移`)
            columnCount = Math.max(1, contentColumnEnd)
            sheet.setColumnCount(columnCount, GC.Spread.Sheets.SheetArea.viewport)
          }
          if (rowCount > 200 || columnCount > 100) throw new Error(`工作表“${sheet.name()}”超过 200 行 × 100 列的治理上限`)
          const cells = []
          const nativeValidations = []
          for (let row = 0; row < rowCount; row += 1) for (let column = 0; column < columnCount; column += 1) {
            const formula = sheet.getFormula(row, column)
            const value = sheet.getValue(row, column)
            if (formula) cells.push({ row, column, formula })
            else if (value !== null && value !== undefined && value !== '') cells.push({ row, column, value })
            if (sheet.getDataValidator(row, column)) nativeValidations.push({ cell: `${row + 1},${column + 1}`, row, col: column, ruleVersionId: null })
          }
          const name = sheet.name()
          const isCompany = quarterlyReferenceProfile.companySheetNames.includes(name)
          const isAuxiliary = quarterlyReferenceProfile.auxiliarySheetNames.includes(name)
          if (isCompany === isAuxiliary) throw new Error(`工作表“${name}”没有唯一的登记分类`)
          sheets.push({ code: `reference_sheet_${String(index + 1).padStart(2, '0')}`, name, kind: isCompany ? 'company' : 'readonly',
            rowCount, columnCount, cells, nativeValidations, designerJson: sheet.toJSON({ includeBindingSource: false }) })
        }
        const result = await templateGovernanceApi.importQuarterlyReferenceDraft({ sourceName: file.name, sourceSha256, sheets })
        this.$message.success(`已创建 Draft 模板 #${result.versionId}：22 张工作表，其中 13 张公司页组件、${result.readonlySheetCount} 张只读参考页`)
        await this.reload()
      } catch (error) { this.$message.error(`导入季度参考工作簿失败：${error.message}`) }
      finally { spread?.destroy(); this.importingReference = false }
    },
    async createTemplateVersion(row) {
      if (this.modifyingTemplateVersionId !== null) return
      this.modifyingTemplateVersionId = row.versionId
      try {
        const result = await templateGovernanceApi.createTemplateVersion(row.templateId, row.versionId)
        if (this._templateDisposed) return
        this.$message.success(`已创建 v${result.version} 草稿，可继续修改并保存`)
        await this.reload()
        await this.editTemplate({ versionId: result.versionId })
      }
      catch (error) { this.$message.error(error.message) }
      finally { this.modifyingTemplateVersionId = null }
    },
    submitTemplate(row) { return this.runRowAction('template', row, 'submit') },
    checkPublication(row) {
      if (!row) return
      this.cancelRead('role')
      this.publicationRow = row
      this.publicationDialog = true
      this.publicationReport = this.rolePreviewData = null
      this.previewRole = 'subsidiary_filler'
      this.roleError = ''; this.roleLoading = false
      return this.runRead('publication', {
        request: signal => templateGovernanceApi.validateTemplate(row.versionId, signal),
        start: () => { this.publicationLoading = true; this.publicationError = '' },
        success: result => {
          const report = result?.report
          if (!report?.versionId || !Array.isArray(report.checks) || !Array.isArray(report.issues)) throw new Error('Invalid response')
          this.publicationReport = report
          this.loadRolePreview()
        },
        failure: error => { this.publicationError = compositionRequestError(error, '检查发布条件') },
        finish: () => { this.publicationLoading = false }
      })
    },
    closePublication() {
      this.cancelRead('publication'); this.cancelRead('role')
      this.publicationLoading = this.roleLoading = false
    },
    loadRolePreview() {
      if (!this.publicationDialog || !this.publicationReport?.versionId) return
      const versionId = this.publicationReport.versionId, role = this.previewRole
      return this.runRead('role', {
        request: signal => templateGovernanceApi.previewTemplateRole(versionId, role, signal),
        start: () => { this.rolePreviewData = null; this.roleLoading = true; this.roleError = '' },
        success: result => {
          if (!Array.isArray(result?.preview?.sheets)) throw new Error('Invalid response')
          this.rolePreviewData = result.preview
        },
        failure: error => { this.roleError = compositionRequestError(error, '加载角色预览') },
        finish: () => { this.roleLoading = false }
      })
    },
    openIssue(issue, target = null) {
      if (!target && issue.code === 'version_metadata_invalid' && this.publicationReport?.versionId) {
        this.publicationDialog = false
        const template = this.templates.find(item => Number(item.versionId) === Number(this.publicationReport.versionId))
        if (template) {
          this.editTemplate(template)
          return
        }
        this.$router.push({ path: '/portal/template', query: templateWorkflowQuery(this.$route, { editVersionId: String(this.publicationReport.versionId) }) })
        return
      }
      const componentVersionId = target?.componentVersionId || issue.componentVersionId
      if (!componentVersionId) return
      this.publicationDialog = false
      const query = templateWorkflowQuery(this.$route, { versionId: String(componentVersionId) })
      if (!target && issue.mappingId != null) query.mappingId = String(issue.mappingId)
      if (target && Number.isInteger(Number(target.row)) && Number.isInteger(Number(target.col))) {
        query.cellRow = String(target.row)
        query.cellCol = String(target.col)
      }
      this.$router.push({ path: '/portal/template-workbench', query })
    },
    reviewTemplate(row, action) { return action === 'reject' ? this.openRejection('template', row) : this.runRowAction('template', row, action) },
    viewTemplate(row) {
      if (!row) return
      this.destroyTemplatePreview()
      this.previewRow = row
      this.previewTemplate = null
      this.previewErrors = []
      this.previewFailure = ''
      this.previewLoading = true
      this.previewDialog = true
      return this.runRead('preview', {
        request: signal => templateGovernanceApi.getTemplateVersion(row.versionId, signal),
        success: response => {
          if (!response?.template?.workbook || !Array.isArray(response.template.workbook.sheets)) throw new Error('Invalid response')
          this.previewTemplate = response.template
          if (this._previewOpened) this.$nextTick(() => this.initTemplatePreview())
        },
        failure: error => { this.previewFailure = compositionRequestError(error, '加载成品预览'); this.previewLoading = false }
      })
    },
    onPreviewOpened() { this._previewOpened = true; this.initTemplatePreview() },
    closeTemplatePreview() {
      this._previewOpened = false
      this.cancelRead('preview')
      this.destroyTemplatePreview()
      this.previewLoading = false
    },
    async initTemplatePreview() {
      if (!this.previewDialog || !this.previewTemplate || this._previewSession || this._templateDisposed) return
      const host = this.$refs.templatePreviewHost
      const contract = this.previewTemplate.workbook
      const sourceSheets = contract?.sheets || []
      this.previewReady = false
      this.previewFailure = ''
      this.previewErrors = []
      if (!host || !sourceSheets.length) {
        this.previewLoading = false
        this.previewFailure = '此版本还没有可预览的工作簿，请在 Designer 中保存设计后重试。'
        return
      }
      // Each load owns its host and instance. A cancelled async loader finishes on
      // its detached host before destruction, never on a replacement workbook.
      const mount = document.createElement('div')
      mount.style.cssText = 'width:100%;height:100%'
      host.appendChild(mount)
      const session = { spread: null, mount, loading: true, cancelled: false }
      this._previewSession = session
      const current = () => !this._templateDisposed && this.previewDialog && this._previewSession === session && !session.cancelled
      this.previewLoading = true
      const timer = session.timer = setTimeout(() => {
        if (!current()) return
        this.destroyTemplatePreview()
        this.previewLoading = false
        this.previewFailure = '工作簿加载超时，请检查网络后重新加载预览。'
      }, 15000)
      try {
        const spread = session.spread = markRaw(new GC.Spread.Sheets.Workbook(mount, { sheetCount: sourceSheets.length, tabEditable: false, newTabVisible: false }))
        this.previewSpread = spread
        await loadTemplateWorkbook(spread, contract, { onRemoteError: message => { if (current()) this.previewErrors.push(message) } })
        if (!current()) return
        // Lock all sheets before the first cooperative yield so users cannot
        // change another sheet while validation is still in progress.
        for (let index = 0; index < sourceSheets.length; index++) spread.getSheet(index).options.isProtected = true
        spread.options.allowUserDragDrop = false
        spread.options.allowUserDragFill = false
        spread.options.allowUndo = false
        for (const [index, source] of sourceSheets.entries()) {
          const sheet = spread.getSheet(index)
          const name = sheet.name()
          const rowCount = sheet.getRowCount(), columnCount = sheet.getColumnCount()
          for (const mapping of source.mappings || []) {
            if (!mapping.required) continue
            const inBounds = Number.isInteger(Number(mapping.row)) && Number.isInteger(Number(mapping.col))
              && Number(mapping.row) >= 0 && Number(mapping.col) >= 0
              && Number(mapping.row) + (Number(mapping.rowCount) || 1) <= rowCount
              && Number(mapping.col) + (Number(mapping.colCount) || 1) <= columnCount
            const tag = inBounds ? sheet.getTag(Number(mapping.row), Number(mapping.col)) : null
            if (!inBounds || !tag) this.previewErrors.push(`${name} 的必填区域 ${mapping.namedArea || mapping.fieldCode || ''} 缺少有效锚点`)
          }
          const errors = await scanTemplateFormulaErrors(sheet, {
            usedRangeType: GC.Spread.Sheets.UsedRangeType.all,
            CalcError: GC.Spread.CalcEngine.CalcError, isCurrent: current
          })
          if (!current() || errors === null) return
          this.previewErrors = this.previewErrors.concat(errors)
        }
        this.stopPreviewLayout = observeWorkbookLayout(mount, spread)
        this.previewReady = true
      } catch (error) {
        if (current()) this.previewFailure = '工作簿加载或校验失败，请重新加载预览；若仍失败，请联系模板维护人。'
      } finally {
        clearTimeout(timer)
        session.loading = false
        if (current()) this.previewLoading = false
        else this.releasePreviewSession(session)
      }
    },
    releasePreviewSession(session) {
      if (session.released) return
      session.released = true
      if (session.spread) { disposeAuxiliaryData(session.spread); session.spread.destroy() }
      session.mount.remove()
    },
    destroyTemplatePreview() {
      const session = this._previewSession
      this._previewSession = null
      this.previewReady = false
      this.previewSpread = null
      this.stopPreviewLayout?.()
      this.stopPreviewLayout = null
      if (session) {
        session.cancelled = true
        clearTimeout(session.timer)
        if (session.spread) disposeAuxiliaryData(session.spread)
        session.mount.remove()
        if (!session.loading) this.releasePreviewSession(session)
      }
    },
    previewBlob(blob, extension) {
      if (!blob?.size) return this.$message.error(`${extension.toUpperCase()} 预览文件为空`)
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
      link.download = `${this.previewTemplate?.code || 'template'}-preview.xlsx`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
    releasePdfPreview() {
      if (this.pdfPreviewUrl) URL.revokeObjectURL(this.pdfPreviewUrl)
      this.pdfPreviewUrl = ''
    },
    async createReferenceExportWorkbook() {
      const exportSpread = new GC.Spread.Sheets.Workbook()
      try {
        await exportSpread.fromJSON(this.previewSpread.toJSON())
        if (this.previewTemplate?.manifest?.sourceWorkbook?.sha256 === quarterlyReferenceProfile.sha256) {
          for (const sheet of exportSpread.sheets) {
            if (!sheet.visible()) continue
            const rowCount = sheet.getRowCount(GC.Spread.Sheets.SheetArea.viewport)
            const columnCount = sheet.getColumnCount(GC.Spread.Sheets.SheetArea.viewport)
            for (let row = 0; row < rowCount; row++) {
              for (let column = 0; column < columnCount; column++) {
                const value = sheet.getValue(row, column)
                if (typeof value !== 'string' || (value.length < 25 && !/[\r\n]/.test(value))) continue
                const sourceStyle = sheet.getStyle(row, column, GC.Spread.Sheets.SheetArea.viewport)
                const style = sourceStyle ? sourceStyle.clone() : new GC.Spread.Sheets.Style()
                style.wordWrap = true
                sheet.setStyle(row, column, style, GC.Spread.Sheets.SheetArea.viewport)
              }
            }
            const printInfo = sheet.printInfo()
            printInfo.fitPagesWide(1)
            printInfo.bestFitRows(true)
            sheet.printInfo(printInfo)
          }
        }
        return exportSpread
      } catch (error) {
        exportSpread.destroy()
        throw error
      }
    },
    async exportTemplateXlsx() {
      if (!this.previewReady || this.previewLoading || this.previewFailure || !this.previewSpread || this.previewErrors.length || this.xlsxExporting) return
      this.xlsxExporting = true
      const source = this.previewSpread
      const current = () => !this._templateDisposed && this.previewDialog && this.previewSpread === source
      let exportSpread
      try {
        await ensureSpreadIo()
        if (!current()) return
        exportSpread = await this.createReferenceExportWorkbook()
        if (!current()) return
        const blob = await new Promise((resolve, reject) => exportSpread.export(resolve, reject, { fileType: GC.Spread.Sheets.FileType.excel, includeBindingSource: false }))
        if (current()) this.previewBlob(blob, 'xlsx')
      } catch (error) { if (current()) this.$message.error(`XLSX 预览失败：${error.errorMessage || error.message || '导出失败，请重试'}`) }
      finally { exportSpread?.destroy(); this.xlsxExporting = false }
    },
    async exportTemplatePdf() {
      if (!this.previewReady || this.previewLoading || this.previewFailure || !this.previewSpread || this.previewErrors.length || this.pdfExporting) return
      this.pdfExporting = true
      const source = this.previewSpread
      let pdfSpread
      try {
        await ensureSpreadPdfExport(GC)
        if (this._templateDisposed || !this.previewDialog || this.previewSpread !== source) return
        pdfSpread = await this.createReferenceExportWorkbook()
        if (this._templateDisposed || !this.previewDialog || this.previewSpread !== source) return
        const blob = await new Promise((resolve, reject) => pdfSpread.savePDF(resolve, reject, {
          title: this.previewTemplate?.name || '模板预览', creator: '成本指标平台'
        }))
        if (!this._templateDisposed && this.previewDialog && this.previewSpread === source) this.previewBlob(blob, 'pdf')
      } catch (error) { if (!this._templateDisposed && this.previewDialog && this.previewSpread === source) this.$message.error(`PDF 预览失败：${error.errorMessage || error.message || '导出失败'}`) }
      finally { pdfSpread?.destroy(); this.pdfExporting = false }
    }
  }
}
</script>

<style scoped>
.template-status { margin-block: 12px; overflow-wrap: anywhere; }
.preview-owner, .preview-footnote, .review-object { overflow-wrap: anywhere; }
.library-navigation { display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin-top:20px }
.quarterly-import-host{position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none}
.governance-page { max-width: 1440px; margin: 0 auto; padding: 28px 32px 56px; color: #172a3a; }
.page-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
.eyebrow { margin: 0 0 8px; color: #941966; font-size:12px; font-weight: 700; letter-spacing: .15em; }
h1 { margin: 0; font-size: 28px; letter-spacing: -.03em; }
.heading-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
.heading-actions :deep(.el-button + .el-button) { margin-left: 0; }
:global(.template-help-tooltip) { max-width: 320px; line-height: 1.6; }
.governance-section { margin-top: 22px; padding: 20px 22px 14px; border: 1px solid #e0e9e8; border-radius: 12px; background: #fff; box-shadow: 0 5px 20px rgba(21, 53, 63, .035); }
.section-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 17px; }
.section-heading h2 { margin: 0; font-size: 18px; }
.section-heading span { color: #6d5a65; font-size: 12px; }
.subline { display: block; color: #8b999e; font-size: 12px; margin-top: 4px; }
.owner-mark { display: inline-block; margin-left: 8px; padding: 1px 6px; border-radius: 8px; color: #277671; background: #f8ebf3; font-size:12px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.form-grid :deep(.el-select), .form-grid :deep(.el-input-number) { width: 100%; }
.span-two { grid-column: 1 / -1; }
.form-hint { margin: 0 0 8px; color: #6d5a65; font-size: 12px; line-height: 1.6; }
.sheet-heading { display: flex; justify-content: space-between; align-items: center; margin: 8px 0 14px; }
.sheet-heading h3 { margin: 0; font-size: 15px; }
.sheet-card { padding: 15px; margin-bottom: 12px; border: 1px solid #e2eae8; border-radius: 9px; background: #fbfdfc; }
.sheet-row-title { display: flex; justify-content: space-between; align-items: center; margin-bottom: 11px; }
.sheet-controls { display: grid; grid-template-columns: 1.1fr 1fr 1.1fr; gap: 10px; }
.component-selects { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 11px; }
.auxiliary-editor { margin-top: 12px; }
.auxiliary-grid-size { display: flex; align-items: center; gap: 9px; max-width: 310px; margin-bottom: 12px; color: #6d5a65; font-size: 12px; }
.preview-owner { margin-top: 0; color: #6d7f88; }
.template-preview-host { height: 62vh; min-height: 420px; margin-top: 14px; border: 1px solid #e8d9e1; }
.preview-footnote { margin: 8px 0 0; color: #788b8d; font-size: 12px; }
.pdf-preview-frame { display: block; width: 100%; height: 74vh; border: 0; }
.component-drag-palette { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; padding: 9px 10px; margin: 0 0 12px; border: 1px dashed #b8d0cd; border-radius: 8px; background: #f5faf9; }
.palette-label { color: #6d5a65; font-size:12px; }
.component-drag-card { display: inline-flex; align-items: center; gap: 7px; padding: 5px 8px; border: 1px solid #d9e8e5; border-radius: 6px; background: #fff; color: #24474b; cursor: grab; }
.component-drag-card strong { font-size:12px; }
.component-drag-card small { color: #819497; font-size:12px; }
.component-drop-slot { min-width: 0; padding: 6px; border: 1px solid transparent; border-radius: 7px; transition: background .15s,border-color .15s; }
.component-drop-slot.drop-target { border-color: #941966; background: #f8ebf3; box-shadow: 0 0 0 2px #94196620; }
.component-drop-slot .slot-label { display: block; margin: 0 0 5px 2px; color: #6d5a65; font-size:12px; font-weight: 700; }
.component-drop-slot :deep(.el-select) { width: 100%; }
@media (max-width: 800px) { .governance-page { padding: 20px 14px; } .page-heading { align-items: flex-start; flex-direction: column; } .heading-actions { width: 100%; justify-content: flex-start; } .sheet-controls, .component-selects, .form-grid { grid-template-columns: 1fr; } }
</style>
<style>
.template-state-dialog { --el-color-primary: var(--portal-focus, #941966); --el-text-color-placeholder: var(--portal-muted, #6d5a65); }
.template-state-dialog .el-alert--error, .template-state-dialog .el-form-item__error, .template-state-dialog .el-alert--error .el-alert__description { color: #b42318; }
.template-state-dialog .el-alert__title { overflow-wrap: anywhere; }
.template-state-dialog .preview-footnote { color: var(--portal-muted, #6d5a65); }
.template-review-dialog .el-textarea__inner { font-size: 16px; }
.template-review-dialog .el-form-item__error { position: static; padding-block-start: 6px; line-height: 1.5; }
.template-review-dialog .el-dialog__footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.template-review-dialog .el-dialog__footer .el-button { margin: 0; min-height: 44px; }
.template-state-dialog .el-button--primary { --el-button-bg-color: var(--portal-focus, #941966); --el-button-border-color: var(--portal-focus, #941966); }
.template-state-dialog button:focus-visible { outline: 2px solid var(--portal-focus, #941966); outline-offset: 2px; }
</style>
<style src="@/styles/template-composition.css"></style>

<style src="@/styles/template-library-layout.css"></style>
