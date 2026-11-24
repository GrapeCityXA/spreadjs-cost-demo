export const fieldProposalTypes = [
  ['decimal', '精确小数'], ['integer', '整数'], ['short_text', '短文本'],
  ['long_text', '长文本'], ['date', '日期'], ['datetime', '日期和时间'],
  ['boolean', '布尔值（是/否）'], ['enum', '枚举（固定选项）'],
  ['organization_reference', '组织引用'], ['user_reference', '用户引用']
].map(([value, label]) => ({ value, label }))

export function createFieldProposal(proposal = {}, draft = {}) {
  const { options: storedOptions, ...applicability } = proposal.applicability || {}
  return {
    id: draft.id || null, supersedesFieldId: draft.supersedesFieldId || null,
    code: proposal.code || draft.code || '', displayName: proposal.displayName || '',
    type: proposal.type || 'decimal', unit: proposal.unit || '', precision: proposal.precision ?? 2,
    editable: proposal.editable !== false, optionsText: (proposal.options || storedOptions || []).join('\n'),
    applicabilityText: JSON.stringify(applicability, null, 2), reason: ''
  }
}

export function validateFieldProposal(form) {
  const errors = {}
  const code = String(form.code || '').trim(), displayName = String(form.displayName || '').trim()
  const unit = String(form.unit || '').trim()
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) errors.code = '请输入 2–64 位编码，以大写字母开头，仅含大写字母、数字或下划线。'
  if (!displayName || !/\p{Script=Han}/u.test(displayName) || displayName.length > 120) errors.displayName = '请填写中文名称，需包含中文且不超过 120 个字符。'
  if (!fieldProposalTypes.some(type => type.value === form.type)) errors.type = '请选择有效的字段类型。'
  if (unit.length > 80) errors.unit = '单位不能超过 80 个字符。'
  if (form.type === 'decimal' && (!Number.isInteger(form.precision) || form.precision < 0 || form.precision > 12)) errors.precision = '小数精度须为 0–12 的整数。'
  if (typeof form.editable !== 'boolean') errors.editable = '请选择字段是否可编辑。'
  let applicability
  try {
    applicability = JSON.parse(form.applicabilityText || '{}')
    if (!applicability || typeof applicability !== 'object' || Array.isArray(applicability)) errors.applicabilityText = '适用范围须为 JSON 对象，例如 {}。'
    else if (JSON.stringify(applicability).length > 4000) errors.applicabilityText = '适用范围去除格式空白后不能超过 4000 个字符。'
  } catch { errors.applicabilityText = 'JSON 格式不正确，请检查双引号、逗号和括号。' }
  // Hidden enum input may be retained for editing, but never sent with another type.
  const options = form.type === 'enum' ? String(form.optionsText || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean) : []
  if (form.type === 'enum') {
    if (!options.length || options.length > 200) errors.optionsText = '请输入 1–200 个选项，每行一项。'
    else if (options.some(value => value.length > 120)) errors.optionsText = '每个枚举选项不能超过 120 个字符。'
    else if (new Set(options).size !== options.length) errors.optionsText = '枚举选项不能重复，请检查重复行。'
  }
  return { errors, payload: Object.keys(errors).length ? null : {
    code, displayName, type: form.type, unit, precision: form.type === 'decimal' ? form.precision : 0,
    editable: form.editable, applicability, options, reason: String(form.reason || '').trim()
  } }
}

export function fieldProposalFailure(error) {
  const status = Number(error?.status)
  const message = String(error?.message || '')
  if (!status || status >= 500 || status === 408) return { uncertain: true, message: '尚未确认提交结果，请勿重复提交。请记下字段编码，关闭表单后到“业务字段目录”核对“已批准字段”和“字段提案”。' }
  if (status === 401) return { message: '登录已失效，请重新登录后核对提案状态。' }
  if (status === 403) return { message: '当前账号无法提交此字段提案。输入已保留，请联系管理员确认权限或提案状态。' }
  if (status === 404) return { message: '未找到原字段或提案。请关闭表单、刷新业务字段目录后重新查看。' }
  if (status === 429) return { message: '提交过于频繁，请稍后重试。输入已保留。' }
  const field = /编码/.test(message) ? 'code' : /中文|显示名称/.test(message) ? 'displayName' : /枚举|选项/.test(message) ? 'optionsText' : /适用范围/.test(message) ? 'applicabilityText' : /精度/.test(message) ? 'precision' : /单位/.test(message) ? 'unit' : null
  return { field, message: message || '提交未成功，请检查输入后重试。' }
}

export function persistFieldProposal(api, { id, supersedesFieldId }, payload, signal) {
  // Correcting an existing replacement draft must not create a second replacement.
  if (id) return api.correctDraft(id, payload, signal)
  if (supersedesFieldId) return api.supersedeField(supersedesFieldId, payload, signal)
  return api.createDraft(payload, signal)
}

// Aborting a write does not prove that the server rolled it back.
export async function submitFieldProposal(fetcher, { signal, timeoutMs = 30000 } = {}) {
  const controller = new AbortController()
  let timer, abort
  const interrupted = new Promise((_, reject) => {
    abort = () => { controller.abort(); reject(Object.assign(new Error('提交已中断'), { name: 'AbortError' })) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    timer = setTimeout(abort, timeoutMs)
  })
  try { return await Promise.race([interrupted, Promise.resolve().then(() => {
    if (controller.signal.aborted) throw Object.assign(new Error('提交已中断'), { name: 'AbortError' })
    return fetcher(controller.signal)
  })]) }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
