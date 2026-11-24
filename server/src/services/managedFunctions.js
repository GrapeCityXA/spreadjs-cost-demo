const { readEvaluateSignature, readFunctionIdentity } = require('./functionSignature');
const { runIsolated } = require('./functionPlayground');
const isManagedFunction = value => value?.engine === 'spreadjs-function' && value.schemaVersion === 1;
const invalid = message => Object.assign(new Error(message), { status: 400 });

function validateDefinition(value) {
  if (!isManagedFunction(value) || typeof value.sourceCode !== 'string' || !value.sourceCode.trim() || value.sourceCode.length > 50000) throw invalid('自定义函数源码不能为空且不能超过 50,000 字符');
  try { readEvaluateSignature(value.sourceCode); } catch (error) { throw invalid(error.message); }
  if (JSON.stringify(value).length > 80000) throw invalid('自定义函数定义不能超过 80 KB');
}

// This callback runs only in the disposable Chromium iframe, never in Node or
// the authenticated application page. JSON stores code text and inert state.
function evaluateManaged({ definitions, calls, inspect, sheets }) {
  const classes = new Map(), instances = new Map();
  function plain(value, depth = 0) {
    if (depth > 30) throw Error('实例属性层级过深');
    if (value === null || ['string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || ![Object.prototype, Array.prototype].includes(Object.getPrototypeOf(value))) throw Error('toJSON 只能返回普通 JSON 数据');
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('实例属性名称无效');
      plain(child, depth + 1);
    }
  }
  function serialize(fn) {
    if (typeof fn.typeName !== 'string' || !/^[A-Za-z_][\w.]{1,159}$/.test(fn.typeName)) throw Error('请设置有效的 typeName，例如 CustomFunctions.MyFunction');
    if (typeof fn.toJSON !== 'function' || typeof fn.fromJSON !== 'function') throw Error('请实现 toJSON() 和 fromJSON(settings)');
    const state = fn.toJSON(); plain(state);
    if (!state || Array.isArray(state) || state.typeName !== fn.typeName) throw Error('toJSON() 必须返回包含当前 typeName 的对象');
    if (JSON.stringify(state).length > 8000) throw Error('函数实例属性不能超过 8 KB');
    return JSON.parse(JSON.stringify(state));
  }
  function create(definition, state) {
    let Constructor = classes.get(definition.id);
    if (!Constructor) {
      Constructor = new Function('GC', '"use strict";\n' + definition.sourceCode + '\n;return ' + definition.signature.className + ';')(GC);
      classes.set(definition.id, Constructor);
    }
    const fn = new Constructor();
    if (!(fn instanceof GC.Spread.CalcEngine.Functions.Function)) throw Error('入口类必须继承 SpreadJS Function');
    if (state != null) { plain(state); fn.fromJSON(JSON.parse(JSON.stringify(state))); }
    if (!/^[A-Z_][A-Z0-9_.]{1,63}$/i.test(fn.name)) throw Error('函数名须为 2–64 位英文、数字、下划线或点');
    if (fn.isContextSensitive() || fn.isBranch()) throw Error('可发布函数暂不支持工作表上下文或分支求值，请使用普通参数传值');
    const parameters = definition.signature.parameters;
    if (Array.from({ length: 255 }, (_, i) => fn.acceptsReference(i)).some(Boolean)) throw Error('可发布函数暂不支持引用对象，请通过普通参数或数组传值');
    fn.minArgs = parameters.reduce((min, p, i) => !p.optional && !p.rest ? i + 1 : min, 0);
    fn.maxArgs = parameters.some(p => p.rest) ? 255 : parameters.length;
    const missing = fn.acceptsMissingArgument.bind(fn);
    fn.acceptsMissingArgument = index => Boolean(parameters[index]?.optional) || missing(index);
    return fn;
  }
  for (const definition of definitions) instances.set(definition.id, create(definition, definition.instanceState));
  if (inspect) {
    const definition = definitions[0], fn = instances.get(definition.id), state = serialize(fn);
    const restored = create(definition, state);
    if (JSON.stringify(serialize(restored)) !== JSON.stringify(state) || restored.name !== fn.name || restored.typeName !== fn.typeName) throw Error('fromJSON() 未能完整恢复 toJSON() 保存的实例属性');
    const originalResolver = GC.Spread.Sheets.getTypeFromString;
    GC.Spread.Sheets.getTypeFromString = function (name) { return name === fn.typeName ? classes.get(definition.id) : originalResolver.apply(this, arguments); };
    const a = new GC.Spread.Sheets.Workbook(document.createElement('div'));
    const b = new GC.Spread.Sheets.Workbook(document.createElement('div'));
    try { a.addCustomFunction(fn); b.fromJSON(JSON.parse(JSON.stringify(a.toJSON()))); }
    finally { a.destroy(); b.destroy(); GC.Spread.Sheets.getTypeFromString = originalResolver; }
    return { className: definition.signature.className, functionName: fn.name.toUpperCase(), typeName: fn.typeName, instanceState: state,
      minArgs: fn.minArgs, maxArgs: fn.maxArgs, parameters: definition.signature.parameters,
      acceptsArray: Array.from({ length: fn.maxArgs }, (_, i) => Boolean(fn.acceptsArray(i))),
      acceptsMissing: Array.from({ length: fn.maxArgs }, (_, i) => Boolean(fn.acceptsMissingArgument(i))) };
  }
  function output(value) {
    if (value == null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return { value: value ?? null };
    if (value instanceof GC.Spread.CalcEngine.CalcError) return { calcError: value.toString() };
    throw Error('可发布函数须返回标量或 SpreadJS 错误值');
  }
  if (sheets) {
    const book = new GC.Spread.Sheets.Workbook(document.createElement('div'), { sheetCount: sheets.length });
    try {
      book.suspendCalcService();
      for (const fn of instances.values()) book.addCustomFunction(fn);
      for (const [index, source] of sheets.entries()) {
        const sheet = book.getSheet(index); sheet.name(source.name); sheet.setRowCount(source.rowCount); sheet.setColumnCount(source.columnCount);
        for (const cell of source.cells) if (!cell.formula) sheet.setValue(cell.row, cell.col, cell.value);
      }
      for (const [index, source] of sheets.entries()) for (const cell of source.cells) if (cell.formula) book.getSheet(index).setFormula(cell.row, cell.col, cell.formula);
      book.resumeCalcService(false); book.calculate();
      return Object.fromEntries(sheets.flatMap((source, index) => source.cells.filter(c => c.formula).map(cell => [`${source.id}:${cell.row}:${cell.col}`, { ...output(book.getSheet(index).getValue(cell.row, cell.col)), formula: cell.formula }])));
    } finally { book.destroy(); }
  }
  return calls.map(call => {
    try {
      const definition = definitions.find(item => item.id === call.versionId), fn = create(definition, call.instanceState ?? definition.instanceState);
      if (call.args.length < fn.minArgs || call.args.length > fn.maxArgs) throw Error(`参数数量须为 ${fn.minArgs}–${fn.maxArgs}`);
      const args = call.args.map(arg => arg?.missing === true ? undefined : arg);
      return output(fn.evaluate(...args));
    } catch (error) { return { error: String(error?.message || error).slice(0, 2000) }; }
  });
}

async function inspectDefinition(expression, signal) {
  validateDefinition(expression);
  const metadata = await runIsolated(evaluateManaged, { inspect: true, definitions: [{ ...expression, id: 0, signature: readEvaluateSignature(expression.sourceCode) }] }, signal);
  const identity = readFunctionIdentity(expression.sourceCode, true);
  if (metadata.functionName !== identity.functionName || metadata.typeName !== identity.typeName) throw invalid('运行时函数名和 typeName 必须与声明保持一致，请勿动态修改名称');
  return { engine: 'spreadjs-function', schemaVersion: 1, sourceCode: expression.sourceCode, ...metadata };
}
async function executeDefinitions(definitions, { calls, sheets }, signal) {
  return runIsolated(evaluateManaged, { definitions: definitions.map(item => ({ ...item, signature: readEvaluateSignature(item.sourceCode) })), calls, sheets }, signal);
}

function collectFunctionRefs(source) {
  const found = new Map();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (/^CostReport\.Function_\d+$/.test(value.typeName || '')) {
      const id = Number(value.typeName.split('_').pop());
      if (value.versionId !== id || !value.instanceState || JSON.stringify(value.instanceState).length > 8000) throw invalid('模板自定义函数引用无效');
      const previous = found.get(id);
      if (previous && JSON.stringify(previous.instanceState) !== JSON.stringify(value.instanceState)) throw invalid('同一模板中的同版本函数实例属性必须一致');
      found.set(id, value);
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(source); return [...found.values()];
}
async function loadPublishedDefinitions(ids) {
  if (!ids.length) return [];
  const db = require('../config/database');
  const rows = await new Promise((resolve, reject) => db.all(`SELECT id, expression_json FROM rule_versions WHERE status = 'published' AND id IN (${ids.map(() => '?').join(',')})`, ids, (error, rows) => error ? reject(error) : resolve(rows)));
  const definitions = rows.map(row => ({ ...JSON.parse(row.expression_json), id: row.id }));
  if (definitions.length !== new Set(ids).size || definitions.some(item => !isManagedFunction(item))) throw invalid('模板引用了不存在或未发布的自定义函数版本');
  return definitions;
}
async function templateDefinitions(workbook) {
  const refs = collectFunctionRefs(workbook), definitions = await loadPublishedDefinitions(refs.map(ref => ref.versionId));
  const names = new Set();
  return definitions.map(definition => {
    const ref = refs.find(ref => ref.versionId === definition.id);
    if (ref.name !== definition.functionName || ref.minArgs !== definition.minArgs || ref.maxArgs !== definition.maxArgs || ref.instanceState.typeName !== definition.typeName) throw invalid('模板中的函数声明与已发布版本不匹配');
    if (names.has(definition.functionName)) throw invalid(`同一模板不能同时使用 ${definition.functionName} 的多个版本`);
    names.add(definition.functionName);
    return { ...definition, instanceState: ref.instanceState };
  });
}

const calculatedSnapshots = new WeakMap();
async function calculateManagedSnapshot(workbook, snapshot) {
  const data = snapshot?.data || snapshot;
  if (!data || !collectFunctionRefs(workbook).length) return {};
  if (calculatedSnapshots.has(data)) return calculatedSnapshots.get(data);
  const task = (async () => {
    const definitions = await templateDefinitions(workbook);
    const names = new Set(definitions.map(item => item.functionName));
    const { decodeNativeFormula } = require('./nativeUserFormula');
    const { readBoundValue } = require('./bindingSource');
    const sheets = Object.entries(data.sheets || {}).sort(([, a], [, b]) => a.order - b.order).map(([id, sheet]) => ({
      id, name: sheet.name, rowCount: sheet.rowCount, columnCount: sheet.columnCount,
      cells: Object.entries(sheet.data?.dataTable || {}).flatMap(([row, columns]) => Object.entries(columns).map(([col, cell]) => ({
        row: Number(row), col: Number(col),
        ...(cell.formulaInfo?.parts ? { formula: decodeNativeFormula(cell.formulaInfo, data, id, names).formula }
          : cell.formulaInfo?.formula ? { formula: cell.formulaInfo.formula }
            : { value: cell.bindingPath ? readBoundValue(data, sheet, cell.bindingPath) : cell.value ?? null })
      })))
    }));
    const values = await executeDefinitions(definitions, { sheets });
    return Object.fromEntries(Object.entries(values).map(([key, result]) => [key, { value: result.calcError || result.value, formula: result.formula }]));
  })();
  calculatedSnapshots.set(data, task);
  try { return await task; } catch (error) { calculatedSnapshots.delete(data); throw error; }
}
module.exports = { isManagedFunction, validateDefinition, inspectDefinition, executeDefinitions, collectFunctionRefs, loadPublishedDefinitions, templateDefinitions, calculateManagedSnapshot };
