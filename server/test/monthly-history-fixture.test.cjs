const assert = require('node:assert/strict');
const { test } = require('node:test');
const { findSyntheticHistoryOrganization } = require('../src/services/monthlyFillingHistory');

test('synthetic organization history is restricted to development and acceptance environments', () => {
  assert.ok(findSyntheticHistoryOrganization({ name: '航天电工', code: 'ORG_1' }, 'development'));
  assert.ok(findSyntheticHistoryOrganization({ name: '航天电工', code: 'ORG_1' }, 'test'));
  assert.equal(findSyntheticHistoryOrganization({ name: '航天电工', code: 'ORG_1' }, 'production'), null);
  assert.equal(findSyntheticHistoryOrganization({ name: '航天电工', code: 'ORG_1' }, 'staging'), null);
});

test('synthetic organization matching requires an exact normalized name or code', () => {
  assert.ok(findSyntheticHistoryOrganization({ name: '航 天电工', code: 'ORG_1' }, 'test'));
  assert.ok(findSyntheticHistoryOrganization({ name: 'Other name', code: 'SAMPLE_ORG_01' }, 'test'));
  assert.equal(findSyntheticHistoryOrganization({ name: '航天', code: 'ORG_1' }, 'test'), null);
  assert.equal(findSyntheticHistoryOrganization({ name: '航天电工集团', code: 'ORG_1' }, 'test'), null);
});
