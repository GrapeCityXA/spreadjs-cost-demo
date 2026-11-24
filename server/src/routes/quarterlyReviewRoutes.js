const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const multer = require('multer');
const router = express.Router();
const controller = require('../controllers/quarterlyReviewController');
const { authenticateToken } = require('../middleware/auth');
const uploadDirectory = path.join(os.tmpdir(), 'quarterly-review-uploads');
fs.mkdirSync(uploadDirectory, { recursive: true });
const uploadArtifacts = multer({ dest: uploadDirectory, limits: { fileSize: 25 * 1024 * 1024, files: 40 } });

router.use(authenticateToken);
router.get('/tasks', controller.listTasks);
router.get('/packages/:packageId/official-report', controller.getPackageReport);
router.get('/tasks/:taskId', controller.getTask);
router.post('/tasks/:taskId/indicators/:indicatorId/review', controller.saveReview);
router.post('/tasks/:taskId/indicators/:indicatorId/score', controller.saveScore);
router.post('/tasks/:taskId/adjustments', controller.addAdjustment);
router.post('/tasks/:taskId/adjustments/:adjustmentId/decision', controller.decideAdjustment);
router.post('/tasks/:taskId/finalize', uploadArtifacts.array('artifacts', 40), controller.finalize);

module.exports = router;
