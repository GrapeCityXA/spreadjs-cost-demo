const { readBoundValue } = require('./bindingSource');
// SpreadJS 19.1.4 collaborative formulas use refs/parts, not cached values.
// Deliberately limited to ordinary scalar formulas; never execute formula text as JS.
const FUNCTIONS = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'PRODUCT', 'ABS', 'ROUND', 'IF', 'IFERROR', 'AND', 'OR', 'NOT']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const invalid = () => { throw new Error('用户公式格式无效或含未支持的函数、引用'); };
const columnName = column => { let text = ''; for (let n = column + 1; n; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + (n - 1) % 26) + text; return text; };

function decodeNativeFormula(info, snapshot, sheetId, customFunctions = new Set()) {
  if (!keys(info, ['refs', 'parts']) || !object(info.refs) || !Array.isArray(info.parts)
    || !info.parts.length || info.parts.length > 2048) invalid();
  const references = new Map();
  const tokens = [];
  let formula = '';
  for (const part of info.parts) {
    if (!object(part) || Object.keys(part).length !== 1) invalid();
    if (typeof part.text === 'string') {
      formula += part.text;
      let rest = part.text;
      while (rest.length) {
        const match = /^\s+|^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|^"(?:[^"]|"")*"|^[A-Za-z_][A-Za-z0-9_.]*|^(?:<=|>=|<>|[+\-*/^%(),=<>])/.exec(rest);
        if (!match) invalid();
        rest = rest.slice(match[0].length);
        if (match[0].trim()) tokens.push(match[0]);
      }
    } else if (typeof part.ref === 'string' && Object.hasOwn(info.refs, part.ref)) {
      const ref = info.refs[part.ref];
      if (!keys(ref, ['type', 'sheetId', 'row', 'col', 'endRow', 'endCol', 'flags']) || ref.type !== 0
        || !Number.isSafeInteger(ref.flags) || ref.flags < 0 || (ref.flags & ~30) !== 0
        || ![ref.row, ref.col].every(n => Number.isSafeInteger(n) && n >= 0)
        || (Object.hasOwn(ref, 'endRow') !== Object.hasOwn(ref, 'endCol'))) invalid();
      const id = ref.sheetId || sheetId;
      const sheet = snapshot?.sheets?.[id];
      const endRow = ref.endRow ?? ref.row, endCol = ref.endCol ?? ref.col;
      if (!sheet || ![endRow, endCol].every(Number.isSafeInteger) || endRow < ref.row || endCol < ref.col
        || endRow >= sheet.rowCount || endCol >= sheet.columnCount
        || (endRow - ref.row + 1) * (endCol - ref.col + 1) > 10000) invalid();
      const reference = { sheetId: id, row: ref.row, col: ref.col, endRow, endCol };
      references.set(part.ref, reference);
      tokens.push(reference);
      const cell = (row, col, rowBit, colBit) => `${ref.flags & colBit ? '' : '$'}${columnName(col)}${ref.flags & rowBit ? '' : '$'}${row + 1}`;
      formula += (ref.sheetId ? `'${String(sheet.name).replace(/'/g, "''")}'!` : '')
        + cell(ref.row, ref.col, 2, 4)
        + (ref.endRow == null ? '' : `:${cell(endRow, endCol, 8, 16)}`);
    } else invalid();
    if (formula.length > 8192 || tokens.length > 4096) invalid();
  }
  if (!formula.trim() || Object.keys(info.refs).some(key => !references.has(key))) invalid();
  let position = 0, depth = 0;
  const precedence = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '+': 2, '-': 2, '*': 3, '/': 3, '^': 4 };
  function expression(min = 0) {
    if (++depth > 100) invalid();
    let token = tokens[position++], node;
    if (object(token)) node = { reference: token };
    else if (token === '+' || token === '-') node = { unary: token, child: expression(5) };
    else if (token === '(') { node = expression(); if (tokens[position++] !== ')') invalid(); }
    else if (typeof token === 'string' && /^(?:\d|\.\d)/.test(token)) node = { value: Number(token) };
    else if (typeof token === 'string' && token.startsWith('"')) node = { value: token.slice(1, -1).replace(/""/g, '"') };
    else if (/^(TRUE|FALSE)$/i.test(token)) node = { value: token.toUpperCase() === 'TRUE' };
    else {
      const name = typeof token === 'string' ? token.toUpperCase() : '';
      if ((!FUNCTIONS.has(name) && !customFunctions.has(name)) || tokens[position++] !== '(') invalid();
      const args = [];
      if (tokens[position] !== ')') {
        do { args.push(customFunctions.has(name) && [',', ')'].includes(tokens[position]) ? { value: undefined } : expression()); } while (tokens[position] === ',' && ++position);
      }
      if (tokens[position++] !== ')' || !args.length && !customFunctions.has(name)) invalid();
      if (['ABS', 'NOT'].includes(name) && args.length !== 1 || name === 'ROUND' && args.length !== 2 || name === 'IF' && args.length !== 3 || name === 'IFERROR' && args.length !== 2) invalid();
      node = { name, args };
    }
    while (position < tokens.length) {
      if (tokens[position] === '%') { position++; node = { unary: '%', child: node }; continue; }
      const op = tokens[position], weight = precedence[op];
      if (weight == null || weight < min) break;
      position++; node = { op, left: node, right: expression(weight + 1) };
    }
    depth--;
    return node;
  }
  const ast = expression();
  if (position !== tokens.length) invalid();
  return { formula, references: [...references.values()], ast };
}

function createSnapshotReader(snapshot, calculatedValues = {}) {
  const cache = new Map(), visiting = new Set();
  let remaining = 100000;
  function number(value) { if (Array.isArray(value)) throw new Error('用户公式必须返回单个值'); const n = Number(value ?? 0); if (!Number.isFinite(n)) throw new Error('用户公式含非数值输入'); return n; }
  function evaluate(node, depth = 0) {
    if (--remaining < 0 || depth > 100) throw new Error('用户公式计算范围过大');
    const next = item => { const value = evaluate(item, depth + 1); if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('用户公式计算错误'); return value; };
    if (Object.hasOwn(node, 'value')) return node.value;
    if (node.reference) {
      const ref = node.reference, values = [];
      for (let row = ref.row; row <= ref.endRow; row++) for (let col = ref.col; col <= ref.endCol; col++) values.push(read(ref.sheetId, row, col).value);
      return values.length === 1 ? values[0] : values;
    }
    if (node.unary) { const n = number(next(node.child)); return node.unary === '-' ? -n : node.unary === '%' ? n / 100 : n; }
    if (node.op) {
      const left = next(node.left), right = next(node.right);
      if (['=', '<>', '<', '>', '<=', '>='].includes(node.op) && [left, right].some(value => typeof value === 'string' || typeof value === 'boolean')) throw new Error('用户公式当前仅支持数值比较');
      const a = number(left), b = number(right);
      switch (node.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '^': return a ** b;
        case '=': return a === b; case '<>': return a !== b; case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
      }
    }
    if (node.name === 'IFERROR') {
      try { return next(node.args[0]); }
      catch (error) {
        // Resource and reference-safety failures must not be hidden by IFERROR.
        if (/计算范围过大|循环引用|依赖过深/.test(error.message)) throw error;
        return next(node.args[1]);
      }
    }
    if (node.name === 'IF') { const condition = next(node.args[0]); if (Array.isArray(condition) || typeof condition === 'string') throw new Error('用户公式条件必须为数值或布尔值'); return next(node.args[condition ? 1 : 2]); }
    const args = node.args.map(next);
    const values = args.flat();
    const numeric = args.flatMap((value, index) => {
      if (node.args[index].reference) return [value].flat().filter(item => typeof item === 'number');
      if (['SUM', 'AVERAGE', 'MIN', 'MAX', 'PRODUCT'].includes(node.name)
        && [value].flat().some(item => typeof item === 'string' && (item.trim() === '' || !Number.isFinite(Number(item))))) throw new Error('用户公式含非数值参数');
      return [value].flat().map(item => typeof item === 'boolean' || typeof item === 'string' && item.trim() !== '' && Number.isFinite(Number(item)) ? Number(item) : item)
        .filter(item => typeof item === 'number');
    });
    switch (node.name) {
      case 'SUM': return numeric.reduce((a, b) => a + b, 0);
      case 'PRODUCT': return numeric.length ? numeric.reduce((a, b) => a * b, 1) : 0;
      case 'AVERAGE': return numeric.reduce((a, b) => a + b, 0) / numeric.length;
      case 'MIN': return numeric.length ? Math.min(...numeric) : 0;
      case 'MAX': return numeric.length ? Math.max(...numeric) : 0;
      case 'COUNT': return numeric.length;
      case 'COUNTA': return values.filter(value => value != null).length;
      case 'ABS': return Math.abs(number(values[0]));
      case 'ROUND': { const n = number(values[0]), digits = Math.trunc(number(values[1])); if (Math.abs(digits) > 100) invalid(); const scale = 10 ** digits; return Math.sign(n) * Math.round(Math.abs(n) * scale + Number.EPSILON) / scale; }
      case 'AND': case 'OR': { const logical = args.flatMap((value, index) => [value].flat().filter(item => node.args[index].reference ? typeof item === 'number' || typeof item === 'boolean' : true)); if (!logical.length || logical.some(item => !['number', 'boolean'].includes(typeof item))) throw new Error('用户公式逻辑参数无效'); return node.name === 'AND' ? logical.every(Boolean) : logical.some(Boolean); }
      case 'NOT': if (!['number', 'boolean'].includes(typeof values[0])) throw new Error('用户公式逻辑参数无效'); return !values[0];
      default: invalid();
    }
  }
  function read(sheetId, row, col) {
    if (--remaining < 0) throw new Error('用户公式计算范围过大');
    const key = `${sheetId}:${row}:${col}`;
    if (cache.has(key)) return cache.get(key);
    if (Object.hasOwn(calculatedValues, key)) return calculatedValues[key];
    if (visiting.has(key) || visiting.size > 100) throw new Error('用户公式包含循环引用或依赖过深');
    const cell = snapshot?.sheets?.[sheetId]?.data?.dataTable?.[row]?.[col] || {};
    // A formula-bound cell carries both formulaInfo and bindingPath. The formula
    // is authoritative; the bound value is only the input/cache for the cell.
    // Reading bindingPath first silently turns formulas such as SUM(A1:A3) into
    // their stale cached value during submission and report generation.
    if (!cell.formulaInfo?.parts) {
      if (cell.bindingPath) return { value: readBoundValue(snapshot, snapshot.sheets[sheetId], cell.bindingPath), formula: null };
      return { value: cell.value ?? cell.text ?? null, formula: cell.formulaInfo?.formula || null };
    }
    visiting.add(key);
    try {
      const decoded = decodeNativeFormula(cell.formulaInfo, snapshot, sheetId);
      const value = evaluate(decoded.ast);
      if (Array.isArray(value) || typeof value === 'number' && !Number.isFinite(value)) throw new Error('用户公式计算错误或返回数组');
      const result = { value, formula: decoded.formula };
      cache.set(key, result);
      return result;
    } finally { visiting.delete(key); }
  }
  return { read };
}

module.exports = { decodeNativeFormula, createSnapshotReader };
