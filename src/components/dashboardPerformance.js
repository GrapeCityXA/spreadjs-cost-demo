// Overview payloads are immutable JSON snapshots. Preserve references per section
// so an unchanged poll does not invalidate tables, filters and metric calculations.
export function reuseDashboardData(previous, incoming) {
  const next = { ...incoming }
  let unchanged = JSON.stringify(Object.fromEntries(Object.entries(previous).filter(([key]) => !['tasks', 'fields', 'types', 'values'].includes(key)))) ===
    JSON.stringify(Object.fromEntries(Object.entries(incoming).filter(([key]) => !['tasks', 'fields', 'types', 'values'].includes(key))))
  for (const key of ['tasks', 'fields', 'types', 'values']) {
    if (JSON.stringify(previous[key]) === JSON.stringify(incoming[key])) next[key] = previous[key]
    else unchanged = false
  }
  return unchanged ? previous : next
}

export function createMetricChartController(chart) {
  let previous = [], width = chart.getWidth(), height = chart.getHeight()
  return {
    update(rows) {
      const next = rows.map(row => [row.key, row.label, row.value])
      if (next.length === previous.length && next.every((row, i) => row.every((value, j) => Object.is(value, previous[i][j])))) return
      chart.setOption({ animation: false, aria: { enabled: true }, tooltip: { trigger: 'axis', renderMode: 'richText' }, grid: { left: 65, right: 25, top: 20, bottom: 65 },
        xAxis: { type: 'category', data: rows.map(row => row.label), axisLabel: { width: 110, overflow: 'truncate' } }, yAxis: { type: 'value' },
        series: [{ id: 'metric', type: 'bar', barMaxWidth: 42, itemStyle: { color: '#941966', borderRadius: [4, 4, 0, 0] }, data: rows.map(row => row.value) }]
      })
      previous = next
    },
    resize(nextWidth, nextHeight) {
      if (nextWidth <= 0 || nextHeight <= 0 || (width === nextWidth && height === nextHeight)) return
      chart.resize({ width: nextWidth, height: nextHeight })
      width = nextWidth; height = nextHeight
    },
    dispose() { chart.dispose() }
  }
}
