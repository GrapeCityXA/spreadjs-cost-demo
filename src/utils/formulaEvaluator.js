const operators = new Set(['add', 'subtract', 'multiply', 'divide', 'abs', 'min', 'max', 'sum', 'average', 'round', 'if', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'and', 'or', 'not', 'is_null', 'not_null', 'coalesce', 'completion_rate', 'control_loss', 'cumulative', 'weighted_score', 'score_completion', 'competition_rank'])

export function evaluateBusinessExpression(expression, input = {}, parameters = {}) {
  let nodeCount = 0
  const validate = (node, depth = 0) => {
    nodeCount += 1
    if (nodeCount > 500 || depth > 32) throw new Error('表达式过大或嵌套过深')
    if (node === null || typeof node === 'boolean') return
    if (typeof node === 'number') { if (!Number.isFinite(node)) throw new Error('数值常量必须为有限数字'); return }
    if (typeof node === 'string') { if (node.length > 1000) throw new Error('字符串常量过长'); return }
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('表达式节点必须为 JSON 对象或基本值')
    const keys = Object.keys(node)
    if (Object.hasOwn(node, 'op')) {
      if (keys.some(key => !['op', 'args', 'value', 'name'].includes(key)) || !operators.has(node.op) || !Array.isArray(node.args)) throw new Error('表达式节点格式无效')
      const exact = { abs: 1, if: 3, not: 1, is_null: 1, not_null: 1, subtract: 2, divide: 2, eq: 2, ne: 2, gt: 2, gte: 2, lt: 2, lte: 2, completion_rate: 2, control_loss: 2, weighted_score: 2, score_completion: 3, competition_rank: 2 }[node.op]
      if ((exact != null && node.args.length !== exact) || (!['if', 'not', 'is_null', 'not_null'].includes(node.op) && !node.args.length) || (node.op === 'round' && node.args.length > 2)) throw new Error(`${node.op} 运算参数个数无效`)
      node.args.forEach(arg => validate(arg, depth + 1)); return
    }
    if (keys.length !== 1) throw new Error('表达式只允许 field、param、const 或白名单运算符节点')
    const kind = keys[0]
    if (kind === 'field' || kind === 'param') { if (typeof node[kind] !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(node[kind])) throw new Error(`${kind} 引用名称无效`) }
    else if (kind === 'const') validate(node.const, depth + 1)
    else throw new Error('表达式只允许 field、param、const 或白名单运算符节点')
  }
  const visit = (node, depth = 0) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
    if (Object.hasOwn(node, 'const')) return node.const
    if (Object.hasOwn(node, 'field')) return Object.hasOwn(input, node.field) ? input[node.field] : null
    if (Object.hasOwn(node, 'param')) return Object.hasOwn(parameters, node.param) ? parameters[node.param] : null
    const { op, args = [] } = node
    if (!operators.has(op)) throw new Error(`不支持的表达式运算符：${String(op)}`)
    if (op === 'if') return visit(args[0], depth + 1) ? visit(args[1], depth + 1) : visit(args[2], depth + 1)
    if (op === 'and') return args.every(arg => Boolean(visit(arg, depth + 1)))
    if (op === 'or') return args.some(arg => Boolean(visit(arg, depth + 1)))
    if (op === 'not') return !Boolean(visit(args[0], depth + 1))
    if (op === 'is_null') { const value = visit(args[0], depth + 1); return value == null || value === '' }
    if (op === 'not_null') { const value = visit(args[0], depth + 1); return value != null && value !== '' }
    const values = args.map(arg => visit(arg, depth + 1))
    if (op === 'coalesce') return values.find(value => value != null) ?? null
    const nums = () => values.map(value => {
      if (value == null || value === '') return null
      const number = Number(value)
      if (!Number.isFinite(number)) throw new Error(`${op} 运算需要有限数字`)
      return number
    })
    const ns = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'competition_rank'].includes(op) ? null : nums()
    let result
    if (op === 'add') result = ns.every(v => v != null) ? ns.reduce((a, b) => a + b, 0) : null
    else if (op === 'subtract') result = ns.length === 2 && ns.every(v => v != null) ? ns[0] - ns[1] : null
    else if (op === 'multiply') result = ns.every(v => v != null) ? ns.reduce((a, b) => a * b, 1) : null
    else if (op === 'divide') result = ns.length === 2 && ns.every(v => v != null) && ns[1] !== 0 ? ns[0] / ns[1] : null
    else if (op === 'abs') result = ns[0] == null ? null : Math.abs(ns[0])
    else if (op === 'min') result = ns.every(v => v != null) ? Math.min(...ns) : null
    else if (op === 'max') result = ns.every(v => v != null) ? Math.max(...ns) : null
    else if (op === 'sum' || op === 'cumulative') result = ns.every(v => v != null) ? ns.reduce((a, b) => a + b, 0) : null
    else if (op === 'average') result = ns.every(v => v != null) ? ns.reduce((a, b) => a + b, 0) / ns.length : null
    else if (op === 'round') {
      const precision = ns[1] ?? 0
      result = ns[0] == null || !Number.isInteger(precision) || precision < 0 || precision > 12 ? null : Math.round((ns[0] + Number.EPSILON) * 10 ** precision) / 10 ** precision
    } else if (op === 'eq') result = values[0] === values[1]
    else if (op === 'ne') result = values[0] !== values[1]
    else if (op === 'gt') result = values[0] != null && values[1] != null && values[0] > values[1]
    else if (op === 'gte') result = values[0] != null && values[1] != null && values[0] >= values[1]
    else if (op === 'lt') result = values[0] != null && values[1] != null && values[0] < values[1]
    else if (op === 'lte') result = values[0] != null && values[1] != null && values[0] <= values[1]
    else if (op === 'completion_rate') result = ns.length === 2 && ns.every(v => v != null) && ns[1] !== 0 ? ns[0] / ns[1] : null
    else if (op === 'control_loss') result = ns.length === 2 && ns.every(v => v != null) && ns[1] !== 0 ? 2 - ns[0] / ns[1] : null
    else if (op === 'weighted_score') result = ns.length === 2 && ns.every(v => v != null) ? ns[0] * ns[1] : null
    else if (op === 'score_completion') result = ns.length === 3 && ns.every(v => v != null) && ns[1] !== 0 ? Math.min(Math.max(ns[0] / ns[1], 0), 1) * ns[2] : null
    else if (op === 'competition_rank') {
      const target = values[1] == null ? null : Number(values[1])
      result = Array.isArray(values[0]) && Number.isFinite(target) ? 1 + values[0].filter(score => score != null && Number.isFinite(Number(score)) && Number(score) > target).length : null
    } else throw new Error(`不支持的表达式运算符：${op}`)
    if (typeof result === 'number' && !Number.isFinite(result)) throw new Error('表达式结果不是有限数字')
    return result
  }
  nodeCount = 0
  validate(expression)
  nodeCount = 0
  return visit(expression)
}
