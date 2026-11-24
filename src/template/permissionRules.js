// Kept in parity with server/src/services/permissionIndex.js; published restrictions intersect.
export const permissionKeys = ['permissionModel', 'editDimension', 'editableForUsers', 'permission', 'visibility', 'hiddenForRoles', 'maskedForRoles', 'editableForRoles', 'denyEditForRoles',
  'hiddenForDepartments', 'maskedForDepartments', 'editableForDepartments', 'denyEditForDepartments',
  'allVisible', 'dimension', 'visibleUsers', 'visibleRoles', 'visibleDepartments', 'excludedVisibility']

export function audienceAllows(rule, identity) {
  if (rule.allVisible !== false) return true
  if (rule.dimension === 'user') return (rule.visibleUsers || []).some(id => Number(id) === Number(identity.userId))
  const values = rule.dimension === 'role' ? identity.roles : identity.departments
  const list = rule.dimension === 'role' ? rule.visibleRoles : rule.visibleDepartments
  return (list || []).some(value => (values || []).includes(value))
}

export function ruleVisibility(rule, identity) {
  if (!rule) return 'visible'
  const matches = (list, values) => (list || []).some(value => (values || []).includes(value))
  if (rule.visibility === 'hidden' || matches(rule.hiddenForRoles, identity.roles) || matches(rule.hiddenForDepartments, identity.departments)
    || !audienceAllows(rule, identity) && rule.excludedVisibility !== 'masked') return 'hidden'
  if (rule.visibility === 'masked' || matches(rule.maskedForRoles, identity.roles) || matches(rule.maskedForDepartments, identity.departments)
    || !audienceAllows(rule, identity)) return 'masked'
  return 'visible'
}

export function permissionTargets(sheet, scope) {
  if (scope === 'sheet') return [{ row: -1, col: -1 }]
  const targets = new Map()
  for (const selection of sheet.getSelections()) {
    const startRow = Math.max(0, selection.row), startCol = Math.max(0, selection.col)
    const rows = selection.row < 0 ? sheet.getRowCount() : selection.rowCount
    const cols = selection.col < 0 ? sheet.getColumnCount() : selection.colCount
    if (scope === 'row') for (let row = startRow; row < startRow + rows; row++) targets.set(`${row},-1`, { row, col: -1 })
    else if (scope === 'column') for (let col = startCol; col < startCol + cols; col++) targets.set(`-1,${col}`, { row: -1, col })
    else for (let row = startRow; row < startRow + rows; row++) for (let col = startCol; col < startCol + cols; col++) targets.set(`${row},${col}`, { row, col })
  }
  return [...targets.values()]
}
