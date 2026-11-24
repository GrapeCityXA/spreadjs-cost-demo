import GC from '@grapecity-software/spread-sheets'
import { cellPermission } from './permissionView'
import { isSignatureCell, signatureAnchor, isSignatureImage } from './signatureCell'

export default {
  data: () => ({ signatureDialog: false, signatureTarget: null, signatureSaving: false }),
  computed: {
    signatureLocation() { const t = this.signatureTarget; return t ? `${t.sheetName} · ${this.columnLabel(t.col)}${t.row + 1}` : '' },
    signatureExistingImage() { return isSignatureImage(this.signatureTarget?.existingValue) ? this.signatureTarget.existingValue : '' }
  },
  methods: {
    canSignCell(sheet, row, col) {
      if (!this.ready || this.recoveryRequired || this.submissionBusy || this.task?.status !== 'draft' || this.room?.status !== 'open'
        || !this.businessChangesBound || !this.permissionIdentity?.roles?.includes('subsidiary_filler')
        || !(this.task?.configuration?.assignments || []).some(item => item.responsibility === 'filler' && Number(item.userId) === this.currentUserId)) return false
      const index = this.workbook?.sheets.indexOf(sheet), rules = this.permissionIndex?.sheets?.[index]
      return Boolean(rules && isSignatureCell(sheet, row, col) && cellPermission(rules, row, col, this.permissionIdentity).editable)
    },
    bindSignatureCells() {
      this.workbook.bind(GC.Spread.Sheets.Events.CellClick, (_event, args) => {
        if (args.sheetArea !== GC.Spread.Sheets.SheetArea.viewport) return
        this.openSignatureCell(args.sheet, args.row, args.col)
      })
      this.workbook.bind(GC.Spread.Sheets.Events.EditStarting, (_event, args) => {
        const { row, col } = signatureAnchor(args.sheet, args.row, args.col)
        if (!isSignatureCell(args.sheet, row, col)) return
        args.cancel = true
        this.openSignatureCell(args.sheet, row, col)
      })
    },
    openSignatureCell(sheet, clickedRow, clickedCol) {
      if (this.signatureDialog || clickedRow < 0 || clickedCol < 0) return
      const { row, col } = signatureAnchor(sheet, clickedRow, clickedCol)
      if (!this.canSignCell(sheet, row, col)) return
      this.signatureTarget = { row, col, sheetName: sheet.name(), generation: this.roomLoadGeneration, existingValue: sheet.getValue(row, col) }
      this.signatureDialog = true
    },
    async saveSignatureImage(image) {
      const target = this.signatureTarget, book = this.workbook, doc = this.sharedDoc
      const sheet = book?.getSheetFromName(target?.sheetName)
      if (!target || target.generation !== this.roomLoadGeneration || !sheet || !this.canSignCell(sheet, target.row, target.col)) throw new Error('当前单元格已不能编辑，请关闭画板并刷新任务')
      if (!isSignatureImage(image)) throw new Error('签名图片无效')
      this.signatureSaving = true
      try {
        // Only the input value changes. The published formatter and permission Tag stay unchanged.
        sheet.setValue(target.row, target.col, image)
        const deadline = Date.now() + 15000
        while (this.pendingChangeSets && Date.now() < deadline && this.sharedDoc === doc) await new Promise(resolve => setTimeout(resolve, 30))
        if (this.sharedDoc !== doc || this.recoveryRequired || this.pendingChangeSets) throw new Error('签名尚未确认保存，请检查协作连接后重试')
        this.$message.success('签名已保存')
      } finally { this.signatureSaving = false }
    }
  }
}
