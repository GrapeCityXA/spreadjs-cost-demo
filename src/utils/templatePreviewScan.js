import { templateCellError } from './templatePageState.js'

// Include every used-range type: bound cells and formatted regions must not be
// excluded simply because they contain no stored literal value or formula.
export async function scanTemplateFormulaErrors(sheet, {
  usedRangeType, CalcError, isCurrent = () => true,
  yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)),
  now = () => performance.now()
}) {
  if (!isCurrent()) return null
  const rowCount = sheet.getRowCount(), colCount = sheet.getColumnCount()
  const range = sheet.getUsedRange(usedRangeType)
  if (!range) return []
  const axis = (start, count, limit) => {
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0) return [0, limit]
    return [Math.min(start, limit), Math.min(start + count, limit)]
  }
  const [rowStart, rowEnd] = axis(range.row, range.rowCount, rowCount)
  const [colStart, colEnd] = axis(range.col, range.colCount, colCount)
  const errors = [], name = sheet.name()
  let checked = 0, sliceStart = now()
  for (let row = rowStart; row < rowEnd; row++) for (let col = colStart; col < colEnd; col++) {
    if (templateCellError(sheet.getFormula(row, col), sheet.getValue(row, col), CalcError)) {
      errors.push(`${name}!R${row + 1}C${col + 1} 存在公式引用或计算错误`)
    }
    // Check time in batches; large/dense sheets still allow close, retry and paint.
    if (++checked % 64 === 0 && now() - sliceStart >= 8) {
      await yieldControl()
      if (!isCurrent()) return null
      sliceStart = now()
    }
  }
  return isCurrent() ? errors : null
}
