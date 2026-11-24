const isNativeRule = expression => expression?.engine === 'spreadjs-validator';
function validateNativeDefinition(expression) {
  const invalid = () => { throw Object.assign(new Error('单元格校验配置无效，请在可视化编辑器重新保存'), { status: 400 }); };
  if (!isNativeRule(expression) || expression.version !== 1 || !expression.validator || !expression.config) invalid();
  if (!['number','integer','date','textLength','list','formulaList','formula'].includes(expression.config.type)) invalid();
  if (!Number.isInteger(expression.validator.type) || expression.validator.type < 0 || expression.validator.type > 7 || !expression.validator.condition) invalid();
  if (![0,1,2].includes(expression.config.errorStyle)) invalid();
  if (JSON.stringify(expression).length > 16000) invalid();
  const inspect = (node, depth = 0) => {
    if (depth > 32) invalid();
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) { if (['__proto__','constructor','prototype','typeName'].includes(key)) invalid(); inspect(value,depth+1); }
  };
  inspect(expression);
}
module.exports = { isNativeRule, validateNativeDefinition };
