const test = require('node:test');
const assert = require('node:assert/strict');
const { expectedMonthlyPeriods, summarizeQuarterlyDependencies, metricForField } = require('../src/services/quarterlyDependencies');
const { buildQuarterlyWorkbook } = require('../src/services/quarterlyWorkbook');
const { compilePermissionIndex, permissionAt } = require('../src/services/permissionIndex');

test('quarterly dependency source fields recognize the same common revenue and profit labels', () => {
  assert.equal(metricForField({ code: 'SUBMISSION_REVENUE' }), 'revenue');
  assert.equal(metricForField({ displayName: '营业收入' }), 'revenue');
  assert.equal(metricForField({ code: 'BROWSER_PRIOR_REVENUE', displayName: '上年同月营业收入' }), null);
  assert.equal(metricForField({ code: 'BROWSER_PRIOR_PROFIT', displayName: '上年同月利润总额' }), null);
  assert.equal(metricForField({ code: 'REVENUE_TARGET', displayName: '营业收入' }), null);
  assert.equal(metricForField({ code: 'BUDGET_PROFIT', displayName: '利润总额' }), null);
  assert.equal(metricForField({ code: 'REVENUE_YTD', displayName: '营业收入' }), null);
  assert.equal(metricForField({ code: 'PROFIT_QTD', displayName: '利润总额' }), null);
  assert.equal(metricForField({ code: 'REVENUE_EXPLANATION', displayName: '营业收入说明' }), 'revenue');
  assert.equal(metricForField({ code: 'PROFIT_TOTAL' }), 'profit');
  assert.equal(metricForField({ displayName: '利润总额' }), 'profit');
  assert.equal(metricForField({ code: 'EMPLOYEE_COUNT' }), null);
});

test('quarter dependency periods cover January through quarter end and retain quarter scope', () => {
  const periods = expectedMonthlyPeriods('2026-Q2');
  assert.deepEqual(periods.map(item => item.periodCode), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
  assert.deepEqual(periods.filter(item => item.quarter).map(item => item.periodCode), ['2026-04', '2026-05', '2026-06']);
});

test('incomplete months retain exact statuses and prevent scoring totals from becoming complete', () => {
  const report = summarizeQuarterlyDependencies('2026-Q1', [
    { periodCode: '2026-01', status: 'finalized', revisionId: 11, metrics: { revenue: 10, profit: 2 } },
    { periodCode: '2026-02', status: 'superseded', revisionId: 12, metrics: { revenue: 20, profit: 3 } }
  ]);
  assert.equal(report.complete, false);
  assert.deepEqual(report.missingPeriods, [
    { periodCode: '2026-02', status: 'superseded', missingMetrics: [] },
    { periodCode: '2026-03', status: 'task_missing', missingMetrics: ['revenue', 'profit'] }
  ]);
  assert.equal(report.currentQuarter.revenue.value, null);
  assert.equal(report.currentQuarter.revenue.availableSubtotal, 10);
  assert.equal(report.yearToDate.profit.value, null);
});

test('completed months retain separate quarter and year-to-date totals', () => {
  const sourceRows = expectedMonthlyPeriods('2026-Q2').map(({ periodCode }, index) => ({ periodCode,
    status: 'finalized', revisionId: index + 1,
    metrics: { revenue: (index + 1) * 10, profit: index + 1 } }));
  const report = summarizeQuarterlyDependencies('2026-Q2', sourceRows);
  assert.equal(report.complete, true);
  assert.equal(report.currentQuarter.revenue.value, 150);
  assert.equal(report.currentQuarter.profit.value, 15);
  assert.equal(report.yearToDate.revenue.value, 210);
  assert.equal(report.yearToDate.profit.value, 21);
  assert.equal(report.scoringAllowed, true);
  assert.equal(report.finalizationAllowed, true);
});

test('quarterly workbook receives fixed indicator cell Tags and protected quarter/YTD economic areas', () => {
  const workbook = { sheets: [{ code: 'main', name: '主表', rowCount: 5, columnCount: 2, cells: [], mappings: [{
    kind: 'table', namedArea: 'MAIN_BODY_TABLE_QUALITATIVE', row: 0, col: 0, rowCount: 3, colCount: 2,
    primary: true, permission: 'primary_input'
  }] }] };
  const dependencies = summarizeQuarterlyDependencies('2026-Q1', [
    { periodCode: '2026-01', status: 'finalized', revisionId: 1, metrics: { revenue: 10, profit: 1 } },
    { periodCode: '2026-02', status: 'finalized', revisionId: 2, metrics: { revenue: 20, profit: 2 } },
    { periodCode: '2026-03', status: 'finalized', revisionId: 3, metrics: { revenue: 30, profit: 3 } }
  ]);
  const indicators = [{ code: 'BIZ_1', displayName: '重点业务一', category: 'key_business', maximumScore: 20,
    recordKey: 'quarterly:key_business:BIZ_1', tagCode: 'QUARTERLY_KEY_BUSINESS_FILLER', namedArea: 'MAIN_BODY_TABLE_QUALITATIVE' },
  { code: 'WORK_1', displayName: '重点工作一', category: 'key_work', maximumScore: 10,
    recordKey: 'quarterly:key_work:WORK_1', tagCode: 'QUARTERLY_KEY_WORK_FILLER', namedArea: 'MAIN_BODY_TABLE_QUALITATIVE' }];
  const generated = buildQuarterlyWorkbook(workbook, indicators, dependencies);
  assert.equal(workbook.sheets.length, 1, 'task workbooks must not mutate the published template');
  const indicatorTags = generated.sheets[0].cells.map(cell => JSON.parse(cell.tag));
  assert.deepEqual(indicatorTags.map(tag => tag.recordKey), ['quarterly:key_business:BIZ_1', 'quarterly:key_business:BIZ_1',
    'quarterly:key_work:WORK_1', 'quarterly:key_work:WORK_1']);
  const economics = generated.sheets[1];
  assert.equal(economics.readOnly, true);
  assert.equal(economics.cells.find(cell => cell.row === 1 && cell.column === 1).value, 60);
  assert.equal(economics.cells.find(cell => cell.row === 1 && cell.column === 2).value, 60);
  assert.equal(economics.cells.find(cell => cell.row === 2 && cell.column === 1).value, 6);
  assert.equal(economics.cells.find(cell => cell.row === 2 && cell.column === 2).value, 6);
  const index = compilePermissionIndex(generated);
  assert.equal(JSON.parse(generated.sheets[0].cells.find(cell => cell.row === 1 && cell.column === 0).tag).displayName, '重点业务一');
  assert.equal(index.sheets[1].readOnly, true);
  assert.equal(permissionAt(index.sheets[1], 1, 1, { roles: ['subsidiary_filler'], departments: [] }).editable, false);
});
