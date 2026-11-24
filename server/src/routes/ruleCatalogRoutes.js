const express = require('express');
const controller = require('../controllers/ruleCatalogController');
const { authenticateToken, requireRuleContributor, requireRuleCatalogReader, requireRuleAdministrator, requireSystemAdmin } = require('../middleware/auth');
const { recordRejectedAdminRequest } = require('../services/businessAudit');

const router = express.Router();
router.use(recordRejectedAdminRequest);
router.use(authenticateToken);
router.get('/catalog', requireRuleCatalogReader, controller.catalog);
router.get('/:ruleId/versions', requireRuleContributor, controller.versions);
router.post('/', requireRuleAdministrator, controller.create);
router.post('/:ruleId/versions', requireRuleAdministrator, controller.createVersion);
router.patch('/versions/:versionId', requireRuleAdministrator, controller.updateDraft);
router.post('/versions/:versionId/test', requireRuleAdministrator, controller.test);
router.post('/versions/:versionId/submit', requireRuleAdministrator, controller.submit);
router.post('/versions/:versionId/publish', requireSystemAdmin, controller.publish);
router.post('/versions/:versionId/reject', requireSystemAdmin, controller.reject);
router.post('/evaluate/:versionId?', controller.evaluate);
module.exports = router;
