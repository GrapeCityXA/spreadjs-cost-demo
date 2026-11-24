const READ_ONLY_ECONOMICS_TAG = JSON.stringify({ schemaVersion: 1,
  denyEditForRoles: ['subsidiary_filler', 'subsidiary_submitter', 'department_reviewer', 'score_editor', 'report_finalizer'] });
const quarterlyReferenceProfile = require('../../../shared/quarterly-reference-profile.json');

function isQuarterlyReferenceTemplate(manifest) {
  return manifest?.sourceWorkbook?.sha256 === quarterlyReferenceProfile.sha256;
}

const quarterlyIndicatorTag = indicator => JSON.stringify({
  schemaVersion: 1,
  indicatorCode: indicator.code,
  recordKey: indicator.recordKey,
  category: indicator.category,
  tagCode: indicator.tagCode,
  displayName: indicator.displayName,
  maximumScore: indicator.maximumScore,
  denyEditForRoles: ['department_reviewer', 'score_editor']
});

function economicsSheet(dependencies) {
  const quarterRevenue = dependencies?.currentQuarter?.revenue?.value ?? null;
  const quarterProfit = dependencies?.currentQuarter?.profit?.value ?? null;
  const ytdRevenue = dependencies?.yearToDate?.revenue?.value ?? null;
  const ytdProfit = dependencies?.yearToDate?.profit?.value ?? null;
  return {
    code: 'quarterly_economics', name: '季度经济指标', rowCount: 4, columnCount: 3, readOnly: true,
    cells: [
      { row: 0, column: 0, value: '经济指标', tag: READ_ONLY_ECONOMICS_TAG },
      { row: 0, column: 1, value: '本季度', tag: READ_ONLY_ECONOMICS_TAG },
      { row: 0, column: 2, value: '年初至今', tag: READ_ONLY_ECONOMICS_TAG },
      { row: 1, column: 0, value: '营业收入', tag: READ_ONLY_ECONOMICS_TAG },
      { row: 1, column: 1, value: quarterRevenue, tag: READ_ONLY_ECONOMICS_TAG },
      { row: 1, column: 2, value: ytdRevenue, tag: READ_ONLY_ECONOMICS_TAG },
      { row: 2, column: 0, value: '利润总额', tag: READ_ONLY_ECONOMICS_TAG },
      { row: 2, column: 1, value: quarterProfit, tag: READ_ONLY_ECONOMICS_TAG },
      { row: 2, column: 2, value: ytdProfit, tag: READ_ONLY_ECONOMICS_TAG },
      { row: 3, column: 0, value: '月报依赖状态', tag: READ_ONLY_ECONOMICS_TAG },
      { row: 3, column: 1, value: dependencies?.complete ? '已齐全' : '待齐全', tag: READ_ONLY_ECONOMICS_TAG },
      { row: 3, column: 2, value: dependencies?.missingPeriods?.map(item => item.periodCode).join('、') || '', tag: READ_ONLY_ECONOMICS_TAG }
    ],
    mappings: [
      { kind: 'calculated', fieldCode: 'QUARTER_REVENUE', namedArea: 'QUARTERLY_CALC_REVENUE', row: 1, col: 1, rowCount: 1, colCount: 1 },
      { kind: 'calculated', fieldCode: 'QUARTER_PROFIT', namedArea: 'QUARTERLY_CALC_PROFIT', row: 2, col: 1, rowCount: 1, colCount: 1 },
      { kind: 'calculated', fieldCode: 'YTD_REVENUE', namedArea: 'QUARTERLY_CALC_YTD_REVENUE', row: 1, col: 2, rowCount: 1, colCount: 1 },
      { kind: 'calculated', fieldCode: 'YTD_PROFIT', namedArea: 'QUARTERLY_CALC_YTD_PROFIT', row: 2, col: 2, rowCount: 1, colCount: 1 }
    ]
  };
}

function quarterlyReferenceSheetNames(workbook, organizationId, referenceCompanySheets, required = false) {
  if (referenceCompanySheets == null) {
    if (required) throw new Error('季度参考模板缺少组织公司页映射');
    return null;
  }
  const sheetCode = referenceCompanySheets[String(organizationId)];
  if (typeof sheetCode !== 'string' || !sheetCode) throw new Error('季度参考模板缺少当前组织的公司页映射');
  const sheets = Array.isArray(workbook?.sheets) ? workbook.sheets : [];
  const matches = sheets.filter(sheet => sheet.code === sheetCode);
  if (matches.length !== 1 || matches[0].readOnly) throw new Error('季度参考模板的公司页映射无效');
  return new Set([String(matches[0].name || matches[0].code)]);
}

function scopeQuarterlyWorkbook(workbook, organizationId, referenceCompanySheets, required = false) {
  const result = JSON.parse(JSON.stringify(workbook || {}));
  const allowedNames = quarterlyReferenceSheetNames(result, organizationId, referenceCompanySheets, required);
  if (!allowedNames) return result;
  result.sheets = (result.sheets || []).filter(sheet => allowedNames.has(String(sheet.name || sheet.code)));
  return result;
}

function scopeQuarterlySpreadJsonWorkbook(spreadJson, workbookDefinition, organizationId, referenceCompanySheets, required = false) {
  const allowedNames = quarterlyReferenceSheetNames(workbookDefinition, organizationId, referenceCompanySheets, required);
  if (!allowedNames) return spreadJson;
  if (!spreadJson || typeof spreadJson !== 'object' || !spreadJson.sheets
    || typeof spreadJson.sheets !== 'object' || Array.isArray(spreadJson.sheets)) {
    throw new Error('季度参考修订工作簿格式无效，无法安全应用组织范围');
  }
  const result = JSON.parse(JSON.stringify(spreadJson));
  const entries = Object.entries(result.sheets);
  const scopedSheets = Object.fromEntries(entries.filter(([, sheet]) => allowedNames.has(String(sheet?.name || ''))));
  const matchingSheets = entries.filter(([, sheet]) => allowedNames.has(String(sheet?.name || '')));
  if (matchingSheets.length !== allowedNames.size
    || new Set(Object.values(scopedSheets).map(sheet => String(sheet.name))).size !== allowedNames.size) {
    throw new Error('季度参考修订工作簿缺少获准的组织工作表');
  }
  result.sheets = scopedSheets;
  if (!Object.hasOwn(scopedSheets, result.activeSheetId)) {
    const active = Object.entries(scopedSheets).find(([, sheet]) => sheet.name === [...allowedNames][0]);
    if (!active) throw new Error('季度参考修订工作簿没有可用的当前组织工作表');
    result.activeSheetId = active[0];
  }
  return result;
}

function buildQuarterlyWorkbook(workbook, indicators, dependencies, taskScope = null) {
  const result = taskScope
    ? scopeQuarterlyWorkbook(workbook, taskScope.organizationId, taskScope.referenceCompanySheets,
      Boolean(taskScope.requiresReferenceCompanyScope))
    : JSON.parse(JSON.stringify(workbook || {}));
  const sheets = result.sheets || [];
  const groups = new Map();
  for (const indicator of indicators || []) {
    const entries = groups.get(indicator.namedArea) || [];
    entries.push(indicator);
    groups.set(indicator.namedArea, entries);
  }
  for (const [namedArea, items] of groups) {
    const matches = [];
    sheets.forEach((sheet, sheetIndex) => (sheet.mappings || []).forEach(mapping => {
      if (mapping.namedArea === namedArea && mapping.kind === 'table' && mapping.primary === true
        && mapping.permission === 'primary_input') matches.push({ sheet, sheetIndex, mapping });
    }));
    if (matches.length !== 1) throw new Error(`季度指标区域 ${namedArea} 必须唯一映射到填报表格`);
    const { sheet, mapping } = matches[0];
    if (Number(mapping.rowCount) < items.length + 1) throw new Error(`季度指标区域 ${namedArea} 容量不足`);
    sheet.rowCount = Math.max(Number(sheet.rowCount) || 0, Number(mapping.row) + Number(mapping.rowCount));
    sheet.columnCount = Math.max(Number(sheet.columnCount) || 0, Number(mapping.col) + Number(mapping.colCount));
    items.forEach((indicator, index) => {
      const row = Number(mapping.row) + index + 1;
      const tag = quarterlyIndicatorTag(indicator);
      sheet.cells = sheet.cells || [];
      for (let columnOffset = 0; columnOffset < Number(mapping.colCount); columnOffset += 1) {
        const column = Number(mapping.col) + columnOffset;
        const cell = sheet.cells.find(item => Number(item.row) === row && Number(item.column ?? item.col) === column);
        if (cell?.tag != null) throw new Error(`季度指标区域 ${namedArea} 第 ${row + 1} 行与模板权限 Tag 冲突`);
        if (cell) cell.tag = tag;
        else sheet.cells.push({ row, column, tag });
      }
    });
    sheet.cells.sort((left, right) => Number(left.row) - Number(right.row)
      || Number(left.column ?? left.col) - Number(right.column ?? right.col));
  }
  if (sheets.some(sheet => sheet.code === 'quarterly_economics')) throw new Error('模板保留了系统季度经济工作表编码');
  const economics = economicsSheet(dependencies);
  economics.cells = economics.cells.map(cell => {
    if (cell.value !== null) return cell;
    const { value, ...blankCell } = cell;
    return blankCell;
  });
  sheets.push(economics);
  return result;
}

module.exports = { buildQuarterlyWorkbook, scopeQuarterlyWorkbook, scopeQuarterlySpreadJsonWorkbook,
  isQuarterlyReferenceTemplate, quarterlyIndicatorTag, economicsSheet };
