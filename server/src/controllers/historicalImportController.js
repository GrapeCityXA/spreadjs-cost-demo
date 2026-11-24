const historicalImports = require('../services/historicalImports');

exports.getOptions = async (req, res) => {
  try { res.json(await historicalImports.getImportOptions()); }
  catch (error) { res.status(500).json({ error: '读取历史导入选项失败' }); }
};

exports.preview = async (req, res) => {
  let rows;
  try { rows = JSON.parse(req.body.rows || ''); }
  catch { return res.status(400).json({ error: '导入行格式无效' }); }
  try {
    const result = await historicalImports.preview({ actor: req.user, reportTypeId: Number(req.body.reportTypeId),
      periodCode: req.body.periodCode, sourceName: req.file?.originalname, fileBuffer: req.file?.buffer, rows });
    res.status(201).json(result);
  } catch (error) { res.status(error.status || 500).json({ error: error.message || '历史数据预览失败' }); }
};

exports.confirm = async (req, res) => {
  try { res.json(await historicalImports.confirm({ actor: req.user, batchId: Number(req.params.batchId) })); }
  catch (error) { res.status(error.status || 500).json({ error: error.message || '确认历史数据导入失败' }); }
};
