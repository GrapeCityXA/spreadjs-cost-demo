import GC from '@grapecity-software/spread-sheets'
import { collaborationApi } from '@/api'
import { registerTemplateFunctions } from '@/template/managedFunctions'
import { ensureSpreadPdfExport } from './spreadPdfFonts'
import { ensureSpreadIo } from './spreadIo'

// Export-only code: the report page loads this module after a download is requested.
function populatePdfWorkbook(spread, report, format) {
  const demoLabel = (report.source === 'DEMO_SYNTHETIC_ONLY') ? 'DEMO 合成数据，仅用于功能验证，不代表正式审批结果' : '数据来源：当前有效的已定稿月报修订'
  const headerStyle = new GC.Spread.Sheets.Style()
  headerStyle.font = 'bold 11px Microsoft YaHei'; headerStyle.foreColor = '#ffffff'; headerStyle.backColor = '#195e58'
  headerStyle.hAlign = GC.Spread.Sheets.HorizontalAlign.center
  const titleStyle = new GC.Spread.Sheets.Style()
  titleStyle.font = 'bold 18px Microsoft YaHei'; titleStyle.foreColor = '#15383a'; titleStyle.backColor = '#e5efeb'
  const totalStyle = new GC.Spread.Sheets.Style()
  totalStyle.font = 'bold 11px Microsoft YaHei'; totalStyle.backColor = '#e9f0eb'
  const setupPrint = (sheet, columnEnd, rowEnd, repeatHeaderEnd = 2) => {
    sheet.options.gridline = { showVerticalGridline: false, showHorizontalGridline: false }
    const printInfo = new GC.Spread.Sheets.Print.PrintInfo()
    printInfo.orientation(GC.Spread.Sheets.Print.PrintPageOrientation.landscape)
    printInfo.fitPagesWide(1); printInfo.showGridLine(false)
    printInfo.showRowHeader(GC.Spread.Sheets.Print.PrintVisibilityType.hide)
    printInfo.showColumnHeader(GC.Spread.Sheets.Print.PrintVisibilityType.hide)
    printInfo.rowStart(0); printInfo.rowEnd(rowEnd)
    printInfo.columnStart(0); printInfo.columnEnd(columnEnd)
    printInfo.repeatRowStart(0); printInfo.repeatRowEnd(repeatHeaderEnd)
    sheet.printInfo(printInfo)
  }
  for (const [index, metric] of format.metricDefinitions.entries()) {
    const sheet = spread.getSheet(index); sheet.name(`${metric.label}汇总`)
    sheet.setValue(0, 0, `${report.reportType.name} · ${report.periodCode} · ${metric.label}`)
    sheet.addSpan(0, 0, 1, 10)
    sheet.setValue(1, 0, demoLabel); sheet.addSpan(1, 0, 1, 10)
    sheet.setArray(2, 0, [['组织编码', '组织名称', '本月', '上年同月', '本年累计', '上年累计', '累计目标', '完成率', '同比', '完整度']])
    const body = report.rows.map(row => {
      const values = row.metrics[metric.key]
      return [row.organizationCode, row.organizationName, format.amount(values.currentMonth),
        format.amount(values.priorYearSameMonth), format.amount(values.currentYearToDate.value),
        format.amount(values.priorYearToDate.value), format.amount(values.cumulativeTarget),
        format.percent(values.cumulativeCompletionRate), format.percent(values.yearOverYearChange),
        `${values.currentYearToDate.monthsAvailable}/${values.currentYearToDate.monthsExpected}`]
    })
    if (body.length) sheet.setArray(3, 0, body)
    const totalRow = 3 + body.length
    const total = report.totals[metric.key]
    sheet.setArray(totalRow, 0, [[(report.source === 'DEMO_SYNTHETIC_ONLY') ? 'DEMO合计' : '合计', report.consolidationAvailable ? '配置范围合计' : '合并口径未核定', '', '',
      format.amount(total.currentYearToDate.value), format.amount(total.priorYearToDate.value),
      format.amount(total.cumulativeTarget), format.percent(total.cumulativeCompletionRate),
      format.percent(total.yearOverYearChange), `${total.currentYearToDate.monthsAvailable}/${total.currentYearToDate.monthsExpected} 组织`]])
    const noteRow = totalRow + 2
    sheet.setValue(noteRow, 0, report.traceability?.organizationScope?.reason || '')
    sheet.addSpan(noteRow, 0, 1, 10)
    sheet.setValue(noteRow + 1, 0, report.traceability?.sourceWorkbookAdjustments?.reason || '')
    sheet.addSpan(noteRow + 1, 0, 1, 10)
    sheet.setValue(noteRow + 2, 0, report.traceability?.scoreAndRank?.reason || '月度得分和排名以已发布规则为准。')
    sheet.addSpan(noteRow + 2, 0, 1, 10)
    sheet.setStyle(0, 0, titleStyle); sheet.getRange(2, 0, 1, 10).setStyle(headerStyle)
    sheet.getRange(totalRow, 0, 1, 10).setStyle(totalStyle)
    sheet.setRowHeight(0, 36); sheet.setRowHeight(1, 25); sheet.setRowHeight(2, 28)
    for (let row = 3; row <= totalRow; row += 1) sheet.setRowHeight(row, 27)
    for (let row = noteRow; row <= noteRow + 2; row += 1) sheet.setRowHeight(row, 24)
    ;[162, 140, 78, 78, 95, 95, 90, 78, 78, 88].forEach((width, column) => sheet.setColumnWidth(column, width))
    setupPrint(sheet, 9, noteRow + 2)
  }
  const traceSheet = spread.getSheet(2); traceSheet.name('来源修订')
  traceSheet.setValue(0, 0, `${report.reportType.name} · ${report.periodCode} · 来源修订`)
  traceSheet.addSpan(0, 0, 1, 4)
  traceSheet.setValue(1, 0, demoLabel); traceSheet.addSpan(1, 0, 1, 4)
  traceSheet.setArray(2, 0, [['组织编码', '组织名称', '来源月份', '修订 ID']])
  const traceRows = report.rows.flatMap(row => (row.sourceRevisions || []).map(source =>
    [row.organizationCode, row.organizationName, source.periodCode, `#${source.revisionId}`]))
  if (traceRows.length) traceSheet.setArray(3, 0, traceRows)
  traceSheet.setStyle(0, 0, titleStyle); traceSheet.getRange(2, 0, 1, 4).setStyle(headerStyle)
  traceSheet.setRowHeight(0, 36); traceSheet.setRowHeight(1, 25); traceSheet.setRowHeight(2, 28)
  ;[175, 190, 135, 130].forEach((width, column) => traceSheet.setColumnWidth(column, width))
  setupPrint(traceSheet, 3, Math.max(3, traceRows.length + 2))
}

async function appendFinalizedSheets(spread, report, assertActive) {
  for (const row of report.rows.filter(item => item.reportRevisionId != null)) {
    if (!row.taskId) { if ((report.source === 'DEMO_SYNTHETIC_ONLY')) continue; throw new Error(`${row.organizationName} 缺少填报任务来源`) }
    const blob = await collaborationApi.downloadFinalizedArtifact(row.taskId, row.reportRevisionId, 'finalized_workbook_json')
    const json = JSON.parse(await blob.text())
    assertActive()
    if (json.activeSheetId || json.collaborationInfo) {
      await import('@grapecity-software/spread-sheets-collaboration-addon')
      assertActive()
    }
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-20000px;width:1000px;height:700px'
    document.body.appendChild(host)
    let source
    try {
      source = new GC.Spread.Sheets.Workbook(host)
      await registerTemplateFunctions(source, json)
      assertActive()
      if (json.activeSheetId || json.collaborationInfo) source.collaboration.fromSnapshot(json)
      else await source.fromJSON(json, { doNotRecalculateAfterLoad: true })
      assertActive()
      const used = new Set(Array.from({ length: spread.getSheetCount() }, (_, i) => spread.getSheet(i).name().toLowerCase()))
      // Rename within the source workbook so native cross-sheet references follow their sheets.
      for (let i = 0; i < source.getSheetCount(); i += 1) {
        const sheet = source.getSheet(i)
        const base = `${row.organizationName}-${sheet.name()}`.replace(/[\\/?:*\[\]]/g, '_').slice(0, 27)
        let name = base, suffix = 1
        while (used.has(name.toLowerCase())) name = `${base}-${suffix++}`
        used.add(name.toLowerCase()); sheet.name(name)
      }
      for (let i = 0; i < source.getSheetCount(); i += 1) {
        const original = source.getSheet(i)
        const sheet = new GC.Spread.Sheets.Worksheet(original.name())
        spread.addSheet(spread.getSheetCount(), sheet)
        const sheetJson = original.toJSON({ includeBindingSource: false })
        // Localize workbook functions so source sheets can retain different
        // published versions when combined in a single result workbook.
        sheet.fromJSON({ ...sheetJson, customFunctions: { ...json.customFunctions, ...sheetJson.customFunctions } })
      }
    } finally { try { source?.destroy() } finally { host.remove() } }
  }
}

export async function exportMonthlyReference(report, type, format, assertActive) {
  let spread, host
  try {
    if (type === 'pdf') await ensureSpreadPdfExport(GC)
    else await Promise.all([ensureSpreadIo(), import('@grapecity-software/spread-sheets-print')])
    assertActive()
    host = document.createElement('div')
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText = 'position:fixed;left:-20000px;width:1900px;height:900px;overflow:hidden'
    document.body.appendChild(host)
    spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: type === 'pdf' ? 3 : 1 })
    if (type === 'pdf') {
      populatePdfWorkbook(spread, report, format)
      const pdf = await new Promise((resolve, reject) => spread.savePDF(resolve, reject,
        { title: `${report.reportType.name} ${report.periodCode}`, author: '成本指标平台', creator: 'SpreadJS 19.1.4' }))
      assertActive()
      return pdf
    }
    const sheet = spread.getActiveSheet(); sheet.name('月度汇总')
    const columns = 19
    sheet.setValue(0, 0, `${report.reportType.name} ${report.periodCode}经营情况汇总`)
    sheet.addSpan(0, 0, 1, columns)
    sheet.setArray(1, 0, [['组织编码', '组织名称', '本期修订', '营业收入', '', '', '', '', '', '', '利润总额', '', '', '', '', '', '', '累计来源修订', '评分与排名'],
      ['', '', '', '本月', '上年同期', '本年累计', '累计目标', '完成率', '同比', '月份完整', '本月', '上年同期', '本年累计', '累计目标', '完成率', '同比', '月份完整', '', '总分 / 排名']])
    for (const column of [0, 1, 2, 17, 18]) sheet.addSpan(1, column, 2, 1)
    sheet.addSpan(1, 3, 1, 7); sheet.addSpan(1, 10, 1, 7)
    const body = report.rows.map(row => [row.organizationCode, row.organizationName,
      row.reportRevisionId ?? '—', row.metrics.revenue.currentMonth, row.metrics.revenue.priorYearSameMonth, row.metrics.revenue.currentYearToDate.value,
      row.metrics.revenue.cumulativeTarget, row.metrics.revenue.cumulativeCompletionRate, row.metrics.revenue.yearOverYearChange,
      `${row.metrics.revenue.currentYearToDate.monthsAvailable}/${row.metrics.revenue.currentYearToDate.monthsExpected}`,
      row.metrics.profit.currentMonth, row.metrics.profit.priorYearSameMonth, row.metrics.profit.currentYearToDate.value,
      row.metrics.profit.cumulativeTarget, row.metrics.profit.cumulativeCompletionRate, row.metrics.profit.yearOverYearChange,
      `${row.metrics.profit.currentYearToDate.monthsAvailable}/${row.metrics.profit.currentYearToDate.monthsExpected}`,
      format.revisionTrace(row),
      row.totalScore == null ? '—' : `${format.amount(row.totalScore)} / ${row.rank ?? '—'}`])
    if (body.length) sheet.setArray(3, 0, body)
    if (body.length) {
      sheet.getRange(3, 17, body.length, 1).wordWrap(true)
      body.forEach((row, index) => {
        const wrappedLines = Math.ceil(String(row[17]).length / 42)
        sheet.setRowHeight(3 + index, Math.max(32, Math.min(112, wrappedLines * 16)))
      })
    }
    const totalRow = 3 + body.length
    sheet.setArray(totalRow, 0, [['', report.consolidationAvailable ? '配置范围合计' : '合并口径未核定', '', '', '', report.totals.revenue.currentYearToDate.value,
      report.totals.revenue.cumulativeTarget, report.totals.revenue.cumulativeCompletionRate,
      report.totals.revenue.yearOverYearChange, `${report.totals.revenue.currentYearToDate.monthsAvailable}/${report.totals.revenue.currentYearToDate.monthsExpected}`,
      '', '', report.totals.profit.currentYearToDate.value, report.totals.profit.cumulativeTarget,
      report.totals.profit.cumulativeCompletionRate, report.totals.profit.yearOverYearChange,
      `${report.totals.profit.currentYearToDate.monthsAvailable}/${report.totals.profit.currentYearToDate.monthsExpected}`,
      '', report.scoringAvailable ? format.amount(report.totals.totalScore) : '未配置规则']])
    const traceabilityNotes = [
      (report.source === 'DEMO_SYNTHETIC_ONLY')
        ? `DEMO 合成数据，仅用于功能验证，不代表正式审批结果；${report.periodCode} 的虚构修订 ID 已逐组织列示。`
        : `计算数据：取 ${report.periodCode} 月报配置包内当前有效的已定稿修订；本期修订 ID 和累计来源修订 ID 已逐组织列示。`,
      `组织合计：${report.traceability?.organizationScope?.reason || report.traceability?.consolidation?.reason || '依据已发布的版本化组织合并规则计算。'} 源表第 5–16 行仅为候选，第 17 行暂缓。${report.consolidationAvailable ? '' : ' 当前不展示跨组织合计。'}`,
      `源表手工调整：${report.traceability?.sourceWorkbookAdjustments?.reason || '仅采用当前有效的已定稿修订。'} 候选单元格：${report.traceability?.sourceWorkbookAdjustments?.candidateCells?.join('、') || '无'}。`,
      `控亏完成率：${report.traceability?.controlLossCompletion?.reason || '按已发布版本化规则计算。'}`
    ]
    const traceStartRow = totalRow + 2
    traceabilityNotes.forEach((note, index) => {
      const row = traceStartRow + index
      sheet.setValue(row, 0, note)
      sheet.addSpan(row, 0, 1, columns)
      sheet.setRowHeight(row, 25)
    })
    const titleStyle = new GC.Spread.Sheets.Style(); titleStyle.font = 'bold 18px Microsoft YaHei'; titleStyle.foreColor = '#15383a'; titleStyle.backColor = '#e5efeb'; titleStyle.hAlign = GC.Spread.Sheets.HorizontalAlign.center; titleStyle.vAlign = GC.Spread.Sheets.VerticalAlign.center
    const headerStyle = new GC.Spread.Sheets.Style(); headerStyle.font = 'bold 10px Microsoft YaHei'; headerStyle.foreColor = '#ffffff'; headerStyle.backColor = '#195e58'; headerStyle.hAlign = GC.Spread.Sheets.HorizontalAlign.center; headerStyle.vAlign = GC.Spread.Sheets.VerticalAlign.center
    const totalStyle = new GC.Spread.Sheets.Style(); totalStyle.font = 'bold 10px Microsoft YaHei'; totalStyle.backColor = '#e9f0eb'
    sheet.setStyle(0, 0, titleStyle); sheet.getRange(1, 0, 2, columns).setStyle(headerStyle)
    sheet.getRange(totalRow, 0, 1, columns).setStyle(totalStyle)
    sheet.setRowHeight(0, 36); sheet.setRowHeight(1, 28); sheet.setRowHeight(2, 32)
    sheet.setColumnWidth(0, 130); sheet.setColumnWidth(1, 180); sheet.setColumnWidth(2, 105)
    sheet.setColumnWidth(17, 320); sheet.setColumnWidth(18, 120)
    for (let column = 3; column < 17; column += 1) sheet.setColumnWidth(column, column === 9 || column === 16 ? 90 : 112)
    sheet.options.gridline = { showVerticalGridline: false, showHorizontalGridline: false }
    const printInfo = new GC.Spread.Sheets.Print.PrintInfo()
    printInfo.orientation(GC.Spread.Sheets.Print.PrintPageOrientation.landscape)
    printInfo.bestFitColumns(true); printInfo.fitPagesWide(1)
    printInfo.repeatRowStart(1); printInfo.repeatRowEnd(2); printInfo.showGridLine(false)
    sheet.printInfo(printInfo)
    await appendFinalizedSheets(spread, report, assertActive)
    assertActive()
    const blob = await new Promise((resolve, reject) => spread.export(resolve, reject,
      { fileType: GC.Spread.Sheets.FileType.excel, includeBindingSource: false }))
    assertActive()
    return blob
  } finally {
    try { spread?.destroy() } finally { host?.remove() }
  }
}
