const db = require('../config/database');
const { recordBusinessAudit } = require('../services/businessAudit');
const { getCollaborationDatabasePath } = require('../config/storage');
const { ensureDefaultRules } = require('./ruleCatalogController');
const { DEFAULT_ANOMALY_RULE_CODES } = require('../services/defaultAnomalyRules');
const { scopeQuarterlyWorkbook, isQuarterlyReferenceTemplate } = require('../services/quarterlyWorkbook');
const quarterlyReferenceProfile = require('../../../shared/quarterly-reference-profile.json');
const { quarterlyTemplateCompatibility } = require('../services/quarterlyTemplateCompatibility');

const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
const parse = (value, fallback = {}) => { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(error => {
  if (error.status === 409) return fail(res, 409, error.message);
  next(error);
});
const fail = (res, status, error) => res.status(status).json({ error });
const assignmentsAllowed = new Set(['filler', 'submitter', 'department_reviewer', 'scorer', 'approver', 'finalizer']);
const assignmentRoles = {
  filler: ['subsidiary_filler'], submitter: ['subsidiary_submitter'], department_reviewer: ['department_reviewer'],
  scorer: ['score_editor'], approver: ['management'], finalizer: ['report_finalizer']
};
const targetPhases = new Set(['annual', 'monthly', 'cumulative', 'quarterly']);
const DEFAULT_RULE_THRESHOLDS = Object.freeze({
  yoyChangePercent: 30,
  momChangePercent: 30,
  targetCompletionMinPercent: 70,
  targetCompletionMaxPercent: 130
});

function readRuleThresholds(value) {
  if (value == null) value = DEFAULT_RULE_THRESHOLDS;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const thresholds = {};
  for (const [key, defaultValue] of Object.entries(DEFAULT_RULE_THRESHOLDS)) {
    const candidate = value[key] == null ? defaultValue : Number(value[key]);
    if (!Number.isFinite(candidate) || candidate < 0 || candidate > 1000) return null;
    thresholds[key] = candidate;
  }
  if (thresholds.targetCompletionMinPercent >= thresholds.targetCompletionMaxPercent) return null;
  return thresholds;
}

function referenceCompanySheetMapError(workbookJson, organizations, mappings) {
  const companySheetCodes = new Set((parse(workbookJson, {}).sheets || [])
    .filter(sheet => sheet.type === 'business' || sheet.kind === 'company')
    .map(sheet => String(sheet.code || sheet.sheetCode || '')).filter(Boolean));
  const organizationIds = organizations.map(organization => String(organization.id ?? organization.organization_id));
  const mapping = mappings && typeof mappings === 'object' && !Array.isArray(mappings) ? mappings : {};
  const selectedCodes = organizationIds.map(id => mapping[id]);
  if (Object.keys(mapping).length !== organizationIds.length || organizationIds.some(id => !Object.hasOwn(mapping, id))
    || selectedCodes.some(code => !companySheetCodes.has(String(code || ''))) || new Set(selectedCodes).size !== selectedCodes.length) {
    return '季度参考模板必须为每个参与子公司配置唯一且有效的公司考核页';
  }
  return null;
}

function normalizedPeriod(cadence, period) {
  const value = String(period || '').trim();
  if (cadence === 'monthly' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
  if (cadence === 'quarterly' && /^\d{4}-Q[1-4]$/.test(value)) return value;
  return null;
}

function nextPeriodStart(cadence, period) {
  const [year, suffix] = period.split(cadence === 'monthly' ? '-' : '-Q');
  if (cadence === 'monthly') {
    const month = Number(suffix);
    return month === 12 ? { year: Number(year) + 1, month: 1 } : { year: Number(year), month: month + 1 };
  }
  const month = Number(suffix) * 3 + 1;
  return month > 12 ? { year: Number(year) + 1, month: 1 } : { year: Number(year), month };
}

function defaultDeadline(cadence, period) {
  const { year, month } = nextPeriodStart(cadence, period);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-02T23:59:59+08:00`;
}

function validDeadline(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\+08:00|Z)$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function decimalString(value) {
  const text = String(value ?? '').trim();
  return /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(text) ? text : null;
}

async function packageView(id) {
  const row = await get(`SELECT p.*, rt.code AS report_type_code, rt.display_name AS report_type_name,
      rt.cadence, rt.workflow_profile, tv.version AS template_version,
      t.name AS template_name, creator.name AS created_by_name,
      (SELECT COUNT(*) FROM report_tasks task WHERE task.package_id = p.id AND task.task_status <> 'cancelled') AS task_count
    FROM period_packages p JOIN report_types rt ON rt.id = p.report_type_id
    JOIN template_versions tv ON tv.id = p.template_version_id JOIN templates t ON t.id = tv.template_id
    LEFT JOIN users creator ON creator.id = p.created_by WHERE p.id = ?`, [id]);
  if (!row) return null;
  const organizations = await all(`SELECT po.*, o.code AS organization_code, o.name AS organization_name, o.status AS organization_status
    FROM package_organizations po JOIN organizations o ON o.id = po.organization_id WHERE po.package_id = ? ORDER BY o.code`, [id]);
  const targets = await all(`SELECT pt.*, fd.code AS field_code, fd.display_name AS field_name
    FROM package_targets pt JOIN field_definitions fd ON fd.id = pt.field_definition_id WHERE pt.package_id = ? ORDER BY pt.organization_id, fd.code, pt.target_phase, pt.phase_period`, [id]);
  const assignments = await all(`SELECT pa.*, u.username, u.name AS user_name, u.account_status, o.code AS organization_code
    FROM package_assignments pa JOIN users u ON u.id = pa.user_id JOIN organizations o ON o.id = pa.organization_id
    WHERE pa.package_id = ? ORDER BY o.code, pa.responsibility, u.name`, [id]);
  const configuration = parse(row.configuration_json);
  configuration.ruleThresholds = readRuleThresholds(configuration.ruleThresholds) || { ...DEFAULT_RULE_THRESHOLDS };
  return { ...row, configuration, organizations, targets, assignments };
}

async function quarterlyOwnerOrganizationId(organizationId, periodCode) {
  const endDate = `${periodCode.slice(0, 4)}-${String(Number(periodCode.slice(-1)) * 3).padStart(2, '0')}-${[31, 30, 30, 31][Number(periodCode.slice(-1)) - 1]}`;
  let organization = await get('SELECT id, organization_type FROM organizations WHERE id = ? AND status = \'active\'', [organizationId]);
  const visited = new Set();
  while (organization && !visited.has(Number(organization.id))) {
    const id = Number(organization.id);
    visited.add(id);
    if (organization.organization_type === 'subsidiary') return id;
    const parents = await all(`SELECT o.id, o.organization_type FROM organization_relationships r
      JOIN organizations o ON o.id = r.parent_organization_id AND o.status = 'active'
      WHERE r.child_organization_id = ? AND r.effective_from <= ? AND (r.effective_to IS NULL OR r.effective_to >= ?)
      ORDER BY r.effective_from DESC`, [id, endDate, endDate]);
    if (parents.length > 1) return null;
    organization = parents[0] || null;
  }
  return null;
}

// Draft identifiers are deliberately distinct: an incomplete form cannot be used as a task package.
async function editorDraft(id) {
  return /^draft-[1-9]\d*$/.test(String(id))
    ? get('SELECT * FROM period_package_drafts WHERE id = ?', [Number(String(id).slice(6))])
    : get('SELECT * FROM period_package_drafts WHERE package_id = ?', [Number(id)]);
}

async function editorDraftView(draft) {
  const input = parse(draft.input_json);
  const type = await get('SELECT * FROM report_types WHERE id = ?', [Number(input.reportTypeId)]);
  const template = await get(`SELECT tv.version, t.name FROM template_versions tv
    JOIN templates t ON t.id = tv.template_id WHERE tv.id = ?`, [Number(input.templateVersionId)]);
  const original = draft.package_id ? await packageView(draft.package_id) : null;
  const organizations = [];
  for (const entry of input.organizations || []) {
    const org = await get('SELECT name, code FROM organizations WHERE id = ?', [Number(entry.organizationId)]);
    organizations.push({ organization_id: entry.organizationId, organization_name: org?.name || '待选择组织',
      organization_code: org?.code, deadline_at: entry.deadlineAt || '默认期限' });
  }
  return { id: `draft-${draft.id}`, originalPackageId: draft.package_id, status: 'draft', version: original?.version || 1,
    report_type_id: input.reportTypeId, report_type_name: type?.display_name || '未命名草稿', cadence: type?.cadence,
    period_code: input.periodCode || '周期待填写', template_version_id: input.templateVersionId,
    template_name: template?.name || '模板待选择', template_version: template?.version,
    task_count: 0, organizations, targets: input.targets || [], assignments: input.assignments || [],
    configuration: input.configuration || {}, draftInput: input, created_at: draft.created_at };
}

async function saveEditorDraft(req, res, id = null) {
  const existing = id ? await editorDraft(id) : null;
  if (id && String(id).startsWith('draft-') && !existing) return fail(res, 404, '草稿不存在');
  const packageId = existing?.package_id || (id && !String(id).startsWith('draft-') ? Number(id) : null);
  const original = packageId ? await get('SELECT * FROM period_packages WHERE id = ?', [packageId]) : null;
  if (packageId && !original) return fail(res, 404, '填报计划不存在');
  if (original && !['draft', 'validated'].includes(original.status)) return fail(res, 409, '只有未激活的填报计划可以修改');
  // Only bound the document shape here. Business completeness is checked on validate/activate.
  for (const key of ['organizations', 'targets', 'indicators', 'assignments', 'ruleVersionIds', 'generateMonthlyTargetsFromAnnual']) {
    if (req.body[key] != null && (!Array.isArray(req.body[key]) || req.body[key].length > 1000
      || req.body[key].some(value => value == null))) return fail(res, 400, `${key} 格式无效或数量超限`);
  }
  const input = { ...req.body };
  delete input.draftOnly;
  if (original) {
    input.reportTypeId = original.report_type_id;
    input.periodCode = original.period_code;
    if (input.editorState) input.editorState = { ...input.editorState, reportTypeId: input.reportTypeId, periodCode: input.periodCode };
  }
  let draftId = existing?.id;
  if (draftId) await run('UPDATE period_package_drafts SET input_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(input), draftId]);
  else draftId = (await run('INSERT INTO period_package_drafts (package_id, input_json, created_by) VALUES (?, ?, ?)',
    [packageId, JSON.stringify(input), req.user.id])).lastID;
  await recordBusinessAudit({ actor: req.user, action: 'period_package.save_draft', objectType: 'period_package_draft',
    objectId: draftId, after: { packageId, reportTypeId: input.reportTypeId || null, periodCode: input.periodCode || null } });
  res.status(id ? 200 : 201).json({ package: await editorDraftView(await editorDraft(`draft-${draftId}`)) });
}

async function materializeEditorDraft(draft, actor) {
  const input = parse(draft.input_json);
  const reportType = await get("SELECT * FROM report_types WHERE id = ? AND status = 'active'", [Number(input.reportTypeId)]);
  const missing = [];
  if (!reportType) missing.push('请选择有效的报告类型');
  if (!input.periodCode) missing.push('请填写报告周期');
  if (!input.templateVersionId) missing.push('请选择已发布模板');
  if (!input.organizations?.length) missing.push('请选择至少一个参与组织');
  if (missing.length) return { errors: missing };
  const checked = await readDraftInput(input, reportType);
  if (checked.error) return { errors: [checked.error] };
  const value = checked.value;
  const configuration = { ...value.configuration, indicators: value.indicators, metricWeights: value.metricWeights,
    ruleVersionIds: value.ruleVersionIds, ruleThresholds: value.ruleThresholds, templateVersion: value.template.version };
  const errors = await packageValidationErrors({ period_code: value.periodCode, template_version_id: value.template.id,
    configuration, organizations: value.organizations.map(org => ({ organization_id: org.id, organization_name: org.name,
      organization_status: org.status, deadline_at: org.deadlineAt })),
    targets: value.targets.map(target => ({ field_definition_id: target.fieldDefinitionId, field_code: target.fieldCode })),
    assignments: value.assignments.map(assignment => ({ organization_id: assignment.organizationId,
      user_id: assignment.userId, responsibility: assignment.responsibility, user_name: assignment.userName, account_status: 'active' })) }, reportType);
  if (errors.length) return { errors };
  let packageId = draft.package_id;
  await run('BEGIN IMMEDIATE');
  try {
    const latestDraft = await get('SELECT input_json FROM period_package_drafts WHERE id = ?', [draft.id]);
    if (!latestDraft || latestDraft.input_json !== draft.input_json) throw Object.assign(new Error('草稿已改变，请刷新后重新校验'), { status: 409 });
    if (packageId) {
      const current = await get('SELECT status FROM period_packages WHERE id = ?', [packageId]);
      if (!current || !['draft', 'validated'].includes(current.status)) throw Object.assign(new Error('填报计划状态已改变'), { status: 409 });
      await run("UPDATE period_packages SET template_version_id = ?, configuration_json = ?, status = 'validated' WHERE id = ?",
        [value.template.id, JSON.stringify(configuration), packageId]);
    } else {
      const latest = await get('SELECT COALESCE(MAX(version), 0) AS version FROM period_packages WHERE report_type_id = ? AND period_code = ?', [reportType.id, value.periodCode]);
      packageId = (await run(`INSERT INTO period_packages (report_type_id, period_code, version, template_version_id, configuration_json, created_by, status)
        VALUES (?, ?, ?, ?, ?, ?, 'validated')`, [reportType.id, value.periodCode, latest.version + 1, value.template.id, JSON.stringify(configuration), draft.created_by])).lastID;
    }
    await persistChildren(packageId, value, actor.id, Boolean(draft.package_id));
    await run('DELETE FROM period_package_drafts WHERE id = ?', [draft.id]);
    await run('COMMIT');
  } catch (error) { await run('ROLLBACK').catch(() => {}); throw error; }
  await recordBusinessAudit({ actor, action: 'period_package.validate', objectType: 'period_package', objectId: packageId,
    after: { status: 'validated', valid: true, sourceDraftId: draft.id } });
  return { errors: [], packageId };
}

async function packageValidationErrors(item, reportType) {
  const errors = [];
  if (!normalizedPeriod(reportType.cadence, item.period_code)) errors.push('报告周期格式与 Report Type 不匹配');
  if (!(await get("SELECT id FROM template_versions WHERE id = ? AND status = 'published'", [item.template_version_id]))) errors.push('所选模板版本不再处于已发布状态');
  if (!item.organizations.length) errors.push('至少需要一个参与组织');
  const indicators = item.configuration.indicators || [];
  if (reportType.cadence === 'monthly' && Object.keys(item.configuration.metricWeights || {}).length) {
    const weights = item.configuration.metricWeights || {};
    const revenue = Number(weights.revenue);
    const profit = Number(weights.profit);
    if (!Number.isFinite(revenue) || !Number.isFinite(profit) || revenue < 0 || profit < 0 || Math.abs(revenue + profit - 100) > 0.000001) {
      errors.push('月度收入与利润权重合计必须为 100%');
    }
  }
  if (reportType.cadence === 'quarterly') {
    const sourceTypeId = Number(item.configuration.monthlySourceReportTypeId);
    if (!Number.isSafeInteger(sourceTypeId) || !(await get("SELECT id FROM report_types WHERE id = ? AND cadence = 'monthly' AND status = 'active'", [sourceTypeId]))) {
      errors.push('必须选择有效的月度数据来源 Report Type');
    }
    const template = await get('SELECT manifest_json, workbook_json FROM template_versions WHERE id = ?', [item.template_version_id]);
    const compatibility = quarterlyTemplateCompatibility(parse(template?.workbook_json, {}));
    if (!compatibility.compatible) errors.push(compatibility.message);
    if (parse(template?.manifest_json, {}).sourceWorkbook?.sha256 === quarterlyReferenceProfile.sha256) {
      const mappingError = referenceCompanySheetMapError(template?.workbook_json, item.organizations, item.configuration.referenceCompanySheets);
      if (mappingError) errors.push(mappingError);
    }
  }
  for (const organization of item.organizations) {
    if (organization.organization_status !== 'active') errors.push(`${organization.organization_name} 已停用`);
    if (!validDeadline(organization.deadline_at)) errors.push(`${organization.organization_name} 的截止时间无效`);
    const scoped = indicators.filter(indicator => Number(indicator.organizationId) === organization.organization_id);
    if (scoped.length && Math.abs(scoped.reduce((sum, indicator) => sum + Number(indicator.weight), 0) - 100) > 0.000001) errors.push(`${organization.organization_name} 的指标权重合计必须为 100%`);
  }
  for (const indicator of indicators) {
    if (reportType.cadence === 'quarterly') {
      const maximumScore = Number(indicator.maximumScore);
      if (!['key_business', 'key_work'].includes(indicator.category)) errors.push(`指标 ${indicator.code} 必须归入重点业务或重点工作`);
      if (!Number.isFinite(maximumScore) || maximumScore <= 0 || maximumScore > 10000) errors.push(`指标 ${indicator.code} 的最高分无效`);
      if (!indicator.namedArea || !/^[A-Z][A-Z0-9_]*_TABLE_[A-Z][A-Z0-9_]{0,240}$/.test(indicator.namedArea)) errors.push(`指标 ${indicator.code} 必须绑定包含 _TABLE_ 的表格命名区域`);
      if (!Number.isSafeInteger(Number(indicator.ownerOrganizationId)) || !(await get("SELECT id FROM organizations WHERE id = ? AND organization_type = 'department' AND status = 'active'", [Number(indicator.ownerOrganizationId)]))) {
        errors.push(`指标 ${indicator.code} 必须指定有效的审核归属部门`);
      }
      if (!Number.isSafeInteger(Number(indicator.reviewerUserId)) || !(await get(`SELECT u.id FROM users u JOIN effective_user_roles ur ON ur.user_id = u.id
          WHERE u.id = ? AND u.organization_id = ? AND u.account_status = 'active' AND ur.role_code = 'department_reviewer'
            AND (ur.organization_id = ? OR ur.organization_id IS NULL) AND ur.effective_from <= CURRENT_TIMESTAMP
            AND (ur.effective_to IS NULL OR ur.effective_to > CURRENT_TIMESTAMP)`,
      [Number(indicator.reviewerUserId), Number(indicator.ownerOrganizationId), Number(indicator.ownerOrganizationId)]))) {
        errors.push(`指标 ${indicator.code} 必须指定归属部门的有效审核人`);
      }
    }
    if (!indicator.parentCode) continue;
    const parent = indicators.find(candidate => Number(candidate.organizationId) === Number(indicator.organizationId) && candidate.code === indicator.parentCode);
    if (!parent || parent.code === indicator.code) errors.push(`指标 ${indicator.code} 的上级指标不存在或形成自引用`);
    else if (indicators.indexOf(parent) > indicators.indexOf(indicator)) errors.push(`指标 ${indicator.code} 必须排在上级指标之后`);
  }
  for (const versionId of item.configuration.ruleVersionIds || []) {
    if (!(await get("SELECT id FROM rule_versions WHERE id = ? AND status = 'published'", [versionId]))) errors.push(`规则版本 ${versionId} 未发布或不存在`);
  }
  if (!readRuleThresholds(item.configuration.ruleThresholds)) errors.push('规则比例无效：各比例须在 0% 至 1000% 之间，且目标完成率下限须低于上限');
  for (const target of item.targets) {
    if (!(await get("SELECT id FROM field_definitions WHERE id = ? AND status = 'approved' AND data_type IN ('integer','decimal')", [target.field_definition_id]))) errors.push(`目标字段 ${target.field_code} 未批准或不是数值类型`);
  }
  for (const assignment of item.assignments) {
    if (assignment.account_status !== 'active') errors.push(`责任人 ${assignment.user_name} 已停用`);
    else if (!(await assignmentHasRole(assignment.user_id, assignment.organization_id, assignment.responsibility))) errors.push(`责任人 ${assignment.user_name} 未持有${assignment.responsibility}职责`);
  }
  const requiredResponsibilities = reportType.cadence === 'quarterly'
    ? ['filler', 'submitter', 'department_reviewer', 'scorer', 'approver', 'finalizer']
    : ['filler', 'submitter', 'department_reviewer', 'approver', 'finalizer'];
  for (const organization of item.organizations) {
    const responsibilities = new Set(item.assignments.filter(assignment => assignment.organization_id === organization.organization_id).map(assignment => assignment.responsibility));
    const missing = requiredResponsibilities.filter(responsibility => !responsibilities.has(responsibility));
    if (missing.length) errors.push(`${organization.organization_name} 缺少责任人：${missing.join('、')}`);
  }
  return errors;
}

async function assignmentHasRole(userId, organizationId, responsibility) {
  const roleCodes = assignmentRoles[responsibility] || [];
  if (!roleCodes.length) return false;
  const placeholders = roleCodes.map(() => '?').join(',');
  const found = await get(`SELECT 1 AS found FROM effective_user_roles WHERE user_id = ? AND role_code IN (${placeholders})
    AND (organization_id = ? OR (role_code = 'management' AND organization_id IS NULL)
      OR (role_code = 'department_reviewer' AND organization_id = (SELECT organization_id FROM users WHERE id = ?)
        AND EXISTS (SELECT 1 FROM organizations department WHERE department.id = effective_user_roles.organization_id
          AND department.organization_type = 'department')))
    AND effective_from <= CURRENT_TIMESTAMP AND (effective_to IS NULL OR effective_to > CURRENT_TIMESTAMP)`, [userId, ...roleCodes, organizationId, userId]);
  if (found) return true;
  // Approval is the one responsibility a system administrator can actually perform without a management role.
  if (responsibility === 'approver') return Boolean(await get(`SELECT 1 AS found FROM effective_user_roles
    WHERE user_id = ? AND role_code = 'system_admin'
      AND effective_from <= CURRENT_TIMESTAMP AND (effective_to IS NULL OR effective_to > CURRENT_TIMESTAMP)`, [userId]));
  return false;
}

async function defaultAdministrator() {
  return get(`SELECT u.id, u.username, u.name FROM users u JOIN effective_user_roles ur ON ur.user_id = u.id
    WHERE u.account_status = 'active' AND ur.role_code = 'system_admin' AND ur.effective_from <= CURRENT_TIMESTAMP
    AND (ur.effective_to IS NULL OR ur.effective_to > CURRENT_TIMESTAMP) ORDER BY u.id LIMIT 1`);
}

async function readDraftInput(body, reportType) {
  if (!normalizedPeriod(reportType.cadence, body.periodCode)) return { error: '报告周期格式与 Report Type 不匹配' };
  const template = await get(`SELECT tv.id, tv.status, tv.version, tv.manifest_json, tv.workbook_json,
      t.name AS templateName FROM template_versions tv JOIN templates t ON t.id = tv.template_id WHERE tv.id = ?`, [Number(body.templateVersionId)]);
  if (!template || template.status !== 'published') return { error: '必须选择已发布的模板版本' };
  if (!Array.isArray(body.organizations) || body.organizations.length < 1 || body.organizations.length > 1000) return { error: '至少需要选择一个参与组织' };
  const seenOrgs = new Set();
  const organizations = [];
  for (const entry of body.organizations) {
    const id = Number(entry.organizationId);
    if (!Number.isInteger(id) || id < 1 || seenOrgs.has(id)) return { error: '组织选择无效或重复' };
    seenOrgs.add(id);
    const organization = await get(`SELECT id, code, name, status, organization_type FROM organizations WHERE id = ?`, [id]);
    if (!organization || organization.status !== 'active') return { error: `组织 ${id} 不存在或已停用` };
    if (entry.included === false) continue;
    const deadlineAt = entry.deadlineAt || defaultDeadline(reportType.cadence, body.periodCode);
    if (!validDeadline(deadlineAt)) return { error: `${organization.name} 的截止时间无效，请使用上海时区或 UTC 时间` };
    if (entry.extensionDeadlineAt && (!validDeadline(entry.extensionDeadlineAt) || Date.parse(entry.extensionDeadlineAt) < Date.parse(deadlineAt))) {
      return { error: `${organization.name} 的延期截止时间无效` };
    }
    organizations.push({ ...organization, deadlineAt, extensionDeadlineAt: entry.extensionDeadlineAt || null });
  }
  if (!organizations.length) return { error: '至少需要包含一个参与组织' };

  const isQuarterlyReference = reportType.cadence === 'quarterly'
    && parse(template.manifest_json, {}).sourceWorkbook?.sha256 === quarterlyReferenceProfile.sha256;

  const quarterlyOwners = new Map();
  if (reportType.cadence === 'quarterly') {
    const rawOrganizations = [...organizations];
    for (const organization of rawOrganizations) {
      const ownerId = await quarterlyOwnerOrganizationId(organization.id, body.periodCode);
      if (!ownerId) return { error: `${organization.name} 按季度末有效组织树无法归属到唯一所属子公司` };
      quarterlyOwners.set(organization.id, ownerId);
    }
    const selectedOwnerIds = new Set(quarterlyOwners.values());
    const owners = new Map();
    for (const organization of rawOrganizations) {
      const ownerId = quarterlyOwners.get(organization.id);
      const owner = await get('SELECT id, code, name, status FROM organizations WHERE id = ? AND status = \'active\'', [ownerId]);
      const current = owners.get(ownerId);
      if (current && (current.deadlineAt !== organization.deadlineAt
        || current.extensionDeadlineAt !== organization.extensionDeadlineAt)) {
        return { error: `${owner.name} 下属单位归并后截止时间不一致，请为同一所属子公司配置一致的截止时间` };
      }
      if (!current || organization.id === ownerId) owners.set(ownerId, { ...owner,
        organization_status: owner.status, organization_id: ownerId,
        deadline_at: organization.deadlineAt, extension_deadline_at: organization.extensionDeadlineAt,
        deadlineAt: organization.deadlineAt, extensionDeadlineAt: organization.extensionDeadlineAt });
    }
    organizations.splice(0, organizations.length, ...[...selectedOwnerIds].map(ownerId => owners.get(ownerId)));
  }

  const config = body.configuration && typeof body.configuration === 'object' && !Array.isArray(body.configuration) ? body.configuration : {};
  if (isQuarterlyReference) {
    const mappingError = referenceCompanySheetMapError(template.workbook_json, organizations, config.referenceCompanySheets);
    if (mappingError) return { error: `${mappingError.replace('配置唯一且有效', '显式选择唯一且有效')}` };
    config.referenceCompanySheets = Object.fromEntries(organizations.map(item => [String(item.id), String(config.referenceCompanySheets[item.id])]));
  } else if (config.referenceCompanySheets != null) {
    delete config.referenceCompanySheets;
  }

  const targets = [];
  for (const target of (Array.isArray(body.targets) ? body.targets : [])) {
    const organizationId = Number(target.organizationId);
    const fieldDefinitionId = Number(target.fieldDefinitionId);
    const amount = decimalString(target.amount);
    if (!seenOrgs.has(organizationId) || !(reportType.cadence === 'quarterly'
      ? organizations.some(item => item.id === quarterlyOwners.get(organizationId))
      : organizations.some(item => item.id === organizationId))
      || !Number.isInteger(fieldDefinitionId) || !targetPhases.has(target.phase) || !amount) return { error: '目标数据无效' };
    if ((reportType.cadence === 'monthly' && target.phase === 'quarterly') || (reportType.cadence === 'quarterly' && target.phase === 'monthly')) {
      return { error: '目标阶段与 Report Type 周期不匹配' };
    }
    const field = await get('SELECT id, code, display_name, status, data_type FROM field_definitions WHERE id = ?', [fieldDefinitionId]);
    if (!field || field.status !== 'approved' || !['integer', 'decimal'].includes(field.data_type)) return { error: '目标只能绑定已批准的数值字段' };
    const phasePeriod = String(target.phasePeriod || '').trim();
    const validPhase = target.phase === 'annual' ? /^\d{4}$/.test(phasePeriod)
      : target.phase === 'monthly' || target.phase === 'cumulative' ? /^\d{4}-(0[1-9]|1[0-2])$/.test(phasePeriod)
        : /^\d{4}-Q[1-4]$/.test(phasePeriod);
    if (!validPhase) return { error: '目标阶段周期格式无效' };
    targets.push({ organizationId: quarterlyOwners.get(organizationId) || organizationId, fieldDefinitionId, fieldCode: field.code, phase: target.phase, phasePeriod, amount, generatedFromAnnual: false });
  }
  for (const generation of (Array.isArray(body.generateMonthlyTargetsFromAnnual) ? body.generateMonthlyTargetsFromAnnual : [])) {
    const organizationId = Number(generation.organizationId);
    const fieldDefinitionId = Number(generation.fieldDefinitionId);
    const year = String(generation.year || '');
    if (!(reportType.cadence === 'quarterly' ? seenOrgs.has(organizationId) : organizations.some(item => item.id === organizationId))
      || !Number.isInteger(fieldDefinitionId) || !/^\d{4}$/.test(year)) return { error: '年度目标生成配置无效' };
    const targetOrganizationId = quarterlyOwners.get(organizationId) || organizationId;
    const annual = targets.find(item => item.organizationId === targetOrganizationId && item.fieldDefinitionId === fieldDefinitionId && item.phase === 'annual' && item.phasePeriod === year);
    if (!annual) return { error: '按年度目标生成月度目标时，必须先提供对应年度目标' };
    const [whole = '0', fraction = ''] = annual.amount.split('.');
    const scale = Math.max(fraction.length, 2);
    const scaledAnnual = BigInt(whole) * (10n ** BigInt(scale)) + BigInt(fraction.padEnd(scale, '0') || '0');
    const monthly = scaledAnnual / 12n;
    const remainder = scaledAnnual % 12n;
    for (let month = 1; month <= 12; month += 1) {
      const valueCents = monthly + (BigInt(month) <= remainder ? 1n : 0n);
      const raw = valueCents.toString().padStart(scale + 1, '0');
      const formatted = `${raw.slice(0, -scale)}.${raw.slice(-scale)}`;
      const amount = formatted.replace(/0+$/, '').replace(/\.$/, '');
      targets.push({ organizationId: quarterlyOwners.get(organizationId) || organizationId, fieldDefinitionId, fieldCode: annual.fieldCode, phase: 'monthly', phasePeriod: `${year}-${String(month).padStart(2, '0')}`, amount, generatedFromAnnual: true });
    }
  }

  const assignments = [];
  for (const assignment of (Array.isArray(body.assignments) ? body.assignments : [])) {
    const organizationId = Number(assignment.organizationId);
    const userId = Number(assignment.userId);
    if (!(reportType.cadence === 'quarterly' ? seenOrgs.has(organizationId) : organizations.some(item => item.id === organizationId))
      || !assignmentsAllowed.has(assignment.responsibility) || !Number.isInteger(userId)
      || (reportType.cadence === 'quarterly' && !organizations.some(item => item.id === quarterlyOwners.get(organizationId)))) return { error: '责任分配无效' };
    const user = await get(`SELECT id, username, name FROM users WHERE id = ? AND account_status = 'active'`, [userId]);
    if (!user) return { error: '责任人不存在或已停用' };
    assignments.push({ organizationId: quarterlyOwners.get(organizationId) || organizationId, userId, responsibility: assignment.responsibility, reason: String(assignment.reason || '').trim().slice(0, 500) || null, userName: user.name, username: user.username });
  }

  const administrator = await defaultAdministrator();
  const required = reportType.cadence === 'quarterly'
    ? [...assignmentsAllowed] : [...assignmentsAllowed].filter(role => role !== 'scorer');
  for (const organization of organizations) for (const responsibility of required) {
    if (assignments.some(item => item.organizationId === organization.id && item.responsibility === responsibility)) continue;
    // Only default when the administrator can actually perform this responsibility.
    if (!administrator || !(await assignmentHasRole(administrator.id, organization.id, responsibility))) continue;
    assignments.push({ organizationId: organization.id, userId: administrator.id, responsibility,
      reason: '未分配职责，默认由系统管理员负责', userName: administrator.name, username: administrator.username });
  }

  const indicators = Array.isArray(body.indicators) ? body.indicators : [];
  if (indicators.length > 1000) return { error: '指标数量超限' };
  const codes = new Set();
  const sourceMonthlyReportTypeId = Number(body.configuration?.monthlySourceReportTypeId);
  if (reportType.cadence === 'quarterly' && (!Number.isSafeInteger(sourceMonthlyReportTypeId)
    || !(await get("SELECT id FROM report_types WHERE id = ? AND cadence = 'monthly' AND status = 'active'", [sourceMonthlyReportTypeId])))) {
    return { error: '季度配置必须选择有效的月度数据来源 Report Type' };
  }
  for (const indicator of indicators) {
    const code = String(indicator.code || '').trim();
    const name = String(indicator.displayName || '').trim();
    const organizationId = Number(indicator.organizationId);
    const weight = Number(indicator.weight);
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(code) || !name || !seenOrgs.has(organizationId)
      || !Number.isFinite(weight) || weight < 0 || weight > 100 || codes.has(`${organizationId}:${code}`)) return { error: '指标定义无效或重复' };
    codes.add(`${organizationId}:${code}`);
    if (reportType.cadence === 'quarterly' && quarterlyOwners.has(organizationId)) {
      indicator.sourceOrganizationId = organizationId;
      indicator.organizationId = quarterlyOwners.get(organizationId);
      const ownerCode = `${indicator.organizationId}:${code}`;
      if (ownerCode !== `${organizationId}:${code}` && codes.has(ownerCode)) return { error: `季度指标 ${code} 在归属子公司内重复，请设置唯一编码` };
      codes.add(ownerCode);
    }
    if (indicator.fieldDefinitionId) {
      const field = await get("SELECT id FROM field_definitions WHERE id = ? AND status = 'approved'", [Number(indicator.fieldDefinitionId)]);
      if (!field) return { error: `指标 ${code} 引用了未批准的字段` };
    }
    if (reportType.cadence === 'quarterly') {
      const category = String(indicator.category || '');
      if (!organizations.some(item => item.id === Number(indicator.organizationId))) return { error: `季度指标 ${code} 未归属到参与子公司` };
      const ownerOrganizationId = Number(indicator.ownerOrganizationId);
      const reviewerUserId = Number(indicator.reviewerUserId);
      const maximumScore = Number(indicator.maximumScore);
      const namedArea = String(indicator.namedArea || '').trim();
      if (!['key_business', 'key_work'].includes(category) || !Number.isFinite(maximumScore) || maximumScore <= 0 || maximumScore > 10000
        || !Number.isSafeInteger(ownerOrganizationId) || !/^[A-Z][A-Z0-9_]*_TABLE_[A-Z][A-Z0-9_]{0,240}$/.test(namedArea)) return { error: `季度指标 ${code} 缺少类别、最高分、归属部门或有效表格命名区域` };
      const owner = await get("SELECT id FROM organizations WHERE id = ? AND organization_type = 'department' AND status = 'active'", [ownerOrganizationId]);
      if (!owner) return { error: `季度指标 ${code} 的归属必须是有效审核部门` };
      const reviewer = await get(`SELECT u.id FROM users u JOIN effective_user_roles ur ON ur.user_id = u.id
        WHERE u.id = ? AND u.organization_id = ? AND u.account_status = 'active' AND ur.role_code = 'department_reviewer'
          AND (ur.organization_id = ? OR ur.organization_id IS NULL) AND ur.effective_from <= CURRENT_TIMESTAMP
          AND (ur.effective_to IS NULL OR ur.effective_to > CURRENT_TIMESTAMP)`,
      [reviewerUserId, ownerOrganizationId, ownerOrganizationId]);
      if (!reviewer) return { error: `季度指标 ${code} 的审核人必须是归属部门的有效审核人` };
      indicator.category = category;
      indicator.ownerOrganizationId = ownerOrganizationId;
      indicator.reviewerUserId = reviewerUserId;
      indicator.maximumScore = maximumScore;
      indicator.namedArea = namedArea;
      indicator.recordKey = `quarterly:${category}:${code}`;
      indicator.tagCode = `QUARTERLY_${category.toUpperCase()}_FILLER`;
      indicator.tag = JSON.stringify({ schemaVersion: 1, denyEditForRoles: ['department_reviewer', 'score_editor'] });
    }
  }
  for (const indicator of indicators) {
    if (!indicator.parentCode) continue;
    const parent = indicators.find(candidate => Number(candidate.organizationId) === Number(indicator.organizationId) && candidate.code === indicator.parentCode);
    if (!parent || parent.code === indicator.code) return { error: `指标 ${indicator.code} 的上级指标不存在或形成自引用` };
    if (indicators.indexOf(parent) > indicators.indexOf(indicator)) return { error: `指标 ${indicator.code} 必须排在上级指标之后` };
  }
  if (reportType.cadence === 'quarterly') {
    const workbook = parse(template.workbook_json, {});
    const mappings = (workbook.sheets || []).flatMap(sheet => sheet.mappings || []);
    const compatibility = quarterlyTemplateCompatibility(workbook);
    if (!compatibility.compatible) return { error: `${compatibility.message} 冲突位置：${compatibility.conflicts.map(item => `${item.sheetName} / ${item.fieldName}（${item.namedArea}）`).join('、')}` };
    const areaCounts = new Map();
    for (const indicator of indicators) {
      const key = `${indicator.organizationId}:${indicator.namedArea}`;
      areaCounts.set(key, { organizationId: Number(indicator.organizationId), namedArea: indicator.namedArea,
        rowCount: (areaCounts.get(key)?.rowCount || 0) + 1 });
    }
    for (const { organizationId, namedArea, rowCount } of areaCounts.values()) {
      const mapping = mappings.find(candidate => candidate.namedArea === namedArea);
      if (!mapping || mapping.kind !== 'table' || mapping.primary !== true || mapping.permission !== 'primary_input'
        || Number(mapping.rowCount) < rowCount + 1) {
        return { error: `模板必须提供容量足够且允许填报的固定 _TABLE_ 命名区域：${namedArea}` };
      }
      const sheet = (workbook.sheets || []).find(candidate => (candidate.mappings || []).includes(mapping));
      const configuredRows = indicators.filter(indicator => indicator.namedArea === namedArea
        && Number(indicator.organizationId) === organizationId);
      const tagConflict = configuredRows.some((indicator, index) => Array.from({ length: Number(mapping.colCount) || 1 }, (_, colOffset) =>
        (sheet?.cells || []).find(cell => Number(cell.row) === Number(mapping.row) + index + 1
          && Number(cell.column ?? cell.col) === Number(mapping.col) + colOffset && cell.tag != null)).some(Boolean));
      if (tagConflict) return { error: `季度指标区域 ${namedArea} 的固定行与模板权限 Tag 冲突` };
    }
  }
  for (const organization of organizations) {
    const scoped = indicators.filter(item => Number(item.organizationId) === organization.id);
    if (scoped.length && Math.abs(scoped.reduce((sum, item) => sum + Number(item.weight), 0) - 100) > 0.000001) {
      return { error: `${organization.name} 的指标权重合计必须为 100%` };
    }
  }

  const ruleVersions = Array.isArray(body.ruleVersionIds) ? [...new Set(body.ruleVersionIds.map(Number))] : [];
  for (const indicator of indicators) {
    const formulaVersionId = Number(indicator.scoreFormulaVersionId ?? indicator.formulaVersionId ?? 0);
    if (!formulaVersionId) { indicator.scoreFormulaVersionId = null; continue; }
    const formula = await get(`SELECT rv.id FROM rule_versions rv JOIN rule_definitions rd ON rd.id = rv.rule_id
      WHERE rv.id = ? AND rv.status = 'published' AND rd.rule_type = 'formula'`, [formulaVersionId]);
    if (!formula) return { error: `指标 ${indicator.code} 的评分公式必须是已发布 Business Formula 版本` };
    indicator.scoreFormulaVersionId = formulaVersionId;
    if (!ruleVersions.includes(formulaVersionId)) ruleVersions.push(formulaVersionId);
  }
  for (const id of ruleVersions) {
    if (!Number.isInteger(id)) return { error: '规则版本选择无效' };
    const rule = await get(`SELECT rv.id, rv.rule_id, rv.version, rv.expression_json, rv.parameters_json, rv.severity,
        rd.code, rd.rule_type FROM rule_versions rv JOIN rule_definitions rd ON rd.id = rv.rule_id
      WHERE rv.id = ? AND rv.status = 'published'`, [id]);
    if (!rule) return { error: '只能选择已发布的规则或公式版本' };
    if (parse(rule.expression_json, {}).engine === 'spreadjs-validator') return { error: '单元格校验请在模板 Designer 中应用到区域，无需加入周期规则' };
  }
  const ruleThresholds = readRuleThresholds(body.ruleThresholds == null ? DEFAULT_RULE_THRESHOLDS : body.ruleThresholds);
  if (!ruleThresholds) return { error: '规则比例无效：各比例须在 0% 至 1000% 之间，且目标完成率下限须低于上限' };
  if (reportType.cadence === 'quarterly') config.monthlySourceReportTypeId = sourceMonthlyReportTypeId;
  const metricWeights = body.metricWeights && typeof body.metricWeights === 'object' && !Array.isArray(body.metricWeights)
    ? { revenue: Number(body.metricWeights.revenue), profit: Number(body.metricWeights.profit) } : {};
  return { value: { periodCode: body.periodCode, template, organizations, targets, assignments, indicators, metricWeights,
    ruleVersionIds: ruleVersions, ruleThresholds, configuration: config } };
}

async function persistChildren(packageId, value, actorId, existingOrgRows = false) {
  if (existingOrgRows) await run('DELETE FROM package_organizations WHERE package_id = ?', [packageId]);
  for (const org of value.organizations) {
    await run(`INSERT INTO package_organizations (package_id, organization_id, included, deadline_at, extension_deadline_at, targets_json)
      VALUES (?, ?, 1, ?, ?, ?)`, [packageId, org.id, org.deadlineAt, org.extensionDeadlineAt, JSON.stringify(value.targets.filter(item => item.organizationId === org.id))]);
  }
  if (existingOrgRows) {
    await run('DELETE FROM package_targets WHERE package_id = ?', [packageId]);
    await run('DELETE FROM package_assignments WHERE package_id = ?', [packageId]);
  }
  for (const target of value.targets) await run(`INSERT INTO package_targets
    (package_id, organization_id, field_definition_id, target_phase, phase_period, amount_decimal, generated_from_annual)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [packageId, target.organizationId, target.fieldDefinitionId, target.phase, target.phasePeriod, target.amount, target.generatedFromAnnual ? 1 : 0]);
  for (const assignment of value.assignments) await run(`INSERT INTO package_assignments
    (package_id, organization_id, responsibility, user_id, assigned_by, reason) VALUES (?, ?, ?, ?, ?, ?)`
  , [packageId, assignment.organizationId, assignment.responsibility, assignment.userId, actorId, assignment.reason]);
}

exports.listReportTypes = asyncRoute(async (req, res) => {
  const reportTypes = await all(`SELECT rt.id, rt.code, rt.display_name AS displayName, rt.cadence, rt.workflow_profile AS workflowProfile,
      rt.status, COUNT(DISTINCT p.id) AS packageCount FROM report_types rt LEFT JOIN period_packages p ON p.report_type_id = rt.id
    GROUP BY rt.id ORDER BY rt.id DESC`);
  res.json({ reportTypes });
});

exports.createReportType = asyncRoute(async (req, res) => {
  const code = String(req.body.code || '').trim();
  const displayName = String(req.body.displayName || '').trim();
  const cadence = req.body.cadence;
  if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code) || !displayName || displayName.length > 120 || !['monthly', 'quarterly'].includes(cadence)) return fail(res, 400, 'Report Type 编码、名称或周期无效');
  try {
    const result = await run(`INSERT INTO report_types (code, display_name, cadence, workflow_profile, created_by)
      VALUES (?, ?, ?, ?, ?)`, [code, displayName, cadence, cadence, req.user.id]);
    await recordBusinessAudit({ actor: req.user, action: 'report_type.create', objectType: 'report_type', objectId: result.lastID,
      businessVersion: '1', after: { code, displayName, cadence, workflowProfile: cadence } });
    res.status(201).json({ reportTypeId: result.lastID, code, displayName, cadence, workflowProfile: cadence });
  } catch (error) {
    if (/UNIQUE constraint failed: report_types.code/.test(error.message)) return fail(res, 409, 'Report Type 编码已存在');
    throw error;
  }
});

exports.listResources = asyncRoute(async (req, res) => {
  await ensureDefaultRules(req.user);
  const organizations = await all("SELECT id, code, name, organization_type AS organizationType FROM organizations WHERE status = 'active' ORDER BY code");
  const userRoles = await all(`SELECT user_id AS userId, role_code AS code, organization_id AS organizationId
    FROM effective_user_roles WHERE effective_from <= CURRENT_TIMESTAMP AND (effective_to IS NULL OR effective_to > CURRENT_TIMESTAMP)`);
  const users = (await all("SELECT id, username, name, organization_id AS organizationId FROM users WHERE account_status = 'active' ORDER BY name"))
    .map(user => ({ ...user, roles: userRoles.filter(role => Number(role.userId) === Number(user.id))
      .map(({ code, organizationId }) => ({ code, organizationId })) }));
  const templates = await all(`SELECT tv.id AS versionId, tv.version, tv.template_id AS templateId, t.name AS templateName, tv.published_at AS publishedAt,
      tv.manifest_json, tv.workbook_json
    FROM template_versions tv JOIN templates t ON t.id = tv.template_id WHERE tv.status = 'published' ORDER BY t.name, tv.version DESC`);
  for (const template of templates) {
    template.quarterlyCompatibility = quarterlyTemplateCompatibility(parse(template.workbook_json, {}));
    template.isQuarterlyReference = parse(template.manifest_json, {}).sourceWorkbook?.sha256 === quarterlyReferenceProfile.sha256;
    template.companySheets = template.isQuarterlyReference ? await all(`SELECT sheet_code AS code, display_name AS name FROM template_sheets
      WHERE template_version_id = ? AND sheet_type = 'business' ORDER BY sheet_order`, [template.versionId]) : [];
    template.fieldCodes = [...new Set((parse(template.workbook_json, {}).sheets || []).flatMap(sheet => (sheet.mappings || []).map(mapping => mapping.fieldCode)).filter(Boolean))];
    delete template.manifest_json;
    delete template.workbook_json;
  }
  const fields = await all("SELECT id, code, display_name AS displayName, data_type AS dataType FROM field_definitions WHERE status = 'approved' ORDER BY code");
  const rules = await all(`SELECT rv.id AS versionId, rv.version, rd.code, rd.display_name AS displayName, rd.rule_type AS ruleType
    FROM rule_versions rv JOIN rule_definitions rd ON rd.id = rv.rule_id WHERE rv.status = 'published' AND COALESCE(json_extract(rv.expression_json, '$.engine'),'') <> 'spreadjs-validator' ORDER BY rd.rule_type, rd.code, rv.version DESC`);
  res.json({ organizations, users, templates, fields, rules, defaultAdministrator: await defaultAdministrator(), ruleThresholdDefaults: { ...DEFAULT_RULE_THRESHOLDS } });
});

exports.listPackages = asyncRoute(async (req, res) => {
  const ids = await all(`SELECT id FROM period_packages p WHERE NOT EXISTS
    (SELECT 1 FROM period_package_drafts d WHERE d.package_id = p.id) ORDER BY created_at DESC, id DESC`);
  const drafts = await all('SELECT * FROM period_package_drafts ORDER BY updated_at DESC, id DESC');
  res.json({ packages: [...await Promise.all(drafts.map(editorDraftView)),
    ...(await Promise.all(ids.map(row => packageView(row.id)))).filter(Boolean)] });
});

exports.createPackage = asyncRoute(async (req, res) => {
  if (req.body.draftOnly === true) return saveEditorDraft(req, res);
  const reportType = await get("SELECT * FROM report_types WHERE id = ? AND status = 'active'", [Number(req.body.reportTypeId)]);
  if (!reportType) return fail(res, 400, 'Report Type 不存在或已停用');
  const checked = await readDraftInput(req.body, reportType);
  if (checked.error) return fail(res, 400, checked.error);
  const value = checked.value;
  await run('BEGIN IMMEDIATE');
  try {
    const latest = await get('SELECT COALESCE(MAX(version), 0) AS version FROM period_packages WHERE report_type_id = ? AND period_code = ?', [reportType.id, value.periodCode]);
    const inserted = await run(`INSERT INTO period_packages (report_type_id, period_code, version, template_version_id, configuration_json, created_by)
      VALUES (?, ?, ?, ?, ?, ?)`, [reportType.id, value.periodCode, latest.version + 1, value.template.id,
      JSON.stringify({ ...value.configuration, indicators: value.indicators, metricWeights: value.metricWeights, ruleVersionIds: value.ruleVersionIds,
        ruleThresholds: value.ruleThresholds, templateVersion: value.template.version }), req.user.id]);
    await persistChildren(inserted.lastID, value, req.user.id);
    await run('COMMIT');
    await recordBusinessAudit({ actor: req.user, action: 'period_package.create', objectType: 'period_package', objectId: inserted.lastID,
      businessVersion: String(latest.version + 1), after: { reportTypeId: reportType.id, periodCode: value.periodCode,
        organizationCount: value.organizations.length, ruleThresholds: value.ruleThresholds } });
    res.status(201).json({ package: await packageView(inserted.lastID) });
  } catch (error) { await run('ROLLBACK').catch(() => {}); if (/UNIQUE constraint/.test(error.message)) return fail(res, 409, '此填报计划版本冲突'); throw error; }
});

exports.updatePackage = asyncRoute(async (req, res) => {
  if (req.body.draftOnly === true || String(req.params.id).startsWith('draft-')) return saveEditorDraft(req, res, req.params.id);
  if (await editorDraft(req.params.id)) return fail(res, 409, '此填报计划有待完成的编辑草稿，请先编辑该草稿');
  const packageId = Number(req.params.id);
  const current = await get('SELECT * FROM period_packages WHERE id = ?', [packageId]);
  if (!current) return fail(res, 404, '填报计划不存在');
  if (!['draft', 'validated'].includes(current.status)) return fail(res, 409, '只有未激活的填报计划可以修改；已激活配置必须新建版本');
  const reportType = await get('SELECT * FROM report_types WHERE id = ?', [current.report_type_id]);
  const checked = await readDraftInput({ ...req.body, periodCode: current.period_code, reportTypeId: current.report_type_id }, reportType);
  if (checked.error) return fail(res, 400, checked.error);
  const value = checked.value;
  const previousConfiguration = parse(current.configuration_json);
  const previousRuleThresholds = readRuleThresholds(previousConfiguration.ruleThresholds) || { ...DEFAULT_RULE_THRESHOLDS };
  await run('BEGIN IMMEDIATE');
  try {
    await run("UPDATE period_packages SET template_version_id = ?, configuration_json = ?, status = 'draft' WHERE id = ? AND status IN ('draft','validated')",
      [value.template.id, JSON.stringify({ ...value.configuration, indicators: value.indicators, metricWeights: value.metricWeights, ruleVersionIds: value.ruleVersionIds,
        ruleThresholds: value.ruleThresholds, templateVersion: value.template.version }), packageId]);
    await persistChildren(packageId, value, req.user.id, true);
    await run('COMMIT');
    await recordBusinessAudit({ actor: req.user, action: 'period_package.update', objectType: 'period_package', objectId: packageId,
      businessVersion: String(current.version), before: { ruleThresholds: previousRuleThresholds },
      after: { templateVersionId: value.template.id, organizationCount: value.organizations.length, ruleThresholds: value.ruleThresholds } });
    res.json({ package: await packageView(packageId) });
  } catch (error) { await run('ROLLBACK').catch(() => {}); throw error; }
});

exports.validatePackage = asyncRoute(async (req, res) => {
  const draft = await editorDraft(req.params.id);
  if (draft) {
    const result = await materializeEditorDraft(draft, req.user);
    return res.json({ valid: result.errors.length === 0, errors: result.errors, packageId: result.packageId || `draft-${draft.id}` });
  }
  const item = await packageView(Number(req.params.id));
  if (!item) return fail(res, 404, '填报计划不存在');
  if (item.status !== 'draft' && item.status !== 'validated') return fail(res, 409, '当前填报计划状态不允许校验');
  const reportType = await get('SELECT * FROM report_types WHERE id = ?', [item.report_type_id]);
  const errors = await packageValidationErrors(item, reportType);
  if (errors.length === 0 && item.status === 'draft') {
    await run("UPDATE period_packages SET status = 'validated' WHERE id = ? AND status = 'draft'", [item.id]);
    await recordBusinessAudit({ actor: req.user, action: 'period_package.validate', objectType: 'period_package', objectId: item.id,
      businessVersion: String(item.version), after: { status: 'validated', valid: true } });
  }
  res.json({ valid: errors.length === 0, errors, packageId: item.id });
});

exports.activatePackage = asyncRoute(async (req, res) => {
  await ensureDefaultRules(req.user);
  const draft = await editorDraft(req.params.id);
  let packageId = Number(req.params.id);
  if (draft) {
    const result = await materializeEditorDraft(draft, req.user);
    if (result.errors.length) return res.status(400).json({ error: '草稿尚未填写完整，暂不能激活', errors: result.errors });
    packageId = result.packageId;
  }
  const before = await get('SELECT * FROM period_packages WHERE id = ?', [packageId]);
  if (!before) return fail(res, 404, '填报计划不存在');
  if (before.status === 'active') return fail(res, 409, '填报计划已经激活');
  if (before.status !== 'draft' && before.status !== 'validated') return fail(res, 409, '只有草稿或已校验的填报计划可以激活');
  const current = await packageView(packageId);
  const reportType = await get('SELECT * FROM report_types WHERE id = ?', [before.report_type_id]);
  const validation = await packageValidationErrors(current, reportType);
  const cfg = current.configuration;
  const indicators = cfg.indicators || [];
  if (validation.length) return res.status(400).json({ error: '填报计划未通过激活校验', errors: validation });

  await run('ATTACH DATABASE ? AS collaboration_store', [getCollaborationDatabasePath()]);
  await run('BEGIN IMMEDIATE');
  let taskIds = [];
  try {
    const locked = await get('SELECT status FROM period_packages WHERE id = ?', [packageId]);
    if (!locked || !['draft', 'validated'].includes(locked.status)) throw Object.assign(new Error('填报计划状态已改变'), { status: 409 });
    const organizations = await all(`SELECT po.*, o.status AS organization_status FROM package_organizations po
      JOIN organizations o ON o.id = po.organization_id WHERE po.package_id = ? ORDER BY po.organization_id`, [packageId]);
    const assignments = await all(`SELECT pa.*, u.account_status FROM package_assignments pa JOIN users u ON u.id = pa.user_id WHERE pa.package_id = ?`, [packageId]);
    const targets = await all(`SELECT pt.*, fd.code AS field_code, fd.version AS field_version FROM package_targets pt
      JOIN field_definitions fd ON fd.id = pt.field_definition_id WHERE pt.package_id = ?`, [packageId]);
    const defaultAnomalyRows = await all(`SELECT rv.id, rd.code,
        CASE WHEN rv.version = (SELECT MAX(latest.version) FROM rule_versions latest
          WHERE latest.rule_id = rv.rule_id AND latest.status = 'published') THEN 1 ELSE 0 END AS is_latest
      FROM rule_versions rv
      JOIN rule_definitions rd ON rd.id = rv.rule_id
      WHERE rd.code IN (${DEFAULT_ANOMALY_RULE_CODES.map(() => '?').join(',')})
        AND rd.rule_type = 'anomaly' AND rv.status = 'published'`, DEFAULT_ANOMALY_RULE_CODES);
    const defaultAnomalyVersionIds = new Set(defaultAnomalyRows.map(row => Number(row.id)));
    const selectedNonDefaultRuleIds = (cfg.ruleVersionIds || []).map(Number)
      .filter(id => !defaultAnomalyVersionIds.has(id));
    const latestDefaultRuleIds = defaultAnomalyRows.filter(row => Number(row.is_latest) === 1).map(row => Number(row.id));
    const taskRuleVersions = [...new Set([...selectedNonDefaultRuleIds, ...latestDefaultRuleIds])];
    if (!organizations.length || organizations.some(org => org.organization_status !== 'active')) throw Object.assign(new Error('参与组织状态已改变，请重新编辑填报计划'), { status: 409 });
    if (assignments.some(item => item.account_status !== 'active')) throw Object.assign(new Error('责任人账户已停用，请重新编辑填报计划'), { status: 409 });
    for (const assignment of assignments) {
      if (!(await assignmentHasRole(assignment.user_id, assignment.organization_id, assignment.responsibility))) {
        throw Object.assign(new Error('责任人职责已变化，请重新编辑填报计划'), { status: 409 });
      }
    }
    const taskSnapshots = [];
    for (const org of organizations) {
      const orgAssignments = assignments.filter(item => item.organization_id === org.organization_id).map(item => ({
        responsibility: item.responsibility, userId: item.user_id, reason: item.reason
      }));
      const orgTargets = targets.filter(item => item.organization_id === org.organization_id).map(item => ({
        fieldDefinitionId: item.field_definition_id, fieldCode: item.field_code, fieldVersion: item.field_version,
        phase: item.target_phase, phasePeriod: item.phase_period, amount: item.amount_decimal, generatedFromAnnual: Boolean(item.generated_from_annual)
      }));
      taskSnapshots.push({ organizationId: org.organization_id, deadlineAt: org.deadline_at,
        extensionDeadlineAt: org.extension_deadline_at || null, templateVersionId: before.template_version_id,
        reportTypeId: before.report_type_id, periodCode: before.period_code, packageId, packageVersion: before.version,
        workflowProfile: reportType.workflow_profile, configuration: { ...cfg,
          indicators: indicators.filter(indicator => Number(indicator.organizationId) === Number(org.organization_id)),
          ruleVersionIds: taskRuleVersions },
        targets: orgTargets, assignments: orgAssignments, ruleVersions: taskRuleVersions });
    }
    for (const snapshot of taskSnapshots) {
      const inserted = await run(`INSERT INTO report_tasks
        (package_id, report_type_id, organization_id, period_code, task_status, deadline_at, configuration_snapshot_json, template_version_id)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`, [packageId, before.report_type_id, snapshot.organizationId, before.period_code,
        snapshot.deadlineAt, JSON.stringify(snapshot), before.template_version_id]);
      taskIds.push(inserted.lastID);
      const roomKey = `report-task-${inserted.lastID}-revision-1`;
      const room = await run(`INSERT INTO collaboration_rooms (task_id, revision_number, collaboration_room_key, collaboration_db)
        VALUES (?, 1, ?, ?)`, [inserted.lastID, roomKey, getCollaborationDatabasePath()]);
      await run('UPDATE collaboration_rooms SET snapshot_reference = ? WHERE id = ?', [`${roomKey}@0`, room.lastID]);
      await run(`INSERT INTO collaboration_store.collaboration_rooms (room_key, task_id, revision_number, room_status, current_version)
        VALUES (?, ?, 1, 'open', 0)`, [roomKey, inserted.lastID]);
      const workbook = await get('SELECT workbook_json, manifest_json FROM template_versions WHERE id = ?', [before.template_version_id]);
      const scopedWorkbook = scopeQuarterlyWorkbook(parse(workbook?.workbook_json, {}), snapshot.organizationId,
        snapshot.configuration.referenceCompanySheets,
        isQuarterlyReferenceTemplate(parse(workbook?.manifest_json, {})));
      await run(`INSERT INTO collaboration_store.collaboration_snapshots (room_id, version, snapshot_json)
        VALUES ((SELECT id FROM collaboration_store.collaboration_rooms WHERE room_key = ?), 0, ?)`, [roomKey, JSON.stringify(scopedWorkbook)]);
      await run('UPDATE collaboration_rooms SET latest_version = 0 WHERE id = ?', [room.lastID]);
      const orgIndicators = indicators.filter(indicator => Number(indicator.organizationId) === snapshot.organizationId);
      const indicatorIds = new Map();
      for (let index = 0; index < orgIndicators.length; index += 1) {
        const indicator = orgIndicators[index];
        const parentId = indicator.parentCode ? (indicatorIds.get(indicator.parentCode) || null) : null;
        const insertedIndicator = await run(`INSERT INTO task_indicators
          (task_id, indicator_code, parent_id, field_definition_id, display_name, indicator_type, weight, sort_order, configuration_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [inserted.lastID, indicator.code, parentId,
          indicator.fieldDefinitionId ? Number(indicator.fieldDefinitionId) : null, indicator.displayName,
          indicator.type || 'quantitative', Number(indicator.weight), index, JSON.stringify(indicator)]);
        indicatorIds.set(indicator.code, insertedIndicator.lastID);
      }
    }
    await run(`UPDATE period_packages SET status = 'active', activated_by = ?, activated_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.user.id, packageId]);
    await run('COMMIT');
    await run('DETACH DATABASE collaboration_store');
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    await run('DETACH DATABASE collaboration_store').catch(() => {});
    if (error.status) return fail(res, error.status, error.message);
    if (/UNIQUE constraint failed/.test(error.message) || /FOREIGN KEY constraint failed/.test(error.message)) return fail(res, 409, '任务生成冲突，激活已回滚');
    throw error;
  }
  await recordBusinessAudit({ actor: req.user, action: 'period_package.activate', objectType: 'period_package', objectId: packageId,
    businessVersion: String(before.version), after: { status: 'active', taskIds, taskCount: taskIds.length, ruleThresholds: cfg.ruleThresholds } });
  res.json({ packageId, status: 'active', taskIds, taskCount: taskIds.length });
});
