const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { evaluateExpression, resultsEqual } = require('../src/services/ruleEvaluator');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rule-formula-parity.json'), 'utf8'));

test('browser and backend evaluators agree on supported governed formula fixtures', async () => {
  const { evaluateBusinessExpression } = await import('../../src/utils/formulaEvaluator.js');
  for (const vector of vectors) {
    const backend = evaluateExpression(vector.expression, vector.input, vector.parameters);
    const browser = evaluateBusinessExpression(vector.expression, vector.input, vector.parameters);
    assert.ok(resultsEqual(backend, vector.expected), `${vector.name}: backend expected ${vector.expected}, got ${backend}`);
    assert.ok(resultsEqual(browser, vector.expected), `${vector.name}: browser expected ${vector.expected}, got ${browser}`);
    assert.ok(resultsEqual(backend, browser), `${vector.name}: backend and browser diverged`);
  }
});

test('both evaluators reject invalid operator arity and executable syntax', async () => {
  const { evaluateBusinessExpression } = await import('../../src/utils/formulaEvaluator.js');
  const invalid = [
    { op: 'abs', args: [1, 2] },
    { op: 'execute', args: ['return process.env'] },
    { op: 'field', name: 'A1' }
  ];
  for (const expression of invalid) {
    assert.throws(() => evaluateExpression(expression, {}, {}));
    assert.throws(() => evaluateBusinessExpression(expression, {}, {}));
  }
});
