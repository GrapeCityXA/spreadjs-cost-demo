export function templateRecordActions(kind, row, { maintain, admin, workflowFrom, busy, modifyingVersionId = null }) {
  const actions = []
  const add = (key, label, tip, type = 'primary', disabled = false, loading = false) => actions.push({ key, label, tip, type, disabled, loading })
  const draft = row.status === 'draft', reviewing = row.status === 'in_review'
  if (kind === 'component') {
    if (draft && maintain) add('edit', 'Designer 编辑', '在 Designer 中编辑当前组件草稿的内容、字段映射和填报权限。')
    if (!draft) add('edit', '查看设计', '查看当前组件版本的设计。')
  } else {
    if (draft && maintain) add('edit', '修改', '继续修改当前草稿的基本信息和工作表设计，可多次保存。')
    if (reviewing && maintain) add('edit', '修改', '当前版本正在审核，退回后可修改。', 'primary', true)
    if (draft && maintain) add('check', '发布检查', '检查发布条件，并定位需要修复的问题。')
  }
  if (draft && maintain) add('submit', '提交审核', '提交系统管理员审批；管理员提交时直接发布。', 'primary', busy)
  if (reviewing && admin && workflowFrom) {
    add('approve', '批准发布', '审核通过并发布当前版本。', 'success', busy)
    add('reject', '退回', '填写退回原因，将当前版本退回维护人修改。', 'danger', busy)
  }
  const versionable = kind === 'component' ? ['published', 'rejected'] : ['published', 'superseded', 'rejected']
  if (maintain && versionable.includes(row.status)) {
    add('version', kind === 'component' ? '新版本设计' : '修改', '以当前版本创建新草稿并打开编辑，原版本保留。', 'primary',
      kind === 'template' && modifyingVersionId !== null && modifyingVersionId !== row.versionId,
      kind === 'template' && modifyingVersionId === row.versionId)
  }
  if (kind === 'template') add('preview', '预览成品', '查看工作簿，并可导出 XLSX 或打开 PDF 预览。', '')
  return actions
}
