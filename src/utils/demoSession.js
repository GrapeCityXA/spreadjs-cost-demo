import { authApi } from '@/api'
import { DEMO_IDENTITIES } from '@/config/showcase'

export function currentDemoIdentityKey() {
  try {
    const saved = localStorage.getItem('cost-report-demo-role')
    if (DEMO_IDENTITIES.some(item => item.key === saved)) return saved
    const user = JSON.parse(localStorage.getItem('userInfo') || '{}')
    return DEMO_IDENTITIES.find(item => item.username === user.username)?.key || ''
  } catch {
    return ''
  }
}

export async function switchDemoIdentity(key) {
  const identity = DEMO_IDENTITIES.find(item => item.key === key)
  if (!identity) throw new Error('未知的演示身份')
  const response = await authApi.login(identity.username, identity.password)
  if (!response?.token || !response?.user?.id) throw new Error('演示账号登录失败')
  localStorage.setItem('token', response.token)
  localStorage.setItem('userInfo', JSON.stringify(response.user))
  localStorage.setItem('cost-report-demo-role', key)
  window.dispatchEvent(new Event('cost-report-session-updated'))
  return response.user
}
