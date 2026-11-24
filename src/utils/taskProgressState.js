export function shanghaiDeadline(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN
  const text = value.trim()
  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(text) ? text : `${text}+08:00`)
}

export function normalizeProgress(progress) {
  if (!Array.isArray(progress?.tasks) || !Array.isArray(progress?.reminderSchedules)) throw new Error('任务进度响应不完整，请重新刷新。')
  const tasks = progress.tasks.map(task => {
    if (!Number.isSafeInteger(Number(task?.id)) || Number(task.id) <= 0) throw new Error('任务编号异常，请重新刷新。')
    return { ...task, periodCode: String(task.periodCode || ''), reportTypeName: String(task.reportTypeName || '未命名报告'),
      organizationName: String(task.organizationName || '未命名组织'), assignments: Array.isArray(task.assignments) ? task.assignments : [] }
  })
  const reminderSchedules = progress.reminderSchedules.map(item => {
    if (!Number.isSafeInteger(Number(item?.reportTypeId)) || Number(item.reportTypeId) <= 0 || !Array.isArray(item.schedule?.daysBefore)) throw new Error('提醒计划响应不完整，请重新刷新。')
    return { ...item, schedule: { ...item.schedule, daysBefore: [...item.schedule.daysBefore] } }
  })
  return { tasks, reminderSchedules }
}
