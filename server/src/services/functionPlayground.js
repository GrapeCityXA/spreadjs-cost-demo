const { chromium } = require('playwright');
const path = require('node:path');
const { readEvaluateSignature } = require('./functionSignature');
const { readLocalSpreadjsLicense } = require('../config/localSpreadjsLicense.cjs');

const CASE_TIMEOUT = 2000;
const SDK = path.resolve(__dirname, '../../../node_modules/@grapecity-software/spread-sheets/dist/gc.spread.sheets.all.min.js');
const POLICY = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

function validateRequest(body) {
  if (!body || typeof body.code !== 'string' || !body.code.trim() || body.code.length > 50000) throw new Error('代码不能为空且不能超过 50,000 字符');
  if (body.mode === 'workbook') {
    if (!Array.isArray(body.cells) || body.cells.length > 300) throw new Error('试算表最多 30 行 × 10 列');
    const positions = new Set();
    const cells = body.cells.map(cell => {
      if (!cell || !Number.isInteger(cell.row) || !Number.isInteger(cell.col) || cell.row < 0 || cell.row >= 30 || cell.col < 0 || cell.col >= 10) throw new Error('试算单元格位置无效');
      const key = `${cell.row}:${cell.col}`;
      if (positions.has(key)) throw new Error('试算单元格重复');
      positions.add(key);
      if (cell.formula != null && (typeof cell.formula !== 'string' || cell.formula.length > 2000)) throw new Error('公式不能超过 2,000 字符');
      if (cell.value != null && !['string', 'number', 'boolean'].includes(typeof cell.value)) throw new Error('单元格值须为数字、文本或布尔值');
      if (typeof cell.value === 'string' && cell.value.length > 10000) throw new Error('单元格文本过长');
      return { row: cell.row, col: cell.col, formula: cell.formula || '', value: cell.value ?? null };
    });
    return { mode: 'workbook', code: body.code, cells, initializeExample: body.initializeExample === true && cells.length === 0 };
  }
  throw new Error('仅支持 SpreadJS 工作簿试算');
}

// Real registration and dependency calculation happen only in the disposable
// browser. Return scalar cell values, never executable JSON or user-defined types.
function evaluateWorkbook({ code, cells, signature, initializeExample }) {
  let phase = 'compile', book;
  const started = performance.now();
  try {
    const create = new Function('GC', '"use strict";\n' + code + '\n;return new ' + signature.className + '();\n//# sourceURL=playground-function.js');
    phase = 'execute';
    const fn = create(GC);
    if (!(fn instanceof GC.Spread.CalcEngine.Functions.Function)) throw new TypeError('入口类必须继承 SpreadJS Function');
    const parameters = signature.parameters.slice(fn.isContextSensitive() ? 1 : 0);
    let minArgs = 0;
    parameters.forEach((param, index) => { if (!param.optional && !param.rest) minArgs = index + 1; });
    const rest = parameters.some(param => param.rest);
    // Bound variadic formulas in this playground; the SDK constructor does not
    // supply a usable default argument limit when only a name is passed.
    const maxArgs = rest ? 255 : parameters.length;
    fn.minArgs = minArgs; fn.maxArgs = maxArgs;
    const acceptsMissing = fn.acceptsMissingArgument.bind(fn);
    fn.acceptsMissingArgument = index => Boolean(parameters[index]?.optional) || acceptsMissing(index);
    const argumentInfo = { parameters, minArgs, maxArgs, rest };
    const exampleCount = rest ? Math.min(maxArgs, parameters.length + 1) : parameters.length;
    const exampleFormula = `=${fn.name}(${Array.from({ length: exampleCount }, (_, index) => String((index + 1) * 10)).join(',')})`;
    const seededCell = initializeExample ? { row: 0, col: 0, formula: exampleFormula } : null;
    if (seededCell) cells = [seededCell];
    const errors = [];
    const original = fn.evaluate;
    fn.evaluate = function (...args) {
      try {
        const result = original.apply(this, args);
        if (result && typeof result.then === 'function') throw new TypeError('暂不支持 Promise / 异步自定义函数');
        return result;
      } catch (error) { errors.push(String(error?.message || error).slice(0, 2000)); throw error; }
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    book = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1, calculationMode: GC.Spread.Sheets.CalculationMode.manual });
    book.options.allowDynamicArray = true;
    const sheet = book.getActiveSheet(); sheet.name('试算'); sheet.setRowCount(30); sheet.setColumnCount(10);
    book.suspendCalcService();
    sheet.addCustomFunction(fn);
    for (const cell of cells) if (!cell.formula) sheet.setValue(cell.row, cell.col, cell.value);
    for (const cell of cells) if (cell.formula) {
      try { sheet.setFormula(cell.row, cell.col, cell.formula); }
      catch (error) {
        // A previous formula may no longer match the edited evaluate signature.
        // Keep other cells usable and return the new signature/example as well.
        sheet.setFormula(cell.row, cell.col, 'VALUE("Invalid Formula")');
        errors.push(`${String.fromCharCode(65 + cell.col)}${cell.row + 1}：${String(error?.message || error).slice(0, 2000)}`);
      }
    }
    book.resumeCalcService(false);
    book.calculate();
    const values = [];
    for (let row = 0; row < 30; row++) for (let col = 0; col < 10; col++) {
      const value = sheet.getValue(row, col);
      const displayValue = value == null ? null : ['string', 'number', 'boolean'].includes(typeof value) ? value : sheet.getText(row, col);
      if (typeof displayValue === 'string' && displayValue.length > 20000) throw new RangeError('单元格输出超过 20,000 字符');
      values.push({ row, col, value: displayValue });
    }
    return { mode: 'workbook', functionName: String(fn.name).slice(0, 255), argumentInfo, exampleFormula, seededCell, values, errors: [...new Set(errors)], durationMs: performance.now() - started };
  } catch (error) {
    return { mode: 'workbook', status: phase === 'compile' && error?.name === 'SyntaxError' ? 'Syntax Error' : 'Runtime Error', error: String(error?.message || error).slice(0, 2000) };
  } finally { book?.destroy(); }
}

function bounded(promise, milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('运行已停止'), { name: 'AbortError' }));
    const timer = setTimeout(() => reject(Object.assign(new Error(`执行超过 ${milliseconds / 1000} 秒，运行环境已终止`), { name: 'TimeoutError' })), milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
  });
}

async function runPlayground(payload, signal) {
  let signature;
  try { signature = readEvaluateSignature(payload.code); }
  catch (error) { return { mode: 'workbook', status: error.name === 'SyntaxError' ? 'Syntax Error' : 'Runtime Error', error: error.message }; }
  try { return await runIsolated(evaluateWorkbook, { ...payload, signature }, signal); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    return { mode: 'workbook', status: error.name === 'TimeoutError' ? 'Time Limit Exceeded' : 'Runtime Error', error: error.message.slice(0, 2000) };
  }
}

async function runIsolated(evaluate, payload, signal) {
  let browserServer;
  try {
    // Fresh browser profile, no inherited application tokens or server secrets.
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'HOME', 'DISPLAY'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    browserServer = await chromium.launchServer({ headless: true, chromiumSandbox: true, timeout: 10000, env });
    if (signal?.aborted) throw Object.assign(new Error('运行已停止'), { name: 'AbortError' });
    const browser = await bounded(chromium.connect(browserServer.wsEndpoint()), 5000, signal);
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    async function createFrame() {
      await bounded(page.setContent('<iframe sandbox="allow-scripts"></iframe>'), 3000, signal);
      await bounded(page.locator('iframe').evaluate((el, policy) => { el.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${policy}"><div></div>`; }, POLICY), 3000, signal);
      const frame = await page.locator('iframe').elementHandle().then(handle => handle.contentFrame());
      await bounded(frame.waitForLoadState(), 3000, signal);
      await bounded(frame.addScriptTag({ path: SDK }), 5000, signal);
      const spreadjsLicense = readLocalSpreadjsLicense().spreadjsLICENSE;
      if (!spreadjsLicense) throw new Error('缺少 SPREADJS_LICENSE 环境变量');
      await bounded(frame.evaluate(key => { GC.Spread.Sheets.LicenseKey = key; }, spreadjsLicense), 2000, signal);
      return frame;
    }
    const frame = await createFrame();
    return await bounded(frame.evaluate(evaluate, payload), CASE_TIMEOUT, signal);
  } finally {
    // kill() terminates even a renderer stuck in an infinite JavaScript loop.
    if (browserServer) await browserServer.kill();
  }
}

module.exports = { validateRequest, runPlayground, runIsolated };
