const db = require('../config/database');
const { loadQuarterlyDependencies } = require('./quarterlyDependencies');
const { weightedScore } = require('./quarterlyScoreMath');

const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const fail = (message, status) => Object.assign(new Error(message), { status });
const parse = (value, fallback = {}) => { try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; } };

function hasGlobalRole(actor, code) {
  return (actor.roles || []).some(role => role.code === code && role.organizationId == null);
}

function assertReader(actor) {
  if (!hasGlobalRole(actor, 'system_admin') && !hasGlobalRole(actor, 'management')
    && !hasGlobalRole(actor, 'report_finalizer')) {
    throw fail('需要全局管理人员权限查看经营仪表盘', 403);
  }
}

function normalizeQuarter(value) {
  const quarter = String(value || '');
  if (!/^\d{4}-Q[1-4]$/.test(quarter)) throw fail('季度必须采用 YYYY-Qn 格式', 400);
  return quarter;
}

function previousQuarter(value) {
  const [, yearText, quarterText] = /^(\d{4})-Q([1-4])$/.exec(value);
  const year = Number(yearText);
  const quarter = Number(quarterText);
  return quarter === 1 ? `${year - 1}-Q4` : `${year}-Q${quarter - 1}`;
}

function metricForField(field) {
  const code = String(field.code || '').trim().toLowerCase();
  if (['revenue', 'submission_revenue'].includes(code)) return 'revenue';
  if (['profit', 'submission_profit'].includes(code)) return 'profit';
  return null;
}

function storedValue(row) {
  const value = row.decimalValue ?? row.integerValue ?? row.textValue;
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function visibleQuarterTasks(periodCode) {
  return all(db, `SELECT t.id AS taskId, t.package_id AS packageId, t.report_type_id AS reportTypeId,
      t.organization_id AS organizationId, t.period_code AS periodCode, t.task_status AS taskStatus,
      t.configuration_snapshot_json AS configurationJson, rt.display_name AS reportTypeName,
      o.code AS organizationCode, o.name AS organizationName, r.id AS revisionId,
      r.revision_number AS revisionNumber, r.finalized_at AS finalizedAt
    FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id AND rt.cadence='quarterly'
    JOIN organizations o ON o.id=t.organization_id
    JOIN business_revisions r ON r.task_id=t.id
      AND r.revision_status='finalized' AND r.is_current_effective=1
    WHERE t.period_code=? ORDER BY rt.display_name, o.code`, [periodCode]);
}

async function availablePeriods() {
  return all(db, `SELECT DISTINCT t.period_code AS periodCode
    FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id AND rt.cadence='quarterly'
    JOIN business_revisions r ON r.task_id=t.id
      AND r.revision_status='finalized' AND r.is_current_effective=1
    ORDER BY t.period_code DESC`);
}

async function categoryBreakdown(task) {
  const indicators = await all(db, `SELECT id, indicator_code AS code, display_name AS displayName,
      indicator_type AS type, weight, configuration_json AS configurationJson
    FROM task_indicators WHERE task_id=? ORDER BY sort_order,id`, [task.taskId]);
  const scores = await all(db, `SELECT indicator_id AS indicatorId, score_decimal AS score,
      score_source AS scoreSource, formula_version_id AS formulaVersionId
    FROM quarterly_indicator_scores WHERE revision_id=?`, [task.revisionId]);
  const adjustments = await all(db, `SELECT adjustment_type AS adjustmentType, amount_decimal AS amount, status
    FROM quarterly_adjustment_requests WHERE revision_id=?`, [task.revisionId]);
  const normalizedIndicators = indicators.map(item => ({ ...item,
    configuration: parse(item.configurationJson) }));
  const total = weightedScore(normalizedIndicators, scores, adjustments);
  const categories = new Map();
  for (const item of total.details) {
    const category = item.configuration.category || item.type || 'other';
    const current = categories.get(category) || { category, score: 0, maximumScore: 0, indicators: [] };
    const contribution = Number(item.weightedScore || 0);
    current.score += contribution;
    current.maximumScore += Number(item.weight || 0);
    current.indicators.push({ code: item.code, displayName: item.displayName, score: item.score,
      weightedScore: item.weightedScore, weight: item.weight, scoreSource: item.scoreSource });
    categories.set(category, current);
  }
  return { totalScore: total.totalScore, categories: [...categories.values()] };
}

async function quarterEconomics(task) {
  const configuration = parse(task.configurationJson);
  const dependencies = await loadQuarterlyDependencies({ taskId: task.taskId,
    organizationId: task.organizationId, periodCode: task.periodCode, configuration });
  const targetRows = await all(db, `SELECT fd.code, fd.unit, pt.amount_decimal AS amount
    FROM package_targets pt JOIN field_definitions fd ON fd.id=pt.field_definition_id
    WHERE pt.package_id=? AND pt.organization_id=? AND pt.target_phase='quarterly' AND pt.phase_period=?`,
  [task.packageId, task.organizationId, task.periodCode]);
  const targets = { revenue: null, profit: null };
  const units = { revenue: null, profit: null };
  for (const row of targetRows) {
    const metric = metricForField(row);
    if (!metric) continue;
    if (targets[metric] != null) throw fail(`季度目标${metric}存在多个字段映射，无法确定图表口径`, 409);
    targets[metric] = Number(row.amount);
    units[metric] = row.unit || '';
  }
  const metricResult = metric => {
    const actual = dependencies.currentQuarter?.[metric]?.value ?? null;
    const actualUnit = dependencies.currentQuarter?.[metric]?.unit || '';
    const targetUnit = units[metric] || '';
    const unitCompatible = dependencies.currentQuarter?.[metric]?.unitsCompatible !== false
      && (!actualUnit || !targetUnit || actualUnit === targetUnit);
    return { actual, target: targets[metric], actualUnit, targetUnit, unitCompatible,
      unit: targetUnit || actualUnit || '' };
  };
  return {
    revenue: metricResult('revenue'),
    profit: metricResult('profit'),
    dependenciesComplete: Boolean(dependencies.complete)
  };
}

async function loadRanking(periodCode, reportTypeIds = null) {
  const conditions = ["rt.cadence='quarterly'", 't.period_code=?',
    "r.revision_status='finalized'", 'r.is_current_effective=1', "rankings.ranking_type='quarterly'"];
  const params = [periodCode];
  if (reportTypeIds?.length) {
    conditions.push(`t.report_type_id IN (${reportTypeIds.map(() => '?').join(',')})`);
    params.push(...reportTypeIds);
  }
  return all(db, `SELECT t.id AS taskId, rankings.revision_id AS revisionId,
      rankings.organization_id AS organizationId, rankings.rank,
      rankings.score_decimal AS totalScore, t.report_type_id AS reportTypeId,
      o.code AS organizationCode, o.name AS organizationName
    FROM report_rankings rankings JOIN report_tasks t ON t.package_id=rankings.package_id
      AND t.organization_id=rankings.organization_id
    JOIN report_types rt ON rt.id=t.report_type_id JOIN business_revisions r ON r.task_id=t.id
      AND r.id=rankings.revision_id
    JOIN organizations o ON o.id=t.organization_id
    WHERE ${conditions.join(' AND ')} ORDER BY rankings.rank,o.code`, params);
}

async function loadAnomalies(tasks, category) {
  if (!tasks.length) return [];
  const revisions = tasks.map(task => Number(task.revisionId));
  const rows = await all(db, `SELECT a.id, r.task_id AS taskId, r.id AS revisionId,
      o.id AS organizationId, o.name AS organizationName, o.code AS organizationCode,
      a.rule_code AS ruleCode, a.field_code AS fieldCode, a.message, a.severity,
      a.disposition, a.created_at AS createdAt
    FROM anomaly_snapshots a JOIN business_revisions r ON r.id=a.revision_id
    JOIN report_tasks t ON t.id=r.task_id JOIN organizations o ON o.id=t.organization_id
    WHERE r.id IN (${revisions.map(() => '?').join(',')}) ORDER BY a.created_at DESC,a.id DESC`, revisions);
  if (category === 'all') return rows;
  if (category === 'economic') return rows.filter(row => /revenue|profit|收入|利润/i.test(`${row.fieldCode} ${row.message}`));
  return rows.filter(row => row.fieldCode || row.ruleCode);
}

async function loadProgress(periodCode) {
  const tasks = await all(db, `SELECT t.id AS taskId, t.task_status AS status, t.period_code AS periodCode,
      o.id AS organizationId, o.name AS organizationName, o.code AS organizationCode,
      rt.display_name AS reportTypeName
    FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id AND rt.cadence='quarterly'
    JOIN organizations o ON o.id=t.organization_id WHERE t.period_code=? ORDER BY o.code`, [periodCode]);
  const counts = { total: tasks.length, finalized: 0, submitted: 0, reviewing: 0, draft: 0, cancelled: 0 };
  for (const task of tasks) {
    if (Object.hasOwn(counts, task.status)) counts[task.status] += 1;
  }
  return { counts, tasks: tasks.map(task => ({ ...task, href: `/portal/quarterly-review/${task.taskId}` })) };
}

async function getDashboard(actor, filters = {}) {
  assertReader(actor);
  const periods = await availablePeriods();
  const selectedPeriod = filters.periodCode ? normalizeQuarter(filters.periodCode) : periods[0]?.periodCode;
  if (!selectedPeriod) return { source: 'current_effective_finalized_quarterly_revisions', periods: [], selectedPeriod: null,
    organizations: [], ranking: [], economics: [], scoreComposition: [], anomalies: [], progress: { counts: {}, tasks: [] }, updatedAt: null };
  const periodExists = periods.some(item => item.periodCode === selectedPeriod);
  if (!periodExists) throw fail('该季度没有当前有效的已定稿数据', 404);
  const allTasks = await visibleQuarterTasks(selectedPeriod);
  const organizations = [...new Map(allTasks.map(task => [Number(task.organizationId), {
    id: Number(task.organizationId), code: task.organizationCode, name: task.organizationName
  }])).values()];
  const organizationId = filters.organizationId == null || filters.organizationId === '' ? null : Number(filters.organizationId);
  if (organizationId != null && (!Number.isSafeInteger(organizationId) || !organizations.some(item => item.id === organizationId))) {
    throw fail('所选公司在该季度没有当前有效的已定稿数据', 404);
  }
  const category = filters.category || 'all';
  if (!['all', 'economic', 'key_business', 'key_work'].includes(category)) throw fail('指标类别无效', 400);
  const tasks = allTasks.filter(task => organizationId == null || Number(task.organizationId) === organizationId);
  const reportTypeIds = [...new Set(tasks.map(task => Number(task.reportTypeId)))];
  const [ranking, priorRanking, economies, compositions, anomalies, progress] = await Promise.all([
    loadRanking(selectedPeriod, reportTypeIds),
    loadRanking(previousQuarter(selectedPeriod), reportTypeIds),
    Promise.all(tasks.map(async task => ({ taskId: Number(task.taskId), revisionId: Number(task.revisionId),
      organizationId: Number(task.organizationId), organizationName: task.organizationName,
      organizationCode: task.organizationCode, reportTypeName: task.reportTypeName,
      metrics: await quarterEconomics(task) }))),
    Promise.all(tasks.map(async task => ({ taskId: Number(task.taskId), revisionId: Number(task.revisionId),
      organizationId: Number(task.organizationId), organizationName: task.organizationName,
      organizationCode: task.organizationCode, reportTypeName: task.reportTypeName,
      ...(await categoryBreakdown(task)) }))),
    loadAnomalies(tasks, category),
    loadProgress(selectedPeriod)
  ]);
  const rankingByKey = new Map(ranking.map(item => [`${item.reportTypeId}:${item.organizationId}`, item]));
  const priorByKey = new Map(priorRanking.map(item => [`${item.reportTypeId}:${item.organizationId}`, item]));
  const rankRows = ranking.filter(item => organizationId == null || Number(item.organizationId) === organizationId)
    .map(item => {
      const previous = priorByKey.get(`${item.reportTypeId}:${item.organizationId}`);
      return { ...item, totalScore: item.totalScore == null ? null : Number(item.totalScore),
        previousRank: previous?.rank ?? null, rankMovement: previous ? Number(previous.rank) - Number(item.rank) : null };
    });
  const selectedTaskIds = new Set(tasks.map(task => Number(task.taskId)));
  const scoreComposition = compositions.filter(item => category === 'all' || item.categories.some(entry => entry.category === category))
    .map(item => ({ ...item, totalScore: Number(item.totalScore),
      categories: category === 'all' ? item.categories : item.categories.filter(entry => entry.category === category) }));
  const selectedAnomalies = anomalies.filter(item => selectedTaskIds.has(Number(item.taskId)));
  const selectedProgress = organizationId == null ? progress : { ...progress,
    tasks: progress.tasks.filter(item => Number(item.organizationId) === organizationId),
    counts: progress.tasks.filter(item => Number(item.organizationId) === organizationId).reduce((counts, item) => {
      counts.total += 1; if (Object.hasOwn(counts, item.status)) counts[item.status] += 1; return counts;
    }, { total: 0, finalized: 0, submitted: 0, reviewing: 0, draft: 0, cancelled: 0 }) };
  return {
    source: 'current_effective_finalized_quarterly_revisions', periods: periods.map(item => item.periodCode),
    selectedPeriod, organizations, selectedOrganizationId: organizationId, selectedCategory: category,
    ranking: rankRows, economics: economies, scoreComposition,
    anomalies: selectedAnomalies, progress: selectedProgress,
    updatedAt: tasks.map(task => task.finalizedAt).filter(Boolean).sort().at(-1) || null,
    selection: { taskIds: tasks.map(task => Number(task.taskId)), revisionIds: tasks.map(task => Number(task.revisionId)),
      sourceTaskCount: rankingByKey.size }
  };
}

module.exports = { getDashboard, normalizeQuarter, previousQuarter, assertReader };
