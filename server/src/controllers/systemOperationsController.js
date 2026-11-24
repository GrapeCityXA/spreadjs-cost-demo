const db = require('../config/database');
const checkpoints = require('../services/checkpointBackups');
const showcaseReset = require('../services/showcaseReset');
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(error => {
  if (res.headersSent) return next(error);
  return res.status(error.status || 500).json({ error: error.message || '系统运维操作失败' });
});

exports.listCheckpoints = asyncRoute(async (_req, res) => {
  res.json({ checkpoints: await checkpoints.listCheckpoints() });
});

exports.createCheckpoint = asyncRoute(async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) return res.status(400).json({ error: '创建检查点必须填写原因' });
  const checkpoint = await checkpoints.createCheckpoint({ actor: req.user, reason });
  res.status(201).json(checkpoint);
});

exports.retryCheckpoint = asyncRoute(async (req, res) => {
  res.json(await checkpoints.retryCheckpoint({ checkpointId: req.params.checkpointId, actor: req.user,
    reason: req.body?.reason, finalization: req.body?.finalization }));
});

exports.compactCollaboration = asyncRoute(async (req, res) => {
  const retentionDays = req.body?.retentionDays === undefined ? 90 : Number(req.body.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 90) return res.status(400).json({ error: '原始协作操作至少保留 90 天' });
  res.json(await checkpoints.compactCollaborationOperations({ actor: req.user, retentionDays }));
});

exports.resetShowcase = asyncRoute(async (req, res) => {
  const result = await showcaseReset.resetShowcase({ actor: req.user, reason: 'Manual showcase reset API' });
  res.json(result);
});

exports.cleanEmptyRooms = asyncRoute(async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) return res.status(400).json({ error: '清理协作室必须填写原因' });
  res.json(await checkpoints.cleanEmptyCollaborationRooms({ actor: req.user, reason }));
});

exports._test = { getDatabase: () => db };
