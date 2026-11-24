const review = require('../services/quarterlyReviewScoring');
const quarterlyReferenceReport = require('../services/quarterlyReferenceReport');
const fs = require('node:fs/promises');

const handle = operation => async (req, res) => {
  try { res.json(await operation(req)); }
  catch (error) { res.status(error.status || 500).json({ error: error.message || '季度审核请求失败' }); }
};

exports.listTasks = handle(async req => ({ tasks: await review.listQuarterlyReviewTasks(req.user) }));
exports.getTask = handle(req => review.getQuarterlyReview(Number(req.params.taskId), req.user,
  { includeWorkbook: req.query.includeWorkbook !== 'false' }));
exports.getPackageReport = handle(req => quarterlyReferenceReport.loadQuarterlyReferenceReport(Number(req.params.packageId), req.user));
exports.saveReview = handle(req => review.saveIndicatorReview({ taskId: Number(req.params.taskId),
  indicatorId: Number(req.params.indicatorId), actor: req.user, expectedVersion: req.body.expectedVersion,
  status: req.body.status, opinion: req.body.opinion, remediationDeadline: req.body.remediationDeadline }));
exports.saveScore = handle(req => review.saveIndicatorScore({ taskId: Number(req.params.taskId),
  indicatorId: Number(req.params.indicatorId), actor: req.user, expectedVersion: req.body.expectedVersion,
  score: req.body.score, comment: req.body.comment }));
exports.addAdjustment = handle(req => review.addAdjustment({ taskId: Number(req.params.taskId), actor: req.user,
  adjustmentType: req.body.adjustmentType, amount: req.body.amount, reason: req.body.reason }));
exports.decideAdjustment = handle(req => review.decideAdjustment({ taskId: Number(req.params.taskId),
  adjustmentId: Number(req.params.adjustmentId), actor: req.user, decision: req.body.decision, note: req.body.note }));
exports.finalize = async (req, res) => {
  const files = req.files || [];
  try {
    const artifactFiles = files.map(file => {
      const match = /^(\d+)\.(xlsx|pdf)$/i.exec(file.originalname);
      if (!match) throw Object.assign(new Error('每个季度任务都必须提供以任务编号命名的 XLSX 和 PDF'), { status: 400 });
      return { taskId: Number(match[1]), type: match[2].toLowerCase(), path: file.path };
    });
    for (const file of artifactFiles) {
      const signature = Buffer.alloc(file.type === 'xlsx' ? 4 : 5);
      const handle = await fs.open(file.path, 'r');
      await handle.read(signature, 0, signature.length, 0);
      await handle.close();
      const valid = file.type === 'xlsx'
        ? signature[0] === 0x50 && signature[1] === 0x4b
        : signature.toString('ascii') === '%PDF-';
      if (!valid) throw Object.assign(new Error(`${file.type.toUpperCase()} 文件格式无效`), { status: 400 });
    }
    res.json(await review.finalizeQuarterlyTask({ taskId: Number(req.params.taskId), actor: req.user, artifactFiles }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '季度定稿失败' });
  } finally {
    await Promise.all(files.map(file => fs.rm(file.path, { force: true }).catch(() => {})));
  }
};
