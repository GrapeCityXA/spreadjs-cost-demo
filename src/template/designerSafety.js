import { sheetDesignFingerprint } from './sheetDesignState'
import { auxiliaryStructureJSON } from './auxiliaryDataBinding'

// Compare only when leaving, not on every keystroke or selection change.
export default {
  methods: {
    designerFingerprint() {
      if (!this.spread) return null
      const json = auxiliaryStructureJSON(this.spread)
      delete json.activeSheetIndex
      json.sheets = Object.fromEntries(Object.entries(json.sheets || {}).map(([name, sheet]) =>
        [name, { order: sheet.order, index: sheet.index, content: sheetDesignFingerprint(sheet) }]))
      return JSON.stringify({ workbook: json, name: this.form.name, code: this.form.code,
        componentType: this.form.componentType, factory: this.templateFactory, description: this.templateDescription })
    },
    rememberSavedDesign() { this._savedDesign = this.designerFingerprint() },
    hasUnsavedDesign() {
      return Boolean(this.canEdit && this._savedDesign != null &&
        (this.hasPermissionDraft?.() || this.spread?.getActiveSheet()?.isEditing() || this.designerFingerprint() !== this._savedDesign))
    },
    async confirmDesignerLeave() {
      if (!this.hasUnsavedDesign()) return true
      try {
        await this.$confirm('当前修改尚未保存，离开后将丢失。', '离开设计工作台？', {
          confirmButtonText: '放弃修改并离开', cancelButtonText: '继续编辑', type: 'warning',
          closeOnClickModal: false, distinguishCancelAndClose: true
        })
        return true
      } catch { return false }
    },
    warnUnsavedDesign(event) {
      if (!this.hasUnsavedDesign()) return
      event.preventDefault()
      event.returnValue = ''
    }
  }
}
