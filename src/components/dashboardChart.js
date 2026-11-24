import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, AriaComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { createMetricChartController } from './dashboardPerformance'

echarts.use([BarChart, GridComponent, TooltipComponent, AriaComponent, CanvasRenderer])
export function createMetricChart(host) {
  return createMetricChartController(echarts.init(host))
}
