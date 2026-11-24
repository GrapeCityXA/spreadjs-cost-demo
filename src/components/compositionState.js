export const MAX_COMPOSITION_SHEETS = 30

export function nextSheetIndex(sheets) {
  const codes = new Set(sheets.map(sheet => sheet.code))
  let index = 1
  while (codes.has(`sheet_${index + 1}`)) index++
  return index
}

export function compositionFingerprint(form) {
  return JSON.stringify({ ...form, sheets: form.sheets.map(({ key, ...sheet }) => sheet) })
}

export function validateComposition(form, { components = [], componentsReady = true, validateBinding = () => {} } = {}) {
  const errors = {}
  if (!String(form.name || '').trim()) errors.name = '请输入模板名称。'
  if (!form.sheets?.length || form.sheets.length > MAX_COMPOSITION_SHEETS) errors.sheets = '模板需要 1–30 张工作表。'
  const codes = new Map()
  for (const [index, sheet] of (form.sheets || []).entries()) {
    const path = `sheets.${index}`, prefix = `工作表 ${index + 1}：`
    if (!String(sheet.name || '').trim()) errors[`${path}.name`] = `${prefix}请输入名称。`
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(sheet.code || '')) errors[`${path}.code`] = `${prefix}编码须为 2–64 位，以小写字母开头，只能包含小写字母、数字、下划线或短横线。`
    else if (codes.has(sheet.code)) {
      errors[`${path}.code`] = `${prefix}编码“${sheet.code}”已使用，请修改。`
      errors[`sheets.${codes.get(sheet.code)}.code`] = `编码“${sheet.code}”重复，请为每张工作表设置不同编码。`
    } else codes.set(sheet.code, index)
    if (sheet.inlineWorkbook) continue
    if (sheet.type === 'business') {
      const body = components.find(c => Number(c.versionId) === Number(sheet.bodyVersionId))
      for (const type of ['header', 'body', 'footer']) {
        const id = sheet[`${type}VersionId`], field = `${path}.${type}VersionId`
        if (!id) { if (type === 'body') errors[field] = `${prefix}请选择 Body 组件。`; continue }
        if (!componentsReady) { errors[field] = `${prefix}请先重新加载组件列表，再确认组件版本。`; continue }
        const component = components.find(c => Number(c.versionId) === Number(id))
        if (!component || component.status !== 'published' || component.componentType !== type) errors[field] = `${prefix}${type} 组件版本已不可用，请重新选择。`
        else if (type !== 'body' && body && Number(component.workbook?.columnCount) !== Number(body.workbook?.columnCount)) errors[field] = `${prefix}${type} 列数须与 Body 一致，请重新选择组件。`
      }
    } else if (sheet.type === 'auxiliary') {
      const aux = sheet.auxiliary || {}, field = `${path}.auxiliary`
      if (aux.sourceMode === 'remote') {
        try { validateBinding(aux.dataBinding) } catch (error) { errors[field] = `${prefix}${error.message}` }
      } else {
        const rows = aux.rowCount, cols = aux.columnCount
        if (!Number.isInteger(rows) || rows < 1 || rows > 200 || !Number.isInteger(cols) || cols < 1 || cols > 100) errors[field] = `${prefix}行数须为 1–200，列数须为 1–100 的整数。`
        else {
          try {
            const cells = JSON.parse(aux.cellsJson || '[]')
            if (!Array.isArray(cells)) errors[field] = `${prefix}固定内容须为 JSON 数组，例如 []。`
            else if (cells.some(cell => !cell || !Number.isInteger(cell.row) || cell.row < 0 || cell.row >= rows || !Number.isInteger(cell.column) || cell.column < 0 || cell.column >= cols)) errors[field] = `${prefix}单元格 row、column 须为从 0 开始的整数，且不能超出行列范围。`
          } catch { errors[field] = `${prefix}固定内容不是有效 JSON，请检查引号、逗号和括号。` }
        }
      }
    } else errors[`${path}.type`] = `${prefix}请选择工作表类型。`
  }
  return errors
}

export function compositionRequestError(error, action) {
  if (error?.name === 'TimeoutError') return `${action}超时，请检查网络后重试。`
  if (error?.status === 401) return '登录已过期，请重新登录。'
  if (error?.status === 403) return '没有操作权限，请联系模板维护人或管理员。'
  if (error?.status === 404) return '模板或组件版本已不存在，请刷新列表后确认。'
  if (error?.status === 409) return '版本状态已变化，请重新打开最新草稿后再修改。'
  if (error?.status === 429) return '请求过于频繁，请稍后重试。'
  if (error?.status === 400) return String(error.message || '请检查填写内容。')
  return `${action}失败，请检查网络后重试。`
}

// Read-only requests can be safely cancelled and retried; writes keep their server outcome.
export async function readCompositionComponents(fetcher, signal, timeoutMs = 15000) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  let timer
  try {
    return await Promise.race([
      fetcher(controller.signal),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })) }, timeoutMs) })
    ])
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}
