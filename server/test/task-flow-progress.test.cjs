const { test } = require('node:test');
const assert = require('node:assert/strict');
const { taskFlowProgress } = require('../src/services/taskFlowProgress');

test('monthly review, finalization and optional review use the resolved workflow stage', () => {
  const review = taskFlowProgress({ cadence: 'monthly', status: 'submitted', stage: '部门审核' });
  assert.deepEqual(review.steps.map(s => [s.key, s.state]), [['filling', 'done'], ['review', 'current'], ['finalizing', 'pending'], ['complete', 'pending']]);
  const noReview = taskFlowProgress({ cadence: 'monthly', status: 'reviewing', stage: '月报定稿', hasReview: false });
  assert.deepEqual(noReview.steps.map(s => s.key), ['filling', 'finalizing', 'complete']);
  assert.equal(noReview.steps.find(s => s.state === 'current').key, 'finalizing');
});
test('quarterly scoring and actual approval branches are visible', () => {
  const scoring = taskFlowProgress({ cadence: 'quarterly', status: 'reviewing', stage: '季度评分' });
  assert.equal(scoring.steps.find(s => s.state === 'current').key, 'scoring');
  assert.ok(!scoring.steps.some(s => s.key === 'award'));
  const approval = taskFlowProgress({ cadence: 'quarterly', status: 'reviewing', stage: '季度奖惩审批', hasQuarterAdjustment: true });
  assert.equal(approval.steps.find(s => s.state === 'current').key, 'award');
  const adjustment = taskFlowProgress({ cadence: 'monthly', status: 'reviewing', stage: '数据调整审批', hasAdjustment: true });
  assert.equal(adjustment.steps.find(s => s.state === 'current').key, 'adjustment');
});
test('completed, cancelled and returned tasks do not misrepresent progress', () => {
  assert.ok(taskFlowProgress({ cadence: 'monthly', status: 'finalized', stage: '已完成' }).steps.every(s => s.state === 'done'));
  const cancelled = taskFlowProgress({ cadence: 'monthly', status: 'cancelled', stage: '已结束' });
  assert.ok(cancelled.steps.every(s => s.state === 'stopped'));
  assert.match(cancelled.notice, /取消/);
  for (const revisionStatus of ['returned', 'withdrawn']) {
    const flow = taskFlowProgress({ cadence: 'monthly', status: 'draft', revisionStatus, stage: '填报与提交' });
    assert.equal(flow.steps[0].state, 'current');
    assert.ok(flow.notice); assert.ok(flow.steps.slice(1).every(s => s.state === 'pending'));
  }
});
