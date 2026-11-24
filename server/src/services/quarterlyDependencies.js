const db = require('../config/database');

const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const fail = (message, status) => Object.assign(new Error(message), { status });
const metricForField = field => {
  const code = String(field?.code || '').toLowerCase();
  const displayName = String(field?.displayName || '').toLowerCase();
  const text = `${code} ${displayName}`.replace(/[_-]+/g, ' ');
  if (/同比|上年|去年|目标|预算|计划|差额|增长率|完成率|变化率|对比|累计|季度|\b(prior|previous|last\s+year|yoy|target|budget|plans?|planned|year\s+to\s+date|cumulative|quarterly|ytd|qtd)\b/.test(text)) return null;
  if (/profit|利润/.test(text)) return 'profit';
  if (/revenue|营业收入|营收/.test(text)) return 'revenue';
  return null;
};

function parseQuarter(periodCode) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(periodCode || ''));
  if (!match) throw fail('季度报告期间必须采用 YYYY-Qn 格式', 400);
  return { year: Number(match[1]), quarter: Number(match[2]) };
}

function quarterlyConfiguration(configuration) {
  return configuration?.configuration && typeof configuration.configuration === 'object'
    ? configuration.configuration : configuration || {};
}

function expectedMonthlyPeriods(periodCode) {
  const { year, quarter } = parseQuarter(periodCode);
  const quarterEnd = quarter * 3;
  return Array.from({ length: quarterEnd }, (_, index) => {
    const month = index + 1;
    return { periodCode: `${year}-${String(month).padStart(2, '0')}`, quarter: month > quarterEnd - 3 };
  });
}

function numeric(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumPeriods(periods, rows) {
  const byPeriod = new Map(rows.map(row => [row.periodCode, row]));
  const selected = periods.map(periodCode => byPeriod.get(periodCode));
  const values = selected.map(row => row?.status === 'finalized' ? row.metrics || {} : {});
  const metrics = {};
  for (const metric of ['revenue', 'profit']) {
    const parts = values.map(item => numeric(item[metric]));
    const available = parts.filter(value => value != null);
    const units = [...new Set(values.map(item => item[`${metric}Unit`]).filter(Boolean))];
    metrics[metric] = { value: parts.length === selected.length && available.length === selected.length
      ? available.reduce((sum, value) => sum + value, 0) : null,
    availableSubtotal: available.reduce((sum, value) => sum + value, 0),
    complete: available.length === selected.length, monthsAvailable: available.length, monthsExpected: selected.length,
    unit: units.length === 1 ? units[0] : null, unitsCompatible: units.length <= 1 };
  }
  return metrics;
}

function summarizeQuarterlyDependencies(periodCode, sourceRows) {
  const periods = expectedMonthlyPeriods(periodCode);
  const rowsByPeriod = new Map((sourceRows || []).map(row => [row.periodCode, row]));
  const months = periods.map(({ periodCode: sourcePeriodCode, quarter }) => {
    const source = rowsByPeriod.get(sourcePeriodCode);
    const status = source?.status || 'task_missing';
    const metrics = source?.metrics || { revenue: null, profit: null };
    const missingMetrics = ['revenue', 'profit'].filter(metric => numeric(metrics[metric]) == null);
    return { periodCode: sourcePeriodCode, scope: quarter ? 'quarter' : 'year_to_date',
      status, ready: status === 'finalized', taskId: source?.taskId ?? null,
      revisionId: status === 'finalized' ? source.revisionId : null,
      supersededRevisionId: status === 'superseded' ? source.revisionId ?? null : null,
      missingMetrics, metrics };
  });
  const quarterMonths = months.filter(item => item.scope === 'quarter');
  const currentQuarter = sumPeriods(quarterMonths.map(item => item.periodCode), months);
  const yearToDate = sumPeriods(months.map(item => item.periodCode), months);
  const missingPeriods = months.filter(item => !item.ready || item.missingMetrics.length)
    .map(({ periodCode: sourcePeriodCode, status, missingMetrics }) => ({ periodCode: sourcePeriodCode, status, missingMetrics }));
  const complete = missingPeriods.length === 0 && currentQuarter.revenue.complete && currentQuarter.profit.complete
    && yearToDate.revenue.complete && yearToDate.profit.complete;
  return { periodCode, source: 'current_effective_finalized_monthly_revisions', complete,
    scoringAllowed: complete, finalizationAllowed: complete,
    missingPeriods, months, currentQuarter, yearToDate,
    sourceRevisionIds: months.filter(item => item.ready).map(item => ({ periodCode: item.periodCode, revisionId: item.revisionId })) };
}

async function loadQuarterlyDependencies({ taskId, organizationId, periodCode, configuration }) {
  parseQuarter(periodCode);
  const sourceReportTypeId = Number(quarterlyConfiguration(configuration).monthlySourceReportTypeId);
  if (!Number.isSafeInteger(sourceReportTypeId) || sourceReportTypeId < 1) {
    return summarizeQuarterlyDependencies(periodCode, []);
  }
  const reportType = await new Promise((resolve, reject) => db.get(
    'SELECT id, cadence FROM report_types WHERE id = ?', [sourceReportTypeId],
    (error, row) => error ? reject(error) : resolve(row)));
  if (!reportType || reportType.cadence !== 'monthly') throw fail('季度配置引用的月报类型不存在或不是月度类型', 409);
  const periods = expectedMonthlyPeriods(periodCode).map(item => item.periodCode);
  const periodStart = periods[0];
  const periodEnd = periods[periods.length - 1];
  const tasks = await all(db, `SELECT t.id AS taskId, t.period_code AS periodCode, t.current_revision_id AS currentRevisionId,
      p.version AS packageVersion, r.id AS effectiveRevisionId, r.revision_status AS effectiveStatus,
      historic.id AS latestFinalizedRevisionId
    FROM report_tasks t JOIN period_packages p ON p.id = t.package_id
    LEFT JOIN business_revisions r ON r.task_id = t.id AND r.is_current_effective = 1 AND r.revision_status = 'finalized'
    LEFT JOIN business_revisions historic ON historic.task_id = t.id AND historic.revision_status = 'finalized'
      AND historic.revision_number = (SELECT MAX(previous.revision_number) FROM business_revisions previous
        WHERE previous.task_id = t.id AND previous.revision_status = 'finalized')
    WHERE t.report_type_id = ? AND t.organization_id = ? AND t.period_code BETWEEN ? AND ?
    ORDER BY t.period_code, p.version DESC, t.id DESC`, [sourceReportTypeId, organizationId, periodStart, periodEnd]);
  const tasksByPeriod = new Map();
  for (const row of tasks) {
    const values = tasksByPeriod.get(row.periodCode) || [];
    values.push(row);
    tasksByPeriod.set(row.periodCode, values);
  }
  const taskIds = [...tasksByPeriod.values()].flat().map(row => Number(row.taskId));
  const valuesByTask = new Map();
  if (taskIds.length) {
    const placeholders = taskIds.map(() => '?').join(',');
    const values = await all(db, `SELECT t.id AS taskId, t.period_code AS periodCode, r.id AS revisionId,
        fd.code AS fieldCode, fd.display_name AS displayName, COALESCE(v.unit_snapshot,fd.unit) AS unit,
        v.decimal_value AS decimalValue, v.integer_value AS integerValue, v.text_value AS textValue
      FROM report_tasks t JOIN business_revisions r ON r.task_id = t.id AND r.is_current_effective = 1 AND r.revision_status = 'finalized'
      JOIN business_values v ON v.revision_id = r.id JOIN field_definitions fd ON fd.id = v.field_definition_id
      WHERE t.id IN (${placeholders}) ORDER BY t.period_code, fd.code, v.record_key`, taskIds);
    for (const row of values) {
      const metric = metricForField(row);
      if (!metric) continue;
      const value = numeric(row.decimalValue ?? row.integerValue ?? row.textValue);
      if (value == null) continue;
      const bucket = valuesByTask.get(Number(row.taskId)) || { revenue: [], profit: [], revenueUnits: [], profitUnits: [], revisionId: Number(row.revisionId) };
      bucket[metric].push(value);
      if (row.unit) bucket[`${metric}Units`].push(row.unit);
      valuesByTask.set(Number(row.taskId), bucket);
    }
  }
  const sourceRows = periods.map(sourcePeriodCode => {
    const candidates = tasksByPeriod.get(sourcePeriodCode) || [];
    if (!candidates.length) return { periodCode: sourcePeriodCode, status: 'task_missing' };
    if (candidates.length > 1) return { periodCode: sourcePeriodCode, status: 'ambiguous_tasks', taskIds: candidates.map(row => Number(row.taskId)) };
    const source = candidates[0];
    const bucket = valuesByTask.get(Number(source.taskId));
    if (source.effectiveRevisionId) return { periodCode: sourcePeriodCode, taskId: Number(source.taskId),
      revisionId: Number(source.effectiveRevisionId), status: 'finalized', metrics: {
        revenue: bucket?.revenue.length ? bucket.revenue.reduce((sum, value) => sum + value, 0) : null,
        profit: bucket?.profit.length ? bucket.profit.reduce((sum, value) => sum + value, 0) : null,
        revenueUnit: bucket?.revenueUnits.length === 1 ? bucket.revenueUnits[0] : null,
        profitUnit: bucket?.profitUnits.length === 1 ? bucket.profitUnits[0] : null } };
    if (source.latestFinalizedRevisionId) return { periodCode: sourcePeriodCode, taskId: Number(source.taskId),
      revisionId: Number(source.latestFinalizedRevisionId), status: 'superseded' };
    return { periodCode: sourcePeriodCode, taskId: Number(source.taskId), status: 'revision_pending' };
  });
  return summarizeQuarterlyDependencies(periodCode, sourceRows);
}

module.exports = { parseQuarter, expectedMonthlyPeriods, quarterlyConfiguration, summarizeQuarterlyDependencies, loadQuarterlyDependencies, metricForField };
