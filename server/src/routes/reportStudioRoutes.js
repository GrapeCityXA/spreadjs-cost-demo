const router = require('express').Router();
const fs = require('node:fs/promises');
const path = require('node:path');
const service = require('../services/reportStudio');
const multer = require('multer');
router.use(require('../middleware/auth').authenticateToken);
const handle = fn => async (req, res) => { try { await service.initialize(); await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
const resultUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 3, fields: 20 } }).fields([
  { name: 'workbook', maxCount: 1 }, { name: 'xlsx', maxCount: 1 }, { name: 'pdf', maxCount: 1 }]);
router.get('/', handle(async (req, res) => res.json(await service.list(req.user))));
router.get('/design-source/:reportTypeId', handle(async (req, res) => res.json(await service.designSource(req.user, req.params.reportTypeId))));
router.get('/design-data/:reportTypeId/:tableName', handle(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await service.designData(req.user, req.params.reportTypeId, req.params.tableName, req.query.legacy === 'true'));
}));

router.get('/templates/:id', handle(async (req, res) => res.json(await service.template(req.user, req.params.id))));
router.post('/templates', handle(async (req, res) => res.json(await service.saveTemplate(req.user, req.body))));
router.post('/templates/:id/:action', handle(async (req, res) => res.json(await service.transition(req.user, req.params.id, req.params.action, req.body.note))));
router.post('/render-data', handle(async (req, res) => res.json(await service.prepareRender(req.user, req.body))));
router.post('/results', (req, res) => resultUpload(req, res, async error => {
  if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '报表成果文件超过 50 MB' : '报表成果上传失败' });
  try { await service.initialize(); res.json(await service.uploadResult(req.user, req.body, req.files)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}));
router.post('/jobs', handle(async (req, res) => { const result = await service.enqueue(req.user, req.body); res.status(202).json(result); service.tick().catch(e => console.error(e.message)); }));
router.post('/schedules', handle(async (req, res) => res.json(await service.saveSchedule(req.user, req.body))));
router.patch('/schedules/:id', handle(async (req, res) => res.json(await service.toggleSchedule(req.user, req.params.id, req.body.enabled === true))));
router.get('/jobs/:id', handle(async (req, res) => { const job = await service.jobFor(req.user, req.params.id); res.json({ ...job, path: undefined }); }));
router.get('/jobs/:id/:format', handle(async (req, res) => {
  const job = await service.jobFor(req.user, req.params.id);
  const format = req.params.format;
  const files = { json: 'workbook.json', xlsx: 'report.xlsx', pdf: 'report.pdf' };
  if (!files[format]) return res.status(400).json({ error: '不支持的文件格式' });
  if (job.status !== 'complete' || !job.path) return res.status(409).json({ error: '报表尚未生成完成' });
  const file = path.join(job.path, files[format]);
  if (format === 'json') return res.json(JSON.parse(await fs.readFile(file, 'utf8')));
  res.download(file, `${job.name}-${job.query.periodCode}-v${job.version}.${format}`);
}));
module.exports = router;
