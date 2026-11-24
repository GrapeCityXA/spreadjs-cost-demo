const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeValidationSnapshot: normalize } = require('../src/services/validationSnapshot');
const base = { schemaVersion: 1, collaborationVersion: 3, checkedCount: 2, skippedCount: 0, issues: [] };
test('missing, no-rules and partial checks never claim an all-clear', () => {
  assert.equal(normalize(null, 3), null);
  assert.equal(normalize({ ...base, checkedCount: 0 }, 3).status, 'no_rules');
  assert.equal(normalize({ ...base, skippedCount: 1 }, 3).status, 'partial');
  assert.equal(normalize(base, 3).status, 'passed');
});
test('frontend warning evidence keeps coordinates and cannot claim another version', () => {
  const r = normalize({ ...base, status: 'passed', issues: [{ severity: 'warning', message: '超出范围', sheetName: '主表', row: 2, col: 3 }] }, 3);
  assert.equal(r.status, 'warnings'); assert.equal(r.issues[0].row, 2);
  assert.throws(() => normalize(base, 4), { status: 400 });
  assert.throws(() => normalize({ ...base, checkedCount: -1 }, 3), { status: 400 });
});
