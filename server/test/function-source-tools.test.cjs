const test = require('node:test');
const assert = require('node:assert/strict');
const { readEvaluateSignature, readFunctionIdentity, editFunctionSource, addSerialization } = require('../src/services/functionSignature');
const { assertFunctionIdentityAvailable } = require('../src/services/functionIdentity');
const source = `class Total extends GC.Spread.CalcEngine.Functions.Function {
  constructor() { super("MY_TOTAL", 1, 2); this.typeName = "CustomFunctions.Total"; this.factor = 3; }
  evaluate(value, extra = 0) { /* keep { braces } and names */ return (value + extra) * this.factor; }
  toJSON() { return { typeName: this.typeName, factor: this.factor }; }
  fromJSON(settings) { this.factor = settings.factor; }
}`;
const expression = code => ({ engine: 'spreadjs-function', sourceCode: code });

test('named classes preserve evaluate defaults, serializers and business properties on rename', () => {
  const changed = editFunctionSource(source, { className: 'Amount', functionName: 'MY_AMOUNT' });
  assert.equal(changed.typeName, 'CustomFunctions.Amount');
  assert.equal(changed.className, 'Amount');
  assert.equal(changed.functionName, 'MY_AMOUNT');
  assert.ok(changed.code.includes('return (value + extra) * this.factor;'));
  assert.ok(changed.code.includes('fromJSON(settings) { this.factor = settings.factor; }'));
  const signature = readEvaluateSignature(changed.code);
  assert.equal(signature.className, 'Amount');
  assert.deepEqual(signature.parameters.map(p => p.optional), [false, true]);
  assert.equal(addSerialization(changed.code), changed.code);
});
test('all optional methods insert once without replacing calculations', () => {
  let code = source;
  for (const method of ['description','acceptsArray','acceptsReference','acceptsError','acceptsMissingArgument','isVolatile','isContextSensitive','supportCalcWorker']) {
    code = editFunctionSource(code, { method }).code;
    assert.ok(readFunctionIdentity(code).methods.includes(method));
    assert.throws(() => editFunctionSource(code, { method }), /已存在/);
    assert.ok(code.includes('return (value + extra) * this.factor;'));
  }
  assert.throws(() => editFunctionSource(code, { method: 'constructor' }), /已存在/);
  assert.throws(() => editFunctionSource(code, { method: '__proto__' }), /不支持/);
});
test('reject ambiguous classes, dynamic names, reserved names and unsafe rename references', () => {
  assert.throws(() => readEvaluateSignature(source + source.replaceAll('Total', 'Other')), /只声明一个/);
  assert.throws(() => readFunctionIdentity(source.replace('"MY_TOTAL"', 'getName()'), true), /固定/);
  assert.throws(() => editFunctionSource(source, { className: 'default', functionName: 'MY_NEW' }));
  assert.throws(() => editFunctionSource(source, { className: 'GC', functionName: 'MY_NEW' }));
  assert.throws(() => editFunctionSource(source.replace('return (value', 'const self = Total; return (value'), { className: 'NewTotal', functionName: 'MY_NEW' }), /引用/);
});
test('legacy serializer upgrade uses actual class name and preserves added properties', () => {
  const upgraded = addSerialization('class Amount extends GC.Spread.CalcEngine.Functions.Function { constructor() { super("AMOUNT"); this.factor = 4; } evaluate(value) { return value * this.factor; } }');
  assert.equal(readFunctionIdentity(upgraded, true).typeName, 'CustomFunctions.Amount');
  assert.ok(upgraded.includes('factor: this.factor'));
});
test('collision detection covers raw legacy drafts, all three names and case variations; same rule can version', async () => {
  const rows = [{ ruleId: 12, displayName: '金额', expression_json: JSON.stringify(expression(source)) }];
  const query = async (_, [exclude]) => rows.filter(row => row.ruleId !== exclude);
  for (const code of [
    source.replaceAll('Total', 'Other'),
    source.replace('MY_TOTAL', 'DIFFERENT').replace('CustomFunctions.Total', 'OtherNamespace.Type'),
    source.replace('class Total', 'class Another').replace('MY_TOTAL', 'DIFFERENT'),
    source.replace('MY_TOTAL', 'my_total').replaceAll('Total', 'Other'),
  ]) await assert.rejects(assertFunctionIdentityAvailable(expression(code), null, query), { status: 409 });
  await assertFunctionIdentityAvailable(expression(source), 12, query);
  await assertFunctionIdentityAvailable(expression(editFunctionSource(source, { className: 'Unique', functionName: 'UNIQUE' }).code), null, query);
});
