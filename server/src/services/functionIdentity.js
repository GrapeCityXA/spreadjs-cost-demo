const { readFunctionIdentity } = require('./functionSignature');

function identityOf(expression) {
  if (expression?.engine !== 'spreadjs-function') return null;
  try { return readFunctionIdentity(expression.sourceCode); }
  catch { return { className: expression.className, functionName: expression.functionName, typeName: expression.typeName }; }
}

async function assertFunctionIdentityAvailable(expression, ruleId, query) {
  if (expression?.engine !== 'spreadjs-function') return;
  const identity = readFunctionIdentity(expression.sourceCode, true);
  const rows = await query(`SELECT d.id AS ruleId, d.display_name AS displayName, v.expression_json
    FROM rule_definitions d JOIN rule_versions v ON v.rule_id = d.id WHERE d.id <> ?`, [ruleId || 0]);
  for (const row of rows) {
    let other;
    try { other = identityOf(JSON.parse(row.expression_json)); } catch { continue; }
    if (!other) continue;
    for (const [key, label] of [['functionName', '函数名'], ['className', 'class 名'], ['typeName', '序列化类型名']]) {
      if (identity[key] && other[key] && identity[key].toUpperCase() === other[key].toUpperCase()) {
        throw Object.assign(Error(`${label} ${identity[key]} 已被「${row.displayName}」使用，请更换名称；同一公式请创建新版本`), { status: 409 });
      }
    }
  }
  return identity;
}

module.exports = { assertFunctionIdentityAvailable };
