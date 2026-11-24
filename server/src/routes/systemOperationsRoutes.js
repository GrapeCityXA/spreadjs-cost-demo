const express = require('express');
const router = express.Router();
const controller = require('../controllers/systemOperationsController');
const { authenticateToken, requireSystemAdmin } = require('../middleware/auth');

router.post('/showcase-reset', controller.resetShowcase);
router.use(authenticateToken, requireSystemAdmin);
router.get('/checkpoints', controller.listCheckpoints);
router.post('/checkpoints', controller.createCheckpoint);
router.post('/checkpoints/:checkpointId/retry', controller.retryCheckpoint);
router.post('/collaboration/compact', controller.compactCollaboration);
router.post('/collaboration/empty-rooms/cleanup', controller.cleanEmptyRooms);

module.exports = router;
