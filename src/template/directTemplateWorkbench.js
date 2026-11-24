import GC from '@grapecity-software/spread-sheets'
import '@grapecity-software/spread-sheets-collaboration-addon'
import { templateGovernanceApi } from '@/api'
import { loadTemplateWorkbook } from './composedTemplateWorkbook'
import { sheetDesignFingerprint, templateSheetPayload } from './sheetDesignState'
import { auxiliaryStructureJSON } from './auxiliaryDataBinding'
import { createSheetCode } from './sheetCode'

const copy = value => JSON.parse(JSON.stringify(value))

// Template sheets own their mappings; components remain optional reusable content.
export default {
  data: () => ({ directTemplate: null, templateVersionId: null, templateId: null,
    templateFactory: 'ALL', templateDescription: '', templateOrganizations: [] }),
  computed: {
    isTemplateDesign() { return this.$route.query.mode === 'template' }
  },
  methods: {
    async loadDirectTemplate() {
      this.templateVersionId = Number(this.$route.query.templateVersionId) || null
      try {
        const catalog = await templateGovernanceApi.getTemplates()
        this.templateOrganizations = catalog.organizations || []
        if (!this.templateVersionId) { this.form.rowCount = 100; this.form.columnCount = 20; return }
        const { template } = await templateGovernanceApi.getTemplateVersion(this.templateVersionId)
        if (!template.workbook?.sheets?.length) throw new Error('此版本还没有工作表，请先保存工作表组成')
        this.directTemplate = template
        this.templateId = template.template_id
        this.form.name = template.manifest.name || template.name
        this.templateFactory = template.manifest.factory || 'ALL'
        this.templateDescription = template.manifest.description || ''
        this.isDraft = template.status === 'draft'
        this.canEdit = this.isDraft && (Number(template.ownerId) === this.userId || this.isSystemAdmin)
      } catch (error) { this.canEdit = false; this.$message.error(`加载模板失败：${error.message}`) }
    },
    directSheetState(sheet) {
      if (!this._directSheets) this._directSheets = new Map()
      if (!this._directSheets.has(sheet)) this._directSheets.set(sheet, {
        code: createSheetCode(), mappings: [], nativeValidations: []
      })
      return this._directSheets.get(sheet)
    },
    rememberDirectSheet() {
      const sheet = this._directActiveSheet
      if (!sheet) return
      const state = this.directSheetState(sheet)
      state.mappings = copy(this.mappings)
      state.nativeValidations = copy(this.nativeValidations)
    },
    activateDirectSheet(sheet) {
      this.removeGridListeners()
      this._directActiveSheet = sheet
      const state = this.directSheetState(sheet)
      this.mappings = copy(state.mappings).map(mapping => this.hydrateMapping(mapping))
      this.nativeValidations = copy(state.nativeValidations)
      this.form.rowCount = sheet.getRowCount()
      this.form.columnCount = sheet.getColumnCount()
      this.selectedMapping = null
      this.selectedTargetCell = null
      this.loadSignatureCell()
      this.permissionForm = null
      this.reconcileMappings(true)
      this.attachGridListeners()
      if (this.inspectorMode === 'permissions') this.loadCellPermissions()
    },
    async applyDirectTemplateToDesigner() {
      this._directSheets = new Map()
      if (this.directTemplate) {
        await loadTemplateWorkbook(this.spread, this.directTemplate.workbook, { onRemoteError: message => this.$message.warning(message) })
        for (const [index, definition] of this.directTemplate.sheets.entries()) {
          const source = this.directTemplate.workbook.sheets[index]
          const metadata = definition.auxiliary?.inlineWorkbook?.metadata
          const sheet = this.spread.getSheet(index)
          sheet.options.isProtected = !this.canEdit || Boolean(source.dataBinding)
          const mappings = copy((metadata?.mappings?.length ? metadata.mappings : source.mappings) || []).map(mapping => this.hydrateMapping(mapping))
          const nativeValidations = copy(metadata?.nativeValidations || source.nativeValidations ||
            (source.sections || []).flatMap(section => (section.nativeValidations || []).map(rule => ({ ...rule, row: rule.row + section.startRow }))))
          this._directSheets.set(sheet, { code: definition.sheet_code, definition: copy(definition), mappings, nativeValidations,
            baseline: sheetDesignFingerprint(sheet.toJSON({ includeBindingSource: false }), mappings, nativeValidations) })
        }
      } else {
        const sheet = this.spread.getActiveSheet()
        sheet.name('工作表1')
        sheet.setRowCount(this.form.rowCount)
        sheet.setColumnCount(this.form.columnCount)
      }
      this.activateDirectSheet(this.spread.getActiveSheet())
      const events = GC.Spread.Sheets.Events
      this._directSheetChanging = () => { this.reconcileMappings(true); this.rememberDirectSheet() }
      this._directSheetChanged = () => this.activateDirectSheet(this.spread.getActiveSheet())
      this.spread.bind(events.ActiveSheetChanging, this._directSheetChanging)
      this.spread.bind(events.ActiveSheetChanged, this._directSheetChanged)
      this.spread.undoManager().clear()
    },
    removeDirectSheetListeners() {
      if (this._directSheetChanging) this.spread?.unbind(GC.Spread.Sheets.Events.ActiveSheetChanging, this._directSheetChanging)
      if (this._directSheetChanged) this.spread?.unbind(GC.Spread.Sheets.Events.ActiveSheetChanged, this._directSheetChanged)
    },
    async saveDirectTemplate(returnToList = true) {
      if (this.saving) return false
      if (!this.canEdit || !this.spread) return false
      if (!this.form.name.trim()) { this.$message.warning('请填写模板名称'); return false }
      const active = this.spread.getActiveSheet()
      if (active.isEditing() && !active.endEdit()) return false
      this.saving = true
      try {
        this.reconcileMappings(true)
        this.rememberDirectSheet()
        const sheets = []
        for (let index = 0; index < this.spread.getSheetCount(); index++) {
          const sheet = this.spread.getSheet(index), state = this.directSheetState(sheet)
          if (state.definition?.auxiliary?.dataBinding) {
            sheets.push({ ...templateSheetPayload(state.definition), name: sheet.name() })
            continue
          }
          const changed = !state.baseline || state.baseline !== sheetDesignFingerprint(sheet.toJSON({ includeBindingSource: false }), state.mappings, state.nativeValidations)
          const composed = this.directTemplate && this.directTemplate.manifest?.designMode !== 'direct'
          if (composed && state.definition && !state.definition.auxiliary?.inlineWorkbook && !changed) {
            sheets.push(templateSheetPayload(state.definition))
            continue
          }
          sheets.push({ code: state.code, name: sheet.name(), type: state.definition?.sheet_type || 'business', inlineWorkbook: {
            rowCount: sheet.getRowCount(), columnCount: sheet.getColumnCount(), cells: this.exportCells(sheet),
            metadata: { designerJson: sheet.toJSON({ includeBindingSource: false }),
              mappings: state.mappings.map(({ ruleCodesText, issue, ...mapping }) => mapping),
              nativeValidations: this.collectNativeValidations(sheet, state.nativeValidations),
              permissionTags: this.exportPermissionTags(sheet) }
          } })
        }
        const designerJson = auxiliaryStructureJSON(this.spread)
        // Native JSON may omit default dimensions; the platform contract records them explicitly.
        for (const nativeSheet of Object.values(designerJson.sheets || {})) {
          const definition = sheets.find(sheet => sheet.name === nativeSheet.name)
          const source = this.spread.getSheetFromName(definition.name)
          nativeSheet.rowCount = definition.auxiliary?.dataBinding ? definition.auxiliary.rowCount : source.getRowCount()
          nativeSheet.columnCount = definition.auxiliary?.dataBinding ? definition.auxiliary.columnCount : source.getColumnCount()
        }
        const snapshotModel = new GC.Spread.Sheets.Workbook(document.createElement('div'))
        let templateSnapshot
        try {
          await snapshotModel.fromJSON(designerJson)
          templateSnapshot = copy(snapshotModel.collaboration.toSnapshot())
        } finally { snapshotModel.destroy() }
        const payload = { name: this.form.name.trim(), factory: this.templateFactory, description: this.templateDescription,
          sheets, designerJson, templateSnapshot }
        if (this.templateVersionId) await templateGovernanceApi.updateTemplateVersion(this.templateVersionId, payload)
        else {
          const result = await templateGovernanceApi.createTemplate(payload)
          this.templateVersionId = result.versionId
          this.templateId = result.templateId
          await this.$router.replace({ query: { mode: 'template', templateVersionId: String(result.versionId) } })
        }
        this.rememberSavedDesign()
        if (returnToList) { this.$message.success('模板草稿已保存'); await this.$router.push('/portal/template?section=templates') }
        return true
      } catch (error) { this.$message.error(`保存模板失败：${error.message}`); return false }
      finally { this.saving = false }
    },
    async submitDirectTemplate() {
      if (this.submitting || this.saving) return
      this.submitting = true
      try {
        if (!await this.saveDirectTemplate(false)) return
        const result = await templateGovernanceApi.submitTemplate(this.templateId, this.templateVersionId)
        this.$message.success(result.status === 'published' ? '模板已免审发布' : '模板已提交系统管理员审批')
        await this.$router.push('/portal/template?section=templates')
      } catch (error) { this.$message.error(`提交审核失败：${error.message}`) }
      finally { this.submitting = false }
    }
  }
}
