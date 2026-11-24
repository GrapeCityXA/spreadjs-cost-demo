const express = require('express');
const router = express.Router();
const controller = require('../controllers/periodConfigurationController');
const { authenticateToken, requireManagement } = require('../middleware/auth');

router.use(authenticateToken, requireManagement);
router.get('/resources', controller.listResources);
router.get('/report-types', controller.listReportTypes);
router.post('/report-types', controller.createReportType);
router.get('/packages', controller.listPackages);
router.post('/packages', controller.createPackage);
router.put('/packages/:id', controller.updatePackage);
router.post('/packages/:id/validate', controller.validatePackage);
router.post('/packages/:id/activate', controller.activatePackage);

module.exports = router;
