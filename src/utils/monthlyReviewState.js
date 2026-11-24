export const reviewTaskId = value => {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

export function readReviewTasks(response) {
  if (!Array.isArray(response?.tasks) || response.tasks.some(task => !reviewTaskId(task?.id)
    || typeof task.organizationName !== 'string' || typeof task.reportTypeName !== 'string')) {
    throw new Error('任务列表数据不完整，请重新加载。')
  }
  return response.tasks
}

export function readReviewDetail(detail, taskId) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value)
  if (!object(detail) || reviewTaskId(detail.task?.id) !== taskId || !reviewTaskId(detail.revision?.id)
    || !['submitted', 'finalized'].includes(detail.revision.status) || !object(detail.workbook)
    || !['opinions', 'anomalies', 'attachments'].every(key => Array.isArray(detail[key]) && detail[key].every(object))
    || detail.opinions.some(item => typeof item.opinion !== 'string')
    || detail.attachments.some(item => !reviewTaskId(item.id) || typeof item.originalName !== 'string')
    || detail.anomalies.some(item => !reviewTaskId(item.id))
    || (detail.myOpinion && typeof detail.myOpinion.opinion !== 'string')
    || (detail.adjustment && !Array.isArray(detail.adjustment.changedFields))) {
    throw new Error('审核资料数据不完整或与当前任务不匹配，请重新加载。')
  }
  return detail
}

export function reviewError(error, fallback) {
  if (error?.name === 'AbortError') return '读取超时，请检查网络后重试。'
  return error?.errorMessage || error?.message || fallback
}
