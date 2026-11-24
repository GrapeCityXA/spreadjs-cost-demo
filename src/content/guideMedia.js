import design from '@/assets/guide/design.webp'
import collaboration from '@/assets/guide/collaboration.webp'
import imported from '@/assets/guide/import.webp'
import composition from '@/assets/guide/composition.webp'
import data from '@/assets/guide/data.webp'
import analysis from '@/assets/guide/analysis.webp'
import report from '@/assets/guide/report.webp'
import filling from '@/assets/guide/filling.webp'

// Stills come from the project's own recordings; source/time provenance is in assets/guide/sources.json.
export const scenes = {
  design: { src: design, title: '熟悉的表格，成为在线业务模板', caption: '看中间的表格设计区：保留表样，在两侧连接字段与单元格属性。' },
  binding: { src: data, title: '把外部数据接进模板', caption: '看数据源配置：将外部数据映射到模板，让同一表样服务不同数据。' },
  collaborate: { src: collaboration, title: '两个账号，同一张工作表', caption: '看左右两端的同一表格、在线头像和彩色选区；播放录屏可观察修改同步。' },
  submit: { src: filling, title: '填报与提交检查在一个工作台完成', caption: '看表格右侧的必填完整度，再沿工作台完成本次提交。' },
  report: { src: report, title: '从定稿数据到可交付报表', caption: '看 ReportSheet 设计区：设置报表表样、数据字段和输出布局。' },
}

export const videoMedia = {
  full: { poster: design, duration: '6:14' },
  import: { poster: imported, duration: '0:40' },
  composition: { poster: composition, duration: '0:21' },
  data: { poster: data, duration: '0:45' },
  collaboration: { poster: collaboration, duration: '1:03' },
  analysis: { poster: analysis, duration: '0:33' },
}

export const phases = { design: '准备标准 · 让表样与口径统一', dispatch: '协同完成 · 让多人围绕一张表工作', review: '审核交付 · 让数据成为业务成果' }
export const transitions = {
  dispatch: ['固定模板与规则版本', '分派责任人与期限', '生成任务工作簿'],
  review: ['查看提交表样', '退回修改 / 审核通过', '保留定稿版本'],
}
