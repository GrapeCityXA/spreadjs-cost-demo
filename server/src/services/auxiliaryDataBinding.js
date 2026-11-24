// Store only the declared remote read contract. Never fetch URLs on the server.
function normalizeAuxiliaryBinding(value) {
  if (value == null) return null;
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (value.engine !== 'datamanager') fail('辅助表数据绑定类型无效');
  const url = String(value.url || '').trim(), dataPath = String(value.dataPath || '').trim();
  let parsed;
  try { parsed = new URL(url); } catch { fail('请输入完整的 HTTP 或 HTTPS 接口 URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length > 2000) fail('辅助表接口 URL 无效');
  if (dataPath.length > 200 || dataPath && !/^[\w$]+(?:\.[\w$]+)*$/.test(dataPath)
    || dataPath.split('.').some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) fail('辅助表响应数据路径无效');
  if (Object.keys(value).some(key => !['engine', 'url', 'dataPath'].includes(key))) fail('辅助表只允许配置 GET 接口及响应路径，不能保存接口数据或写回操作');
  return { engine: 'datamanager', url, dataPath };
}
module.exports = { normalizeAuxiliaryBinding };
