export function cellAddress(row, col) {
  let letters = ''
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + (n - 1) % 26) + letters
  return `${letters}${row + 1}`
}
export function dependencyCell(book, sheetName, row, col) {
  if (typeof sheetName !== 'string' || !Number.isSafeInteger(row) || !Number.isSafeInteger(col) || row < 0 || col < 0) return null
  const sheet = book.getSheetFromName(sheetName)
  if (!sheet || row < 0 || col < 0 || row >= sheet.getRowCount() || col >= sheet.getColumnCount()) return null
  const value = sheet.getValue(row, col), text = sheet.getText(row, col), formula = sheet.getFormula(row, col)
  return { sheetName, row, col, key: JSON.stringify([sheetName, row, col]),
    address: `'${sheetName.replace(/'/g, "''")}'!${cellAddress(row, col)}`,
    formula: typeof formula === 'string' ? formula : '', displayValue: value == null ? '（空）' : text === '' ? String(value) : String(text) }
}
// Bound traversal before expanding SDK ranges, including whole-column references.
export function reportDependencies(book, origin, direction = 'precedents', limits = {}) {
  const { maxNodes = 160, maxDepth = 5, maxChildren = 30 } = limits
  let count = 1, serial = 0, examined = 0
  const maxExamined = 1600
  const notices = new Set(), rootCell = origin && dependencyCell(book, origin.sheetName, origin.row, origin.col)
  if (!rootCell) return { root: null, notices: ['所选单元格不存在'], count: 0 }
  const nodeFor = (cell, depth, kind) => ({ ...cell, id: String(serial++), name: cell.address, depth, kind, children: [] })
  const root = nodeFor(rootCell, 0, 'root')
  function walk(node, kind, path) {
    if (path.has(node.key)) { node.note = '循环引用，已停止展开'; notices.add(node.note); return }
    if (node.depth >= maxDepth) { node.note = `最多显示 ${maxDepth} 层，可定位后继续追踪`; notices.add(node.note); return }
    const sheet = book.getSheetFromName(node.sheetName)
    let ranges
    try { ranges = (kind === 'precedents' ? sheet.getPrecedents(node.row, node.col) : sheet.getDependents(node.row, node.col)) || [] }
    catch { node.note = '此单元格的依赖信息暂不可解析'; notices.add(node.note); return }
    if (!Array.isArray(ranges)) { node.note = '此单元格的依赖信息格式异常'; notices.add(node.note); return }
    const nextPath = new Set(path).add(node.key), seen = new Set()
    for (const range of ranges) {
      if (!range || typeof range.sheetName !== 'string'
        || !Number.isSafeInteger(range.row) || range.row < -1 || !Number.isSafeInteger(range.col) || range.col < -1
        || !Number.isSafeInteger(range.rowCount ?? 1) || (range.rowCount ?? 1) < -1
        || !Number.isSafeInteger(range.colCount ?? 1) || (range.colCount ?? 1) < -1) {
        notices.add('部分引用范围无效，已跳过；当前关系可能不完整'); continue
      }
      const target = book.getSheetFromName(range.sheetName)
      if (!target) { notices.add(`引用的工作表不可用：${range.sheetName}`); continue }
      const startRow = Math.max(0, range.row), startCol = Math.max(0, range.col)
      const endRow = range.row < 0 || range.rowCount < 0 ? target.getRowCount() : Math.min(target.getRowCount(), startRow + (range.rowCount ?? 1))
      const endCol = range.col < 0 || range.colCount < 0 ? target.getColumnCount() : Math.min(target.getColumnCount(), startCol + (range.colCount ?? 1))
      for (let row = startRow; row < endRow; row++) for (let col = startCol; col < endCol; col++) {
        if (count >= maxNodes || node.children.length >= maxChildren) {
          notices.add(`关系较多，当前最多展示 ${maxNodes} 个节点、每个节点 ${maxChildren} 个直接关联；可定位到单元格继续追踪`); return
        }
        if (++examined > maxExamined) { notices.add('部分引用范围重复或无法读取，已达到检查上限；可选择其他单元格继续追踪'); return }
        let cell
        try { cell = dependencyCell(book, range.sheetName, row, col) }
        catch { notices.add('部分关联单元格无法读取，已保留其他可用关系'); continue }
        if (!cell || seen.has(cell.key)) continue
        seen.add(cell.key)
        const child = nodeFor(cell, node.depth + 1, kind)
        node.children.push(child); count++; walk(child, kind, nextPath)
      }
    }
  }
  if (direction === 'both') {
    for (const kind of ['precedents', 'dependents']) {
      const group = { ...root, id: String(serial++), name: kind === 'precedents' ? '引用来源' : '影响去向', group: true, children: [] }
      walk(group, kind, new Set()); root.children.push(group)
    }
  } else walk(root, direction, new Set())
  return { root, notices: [...notices], count }
}

// Preserve the actual ancestry when flattening; synthetic direction groups are not cells.
export function dependencyRows(root) {
  const rows = []
  function visit(node, ancestors = []) {
    if (!node) return
    if (node.group) { node.children?.forEach(child => visit(child, ancestors)); return }
    const parent = ancestors.at(-1)
    const path = [...ancestors, node]
    rows.push({ ...node,
      relation: !parent ? '分析起点' : node.kind === 'precedents'
        ? `${parent.address} 引用了 ${node.address}` : `${node.address} 引用了 ${parent.address}`,
      pathText: path.map(cell => cell.address).join(' → '),
    })
    node.children?.forEach(child => visit(child, path))
  }
  visit(root)
  return rows
}
