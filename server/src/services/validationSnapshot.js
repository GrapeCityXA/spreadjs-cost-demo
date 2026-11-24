const invalid = () => { throw Object.assign(new Error('提交检查记录格式无效或与协作版本不一致，请重新检查后提交'), { status: 400 }); };
function normalizeValidationSnapshot(report, version) {
  if (report == null) return null; // Historical/older clients never imply a passed check.
  if (report.schemaVersion !== 1 || report.collaborationVersion !== version || !Array.isArray(report.issues) || report.issues.length > 2000) invalid();
  for (const key of ['checkedCount', 'skippedCount']) if (!Number.isSafeInteger(report[key]) || report[key] < 0) invalid();
  const issues = report.issues.map(item => {
    if (!['error', 'warning'].includes(item.severity) || typeof item.message !== 'string') invalid();
    const located = typeof item.sheetName === 'string' && Number.isSafeInteger(item.row) && item.row >= 0 && Number.isSafeInteger(item.col) && item.col >= 0;
    return { severity: item.severity, message: item.message.slice(0, 2000), code: String(item.code || '').slice(0, 100),
      ...(located ? { sheetName: item.sheetName.slice(0, 100), row: item.row, col: item.col } : {}) };
  });
  return { schemaVersion: 1, source: 'frontend_submission', scope: 'submitter_visible_cells', collaborationVersion: version,
    checkedCount: report.checkedCount, skippedCount: report.skippedCount, issues,
    status: issues.some(i => i.severity === 'error') ? 'errors' : issues.length ? 'warnings' : report.skippedCount ? 'partial' : report.checkedCount ? 'passed' : 'no_rules' };
}
module.exports = { normalizeValidationSnapshot };
