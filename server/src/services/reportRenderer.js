const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const { readLocalSpreadjsLicense } = require('../config/localSpreadjsLicense.cjs');
const { prepareReportSources } = require('./reportSourceWorkbook');
const root = path.resolve(__dirname, '../../..');
const packages = ['spread-sheets', 'spread-sheets-shapes', 'spread-sheets-charts', 'spread-sheets-print', 'spread-sheets-pdf', 'spread-sheets-io', 'spread-sheets-tablesheet', 'spread-sheets-datacharts-addon', 'spread-sheets-reportsheet-addon'];
const scripts = ['gc.spread.sheets.all.min.js', 'gc.spread.sheets.shapes.min.js', 'gc.spread.sheets.charts.min.js', 'gc.spread.sheets.print.min.js', 'gc.spread.sheets.pdf.min.js', 'gc.spread.sheets.io.min.js', 'gc.spread.sheets.tablesheet.min.js', 'gc.spread.sheets.datacharts.min.js', 'gc.spread.report.reportsheet.min.js'];

async function inReportBrowser(callback, payload, timeout = 90000, localEvaluation = false) {
  let server, timer;
  try {
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'HOME', 'DISPLAY'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    try {
      server = await chromium.launchServer({ headless: true, chromiumSandbox: true, timeout: 15000, env });
    } catch (error) {
      if (/Executable doesn't exist|download new browsers|playwright install/i.test(error.message || '')) {
        throw new Error('报表渲染组件缺少 Chromium 浏览器。请在 server 目录运行 npx playwright install chromium 后重试。');
      }
      throw error;
    }
    return await Promise.race([(async () => {
      const browser = await chromium.connect(server.wsEndpoint());
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url === 'http://127.0.0.1/report-renderer') return route.fulfill({ contentType: 'text/html', body: '<div id="report" style="width:1100px;height:750px"></div>' });
        // The job has already resolved permissions, parameters and effective revisions.
        // Serve that frozen dataset through a read-only endpoint inside this render context.
        const table = payload?.tables?.find(t => url === `http://127.0.0.1/report-data/${encodeURIComponent(t.name)}`);
        if (table && route.request().method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(table.rows) });
        return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', error => console.error('ReportSheet:', error.message));
      await page.goto('http://127.0.0.1/report-renderer');
      for (let i = 0; i < packages.length; i++) await page.addScriptTag({ path: path.join(root, 'node_modules/@grapecity-software', packages[i], 'dist', scripts[i]) });
      await page.addScriptTag({ path: path.join(root, 'node_modules/@grapecity-software/spread-sheets-collaboration-addon/dist/gc.spread.sheets.collaboration.min.js') });
      await page.addScriptTag({ path: path.join(root, 'node_modules/@grapecity-software/spread-sheets-collaboration-client/dist/index.js') });
      await page.addScriptTag({ content: `globalThis.prepareReportSources = ${prepareReportSources.toString()};` });
      // Explicit test-only local evaluation; the application always uses its configured license.
      const spreadjsLicense = localEvaluation ? '' : readLocalSpreadjsLicense().spreadjsLICENSE;
      if (!localEvaluation && !spreadjsLicense) throw new Error('缺少 SPREADJS_LICENSE 环境变量');
      await page.evaluate(key => { GC.Spread.Sheets.LicenseKey = key; }, spreadjsLicense);
      const font = await fs.readFile(path.join(root, 'server/assets/fonts/NotoSansSC-Regular.ttf'));
      await page.evaluate(base64 => {
        const data = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0)).buffer;
        const fonts = GC.Spread.Sheets.PDF.PDFFontsManager;
        fonts.registerFont('Noto Sans SC', { normal: data, bold: data }); fonts.fallbackFont = () => data;
      }, font.toString('base64'));
      return page.evaluate(callback, payload);
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('报表生成超过 90 秒，已终止；请缩小数据范围后重试')), timeout); })]);
  } finally { clearTimeout(timer); if (server) await server.kill(); }
}

async function renderReport(payload, localEvaluation = false) {
  return inReportBrowser(async ({ template, rows, tables, parameters, sources, sourceWorkbooks }) => {
    const S = GC.Spread.Sheets;
    const book = new S.Workbook(document.getElementById('report'), { sheetCount: 0 });
    const manager = book.dataManager();
    if (tables) {
      for (const table of tables) await manager.addTable(table.name, {
        remote: { read: { url: `http://127.0.0.1/report-data/${encodeURIComponent(table.name)}`, method: 'GET' } }, schema: table.schema,
      }).fetch();
      const columnName = (table, key) => table.columns.find(c => c.key === key)?.bindingName || key;
      for (const table of tables.filter(t => t.kind === 'detail')) manager.addRelationship(manager.tables[table.name], columnName(table, 'revisionId'), 'master', manager.tables.ReportData, columnName(tables.find(t => t.name === 'ReportData'), 'revisionId'), table.name);
    } else await manager.addTable('ReportData', { data: rows }).fetch();
    const exportExcel = workbook => new Promise((resolve, reject) => workbook.export(resolve, reject, {
      fileType: S.FileType.excel, includeFormulas: true, includeStyles: true,
    }));
    for (const definition of template.sheets) {
      const report = book.addSheetTab(book.getSheetTabCount(), definition.name, S.SheetType.reportSheet);
      if (!report) throw new Error('当前 SpreadJS 许可证未能启用 ReportSheet，请更新 SPREADJS_LICENSE 环境变量中的授权');
      await report.loadTemplateAsync(definition.json);
      await report.setRenderModeAsync('Design');
      const design = report.getTemplate();
      // Export preserves formulas only for Static template cells with this flag.
      // Walk stored cells rather than every cell of a potentially large worksheet.
      for (const [row, cells] of Object.entries(definition.json.data?.dataTable || {})) {
        for (const [col, cell] of Object.entries(cells)) {
          if (!cell.formula) continue;
          const settings = design.getTemplateCell(Number(row), Number(col));
          if (!settings || settings.type === 'Static') design.setTemplateCell(Number(row), Number(col), {
            ...settings, type: 'Static', preserveFormulaInExport: true,
          });
        }
      }
      report.parameter(parameters);
      await report.setRenderModeAsync('Preview');
    }
    // Import the entire XLSX into the destination workbook: workbook styles,
    // names and cross-sheet formula references must travel with the report sheets.
    const reportFile = await exportExcel(book);
    const output = new S.Workbook(document.createElement('div'), { sheetCount: 0 });
    await new Promise((resolve, reject) => output.import(new File([reportFile], 'report.xlsx'), resolve, reject, {
      fileType: S.FileType.excel, includeFormulas: true, includeStyles: true, includeUnusedStyles: true, fullRecalc: false,
    }));
    const blobData = blob => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
    // PDF contains the designed report. XLSX also preserves each submitted source sheet.
    const pdf = await new Promise((resolve, reject) => output.savePDF(blob => blobData(blob).then(resolve, reject), reject));
    const prepared = prepareReportSources(sources, sourceWorkbooks, output.sheets.map(sheet => sheet.name()),
      output.sheets.flatMap(sheet => sheet.tables.all().map(table => table.name())));
    const combined = output.toJSON({ includeBindingSource: false });
    for (const source of prepared) {
      source.json.index = combined.sheetCount++;
      combined.sheets[source.name] = source.json;
    }
    combined.calculationMode = S.CalculationMode.manual;
    output.fromJSON(combined, { doNotRecalculateAfterLoad: true });
    const json = output.toJSON({ includeBindingSource: false });
    json.reportSourceFormulas = { version: 1, frozen: true, sheets: prepared.map(({ json, ...source }) => source) };
    const xlsx = await blobData(await exportExcel(output));
    output.destroy(); book.destroy();
    return { json, xlsx, pdf };
  }, payload, 90000, localEvaluation);
}
module.exports = { renderReport, inReportBrowser };
