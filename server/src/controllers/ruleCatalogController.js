const { isManagedFunction, validateDefinition, inspectDefinition } = require('../services/managedFunctions');
const { readFunctionIdentity } = require('../services/functionSignature');
const { assertFunctionIdentityAvailable } = require('../services/functionIdentity');
const { isNativeRule, validateNativeDefinition } = require('../services/nativeValidatorDefinition');
const { hasRole } = require('../middleware/auth');
const db = require('../config/database');
const { recordBusinessAudit } = require('../services/businessAudit');
const { validateExpression, evaluateExpression, resultsEqual } = require('../services/ruleEvaluator');

const TYPES = new Set(['validation', 'anomaly', 'formula']);
const SCOPES = new Set(['field', 'cross_field', 'cross_period', 'aggregate', 'anomaly', 'business_formula']);
const SEVERITIES = new Set(['blocking', 'warning', 'info']);
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) { if (error) reject(error); else resolve(this); }));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
function fail(res, error, message) { res.status(error.status || 500).json({ error: error.message || message }); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }

function normalize(input) {
  const code = String(input.code || '').trim().toUpperCase();
  const displayName = String(input.displayName || '').trim();
  const ruleType = input.ruleType;
  const scope = input.scope;
  let expression = input.expression;
  const parameters = input.parameters == null ? {} : input.parameters;
  const description = String(input.description || '').trim();
  const severity = input.severity || (ruleType === 'anomaly' ? 'warning' : 'blocking');
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) throw Object.assign(new Error('规则编码须为 2 至 64 位大写英文、数字或下划线，并以字母开头'), { status: 400 });
  if (!displayName || displayName.length > 120) throw Object.assign(new Error('规则名称必填且不能超过 120 个字符'), { status: 400 });
  if (!TYPES.has(ruleType) || !SCOPES.has(scope)) throw Object.assign(new Error('规则类型或适用范围无效'), { status: 400 });
  if (ruleType === 'anomaly' && scope !== 'anomaly') throw Object.assign(new Error('异常规则的适用范围必须为 anomaly'), { status: 400 });
  if (ruleType === 'formula' && scope !== 'business_formula') throw Object.assign(new Error('业务公式的适用范围必须为 business_formula'), { status: 400 });
  if (ruleType === 'validation' && !['field', 'cross_field', 'cross_period', 'aggregate'].includes(scope)) throw Object.assign(new Error('校验规则范围无效'), { status: 400 });
  if (!SEVERITIES.has(severity) || (ruleType === 'formula' && severity !== 'info')) throw Object.assign(new Error('严重级别无效'), { status: 400 });
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || JSON.stringify(parameters).length > 8000) throw Object.assign(new Error('参数须为不超过 8 KB 的 JSON 对象'), { status: 400 });
  if (description.length > 2000) throw Object.assign(new Error('说明不能超过 2000 个字符'), { status: 400 });
  if (isNativeRule(expression)) {
    if (ruleType !== 'validation' || scope !== 'field') throw Object.assign(new Error('原生校验请在模板中应用到单元格'), { status: 400 });
    validateNativeDefinition(expression);
    if (severity !== ['blocking','warning','info'][expression.config.errorStyle]) throw Object.assign(new Error('校验处理方式与严重级别不一致'), { status: 400 });
  } else if (isManagedFunction(expression)) {
    if (ruleType !== 'formula') throw Object.assign(new Error('自定义函数必须使用公式类别'), { status: 400 });
    validateDefinition(expression);
    try {
      const { className, functionName, typeName } = readFunctionIdentity(expression.sourceCode, true);
      expression = { engine: 'spreadjs-function', schemaVersion: 1, sourceCode: expression.sourceCode, className, functionName, typeName };
    } catch (error) { throw Object.assign(error, { status: 400 }); }
  } else validateExpression(expression);
  const expressionJson = JSON.stringify(expression);
  if (expressionJson.length > (isManagedFunction(expression) ? 80000 : 16000)) throw Object.assign(new Error('表达式不能超过 16 KB'), { status: 400 });
  return { code, displayName, ruleType, scope, expression, parameters, description, severity };
}

function normalizeCases(input, native = false) {
  if (!Array.isArray(input) || input.length > 100) throw Object.assign(new Error('最多提供 100 个测试样例'), { status: 400 });
  const cases = input.map((test, index) => {
    if (!test || typeof test !== 'object' || !test.input || typeof test.input !== 'object' || Array.isArray(test.input) || !Object.prototype.hasOwnProperty.call(test, 'expected')) {
      throw Object.assign(new Error(`第 ${index + 1} 个样例须包含 input 和 expected`), { status: 400 });
    }
    const name = String(test.name || `样例 ${index + 1}`).trim();
    if (name.length > 120 || JSON.stringify(test).length > 20000) throw Object.assign(new Error(`第 ${index + 1} 个样例过大`), { status: 400 });
    return { name, input: test.input, expected: test.expected, ...(native && typeof test.nativeActual === 'boolean' ? { nativeActual: test.nativeActual } : {}) };
  });
  if (JSON.stringify(cases).length > 256000) throw Object.assign(new Error('测试样例总大小不能超过 256 KB'), { status: 400 });
  return cases;
}

function runCases(version, cases) {
  return cases.map(test => {
    try {
      const expression = parseJson(version.expression_json, null);
      const actual = isNativeRule(expression) ? test.nativeActual : evaluateExpression(expression, test.input, parseJson(version.parameters_json, {}));
      if (isNativeRule(expression) && (typeof actual !== 'boolean' || typeof test.expected !== 'boolean')) throw new Error('请在浏览器运行原生校验测试');
      return { name: test.name, expected: test.expected, actual, passed: resultsEqual(actual, test.expected) };
    } catch (error) { return { name: test.name, expected: test.expected, error: error.message, passed: false }; }
  });
}

async function audit(req, action, version, before, after, reason) {
  await recordBusinessAudit({ actor: req.user, action, objectType: 'rule_version', objectId: version.id,
    businessVersion: String(version.version), before, after, reason, outcome: 'success', requestId: req.get('x-request-id') || null });
}

const DEFAULT_RULES = [
  { code: 'DEFAULT_YOY_CHANGE', name: '同比变化异常', scope: 'anomaly', expression: { op: 'gte', args: [{ op: 'abs', args: [{ op: 'divide', args: [{ op: 'subtract', args: [{ field: 'current' }, { field: 'priorYearSamePeriod' }] }, { field: 'priorYearSamePeriod' }] }] }, { param: 'threshold' }] }, parameters: { threshold: 0.3 }, description: '当前值相对上年同期绝对变化达到阈值时提示。分母为空或为零时不触发。', testCases: [{ name: '达到同比预警线', input: { current: 130, priorYearSamePeriod: 100 }, expected: true }, { name: '上年同期为零', input: { current: 130, priorYearSamePeriod: 0 }, expected: false }] },
  { code: 'DEFAULT_MOM_CHANGE', name: '环比变化异常', scope: 'anomaly', expression: { op: 'gte', args: [{ op: 'abs', args: [{ op: 'divide', args: [{ op: 'subtract', args: [{ field: 'current' }, { field: 'priorPeriod' }] }, { field: 'priorPeriod' }] }] }, { param: 'threshold' }] }, parameters: { threshold: 0.3 }, description: '当前值相对上期绝对变化达到阈值时提示。分母为空或为零时不触发。', testCases: [{ name: '未达到环比预警线', input: { current: 120, priorPeriod: 100 }, expected: false }, { name: '达到环比预警线', input: { current: 130, priorPeriod: 100 }, expected: true }] },
  { code: 'DEFAULT_COMPLETION_BAND', name: '完成率偏离预警区间', scope: 'anomaly', expression: { op: 'or', args: [{ op: 'lt', args: [{ op: 'completion_rate', args: [{ field: 'actual' }, { field: 'target' }] }, { param: 'minimum' }] }, { op: 'gt', args: [{ op: 'completion_rate', args: [{ field: 'actual' }, { field: 'target' }] }, { param: 'maximum' }] }] }, parameters: { minimum: 0.7, maximum: 1.3 }, description: '完成率低于 70% 或高于 130% 时提示。', testCases: [{ name: '低于下限', input: { actual: 60, target: 100 }, expected: true }, { name: '处于区间', input: { actual: 100, target: 100 }, expected: false }, { name: '高于上限', input: { actual: 140, target: 100 }, expected: true }] },
  { code: 'DEFAULT_NEGATIVE_REVENUE', name: '负收入预警', scope: 'anomaly', expression: { op: 'lt', args: [{ field: 'revenue' }, 0] }, parameters: {}, description: '营业收入为负数时提示。', testCases: [{ name: '负数收入', input: { revenue: -1 }, expected: true }, { name: '零收入', input: { revenue: 0 }, expected: false }] },
  { code: 'DEFAULT_ADJUSTMENT_PRESENT', name: '存在调整记录预警', scope: 'anomaly', expression: { op: 'eq', args: [{ field: 'hasAdjustment' }, true] }, parameters: {}, description: '存在已登记调整时提示并要求说明。', testCases: [{ name: '存在调整', input: { hasAdjustment: true }, expected: true }, { name: '无调整', input: { hasAdjustment: false }, expected: false }] },
  { code: 'CONTROL_LOSS_FORMULA', name: '控制亏损系数', scope: 'business_formula', expression: { op: 'control_loss', args: [{ field: 'actual' }, { field: 'target' }] }, parameters: {}, description: '按已确认口径计算 2 - 实际值 / 目标值；目标为空或为零时返回 null。', testCases: [{ name: '控制亏损系数', input: { actual: 80, target: 100 }, expected: 1.2 }, { name: '零目标', input: { actual: 80, target: 0 }, expected: null }] }
];

async function ensureDefaultRules(actor) {
  for (const rule of DEFAULT_RULES) {
    const found = await get('SELECT id FROM rule_definitions WHERE code = ?', [rule.code]);
    if (found) continue;
    await run('BEGIN IMMEDIATE');
    try {
      const again = await get('SELECT id FROM rule_definitions WHERE code = ?', [rule.code]);
      if (again) { await run('COMMIT'); continue; }
      const ruleType = rule.scope === 'business_formula' ? 'formula' : 'anomaly';
      const seedCases = rule.testCases || [];
      if (!runCases({ expression_json: JSON.stringify(rule.expression), parameters_json: JSON.stringify(rule.parameters) }, seedCases).every(result => result.passed)) {
        throw new Error(`Built-in rule fixture failed for ${rule.code}`);
      }
      const definition = await run(`INSERT INTO rule_definitions (code, rule_type, display_name, status, created_by)
        VALUES (?, ?, ?, 'active', ?)`, [rule.code, ruleType, rule.name, actor.id]);
      await run(`INSERT INTO rule_versions (rule_id, version, expression_json, parameters_json, severity, status, created_by,
        rule_scope, description, test_cases_json, tested_at, seeded)
        VALUES (?, 1, ?, ?, ?, 'published', ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)`,
      [definition.lastID, JSON.stringify(rule.expression), JSON.stringify(rule.parameters), ruleType === 'anomaly' ? 'warning' : 'info', actor.id, rule.scope, rule.description, JSON.stringify(seedCases)]);
      const version = await get('SELECT id, version FROM rule_versions WHERE rule_id = ? AND version = 1', [definition.lastID]);
      await recordBusinessAudit({ actor: reqActor(actor), action: 'rule_version.seed', objectType: 'rule_version', objectId: version.id,
        businessVersion: '1', after: { code: rule.code, seeded: true, status: 'published' }, reason: 'platform_default', outcome: 'success' });
      await run('COMMIT');
    } catch (error) { await run('ROLLBACK').catch(() => {}); throw error; }
  }
}
function reqActor(actor) { return { id: actor.id, organizationId: actor.organizationId }; }

exports.catalog = async (req, res) => {
  try {
    await ensureDefaultRules(req.user);
    const canReadUnpublished = (req.user?.roles || []).some(role =>
      ['system_admin', 'business_rule_administrator', 'business_rule_reviewer'].includes(role.code));
    const rows = await all(`SELECT d.id AS ruleId, d.code, d.rule_type AS ruleType, d.display_name AS displayName, d.status AS ruleStatus,
      d.created_by AS ruleCreatedBy, v.id AS versionId, v.version, v.expression_schema_version AS expressionSchemaVersion,
      v.rule_scope AS scope, v.description, v.expression_json AS expressionJson,
      v.parameters_json AS parametersJson, v.severity, v.status, v.created_by AS createdBy, creator.name AS creatorName,
      v.reviewed_by AS reviewedBy, reviewer.name AS reviewerName, v.supersedes_version_id AS supersedesVersionId,
      v.published_at AS publishedAt, v.test_cases_json AS testCasesJson, v.tested_at AS testedAt, v.seeded, v.review_note AS reviewNote
      FROM rule_definitions d JOIN rule_versions v ON v.rule_id = d.id
      LEFT JOIN users creator ON creator.id = v.created_by LEFT JOIN users reviewer ON reviewer.id = v.reviewed_by
      WHERE ? = 1 OR v.status = 'published'
      ORDER BY d.code, v.version DESC`, [canReadUnpublished ? 1 : 0]);
    res.json({ rules: rows.map(row => ({ ...row, expression: parseJson(row.expressionJson, null), parameters: parseJson(row.parametersJson, {}), testCases: parseJson(row.testCasesJson, []) })) });
  } catch (error) { fail(res, error, '读取规则目录失败'); }
};

exports.ensureDefaultRules = ensureDefaultRules;

exports.versions = async (req, res) => {
  const ruleId = Number(req.params.ruleId);
  if (!Number.isSafeInteger(ruleId) || ruleId <= 0) return res.status(400).json({ error: '规则编号无效' });
  try {
    const versions = await all(`SELECT v.id, v.version, v.expression_schema_version AS expressionSchemaVersion,
      v.rule_scope AS scope, v.description, v.expression_json AS expressionJson,
      v.parameters_json AS parametersJson, v.severity, v.status, v.created_by AS createdBy, creator.name AS creatorName,
      v.reviewed_by AS reviewedBy, reviewer.name AS reviewerName, v.supersedes_version_id AS supersedesVersionId,
      v.published_at AS publishedAt, v.test_cases_json AS testCasesJson, v.seeded, v.review_note AS reviewNote
      FROM rule_versions v LEFT JOIN users creator ON creator.id = v.created_by LEFT JOIN users reviewer ON reviewer.id = v.reviewed_by
      WHERE v.rule_id = ? ORDER BY v.version DESC`, [ruleId]);
    res.json({ versions: versions.map(row => ({ ...row, expression: parseJson(row.expressionJson, null), parameters: parseJson(row.parametersJson, {}), testCases: parseJson(row.testCasesJson, []) })) });
  } catch (error) { fail(res, error, '读取规则版本失败'); }
};

exports.create = async (req, res) => {
  let data;
  try { data = normalize(req.body); }
  catch (error) { return fail(res, error, '规则定义无效'); }
  try {
    const cases = normalizeCases(req.body.testCases || []);
    await run('BEGIN IMMEDIATE');
    const duplicate = await get('SELECT id FROM rule_definitions WHERE code = ?', [data.code]);
    if (duplicate) throw Object.assign(new Error('规则编码已存在，请创建该规则的新版本'), { status: 409 });
    await assertFunctionIdentityAvailable(data.expression, null, all);
    const definition = await run(`INSERT INTO rule_definitions (code, rule_type, display_name, status, created_by)
      VALUES (?, ?, ?, 'draft', ?)`, [data.code, data.ruleType, data.displayName, req.user.id]);
    const version = await run(`INSERT INTO rule_versions (rule_id, version, expression_json, parameters_json, severity, status,
      created_by, rule_scope, description, test_cases_json) VALUES (?, 1, ?, ?, ?, 'draft', ?, ?, ?, ?)`
    , [definition.lastID, JSON.stringify(data.expression), JSON.stringify(data.parameters), data.severity, req.user.id, data.scope, data.description, JSON.stringify(cases)]);
    await audit(req, 'rule_version.create', { id: version.lastID, version: 1 }, null, { ...data, testCases: cases }, null);
    await run('COMMIT');
    res.status(201).json({ ruleId: definition.lastID, versionId: version.lastID, version: 1 });
  } catch (error) { await run('ROLLBACK').catch(() => {}); fail(res, error, '创建规则失败'); }
};

exports.createVersion = async (req, res) => {
  const ruleId = Number(req.params.ruleId);
  if (!Number.isSafeInteger(ruleId) || ruleId <= 0) return res.status(400).json({ error: '规则编号无效' });
  try {
    await run('BEGIN IMMEDIATE');
    const definition = await get('SELECT * FROM rule_definitions WHERE id = ?', [ruleId]);
    if (!definition) throw Object.assign(new Error('规则不存在'), { status: 404 });
    if (definition.status === 'retired') throw Object.assign(new Error('已停用规则不能创建新版本'), { status: 409 });
    const base = await get(`SELECT * FROM rule_versions WHERE rule_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1`, [ruleId]);
    if (!base) throw Object.assign(new Error('规则尚无已发布版本，请先完成首版审批'), { status: 409 });
    const payload = { ...req.body, code: definition.code, displayName: definition.display_name, ruleType: definition.rule_type };
    const data = normalize({
      ...{ scope: base.rule_scope, description: base.description, expression: parseJson(base.expression_json, null), parameters: parseJson(base.parameters_json, {}), severity: base.severity },
      ...payload
    });
    const cases = normalizeCases(req.body.testCases || []);
    const nextVersion = (await get('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM rule_versions WHERE rule_id = ?', [ruleId])).version;
    await assertFunctionIdentityAvailable(data.expression, ruleId, all);
    const created = await run(`INSERT INTO rule_versions (rule_id, version, expression_json, parameters_json, severity, status,
      created_by, rule_scope, description, test_cases_json, supersedes_version_id)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`
    , [ruleId, nextVersion, JSON.stringify(data.expression), JSON.stringify(data.parameters), data.severity, req.user.id,
      data.scope, data.description, JSON.stringify(cases), base.id]);
    await audit(req, 'rule_version.supersede.propose', { id: created.lastID, version: nextVersion }, { versionId: base.id, version: base.version }, { ...data, testCases: cases }, req.body.reason || null);
    await run('COMMIT');
    res.status(201).json({ ruleId, versionId: created.lastID, version: nextVersion, supersedesVersionId: base.id });
  } catch (error) { await run('ROLLBACK').catch(() => {}); fail(res, error, '创建规则新版本失败'); }
};

exports.updateDraft = async (req, res) => {
  const versionId = Number(req.params.versionId);
  if (!Number.isSafeInteger(versionId) || versionId <= 0) return res.status(400).json({ error: '规则版本编号无效' });
  try {
    const existing = await get('SELECT v.*, d.code, d.display_name, d.rule_type FROM rule_versions v JOIN rule_definitions d ON d.id = v.rule_id WHERE v.id = ?', [versionId]);
    if (!existing) return res.status(404).json({ error: '规则版本不存在' });
    if (existing.created_by !== req.user.id || !['draft', 'rejected'].includes(existing.status)) return res.status(403).json({ error: '只能修改自己创建的草稿或已驳回版本' });
    const data = normalize({ code: existing.code, displayName: existing.display_name, ruleType: existing.rule_type,
      scope: req.body.scope ?? existing.rule_scope, description: req.body.description ?? existing.description,
      expression: req.body.expression ?? parseJson(existing.expression_json, null), parameters: req.body.parameters ?? parseJson(existing.parameters_json, {}),
      severity: req.body.severity ?? existing.severity });
    const cases = normalizeCases(req.body.testCases ?? parseJson(existing.test_cases_json, []));
    await run('BEGIN IMMEDIATE');
    await assertFunctionIdentityAvailable(data.expression, existing.rule_id, all);
    const updated = await run(`UPDATE rule_versions SET expression_json = ?, parameters_json = ?, severity = ?, rule_scope = ?,
      description = ?, test_cases_json = ?, tested_at = NULL, status = 'draft', reviewed_by = NULL, review_note = NULL
      WHERE id = ? AND status IN ('draft','rejected') AND created_by = ? AND expression_json = ? AND test_cases_json = ?`,
    [JSON.stringify(data.expression), JSON.stringify(data.parameters), data.severity, data.scope, data.description,
      JSON.stringify(cases), versionId, req.user.id, existing.expression_json, existing.test_cases_json]);
    if (updated.changes !== 1) throw Object.assign(new Error('草稿状态已变化，请刷新后重试'), { status: 409 });
    await audit(req, 'rule_version.update', existing, { expression: parseJson(existing.expression_json, null), parameters: parseJson(existing.parameters_json, {}) }, { ...data, testCases: cases }, null);
    await run('COMMIT');
    res.json({ versionId, updated: true });
  } catch (error) { await run('ROLLBACK').catch(() => {}); fail(res, error, '更新规则草稿失败'); }
};

exports.test = async (req, res) => {
  const versionId = Number(req.params.versionId);
  if (!Number.isSafeInteger(versionId) || versionId <= 0) return res.status(400).json({ error: '规则版本编号无效' });
  let transactionStarted = false;
  try {
    const candidate = await get('SELECT * FROM rule_versions WHERE id = ?', [versionId]);
    if (isManagedFunction(parseJson(candidate?.expression_json, null))) {
      if (candidate.status !== 'draft' || candidate.created_by !== req.user.id) return res.status(403).json({ error: '只能验证自己创建的函数草稿' });
      const expression = await inspectDefinition(parseJson(candidate.expression_json, null));
      await assertFunctionIdentityAvailable(expression, candidate.rule_id, all);
      const updated = await run(`UPDATE rule_versions SET expression_json = ?, tested_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft' AND expression_json = ?`, [JSON.stringify(expression), versionId, candidate.expression_json]);
      if (updated.changes !== 1) return res.status(409).json({ error: '函数已修改，请重新保存并验证' });
      await audit(req, 'rule_version.test', candidate, null, { passed: true, validation: 'spreadjs_serialization_roundtrip' }, null);
      return res.json({ passed: true, expression, results: [] });
    }
    await run('BEGIN IMMEDIATE'); transactionStarted = true;
    const version = await get('SELECT * FROM rule_versions WHERE id = ?', [versionId]);
    if (!version) throw Object.assign(new Error('规则版本不存在'), { status: 404 });
    if (version.status !== 'draft' || version.created_by !== req.user.id) throw Object.assign(new Error('只能测试自己创建的规则草稿'), { status: 403 });
    const cases = normalizeCases(req.body.testCases ?? parseJson(version.test_cases_json, []), isNativeRule(parseJson(version.expression_json, null)));
    const results = runCases(version, cases);
    const updated = await run(`UPDATE rule_versions SET test_cases_json = ?, tested_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft' AND expression_json = ? AND parameters_json = ?`,
      [JSON.stringify(cases), versionId, version.expression_json, version.parameters_json]);
    if (updated.changes !== 1) throw Object.assign(new Error('版本已更新或提交，请刷新后重试'), { status: 409 });
    await audit(req, 'rule_version.test', version, null, { testCount: results.length, passed: results.every(result => result.passed) }, null);
    await run('COMMIT');
    res.json({ results, passed: results.length > 0 && results.every(result => result.passed) });
  } catch (error) { if (transactionStarted) await run('ROLLBACK').catch(() => {}); fail(res, error, '测试规则失败'); }
};

exports.submit = async (req, res) => {
  const versionId = Number(req.params.versionId);
  if (!Number.isSafeInteger(versionId) || versionId <= 0) return res.status(400).json({ error: '规则版本编号无效' });
  try {
    await run('BEGIN IMMEDIATE');
    const version = await get('SELECT * FROM rule_versions WHERE id = ?', [versionId]);
    if (!version) throw Object.assign(new Error('规则版本不存在'), { status: 404 });
    if (version.created_by !== req.user.id || version.status !== 'draft') throw Object.assign(new Error('只能提交自己创建的规则草稿'), { status: 403 });
    const cases = parseJson(version.test_cases_json, []);
    if (!version.tested_at || (!isManagedFunction(parseJson(version.expression_json, null)) && (!cases.length || !runCases(version, cases).every(result => result.passed)))) throw Object.assign(new Error('请先运行全部测试样例，并确保每个预期结果均通过'), { status: 409 });
    const direct = hasRole(req.user, 'system_admin');
    await assertFunctionIdentityAvailable(parseJson(version.expression_json, null), version.rule_id, all);
    const status = direct ? 'published' : 'pending_review';
    // Exempt submissions have no separate reviewer; the submitting administrator is recorded in the audit.
    const changed = await run(`UPDATE rule_versions SET status = ?, published_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
      review_note = ? WHERE id = ? AND status = 'draft'`, [status, direct, direct ? '系统管理员免审发布' : null, versionId]);
    if (direct) await run(`UPDATE rule_definitions SET status = 'active' WHERE id = ? AND status <> 'retired'`, [version.rule_id]);
    if (changed.changes !== 1) throw Object.assign(new Error('版本状态已变化，请刷新后重试'), { status: 409 });
    await audit(req, direct ? 'rule_version.publish' : 'rule_version.submit', version, { status: 'draft' }, { status, approvalMode: direct ? 'administrator_direct' : 'reviewed' }, direct ? '系统管理员免审发布' : null);
    await run('COMMIT');
    res.json({ versionId, status });
  } catch (error) { await run('ROLLBACK').catch(() => {}); fail(res, error, '提交规则复核失败'); }
};

exports.publish = async (req, res) => {
  const versionId = Number(req.params.versionId);
  const reason = String(req.body.reason || '').trim();
  if (!Number.isSafeInteger(versionId) || versionId <= 0) return res.status(400).json({ error: '规则版本编号无效' });
  if (reason.length > 1000) return res.status(400).json({ error: '复核说明不能超过 1000 个字符' });
  try {
    await run('BEGIN IMMEDIATE');
    const version = await get('SELECT v.*, d.code, d.status AS rule_status FROM rule_versions v JOIN rule_definitions d ON d.id = v.rule_id WHERE v.id = ?', [versionId]);
    if (!version) throw Object.assign(new Error('规则版本不存在'), { status: 404 });
    if (!hasRole(req.user, 'system_admin')) throw Object.assign(new Error('需要系统管理员权限'), { status: 403 });
    if (version.status !== 'pending_review') throw Object.assign(new Error('仅待复核版本可以发布'), { status: 409 });
    await assertFunctionIdentityAvailable(parseJson(version.expression_json, null), version.rule_id, all);
    const cases = parseJson(version.test_cases_json, []);
    if (!version.tested_at || (!isManagedFunction(parseJson(version.expression_json, null)) && (!cases.length || !runCases(version, cases).every(result => result.passed)))) throw Object.assign(new Error('版本测试未通过，不能发布'), { status: 409 });
    const changed = await run(`UPDATE rule_versions SET status = 'published', reviewed_by = ?, published_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending_review'`, [version.created_by === req.user.id ? null : req.user.id, versionId]);
    if (changed.changes !== 1) throw Object.assign(new Error('版本状态已变化，请刷新后重试'), { status: 409 });
    await run(`UPDATE rule_definitions SET status = 'active' WHERE id = ? AND status <> 'retired'`, [version.rule_id]);
    await audit(req, 'rule_version.publish', version, { status: version.status }, { status: 'published', reviewerId: req.user.id }, reason || null);
    await run('COMMIT');
    res.json({ versionId, status: 'published' });
  } catch (error) { await run('ROLLBACK').catch(() => {}); fail(res, error, '发布规则版本失败'); }
};

exports.reject = async (req, res) => {
  const versionId = Number(req.params.versionId);
  const reason = String(req.body.reason || '').trim();
  if (!Number.isSafeInteger(versionId) || versionId <= 0) return res.status(400).json({ error: '规则版本编号无效' });
  if (!reason || reason.length > 1000) return res.status(400).json({ error: '请填写不超过 1000 个字符的复核意见' });
  try {
    await run('BEGIN IMMEDIATE');
    const version = await get('SELECT * FROM rule_versions WHERE id = ?', [versionId]);
    if (!version) throw Object.assign(new Error('规则版本不存在'), { status: 404 });
    if (!hasRole(req.user, 'system_admin')) throw Object.assign(new Error('需要系统管理员权限'), { status: 403 });
    if (version.status !== 'pending_review') throw Object.assign(new Error('仅待复核版本可以驳回'), { status: 409 });
    const changed = await run(`UPDATE rule_versions SET status = 'rejected', reviewed_by = ?, review_note = ? WHERE id = ? AND status = 'pending_review'`, [version.created_by === req.user.id ? null : req.user.id, reason, versionId]);
    if (changed.changes !== 1) throw Object.assign(new Error('版本状态已变化，请刷新后重试'), { status: 409 });
    await audit(req, 'rule_version.reject', version, { status: version.status }, { status: 'rejected', reason }, reason);
    await run('COMMIT');
    res.json({ versionId, status: 'rejected' });
  } catch (error) { await run('ROLLBACK').catch(() => {}); fail(res, error, '驳回规则版本失败'); }
};

exports.evaluate = async (req, res) => {
  const versionId = Number(req.params.versionId);
  try {
    let version;
    if (Number.isSafeInteger(versionId) && versionId > 0) version = await get(`SELECT * FROM rule_versions WHERE id = ? AND status = 'published'`, [versionId]);
    else if (req.body.ruleCode) version = await get(`SELECT v.* FROM rule_versions v JOIN rule_definitions d ON d.id = v.rule_id
      WHERE d.code = ? AND v.status = 'published' ORDER BY v.version DESC LIMIT 1`, [String(req.body.ruleCode).toUpperCase()]);
    if (!version) return res.status(404).json({ error: '已发布规则版本不存在' });
    const input = req.body.input || {};
    if (typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 256000) return res.status(400).json({ error: '试算输入必须是小于 256 KB 的 JSON 对象' });
    if (isManagedFunction(parseJson(version.expression_json, null))) return res.status(400).json({ error: '请通过自定义公式试算或模板工作簿执行函数' });
    if (isNativeRule(parseJson(version.expression_json, null))) return res.status(400).json({ error: '请在浏览器中使用 SpreadJS 试算单元格校验' });
    const result = evaluateExpression(parseJson(version.expression_json, null), input, parseJson(version.parameters_json, {}));
    res.json({ versionId: version.id, version: version.version, result });
  } catch (error) { fail(res, error, '计算规则失败'); }
};

async function audit(req, action, version, before, after, reason) {
  await recordBusinessAudit({ actor: req.user, action, objectType: 'rule_version', objectId: version.id,
    businessVersion: String(version.version), before, after, reason, outcome: 'success', requestId: req.get('x-request-id') || null });
}
