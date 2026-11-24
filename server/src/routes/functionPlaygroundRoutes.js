const router = require('express').Router();
const { authenticateToken, requireRuleCatalogReader } = require('../middleware/auth');
const { validateRequest, runPlayground } = require('../services/functionPlayground');

const activeUsers = new Set();
router.use(authenticateToken, requireRuleCatalogReader);
router.post('/source-tools', async (req, res) => {
  try {
    const { readFunctionIdentity, editFunctionSource } = require('../services/functionSignature');
    const { code, changes, ruleId } = req.body || {};
    const result = changes ? editFunctionSource(code, changes) : { code, ...readFunctionIdentity(code) };
    let conflict = '';
    if (result.functionName && result.typeName) {
      const db = require('../config/database');
      const query = (sql, params) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
      try { await require('../services/functionIdentity').assertFunctionIdentityAvailable({ engine: 'spreadjs-function', sourceCode: result.code }, Number(ruleId) || 0, query); }
      catch (error) { if (error.status !== 409) throw error; conflict = error.message; }
    }
    if (changes && conflict) return res.status(409).json({ error: conflict });
    res.json({ ...result, conflict });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
router.post('/serialization-template', (req, res) => {
  try { res.json({ code: require('../services/functionSignature').addSerialization(req.body?.code) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
router.post('/run', async (req, res) => {
  let payload;
  try { payload = validateRequest(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
  const user = req.user.id;
  if (activeUsers.has(user) || activeUsers.size >= 2) return res.status(429).json({ error: '已有测试正在运行，请停止或稍后重试' });
  activeUsers.add(user);
  const controller = new AbortController();
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', disconnected);
  try {
    const result = await runPlayground(payload, controller.signal);
    if (!res.destroyed) res.json(result);
  } catch (error) {
    if (!res.destroyed) res.status(503).json({ error: error.name === 'AbortError' ? '运行已停止' : '独立测试环境启动失败。请确认服务端已安装 Chromium（在 server 目录运行 npx playwright install chromium）并配置本地 SpreadJS 授权。' });
  } finally {
    res.off('close', disconnected);
    activeUsers.delete(user);
  }
});
module.exports = router;
