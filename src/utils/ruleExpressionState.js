export const expressionOperations = {
  add: '相加', subtract: '相减', multiply: '相乘', divide: '相除', abs: '绝对值',
  min: '最小值', max: '最大值', sum: '求和', average: '平均值', round: '四舍五入',
  if: '如果 / 那么 / 否则', eq: '等于', ne: '不等于', gt: '大于', gte: '大于或等于',
  lt: '小于', lte: '小于或等于', and: '全部条件满足', or: '任一条件满足', not: '条件取反',
  is_null: '为空', not_null: '不为空', coalesce: '首个非空值', completion_rate: '完成率',
  control_loss: '控制亏损系数', cumulative: '累计', weighted_score: '加权得分',
  score_completion: '完成率计分', competition_rank: '竞赛排名'
}

export const expressionArities = {
  abs: 1, if: 3, not: 1, is_null: 1, not_null: 1, subtract: 2, divide: 2,
  eq: 2, ne: 2, gt: 2, gte: 2, lt: 2, lte: 2, completion_rate: 2,
  control_loss: 2, weighted_score: 2, score_completion: 3, competition_rank: 2
}

export function operationArguments(op, args = []) {
  const count = expressionArities[op] ?? (op === 'round' ? Math.min(2, Math.max(1, args.length)) : Math.max(1, args.length))
  return Array.from({ length: count }, (_, index) => index < args.length ? args[index] : 0)
}

export function constantText(value) {
  const constant = value && typeof value === 'object' ? value.const : value
  return constant === undefined ? '' : JSON.stringify(constant)
}

export function constantValueError(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return '数值过大，请输入有限数字。'
  if (typeof value === 'string' && value.length > 1000) return '固定文本最多 1000 字符，请缩短内容。'
  if (value !== null && !['number', 'string', 'boolean'].includes(typeof value)) return '固定值仅支持数字、文本、true、false 或 null；数组或对象请通过参数引用。'
  return ''
}

export function operationError(op, args) {
  if (!Object.hasOwn(expressionOperations, op)) return '运算方式无效，请重新选择。'
  if (!Array.isArray(args)) return '表达式的运算项数据不完整，请重新打开规则并核对数据。'
  const count = expressionArities[op]
  if (count && args.length !== count) return `${expressionOperations[op]}需要 ${count} 个运算项，请补齐或移除多余项。`
  if (!args.length) return '请至少保留 1 个条件或运算项。'
  if (op === 'round' && args.length > 2) return '四舍五入需要 1 至 2 个运算项。'
  return ''
}
