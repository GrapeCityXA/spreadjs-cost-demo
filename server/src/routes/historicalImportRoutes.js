const express = require('express');
const multer = require('multer');
const controller = require('../controllers/historicalImportController');
const { authenticateToken, requireDataAdministrator } = require('../middleware/auth');
const { recordRejectedAdminRequest } = require('../services/businessAudit');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const router = express.Router();
router.use(recordRejectedAdminRequest);
router.use(authenticateToken, requireDataAdministrator);
router.get('/options', controller.getOptions);
router.post('/preview', upload.single('file'), controller.preview);
router.post('/:batchId/confirm', controller.confirm);

module.exports = router;
