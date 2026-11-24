import GC from '@grapecity-software/spread-sheets'
import '../src/utils/spreadjsLicense.js'
import '../src/template/restoreRevisionWorkbook.js'
import { type } from '@grapecity-software/spread-sheets-collaboration-client'

export function nativeSnapshot() {
  const host = document.createElement('div'); document.body.append(host)
  const book = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1 })
  try {
    book.collaboration.registerCollaborationType(type)
    const sheet = book.getActiveSheet(); sheet.name('定稿原表')
    sheet.setValue(0, 0, 10); sheet.setValue(1, 0, 20)
    sheet.setFormula(0, 1, 'SUM(A1:A2)'); sheet.setActiveCell(0, 1)
    return JSON.parse(JSON.stringify(book.collaboration.toSnapshot()))
  } finally { book.destroy(); host.remove() }
}
