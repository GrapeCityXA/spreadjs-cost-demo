const assert = require('node:assert/strict');
const { test } = require('node:test');
const { evaluateGovernedFormulas } = require('../src/services/formulaPrecheck');

test('system calculation without a governed formula blocks precheck before submission', () => {
  const mapping = { kind: 'calc', fieldCode: 'EXPERIENCE_AMOUNT_A', displayName: '手工体验金额 A',
    namedArea: 'MAIN_BODY_CALC_EXPERIENCE_AMOUNT_A' };
  const rule = { id: 3, code: 'AMOUNT', expression_json: '100.25', parameters_json: '{}' };
  for (const variant of [mapping, { ...mapping, formulaVersionId: 99, formulaSource: 'AMOUNT' },
    { ...mapping, formulaVersionId: 3, formulaSource: 'OTHER' }]) {
    const issues = evaluateGovernedFormulas([rule], [variant], new Map([[variant, 100.25]]), {});
    assert.ok(issues.some(issue => issue.code === 'formula_unavailable' && issue.mapping === variant));
    assert.match(issues[0].message, /手工体验金额 A.*手工填报/);
  }
  const valid = { ...mapping, formulaVersionId: 3, formulaSource: 'AMOUNT' };
  const input = {};
  assert.deepEqual(evaluateGovernedFormulas([rule], [valid], new Map([[valid, 100.25]]), input), []);
  assert.equal(input.EXPERIENCE_AMOUNT_A, 100.25);
  assert.deepEqual(evaluateGovernedFormulas([], [{ ...mapping, kind: 'input',
    namedArea: 'MAIN_BODY_INPUT_EXPERIENCE_AMOUNT_A' }], new Map(), {}), []);
});

test('governed formula precheck compares workbook values with server calculations', () => {
  const mapping = { fieldCode: 'netRevenue', formulaVersionId: 3, displayName: '净收入' };
  const rule = { id: 3, code: 'NET_REVENUE', expression_json: JSON.stringify({ field: 'revenue' }), parameters_json: '{}' };
  const input = { revenue: 120 };

  assert.deepEqual(evaluateGovernedFormulas([rule], [mapping], new Map([[mapping, 120]]), input), []);
  assert.equal(input.netRevenue, 120);

  const mismatch = evaluateGovernedFormulas([rule], [mapping], new Map([[mapping, 119]]), { revenue: 120 });
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0].code, 'formula_result_mismatch');
  assert.equal(mismatch[0].value, 119);
});

test('governed formulas resolve mapped formula dependencies before downstream formulas', () => {
  const downstream = { fieldCode: 'doubleTotal', formulaVersionId: 4 };
  const source = { fieldCode: 'total', formulaVersionId: 5 };
  const formulas = [
    { id: 4, code: 'DOUBLE_TOTAL', expression_json: JSON.stringify({ op: 'multiply', args: [{ field: 'total' }, 2] }), parameters_json: '{}' },
    { id: 5, code: 'TOTAL', expression_json: JSON.stringify({ op: 'add', args: [{ field: 'revenue' }, { field: 'profit' }] }), parameters_json: '{}' }
  ];
  const input = { revenue: 80, profit: 20 };
  const issues = evaluateGovernedFormulas(formulas, [downstream, source], new Map([[downstream, 200], [source, 100]]), input);

  assert.deepEqual(issues, []);
  assert.equal(input.total, 100);
  assert.equal(input.doubleTotal, 200);
});
