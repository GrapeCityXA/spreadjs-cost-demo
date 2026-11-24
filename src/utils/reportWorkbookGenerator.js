import GC from '@grapecity-software/spread-sheets'
import '@grapecity-software/spread-sheets-shapes'
import '@grapecity-software/spread-sheets-charts'
import '@grapecity-software/spread-sheets-print'
import '@grapecity-software/spread-sheets-tablesheet'
import '@grapecity-software/spread-sheets-datacharts-addon'
import '@grapecity-software/spread-sheets-reportsheet-addon'
import { ensureSpreadIo } from '@/utils/spreadIo'
import { ensureSpreadPdfExport } from '@/utils/spreadPdfFonts'
import { prepareReportSources } from '@/utils/reportSourceMerge'

const HOST_STYLE = 'position:fixed;left:-20000px;top:0;width:1100px;height:750px;overflow:hidden;opacity:0;pointer-events:none'

function exportExcel(workbook) {
  const S = GC.Spread.Sheets
  return new Promise((resolve, reject) => workbook.export(resolve, reject, {
    fileType: S.FileType.excel, includeFormulas: true, includeStyles: true,
  }))
}

/**
 * Render a report from the payload returned by POST /report-studio/render-data.
 * The SpreadJS workbook lives in an offscreen host and is destroyed in finally.
 */
export async function generateReportInBrowser(payload, onStage = () => {}) {
  const { template, rows, tables, parameters, sources, sourceWorkbooks } = payload || {}
  if (!template || !Array.isArray(template.sheets)) throw new Error('报表模板内容不完整')
  const S = GC.Spread.Sheets
  const host = document.createElement('div')
  host.dataset.reportGeneratorHost = 'true'
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = HOST_STYLE
  document.body.appendChild(host)
  let book, output
  try {
    onStage('加载报表引擎')
    await Promise.all([ensureSpreadIo(), ensureSpreadPdfExport(GC)])
    onStage('渲染报表')
    book = new S.Workbook(host, { sheetCount: 0 })
    const manager = book.dataManager()
    if (tables?.length) {
      for (const table of tables) {
        const created = manager.addTable(table.name, {
          data: table.rows, schema: { columns: table.schema?.columns || table.columns || {} },
        })
        if (created?.fetch) await created.fetch()
      }
      const columnName = (table, key) => table.columns.find(column => column.key === key)?.bindingName || key
      const master = tables.find(table => table.kind === 'master')
      if (master) for (const table of tables.filter(table => table.kind === 'detail')) {
        manager.addRelationship(manager.tables[table.name], columnName(table, 'revisionId'), 'master',
          manager.tables[master.name], columnName(master, 'revisionId'), table.name)
      }
    } else {
      const created = manager.addTable('ReportData', { data: rows })
      if (created?.fetch) await created.fetch()
    }

    for (const definition of template.sheets) {
      const report = book.addSheetTab(book.getSheetTabCount(), definition.name, S.SheetType.reportSheet)
      if (!report) throw new Error('当前 SpreadJS 许可证未能启用 ReportSheet，请更新 SPREADJS_LICENSE 环境变量')
      await report.loadTemplateAsync(definition.json)
      await report.setRenderModeAsync('Design')
      const design = report.getTemplate()
      // Preserve formulas in static cells when the workbook is exported to XLSX.
      for (const [row, cells] of Object.entries(definition.json?.data?.dataTable || {})) {
        for (const [col, cell] of Object.entries(cells)) {
          if (!cell.formula) continue
          const settings = design.getTemplateCell(Number(row), Number(col))
          if (!settings || settings.type === 'Static') design.setTemplateCell(Number(row), Number(col), {
            ...settings, type: 'Static', preserveFormulaInExport: true,
          })
        }
      }
      report.parameter(parameters)
      await report.setRenderModeAsync('Preview')
    }

    onStage('导出 Excel 与 PDF')
    const reportFile = await exportExcel(book)
    output = new S.Workbook(document.createElement('div'), { sheetCount: 0 })
    await new Promise((resolve, reject) => output.import(new File([reportFile], 'report.xlsx'), resolve, reject, {
      fileType: S.FileType.excel, includeFormulas: true, includeStyles: true, includeUnusedStyles: true, fullRecalc: false,
    }))
    const pdf = await new Promise((resolve, reject) => output.savePDF(resolve, reject))
    const prepared = prepareReportSources(sources, sourceWorkbooks, output.sheets.map(sheet => sheet.name()),
      output.sheets.flatMap(sheet => sheet.tables.all().map(table => table.name())))
    const combined = output.toJSON({ includeBindingSource: false })
    for (const source of prepared) {
      source.json.index = combined.sheetCount++
      combined.sheets[source.name] = source.json
    }
    combined.calculationMode = S.CalculationMode.manual
    output.fromJSON(combined, { doNotRecalculateAfterLoad: true })
    const json = output.toJSON({ includeBindingSource: false })
    json.reportSourceFormulas = { version: 1, frozen: true,
      sheets: prepared.map(({ json: sheetJson, ...source }) => source) }
    const xlsx = await exportExcel(output)
    const workbookBlob = new Blob([JSON.stringify(json)], { type: 'application/json' })
    return { workbookJson: json, workbookBlob, xlsxBlob: xlsx, pdfBlob: pdf }
  } finally {
    try { output?.destroy() } catch { /* ignore cleanup errors */ }
    try { book?.destroy() } catch { /* ignore cleanup errors */ }
    host.remove()
  }
}
