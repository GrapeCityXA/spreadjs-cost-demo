const { normalizedTag } = require('./permissionIndex');

const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };

function assertStructureOnly(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if ((['dataSource', 'bindingSource'].includes(key) && child != null)
      || (key === 'dataManager' && child && (Object.keys(child.tables || {}).length || (child.relationships || []).length))) {
      invalid('模板只能保存工作簿结构，绑定数据源必须与模板分开保存');
    }
    assertStructureOnly(child);
  }
}

function directWorkbookJson(value, sheets, { allowComposed = false } = {}) {
  if (value == null) {
    if (!allowComposed && sheets.some(sheet => sheet.inlineWorkbook)) invalid('直接设计模板必须保存完整工作簿结构');
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.sheets || (!allowComposed && !sheets.every(sheet => sheet.inlineWorkbook))) {
    invalid('完整工作簿结构只能用于直接设计的模板');
  }
  assertStructureOnly(value);
  const nativeSheets = Object.values(value.sheets).sort((a, b) => (a.order ?? a.index ?? 0) - (b.order ?? b.index ?? 0));
  if (nativeSheets.length !== sheets.length || nativeSheets.some((sheet, index) => sheet.name !== sheets[index].name)) {
    invalid('完整工作簿的工作表名称、顺序必须与模板定义一致');
  }
  for (const [index, sheet] of sheets.entries()) {
    const inline = sheet.inlineWorkbook;
    if (!inline) continue;
    if (nativeSheets[index].rowCount !== Number(inline.rowCount) || nativeSheets[index].columnCount !== Number(inline.columnCount)) {
      invalid('完整工作簿与工作表尺寸不一致');
    }
    inline.metadata = { ...inline.metadata, designerJson: nativeSheets[index] };
  }
  return value;
}

function directTemplateSnapshot(value, sheets, { allowComposed = false } = {}) {
  if (value == null) return null;
  assertStructureOnly(value);
  const nativeSheets = Object.values(value.sheets || {}).sort((a, b) => a.order - b.order);
  if (value.version !== '19.2.0' || nativeSheets.length !== sheets.length || nativeSheets.some((sheet, index) =>
    sheet.name !== sheets[index].name || ((!allowComposed || sheets[index].inlineWorkbook)
      && (sheet.rowCount !== sheets[index].inlineWorkbook?.rowCount
      || sheet.columnCount !== sheets[index].inlineWorkbook?.columnCount)))) invalid('模板协作版式与工作表定义不一致');
  return value;
}

function normalizeInlineWorkbook(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('直接设计工作表内容无效');
  const rowCount = Number(value.rowCount), columnCount = Number(value.columnCount);
  if (!Number.isSafeInteger(rowCount) || rowCount < 1 || !Number.isSafeInteger(columnCount) || columnCount < 1) {
    invalid('直接设计工作表行列数必须是正整数');
  }
  if (!Array.isArray(value.cells) || value.cells.length > rowCount * columnCount) invalid('直接设计工作表的单元格内容无效');
  const cells = value.cells.map(cell => {
    if (!Number.isInteger(cell.row) || !Number.isInteger(cell.column) || cell.row < 0 || cell.column < 0 || cell.row >= rowCount || cell.column >= columnCount) {
      invalid('直接设计工作表的单元格超出范围');
    }
    return { ...cell, ...(cell.tag != null ? { tag: normalizedTag(cell.tag) } : {}) };
  });
  const metadata = value.metadata || {};
  assertStructureOnly(metadata.designerJson);
  if (!metadata.designerJson || metadata.designerJson.rowCount !== rowCount || metadata.designerJson.columnCount !== columnCount) {
    invalid('直接设计工作表缺少一致的 Designer 结构');
  }
  return { rowCount, columnCount, cells, metadata: {
    designerJson: metadata.designerJson,
    mappings: Array.isArray(metadata.mappings) ? metadata.mappings : [],
    nativeValidations: Array.isArray(metadata.nativeValidations) ? metadata.nativeValidations : [],
    permissionTags: metadata.permissionTags || {}
  } };
}

function materializeInlineSheet(row) {
  const source = row.auxiliary.inlineWorkbook;
  const permissions = source.metadata.permissionTags || {};
  const mappings = source.metadata.mappings.map(mapping => {
    const { componentVersionId, componentNamedArea, ...rest } = mapping;
    return { ...rest, sheet: row.sheet_code, section: 'direct',
      occurrences: [{ sheet: row.sheet_code, row: mapping.row, col: mapping.col, rowCount: mapping.rowCount, colCount: mapping.colCount }] };
  });
  return { code: row.sheet_code, name: row.display_name, type: row.sheet_type, readOnly: row.sheet_type === 'auxiliary', designMode: 'direct',
    rowCount: source.rowCount, columnCount: source.columnCount, cells: source.cells, mappings,
    designerJson: source.metadata.designerJson, nativeValidations: source.metadata.nativeValidations,
    tag: permissions.sheet == null ? null : normalizedTag(permissions.sheet),
    rowTags: (permissions.rows || []).map(item => ({ ...item, tag: normalizedTag(item.tag) })),
    columnTags: (permissions.columns || []).map(item => ({ ...item, tag: normalizedTag(item.tag) })) };
}

module.exports = { directTemplateSnapshot, directWorkbookJson, normalizeInlineWorkbook, materializeInlineSheet };
