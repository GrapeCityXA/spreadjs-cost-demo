const ALLOWED_OPERATORS = new Set([
  'add', 'subtract', 'multiply', 'divide', 'abs', 'min', 'max', 'sum', 'average', 'round',
  'if', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'and', 'or', 'not', 'is_null', 'not_null', 'coalesce',
  'completion_rate', 'control_loss', 'cumulative', 'weighted_score', 'score_completion', 'competition_rank'
]);
const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }

function validateExpression(expression, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 500 || depth > 32) invalid('表达式过大或嵌套过深');
  if (expression === null || typeof expression === 'boolean') return;
  if (typeof expression === 'number') {
    if (!Number.isFinite(expression)) invalid('数值常量必须为有限数字');
    return;
  }
  if (typeof expression === 'string') {
    if (expression.length > 1000) invalid('字符串常量过长');
    return;
  }
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) invalid('表达式节点必须为 JSON 对象或基本值');
  const keys = Object.keys(expression);
  if (keys.includes('op')) {
    if (keys.some(key => !['op', 'args', 'value', 'name'].includes(key))) invalid('表达式包含未支持的属性');
    if (!ALLOWED_OPERATORS.has(expression.op)) invalid(`不支持的表达式运算符：${String(expression.op)}`);
    if (expression.op === 'if' && (!Array.isArray(expression.args) || expression.args.length !== 3)) invalid('if 运算符需要 3 个参数');
    if (['not', 'is_null', 'not_null'].includes(expression.op) && (!Array.isArray(expression.args) || expression.args.length !== 1)) invalid(`${expression.op} 运算符需要 1 个参数`);
    if (!['if', 'not', 'is_null', 'not_null'].includes(expression.op) && (!Array.isArray(expression.args) || expression.args.length === 0)) invalid(`${expression.op} 运算符至少需要 1 个参数`);
    const exactArity = { abs: 1, subtract: 2, divide: 2, eq: 2, ne: 2, gt: 2, gte: 2, lt: 2, lte: 2,
      completion_rate: 2, control_loss: 2, weighted_score: 2, score_completion: 3, competition_rank: 2 }[expression.op];
    if (exactArity != null && expression.args.length !== exactArity) invalid(`${expression.op} 运算符需要 ${exactArity} 个参数`);
    if (expression.op === 'round' && (expression.args.length < 1 || expression.args.length > 2)) invalid('round 需要 1 至 2 个参数');
    if (['if', 'not', 'is_null', 'not_null'].includes(expression.op)) expression.args.forEach(arg => validateExpression(arg, state, depth + 1));
    else (expression.args || []).forEach(arg => validateExpression(arg, state, depth + 1));
    if (expression.op === 'round' && expression.args?.length > 2) invalid('round 最多接受 2 个参数');
    return;
  }
  if (keys.length !== 1) invalid('表达式节点必须只包含一个字段引用、参数引用或常量');
  const [kind] = keys;
  if (kind === 'field' || kind === 'param') {
    if (typeof expression[kind] !== 'string' || !NAME.test(expression[kind])) invalid(`${kind} 引用名称无效`);
  } else if (kind === 'const') validateExpression(expression.const, state, depth + 1);
  else invalid('表达式只允许 field、param、const 或白名单运算符节点');
}

function finiteNumber(value, op) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return invalid(`${op} 运算需要有限数字`);
  return number;
}

function evaluateExpression(expression, input = {}, parameters = {}) {
  validateExpression(expression);
  function visit(node) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
    if (Object.prototype.hasOwnProperty.call(node, 'const')) return node.const;
    if (node.field) return Object.prototype.hasOwnProperty.call(input, node.field) ? input[node.field] : null;
    if (node.param) return Object.prototype.hasOwnProperty.call(parameters, node.param) ? parameters[node.param] : null;
    const { op, args } = node;
    if (op === 'if') return visit(args[0]) ? visit(args[1]) : visit(args[2]);
    if (op === 'and') return args.every(arg => Boolean(visit(arg)));
    if (op === 'or') return args.some(arg => Boolean(visit(arg)));
    if (op === 'not') return !Boolean(visit(args[0]));
    if (op === 'is_null') { const value = visit(args[0]); return value == null || value === ''; }
    if (op === 'not_null') { const value = visit(args[0]); return value != null && value !== ''; }
    if (op === 'coalesce') return args.map(visit).find(value => value !== null && value !== undefined) ?? null;
    const values = args.map(visit);
    const numbers = () => values.map(value => finiteNumber(value, op));
    const numberList = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'competition_rank'].includes(op) ? null : numbers();
    let result;
    switch (op) {
      case 'add': result = numberList.every(v => v !== null) ? numberList.reduce((a, b) => a + b, 0) : null; break;
      case 'subtract': result = numberList.length === 2 && numberList.every(v => v !== null) ? numberList[0] - numberList[1] : null; break;
      case 'multiply': result = numberList.every(v => v !== null) ? numberList.reduce((a, b) => a * b, 1) : null; break;
      case 'divide': result = numberList.length === 2 && numberList.every(v => v !== null) && numberList[1] !== 0 ? numberList[0] / numberList[1] : null; break;
      case 'abs': result = numberList[0] == null ? null : Math.abs(numberList[0]); break;
      case 'min': result = numberList.every(v => v !== null) ? Math.min(...numberList) : null; break;
      case 'max': result = numberList.every(v => v !== null) ? Math.max(...numberList) : null; break;
      case 'sum': case 'cumulative': result = numberList.every(v => v !== null) ? numberList.reduce((a, b) => a + b, 0) : null; break;
      case 'average': result = numberList.every(v => v !== null) ? numberList.reduce((a, b) => a + b, 0) / numberList.length : null; break;
      case 'round': {
        const value = numberList[0]; const precision = numberList[1] ?? 0;
        if (value == null || !Number.isInteger(precision) || precision < 0 || precision > 12) result = null;
        else { const scale = 10 ** precision; result = Math.round((value + Number.EPSILON) * scale) / scale; }
        break;
      }
      case 'eq': result = values[0] === values[1]; break;
      case 'ne': result = values[0] !== values[1]; break;
      case 'gt': result = values[0] != null && values[1] != null && values[0] > values[1]; break;
      case 'gte': result = values[0] != null && values[1] != null && values[0] >= values[1]; break;
      case 'lt': result = values[0] != null && values[1] != null && values[0] < values[1]; break;
      case 'lte': result = values[0] != null && values[1] != null && values[0] <= values[1]; break;
      case 'completion_rate': result = numberList.length === 2 && numberList.every(v => v !== null) && numberList[1] !== 0 ? numberList[0] / numberList[1] : null; break;
      case 'control_loss': result = numberList.length === 2 && numberList.every(v => v !== null) && numberList[1] !== 0 ? 2 - numberList[0] / numberList[1] : null; break;
      case 'weighted_score': result = numberList.length === 2 && numberList.every(v => v !== null) ? numberList[0] * numberList[1] : null; break;
      case 'score_completion': result = numberList.length === 3 && numberList.every(v => v !== null) && numberList[1] !== 0 ? Math.min(Math.max(numberList[0] / numberList[1], 0), 1) * numberList[2] : null; break;
      case 'competition_rank': {
        const scores = Array.isArray(values[0]) ? values[0] : null;
        const target = finiteNumber(values[1], op);
        result = scores && target !== null ? 1 + scores.filter(score => finiteNumber(score, op) > target).length : null;
        break;
      }
      default: invalid(`不支持的表达式运算符：${op}`);
    }
    if (typeof result === 'number' && !Number.isFinite(result)) invalid('表达式结果不是有限数字');
    return result;
  }
  return visit(expression);
}

function resultsEqual(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') return Number.isFinite(expected) && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(actual), Math.abs(expected));
  return JSON.stringify(actual) === JSON.stringify(expected);
}

module.exports = { ALLOWED_OPERATORS: [...ALLOWED_OPERATORS], validateExpression, evaluateExpression, resultsEqual };
