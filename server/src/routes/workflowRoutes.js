const router = require('express').Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const service = require('../services/workflowCenter').createWorkflowCenter(db);
router.use(authenticateToken);
router.get('/', async (req, res, next) => { try { await require('../services/reportStudio').initialize(); res.json(await service.list(req.user)); } catch (error) { next(error); } });
module.exports = router;
