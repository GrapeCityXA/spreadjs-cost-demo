// Apply only to the preview instance, after deserialization restores its options.
export function protectWorkbookPreview(book) {
  Object.assign(book.options, {
    newTabVisible: false, tabEditable: false, allowSheetReorder: false,
    allowContextMenu: false, allowUserDragDrop: false, allowUserDragFill: false,
    allowUserDragMerge: false, allowUndo: false, allowUserEditFormula: false,
    enableAccessibility: true,
  })
  book.suspendPaint()
  try {
    for (const sheet of book.sheets) {
      sheet.getRange(0, 0, sheet.getRowCount(), sheet.getColumnCount()).locked(true)
      sheet.options.protectionOptions = {
        allowSelectLockedCells: true, allowSelectUnlockedCells: true,
        allowResizeRows: true, allowResizeColumns: true,
        allowOutlineRows: true, allowOutlineColumns: true,
        allowEditObjects: false, allowEditScenarios: false,
        allowInsertRows: false, allowInsertColumns: false,
        allowDeleteRows: false, allowDeleteColumns: false,
        allowDragInsertRows: false, allowDragInsertColumns: false,
        allowSort: false, allowFilter: false,
      }
      sheet.options.isProtected = true
    }
  } finally { book.resumePaint() }
}

export function hasPreviewSheets(source) {
  return Boolean(source && typeof source === 'object' && source.sheets
    && typeof source.sheets === 'object' && Object.keys(source.sheets).length)
}
