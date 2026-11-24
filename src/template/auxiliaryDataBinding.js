import GC from '@grapecity-software/spread-sheets'

// Reference data belongs to the remote DataManager, never to the task dataset.
const runtimeSheets = new WeakMap()
const clone = value => JSON.parse(JSON.stringify(value))
function bindingError(field, message) { return Object.assign(new Error(message), { field }) }
export function normalizeAuxiliaryBinding(value) {
  const url = String(value?.url || '').trim(), dataPath = String(value?.dataPath || '').trim()
  let parsed
  if (!url) throw bindingError('url', '请填写要读取的接口地址。')
  try { parsed = new URL(url) } catch { throw bindingError('url', '接口地址不完整，请填写以 http:// 或 https:// 开头的完整地址。') }
  if (url.length > 2000) throw bindingError('url', '接口地址不能超过 2,000 个字符，请缩短地址或查询参数。')
  if (!['http:', 'https:'].includes(parsed.protocol)) throw bindingError('url', '仅支持 HTTP 或 HTTPS 接口，请检查地址开头。')
  if (parsed.username || parsed.password) throw bindingError('url', '接口地址不能包含用户名或密码，请使用不含登录凭据的地址。')
  if (dataPath.length > 200) throw bindingError('dataPath', '数据路径不能超过 200 个字符，请检查是否误填了接口地址或返回内容。')
  if (dataPath && !/^[\w$]+(?:\.[\w$]+)*$/.test(dataPath)
    || dataPath.split('.').some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw bindingError('dataPath', '请用点连接数据所在的属性名，例如 data.items；直接返回数组时留空。')
  return { engine: 'datamanager', url, dataPath }
}

export async function bindAuxiliarySheet(workbook, sheet, definition, index) {
  const config = normalizeAuxiliaryBinding(definition.dataBinding)
  const manager = workbook.dataManager(), tableName = `auxiliary_source_${index}`, gridName = `AuxiliaryTable_${index}`
  let states = runtimeSheets.get(workbook)
  if (!states) { states = new Map(); runtimeSheets.set(workbook, states) }
  if (!states.has(sheet)) states.set(sheet, { base: clone(sheet.toJSON({ includeBindingSource: false })), tableName })
  // Protection covers loading, empty and failed results; API writes remain allowed.
  sheet.getRange(-1, -1, -1, -1).locked(true)
  sheet.options.protectionOptions = { allowSelectLockedCells: true, allowSelectUnlockedCells: true }
  sheet.options.isProtected = true
  const previous = sheet.tables.findByName(gridName)
  if (previous) sheet.tables.remove(gridName, GC.Spread.Sheets.Tables.TableRemoveOptions.none)
  if (manager.tables[tableName]) manager.removeTable(tableName)
  const source = manager.addTable(tableName, { remote: { read: { url: config.url, method: 'GET' } },
    ...(config.dataPath ? { schema: { dataPath: config.dataPath } } : {}) })
  let timer
  try {
    const rows = await Promise.race([source.fetch(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('接口读取超时（15 秒），请检查网络和接口地址后重新读取。')), 15000) })])
    if (runtimeSheets.get(workbook) !== states) return
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('未找到可用的记录数组，每条记录需要包含字段和值。若记录嵌套在返回内容中，请填写对应的数据路径。')
    const columns = Object.keys(source.columns || {})
    if (rows.length > 10000 || columns.length > 200) throw new Error('辅助表最多支持 10,000 条记录、200 列，请缩小接口返回范围')
    if (!columns.length) return { rowCount: 0, columnCount: 0 }
    sheet.setRowCount(Math.max(definition.rowCount || 20, rows.length + 1))
    sheet.setColumnCount(Math.max(definition.columnCount || 10, columns.length))
    const table = sheet.tables.add(gridName, 0, 0, Math.max(2, rows.length + 1), columns.length)
    table.bind([], null, tableName)
    for (let col = 0; col < columns.length; col++) sheet.setColumnWidth(col, 150)
    return { rowCount: rows.length, columnCount: columns.length }
  } finally { clearTimeout(timer) }
}

export async function bindAuxiliaryData(workbook, contract, onError = () => {}) {
  for (const [index, definition] of (contract?.sheets || []).entries()) {
    if (definition.type !== 'auxiliary' || !definition.dataBinding) continue
    try { await bindAuxiliarySheet(workbook, workbook.getSheet(index), definition, index) }
    catch (error) { onError(`${definition.name}：${error.message || '接口读取失败，请检查 URL、数据路径及接口跨域设置'}`) }
  }
}

// Keep remote results and runtime table layout out of saved templates and OT seeds.
export function auxiliaryStructureJSON(workbook) {
  const json = clone(workbook.toJSON({ includeBindingSource: false }))
  for (const [sheet, state] of runtimeSheets.get(workbook) || []) {
    const key = Object.keys(json.sheets || {}).find(key => json.sheets[key].name === sheet.name())
    if (key == null) continue
    const native = json.sheets[key]
    json.sheets[key] = { ...clone(state.base), name: native.name, index: native.index, order: native.order }
    if (Array.isArray(json.dataManager?.tables)) json.dataManager.tables = json.dataManager.tables.filter(table => table?.name !== state.tableName)
    else for (const [id, table] of Object.entries(json.dataManager?.tables || {})) {
      if (id === state.tableName || table?.name === state.tableName) delete json.dataManager.tables[id]
    }
  }
  return json
}

export function disposeAuxiliaryData(workbook) { runtimeSheets.delete(workbook) }
