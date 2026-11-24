const express = require('express');
const router = express.Router();
const controller = require('../controllers/taskOperationsController');
const { authenticateToken, requireManagement } = require('../middleware/auth');

router.use(authenticateToken);
router.get('/notifications', controller.listNotifications);
router.post('/notifications/:notificationId/read', controller.markNotificationRead);
router.use(requireManagement);
router.get('/progress', controller.listProgress);
router.get('/tasks/:taskId/assignees', controller.listAssignees);
router.put('/report-types/:reportTypeId/reminders', controller.updateReminderSchedule);
router.post('/tasks/:taskId/reassign', controller.reassign);
router.post('/tasks/:taskId/extend-deadline', controller.extendDeadline);
router.post('/tasks/:taskId/cancel', controller.cancel);

module.exports = router;
