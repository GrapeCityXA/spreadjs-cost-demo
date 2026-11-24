import GC from '@grapecity-software/spread-sheets'

// Templates carry paths only. Each task owns its local, collaborative dataset.
export async function bindReportData(workbook, contract) {
  const entries = (contract?.sheets || []).flatMap((sheet, sheetIndex) =>
    (sheet.mappings || []).filter(mapping => mapping.bindingPath).map(mapping => ({ ...mapping, sheetIndex })))
  if (!entries.length) return
  const record = Object.fromEntries(entries.map(mapping => [mapping.bindingPath, null]))
  const table = workbook.dataManager().addTable('reportData', { data: [record] })
  await table.fetch()
  for (const sheetIndex of new Set(entries.map(entry => entry.sheetIndex))) {
    const sheet = workbook.getSheet(sheetIndex)
    for (const entry of entries.filter(item => item.sheetIndex === sheetIndex)) sheet.setBindingPath(entry.row, entry.col, entry.bindingPath)
    sheet.setDataSource(new GC.Spread.Sheets.Bindings.CellBindingSource(table, 0))
  }
}

export function readBoundValue(sheet, mapping) {
  return mapping.bindingPath && sheet?.getBindingPath(mapping.row, mapping.col)
    ? sheet.getDataSource()?.getValue(mapping.bindingPath) : sheet?.getValue(mapping.row, mapping.col)
}
