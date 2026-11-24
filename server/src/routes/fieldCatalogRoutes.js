const express = require('express');
const controller = require('../controllers/fieldCatalogController');
const { authenticateToken, requireDataAdministrator, requireFieldContributor, requireSystemAdmin } = require('../middleware/auth');
const { recordRejectedAdminRequest } = require('../services/businessAudit');

const router = express.Router();
router.use('/admin', recordRejectedAdminRequest);
router.use(authenticateToken);

router.get('/catalog', requireFieldContributor, controller.catalog);
router.get('/drafts', requireFieldContributor, controller.listDrafts);
router.post('/drafts', requireFieldContributor, controller.createDraft);
router.patch('/drafts/:draftId', requireFieldContributor, controller.correctDraft);

router.post('/admin/drafts/:draftId/approve', requireSystemAdmin, controller.approveDraft);
router.post('/admin/drafts/:draftId/reject', requireSystemAdmin, controller.rejectDraft);
router.post('/admin/fields/:fieldId/supersede', requireDataAdministrator, controller.supersede);
router.get('/admin/fields/:fieldId/versions', requireDataAdministrator, controller.versions);

// Backend administration: retained for typed-value maintenance without a UI entry.
router.post('/admin/values', requireDataAdministrator, controller.writeValue);
router.get('/admin/values', requireDataAdministrator, controller.readValues);

module.exports = router;
