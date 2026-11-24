const { evaluateExpression, resultsEqual } = require('./ruleEvaluator');

function requiresAuthoritativeFormula(mapping) {
  return mapping.kind === 'calc' && /_CALC_/.test(mapping.namedArea || '');
}

function evaluateGovernedFormulas(formulas, mappings, mappingValues, evaluatorInput) {
  const blocking = [];
  for (const mapping of mappings.filter(requiresAuthoritativeFormula)) {
    if (!mapping.formulaVersionId || !mapping.formulaSource || !formulas.some(rule =>
      Number(rule.id) === Number(mapping.formulaVersionId) && rule.code === mapping.formulaSource)) {
      blocking.push({ code: 'formula_unavailable', mapping,
        message: `“${mapping.displayName || mapping.fieldCode || mapping.namedArea}”（${mapping.namedArea}）配置为系统计算，但缺少已发布的后端公式。请由模板设计者绑定业务公式；若需手工填报，请改为标量输入并发布新模板。` });
    }
  }
  const formulaMappings = formulas.map(rule => ({ rule, mapping: mappings.find(item => Number(item.formulaVersionId) === Number(rule.id)) }))
    .filter(item => item.mapping?.fieldCode);
  const formulaFields = new Set(formulaMappings.map(item => item.mapping.fieldCode));
  const unresolved = [...formulas];

  while (unresolved.length) {
    let evaluatedCount = 0;
    for (let index = unresolved.length - 1; index >= 0; index -= 1) {
      const rule = unresolved[index];
      const mapping = mappings.find(item => Number(item.formulaVersionId) === Number(rule.id));
      if (!mapping?.fieldCode) { unresolved.splice(index, 1); evaluatedCount += 1; continue; }
      try {
        const expression = JSON.parse(rule.expression_json);
        const references = new Set();
        const collectReferences = node => {
          if (!node || typeof node !== 'object') return;
          if (typeof node.field === 'string') references.add(node.field);
          if (Array.isArray(node.args)) node.args.forEach(collectReferences);
        };
        collectReferences(expression);
        if ([...references].some(fieldCode => formulaFields.has(fieldCode) && !Object.prototype.hasOwnProperty.call(evaluatorInput, fieldCode))) continue;

        const result = evaluateExpression(expression, evaluatorInput, JSON.parse(rule.parameters_json || '{}'));
        evaluatorInput[mapping.fieldCode] = result;
        const snapshotValue = mappingValues.get(mapping);
        if (!resultsEqual(numericValue(snapshotValue) ?? snapshotValue, numericValue(result) ?? result)) {
          blocking.push({ code: 'formula_result_mismatch', mapping, value: snapshotValue });
        }
      } catch (error) {
        blocking.push({ code: 'formula_evaluation_failed', message: error.message, mapping });
      }
      unresolved.splice(index, 1);
      evaluatedCount += 1;
    }
    if (!evaluatedCount) {
      for (const rule of unresolved) {
        const mapping = mappings.find(item => Number(item.formulaVersionId) === Number(rule.id));
        blocking.push({ code: 'formula_evaluation_failed', message: '存在未解析的公式依赖。', mapping });
      }
      break;
    }
  }
  return blocking;
}

function numericValue(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

module.exports = { evaluateGovernedFormulas, requiresAuthoritativeFormula };
