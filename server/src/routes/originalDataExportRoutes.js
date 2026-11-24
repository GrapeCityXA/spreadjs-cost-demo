const express = require('express');
const controller = require('../controllers/originalDataExportController');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken);
router.get('/periods', controller.periods);
router.get('/packages/:packageId/organizations', controller.organizations);
router.get('/raw-data.xlsx', controller.rawData);
router.post('/jobs', controller.createJob);
router.get('/jobs', controller.listJobs);
router.post('/jobs/:jobId/retry', controller.retryJob);
router.get('/jobs/:jobId/download', controller.downloadJob);

module.exports = router;
