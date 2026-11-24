#!/usr/bin/env node
// 分享包不带原演示库，这里按登录页（src/views/Login.vue）写死的账号重建组织与演示用户。
// 幂等：已存在的组织/账号/角色授权会跳过，不会覆盖已有密码。
const sqlite3 = require('sqlite3');
const bcrypt = require('bcryptjs');
const storage = require('../src/config/storage');

const ORGANIZATIONS = [
  { code: 'GROUP_HQ', name: '集团总部' },
  { code: 'SUB_EAST', name: '华东子公司' },
  { code: 'SUB_SOUTH', name: '华南子公司' },
  { code: 'SUB_NORTHWEST', name: '西北子公司' },
];

// 与登录页的一键登录账号保持一致；角色码取自前端路由守卫和 server/src/middleware/auth.js。
const USERS = [
  { username: 'browser-user', password: 'browser-password', name: '系统管理员', organization: null,
    permissions: ['template', 'edit', 'formula', 'comment', 'review', 'view'],
    roles: ['system_admin'] },
  { username: 'browser-designer', password: 'browser-designer-password', name: '模板设计者', organization: null,
    permissions: ['template', 'view'], roles: ['template_designer', 'data_administrator'] },
  { username: '组织填报人一', password: 'browser-scoped-password', name: '填报人一', organization: 'SUB_EAST',
    permissions: ['view', 'edit'], roles: ['subsidiary_filler', 'subsidiary_submitter'] },
  { username: 'browser-scoped-user-2', password: 'browser-scoped-password-2', name: '填报人二', organization: 'SUB_EAST',
    permissions: ['view', 'edit'], roles: ['subsidiary_filler'] },
  { username: 'browser-quarter-reviewer', password: 'browser-quarter-reviewer-password', name: '季度部门审核人', organization: 'GROUP_HQ',
    permissions: ['view', 'review'], roles: ['department_reviewer', 'score_editor'] },
  { username: 'evidence-outsider', password: 'evidence-outsider-password', name: '组织范围外用户', organization: 'SUB_NORTHWEST',
    permissions: ['view', 'edit'], roles: ['subsidiary_filler'] },
  // 官网演示身份（与 src/config/showcase.js 保持一致）
  { username: 'demo-admin', password: 'demo123', name: '管理员', organization: null,
    permissions: ['template', 'edit', 'formula', 'comment', 'review', 'view'], roles: ['system_admin'] },
  { username: 'demo-filler', password: 'demo123', name: '演示填报人', organization: 'SUB_EAST',
    permissions: ['view', 'edit'], roles: ['subsidiary_filler', 'subsidiary_submitter'] },
  { username: 'demo-reviewer', password: 'demo123', name: '审核人', organization: 'SUB_EAST',
    permissions: ['view', 'review'], roles: ['department_reviewer', 'report_finalizer', 'management'] },
];

const dbPath = storage.getDatabasePath();
const open = () => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, error => error ? reject(error) : resolve(db));
});
const all = (db, sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (e, rows) => e ? reject(e) : resolve(rows)));
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function (e) { e ? reject(e) : resolve(this); }));
const close = db => new Promise((resolve, reject) => db.close(e => e ? reject(e) : resolve()));

async function seedDemoUsers() {
  const db = await open();
  try {
    const orgIds = new Map();
    for (const org of ORGANIZATIONS) {
      await run(db, `INSERT OR IGNORE INTO organizations (code, name, organization_type, status, effective_from)
        VALUES (?, ?, 'company', 'active', '1970-01-01')`, [org.code, org.name]);
      const row = (await all(db, 'SELECT id FROM organizations WHERE code = ?', [org.code]))[0];
      orgIds.set(org.code, row.id);
    }

    for (const user of USERS) {
      const organizationId = user.organization ? orgIds.get(user.organization) : null;
      const existing = (await all(db, 'SELECT id FROM users WHERE username = ?', [user.username]))[0];
      let userId = existing?.id;
      if (userId) {
        await run(db, `UPDATE users SET name = ?, permissions = ?, organization_id = ? WHERE id = ?`,
          [user.name, JSON.stringify(user.permissions), organizationId, userId]);
        console.log(`更新已存在账号：${user.username}`);
      } else {
        const hash = await bcrypt.hash(user.password, 12);
        const created = await run(db, `INSERT INTO users (username, password, name, permissions, organization_id, account_status)
          VALUES (?, ?, ?, ?, ?, 'active')`,
          [user.username, hash, user.name, JSON.stringify(user.permissions), organizationId]);
        userId = created.lastID;
        console.log(`创建账号：${user.username} / ${user.password}`);
      }

      for (const role of user.roles) {
        const granted = (await all(db, `SELECT id FROM user_roles WHERE user_id = ? AND role_code = ?
          AND (organization_id IS ? OR organization_id = ?)`, [userId, role, organizationId, organizationId]))[0];
        if (granted) continue;
        await run(db, 'INSERT INTO user_roles (user_id, role_code, organization_id) VALUES (?, ?, ?)',
          [userId, role, organizationId]);
        console.log(`  授权 ${role}${organizationId ? ` @ ${user.organization}` : '（全局）'}`);
      }
    }
  } finally {
    await close(db);
  }
}

if (require.main === module) {
  seedDemoUsers().catch(error => {
    console.error('生成演示账号失败：', error.message);
    console.error(`请先启动一次后端（npm run server）以完成数据库迁移，当前库路径：${dbPath}`);
    process.exitCode = 1;
  });
}
module.exports = { seedDemoUsers };
