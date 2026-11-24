const { evaluateExpression } = require('./ruleEvaluator');
const db = require('../config/database');

const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const fail = (message, status) => Object.assign(new Error(message), { status });

function parsePeriod(periodCode) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(periodCode || ''));
  if (!match) throw Object.assign(new Error('报告期间必须采用 YYYY-MM 格式'), { status: 400 });
  return { year: Number(match[1]), month: Number(match[2]) };
}

function numeric(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumPresent(values, expectedCount) {
  const available = values.filter(value => value != null);
  return {
    value: available.length === expectedCount ? available.reduce((sum, value) => sum + value, 0) : null,
    availableSubtotal: available.reduce((sum, value) => sum + value, 0),
    complete: available.length === expectedCount,
    monthsAvailable: available.length,
    monthsExpected: expectedCount
  };
}

function targetCompletion(actual, target, rule = null) {
  if (actual == null || target == null || target === 0) return null;
  if (target < 0) {
    if (rule?.kind !== 'control_loss' || !rule.versionId) return null;
    return 2 - actual / target;
  }
  return actual / target;
}

function yoyChange(current, prior) {
  if (current == null || prior == null || prior === 0) return null;
  return (current - prior) / Math.abs(prior);
}

function normalizeMonthlyValues(monthlyValues) {
  const index = new Map();
  for (const item of monthlyValues || []) {
    const { year, month } = parsePeriod(item.periodCode);
    const organizationId = Number(item.organizationId);
    const metric = item.metric;
    const kind = item.kind || 'current';
    if (!Number.isSafeInteger(organizationId) || organizationId < 1 || !['revenue', 'profit'].includes(metric)
      || !['current', 'prior'].includes(kind)) continue;
    const amount = numeric(item.value);
    const key = `${organizationId}:${year}-${String(month).padStart(2, '0')}:${metric}:${kind}`;
    const existing = index.get(key) || [];
    existing.push(amount);
    index.set(key, existing);
  }
  return index;
}

function indexedAmount(index, organizationId, periodCode, metric, kind) {
  const values = index.get(`${organizationId}:${periodCode}:${metric}:${kind}`) || [];
  if (!values.length || values.some(value => value == null)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function scoreForMetric(rule, input) {
  if (!rule?.expression) return null;
  return evaluateExpression(rule.expression, input, rule.parameters || {});
}

function metricForField(field) {
  const code = String(field.code || '').trim().toLowerCase();
  // Explicit current-period field codes used by the collaboration demo templates.
  // Prior-period input fields must not be counted as current-period revenue/profit.
  return ({ revenue: 'revenue', submission_revenue: 'revenue', browser_current_revenue: 'revenue',
    profit: 'profit', submission_profit: 'profit', browser_current_profit: 'profit' })[code] || null;
}

function readStoredValue(row) {
  for (const key of ['decimalValue', 'integerValue', 'textValue']) {
    if (row[key] != null && row[key] !== '') return numeric(row[key]);
  }
  return null;
}

function assertUnambiguous(values, description) {
  const byKey = new Map();
  for (const item of values) {
    const key = `${item.organizationId}:${item.periodCode}:${item.metric}:${item.kind}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }
  const ambiguous = [...byKey.values()].find(items => items.length > 1);
  if (ambiguous) throw fail(`${description}存在多个字段映射到同一指标，请先明确批准字段映射。`, 409);
}

async function listMonthlyReferenceVersions({ periodCode, reportTypeId }) {
  parsePeriod(periodCode);
  const typeId = Number(reportTypeId);
  if (!Number.isSafeInteger(typeId) || typeId < 1) throw fail('必须指定月度报表类型', 400);
  return all(`SELECT p.id, p.version, p.status, p.template_version_id AS templateVersionId,
      COUNT(t.id) AS participatingOrganizations
    FROM period_packages p JOIN report_types rt ON rt.id = p.report_type_id
    JOIN report_tasks t ON t.package_id = p.id AND t.report_type_id = p.report_type_id AND t.period_code = p.period_code
    WHERE p.report_type_id = ? AND p.period_code = ? AND rt.cadence = 'monthly'
      AND p.status IN ('active', 'closed')
    GROUP BY p.id ORDER BY p.version DESC`, [typeId, periodCode]);
}

async function loadMonthlyReferenceReport({ periodCode, reportTypeId, configurationPackageId }) {
  const { year } = parsePeriod(periodCode);
  const normalizedReportTypeId = Number(reportTypeId);
  if (!Number.isSafeInteger(normalizedReportTypeId) || normalizedReportTypeId < 1) {
    throw fail('必须指定月度报表类型', 400);
  }
  const reportType = (await all(`SELECT id, cadence, display_name AS displayName FROM report_types WHERE id = ?`, [normalizedReportTypeId]))[0];
  if (!reportType) throw fail('报表类型不存在', 404);
  if (reportType.cadence !== 'monthly') throw fail('月度参考报表仅支持月度报表类型', 409);

  const versions = await listMonthlyReferenceVersions({ periodCode, reportTypeId });
  let selectedId;
  if (configurationPackageId != null) {
    selectedId = Number(configurationPackageId);
    if (!Number.isSafeInteger(selectedId) || selectedId < 1) throw fail('配置版本无效，请重新选择', 400);
    if (!versions.some(item => Number(item.id) === selectedId)) throw fail('所选配置版本不属于此报表类型和月份，或尚未生成任务', 409);
  } else {
    if (!versions.length) throw fail('此报告期间没有配置参与组织', 404);
    if (versions.length !== 1) throw fail('此报表类型与月份有多个配置版本，请选择配置版本后查询', 409);
    selectedId = Number(versions[0].id);
  }
  const tasks = await all(`SELECT t.id, t.organization_id AS organizationId, t.package_id AS packageId,
      t.period_code AS periodCode, r.id AS revisionId, o.code, o.name,
      p.version AS packageVersion, p.template_version_id AS templateVersionId
    FROM report_tasks t JOIN period_packages p ON p.id = t.package_id
    JOIN organizations o ON o.id = t.organization_id
    LEFT JOIN business_revisions r ON r.id = t.current_revision_id AND r.revision_status = 'finalized' AND r.is_current_effective = 1
    WHERE t.report_type_id = ? AND t.period_code = ? AND t.package_id = ?
    ORDER BY o.code`, [normalizedReportTypeId, periodCode, selectedId]);
  if (!tasks.length) throw fail('此报告期间没有配置参与组织', 404);
  const organizations = tasks.map(task => ({ id: Number(task.organizationId), taskId: Number(task.id), code: task.code, name: task.name,
    reportRevisionId: task.revisionId == null ? null : Number(task.revisionId),
    annualTargets: {}, cumulativeTargets: {}, weights: {} }));
  const orgIds = organizations.map(item => item.id);
  const placeholders = orgIds.map(() => '?').join(',');
  const targets = await all(`SELECT pt.organization_id AS organizationId, fd.code, fd.display_name AS displayName,
      pt.target_phase AS phase, pt.phase_period AS phasePeriod, pt.amount_decimal AS amount
    FROM package_targets pt JOIN field_definitions fd ON fd.id = pt.field_definition_id
    WHERE pt.package_id = ? AND pt.organization_id IN (${placeholders})`, [selectedId, ...orgIds]);
  for (const target of targets) {
    const metric = metricForField(target);
    if (!metric) continue;
    const organization = organizations.find(item => item.id === Number(target.organizationId));
    if (target.phase === 'annual' && String(target.phasePeriod) === String(year)) {
      if (organization.annualTargets[metric] != null) throw fail(`组织 ${organization.code} 的${metric}年度目标有多个字段来源。`, 409);
      organization.annualTargets[metric] = target.amount;
    }
    if (target.phase === 'cumulative' && target.phasePeriod === periodCode) {
      organization.cumulativeTargets[metric] ||= {};
      if (organization.cumulativeTargets[metric][periodCode] != null) throw fail(`组织 ${organization.code} 的${metric}累计目标有多个字段来源。`, 409);
      organization.cumulativeTargets[metric][periodCode] = target.amount;
    }
  }

  const valueRows = await all(`SELECT t.organization_id AS organizationId, t.period_code AS sourcePeriod,
      r.id AS sourceRevisionId,
      f.code, f.display_name AS displayName, v.decimal_value AS decimalValue,
      v.integer_value AS integerValue, v.text_value AS textValue
    FROM report_tasks t JOIN business_revisions r ON r.id = t.current_revision_id
      AND r.revision_status = 'finalized' AND r.is_current_effective = 1
    JOIN business_values v ON v.revision_id = r.id
    JOIN field_definitions f ON f.id = v.field_definition_id
    WHERE t.report_type_id = ? AND t.package_id = ? AND t.period_code BETWEEN ? AND ?
      AND t.organization_id IN (${placeholders})
    ORDER BY t.period_code, t.organization_id, f.code, v.record_key`,
  [normalizedReportTypeId, selectedId, `${year - 1}-01`, periodCode, ...orgIds]);
  const currentYearValues = [];
  const previousYearValues = [];
  for (const row of valueRows) {
    const metric = metricForField(row);
    const sourceYear = Number(row.sourcePeriod.slice(0, 4));
    const sourceMonth = Number(row.sourcePeriod.slice(5, 7));
    if (!metric || !Number.isInteger(sourceMonth)) continue;
    const value = readStoredValue(row);
    const item = { organizationId: Number(row.organizationId), periodCode: row.sourcePeriod,
      sourcePeriodCode: row.sourcePeriod, sourceRevisionId: Number(row.sourceRevisionId), metric, value };
    if (sourceYear === year) currentYearValues.push({ ...item, kind: 'current' });
    else if (sourceYear === year - 1) previousYearValues.push({ ...item, periodCode: `${year}-${String(sourceMonth).padStart(2, '0')}`, kind: 'prior' });
  }
  assertUnambiguous(currentYearValues, '当前年度月报值');
  assertUnambiguous(previousYearValues, '上年度月报值');
  const monthlyValues = [...currentYearValues, ...previousYearValues];
  const report = buildMonthlyReferenceReport({ periodCode, organizations, monthlyValues });
  return { ...report,
    reportType: { id: Number(reportType.id), name: reportType.displayName },
    configurationPackageId: selectedId,
    configurationVersion: Number(tasks[0].packageVersion),
    templateVersionId: Number(tasks[0].templateVersionId),
    participatingOrganizations: organizations.length,
    finalizedOrganizations: tasks.filter(task => task.revisionId != null).length,
    traceability: {
      dataSource: report.source,
      organizationScope: {
        status: 'candidate_only',
        sourceRowsCandidate: '分月数据第 5–16 行',
        deferredSourceRow: '分月数据第 17 行（生态水务）',
        reason: '源表公式范围无法证明各行与系统组织 ID 的对应关系，也无法证明报表期内的母子组织合并关系；第 17 行的七月查找也尚未解决。'
      },
      consolidation: {
        status: report.consolidationAvailable ? 'configured' : 'unavailable',
        ruleVersionId: null,
        reason: report.consolidationAvailable ? null : '本报表没有已发布并加载的组织纳入/合并规则版本。'
      },
      sourceWorkbookAdjustments: {
        status: 'not_imported',
        candidateCells: ['分月数据!C13', '分月数据!AC13', '分月数据!D16', '分月数据!G16', '分月数据!J16',
          '分月数据!U16', '分月数据!V16', '分月数据!AU16', '分月数据!AV16', '分月数据!AU17', '分月数据!AV17'],
        reason: '参考工作簿中的内嵌调整仅保留为迁移证据，不会单独叠加；本报表数值来自当前有效的已定稿修订。'
      },
      controlLossCompletion: {
        status: 'unavailable',
        reason: '分月数据!BC13 和 BC15 的备注仅作为分类线索；组织映射及已发布的控亏规则版本尚未加载。'
      },
      scoreAndRank: {
        status: report.scoringAvailable && report.rankingAvailable ? 'configured' : 'unavailable',
        reason: report.scoringAvailable && report.rankingAvailable ? null : '本报表没有已加载的完整月度评分和排名规则。'
      }
    } };
}

function buildMonthlyReferenceReport({ periodCode, organizations = [], monthlyValues = [], scoreRules = null,
  consolidationRule = null }) {
  const { year, month } = parsePeriod(periodCode);
  const values = normalizeMonthlyValues(monthlyValues);
  const rows = organizations.map(organization => {
    const id = Number(organization.id);
    const metrics = {};
    for (const metric of ['revenue', 'profit']) {
      const currentMonths = [];
      const priorMonths = [];
      for (let itemMonth = 1; itemMonth <= month; itemMonth += 1) {
        const itemPeriod = `${year}-${String(itemMonth).padStart(2, '0')}`;
        currentMonths.push(indexedAmount(values, id, itemPeriod, metric, 'current'));
        priorMonths.push(indexedAmount(values, id, itemPeriod, metric, 'prior'));
      }
      const current = currentMonths.at(-1) ?? null;
      const prior = priorMonths.at(-1) ?? null;
      const annualTarget = numeric(organization.annualTargets?.[metric]);
      const cumulativeTarget = numeric(organization.cumulativeTargets?.[metric]?.[periodCode]);
      const currentYtd = sumPresent(currentMonths, month);
      const priorYtd = sumPresent(priorMonths, month);
      const rule = scoreRules?.[metric] || null;
      const completionRule = organization.completionRules?.[metric] || null;
      const completion = targetCompletion(currentYtd.value, cumulativeTarget, completionRule);
      const scoreInput = { actual: currentYtd.value, target: cumulativeTarget, annualTarget,
        completionRate: completion, weight: numeric(organization.weights?.[metric]) };
      metrics[metric] = {
        currentMonth: current,
        priorYearSameMonth: prior,
        currentYearToDate: currentYtd,
        priorYearToDate: priorYtd,
        annualTarget,
        cumulativeTarget,
        cumulativeTargetSource: cumulativeTarget == null ? 'not_configured' : 'configured_cumulative_target',
        cumulativeCompletionRate: completion,
        yearOverYearChange: yoyChange(currentYtd.value, priorYtd.value),
        score: scoreForMetric(rule, scoreInput),
        scoreRuleVersionId: rule?.versionId ?? null
      };
    }
    const scores = [metrics.revenue.score, metrics.profit.score];
    const totalScore = scores.every(value => value != null) ? scores.reduce((sum, value) => sum + value, 0) : null;
    const sourceRevisions = [...new Map((monthlyValues || [])
      .filter(item => Number(item.organizationId) === id && item.sourceRevisionId != null)
      .map(item => [`${item.sourcePeriodCode || item.periodCode}:${item.sourceRevisionId}`, {
        periodCode: item.sourcePeriodCode || item.periodCode, revisionId: Number(item.sourceRevisionId)
      }])).values()].sort((left, right) => left.periodCode.localeCompare(right.periodCode));
    return { organizationId: id, organizationCode: organization.code, organizationName: organization.name,
      taskId: organization.taskId ?? null, reportRevisionId: organization.reportRevisionId ?? null, sourceRevisions,
      periodCode, metrics, totalScore, rank: null, complete: ['revenue', 'profit'].every(metric =>
        metrics[metric].currentYearToDate.complete && metrics[metric].priorYearToDate.complete) };
  });

  const ranked = rows.filter(row => row.totalScore != null);
  for (const row of ranked) row.rank = 1 + ranked.filter(other => other.totalScore > row.totalScore).length;
  const eligibleOrganizationIds = consolidationRule?.versionId && Array.isArray(consolidationRule.organizationIds)
    ? new Set(consolidationRule.organizationIds.map(Number)) : null;
  const consolidationAvailable = Boolean(eligibleOrganizationIds && eligibleOrganizationIds.size
    && [...eligibleOrganizationIds].every(id => rows.some(row => row.organizationId === id)));
  const totalRows = consolidationAvailable ? rows.filter(row => eligibleOrganizationIds.has(row.organizationId)) : [];
  const totals = {};
  for (const metric of ['revenue', 'profit']) {
    const currentValues = totalRows.map(row => row.metrics[metric].currentYearToDate.value);
    const priorValues = totalRows.map(row => row.metrics[metric].priorYearToDate.value);
    const annualTargets = totalRows.map(row => row.metrics[metric].annualTarget);
    const cumulativeTargets = totalRows.map(row => row.metrics[metric].cumulativeTarget);
    const sumKnown = list => list.filter(value => value != null).reduce((sum, value) => sum + value, 0);
    totals[metric] = {
      currentYearToDate: consolidationAvailable ? sumPresent(currentValues, totalRows.length) : { ...sumPresent([], 1), availableSubtotal: null },
      priorYearToDate: consolidationAvailable ? sumPresent(priorValues, totalRows.length) : { ...sumPresent([], 1), availableSubtotal: null },
      annualTarget: consolidationAvailable && annualTargets.every(value => value != null) ? sumKnown(annualTargets) : null,
      cumulativeTarget: consolidationAvailable && cumulativeTargets.every(value => value != null) ? sumKnown(cumulativeTargets) : null
    };
    totals[metric].cumulativeCompletionRate = targetCompletion(totals[metric].currentYearToDate.value, totals[metric].cumulativeTarget);
    totals[metric].yearOverYearChange = yoyChange(totals[metric].currentYearToDate.value, totals[metric].priorYearToDate.value);
  }
  const scored = totalRows.filter(row => row.totalScore != null);
  totals.totalScore = consolidationAvailable && scored.length === totalRows.length
    ? scored.reduce((sum, row) => sum + row.totalScore, 0) : null;
  return { periodCode, source: 'current_effective_finalized_monthly_revisions', rows, totals,
    consolidationAvailable,
    scoringAvailable: Boolean(scoreRules && rows.length && rows.every(row => row.totalScore != null)),
    rankingAvailable: Boolean(scoreRules && rows.length && rows.every(row => row.rank != null)) };
}

module.exports = { buildMonthlyReferenceReport, loadMonthlyReferenceReport, listMonthlyReferenceVersions, parsePeriod, targetCompletion, yoyChange };
