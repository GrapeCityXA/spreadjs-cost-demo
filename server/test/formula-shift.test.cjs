const test = require('node:test');
const assert = require('node:assert/strict');
const { shiftFormula, shiftFormulaRows } = require('../src/services/formulaShift');

test('shifts relative row references while preserving absolute rows', () => {
  assert.equal(shiftFormulaRows('=A2+$C$1+A$3+$D4', 2), '=A4+$C$1+A$3+$D6');
  assert.equal(shiftFormulaRows('=SUM(A1:A3)', 7), '=SUM(A8:A10)');
});

test('preserves sheet qualifiers and string literals', () => {
  assert.equal(shiftFormulaRows('="A1"&Sheet1!A1&\'Sheet 1\'!$B2', 2), '="A1"&Sheet1!A3&\'Sheet 1\'!$B4');
  assert.equal(shiftFormulaRows('=LOG10(A1)', 2), '=LOG10(A3)');
});

test('shifts columns for direct component insertion', () => {
  assert.equal(shiftFormula('=A1+$B$2+C$3', { rowOffset: 2, columnOffset: 1 }), '=B3+$B$2+D$3');
});

test('leaves non-formulas and zero offsets unchanged', () => {
  assert.equal(shiftFormulaRows('plain text', 2), 'plain text');
  assert.equal(shiftFormulaRows('=A1', 0), '=A1');
});
