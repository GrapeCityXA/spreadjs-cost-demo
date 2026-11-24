import GC from '@grapecity-software/spread-sheets'
import { readCellTag, signatureAnchor, SIGNATURE_FORMAT } from './signatureCell'

export default {
  data: () => ({ signatureEnabled: false, signatureTargetLabel: '请先选择单元格' }),
  methods: {
    loadSignatureCell() {
      const sheet = this.spread?.getActiveSheet(), target = this.selectedTargetCell
      if (!sheet || !target) { this.signatureEnabled = false; this.signatureTargetLabel = '请先选择单元格'; return }
      const { row, col } = signatureAnchor(sheet, target.row, target.col)
      this.signatureEnabled = readCellTag(sheet.getTag(row, col)).signature?.version === 1
      this.signatureTargetLabel = `${sheet.name()} · R${row + 1}C${col + 1}`
    },
    setSignatureCell(enabled) {
      const target = this.insertionTarget()
      if (!target) return
      const sheet = this.spread.getActiveSheet(), { row, col } = signatureAnchor(sheet, target.row, target.col)
      const oldTag = sheet.getTag(row, col), tag = readCellTag(oldTag)
      if (enabled && !tag.signature) {
        if (sheet.getFormula(row, col)) { this.$message.warning('公式单元格不能设置为签名单元格'); return }
        if (sheet.getValue(row, col) != null && sheet.getValue(row, col) !== '') { this.$message.warning('请先选择空白单元格，避免覆盖原有内容'); return }
        const mapping = this.mappings.find(item => item.row === row && item.col === col)
        const field = this.fields.find(item => Number(item.id) === Number(mapping?.fieldDefinitionId))
        if (mapping && !['short_text', 'long_text'].includes(field?.type || field?.dataType)) { this.$message.warning('签名只能绑定文本字段，也可以使用未绑定字段的单元格'); return }
      }
      const beforeStyle = sheet.getStyle(row, col)?.clone() || null
      const afterStyle = beforeStyle?.clone() || new GC.Spread.Sheets.Style()
      if (enabled) {
        tag.schemaVersion = 1
        tag.platform ||= 'cost-report-cell-permission-v1'
        tag.signature ||= { version: 1, previousFormatter: afterStyle.formatter ?? null, previousWatermark: afterStyle.watermark ?? null }
        // A new standalone input starts with filler access; existing restrictions remain intact.
        if (!tag.permission) { tag.permission = 'primary_input'; tag.editableForRoles ||= ['subsidiary_filler'] }
        afterStyle.formatter = SIGNATURE_FORMAT
        afterStyle.watermark = '点击签名'
      } else {
        if (afterStyle.formatter === SIGNATURE_FORMAT) afterStyle.formatter = tag.signature?.previousFormatter ?? null
        if (afterStyle.watermark === '点击签名') afterStyle.watermark = tag.signature?.previousWatermark ?? null
        delete tag.signature
      }
      this.spread.commandManager().register('costReportSignatureCell', { canUndo: true, execute: (spread, options, undo) => {
        const targetSheet = spread.getSheetFromName(options.sheetName)
        if (!targetSheet) return false
        targetSheet.setTag(options.row, options.col, undo ? options.beforeTag : options.afterTag)
        targetSheet.setStyle(options.row, options.col, undo ? options.beforeStyle : options.afterStyle)
        this.loadSignatureCell(); this.refreshHistoryState()
        return true
      } })
      this.spread.commandManager().execute({ cmd: 'costReportSignatureCell', sheetName: sheet.name(), row, col,
        beforeTag: oldTag ?? null, afterTag: JSON.stringify(tag), beforeStyle, afterStyle })
    }
  }
}
