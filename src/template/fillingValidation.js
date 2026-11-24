import { evaluateBusinessExpression } from '../utils/formulaEvaluator.js'

function exceedsDecimalPrecision(value, precision) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return false
  const places = Math.max(0, Number(precision) || 0)
  // Spreadsheet formulas often leave binary floating-point noise (e.g. a cell
  // showing 0 stores 2.77e-17). Treat that as zero instead of a precision error.
  const rounded = Number(numeric.toFixed(places))
  return Math.abs(numeric - rounded) > Number.EPSILON * Math.max(1, Math.abs(numeric)) * 8
}

// Only browser business validation; authorization and persistence remain server responsibilities.
export function validateFillingValues(mappings, rules = []) {
  const errors = [], input = {}
  const add = (code, message) => errors.push({ code, message })
  for (const mapping of mappings) {
    if (mapping.fieldCode) input[mapping.fieldCode] = mapping.value
    if (!mapping.primary || mapping.permission !== 'primary_input') continue
    const value = mapping.value, label = mapping.displayName || mapping.fieldCode
    if (value == null || String(value).trim() === '') {
      if (mapping.required) add('required', `“${label}”为必填项。`)
      continue
    }
    const type = mapping.dataType || mapping.type || mapping.semanticType
    if (['decimal', 'number', 'integer'].includes(type)) {
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || (type === 'integer' && !Number.isSafeInteger(numeric))) add('number', `“${label}”必须是有效${type === 'integer' ? '整数' : '数值'}。`)
      else if (type === 'decimal' && mapping.precision != null && !mapping.calculated && exceedsDecimalPrecision(value, mapping.precision)) add('precision', `“${label}”最多允许 ${mapping.precision} 位小数。`)
    }
    if (typeof value === 'string' && /^#[A-Z0-9/?]+[!?]?$/.test(value)) add('formula', `“${label}”存在公式错误。`)
  }
  for (const rule of rules.filter(rule => rule.ruleType === 'validation' && (rule.severity || 'blocking') === 'blocking' && rule.expression?.engine !== 'spreadjs-validator')) {
    const mapping = mappings.find(item => (item.ruleVersionIds || []).includes(Number(rule.id)))
    try {
      if (!evaluateBusinessExpression(rule.expression, mapping ? { ...input, value: mapping.value } : input, rule.parameters)) add(rule.code, `规则“${rule.displayName || rule.code}”未通过。`)
    } catch (error) { add(rule.code, `规则“${rule.displayName || rule.code}”：${error.message}`) }
  }
  return errors
}
