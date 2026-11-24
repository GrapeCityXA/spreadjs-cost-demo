import { constantValueError, operationError } from './ruleExpressionState.js'

export const BUSINESS_CASE_LIMIT = 100
const referenceName = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

export function expressionReferences(expression) {
  const fields = new Set(), parameters = [], invalid = []
  let count = 0
  const visit = (node, path, depth) => {
    if (++count > 500 || depth > 32) throw new Error('表达式最多支持 500 个节点、32 层嵌套，请简化条件。')
    if (node === null || typeof node !== 'object') {
      const message = constantValueError(node)
      if (message) invalid.push({ path, message })
      return
    }
    if (Array.isArray(node)) throw new Error('表达式节点格式无效，请重新打开规则并核对数据。')
    for (const kind of ['field', 'param']) {
      if (!own(node, kind)) continue
      if (typeof node[kind] !== 'string' || !referenceName.test(node[kind])) invalid.push({ path, message: `${kind === 'field' ? '字段编码' : '参数名'}须以英文字母开头，仅可使用英文字母、数字、_、.、-，最多 64 字符。` })
      else if (kind === 'field') fields.add(node.field)
      else parameters.push({ name: node.param, path })
    }
    if (own(node, 'op')) {
      if (!Array.isArray(node.args)) throw new Error('表达式的运算项数据不完整，请重新打开规则并核对数据。')
      const message = operationError(node.op, node.args)
      if (message) invalid.push({ path, message })
      node.args.forEach((arg, index) => visit(arg, `${path}.${index}`, depth + 1))
    } else if (own(node, 'const')) {
      visit(node.const, path, depth + 1)
    }
    const kinds = ['op', 'field', 'param', 'const'].filter(key => own(node, key))
    const allowed = own(node, 'op') ? ['op', 'args', 'value', 'name'] : kinds
    if (kinds.length !== 1 || Object.keys(node).some(key => !allowed.includes(key))) invalid.push({ path, message: '表达式节点格式无效，请重新选择表达式类型。' })
  }
  visit(expression, 'root', 0)
  return { fields: [...fields], parameters, invalid }
}

export function parseBusinessValue(text) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('请填写值。若要测试空值，请输入 null；空文本请输入 ""。')
  let value
  try { value = JSON.parse(raw) } catch {
    if (/^[\[{"]/.test(raw) || /^[+-]?\d/.test(raw) || /^(?:NaN|[+-]?Infinity)$/.test(raw)) throw new Error('值格式无效。数字请去掉多余前导零；文本请加双引号，如 "01"。数组或对象请检查 JSON 格式。')
    return raw
  }
  const pending = [{ value, depth: 0 }]
  while (pending.length) {
    const item = pending.pop()
    if (item.depth > 64) throw new Error('值的嵌套过深，请简化到 64 层以内。')
    if (typeof item.value === 'number' && !Number.isFinite(item.value)) throw new Error('数值过大，请输入有限数字。')
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 })
    }
  }
  return value
}

export function validateBusinessRuleDraft(expression, parameterRows, caseRows) {
  const errors = Object.create(null), entries = [], names = new Map()
  let references
  try { references = expressionReferences(expression) } catch (error) { errors.expression = error.message }
  for (const row of parameterRows) {
    const key = `parameter-${row.id}`
    if (!referenceName.test(row.name)) errors[`${key}-name`] = '参数名须以英文字母开头，仅可使用英文字母、数字、_、.、-，最多 64 字符。'
    else if (names.has(row.name)) {
      errors[`${key}-name`] = `参数“${row.name}”重复。请为参数设置不同名称，或删除重复项。`
      errors[`parameter-${names.get(row.name)}-name`] = errors[`${key}-name`]
    } else names.set(row.name, row.id)
    try { entries.push([row.name, parseBusinessValue(row.value)]) } catch (error) { errors[`${key}-value`] = error.message }
  }
  const parameters = Object.fromEntries(entries)
  if (JSON.stringify(parameters).length > 8000) errors.parameters = '参数内容超过保存上限，请减少参数或缩短参数值。'
  for (const item of references?.invalid || []) errors[`expression-${item.path}`] = item.message
  for (const item of references?.parameters || []) {
    if (!names.has(item.name)) errors[`expression-${item.path}`] = `参数“${item.name}”尚未定义。请在“参数”区添加同名参数，或将此处改为已有参数名。`
  }
  if (caseRows.length > BUSINESS_CASE_LIMIT) errors.cases = `最多保留 ${BUSINESS_CASE_LIMIT} 个测试样例，请删除多余样例。`
  const testCases = caseRows.map((row, index) => {
    const prefix = `case-${row.id}`, name = String(row.name || '').trim()
    if (!name || name.length > 120) errors[`${prefix}-name`] = '请填写样例名称，最多 120 字符，例如“达到预警线”。'
    let expected
    try { expected = parseBusinessValue(row.expectedText) } catch (error) { errors[`${prefix}-expected`] = error.message }
    const inputs = []
    for (const field of references?.fields || []) {
      try { inputs.push([field, parseBusinessValue(own(row.values, field) ? row.values[field] : undefined)]) } catch (error) { errors[`${prefix}-input-${field}`] = error.message }
    }
    const result = { name, expected, input: Object.fromEntries(inputs) }
    if (JSON.stringify(result).length > 20000) errors[`${prefix}-name`] = `第 ${index + 1} 个样例内容超过保存上限，请缩短测试输入或预期结果。`
    return result
  })
  if (JSON.stringify(testCases).length > 256000) errors.cases = '测试样例的总内容超过保存上限，请删除不需要的样例或缩短输入内容。'
  return { errors, data: { expression, parameters, testCases } }
}
