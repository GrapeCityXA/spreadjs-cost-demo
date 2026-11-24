// 演示进度只记录"访问过哪些步骤"，不伪造业务完成状态。
const KEY = 'cost-report-demo-progress'

export function readDemoProgress() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw.filter(value => typeof value === 'string') : []
  } catch {
    return []
  }
}

export function markDemoStep(key) {
  if (!key) return
  try {
    const visited = new Set(readDemoProgress())
    visited.add(key)
    localStorage.setItem(KEY, JSON.stringify([...visited]))
    window.dispatchEvent(new Event('demo-progress-changed'))
  } catch { /* storage may be unavailable */ }
}

export function resetDemoProgress() {
  try {
    localStorage.removeItem(KEY)
    window.dispatchEvent(new Event('demo-progress-changed'))
  } catch { /* ignore */ }
}
