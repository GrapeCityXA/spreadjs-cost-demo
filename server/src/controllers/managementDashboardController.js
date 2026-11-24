const dashboard = require('../services/managementDashboard');
const operations = require('../services/operationsDashboard').createOperationsDashboard(require('../config/database'));

const handle = operation => async (req, res) => {
  try { res.json(await operation(req)); }
  catch (error) { res.status(error.status || 500).json({ error: error.message || '获取经营仪表盘失败' }); }
};

exports.getDashboard = handle(req => dashboard.getDashboard(req.user, {
  periodCode: req.query.period,
  organizationId: req.query.organizationId,
  category: req.query.category
}));
exports.getOverview = handle(req => operations.overview(req.user));
exports.getTaskSnapshot = handle(req => operations.detail(req.user, Number(req.params.taskId), Number(req.query.revisionId)));
