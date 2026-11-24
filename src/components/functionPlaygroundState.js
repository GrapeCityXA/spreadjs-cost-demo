export function normalizeTrialCells(value) {
  if (!Array.isArray(value) || value.length > 300) return null
  const cells = new Map()
  for (const cell of value) {
    if (!cell || !Number.isInteger(cell.row) || !Number.isInteger(cell.col) || cell.row < 0 || cell.row >= 30 || cell.col < 0 || cell.col >= 10) continue
    const position = { row: cell.row, col: cell.col }
    if (typeof cell.formula === 'string' && cell.formula) cells.set(`${cell.row}:${cell.col}`, { ...position, formula: cell.formula })
    else if (typeof cell.value === 'string' || typeof cell.value === 'boolean' || (typeof cell.value === 'number' && Number.isFinite(cell.value))) cells.set(`${cell.row}:${cell.col}`, { ...position, value: cell.value })
  }
  return [...cells.values()]
}

export function resolveFunctionDraft(saved, baseline, hasServerCode) {
  if (!saved || typeof saved.code !== 'string') return { code: baseline, cells: null, conflict: false }
  const conflict = hasServerCode && saved.code !== baseline && saved.baseCode !== baseline
  return { code: conflict ? baseline : saved.code, cells: conflict ? null : normalizeTrialCells(saved.sheetCells), conflict }
}

export function playgroundStorageKey(userId, draftKey, readonly = false) {
  return `spreadjs-function-playground:v1:${userId}${draftKey ? `:${draftKey}` : ''}${readonly ? ':preview' : ''}`
}
