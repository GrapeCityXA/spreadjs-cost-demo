let snapshotLoader

// The task queue needs no collaboration runtime. Reuse it once a task is opened.
export function loadReviewSnapshot() {
  if (!snapshotLoader) {
    snapshotLoader = import('../template/restoreRevisionWorkbook').catch(error => {
      snapshotLoader = null
      throw new Error('工作簿功能加载失败，请检查网络后刷新页面再试。', { cause: error })
    })
  }
  return snapshotLoader
}
