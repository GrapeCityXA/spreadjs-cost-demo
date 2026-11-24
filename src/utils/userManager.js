/**
 * 用户管理器 - SpreadJS 评论功能用户信息注入
 */

// 登录用户映射表（实际项目中应从后端获取）
const USER_MAPPING = {
  'admin': { id: 'user_admin', name: '管理员', email: 'admin@example.com', color: '#f56c6c' },
  'finance': { id: 'user_finance', name: '财务人员', email: 'finance@example.com', color: '#941966' },
  'viewer': { id: 'user_viewer', name: '查看用户', email: 'viewer@example.com', color: '#67c23a' }
}

/**
 * 初始化用户管理器
 * @param {Object} userInfo - 当前登录用户信息 {username, name, role, permissions}
 * @param {Object} GC - SpreadJS GC 对象（各页面导入的 GC 实例）
 */
export function initUserManager(userInfo, GC) {
  if (!GC || !GC.Spread || !GC.Spread.Common) {
    console.warn('SpreadJS GC 对象未正确传入，无法初始化用户管理器')
    return
  }

  // 检查是否已经配置过（避免重复配置）
  if (GC.Spread.Common.UserManager._configured) {
    // 仅更新当前用户
    const mappedUser = USER_MAPPING[userInfo.username] || {
      id: 'user_' + userInfo.username,
      name: userInfo.name || userInfo.username,
      email: userInfo.username + '@example.com',
      color: '#909399'
    }
    const fullUser = { ...mappedUser, name: userInfo.name || mappedUser.name }
    GC.Spread.Common.UserManager.current(fullUser.id)
    console.log('用户管理器已配置，更新当前用户:', fullUser)
    return fullUser
  }

  // 根据登录用户获取完整用户信息
  const mappedUser = USER_MAPPING[userInfo.username] || {
    id: 'user_' + userInfo.username,
    name: userInfo.name || userInfo.username,
    email: userInfo.username + '@example.com',
    color: '#909399'
  }

  // 合并用户信息
  const fullUser = {
    ...mappedUser,
    name: userInfo.name || mappedUser.name
  }

  // 定义所有可用用户（用于@提及功能）
  const users = Object.values(USER_MAPPING)

  // 配置用户管理器
  GC.Spread.Common.UserManager.configure({
    // 根据用户ID获取用户信息
    get: async (userId) => {
      if (!userId) return
      return new Promise((resolve) => {
        const user = users.find(u => u.id === userId)
        resolve(user || null)
      })
    },
    // 搜索用户（用于@提及）
    search: async (query) => {
      return new Promise((resolve) => {
        if (!query) {
          resolve(users)
          return
        }
        resolve(users.filter(u =>
          u.name.toLowerCase().includes(query.toLowerCase()) ||
          u.email.toLowerCase().includes(query.toLowerCase())
        ))
      })
    }
  })

  // 标记已配置
  GC.Spread.Common.UserManager._configured = true

  // 设置当前用户
  GC.Spread.Common.UserManager.current(fullUser.id)

  console.log('用户管理器初始化完成，当前用户:', fullUser)

  return fullUser
}

/**
 * 获取当前用户ID
 */
export function getCurrentUserId() {
  if (window.GC && window.GC.Spread && window.GC.Spread.Common) {
    return window.GC.Spread.Common.UserManager.current()
  }
  return null
}

/**
 * 获取当前用户信息
 */
export async function getCurrentUserInfo() {
  const userId = getCurrentUserId()
  if (!userId) return null

  if (window.GC && window.GC.Spread && window.GC.Spread.Common) {
    return await window.GC.Spread.Common.UserManager.get(userId)
  }
  return null
}

export default {
  initUserManager,
  getCurrentUserId,
  getCurrentUserInfo
}
