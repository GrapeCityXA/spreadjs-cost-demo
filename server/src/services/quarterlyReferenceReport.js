const db = require('../config/database');
const { getQuarterlyReview } = require('./quarterlyReviewScoring');
const { hasTaskAssignment } = require('./taskAssignments');
const quarterlyReferenceProfile = require('../../../shared/quarterly-reference-profile.json');

const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const fail = (message, status) => Object.assign(new Error(message), { status });

function canReadOfficialQuarterlyReport(actor) {
  return (actor.roles || []).some(role => role.code === 'system_admin' || role.code === 'report_finalizer');
}

function isGlobalAdmin(actor) {
  return (actor.roles || []).some(role => role.code === 'system_admin' && role.organizationId == null);
}

async function assertPackageFinalizer(tasks, actor) {
  if (isGlobalAdmin(actor)) return;
  const completeScope = await Promise.all(tasks.map(async task => {
    const hasRole = (actor.roles || []).some(role => role.code === 'report_finalizer'
      && (role.organizationId == null || Number(role.organizationId) === Number(task.organizationId)));
    return hasRole && await hasTaskAssignment(db, task.taskId, actor.id, 'finalizer');
  }));
  if (!tasks.length || completeScope.some(allowed => !allowed)) throw fail('只有该季度配置包的全范围定稿人可以生成正式季度报表', 403);
}

async function loadQuarterlyReferenceReport(packageId, actor) {
  if (!canReadOfficialQuarterlyReport(actor)) throw fail('需要季度整包定稿权限', 403);
  const reportPackage = await get(db, `SELECT p.id, p.version, p.period_code AS periodCode,
      p.template_version_id AS templateVersionId, p.configuration_json AS configurationJson,
      tv.manifest_json AS templateManifestJson, tv.workbook_json AS templateWorkbookJson,
      rt.id AS reportTypeId, rt.display_name AS reportTypeName
    FROM period_packages p JOIN report_types rt ON rt.id=p.report_type_id
    LEFT JOIN template_versions tv ON tv.id=p.template_version_id
    WHERE p.id=? AND rt.cadence='quarterly'`, [Number(packageId)]);
  if (!reportPackage) throw fail('季度配置包不存在', 404);
  let packageConfiguration = {};
  try { packageConfiguration = JSON.parse(reportPackage.configurationJson || '{}'); } catch { packageConfiguration = {}; }
  let templateManifest = {};
  let templateWorkbook = {};
  try { templateManifest = JSON.parse(reportPackage.templateManifestJson || '{}'); } catch { templateManifest = {}; }
  try { templateWorkbook = JSON.parse(reportPackage.templateWorkbookJson || '{}'); } catch { templateWorkbook = {}; }
  const referenceWorkbook = templateManifest?.sourceWorkbook?.sha256 === quarterlyReferenceProfile.sha256
    && Array.isArray(templateWorkbook?.sheets)
    && templateWorkbook.sheets.length === quarterlyReferenceProfile.sheetNames.length
    && templateWorkbook.sheets.every((sheet, index) => sheet.name === quarterlyReferenceProfile.sheetNames[index])
    ? templateWorkbook : null;
  const tasks = await all(db, `SELECT t.id AS taskId, t.organization_id AS organizationId,
      o.code AS organizationCode, o.name AS organizationName, t.task_status AS taskStatus,
      r.id AS revisionId, r.revision_status AS revisionStatus, r.revision_number AS revisionNumber
    FROM report_tasks t JOIN organizations o ON o.id=t.organization_id
    LEFT JOIN business_revisions r ON r.id=t.current_revision_id
    WHERE t.package_id=? AND t.report_type_id=? ORDER BY o.name, t.id`,
  [reportPackage.id, reportPackage.reportTypeId]);
  if (!tasks.length) throw fail('季度配置包没有生成报告任务', 409);
  await assertPackageFinalizer(tasks, actor);
  const unfinished = tasks.filter(task => task.taskStatus !== 'finalized' || task.revisionStatus !== 'finalized');
  if (unfinished.length) throw fail(`季度报告尚未整包定稿：${unfinished.map(task => task.organizationName).join('、')}`, 409);

  const companies = [];
  for (const task of tasks) {
    // getQuarterlyReview enforces task scope and the package-wide finalizer assignment.
    const reviewed = await getQuarterlyReview(task.taskId, actor);
    const dependencies = reviewed.quarterlyDependencies;
    if (!reviewed.quarterlyDependenciesSnapshotted || !dependencies?.complete || !dependencies.months?.length) {
      throw fail(`${task.organizationName} 缺少定稿时锁定的月报修订来源，不能生成正式季度报表`, 409);
    }
    const indicators = (reviewed.indicators || []).map(indicator => ({
      id: indicator.id,
      code: indicator.code,
      displayName: indicator.displayName,
      type: indicator.type,
      category: indicator.configuration?.category || indicator.category || null,
      weight: indicator.weight,
      maximumScore: indicator.configuration?.maximumScore ?? null,
      review: indicator.review ? {
        status: indicator.review.status,
        opinion: indicator.review.opinion || '',
        remediationDeadline: indicator.review.remediationDeadline || null
      } : null,
      scoring: indicator.scoring ? {
        score: indicator.scoring.score,
        source: indicator.scoring.scoreSource,
        formulaVersionId: indicator.scoring.formulaVersionId || null,
        comment: indicator.scoring.comment || ''
      } : null
    }));
    companies.push({
      id: task.taskId,
      referenceSheetCode: packageConfiguration.referenceCompanySheets?.[String(task.organizationId)] || null,
      task: { id: task.taskId, organizationId: task.organizationId, organizationCode: task.organizationCode,
        organizationName: task.organizationName, revisionId: task.revisionId, revisionNumber: task.revisionNumber },
      monthlyDependencies: {
        source: dependencies.source,
        months: dependencies.months.map(month => ({ periodCode: month.periodCode, revisionId: month.revisionId,
          status: month.status, metrics: month.metrics })),
        currentQuarter: dependencies.currentQuarter,
        yearToDate: dependencies.yearToDate
      },
      indicators,
      scoreSummary: reviewed.scoreSummary,
      adjustments: reviewed.adjustments,
      rankings: reviewed.rankings
    });
  }

  const rankings = companies[0]?.rankings || [];
  return {
    reportType: { id: reportPackage.reportTypeId, name: reportPackage.reportTypeName },
    package: { id: reportPackage.id, version: reportPackage.version, periodCode: reportPackage.periodCode,
      templateVersionId: reportPackage.templateVersionId },
    referenceWorkbook,
    source: 'quarter_finalization_locked_monthly_revisions',
    generatedAt: new Date().toISOString(),
    companies: companies.map(company => {
      const ranking = rankings.find(item => Number(item.organizationId) === Number(company.task.organizationId));
      return { ...company, ranking: ranking ? { rank: ranking.rank, totalScore: ranking.totalScore,
        redemptionCoefficient: ranking.redemptionCoefficient } : null };
    }),
    summary: { companyCount: companies.length, rankings }
  };
}

module.exports = { loadQuarterlyReferenceReport };
