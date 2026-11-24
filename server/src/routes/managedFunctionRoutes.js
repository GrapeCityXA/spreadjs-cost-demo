const router = require('express').Router();
const { authenticateToken } = require('../middleware/auth');
const { loadPublishedDefinitions } = require('../services/managedFunctions');

router.use(authenticateToken);
// Only administrator-published versions may execute in the authenticated UI.
// Saved workbook JSON supplies version references/state, never executable code.
router.post('/definitions', async (req, res) => {
  const ids = req.body?.versionIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100
    || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ error: '自定义函数版本列表无效' });
  try { res.json({ definitions: await loadPublishedDefinitions([...new Set(ids)]) }); }
  catch (error) { res.status(error.status || 422).json({ error: error.message }); }
});

module.exports = router;
