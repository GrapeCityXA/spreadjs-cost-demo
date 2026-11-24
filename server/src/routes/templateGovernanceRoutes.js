const express = require('express');
const router = express.Router();
const controller = require('../controllers/templateGovernanceController');
const { authenticateToken, checkPermission, requireSystemAdmin } = require('../middleware/auth');

router.use(authenticateToken, checkPermission('template'));
router.get('/permission-options', controller.permissionOptions);
router.get('/components', controller.listComponents);
router.post('/components', controller.createComponent);
router.post('/components/:id/versions', controller.createComponentVersion);
router.put('/components/versions/:versionId', controller.updateComponentVersion);
router.post('/components/:id/versions/:versionId/submit', controller.submitComponent);
router.post('/components/:id/versions/:versionId/review', requireSystemAdmin, controller.reviewComponent);
router.get('/templates', controller.listTemplates);
router.post('/templates', controller.createTemplate);
router.post('/templates/import-quarterly-reference', controller.importQuarterlyReferenceDraft);
router.get('/templates/versions/:versionId', controller.getTemplate);
router.get('/templates/versions/:versionId/publication-checks', controller.validateTemplate);
router.get('/templates/versions/:versionId/role-preview', controller.previewTemplateRole);
router.put('/templates/versions/:versionId', controller.updateTemplateVersion);
router.post('/templates/:id/versions', controller.createTemplateVersion);
router.post('/templates/:id/versions/:versionId/submit', controller.submitTemplate);
router.post('/templates/:id/versions/:versionId/review', requireSystemAdmin, controller.reviewTemplate);

module.exports = router;
