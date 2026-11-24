const db = require('../config/database');
const { hasRole } = require('../middleware/auth');
const { recordBusinessAudit } = require('../services/businessAudit');

const FIELD_TYPES = new Set(['decimal', 'integer', 'short_text', 'long_text', 'date', 'datetime', 'boolean', 'enum', 'organization_reference', 'user_reference']);
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));

function isAdmin(user) { return hasRole(user, 'system_admin') || hasRole(user, 'data_administrator'); }
function storageType(type) {
  if (type === 'decimal' || type === 'integer' || type === 'boolean') return type;
  if (type === 'date' || type === 'datetime') return 'date';
  if (type === 'short_text' || type === 'long_text') return 'text';
  return 'json';
}

function normalizeProposal(input, fixedCode) {
  const code = String(fixedCode ?? input.code ?? '').trim();
  const displayName = String(input.displayName ?? '').trim();
  const type = input.type ?? input.semanticType;
  const unit = input.unit == null ? null : String(input.unit).trim() || null;
  const precision = input.precision == null ? (type === 'decimal' ? 2 : 0) : Number(input.precision);
  const editable = input.editable === undefined ? true : input.editable;
  const applicability = input.applicability == null ? {} : input.applicability;
  const options = input.options == null ? [] : input.options;
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) throw Object.assign(new Error('字段编码须为 2 至 64 位大写英文、数字或下划线，并以字母开头'), { status: 400 });
  if (!displayName || !/\p{Script=Han}/u.test(displayName) || displayName.length > 120) throw Object.assign(new Error('请填写不超过 120 个字符的中文显示名称'), { status: 400 });
  if (!FIELD_TYPES.has(type)) throw Object.assign(new Error('字段类型无效'), { status: 400 });
  if (!Number.isInteger(precision) || precision < 0 || precision > 12 || (type !== 'decimal' && precision !== 0)) throw Object.assign(new Error('精度仅适用于 decimal 字段，范围为 0 至 12'), { status: 400 });
  if (typeof editable !== 'boolean') throw Object.assign(new Error('可编辑属性无效'), { status: 400 });
  if (!applicability || typeof applicability !== 'object' || Array.isArray(applicability)) throw Object.assign(new Error('适用范围须为 JSON 对象'), { status: 400 });
  if (JSON.stringify(applicability).length > 4000) throw Object.assign(new Error('适用范围内容过长'), { status: 400 });
  if (type === 'enum' && (!Array.isArray(options) || !options.length || options.length > 200 || options.some(item => typeof item !== 'string' || !item.trim() || item.length > 120) || new Set(options).size !== options.length)) {
    throw Object.assign(new Error('枚举字段须提供不重复的选项'), { status: 400 });
  }
  if (type !== 'enum' && options.length) throw Object.assign(new Error('仅枚举字段可以设置选项'), { status: 400 });
  if (unit && unit.length > 80) throw Object.assign(new Error('单位不能超过 80 个字符'), { status: 400 });
  return { code, displayName, type, unit, precision, editable, applicability, options };
}

function proposalFromRow(row) { return JSON.parse(row.proposal_json ?? row.proposalJson); }
function summary(proposal) {
  return { code: proposal.code, displayName: proposal.displayName, type: proposal.type, unit: proposal.unit,
    precision: proposal.precision, editable: proposal.editable, applicability: proposal.applicability, options: proposal.options || [] };
}

async function addDraft(actor, proposal, supersedesFieldId = null, baseFieldVersion = null) {
  const created = await run(`INSERT INTO field_drafts (proposed_code, proposal_json, status, created_by, supersedes_field_id, base_field_version)
    VALUES (?, ?, 'pending', ?, ?, ?)`, [proposal.code, JSON.stringify(proposal), actor.id, supersedesFieldId, baseFieldVersion]);
  await run(`INSERT INTO field_draft_revisions (draft_id, revision, proposal_json, created_by) VALUES (?, 1, ?, ?)`,
    [created.lastID, JSON.stringify(proposal), actor.id]);
  return created.lastID;
}

async function record(actor, action, objectId, after, before = null, reason = null, objectType = 'field_draft') {
  await recordBusinessAudit({ actor, action, objectType, objectId, before, after, reason,
    businessVersion: '1', outcome: 'success' });
}

exports.catalog = async (req, res) => {
  try {
    const fields = await all(`SELECT f.id, f.code, f.display_name AS displayName, f.semantic_type AS type, f.unit, f.precision,
      v.id AS versionId,
      f.editable, f.applicability_json AS applicabilityJson, f.status, f.version, f.created_at AS createdAt, f.approved_at AS approvedAt
      FROM field_definitions f JOIN field_definition_versions v ON v.field_definition_id = f.id AND v.version = f.version
      WHERE f.status = 'approved' ORDER BY f.code`);
    res.json({ fields: fields.map(field => ({ ...field, editable: Boolean(field.editable), applicability: JSON.parse(field.applicabilityJson) })) });
  } catch (error) { res.status(500).json({ error: '读取已批准字段目录失败' }); }
};

exports.listDrafts = async (req, res) => {
  try {
    const where = isAdmin(req.user) ? '' : 'WHERE d.created_by = ?';
    const params = isAdmin(req.user) ? [] : [req.user.id];
    const drafts = await all(`SELECT d.id, d.proposed_code AS code, d.proposal_json AS proposalJson, d.status,
      d.created_by AS createdBy, creator.name AS creatorName, creator.username AS creatorUsername,
      d.reviewed_by AS reviewedBy, reviewer.name AS reviewerName, d.review_note AS reviewNote,
      d.created_at AS createdAt, d.reviewed_at AS reviewedAt, d.supersedes_field_id AS supersedesFieldId
      FROM field_drafts d JOIN users creator ON creator.id = d.created_by
      LEFT JOIN users reviewer ON reviewer.id = d.reviewed_by ${where} ORDER BY d.created_at DESC, d.id DESC`, params);
    res.json({ drafts: drafts.map(draft => ({ ...draft, proposal: proposalFromRow(draft) })) });
  } catch (error) { console.error('读取字段草稿失败', error); res.status(500).json({ error: '读取字段草稿失败' }); }
};

async function approveDraftRecord(draft, proposal, actor, reason = null) {
    let field;
    let version = 1;
    let before = null;
    if (draft.supersedes_field_id) {
      field = await get('SELECT * FROM field_definitions WHERE id = ? AND status = \'approved\'', [draft.supersedes_field_id]);
      if (!field || field.code !== proposal.code) throw Object.assign(new Error('待替代的字段已不存在或编码已改变'), { status: 409 });
      if (field.version !== draft.base_field_version) throw Object.assign(new Error('该提案基于旧版本，请基于当前版本重新提出'), { status: 409 });
      version = field.version + 1;
      before = { code: field.code, displayName: field.display_name, type: field.semantic_type, unit: field.unit,
        precision: field.precision, editable: Boolean(field.editable), applicability: JSON.parse(field.applicability_json) };
      await run(`UPDATE field_definitions SET display_name = ?, data_type = ?, semantic_type = ?, unit = ?, precision = ?, editable = ?,
        applicability_json = ?, version = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [proposal.displayName, storageType(proposal.type), proposal.type, proposal.unit, proposal.precision, Number(proposal.editable),
        JSON.stringify({ ...proposal.applicability, ...(proposal.options.length ? { options: proposal.options } : {}) }), version, actor.id, field.id]);
    } else {
      const collision = await get('SELECT id FROM field_definitions WHERE code = ?', [proposal.code]);
      if (collision) throw Object.assign(new Error('字段编码已被批准字段使用，请通过版本替代流程更新'), { status: 409 });
      const created = await run(`INSERT INTO field_definitions
        (code, display_name, data_type, semantic_type, unit, precision, editable, applicability_json, status, version, created_by, approved_by, approved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', 1, ?, ?, CURRENT_TIMESTAMP)`,
      [proposal.code, proposal.displayName, storageType(proposal.type), proposal.type, proposal.unit, proposal.precision,
        Number(proposal.editable), JSON.stringify({ ...proposal.applicability, ...(proposal.options.length ? { options: proposal.options } : {}) }), draft.created_by, actor.id]);
      field = { id: created.lastID };
    }
    const directCreation = draft.created_by === actor.id && hasRole(actor, 'system_admin');
    const snapshot = { ...summary(proposal), id: field.id, version, status: 'approved', approvalMode: directCreation ? 'administrator_direct' : 'reviewed' };
    await run(`INSERT INTO field_definition_versions
      (field_definition_id, version, snapshot_json, created_by, approved_by, source_draft_id)
      VALUES (?, ?, ?, ?, ?, ?)`, [field.id, version, JSON.stringify(snapshot), draft.created_by, directCreation ? null : actor.id, draft.id]);
    await run(`UPDATE field_drafts SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`, [actor.id, draft.id]);
    await recordBusinessAudit({ actor: actor, action: draft.supersedes_field_id ? 'field_definition.supersede' : 'field_draft.approve',
      objectType: 'field_definition', objectId: field.id, businessVersion: String(version), before,
      after: snapshot, reason: reason, outcome: 'success' });
    return { fieldDefinitionId: field.id, version, status: 'approved' };
}

exports.createDraft = async (req, res) => {
  let proposal;
  try { proposal = normalizeProposal(req.body); }
  catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  try {
    const duplicate = await get(`SELECT 1 AS found FROM field_definitions WHERE code = ?
      UNION ALL SELECT 1 FROM field_drafts WHERE proposed_code = ? AND status = 'pending' LIMIT 1`, [proposal.code, proposal.code]);
    if (duplicate) return res.status(409).json({ error: '字段编码已存在或已有待审批提案' });
    await run('BEGIN IMMEDIATE');
    const draftId = await addDraft(req.user, proposal);
    await record(req.user, 'field_draft.create', draftId, summary(proposal));
    const approved = hasRole(req.user, 'system_admin')
      ? await approveDraftRecord({ id: draftId, created_by: req.user.id }, proposal, req.user, '系统管理员直接创建字段，无需提案审批') : null;
    await run('COMMIT');
    res.status(201).json({ draftId, ...(approved || { status: 'pending' }) });
  } catch (error) { await run('ROLLBACK').catch(() => {}); res.status(error.message?.includes('UNIQUE') ? 409 : 500).json({ error: error.message?.includes('UNIQUE') ? '字段编码已存在' : '创建字段草稿失败' }); }
};

exports.correctDraft = async (req, res) => {
  const draftId = Number(req.params.draftId);
  if (!Number.isSafeInteger(draftId)) return res.status(400).json({ error: '草稿编号无效' });
  try {
    const draft = await get('SELECT * FROM field_drafts WHERE id = ?', [draftId]);
    if (!draft) return res.status(404).json({ error: '字段草稿不存在' });
    if (draft.created_by !== req.user.id || !['pending', 'rejected'].includes(draft.status)) return res.status(403).json({ error: '只能修改自己待审批或已驳回的草稿' });
    const proposal = normalizeProposal({ ...proposalFromRow(draft), ...req.body }, draft.supersedes_field_id ? draft.proposed_code : undefined);
    const pendingDuplicate = await get(`SELECT 1 AS found FROM field_drafts WHERE proposed_code = ? AND status = 'pending' AND id <> ?`, [proposal.code, draftId]);
    if (pendingDuplicate) return res.status(409).json({ error: '该字段已有待审批提案' });
    await run('BEGIN IMMEDIATE');
    await run('INSERT INTO field_draft_revisions (draft_id, revision, proposal_json, created_by) VALUES (?, ?, ?, ?)',
      [draftId, (await get('SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM field_draft_revisions WHERE draft_id = ?', [draftId])).next, JSON.stringify(proposal), req.user.id]);
    await run(`UPDATE field_drafts SET proposed_code = ?, proposal_json = ?, status = 'pending', reviewed_by = NULL, review_note = NULL,
      reviewed_at = NULL WHERE id = ?`, [proposal.code, JSON.stringify(proposal), draftId]);
    await record(req.user, 'field_draft.correct', draftId, summary(proposal), proposalFromRow(draft));
    const approved = hasRole(req.user, 'system_admin') ? await approveDraftRecord(draft, proposal, req.user, '系统管理员免审') : null;
    await run('COMMIT');
    res.json({ draftId, ...(approved || { status: 'pending' }) });
  } catch (error) { await run('ROLLBACK').catch(() => {}); res.status(error.status || 500).json({ error: error.message || '修正字段草稿失败' }); }
};

exports.rejectDraft = async (req, res) => {
  const draftId = Number(req.params.draftId);
  const reason = String(req.body.reason ?? '').trim();
  if (!Number.isSafeInteger(draftId) || !reason || reason.length > 1000) return res.status(400).json({ error: '草稿编号或驳回原因无效' });
  try {
    const draft = await get('SELECT * FROM field_drafts WHERE id = ?', [draftId]);
    if (!draft) return res.status(404).json({ error: '字段草稿不存在' });
    if (draft.status !== 'pending') return res.status(409).json({ error: '仅待审批草稿可以驳回' });
    await run('BEGIN IMMEDIATE');
    const updated = await run(`UPDATE field_drafts SET status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'`, [req.user.id, reason, draftId]);
    if (updated.changes !== 1) throw Object.assign(new Error('字段草稿状态已变化，请刷新后重试'), { status: 409 });
    await recordBusinessAudit({ actor: req.user, action: 'field_draft.reject', objectType: 'field_draft', objectId: draftId,
      before: { status: draft.status }, after: { status: 'rejected', reason }, reason, businessVersion: '1', outcome: 'success' });
    await run('COMMIT');
    res.json({ draftId, status: 'rejected' });
  } catch (error) { await run('ROLLBACK').catch(() => {}); res.status(error.status || 500).json({ error: error.message || '驳回字段草稿失败' }); }
};

exports.approveDraft = async (req, res) => {
  const draftId = Number(req.params.draftId);
  if (!Number.isSafeInteger(draftId)) return res.status(400).json({ error: '草稿编号无效' });
  try {
    const draft = await get('SELECT * FROM field_drafts WHERE id = ?', [draftId]);
    if (!draft) return res.status(404).json({ error: '字段草稿不存在' });
    if (draft.status !== 'pending') return res.status(409).json({ error: '仅待审批草稿可以批准' });
    if (draft.created_by === req.user.id && !hasRole(req.user, 'system_admin')) return res.status(403).json({ error: '创建者不能批准自己的字段草稿' });
    const proposal = proposalFromRow(draft);
    await run('BEGIN IMMEDIATE');
    const currentDraft = await get('SELECT status FROM field_drafts WHERE id = ?', [draftId]);
    if (!currentDraft || currentDraft.status !== 'pending') throw Object.assign(new Error('字段草稿状态已变化，请刷新后重试'), { status: 409 });
    const { fieldDefinitionId, version } = await approveDraftRecord(draft, proposal, req.user, req.body.reason || null);
    await run('COMMIT');
    res.json({ fieldDefinitionId, version });
  } catch (error) { await run('ROLLBACK').catch(() => {}); res.status(error.status || 500).json({ error: error.message || '批准字段草稿失败' }); }
};

exports.supersede = async (req, res) => {
  const fieldId = Number(req.params.fieldId);
  if (!Number.isSafeInteger(fieldId)) return res.status(400).json({ error: '字段编号无效' });
  try {
    const current = await get(`SELECT id, code, display_name AS displayName, semantic_type AS type, unit, precision,
      editable, applicability_json, version FROM field_definitions WHERE id = ? AND status = 'approved'`, [fieldId]);
    if (!current) return res.status(404).json({ error: '已批准字段不存在' });
    const applicability = JSON.parse(current.applicability_json);
    const proposal = normalizeProposal({ ...current, ...req.body, applicability: req.body.applicability ?? applicability,
      options: req.body.options ?? applicability.options ?? [] }, current.code);
    await run('BEGIN IMMEDIATE');
    const pending = await get("SELECT id FROM field_drafts WHERE supersedes_field_id = ? AND status = 'pending' LIMIT 1", [fieldId]);
    if (pending) throw Object.assign(new Error('该字段已有待审批的新版本提案'), { status: 409 });
    const draftId = await addDraft(req.user, proposal, fieldId, current.version);
    await record(req.user, 'field_definition.supersede.propose', fieldId, summary(proposal), null, req.body.reason || null, 'field_definition');
    const approved = hasRole(req.user, 'system_admin') ? await approveDraftRecord(await get('SELECT * FROM field_drafts WHERE id=?', [draftId]), proposal, req.user, '系统管理员免审') : null;
    await run('COMMIT');
    res.status(201).json({ draftId, ...(approved || { status: 'pending' }) });
  } catch (error) { await run('ROLLBACK').catch(() => {}); res.status(error.status || 500).json({ error: error.message || '创建字段替代提案失败' }); }
};

exports.versions = async (req, res) => {
  const fieldId = Number(req.params.fieldId);
  if (!Number.isSafeInteger(fieldId)) return res.status(400).json({ error: '字段编号无效' });
  try {
    const versions = await all(`SELECT v.version, v.snapshot_json AS snapshotJson, v.created_by AS createdBy,
      creator.name AS creatorName, v.approved_by AS approvedBy, approver.name AS approverName,
      v.source_draft_id AS sourceDraftId, v.approved_at AS approvedAt
      FROM field_definition_versions v LEFT JOIN users creator ON creator.id = v.created_by
      LEFT JOIN users approver ON approver.id = v.approved_by WHERE v.field_definition_id = ? ORDER BY v.version DESC`, [fieldId]);
    res.json({ versions: versions.map(version => ({ ...version, snapshot: JSON.parse(version.snapshotJson) })) });
  } catch (error) { res.status(500).json({ error: '读取字段版本失败' }); }
};

function validateStoredValue(field, value) {
  if (value === null) return { clear: true };
  const type = field.semantic_type;
  if (type === 'decimal') {
    const raw = value;
    if (typeof raw !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw) || (raw.split('.')[1]?.length || 0) > field.precision) throw Object.assign(new Error('decimal 值须以文本形式传入，且不超过字段精度'), { status: 400 });
    return { value_type: 'decimal', decimal_value: raw };
  }
  if (type === 'integer') {
    if (!Number.isSafeInteger(value)) throw Object.assign(new Error('integer 值无效'), { status: 400 });
    return { value_type: 'integer', integer_value: value };
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw Object.assign(new Error('boolean 值无效'), { status: 400 });
    return { value_type: 'boolean', boolean_value: Number(value) };
  }
  if (type === 'short_text' || type === 'long_text') {
    if (typeof value !== 'string' || (type === 'short_text' && value.length > 500) || (type === 'long_text' && value.length > 20000)) throw Object.assign(new Error('文本值无效或超出长度限制'), { status: 400 });
    return { value_type: 'text', text_value: value };
  }
  if (type === 'date') {
    const parsedDate = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
    if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== value) throw Object.assign(new Error('日期值须采用 YYYY-MM-DD 格式'), { status: 400 });
    return { value_type: 'date', date_value: value };
  }
  if (type === 'datetime') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) throw Object.assign(new Error('datetime 值须为带时区的 ISO 8601 时间'), { status: 400 });
    return { value_type: 'date', date_value: value };
  }
  if (type === 'enum') {
    const options = JSON.parse(field.applicability_json).options || [];
    if (typeof value !== 'string' || !options.includes(value)) throw Object.assign(new Error('值不属于字段枚举选项'), { status: 400 });
    return { value_type: 'json', json_value: JSON.stringify(value) };
  }
  if (type === 'organization_reference' || type === 'user_reference') {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('引用编号无效'), { status: 400 });
    return { value_type: 'json', json_value: JSON.stringify(id), referencedId: id };
  }
  throw Object.assign(new Error('不支持的字段类型'), { status: 400 });
}

function readStoredValue(row) {
  if (!row) return null;
  if (row.value_type === 'decimal') return row.decimal_value;
  if (row.value_type === 'integer') return row.integer_value;
  if (row.value_type === 'boolean') return Boolean(row.boolean_value);
  if (row.value_type === 'text') return row.text_value;
  if (row.value_type === 'date') return row.date_value;
  return JSON.parse(row.json_value);
}

exports.writeValue = async (req, res) => {
  const taskId = Number(req.body.taskId);
  const revisionId = Number(req.body.revisionId);
  const fieldId = Number(req.body.fieldDefinitionId);
  const recordKey = req.body.recordKey == null ? '' : String(req.body.recordKey);
  if (![taskId, revisionId, fieldId].every(Number.isSafeInteger) || taskId < 1 || revisionId < 1 || fieldId < 1 || recordKey.length > 200 || !Object.hasOwn(req.body, 'value')) {
    return res.status(400).json({ error: '任务、修订、字段编号、记录键或字段值无效' });
  }
  try {
    const [field, revision] = await Promise.all([
      get(`SELECT id, semantic_type, precision, editable, applicability_json FROM field_definitions WHERE id = ? AND status = 'approved'`, [fieldId]),
      get('SELECT id, revision_status AS status FROM business_revisions WHERE id = ? AND task_id = ?', [revisionId, taskId])
    ]);
    if (!field) return res.status(404).json({ error: '已批准字段不存在' });
    if (!revision) return res.status(404).json({ error: '任务修订不存在' });
    if (revision.status !== 'draft') return res.status(409).json({ error: '仅草稿修订可以写入结构化字段值' });
    if (!field.editable) return res.status(400).json({ error: '该字段为只读字段' });
    const typed = validateStoredValue(field, req.body.value);
    if (typed.clear) {
      await run('BEGIN IMMEDIATE');
      const previous = await get(`SELECT value_type FROM business_values WHERE revision_id = ? AND record_key = ? AND field_definition_id = ?`, [revisionId, recordKey, fieldId]);
      await run('DELETE FROM business_values WHERE revision_id = ? AND record_key = ? AND field_definition_id = ?', [revisionId, recordKey, fieldId]);
      if (previous) await recordBusinessAudit({ actor: req.user, action: 'business_value.clear', objectType: 'business_value',
        objectId: `${revisionId}:${recordKey}:${fieldId}`, before: { valueType: previous.value_type }, after: { value: null }, outcome: 'success' });
      await run('COMMIT');
      return res.json({ value: null });
    }
    if (typed.referencedId) {
      const table = field.semantic_type === 'organization_reference' ? 'organizations' : 'users';
      if (!await get(`SELECT id FROM ${table} WHERE id = ?`, [typed.referencedId])) return res.status(400).json({ error: '引用的组织或用户不存在' });
      delete typed.referencedId;
    }
    const columns = ['text_value', 'decimal_value', 'integer_value', 'boolean_value', 'date_value', 'json_value'];
    const vals = Object.fromEntries(columns.map(column => [column, typed[column] ?? null]));
    await run('BEGIN IMMEDIATE');
    const previous = await get(`SELECT value_type FROM business_values WHERE revision_id = ? AND record_key = ? AND field_definition_id = ?`, [revisionId, recordKey, fieldId]);
    await run(`INSERT INTO business_values (revision_id, task_id, record_key, field_definition_id, value_type,
      text_value, decimal_value, integer_value, boolean_value, date_value, json_value, entered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(revision_id, record_key, field_definition_id) DO UPDATE SET task_id = excluded.task_id,
        value_type = excluded.value_type, text_value = excluded.text_value, decimal_value = excluded.decimal_value,
        integer_value = excluded.integer_value, boolean_value = excluded.boolean_value, date_value = excluded.date_value,
        json_value = excluded.json_value, entered_by = excluded.entered_by`,
    [revisionId, taskId, recordKey, fieldId, typed.value_type, ...columns.map(column => vals[column]), req.user.id]);
    await recordBusinessAudit({ actor: req.user, action: previous ? 'business_value.update' : 'business_value.create', objectType: 'business_value',
      objectId: `${revisionId}:${recordKey}:${fieldId}`, before: previous ? { valueType: previous.value_type } : null,
      after: { valueType: typed.value_type }, outcome: 'success' });
    await run('COMMIT');
    res.json({ value: req.body.value, valueType: typed.value_type });
  } catch (error) { await run('ROLLBACK').catch(() => {}); res.status(error.status || 500).json({ error: error.message || '保存结构化字段值失败' }); }
};

exports.readValues = async (req, res) => {
  const taskId = Number(req.query.taskId);
  const revisionId = Number(req.query.revisionId);
  if (![taskId, revisionId].every(Number.isSafeInteger) || taskId < 1 || revisionId < 1) return res.status(400).json({ error: '任务或修订编号无效' });
  try {
    const rows = await all(`SELECT v.record_key AS recordKey, v.field_definition_id AS fieldDefinitionId,
      f.code, f.semantic_type AS semanticType, v.value_type AS valueType, v.text_value AS textValue,
      v.decimal_value AS decimalValue, v.integer_value AS integerValue, v.boolean_value AS booleanValue,
      v.date_value AS dateValue, v.json_value AS jsonValue, v.source_formula AS sourceFormula
      FROM business_values v JOIN field_definitions f ON f.id = v.field_definition_id
      WHERE v.task_id = ? AND v.revision_id = ? ORDER BY v.record_key, f.code`, [taskId, revisionId]);
    res.json({ values: rows.map(row => ({ recordKey: row.recordKey, fieldDefinitionId: row.fieldDefinitionId,
      code: row.code, semanticType: row.semanticType, value: readStoredValue({ value_type: row.valueType,
        text_value: row.textValue, decimal_value: row.decimalValue, integer_value: row.integerValue,
        boolean_value: row.booleanValue, date_value: row.dateValue, json_value: row.jsonValue }), sourceFormula: row.sourceFormula })) });
  } catch (error) { res.status(500).json({ error: '读取结构化字段值失败' }); }
};
