const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');

// 公开路由
router.post('/login', authController.login);

// 需要认证的路由
router.get('/me', authenticateToken, authController.getCurrentUser);

module.exports = router;
