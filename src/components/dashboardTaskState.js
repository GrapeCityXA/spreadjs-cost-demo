const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback
const id = value => (typeof value === 'number' || typeof value === 'string') && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null
const stepStates = new Set(['done', 'current', 'pending', 'stopped'])

// Normalize at the overview boundary too: sibling summaries consume these rows.
export function normalizeDashboardTasks(input) {
  const tasks = [], seen = new Set()
  let invalidCount = 0
  for (const row of Array.isArray(input) ? input : []) {
    const taskId = record(row) ? id(row.taskId) : null
    if (!taskId || seen.has(taskId)) { invalidCount++; continue }
    seen.add(taskId)
    const stepKeys = new Set()
    const steps = (Array.isArray(row.flow?.steps) ? row.flow.steps : []).flatMap(step => {
      if (!record(step) || !text(step.key) || !text(step.label) || stepKeys.has(step.key)) return []
      stepKeys.add(step.key)
      return [{ key: step.key, label: text(step.label), state: stepStates.has(step.state) ? step.state : 'unknown' }]
    })
    tasks.push({ ...row, taskId,
      name: text(row.name, `任务 #${taskId}`), organization: text(row.organization, '公司未记录'),
      period: text(row.period), kind: text(row.kind), status: text(row.status),
      stage: text(row.stage, '阶段未记录'), assignees: text(row.assignees, '暂无有效责任人'),
      target: typeof row.target === 'string' && row.target.startsWith('/portal/') ? row.target : null,
      submittedRevisionId: id(row.submittedRevisionId), effectiveRevisionId: id(row.effectiveRevisionId),
      flow: { notice: text(row.flow?.notice), steps },
    })
  }
  return { tasks, invalidCount }
}

export const taskKindLabel = kind => ({ monthly: '月报', quarterly: '季报' })[kind] || '类型未记录'
