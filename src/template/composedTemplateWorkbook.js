import { registerTemplateFunctions } from './managedFunctions'
import GC from '@grapecity-software/spread-sheets'
import '@grapecity-software/spread-sheets-print'
import { bindAuxiliaryData } from './auxiliaryDataBinding'
import { shiftFormula } from './formulaShift'

// Materialize component sections only when there is no complete saved workbook.
// Detailed sheets are restored as native sheets so their design is never rebuilt
// from component definitions. Binding sources are deliberately absent here.
export async function loadTemplateWorkbook(workbook, contract, { remoteData = true, onRemoteError } = {}) {
  await registerTemplateFunctions(workbook, contract)
  if (contract.designerJson) {
    await workbook.fromJSON(contract.designerJson)
    await registerTemplateFunctions(workbook, contract)
    if (remoteData) await bindAuxiliaryData(workbook, contract, onRemoteError)
    return
  }
  const definitions = contract.sheets || []
  if (contract.designerSettings) {
    // Formula-based format strings (e.g. signature IMAGE formatters) must be
    // parsed with a real sheet context. Loading settings with sheets:{} leaves
    // null expressions that later table operations cannot traverse.
    const sheets = Object.fromEntries(definitions.map((source, index) => {
      const name = source.name || source.code
      return [name, { ...(source.designerJson || source.auxiliary?.designerJson || {}),
        name, index, rowCount: source.rowCount || 1, columnCount: source.columnCount || 1 }]
    }))
    await workbook.fromJSON({ ...contract.designerSettings, sheetCount: definitions.length, sheets })
  }
  await registerTemplateFunctions(workbook, contract)
  workbook.setSheetCount(definitions.length)
  workbook.suspendPaint()
  try {
    for (const [index, source] of definitions.entries()) {
      const sheet = workbook.getSheet(index)
      const native = source.designerJson || source.auxiliary?.designerJson
      if (native && !contract.designerSettings) sheet.fromJSON(native)
      sheet.name(source.name || source.code)
      sheet.setRowCount(source.rowCount || 1)
      sheet.setColumnCount(source.columnCount || 1)
      if (!native) for (const section of source.sections || []) {
        if (!section.designerJson) continue
        const model = new GC.Spread.Sheets.Workbook(document.createElement('div'))
        try {
          // Old component versions may contain a workbook rather than a sheet.
          if (section.designerJson.sheets) await model.fromJSON(section.designerJson)
          else model.getActiveSheet().fromJSON(section.designerJson)
          const origin = model.getActiveSheet()
          const offset = section.startRow || 0
          for (let col = 0; col < section.columnCount; col++) if (section.type === 'body') {
            sheet.setColumnWidth(col, origin.getColumnWidth(col))
            sheet.setColumnVisible(col, origin.getColumnVisible(col))
          }
          for (let row = 0; row < section.rowCount; row++) {
            sheet.setRowHeight(offset + row, origin.getRowHeight(row))
            sheet.setRowVisible(offset + row, origin.getRowVisible(row))
            if (origin.getRowPageBreak(row)) sheet.setRowPageBreak(offset + row, true)
            for (let col = 0; col < section.columnCount; col++) {
              const formula = origin.getFormula(row, col)
              if (formula) sheet.setFormula(offset + row, col, shiftFormula(formula, row, col, offset + row, col, origin))
              else sheet.setValue(offset + row, col, origin.getValue(row, col))
              sheet.setStyle(offset + row, col, origin.getActualStyle(row, col))
              const validator = origin.getDataValidator(row, col)
              if (validator) sheet.setDataValidator(offset + row, col, validator)
              const path = origin.getBindingPath(row, col)
              if (path) sheet.setBindingPath(offset + row, col, path)
            }
          }
          for (const span of origin.getSpans() || []) {
            if (span.row + span.rowCount <= section.rowCount && span.col + span.colCount <= section.columnCount)
              sheet.addSpan(offset + span.row, span.col, span.rowCount, span.colCount)
          }
        } finally { model.destroy() }
      }
      for (const cell of source.cells || []) {
        const col = cell.column ?? cell.col
        if (cell.formula) sheet.setFormula(cell.row, col, cell.formula)
        else if (Object.hasOwn(cell, 'value')) sheet.setValue(cell.row, col, cell.value)
        if (cell.tag != null) sheet.setTag(cell.row, col, cell.tag)
        if (cell.bindingPath) sheet.setBindingPath(cell.row, col, cell.bindingPath)
      }
      if (source.tag != null) sheet.tag(source.tag)
      for (const item of source.rowTags || []) sheet.setTag(item.row, -1, item.tag)
      for (const item of source.columnTags || []) sheet.setTag(-1, item.col, item.tag)
      for (const mapping of source.mappings || []) {
        if (mapping.bindingPath) sheet.setBindingPath(mapping.row, mapping.col, mapping.bindingPath)
      }
    }
  } finally { workbook.resumePaint() }
  if (remoteData) await bindAuxiliaryData(workbook, contract, onRemoteError)
}
