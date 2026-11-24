// A display projection of the workflow center's resolved stage, not a workflow engine.
function taskFlowProgress({ cadence, status, revisionStatus, stage, hasReview = true, hasAdjustment = false, hasQuarterAdjustment = false }) {
  const quarterly = cadence === 'quarterly';
  const steps = [{ key: 'filling', label: '填报与提交' }];
  if (hasReview || quarterly) steps.push({ key: 'review', label: quarterly ? '指标审核' : '部门审核' });
  if (hasAdjustment) steps.push({ key: 'adjustment', label: '调整审批' });
  if (quarterly) steps.push({ key: 'scoring', label: '评分' });
  if (hasQuarterAdjustment) steps.push({ key: 'award', label: '奖惩审批' });
  steps.push({ key: 'finalizing', label: '定稿' }, { key: 'complete', label: '完成' });
  const current = ({ '填报与提交': 'filling', '部门审核': 'review', '季度指标审核': 'review', '数据调整审批': 'adjustment', '季度评分': 'scoring', '季度奖惩审批': 'award', '月报定稿': 'finalizing', '季度定稿': 'finalizing', '已完成': 'complete' })[stage];
  const cancelled = ['cancelled', 'canceled', 'closed'].includes(status);
  const index = steps.findIndex(s => s.key === current);
  const notice = cancelled ? '流程已取消或结束' : ['returned', 'withdrawn'].includes(status) || ['returned', 'withdrawn'].includes(revisionStatus)
    ? (status === 'withdrawn' || revisionStatus === 'withdrawn' ? '已撤回，重新填报' : '已退回，修改后重新提交') : '';
  return { notice, steps: steps.map((step, i) => ({ ...step,
    state: cancelled ? 'stopped' : status === 'finalized' || i < index ? 'done' : i === index ? 'current' : 'pending' })) };
}

module.exports = { taskFlowProgress };
