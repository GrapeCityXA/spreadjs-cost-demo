const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { JWT_SECRET } = require('../middleware/auth');

// 用户登录
exports.login = (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  db.get(
    'SELECT * FROM users WHERE username = ?',
    [username],
    (err, user) => {
      if (err) {
        return res.status(500).json({ error: '登录失败' });
      }

      if (!user || user.account_status !== 'active') {
        return res.status(401).json({ error: '用户名或密码错误' });
      }

      bcrypt.compare(password, user.password, (err, result) => {
        if (err) {
          return res.status(500).json({ error: '登录失败' });
        }

        if (!result) {
          return res.status(401).json({ error: '用户名或密码错误' });
        }

        const permissions = JSON.parse(user.permissions || '[]');
        db.all(
          `SELECT DISTINCT role_code AS code, organization_id AS organizationId,
           (SELECT name FROM custom_roles WHERE code = effective_user_roles.role_code) AS name
           FROM effective_user_roles WHERE user_id = ? AND effective_from <= CURRENT_TIMESTAMP
             AND (effective_to IS NULL OR effective_to > CURRENT_TIMESTAMP)`,
          [user.id],
          (rolesError, roles) => {
            if (rolesError) return res.status(500).json({ error: '登录失败' });
        const token = jwt.sign(
          {
            id: user.id,
            username: user.username,
            name: user.name,
            permissions
          },
          JWT_SECRET,
          { expiresIn: '24h' }
        );

        res.json({
          message: '登录成功',
          token,
          user: {
            id: user.id,
            username: user.username,
            name: user.name,
            permissions,
            organizationId: user.organization_id,
            roles
          }
        });
          }
        );
      });
    }
  );
};

// 获取当前用户信息
exports.getCurrentUser = (req, res) => {
  res.json({
    user: req.user
  });
};
