import { ref } from 'vue'
import { dashboardError } from './dashboardState.js'

// Latest response wins; cancellation and timeout also invalidate late responses.
export function createDashboardRequest(subject, timeoutMs = 20000) {
  const loading = ref(false), error = ref('')
  let version = 0, controller, timer
  function cancel() {
    version++
    clearTimeout(timer)
    controller?.abort()
    loading.value = false
  }
  async function run(fetcher, apply, onError = () => {}) {
    cancel()
    const seq = version, current = new AbortController()
    controller = current
    loading.value = true
    error.value = ''
    const fail = failure => {
      if (seq !== version) return
      error.value = dashboardError(failure, subject)
      loading.value = false
      onError(failure)
    }
    timer = setTimeout(() => {
      fail({ name: 'TimeoutError' })
      version++
      current.abort()
    }, timeoutMs)
    try {
      const result = await fetcher(current.signal)
      if (seq !== version) return false
      apply(result)
      return true
    } catch (failure) {
      if (!current.signal.aborted) fail(failure)
      return false
    } finally {
      if (seq === version) { clearTimeout(timer); loading.value = false }
    }
  }
  return { loading, error, run, cancel }
}
