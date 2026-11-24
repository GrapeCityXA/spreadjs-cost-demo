export function importFailure(error, fallback) {
  if (error?.status === 401) return '登录已失效，请重新登录后再操作。'
  if (error?.status === 403) return '当前账号无权执行历史导入，请联系数据管理员或系统管理员。'
  if (error?.status === 429) return '操作过于频繁，请稍后重试。'
  if (error?.name === 'TimeoutError') return '等待超时，请检查网络后重试。'
  if (error instanceof TypeError || error?.name === 'TypeError') return '网络连接异常，请检查网络后重试。'
  return error?.message || fallback
}

// A timeout stops waiting, but cannot undo a request already accepted by the server.
export function runImportRequest(work, { signal, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    let timer, settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      callback(value)
    }
    const abort = () => { finish(reject, Object.assign(new Error('操作已取消'), { name: 'AbortError' })); controller.abort() }
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => {
      finish(reject, Object.assign(new Error('等待超时'), { name: 'TimeoutError' }))
      controller.abort()
    }, timeoutMs)
    Promise.resolve().then(() => work(controller.signal)).then(value => finish(resolve, value), error => finish(reject, error))
  })
}

export function checkedImportPreview(result) {
  const count = value => Number.isSafeInteger(value) && value >= 0
  if (!result || !Number.isSafeInteger(result.batchId) || result.batchId < 1 ||
      !['validated', 'rejected'].includes(result.status) || !Array.isArray(result.rows) ||
      !result.summary || !['total', 'newRecords', 'duplicates', 'warnings', 'blockingErrors'].every(key => count(result.summary[key])) ||
      result.rows.some(row => !row || !Array.isArray(row.errors) || !Array.isArray(row.warnings))) {
    throw new Error('预览结果不完整，请重新校验文件。')
  }
  return result
}

export function importReceipt(result) {
  if (result?.status !== 'imported' || !Number.isSafeInteger(result.imported) || result.imported < 0 ||
      !Number.isSafeInteger(result.duplicates) || result.duplicates < 0) {
    throw new Error('未收到完整的导入回执')
  }
  return { imported: result.imported, duplicates: result.duplicates }
}

export function importBatchState(status) {
  return ({ validated: { label: '可确认', type: 'success' }, rejected: { label: '存在阻断错误', type: 'danger' },
    imported: { label: '已导入', type: 'success' }, stale: { label: '需重新校验', type: 'warning' },
    uncertain: { label: '结果待核对', type: 'warning' } })[status] || { label: '需重新校验', type: 'warning' }
}
