import { editAllows } from './permissionPolicy.js'
import { ruleVisibility as ruleView } from './permissionRules.js'
function matches(list, values) { return Array.isArray(list) && list.some(value => (values || []).includes(value)) }

export function cellPermission(sheet, row, col, identity) {
  const rules = [sheet.sheetRule,
    ...(sheet.rowTags || []).filter(item => item.row === row).map(item => item.rule),
    ...(sheet.columnTags || []).filter(item => item.col === col).map(item => item.rule),
    ...(sheet.cellTags || []).filter(item => item.row === row && item.col === col).map(item => item.rule)].filter(Boolean)
  const hidden = rules.some(rule => ruleView(rule, identity) === 'hidden')
  const masked = !hidden && rules.some(rule => ruleView(rule, identity) === 'masked')
  const denied = sheet.readOnly || hidden || masked || rules.some(rule => matches(rule.denyEditForRoles, identity.roles) || matches(rule.denyEditForDepartments, identity.departments) || ['read_only', 'system'].includes(rule.permission))
    || (sheet.nonEditableRanges || []).some(range => row >= range.row && row < range.row + range.rowCount && col >= range.col && col < range.col + range.colCount)
  const mapped = (sheet.editableRanges || []).some(range => row >= range.row && row < range.row + range.rowCount && col >= range.col
    && col < range.col + range.colCount && editAllows({ editableForUsers: range.users, editableForRoles: range.roles, editableForDepartments: range.departments }, identity))
  const editable = mapped && !denied && rules.filter(rule => rule.editableForUsers || rule.editableForRoles || rule.editableForDepartments)
    .every(rule => editAllows(rule, identity))
  return { visibility: hidden ? 'hidden' : masked ? 'masked' : 'visible', editable }
}

export function isBusinessValueChange(op) {
  if (op?.module === 'dataManager' && op.type === 441) return true
  if (isBusinessClear(op)) return true
  const data = op?.payload?.rangeData
  return op?.type === 28 && op.module === 'worksheet' && data && Object.keys(data).length === 1
    && (Object.hasOwn(data, 'value') || Object.hasOwn(data, 'formula'))
}

function isBusinessClear(op) {
  return op?.type === 51 && op.module === 'worksheet' && [1, 257].includes(op.payload?.clearType)
    && Object.keys(op.payload).every(key => ['clearType', 'ignoredRowList'].includes(key))
    && (op.payload.ignoredRowList == null || Array.isArray(op.payload.ignoredRowList) && op.payload.ignoredRowList.length === 0)
}

// Keyboard edits can carry autoFormatter/locked style alongside a value.
// Keep local view metadata local; the server still authorizes each value/formula.
export function businessValueChanges(changeSet, snapshot, permissionIndex) {
  return (changeSet?.ops || []).flatMap(op => {
    // Delete emits clearRange (data | hyperlink), not a setRange with a null value.
    // Styles, permission tags and structure remain excluded; the server checks every cell.
    if (op?.module === 'dataManager' && op.type === 441) {
      // Read-only formula cells can write a calculated cache into the binding
      // source (notably after a remote auxiliary sheet loads). They are local
      // derived values, not user input operations authorized for submission.
      const item = Object.fromEntries(Object.entries(op.payload?.item || {}).filter(([path]) =>
        !Object.values(snapshot?.sheets || {}).some(sheet => {
          if (sheet.bindingManager?.tableId !== op.payload.tableId) return false
          const rules = permissionIndex?.sheets?.[sheet.order]
          return (rules?.bindings || []).some(binding => binding.path === path
            && sheet.data?.dataTable?.[binding.row]?.[binding.col]?.formulaInfo
            && (rules.nonEditableRanges || []).some(range => binding.row >= range.row
              && binding.row < range.row + range.rowCount && binding.col >= range.col
              && binding.col < range.col + range.colCount))
        })))
      return Object.keys(item).length ? [{ ...op, payload: { ...op.payload, item } }] : []
    }
    if (isBusinessClear(op)) return [op]
    const data = op?.payload?.rangeData
    if (op?.type !== 28 || op.module !== 'worksheet' || !data) return []
    return ['value', 'formula'].filter(key => Object.hasOwn(data, key)).map(key => ({
      ...op, payload: { ...op.payload, rangeData: { [key]: data[key] } },
    }))
  })
}

const originalViewStyles = new WeakMap()

const maskFormatter = { format: () => '••••', parse: () => null }

export function applyPermissionView(workbook, index, identity, mayEdit = false) {
  let visibleSheets = workbook.getSheetCount()
  for (const [sheetIndex, rules] of (index?.sheets || []).entries()) {
    const sheet = workbook.getSheet(sheetIndex)
    if (!sheet) continue
    if (ruleView(rules.sheetRule, identity) === 'hidden' && visibleSheets > 1) { sheet.visible(2); visibleSheets -= 1; continue }
    for (const { row, rule } of rules.rowTags || []) if (ruleView(rule, identity) === 'hidden') sheet.setRowVisible(row, false)
    for (const { col, rule } of rules.columnTags || []) if (ruleView(rule, identity) === 'hidden') sheet.setColumnVisible(col, false)
    if (!originalViewStyles.has(sheet)) originalViewStyles.set(sheet, new Map())
    const originalStyles = originalViewStyles.get(sheet)
    const taggedCells = new Set((rules.cellTags || []).map(item => `${item.row},${item.col}`))
    if (ruleView(rules.sheetRule, identity) !== 'visible') for (let row = 0; row < rules.rowCount; row += 1)
      for (let col = 0; col < rules.columnCount; col += 1) taggedCells.add(`${row},${col}`)
    for (const { row, rule } of rules.rowTags || []) if (ruleView(rule, identity) === 'masked')
      for (let col = 0; col < rules.columnCount; col += 1) taggedCells.add(`${row},${col}`)
    for (const { col, rule } of rules.columnTags || []) if (ruleView(rule, identity) === 'masked')
      for (let row = 0; row < rules.rowCount; row += 1) taggedCells.add(`${row},${col}`)
    for (const range of rules.editableRanges || []) for (let row = range.row; row < range.row + range.rowCount; row += 1)
      for (let col = range.col; col < range.col + range.colCount; col += 1) taggedCells.add(`${row},${col}`)
    for (const key of taggedCells) {
      const [row, col] = key.split(',').map(Number)
      const permission = cellPermission(rules, row, col, identity)
      if (!originalStyles.has(key)) originalStyles.set(key, sheet.getStyle(row, col)?.backColor)
      sheet.getCell(row, col).backColor(mayEdit && permission.editable ? '#dceeff' : originalStyles.get(key) || null)
      sheet.getCell(row, col).locked(!mayEdit || !permission.editable)
      if (permission.visibility !== 'visible') sheet.setFormatter(row, col, maskFormatter)
    }
  }
}
