const express = require('express');
const router = express.Router();
const dataQueryController = require('../controllers/dataQueryController');
const { authenticateToken } = require('../middleware/auth');

// 所有数据查询路由需要认证
router.use(authenticateToken);

// 查询tableData数据
// GET /api/data/query?templateId=1&month=2026-01&project1=生产指标&project2=产量&fields=unit,yearPlan,currentMonth
router.get('/query', dataQueryController.queryTableData);

module.exports = router;
