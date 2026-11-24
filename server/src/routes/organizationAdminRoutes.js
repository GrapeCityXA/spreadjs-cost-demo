const express = require('express');
const router = express.Router();
const controller = require('../controllers/organizationAdminController');
const { authenticateToken, requireOrganizationAdmin, requireSystemAdmin } = require('../middleware/auth');
const { recordRejectedAdminRequest } = require('../services/businessAudit');

router.use(recordRejectedAdminRequest, authenticateToken, requireOrganizationAdmin);
router.get('/audit-events/export', controller.exportAuditEvents);
router.get('/audit-events', controller.listAuditEvents);
router.get('/organizations', controller.listOrganizations);
router.post('/organizations', controller.createOrganization);
router.patch('/organizations/:id', controller.updateOrganization);
router.get('/users', controller.listUsers);
router.get('/roles', controller.listRoles);
router.post('/roles', requireSystemAdmin, controller.saveRole);
router.patch('/roles/:code', requireSystemAdmin, controller.saveRole);
router.post('/users', controller.createUser);
router.patch('/users/:id', controller.updateUser);
router.put('/users/:id/roles', controller.replaceUserRoles);
router.post('/users/:id/reset-password', controller.resetPassword);

module.exports = router;
