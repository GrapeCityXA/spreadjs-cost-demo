// SpreadJS 19.2 DataManager local data is part of the authoritative OT snapshot.
// Never accept a client-supplied replacement dataset at business submission.
const validPath = path => typeof path === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(path)
  && !['__proto__', 'constructor', 'prototype'].includes(path);
function bindingMappings(workbook) {
  return (workbook?.sheets || []).flatMap((sheet, sheetIndex) => (sheet.mappings || [])
    .filter(mapping => mapping.bindingPath).map(mapping => ({ ...mapping, sheetIndex })));
}
function readBoundValue(snapshot, sheet, path) {
  const data = snapshot?.data || snapshot;
  const binding = sheet?.bindingManager;
  const table = data?.dataManager?.tables?.[binding?.tableId];
  if (!validPath(path) || binding?.type !== 'cellBinding' || binding.activeRecordIndex !== 0
    || !table || table.name !== 'reportData' || table.dataSourceOption?.remote
    || !Array.isArray(table.dataSourceOption?.data) || table.dataSourceOption.data.length !== 1) {
    throw new Error('填报数据源与已发布绑定契约不一致');
  }
  const record = table.dataSourceOption.data[0];
  if (!Object.hasOwn(record, path)) throw new Error(`填报数据源缺少字段 ${path}`);
  return record[path];
}
function validateBindingSnapshot(snapshot, workbook, seed, calculatedValues = {}) {
  const mappings = bindingMappings(workbook);
  const manager = snapshot.dataManager;
  if (!mappings.length) return manager == null || Object.keys(manager).every(key => ['tables','relationships'].includes(key))
    && !Object.keys(manager.tables || {}).length && Array.isArray(manager.relationships) && !manager.relationships.length ? null : '模板未发布数据绑定';
  const tables = Object.entries(manager?.tables || {});
  if (tables.length !== 1 || !Array.isArray(manager.relationships) || manager.relationships.length
    || Object.keys(manager).some(key => !['tables', 'relationships'].includes(key))) return '填报数据表结构无效';
  const [id, table] = tables[0];
  const options = table.dataSourceOption;
  const paths = [...new Set(mappings.map(mapping => mapping.bindingPath))].sort();
  if (table.__ID__ !== id || table.name !== 'reportData' || table.primaryKey !== ''
    || Object.keys(table).some(key => !['__ID__', 'name', 'views', 'dataSourceOption', 'primaryKey'].includes(key))
    || !options || Object.keys(options).some(key => !['data', 'batch'].includes(key)) || options.batch !== false
    || !Array.isArray(options.data) || options.data.length !== 1
    || JSON.stringify(Object.keys(options.data[0] || {}).sort()) !== JSON.stringify(paths)) return '填报数据源结构与发布契约不符';
  const sheets = Object.values(snapshot.sheets || {}).sort((a,b) => a.order-b.order);
  const seedSheets = Object.values(seed?.sheets || {}).sort((a,b) => a.order-b.order);
  for (const mapping of mappings) {
    if (!validPath(mapping.bindingPath)) return '数据绑定路径无效';
    const sheet = sheets[mapping.sheetIndex], binding = sheet?.bindingManager;
    const view = table.views?.[binding?.viewId];
    if (binding?.type !== 'cellBinding' || binding.tableId !== id || binding.activeRecordIndex !== 0
      || Object.keys(binding).some(key => !['type','tableId','viewId','activeRecordIndex'].includes(key))
      || !view || view.__ID__ !== binding.viewId || !Array.isArray(view.columns)
      || JSON.stringify(view.columns.map(column => column.value).sort()) !== JSON.stringify(paths)
      || view.columns.some(column => column.name !== column.value || Object.keys(column).some(key => !['name','value','width'].includes(key)))) return '单元格绑定配置与发布契约不符';
    let expected = null;
    if (seed) {
      try { expected = readBoundValue(seed, seedSheets[mapping.sheetIndex], mapping.bindingPath); }
      catch { return '源修订缺少绑定数据源'; }
    } else if (sheet?.data?.dataTable?.[mapping.row]?.[mapping.col]?.formulaInfo) {
      // A bound formula writes its calculated result back to DataManager during
      // initialization. Validate that result, rather than requiring a blank input.
      // Formula identity and all referenced cell values are checked by
      // validateInitialSnapshot; do not trust the client-provided result cache.
      const calculation = JSON.parse(JSON.stringify(snapshot));
      for (const item of Object.values(calculation.sheets || {})) {
        for (const columns of Object.values(item.data?.dataTable || {})) {
          for (const cell of Object.values(columns || {})) if (cell.formulaInfo) delete cell.bindingPath;
        }
      }
      try {
        const { createSnapshotReader } = require('./nativeUserFormula');
        expected = createSnapshotReader(calculation, calculatedValues).read(sheet.__ID__, mapping.row, mapping.col).value;
      } catch { return `初始公式无法计算：${sheet.name}，字段 ${mapping.bindingPath}`; }
    }
    if (JSON.stringify(options.data[0][mapping.bindingPath]) !== JSON.stringify(expected)) return '初始绑定数据未保留发布值或源修订值';
  }
  return null;
}
function materializeBoundSnapshot(snapshot, calculatedValues = {}) {
  const data = JSON.parse(JSON.stringify(snapshot?.data || snapshot || {}));
  let formulaReader;
  for (const [sheetId, sheet] of Object.entries(data.sheets || {})) {
    for (const [row, columns] of Object.entries(sheet.data?.dataTable || {})) for (const [col, cell] of Object.entries(columns || {})) {
      if (cell.formulaInfo?.parts) {
        formulaReader ||= require('./nativeUserFormula').createSnapshotReader(snapshot, calculatedValues);
        cell.value = formulaReader.read(sheetId, Number(row), Number(col)).value;
        delete cell.bindingPath;
      } else if (cell.bindingPath) {
        cell.value = readBoundValue(data, sheet, cell.bindingPath);
        delete cell.bindingPath;
      }
    }
    delete sheet.bindingManager;
  }
  delete data.dataManager;
  // Keep the native snapshot format marker: formulaInfo is still in OT format.
  // Removing the marker does not convert the workbook into ordinary SSJSON.
  return data;
}
module.exports = { validPath, bindingMappings, readBoundValue, validateBindingSnapshot, materializeBoundSnapshot };
