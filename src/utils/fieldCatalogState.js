import { createWorkflowRequest } from './workflowRequest.js'

export const emptyFieldList = () => ({ rows: [], loading: false, loaded: false, error: '', denied: false })
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const invalid = () => { throw Object.assign(new Error(), { name: 'InvalidFieldResponse' }) }
const text = (value, fallback = '—') => typeof value === 'string' && value.trim() ? value : fallback
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0

function definition(value) {
  if (!object(value) || !text(value.code, '') || !text(value.displayName, '') || !text(value.type, '')) invalid()
  if (value.applicability != null && !object(value.applicability)) invalid()
  for (const options of [value.options, value.applicability?.options]) {
    if (options != null && (!Array.isArray(options) || options.some(item => typeof item !== 'string'))) invalid()
  }
  return { ...value, unit: text(value.unit, ''), applicability: value.applicability || {} }
}

export function normalizeFieldRows(result, kind) {
  const key = { catalog: 'fields', drafts: 'drafts', versions: 'versions' }[kind]
  if (!key || !Array.isArray(result?.[key])) invalid()
  const seen = new Set()
  return result[key].map(row => {
    const identity = kind === 'versions' ? row?.version : row?.id
    if (!object(row) || !positiveId(identity) || seen.has(Number(identity))) invalid()
    seen.add(Number(identity))
    if (kind === 'catalog') {
      if (!positiveId(row.version)) invalid()
      return { ...definition(row), id: Number(row.id) }
    }
    if (kind === 'drafts') {
      if (!['pending', 'approved', 'rejected'].includes(row.status)) invalid()
      return { ...row, id: Number(row.id), proposal: definition(row.proposal),
        creatorName: text(row.creatorName), creatorUsername: text(row.creatorUsername), reviewNote: text(row.reviewNote) }
    }
    return { ...row, snapshot: definition(row.snapshot), creatorName: text(row.creatorName), approverName: text(row.approverName), approvedAt: text(row.approvedAt) }
  })
}

export function fieldReadError(error, label) {
  if (error?.name === 'TimeoutError') return `${label}读取超时，请重试。`
  if (error?.name === 'InvalidFieldResponse') return `${label}数据格式异常，请重试；若仍失败，请联系管理员。`
  if (error?.status === 401) return '登录已失效，请重新登录。'
  if (error?.status === 403) return `当前账号无权读取${label}，请联系管理员确认权限。`
  if (error?.status === 404) return '该字段或提案已不可用，请刷新目录后重新查看。'
  if (error?.status === 429) return '读取过于频繁，请稍后重试。'
  return `${label}读取失败，请检查网络后重试。`
}

// Each resource owns its request, so a failed drafts request cannot hide a valid catalog.
export function createFieldReader(state, { request, kind, onDenied, timeoutMs = 15000 }) {
  const label = { catalog: '已批准字段', drafts: '字段提案', versions: '版本历史' }[kind]
  return createWorkflowRequest({ request, timeoutMs,
    start() { state.loading = true; state.error = '' },
    success(result) {
      const rows = normalizeFieldRows(result, kind)
      state.rows = rows; state.loaded = true; state.denied = false
    },
    failure(error) {
      state.error = fieldReadError(error, label)
      if ([401, 403, 404].includes(error?.status)) {
        state.rows = []; state.loaded = false
        state.denied = [401, 403].includes(error.status)
        if (state.denied) onDenied?.()
      }
    },
    finish() { state.loading = false }
  })
}
