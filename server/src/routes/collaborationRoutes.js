const express = require('express');
const router = express.Router();
const controller = require('../controllers/collaborationController');
const { authenticateToken, requireManagement, requireSystemAdmin } = require('../middleware/auth');

router.use(authenticateToken);
router.get('/tasks', controller.listMonthlyTasks);
router.get('/review-tasks', controller.listMonthlyReviewTasks);
router.get('/finalized-tasks', controller.listFinalizedTasks);
router.get('/reference-report', controller.getMonthlyReferenceReport);
router.get('/tasks/:taskId/review', controller.getMonthlyReview);
router.post('/tasks/:taskId/finalize', controller.finalizeMonthlyTask);
router.get('/tasks/:taskId/revisions', controller.listFinalizedRevisions);
router.get('/tasks/:taskId/revisions/:revisionId', controller.getFinalizedRevision);
router.get('/tasks/:taskId/revisions/:revisionId/artifacts/:artifactType', controller.downloadFinalizedArtifact);
router.get('/tasks/:taskId/room', controller.getRoom);
router.post('/tasks/:taskId/attachments', controller.uploadEvidenceAttachment);
router.get('/tasks/:taskId/attachments/:attachmentId/download', controller.downloadEvidenceAttachment);
router.post('/tasks/:taskId/submit', controller.submitTask);
router.post('/tasks/:taskId/withdraw', controller.withdrawTask);
router.get('/tasks/:taskId/adjustment-fields', controller.getAdjustmentFields);
router.post('/tasks/:taskId/adjustments', controller.startMonthlyAdjustment);
router.post('/tasks/:taskId/adjustment-decision', controller.decideMonthlyAdjustment);
router.post('/tasks/:taskId/adjustment-impacts/:impactId/confirm', controller.confirmQuarterlyAdjustmentImpact);
router.post('/tasks/:taskId/review-opinions', controller.saveReviewOpinion);
router.post('/tasks/:taskId/anomalies/:anomalyId/disposition', controller.saveAnomalyDisposition);
// Backend recovery: explicit room management and persisted snapshot inspection.
router.post('/tasks/:taskId/room/lifecycle', requireManagement, controller.updateRoomLifecycle);
router.get('/tasks/:taskId/history', controller.getRoomHistory);
router.get('/tasks/:taskId/history/:version', controller.getHistorySnapshot);

module.exports = router;
