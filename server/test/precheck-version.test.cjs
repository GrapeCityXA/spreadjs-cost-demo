const assert = require('node:assert/strict');
const { test } = require('node:test');
const { precheckSnapshotVersion } = require('../src/services/precheckVersion');

test('a missing snapshot on an edited room is reported as stale and unavailable', () => {
  assert.deepEqual(precheckSnapshotVersion(null, 4), {
    version: 4, roomVersion: 4, snapshotUnavailable: true, stale: true
  });
});

test('new rooms may have no persisted snapshot, while mismatched snapshots are stale', () => {
  assert.deepEqual(precheckSnapshotVersion(null, 0), {
    version: 0, roomVersion: 0, snapshotUnavailable: false, stale: false
  });
  assert.equal(precheckSnapshotVersion({ v: 3 }, 4).stale, true);
  assert.equal(precheckSnapshotVersion({ v: 4 }, 4).stale, false);
});
