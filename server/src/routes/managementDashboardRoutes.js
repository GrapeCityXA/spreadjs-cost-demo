const express = require('express');
const router = express.Router();
const controller = require('../controllers/managementDashboardController');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);
router.get('/', controller.getDashboard);
router.get('/overview', controller.getOverview);
router.get('/tasks/:taskId/snapshot', controller.getTaskSnapshot);

module.exports = router;
