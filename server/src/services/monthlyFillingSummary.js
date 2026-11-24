const { calculateManagedSnapshot } = require('./managedFunctions');
const { readBoundValue } = require('./bindingSource');
const db = require('../config/database');
const { evaluateExpression } = require('./ruleEvaluator');
const { evaluateGovernedFormulas } = require('./formulaPrecheck');
const { findSyntheticHistoryOrganization, getSyntheticHistoryFixture } = require('./monthlyFillingHistory');
const { precheckSnapshotVersion } = require('./precheckVersion');
const { DEFAULT_ANOMALY_RULE_CODES } = require('./defaultAnomalyRules');
const { createSnapshotReader } = require('./nativeUserFormula');

const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));

function parsePeriod(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]); const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year, month } : null;
}

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[\s\-_（）()]/g, '');
}

function mappingSearchText(mapping) {
  return `${mapping.fieldCode || ''} ${mapping.displayName || ''} ${mapping.fieldName || ''} ${mapping.label || ''}`.toLowerCase();
}

function metricFor(mapping) {
  const text = mappingSearchText(mapping);
  if (/profit|利润/.test(text)) return 'profit';
  if (/revenue|营业收入|营收/.test(text)) return 'revenue';
  return null;
}

function isPriorYear(mapping) {
  return /prior|previous|last.?year|上年|去年|同比/.test(mappingSearchText(mapping));
}

function isPrimaryInput(mapping) {
  return mapping.primary === true && mapping.permission === 'primary_input';
}

function readMappingValue(snapshotData, workbook, sheetIndex, mapping, formulaReader) {
  const row = Number(mapping.row); const col = Number(mapping.col);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) return null;
  const sheets = snapshotData?.sheets || snapshotData?.data?.sheets;
  const orderedSheets = Array.isArray(sheets) ? sheets : sheets && typeof sheets === 'object'
    ? Object.values(sheets).sort((left, right) => Number(left.order || 0) - Number(right.order || 0)) : [];
  const sheet = orderedSheets[sheetIndex];
  const cell = sheet?.data?.dataTable?.[row]?.[col] || sheet?.dataTable?.[row]?.[col];
  if (cell?.formulaInfo?.parts) {
    const sheetId = Object.keys(sheets).find(id => sheets[id] === sheet);
    return formulaReader.read(sheetId, row, col).value;
  }
  if (mapping.bindingPath && snapshotData) return readBoundValue(snapshotData, sheet, mapping.bindingPath);
  if (cell && Object.prototype.hasOwnProperty.call(cell, 'value')) return cell.value;
  if (cell && Object.prototype.hasOwnProperty.call(cell, 'text')) return cell.text;
  const templateCell = workbook?.sheets?.[sheetIndex]?.cells?.find(item => Number(item.row) === row
    && Number(item.column ?? item.col) === col);
  return templateCell?.value ?? null;
}

function numericValue(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function historyValue(organizationCode, year, month, fieldCode, finalizedHistory = new Map(), historyFixture = null) {
  const period = `${year}-${String(month).padStart(2, '0')}`;
  const finalizedValue = finalizedHistory.get(`${period}:${fieldCode}`);
  if (finalizedValue != null) return finalizedValue;
  if (!organizationCode || !historyFixture) return null;
  const row = historyFixture.records.find(item => item.organizationCode === organizationCode
    && item.period === period && item.fieldCode === fieldCode);
  return row ? row.value : null;
}

function sumThroughMonth(organizationCode, year, month, fieldCode, currentValue, finalizedHistory, historyFixture) {
  const values = [];
  for (let index = 1; index < month; index += 1) values.push(historyValue(organizationCode, year, index, fieldCode, finalizedHistory, historyFixture));
  values.push(currentValue);
  const present = values.filter(value => value != null);
  return {
    value: present.length === values.length ? present.reduce((sum, value) => sum + value, 0) : null,
    availableSubtotal: present.reduce((sum, value) => sum + value, 0),
    complete: present.length === values.length,
    monthsAvailable: present.length,
    monthsExpected: values.length
  };
}

function targetFor(task, metric, mappings, year, month) {
  const metricMappings = mappings.filter(mapping => metricFor(mapping) === metric);
  const fieldCodes = new Set(metricMappings.map(mapping => normalized(mapping.fieldCode)));
  const targets = task.configuration?.targets || [];
  const matches = targets.filter(target => {
    const targetCode = normalized(target.fieldCode);
    return fieldCodes.has(targetCode) || metricFor({ fieldCode: target.fieldCode, displayName: target.displayName }) === metric;
  });
  const monthly = matches.find(target => target.phase === 'monthly' && target.phasePeriod === task.periodCode);
  const cumulative = matches.find(target => target.phase === 'cumulative' && target.phasePeriod === task.periodCode);
  const annual = matches.find(target => target.phase === 'annual' && String(target.phasePeriod) === String(year));
  return {
    monthly: monthly ? Number(monthly.amount) : null,
    annual: annual ? Number(annual.amount) : null,
    cumulative: cumulative ? Number(cumulative.amount)
      : annual && Number.isFinite(Number(annual.amount)) ? Number(annual.amount) * month / 12 : null,
    source: cumulative || monthly || annual ? 'period-package' : null,
    cumulativeSource: cumulative ? 'configured-cumulative-target' : annual ? 'annual-target-proration' : null
  };
}

function targetCompletionPercent(actual, target) {
  if (actual == null || target == null || target === 0) return null;
  return (target < 0 ? 2 - actual / target : actual / target) * 100;
}

function addIssue(issues, code, message, mapping, severity = 'warning', value = null, evidence = {}) {
  const row = mapping?.row != null && Number.isInteger(Number(mapping.row)) ? Number(mapping.row) : null;
  const column = mapping?.col != null && Number.isInteger(Number(mapping.col)) ? Number(mapping.col) : null;
  const ruleVersionId = Number.isSafeInteger(Number(evidence.ruleVersionId)) && Number(evidence.ruleVersionId) > 0
    ? Number(evidence.ruleVersionId) : null;
  const recordKey = String(evidence.recordKey ?? mapping?.recordKey ?? '');
  const warningKey = `${ruleVersionId || code}:${mapping?.fieldCode || ''}:${recordKey}:${row ?? ''}:${column ?? ''}`;
  issues.push({ code, warningKey, message, severity, fieldCode: mapping?.fieldCode || null,
    fieldDefinitionId: mapping?.fieldDefinitionId || null, namedArea: mapping?.namedArea || null,
    sheetCode: mapping?.sheetCode || null, row, column, recordKey, ruleVersionId,
    ruleCode: evidence.ruleCode || code, value,
    triggeringValue: evidence.triggeringValue !== undefined ? evidence.triggeringValue : value,
    comparisonValue: evidence.comparisonValue ?? null, threshold: evidence.threshold ?? null,
    colorClassification: evidence.colorClassification || (severity === 'warning' ? 'warning' : 'blocking') });
}

async function buildMonthlyFillingSummary({ task, organization, workbook, manifest, snapshot, roomVersion }) {
  const period = parsePeriod(task.periodCode);
  const sheetDefinitions = workbook?.sheets || [];
  const snapshotData = snapshot?.data || snapshot || null;
  const snapshotStatus = precheckSnapshotVersion(snapshot, roomVersion);
  const { version: snapshotVersion, roomVersion: roomVersionNumber, snapshotUnavailable, stale } = snapshotStatus;
  const historyFixture = getSyntheticHistoryFixture();
  const mappings = sheetDefinitions.flatMap((sheet, sheetIndex) => (sheet.mappings || []).map(mapping => ({
    ...mapping, sheetIndex, sheetCode: sheet.code, sheetName: sheet.name
  })));
  const formulaReader = createSnapshotReader(snapshotData, await calculateManagedSnapshot(workbook, snapshotData));
  const formulaErrors = [];
  const mappingValues = new Map(mappings.map(mapping => {
    try { return [mapping, readMappingValue(snapshotData, workbook, mapping.sheetIndex, mapping, formulaReader)]; }
    catch (error) { formulaErrors.push({ mapping, message: error.message }); return [mapping, null]; }
  }));
  const finalizedHistory = new Map();
  if (organization.id) {
    const rows = await all(`SELECT t.period_code AS periodCode, fd.code AS fieldCode, fd.display_name AS displayName,
        COALESCE(bv.decimal_value, CAST(bv.integer_value AS TEXT)) AS value
      FROM report_tasks t JOIN report_types rt ON rt.id = t.report_type_id AND rt.cadence = 'monthly'
      JOIN business_revisions br ON br.id = (SELECT latest.id FROM business_revisions latest
        WHERE latest.task_id = t.id AND lower(latest.revision_status) = 'finalized'
        ORDER BY latest.revision_number DESC LIMIT 1)
      JOIN business_values bv ON bv.revision_id = br.id
      JOIN field_definitions fd ON fd.id = bv.field_definition_id
      WHERE t.organization_id = ? AND t.report_type_id = ?`, [organization.id, task.reportTypeId]);
    for (const row of rows) {
      const rowPeriod = parsePeriod(row.periodCode); const metric = metricFor({ fieldCode: row.fieldCode, displayName: row.displayName });
      const value = numericValue(row.value);
      if (rowPeriod && metric && value != null) finalizedHistory.set(`${row.periodCode}:${metric}`, value);
    }
  }
  const fieldValues = {};
  const currentByMetric = {};
  const priorByMetric = {};
  const blocking = [];
  for (const error of formulaErrors) addIssue(blocking, 'user_formula_error', error.message, error.mapping, 'blocking');
  const warnings = [];

  for (const mapping of mappings) {
    if (!mapping.fieldCode) continue;
    const value = mappingValues.get(mapping);
    if (!isPrimaryInput(mapping)) continue;
    fieldValues[mapping.fieldCode] = value;
    const number = numericValue(value);
    if (mapping.required && (value == null || String(value).trim() === '')) {
      addIssue(blocking, 'required_value_missing', `必填项“${mapping.displayName || mapping.fieldCode}”尚未填写。`, mapping, 'blocking');
    }
    const dataType = String(mapping.dataType || mapping.data_type || '').toLowerCase();
    const metric = metricFor(mapping);
    if (metric) {
      if (value != null && value !== '' && (['decimal', 'integer', 'number'].includes(dataType) || mapping.required) && number == null) {
        addIssue(blocking, 'invalid_numeric_value', `“${mapping.displayName || mapping.fieldCode}”必须是有效数值。`, mapping, 'blocking', value);
      }
      if (isPriorYear(mapping)) priorByMetric[metric] = { mapping, value: number };
      else currentByMetric[metric] = { mapping, value: number };
    } else if (value != null && value !== '' && ['decimal', 'integer', 'number'].includes(dataType) && number == null) {
      addIssue(blocking, 'invalid_numeric_value', `“${mapping.displayName || mapping.fieldCode}”必须是有效数值。`, mapping, 'blocking', value);
    }
  }

  const taskRuleVersionIds = (task.configuration?.configuration?.ruleVersionIds || task.configuration?.ruleVersions || []).map(Number);
  const selectedRuleIds = new Set(taskRuleVersionIds);
  for (const mapping of mappings) {
    for (const id of mapping.ruleVersionIds || []) selectedRuleIds.add(Number(id));
    if (mapping.formulaVersionId) selectedRuleIds.add(Number(mapping.formulaVersionId));
  }
  const ruleRows = selectedRuleIds.size ? await all(`SELECT rv.id, rv.version, rv.expression_json, rv.parameters_json, rv.severity,
      rd.code, rd.display_name AS displayName, rd.rule_type AS ruleType
    FROM rule_versions rv JOIN rule_definitions rd ON rd.id = rv.rule_id
    WHERE rv.id IN (${[...selectedRuleIds].map(() => '?').join(',')}) AND rv.status = 'published'`, [...selectedRuleIds]) : [];
  const defaultRulesByCode = new Map(ruleRows
    .filter(rule => !DEFAULT_ANOMALY_RULE_CODES.includes(rule.code) || taskRuleVersionIds.includes(Number(rule.id)))
    .sort((left, right) => Number(left.version) - Number(right.version))
    .map(rule => [rule.code, rule]));
  const evaluatorInput = { ...fieldValues };
  if (currentByMetric.revenue?.value != null) evaluatorInput.revenue = currentByMetric.revenue.value;
  if (currentByMetric.profit?.value != null) evaluatorInput.profit = currentByMetric.profit.value;
  const formulaIssues = evaluateGovernedFormulas(ruleRows.filter(rule => rule.ruleType === 'formula'), mappings, mappingValues, evaluatorInput);
  for (const issue of formulaIssues) {
    const message = issue.code === 'formula_result_mismatch'
      ? `公式“${issue.mapping?.displayName || issue.mapping?.fieldCode}”的工作簿结果与服务端重算结果不一致。`
      : `公式执行失败：${issue.message}`;
    addIssue(blocking, issue.code, message, issue.mapping, 'blocking', issue.value ?? null);
  }
  for (const rule of ruleRows) {
    if (rule.ruleType === 'formula' || JSON.parse(rule.expression_json || '{}').engine === 'spreadjs-validator') continue;
    if (DEFAULT_ANOMALY_RULE_CODES.includes(rule.code)) continue;
    try {
      const linkedMappings = mappings.filter(item => (item.ruleVersionIds || []).includes(Number(rule.id)));
      const linkedMapping = linkedMappings.find(isPrimaryInput) || linkedMappings[0];
      const mapping = linkedMapping && !isPrimaryInput(linkedMapping)
        ? mappings.find(item => isPrimaryInput(item) && item.fieldCode === linkedMapping.fieldCode) || linkedMapping
        : linkedMapping;
      const ruleInput = mapping ? { ...evaluatorInput, value: mappingValues.get(mapping) } : evaluatorInput;
      const result = evaluateExpression(JSON.parse(rule.expression_json), ruleInput, JSON.parse(rule.parameters_json || '{}'));
      const violated = rule.ruleType === 'validation' ? !Boolean(result) : Boolean(result);
      if (!violated) continue;
      const severity = rule.ruleType === 'anomaly' || rule.severity === 'warning' ? 'warning' : 'blocking';
      addIssue(severity === 'blocking' ? blocking : warnings, rule.code,
        `规则“${rule.displayName || rule.code}”未通过。`, mapping, severity,
        mapping ? mappingValues.get(mapping) : null, { ruleVersionId: rule.id, ruleCode: rule.code,
          comparisonValue: ruleInput, threshold: JSON.parse(rule.parameters_json || '{}') });
    } catch (error) {
      addIssue(blocking, 'rule_evaluation_failed', `规则 ${rule.code} 执行失败：${error.message}`, null, 'blocking');
    }
  }

  const thresholds = { yoyChangePercent: 30, momChangePercent: 30, targetCompletionMinPercent: 70, targetCompletionMaxPercent: 130,
    ...(task.configuration?.configuration?.ruleThresholds || {}) };
  const evaluateDefaultAnomaly = (rule, input, parameterOverrides = {}) => {
    if (!rule) return false;
    const parameters = { ...JSON.parse(rule.parameters_json || '{}'), ...parameterOverrides };
    return Boolean(evaluateExpression(JSON.parse(rule.expression_json), input, parameters));
  };
  const fixtureOrganization = findSyntheticHistoryOrganization(organization);
  const finalizedPeriods = [...new Set([...finalizedHistory.keys()].map(key => key.split(':')[0]))].sort();
  const sampleDataLabel = finalizedHistory.size
    ? fixtureOrganization ? '已定稿月报数据（缺月由合成样例补齐）' : '已定稿月报数据'
    : fixtureOrganization ? '合成示例数据' : '无可用历史数据';
  const calculations = { syntheticSampleData: Boolean(fixtureOrganization && historyFixture?.synthetic), sampleDataLabel, unit: historyFixture?.unit || '万元',
    currentMonth: {}, priorYearSameMonth: {}, currentYearToDate: {}, priorYearToDate: {}, targets: {}, source: {
      fixtureVersion: fixtureOrganization ? historyFixture?.fixtureVersion : null,
      sourceFiles: fixtureOrganization ? historyFixture?.sourceFiles || [] : [],
      finalizedMonthlyValueCount: finalizedHistory.size,
      historyAvailableThrough: fixtureOrganization ? '2026-12' : finalizedPeriods.at(-1) || null
    } };

  if (period) {
    for (const metric of ['revenue', 'profit']) {
      const currentInput = currentByMetric[metric]?.value ?? null;
      const priorInput = priorByMetric[metric]?.value ?? null;
      const previousPeriodValue = period.month > 1
        ? historyValue(fixtureOrganization?.organizationCode, period.year, period.month - 1, metric, finalizedHistory, historyFixture) : null;
      const sourcePriorSameMonth = historyValue(fixtureOrganization?.organizationCode, period.year - 1, period.month, metric, finalizedHistory, historyFixture);
      const priorSameMonthValue = priorInput ?? sourcePriorSameMonth;
      const currentTotal = sumThroughMonth(fixtureOrganization?.organizationCode, period.year, period.month, metric, currentInput, finalizedHistory, historyFixture);
      const priorTotal = sumThroughMonth(fixtureOrganization?.organizationCode, period.year - 1, period.month, metric,
        priorInput ?? sourcePriorSameMonth, finalizedHistory, historyFixture);
      const target = targetFor(task, metric, mappings, period.year, period.month);
      calculations.currentMonth[metric] = currentInput;
      calculations.priorYearSameMonth[metric] = priorInput;
      calculations.currentYearToDate[metric] = currentTotal;
      calculations.priorYearToDate[metric] = priorTotal;
      calculations.targets[metric] = { ...target,
        monthlyCompletionPercent: targetCompletionPercent(currentInput, target.monthly),
        cumulativeCompletionPercent: targetCompletionPercent(currentTotal.value, target.cumulative) };

      const mapping = currentByMetric[metric]?.mapping;
      const yoyRule = defaultRulesByCode.get('DEFAULT_YOY_CHANGE');
      const momRule = defaultRulesByCode.get('DEFAULT_MOM_CHANGE');
      const completionRule = defaultRulesByCode.get('DEFAULT_COMPLETION_BAND');
      const revenueRule = defaultRulesByCode.get('DEFAULT_NEGATIVE_REVENUE');
      const yoyParams = { threshold: Number(thresholds.yoyChangePercent) / 100 };
      const momParams = { threshold: Number(thresholds.momChangePercent) / 100 };
      const completionParams = { minimum: Number(thresholds.targetCompletionMinPercent) / 100,
        maximum: Number(thresholds.targetCompletionMaxPercent) / 100 };
      if (metric === 'revenue' && currentInput != null
        && evaluateDefaultAnomaly(revenueRule, { revenue: currentInput })) {
        addIssue(warnings, 'negative_revenue', '营业收入为负数，请核对并说明原因。', mapping, 'warning', currentInput,
          { ruleVersionId: revenueRule.id, ruleCode: revenueRule.code, comparisonValue: 0,
            threshold: { operator: 'lt', value: 0, parameters: JSON.parse(revenueRule.parameters_json || '{}') } });
      }
      if (currentInput != null && priorSameMonthValue != null && Math.abs(priorSameMonthValue) > 1e-9
        && evaluateDefaultAnomaly(yoyRule, { current: currentInput, priorYearSamePeriod: priorSameMonthValue }, yoyParams)) {
        const yoy = Math.abs((currentInput - priorSameMonthValue) / Math.abs(priorSameMonthValue)) * 100;
        addIssue(warnings, 'year_over_year_change',
          `较上年同月变动 ${yoy.toFixed(2)}%，达到预警线 ${thresholds.yoyChangePercent}%。`, mapping, 'warning', yoy,
          { ruleVersionId: yoyRule?.id, ruleCode: yoyRule?.code || 'DEFAULT_YOY_CHANGE', comparisonValue: priorSameMonthValue,
            triggeringValue: currentInput,
            threshold: { ...yoyParams, ruleParameters: JSON.parse(yoyRule?.parameters_json || '{}') } });
      }
      if (currentInput != null && previousPeriodValue != null && Math.abs(previousPeriodValue) > 1e-9
        && evaluateDefaultAnomaly(momRule, { current: currentInput, priorPeriod: previousPeriodValue }, momParams)) {
        const mom = Math.abs((currentInput - previousPeriodValue) / Math.abs(previousPeriodValue)) * 100;
        addIssue(warnings, 'month_over_month_change',
          `较上月变动 ${mom.toFixed(2)}%，达到预警线 ${thresholds.momChangePercent}%。`, mapping, 'warning', mom,
          { ruleVersionId: momRule?.id, ruleCode: momRule?.code || 'DEFAULT_MOM_CHANGE', comparisonValue: previousPeriodValue,
            triggeringValue: currentInput,
            threshold: { ...momParams, ruleParameters: JSON.parse(momRule?.parameters_json || '{}') } });
      }
      if (currentInput != null && target.monthly != null && target.monthly !== 0
        && evaluateDefaultAnomaly(completionRule, { actual: currentInput, target: target.monthly }, completionParams)) {
        const completion = targetCompletionPercent(currentInput, target.monthly);
        addIssue(warnings, 'target_completion_outside_range', `本月目标完成率 ${completion.toFixed(2)}%，预警范围为 ${thresholds.targetCompletionMinPercent}%–${thresholds.targetCompletionMaxPercent}%。`, mapping, 'warning', completion,
          { ruleVersionId: completionRule.id, ruleCode: completionRule.code, comparisonValue: target.monthly,
            triggeringValue: currentInput,
            threshold: { ...completionParams, ruleParameters: JSON.parse(completionRule.parameters_json || '{}') } });
      }
      if (currentTotal.value != null && target.cumulative != null && target.cumulative !== 0
        && evaluateDefaultAnomaly(completionRule, { actual: currentTotal.value, target: target.cumulative }, completionParams)) {
        const completion = targetCompletionPercent(currentTotal.value, target.cumulative);
        addIssue(warnings, 'cumulative_target_completion_outside_range', `累计目标完成率 ${completion.toFixed(2)}%，预警范围为 ${thresholds.targetCompletionMinPercent}%–${thresholds.targetCompletionMaxPercent}%。`, mapping, 'warning', completion,
          { ruleVersionId: completionRule.id, ruleCode: completionRule.code, comparisonValue: target.cumulative,
            triggeringValue: currentTotal.value,
            threshold: { ...completionParams, ruleParameters: JSON.parse(completionRule.parameters_json || '{}') } });
      }
    }
  }

  const adjustment = await get(`SELECT COUNT(*) AS count FROM adjustment_requests ar
    WHERE ar.task_id = ?`, [task.id]);
  const adjustmentRule = defaultRulesByCode.get('DEFAULT_ADJUSTMENT_PRESENT');
  if (Number(adjustment?.count || 0) > 0
    && evaluateDefaultAnomaly(adjustmentRule, { hasAdjustment: true })) {
    addIssue(warnings, 'adjustment_present', '本任务存在调整记录，请核对累计口径。', null, 'warning', Number(adjustment.count),
      { ruleVersionId: adjustmentRule.id, ruleCode: adjustmentRule.code, comparisonValue: false,
        threshold: { parameters: JSON.parse(adjustmentRule.parameters_json || '{}') } });
  }

  if (!fixtureOrganization && !finalizedHistory.size) {
    calculations.source.historyMessage = '未匹配到合成历史样例；累计历史不完整。';
  }
  const ruleSummary = { version: snapshotVersion, roomVersion: roomVersionNumber, stale, snapshotUnavailable,
    status: stale ? 'stale' : 'current', blockingCount: blocking.length, warningCount: warnings.length,
    blocking, warnings, thresholds };
  const authoritativeValues = Object.fromEntries(mappings.filter(mapping => mapping.kind === 'calc' && mapping.fieldCode
    && Object.hasOwn(evaluatorInput, mapping.fieldCode)).map(mapping => [mapping.fieldCode, evaluatorInput[mapping.fieldCode]]));
  return { validationRules: ruleRows.map(rule => ({ id: rule.id, code: rule.code, displayName: rule.displayName, ruleType: rule.ruleType, severity: rule.severity, expression: JSON.parse(rule.expression_json), parameters: JSON.parse(rule.parameters_json || '{}') })), precheck: ruleSummary, calculations, authoritativeValues, manifestVersion: manifest?.version || null };
}

module.exports = { buildMonthlyFillingSummary, parsePeriod, metricFor, isPriorYear, isPrimaryInput };
