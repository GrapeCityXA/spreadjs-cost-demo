const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMonthlyReferenceReport } = require('../src/services/monthlyReferenceReport');
const syntheticHistory = require('../src/fixtures/synthetic-monthly-operating-history.json');

const organization = (id, overrides = {}) => ({ id, code: `ORG-${id}`, name: `组织 ${id}`,
  annualTargets: { revenue: 120, profit: -24 }, cumulativeTargets: { revenue: { '2026-03': 25 }, profit: { '2026-03': -8 } },
  completionRules: { profit: { kind: 'control_loss', versionId: 15 } },
  weights: { revenue: 0.6, profit: 0.4 }, ...overrides });

const monthlyValues = (organizationId, rows) => rows.flatMap(([periodCode, revenue, priorRevenue, profit, priorProfit]) => [
  { organizationId, periodCode, metric: 'revenue', kind: 'current', value: revenue },
  { organizationId, periodCode, metric: 'revenue', kind: 'prior', value: priorRevenue },
  { organizationId, periodCode, metric: 'profit', kind: 'current', value: profit },
  { organizationId, periodCode, metric: 'profit', kind: 'prior', value: priorProfit }
]);

test('derives cumulative values, loss-target completion, and explicit target precedence from monthly values', () => {
  const report = buildMonthlyReferenceReport({ periodCode: '2026-03', organizations: [organization(1)], monthlyValues: monthlyValues(1, [
    ['2026-01', 10, 5, -3, -2], ['2026-02', 20, 10, -4, -3], ['2026-03', 30, 20, -5, -4]
  ]) });
  const row = report.rows[0];
  assert.equal(report.consolidationAvailable, false);
  assert.equal(report.totals.revenue.currentYearToDate.value, null);
  assert.equal(row.metrics.revenue.currentYearToDate.value, 60);
  assert.equal(row.metrics.revenue.priorYearToDate.value, 35);
  assert.equal(row.metrics.revenue.cumulativeTarget, 25);
  assert.equal(row.metrics.revenue.cumulativeTargetSource, 'configured_cumulative_target');
  assert.equal(row.metrics.revenue.cumulativeCompletionRate, 2.4);
  assert.equal(row.metrics.profit.currentYearToDate.value, -12);
  assert.equal(row.metrics.profit.cumulativeCompletionRate, 0.5);
  assert.equal(row.metrics.profit.yearOverYearChange, -1 / 3);
  assert.equal(row.metrics.revenue.yearOverYearChange, 25 / 35);
});

test('keeps incomplete months null instead of presenting a partial sum as the cumulative result', () => {
  const report = buildMonthlyReferenceReport({ periodCode: '2026-03', organizations: [organization(1)], monthlyValues: monthlyValues(1, [
    ['2026-01', 10, 5, -3, -2], ['2026-03', 30, 20, -5, -4]
  ]) });
  const revenue = report.rows[0].metrics.revenue;
  assert.equal(revenue.currentYearToDate.value, null);
  assert.equal(revenue.currentYearToDate.availableSubtotal, 40);
  assert.equal(revenue.currentYearToDate.monthsAvailable, 2);
  assert.equal(revenue.currentYearToDate.complete, false);
  assert.equal(report.totals.revenue.currentYearToDate.value, null);
  assert.equal(report.rows[0].complete, false);
});

test('does not infer cumulative targets from annual targets or apply control-loss math without its versioned rule', () => {
  const report = buildMonthlyReferenceReport({ periodCode: '2026-03', organizations: [organization(1, {
    cumulativeTargets: { profit: { '2026-03': -8 } }, completionRules: {}
  })], monthlyValues: monthlyValues(1, [
    ['2026-01', 10, 5, -3, -2], ['2026-02', 20, 10, -4, -3], ['2026-03', 30, 20, -5, -4]
  ]) });
  const { revenue, profit } = report.rows[0].metrics;
  assert.equal(revenue.cumulativeTarget, null);
  assert.equal(revenue.cumulativeTargetSource, 'not_configured');
  assert.equal(revenue.cumulativeCompletionRate, null);
  assert.equal(profit.cumulativeTarget, -8);
  assert.equal(profit.cumulativeCompletionRate, null);
});

test('calculates unrounded totals and competition ranks only from versioned score rules', () => {
  const scoringRules = {
    revenue: { versionId: 101, expression: { op: 'multiply', args: [{ field: 'completionRate' }, { field: 'weight' }] } },
    profit: { versionId: 102, expression: { op: 'multiply', args: [{ field: 'completionRate' }, { field: 'weight' }] } }
  };
  const report = buildMonthlyReferenceReport({ periodCode: '2026-03', organizations: [organization(1), organization(2)],
    monthlyValues: [...monthlyValues(1, [['2026-01', 10, 5, -3, -2], ['2026-02', 20, 10, -4, -3], ['2026-03', 30, 20, -5, -4]]),
      ...monthlyValues(2, [['2026-01', 10, 5, -3, -2], ['2026-02', 20, 10, -4, -3], ['2026-03', 30, 20, -5, -4]])], scoreRules: scoringRules });
  assert.equal(report.rows[0].metrics.revenue.score, 1.44);
  assert.equal(report.rows[0].metrics.profit.score, 0.2);
  assert.equal(report.rows[0].totalScore, 1.64);
  assert.deepEqual(report.rows.map(row => row.rank), [1, 1]);
  assert.equal(report.scoringAvailable, true);
  assert.equal(report.rankingAvailable, true);
});

test('does not invent scores or rankings when no published score rules are pinned', () => {
  const report = buildMonthlyReferenceReport({ periodCode: '2026-03', organizations: [organization(1)], monthlyValues: monthlyValues(1, [
    ['2026-01', 10, 5, -3, -2], ['2026-02', 20, 10, -4, -3], ['2026-03', 30, 20, -5, -4]
  ]) });
  assert.equal(report.rows[0].totalScore, null);
  assert.equal(report.rows[0].rank, null);
  assert.equal(report.scoringAvailable, false);
  assert.equal(report.rankingAvailable, false);
});

test('the fixed DEMO history derives July and year-to-date values without importing source offsets', () => {
  const rows = syntheticHistory.records.filter(item => item.organizationCode === 'SAMPLE_ORG_01'
    && Number(item.period.slice(5)) <= 7);
  const target = fieldCode => syntheticHistory.targets.find(item => item.organizationCode === 'SAMPLE_ORG_01'
    && item.fieldCode === fieldCode);
  const values = rows.map(item => ({ organizationId: 1, periodCode: `2026-${item.period.slice(5)}`,
    metric: item.fieldCode, kind: item.period.startsWith('2025') ? 'prior' : 'current', value: item.value }));
  const report = buildMonthlyReferenceReport({ periodCode: '2026-07', organizations: [organization(1, {
    annualTargets: { revenue: target('revenue').annualTarget, profit: target('profit').annualTarget },
    cumulativeTargets: { revenue: { '2026-07': target('revenue').throughJulyTarget },
      profit: { '2026-07': target('profit').throughJulyTarget } }
  })], monthlyValues: values });
  const revenue = report.rows[0].metrics.revenue;
  const profit = report.rows[0].metrics.profit;
  assert.equal(values.length, 28, 'seven current and seven prior months have both revenue and profit');
  assert.ok(Math.abs(revenue.currentMonth - 58596.00425) < 1e-6);
  assert.ok(Math.abs(revenue.currentYearToDate.value - 367874.435635) < 1e-6);
  assert.ok(Math.abs(revenue.priorYearToDate.value - 215698.445878) < 1e-6);
  assert.ok(Math.abs(revenue.cumulativeCompletionRate - 367874.435635 / 413595) < 1e-9);
  assert.ok(Math.abs(profit.currentYearToDate.value - 639.487004) < 1e-6);
  assert.equal(report.rows[0].rank, null);
});
