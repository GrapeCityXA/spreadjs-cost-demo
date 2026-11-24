const test = require('node:test');
const assert = require('node:assert/strict');
const { competitionRanks, weightedScore, redemptionCoefficient } = require('../src/services/quarterlyScoreMath');

test('quarterly ranking uses unrounded scores and competition ranks', () => {
  const ranked = competitionRanks([
    { organizationId: 1, totalScore: 97.125 },
    { organizationId: 2, totalScore: 92.334 },
    { organizationId: 3, totalScore: 92.334 },
    { organizationId: 4, totalScore: 88.999 }
  ]);
  assert.deepEqual(ranked.map(item => item.rank), [1, 2, 2, 4]);
});

test('quarterly ranking does not merge distinct unrounded scores within a tolerance', () => {
  const ranked = competitionRanks([
    { organizationId: 1, totalScore: 92.3340000005 },
    { organizationId: 2, totalScore: 92.334 }
  ]);
  assert.deepEqual(ranked.map(item => item.rank), [1, 2]);
});

test('quarterly weighted totals use unrounded indicator scores and only approved adjustments', () => {
  const result = weightedScore([
    { id: 1, displayName: 'A', weight: 60, configuration: { maximumScore: 100 } },
    { id: 2, displayName: 'B', weight: 40, configuration: { maximumScore: 20 } }
  ], [
    { indicatorId: 1, score: 91.2345, scoreSource: 'manual' },
    { indicatorId: 2, score: 18.7654, scoreSource: 'manual' }
  ], [
    { adjustmentType: 'reward', amount: 3.125, status: 'approved' },
    { adjustmentType: 'penalty', amount: 8, status: 'pending' }
  ]);
  assert.ok(Math.abs(result.indicatorSubtotal - (91.2345 * .6 + 18.7654 / 20 * 40)) < 1e-10);
  assert.ok(Math.abs(result.totalScore - (result.indicatorSubtotal + 3.125)) < 1e-10);
});

test('quarterly totals keep automatic formula scores unavailable when source inputs are missing', () => {
  const result = weightedScore([
    { id: 1, displayName: '经济指标', weight: 100, configuration: { maximumScore: 25 } }
  ], [{ indicatorId: 1, score: null, scoreSource: 'formula', formulaVersionId: 12 }]);
  assert.equal(result.indicatorSubtotal, 0);
  assert.equal(result.totalScore, 0);
  assert.equal(result.details[0].score, null);
  assert.equal(result.details[0].weightedScore, null);
});

test('redemption coefficient comes only from a matching snapshotted interval', () => {
  const snapshot = { configuration: { performanceRedemptionIntervals: [
    { minScore: 0, maxScore: 79.99, minRank: 1, maxRank: 99, coefficient: 0.8 },
    { minScore: 80, maxScore: 100, minRank: 1, maxRank: 3, coefficient: 1.1 }
  ] } };
  assert.equal(redemptionCoefficient(snapshot, 82.125, 2), 1.1);
  assert.equal(redemptionCoefficient(snapshot, 82.125, 4), null);
  assert.equal(redemptionCoefficient({}, 82.125, 2), null);
});
