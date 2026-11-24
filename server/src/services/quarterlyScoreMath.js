function parse(value, fallback = {}) { try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; } }

function competitionRanks(rows, scoreOf = row => Number(row.totalScore)) {
  const sorted = [...rows].sort((left, right) => scoreOf(right) - scoreOf(left));
  let previous = null;
  let rank = 0;
  return sorted.map((row, index) => {
    const score = scoreOf(row);
    if (previous === null || score !== previous) rank = index + 1;
    previous = score;
    return { ...row, rank };
  });
}

function weightedScore(indicators, scores, adjustments = []) {
  const byIndicator = new Map(scores.map(score => [Number(score.indicatorId), score]));
  let weightedTotal = 0;
  const details = indicators.map(indicator => {
    const score = byIndicator.get(Number(indicator.id));
    const config = indicator.configuration || {};
    const maximumScore = Number(config.maximumScore);
    const weight = Number(indicator.weight || 0);
    const rawScore = score?.score == null ? null : Number(score.score);
    if (rawScore == null || !Number.isFinite(rawScore) || !Number.isFinite(maximumScore) || maximumScore <= 0) {
      return { ...indicator, maximumScore, weight, score: rawScore, weightedScore: null, scoreSource: score?.scoreSource || null };
    }
    const contribution = rawScore / maximumScore * weight;
    weightedTotal += contribution;
    return { ...indicator, maximumScore, weight, score: rawScore, weightedScore: contribution,
      scoreSource: score.scoreSource, formulaVersionId: score.formulaVersionId || null };
  });
  const approvedAdjustments = adjustments.filter(item => item.status === 'approved');
  const rewards = approvedAdjustments.filter(item => item.adjustmentType === 'reward')
    .reduce((sum, item) => sum + Number(item.amount), 0);
  const penalties = approvedAdjustments.filter(item => item.adjustmentType === 'penalty')
    .reduce((sum, item) => sum + Number(item.amount), 0);
  return { indicatorSubtotal: weightedTotal, rewards, penalties, totalScore: weightedTotal + rewards - penalties, details };
}

function redemptionCoefficient(configuration, totalScore, rank) {
  const config = configuration && typeof configuration === 'object' ? configuration : parse(configuration);
  const policy = config.configuration || config;
  const intervals = policy.performanceRedemptionIntervals || policy.redemptionIntervals || policy.scoreRankIntervals;
  if (!Array.isArray(intervals)) return null;
  const entry = intervals.find(item => {
    const minScore = item.minScore == null ? -Infinity : Number(item.minScore);
    const maxScore = item.maxScore == null ? Infinity : Number(item.maxScore);
    const minRank = item.minRank == null ? 1 : Number(item.minRank);
    const maxRank = item.maxRank == null ? Infinity : Number(item.maxRank);
    return totalScore >= minScore && totalScore <= maxScore && rank >= minRank && rank <= maxRank;
  });
  const coefficient = entry?.coefficient ?? entry?.redemptionCoefficient;
  return coefficient != null && Number.isFinite(Number(coefficient)) ? Number(coefficient) : null;
}

module.exports = { competitionRanks, weightedScore, redemptionCoefficient };
