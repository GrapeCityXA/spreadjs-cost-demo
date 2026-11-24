const jwt = require('jsonwebtoken');
const db = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// 验证JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: '未提供认证令牌' });
  }

  jwt.verify(token, JWT_SECRET, async (err, payload) => {
    if (err) {
      return res.status(401).json({ error: '令牌无效或已过期' });
    }
    try {
      const user = await new Promise((resolve, reject) => db.get(
        `SELECT id, username, name, permissions, organization_id, account_status
         FROM users WHERE id = ?`, [payload.id], (error, row) => error ? reject(error) : resolve(row)
      ));
      if (!user || user.account_status !== 'active') {
        return res.status(401).json({ error: '账户不存在或已停用' });
      }
      const roles = await new Promise((resolve, reject) => db.all(
        `SELECT DISTINCT role_code AS code, organization_id AS organizationId,
           (SELECT name FROM custom_roles WHERE code = effective_user_roles.role_code) AS name
         FROM effective_user_roles WHERE user_id = ? AND effective_from <= CURRENT_TIMESTAMP
           AND (effective_to IS NULL OR effective_to > CURRENT_TIMESTAMP)`,
        [user.id], (error, rows) => error ? reject(error) : resolve(rows)
      ));
      req.user = {
        id: user.id,
        username: user.username,
        name: user.name,
        permissions: JSON.parse(user.permissions || '[]'),
        organizationId: user.organization_id,
        roles
      };
      next();
    } catch (error) {
      next(error);
    }
  });
}

// 验证权限
function checkPermission(requiredPermission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: '未认证' });
    }

    if (!hasCapability(req.user, requiredPermission)) {
      return res.status(403).json({ error: '权限不足' });
    }

    next();
  };
}

function hasCapability(user, permission) {
  if (user?.permissions?.includes(permission)) return true;
  const roles = new Set((user?.roles || []).map(role => role.code));
  const responsibilityRoles = {
    template: ['template_designer', 'system_admin'],
    report: ['subsidiary_filler', 'subsidiary_submitter'],
    review: ['department_reviewer'],
    finalize: ['report_finalizer'],
    score: ['score_editor']
  };
  return roles.has(permission) || (responsibilityRoles[permission] || []).some(role => roles.has(role));
}

function requireOrganizationAdmin(req, res, next) {
  const roles = req.user?.roles || [];
  if (roles.some(role => role.code === 'system_admin') || roles.some(role => role.code === 'organization_user_admin' && role.organizationId == null)) return next();
  return res.status(403).json({ error: '需要组织与用户管理员权限' });
}

function requireSystemAdmin(req, res, next) {
  if (hasRole(req.user, 'system_admin')) return next();
  return res.status(403).json({ error: '需要系统管理员权限' });
}

function requireManagement(req, res, next) {
  if (hasRole(req.user, 'system_admin') || hasRole(req.user, 'management')) return next();
  return res.status(403).json({ error: '需要管理人员权限' });
}

function requireDataAdministrator(req, res, next) {
  if (hasRole(req.user, 'system_admin') || hasRole(req.user, 'data_administrator')) return next();
  return res.status(403).json({ error: '需要数据管理员权限' });
}

function requireFieldContributor(req, res, next) {
  if (hasRole(req.user, 'system_admin') || hasRole(req.user, 'data_administrator') || hasRole(req.user, 'template_designer')) return next();
  return res.status(403).json({ error: '需要模板设计或数据管理员权限' });
}

function requireRuleContributor(req, res, next) {
  if (hasRole(req.user, 'system_admin') || hasRole(req.user, 'business_rule_administrator') || hasRole(req.user, 'business_rule_reviewer')) return next();
  return res.status(403).json({ error: '需要业务规则管理员或复核员权限' });
}

function requireRuleCatalogReader(req, res, next) {
  if (hasRole(req.user, 'system_admin') || hasRole(req.user, 'business_rule_administrator') || hasRole(req.user, 'business_rule_reviewer') || hasRole(req.user, 'template_designer')) return next();
  return res.status(403).json({ error: '需要模板设计或业务规则权限' });
}

function requireRuleAdministrator(req, res, next) {
  if (hasRole(req.user, 'system_admin') || hasRole(req.user, 'business_rule_administrator')) return next();
  return res.status(403).json({ error: '需要业务规则管理员权限' });
}

function requireRuleReviewer(req, res, next) {
  if (hasRole(req.user, 'system_admin') || hasRole(req.user, 'business_rule_reviewer')) return next();
  return res.status(403).json({ error: '需要业务规则复核员权限' });
}

function hasRole(user, code) {
  return (user?.roles || []).some(role => role.code === code);
}

module.exports = {
  authenticateToken,
  checkPermission,
  requireOrganizationAdmin,
  requireSystemAdmin,
  requireManagement,
  requireDataAdministrator,
  requireFieldContributor,
  requireRuleContributor,
  requireRuleCatalogReader,
  requireRuleAdministrator,
  requireRuleReviewer,
  hasRole,
  hasCapability,
  JWT_SECRET
};
