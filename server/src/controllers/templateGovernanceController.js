const { templateDefinitions } = require('../services/managedFunctions');
const { normalizeAuxiliaryBinding } = require('../services/auxiliaryDataBinding');
const { hasRole } = require('../middleware/auth');
const db = require('../config/database');
const { permissionOptions } = require('../services/permissionOptions');
const { directTemplateSnapshot, directWorkbookJson, normalizeInlineWorkbook, materializeInlineSheet } = require('../services/directTemplate');
const quarterlyReferenceProfile = require('../../../shared/quarterly-reference-profile.json');
const { recordBusinessAudit } = require('../services/businessAudit');
const { validateTemplate, rolePreview, compileSubmissionManifest } = require('../services/templatePublication');
const { normalizedTag, compilePermissionIndex, validatePermissionConfiguration } = require('../services/permissionIndex');
const { shiftFormulaRows } = require('../services/formulaShift');

const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
const json = value => JSON.stringify(value);
const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } };
function auxiliaryContent(value) {
  const content = typeof value === 'string' ? parse(value, {}) : (value || {});
  return { rowCount: content.rowCount || 1, columnCount: content.columnCount || 1, cells: Array.isArray(content.cells) ? content.cells : [],
    permissionTag: content.permissionTag || null, designerJson: content.designerJson || null,
    ...(content.dataBinding ? { dataBinding: normalizeAuxiliaryBinding(content.dataBinding) } : {}),
    ...(content.inlineWorkbook ? { inlineWorkbook: content.inlineWorkbook } : {}) };
}
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(error => {
  if ([400, 403, 404, 409].includes(error.status)) return res.status(error.status).json({ error: error.message });
  next(error);
});

function fail(res, status, error) { return res.status(status).json({ error }); }
exports.permissionOptions = asyncRoute(async (req, res) => {
  res.json(await permissionOptions());
});
async function validateComponentPermissions(rowCount, columnCount, cells, metadata) {
  const tags = metadata?.permissionTags || {};
  validatePermissionConfiguration({ sheets: [{ name: metadata?.name || '组件', rowCount, columnCount, cells,
    mappings: metadata?.mappings || [], tag: tags.sheet, rowTags: tags.rows || [], columnTags: tags.columns || [] }] }, await permissionOptions());
}
function ownerOrAdmin(req, res, ownerId) {
  if (req.user.id === ownerId || req.user.roles.some(role => role.code === 'system_admin')) return true;
  fail(res, 403, '只有当前维护人或系统管理员可以编辑');
  return false;
}
function validateRectangle(body) {
  const rows = Number(body?.rowCount);
  const columns = Number(body?.columnCount);
  if (!Number.isSafeInteger(rows) || rows < 1 || !Number.isSafeInteger(columns) || columns < 1) {
    return '组件行列数必须是正整数';
  }
  return null;
}
function cellsFitRectangle(cells, rows, columns) {
  return Array.isArray(cells) && cells.every(cell => cell && Number.isInteger(cell.row) && cell.row >= 0
    && cell.row < rows && Number.isInteger(cell.column) && cell.column >= 0 && cell.column < columns);
}
function componentDto(row) {
  return { ...row, workbook: parse(row.workbook_json, {}), metadata: parse(row.metadata_json, {}) };
}
async function getComponentVersion(id) {
  return get(`SELECT cv.*, c.code, c.component_type AS componentType, c.created_by AS ownerId, u.name AS ownerName
    FROM template_component_versions cv JOIN template_components c ON c.id = cv.component_id
    LEFT JOIN users u ON u.id = c.created_by WHERE cv.id = ?`, [id]);
}
async function getTemplateVersion(id) {
  return get(`SELECT tv.*, t.name, t.description, t.factory, t.created_by AS ownerId, u.name AS ownerName
    FROM template_versions tv JOIN templates t ON t.id = tv.template_id
    LEFT JOIN users u ON u.id = t.created_by WHERE tv.id = ?`, [id]);
}

exports.listComponents = asyncRoute(async (req, res) => {
  const rows = await all(`SELECT c.id, c.code, c.component_type AS componentType, c.created_by AS ownerId, u.name AS ownerName,
      cv.id AS versionId, cv.version, cv.workflow_status AS status, cv.created_by AS versionCreatedBy,
      cv.created_at AS createdAt, cv.submitted_by AS submittedBy, cv.reviewed_by AS reviewedBy,
      cv.workbook_json, cv.metadata_json
    FROM template_components c JOIN users u ON u.id = c.created_by
    JOIN template_component_versions cv ON cv.component_id = c.id
    ORDER BY c.id DESC, cv.version DESC`);
  res.json({ components: rows.map(row => componentDto({ ...row, workbook_json: row.workbook_json, metadata_json: row.metadata_json })) });
});

exports.createComponent = asyncRoute(async (req, res) => {
  const { code, name, componentType, rowCount, columnCount, cells = [], metadata = {} } = req.body;
  const rectangleError = validateRectangle({ rowCount, columnCount });
  if (rectangleError) return fail(res, 400, rectangleError);
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(code || '') || !String(name || '').trim() || !['header', 'body', 'footer'].includes(componentType)) {
    return fail(res, 400, '组件编码、名称或类型无效');
  }
  if (!cellsFitRectangle(cells, rowCount, columnCount) || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return fail(res, 400, '组件网格数据无效');
  }
  await validateComponentPermissions(rowCount, columnCount, cells, metadata);
  try {
    await db.ready;
    await run('BEGIN IMMEDIATE');
    const inserted = await run('INSERT INTO template_components (code, component_type, created_by) VALUES (?, ?, ?)', [code, componentType, req.user.id]);
    const version = await run(`INSERT INTO template_component_versions
      (component_id, version, workbook_json, metadata_json, created_by) VALUES (?, 1, ?, ?, ?)`,
    [inserted.lastID, json({ rowCount, columnCount, cells }), json({ name: String(name).trim(), ...metadata }), req.user.id]);
    await run('COMMIT');
    await recordBusinessAudit({ actor: req.user, action: 'template_component.create', objectType: 'template_component', objectId: inserted.lastID,
      businessVersion: '1', after: { code, componentType, rowCount, columnCount } });
    res.status(201).json({ componentId: inserted.lastID, versionId: version.lastID, version: 1, status: 'draft' });
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    if (/UNIQUE constraint failed: template_components.code/.test(error.message)) return fail(res, 409, '组件编码已存在');
    throw error;
  }
});

exports.createComponentVersion = asyncRoute(async (req, res) => {
  const component = await get('SELECT * FROM template_components WHERE id = ?', [req.params.id]);
  if (!component) return fail(res, 404, '组件不存在');
  if (!ownerOrAdmin(req, res, component.created_by)) return;
  const rectangleError = validateRectangle(req.body);
  if (rectangleError) return fail(res, 400, rectangleError);
  const { rowCount, columnCount, cells = [], metadata = {} } = req.body;
  if (!cellsFitRectangle(cells, rowCount, columnCount)) return fail(res, 400, '组件单元格坐标无效或超出工作表范围');
  const latest = await get('SELECT * FROM template_component_versions WHERE component_id = ? ORDER BY version DESC LIMIT 1', [component.id]);
  if (latest.workflow_status === 'draft' || latest.workflow_status === 'in_review') return fail(res, 409, '请先完成当前组件版本的审核');
  const version = latest.version + 1;
  await validateComponentPermissions(rowCount, columnCount, cells, { ...parse(latest.metadata_json, {}), ...metadata });
  const inserted = await run(`INSERT INTO template_component_versions
    (component_id, version, workbook_json, metadata_json, created_by, supersedes_version_id) VALUES (?, ?, ?, ?, ?, ?)`,
  [component.id, version, json({ rowCount, columnCount, cells }), json({ ...(parse(latest.metadata_json, {})), ...metadata }), req.user.id, latest.id]);
  await recordBusinessAudit({ actor: req.user, action: 'template_component.version.create', objectType: 'template_component', objectId: component.id,
    businessVersion: String(version), before: { previousVersion: latest.version }, after: { version, rows: rowCount, columns: columnCount } });
  res.status(201).json({ versionId: inserted.lastID, version, status: 'draft' });
});

exports.updateComponentVersion = asyncRoute(async (req, res) => {
  const version = await getComponentVersion(req.params.versionId);
  if (!version) return fail(res, 404, '组件版本不存在');
  if (!ownerOrAdmin(req, res, version.ownerId)) return;
  if (version.workflow_status !== 'draft') return fail(res, 409, '只有草稿组件版本可以编辑');
  const rectangleError = validateRectangle(req.body);
  if (rectangleError) return fail(res, 400, rectangleError);
  const { rowCount, columnCount, cells = [], metadata = {} } = req.body;
  if (!cellsFitRectangle(cells, rowCount, columnCount) || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return fail(res, 400, '组件网格数据无效');
  }
  const normalizedMetadata = { ...metadata, name: String(metadata.name || version.code).trim() };
  if (!normalizedMetadata.name || json(normalizedMetadata).length > 2_000_000) return fail(res, 400, '组件元数据无效或超出限制');
  await validateComponentPermissions(rowCount, columnCount, cells, normalizedMetadata);
  const previous = { workbook: parse(version.workbook_json, {}), metadata: parse(version.metadata_json, {}) };
  await run('UPDATE template_component_versions SET workbook_json = ?, metadata_json = ? WHERE id = ? AND workflow_status = \'draft\'',
    [json({ rowCount, columnCount, cells }), json(normalizedMetadata), version.id]);
  await recordBusinessAudit({ actor: req.user, action: 'template_component.draft.update', objectType: 'template_component', objectId: version.component_id,
    businessVersion: String(version.version), before: { rowCount: previous.workbook.rowCount, columnCount: previous.workbook.columnCount },
    after: { rowCount, columnCount, mappingCount: Array.isArray(normalizedMetadata.mappings) ? normalizedMetadata.mappings.length : 0 } });
  res.json({ status: 'draft' });
});

exports.submitComponent = asyncRoute(async (req, res) => {
  const version = await getComponentVersion(req.params.versionId);
  if (!version) return fail(res, 404, '组件版本不存在');
  if (!ownerOrAdmin(req, res, version.ownerId)) return;
  if (version.workflow_status !== 'draft') return fail(res, 409, '只有草稿组件版本可以提交审核');
  if (hasRole(req.user, 'system_admin')) return reviewComponentVersion(req, res, version, true);
  await run(`UPDATE template_component_versions SET workflow_status = 'in_review', submitted_by = ?, review_note = NULL WHERE id = ?`, [req.user.id, version.id]);
  await recordBusinessAudit({ actor: req.user, action: 'template_component.submit', objectType: 'template_component', objectId: version.component_id,
    businessVersion: String(version.version), before: { status: 'draft' }, after: { status: 'in_review' } });
  res.json({ status: 'in_review' });
});

exports.reviewComponent = asyncRoute(async (req, res) => {
  const version = await getComponentVersion(req.params.versionId);
  if (!version) return fail(res, 404, '组件版本不存在');
  return reviewComponentVersion(req, res, version);
});

async function reviewComponentVersion(req, res, version, direct = false) {
  if (!hasRole(req.user, 'system_admin')) return fail(res, 403, '需要系统管理员权限');
  if (version.workflow_status !== (direct ? 'draft' : 'in_review')) return fail(res, 409, '组件状态已变化');
  const action = direct ? 'approve' : req.body.action;
  if (!['approve', 'reject'].includes(action)) return fail(res, 400, '审核操作无效');
  const status = action === 'approve' ? 'published' : 'rejected';
  if (action === 'approve') await templateDefinitions(parse(version.metadata_json, {}));
  await db.ready;
  await run('BEGIN IMMEDIATE');
  try {
    const current = await get('SELECT workflow_status AS status FROM template_component_versions WHERE id=?', [version.id]);
    if (current?.status !== (direct ? 'draft' : 'in_review')) throw Object.assign(new Error('版本状态已变化，请刷新后重试'), { status: 409 });
    if (action === 'approve') {
      await run(`UPDATE template_component_versions SET workflow_status = 'superseded' WHERE component_id = ? AND workflow_status = 'published'`, [version.component_id]);
      await run(`UPDATE template_component_versions SET workflow_status = ?, status = 'published', reviewed_by = ?, published_at = CURRENT_TIMESTAMP, review_note = ? WHERE id = ?`,
        [status, req.user.id, req.body.note || null, version.id]);
      await run(`UPDATE template_components SET status = 'active' WHERE id = ?`, [version.component_id]);
    } else {
      await run(`UPDATE template_component_versions SET workflow_status = ?, reviewed_by = ?, review_note = ? WHERE id = ?`, [status, req.user.id, req.body.note || null, version.id]);
    }
    await recordBusinessAudit({ actor: req.user, action: `template_component.${action}`, objectType: 'template_component', objectId: version.component_id,
      businessVersion: String(version.version), before: { status: version.workflow_status }, after: { status, approvalMode: direct ? 'administrator_direct' : 'reviewed' }, reason: direct ? '系统管理员提交，免审批直接发布' : req.body.note || null });
    await run('COMMIT');
  } catch (error) { await run('ROLLBACK').catch(() => {}); throw error; }

  res.json({ status });
}

exports.listTemplates = asyncRoute(async (req, res) => {
  const rows = await all(`SELECT t.id AS templateId, t.name, t.description, t.factory, t.created_by AS ownerId,
      u.name AS ownerName, tv.id AS versionId, tv.version, tv.status, tv.created_at AS createdAt, tv.reviewed_by AS reviewedBy,
      (SELECT COUNT(*) FROM template_sheets s WHERE s.template_version_id = tv.id) AS sheetCount
    FROM templates t JOIN users u ON u.id = t.created_by JOIN template_versions tv ON tv.template_id = t.id
    ORDER BY t.id DESC, tv.version DESC`);
  const organizations = await all("SELECT id, code, name FROM organizations WHERE status = 'active' ORDER BY code");
  res.json({ templates: rows, organizations });
});

async function templateSheets(versionId) {
  const rows = await all(`SELECT s.*, h.component_id AS headerComponentId, h.version AS headerVersion,
      b.component_id AS bodyComponentId, b.version AS bodyVersion, f.component_id AS footerComponentId, f.version AS footerVersion
    FROM template_sheets s LEFT JOIN template_component_versions h ON h.id = s.header_component_version_id
    LEFT JOIN template_component_versions b ON b.id = s.body_component_version_id
    LEFT JOIN template_component_versions f ON f.id = s.footer_component_version_id
    WHERE s.template_version_id = ? ORDER BY s.sheet_order`, [versionId]);
  return rows.map(row => ({ ...row, auxiliary: auxiliaryContent(row.auxiliary_json) }));
}
async function repairInlineMappings(sheet, row) {
  const cells = (sheet.cells || []).filter(cell => cell.bindingPath);
  if (!cells.length) return false;
  const codes = [...new Set(cells.map(cell => cell.bindingPath))];
  const fields = await all(`SELECT id, code, display_name, version, editable FROM field_definitions
    WHERE status = 'approved' AND code IN (${codes.map(() => '?').join(',')})`, codes);
  const byCode = new Map(fields.map(field => [field.code, field]));
  const mappings = [...(sheet.mappings || [])];
  const usedNames = new Set(mappings.map(mapping => mapping.namedArea));
  let changed = false;
  for (const cell of cells) {
    const field = byCode.get(cell.bindingPath);
    if (!field) continue;
    const col = Number(cell.column ?? cell.col);
    if (mappings.some(mapping => mapping.bindingPath === cell.bindingPath
      && Number(mapping.row) === Number(cell.row) && Number(mapping.col) === col)) continue;
    let tag = {};
    try { tag = typeof cell.tag === 'string' ? JSON.parse(cell.tag) : (cell.tag || {}); } catch { tag = {}; }
    const permission = tag.permission || 'primary_input';
    const primary = permission === 'primary_input';
    const base = `MAIN_BODY_INPUT_${field.code}`;
    let namedArea = base;
    for (let suffix = 2; usedNames.has(namedArea); suffix += 1) namedArea = `${base}_${suffix}`;
    usedNames.add(namedArea);
    const editable = tag.editableForUsers?.length ? { editableForUsers: tag.editableForUsers }
      : tag.editableForDepartments?.length ? { editableForDepartments: tag.editableForDepartments }
        : tag.editableForRoles?.length ? { editableForRoles: tag.editableForRoles }
          : primary ? { editableForRoles: ['subsidiary_filler'] } : {};
    const editDimension = editable.editableForUsers ? 'user' : editable.editableForDepartments ? 'department' : 'role';
    const mapping = {
      id: `${field.id}-${cell.row}-${col}-${Date.now()}`,
      fieldDefinitionId: Number(field.id), fieldVersion: Number(field.version), fieldCode: field.code, displayName: field.display_name,
      kind: 'input', namedArea, bindingPath: field.code, bindingVersion: 2,
      row: Number(cell.row), col, rowCount: 1, colCount: 1, required: false, primary,
      format: '', ruleCodes: [], ruleVersionIds: [], formulaSource: null,
      occurrences: [{ sheet: row.sheet_code, section: 'direct', row: Number(cell.row), column: col, rowCount: 1, colCount: 1 }],
      permissionModel: 2, editDimension, ...editable,
      permission, allVisible: tag.allVisible ?? true, dimension: tag.dimension || 'user', excludedVisibility: tag.excludedVisibility || 'masked',
      visibility: tag.visibility || 'visible', hiddenForRoles: tag.hiddenForRoles || [], maskedForRoles: tag.maskedForRoles || [],
      sheet: row.sheet_code, section: 'direct'
    };
    mappings.push(mapping);
    cell.tag = JSON.stringify({ ...tag, mappingId: mapping.id, fieldDefinitionId: mapping.fieldDefinitionId,
      fieldCode: field.code, namedArea, permission, visibility: mapping.visibility });
    changed = true;
  }
  if (!changed) return false;
  sheet.mappings = mappings;
  const inline = row.auxiliary.inlineWorkbook;
  inline.cells = sheet.cells;
  inline.metadata = { ...(inline.metadata || {}), mappings };
  row.auxiliary.inlineWorkbook = inline;
  await run('UPDATE template_sheets SET auxiliary_json = ? WHERE id = ?', [json(row.auxiliary), row.id]);
  return true;
}

async function materializeTemplate(versionId, designerJson, templateSnapshot) {
  if (designerJson === undefined) {
    const version = await getTemplateVersion(versionId);
    const manifest = parse(version.manifest_json, {});
    designerJson = manifest.designerJson || null;
    templateSnapshot = manifest.templateSnapshot || null;
  }
  const rows = await templateSheets(versionId);
  const materializedSheets = [];
  const primaryFields = new Set();
  for (const row of rows) {
    if (row.auxiliary.inlineWorkbook) {
      const inlineSheet = materializeInlineSheet(row);
      await repairInlineMappings(inlineSheet, row);
      materializedSheets.push(inlineSheet);
      continue;
    }
    if (row.sheet_type === 'auxiliary') {
      materializedSheets.push({ code: row.sheet_code, name: row.display_name, type: 'auxiliary', readOnly: true,
        ...row.auxiliary, tag: row.auxiliary.permissionTag || null });
      continue;
    }
    const ids = [row.header_component_version_id, row.body_component_version_id, row.footer_component_version_id].filter(Boolean);
    const versions = await Promise.all(ids.map(id => getComponentVersion(id)));
    const byId = new Map(versions.map(version => [version.id, version]));
    const body = byId.get(row.body_component_version_id);
    if (!body) throw Object.assign(new Error(`业务工作表“${row.display_name}”缺少 Body 网格`), { status: 400 });
    const bodyGrid = parse(body.workbook_json, {});
    let nextRow = 0;
    const sections = [];
    const mappings = [];
    const rowTags = [];
    const columnTags = [];
    const sheetTag = row.auxiliary?.permissionTag || null;
    for (const [type, id] of [['header', row.header_component_version_id], ['body', row.body_component_version_id], ['footer', row.footer_component_version_id]]) {
      if (!id) continue;
      const version = byId.get(id);
      const grid = parse(version.workbook_json, {});
      if (grid.columnCount !== bodyGrid.columnCount) throw Object.assign(new Error(`工作表“${row.display_name}”的 ${typeLabel(type)} 列数必须与 Body 一致`), { status: 400 });
      const componentMetadata = parse(version.metadata_json, {});
      const permissionTags = componentMetadata.permissionTags || {};
      if (permissionTags.sheet != null) for (let sectionRow = 0; sectionRow < grid.rowCount; sectionRow += 1) {
        rowTags.push({ row: sectionRow + nextRow, tag: normalizedTag(permissionTags.sheet) });
      }
      for (const entry of permissionTags.rows || []) rowTags.push({ row: Number(entry.row) + nextRow, tag: normalizedTag(entry.tag) });
      for (const entry of permissionTags.columns || []) columnTags.push({ col: Number(entry.col), tag: normalizedTag(entry.tag) });
      const sectionMappings = (Array.isArray(componentMetadata.mappings) ? componentMetadata.mappings : []).map(mapping => {
        const mappedRow = Number(mapping.row) || 0;
        const col = Number(mapping.col) || 0;
        const rowCount = Number(mapping.rowCount) || 1;
        const colCount = Number(mapping.colCount) || 1;
        const startRow = mappedRow + nextRow;
        const sheetName = row.sheet_code;
        const qualifiedName = `${String(row.sheet_code).toUpperCase()}_${type.toUpperCase()}_${mapping.namedArea}`.replace(/[^A-Z0-9_]/g, '_');
        return { ...mapping, namedArea: qualifiedName, componentNamedArea: mapping.namedArea, sheet: sheetName, section: type,
          componentVersionId: id, row: startRow, col, rowCount, colCount,
          occurrences: [{ sheet: sheetName, section: type, componentVersionId: id, row: startRow, col, rowCount, colCount }] };
      });
      mappings.push(...sectionMappings);
      const mappingByAnchor = new Map(sectionMappings.map(mapping => [`${mapping.row},${mapping.col}`, mapping]));
      sections.push({ type, componentVersionId: id, version: version.version, startRow: nextRow, rowCount: grid.rowCount, columnCount: bodyGrid.columnCount,
        designerJson: componentMetadata.designerJson || null,
        nativeValidations: componentMetadata.nativeValidations || [],
        managedFunctions: componentMetadata.managedFunctions || [],
        mappings: sectionMappings,
        cells: (grid.cells || []).map(cell => {
          const rowIndex = Number(cell.row) + nextRow;
          const colIndex = Number(cell.column ?? cell.col);
          const mapping = mappingByAnchor.get(`${rowIndex},${colIndex}`);
          const shiftedCell = { ...cell, row: rowIndex,
            ...(cell.formula ? { formula: shiftFormulaRows(cell.formula, nextRow) } : {}) };
          if (!mapping || mapping.bindingPath || !cell.tag) return { ...shiftedCell, ...(cell.tag != null ? { tag: normalizedTag(cell.tag) } : {}) };
          let tag = cell.tag;
          if (typeof tag === 'string') { try { tag = JSON.parse(tag); } catch { tag = null; } }
          if (!tag || typeof tag !== 'object') return shiftedCell;
          return { ...shiftedCell, tag: normalizedTag({ ...tag, namedArea: mapping.namedArea, fieldCode: mapping.fieldCode,
            visibility: mapping.visibility || tag.visibility || 'visible',
            hiddenForRoles: mapping.hiddenForRoles || tag.hiddenForRoles || [],
            maskedForRoles: mapping.maskedForRoles || tag.maskedForRoles || [],
            permissionModel: mapping.permissionModel ?? tag.permissionModel, editDimension: mapping.editDimension ?? tag.editDimension,
            editableForUsers: mapping.editableForUsers || tag.editableForUsers,
            editableForRoles: mapping.editableForRoles || tag.editableForRoles || (mapping.primary && !mapping.editableForUsers && !tag.editableForUsers && !mapping.editableForDepartments && !tag.editableForDepartments ? ['subsidiary_filler'] : []),
            hiddenForDepartments: mapping.hiddenForDepartments || tag.hiddenForDepartments || [],
            maskedForDepartments: mapping.maskedForDepartments || tag.maskedForDepartments || [],
            editableForDepartments: mapping.editableForDepartments || tag.editableForDepartments || [] }) };
        }) });
      nextRow += grid.rowCount;
    }
    for (const mapping of mappings) {
      if (!mapping.primary || mapping.permission !== 'primary_input') continue;
      if (primaryFields.has(mapping.fieldCode)) {
        mapping.primary = false;
        mapping.permission = 'read_only';
      } else primaryFields.add(mapping.fieldCode);
    }
    materializedSheets.push({ code: row.sheet_code, name: row.display_name, type: 'business', readOnly: false,
      rowCount: nextRow, columnCount: bodyGrid.columnCount, sections, mappings, tag: sheetTag, rowTags, columnTags,
      cells: sections.flatMap(section => section.cells) });
  }
  const manifest = parse((await getTemplateVersion(versionId)).manifest_json, {});
  validatePermissionConfiguration({ sheets: materializedSheets }, await permissionOptions());
  await run('UPDATE template_versions SET workbook_json = ? WHERE id = ?', [json({ schemaVersion: 1, sheets: materializedSheets,
    ...(manifest.designerSettings ? { designerSettings: manifest.designerSettings } : {}), ...(designerJson ? { designerJson, templateSnapshot } : {}) }), versionId]);
}
function typeLabel(type) { return ({ header: 'Header', body: 'Body', footer: 'Footer' })[type] || type; }
exports.getTemplate = asyncRoute(async (req, res) => {
  const version = await getTemplateVersion(req.params.versionId);
  if (!version) return fail(res, 404, '模板版本不存在');
  if (version.status !== 'published' && version.ownerId !== req.user.id && !req.user.roles.some(role => role.code === 'system_admin' || role.code === 'data_administrator')) return fail(res, 403, '无权查看此模板草稿');
  res.json({ template: { ...version, manifest: parse(version.manifest_json, {}), workbook: parse(version.workbook_json, {}), sheets: await templateSheets(version.id) } });
});

exports.validateTemplate = asyncRoute(async (req, res) => {
  const version = await getTemplateVersion(req.params.versionId);
  if (!version) return fail(res, 404, '模板版本不存在');
  if (version.status !== 'published' && version.ownerId !== req.user.id && !req.user.roles.some(role => role.code === 'system_admin' || role.code === 'data_administrator')) return fail(res, 403, '无权检查此模板草稿');
  const report = await validateTemplate(version.id);
  res.json({ report });
});

exports.previewTemplateRole = asyncRoute(async (req, res) => {
  const version = await getTemplateVersion(req.params.versionId);
  if (!version) return fail(res, 404, '模板版本不存在');
  if (version.status !== 'published' && version.ownerId !== req.user.id && !req.user.roles.some(role => role.code === 'system_admin' || role.code === 'data_administrator')) return fail(res, 403, '无权预览此模板草稿');
  const workbook = parse(version.workbook_json, {});
  const roleCode = String(req.query.role || 'subsidiary_filler');
  res.json({ preview: rolePreview(workbook, roleCode) });
});

exports.createTemplate = asyncRoute(async (req, res) => {
  const { name, description = '', factory = '', sheets = [] } = req.body;
  if (!String(name || '').trim() || !Array.isArray(sheets) || !sheets.length || sheets.length > 30) return fail(res, 400, '模板名称和 1–30 个工作表为必填');
  const designerJson = directWorkbookJson(req.body.designerJson, sheets);
  const templateSnapshot = directTemplateSnapshot(req.body.templateSnapshot, sheets);
  await db.ready;
  await run('BEGIN IMMEDIATE');
  try {
    const template = await run('INSERT INTO templates (name, description, factory, created_by) VALUES (?, ?, ?, ?)', [String(name).trim(), description, factory, req.user.id]);
    const version = await run(`INSERT INTO template_versions (template_id, version, manifest_json, created_by) VALUES (?, 1, ?, ?)`,
      [template.lastID, json({ name: String(name).trim(), description, factory, ownerId: req.user.id, ...(designerJson ? { designMode: 'direct', designerJson, templateSnapshot } : {}) }), req.user.id]);
    await replaceSheets(version.lastID, sheets);
    await materializeTemplate(version.lastID);
    await run('COMMIT');
    await recordBusinessAudit({ actor: req.user, action: 'template.create', objectType: 'template', objectId: template.lastID, businessVersion: '1', after: { name, sheetCount: sheets.length } });
    res.status(201).json({ templateId: template.lastID, versionId: version.lastID, version: 1, status: 'draft' });
  } catch (error) { await run('ROLLBACK').catch(() => {}); if (error.status) return fail(res, error.status, error.message); throw error; }
});

exports.importQuarterlyReferenceDraft = asyncRoute(async (req, res) => {
  const { sourceName, sourceSha256, sheets } = req.body || {};
  if (sourceName !== quarterlyReferenceProfile.sourceName || String(sourceSha256 || '').toLowerCase() !== quarterlyReferenceProfile.sha256
    || !Array.isArray(sheets) || sheets.length !== quarterlyReferenceProfile.sheetNames.length) {
    return fail(res, 400, '季度参考工作簿信息无效，必须包含文件名、SHA-256 和完整的 22 张工作表');
  }
  const sheetCodes = new Set();
  const companySheets = sheets.filter(sheet => sheet.kind === 'company');
  if (companySheets.length !== quarterlyReferenceProfile.companySheetNames.length
    || sheets.some(sheet => !['company', 'readonly'].includes(sheet.kind))) {
    return fail(res, 400, '迁移清单必须包含 13 张公司考核页和其余只读参考页');
  }
  for (const [index, sheet] of sheets.entries()) {
    const expectedKind = quarterlyReferenceProfile.companySheetNames.includes(sheet.name) ? 'company'
      : quarterlyReferenceProfile.auxiliarySheetNames.includes(sheet.name) ? 'readonly' : null;
    if (sheet.name !== quarterlyReferenceProfile.sheetNames[index] || !expectedKind || sheet.kind !== expectedKind) {
      return fail(res, 400, '工作表名称、顺序或迁移类型与已登记的季度参考工作簿不一致');
    }
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(sheet.code || '') || sheetCodes.has(sheet.code)
      || !String(sheet.name || '').trim() || !Number.isInteger(sheet.rowCount) || sheet.rowCount < 1 || sheet.rowCount > 200
      || !Number.isInteger(sheet.columnCount) || sheet.columnCount < 1 || sheet.columnCount > 100
      || !cellsFitRectangle(sheet.cells, sheet.rowCount, sheet.columnCount)
      || !sheet.designerJson || typeof sheet.designerJson !== 'object' || Array.isArray(sheet.designerJson)) {
      return fail(res, 400, `工作表“${sheet.name || sheet.code || '未命名'}”超出组件范围或迁移数据无效`);
    }
    sheetCodes.add(sheet.code);
    if (json(sheet.designerJson).length > 2_000_000) return fail(res, 413, `工作表“${sheet.name}”的版式数据超出 2 MB`);
  }

  const templateName = '2026 年专业化子公司二季度考核 · 迁移草稿';
  const manifest = { name: templateName, description: '由参考工作簿只读导入的迁移草稿；硬编码值和旧公式仅用于对照，正式业务值须绑定治理字段、规则和配置。',
    factory: '季度考核', ownerId: req.user.id,
    sourceWorkbook: { name: String(sourceName).slice(0, 255), sha256: String(sourceSha256).toLowerCase(), importedReadOnly: true },
    migration: { schemaVersion: 1, importedSheetCount: sheets.length, companySheetCount: companySheets.length,
      readonlySheetCount: sheets.length - companySheets.length, unresolvedGovernance: ['field_registry', 'indicator_registry', 'formula_rules', 'permissions', 'named_areas', 'approved_expected_data'] } };
  const createdComponents = [];
  await db.ready;
  await run('BEGIN IMMEDIATE');
  try {
    const template = await run('INSERT INTO templates (name, description, factory, created_by) VALUES (?, ?, ?, ?)',
      [manifest.name, manifest.description, manifest.factory, req.user.id]);
    const version = await run('INSERT INTO template_versions (template_id, version, manifest_json, created_by) VALUES (?, 1, ?, ?)',
      [template.lastID, json(manifest), req.user.id]);
    for (let index = 0; index < sheets.length; index += 1) {
      const sheet = sheets[index];
      let componentVersionId = null;
      let auxiliary = { rowCount: sheet.rowCount, columnCount: sheet.columnCount, cells: sheet.cells,
        designerJson: sheet.designerJson, permissionTag: JSON.stringify({ schemaVersion: 1, visibility: 'visible' }) };
      if (sheet.kind === 'company') {
        // Each import is an independent draft, including imports by another designer.
        // A file-level fixed code collides with components from the first import.
        const componentCode = `q2_2026_t${template.lastID}_${index + 1}`;
        const component = await run('INSERT INTO template_components (code, component_type, created_by) VALUES (?, ?, ?)',
          [componentCode, 'body', req.user.id]);
        const componentMetadata = { name: `${sheet.name} · Q2 导入草稿`, mappings: [], schemaVersion: 1,
          importedFromXlsx: true, importOverflow: false, sourceWorkbookName: manifest.sourceWorkbook.name,
          sourceWorkbookSha256: manifest.sourceWorkbook.sha256, sourceSheetName: sheet.name, sourceSheetIndex: index,
          designerJsonScope: 'worksheet', designerJson: sheet.designerJson, nativeValidations: Array.isArray(sheet.nativeValidations) ? sheet.nativeValidations : [],
          permissionTags: { sheet: JSON.stringify({ schemaVersion: 1, visibility: 'visible' }) } };
        const componentVersion = await run(`INSERT INTO template_component_versions
          (component_id, version, workbook_json, metadata_json, created_by) VALUES (?, 1, ?, ?, ?)`,
        [component.lastID, json({ rowCount: sheet.rowCount, columnCount: sheet.columnCount, cells: sheet.cells }), json(componentMetadata), req.user.id]);
        componentVersionId = componentVersion.lastID;
        createdComponents.push({ id: component.lastID, versionId: componentVersionId, code: componentCode, sheet: sheet.name });
        auxiliary = { permissionTag: JSON.stringify({ schemaVersion: 1, visibility: 'visible' }) };
      }
      await run(`INSERT INTO template_sheets (template_version_id, sheet_code, display_name, sheet_order, sheet_type,
        header_component_version_id, body_component_version_id, footer_component_version_id, auxiliary_json) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
      [version.lastID, sheet.code, String(sheet.name), index, sheet.kind === 'company' ? 'business' : 'auxiliary', componentVersionId, json(auxiliary)]);
    }
    await materializeTemplate(version.lastID);
    await run('COMMIT');
    await recordBusinessAudit({ actor: req.user, action: 'template.reference_workbook.import', objectType: 'template', objectId: template.lastID,
      businessVersion: '1', after: { name: manifest.name, sourceSha256: manifest.sourceWorkbook.sha256,
        sheetCount: sheets.length, companySheetCount: companySheets.length, readonlySheetCount: sheets.length - companySheets.length } });
    res.status(201).json({ templateId: template.lastID, versionId: version.lastID, version: 1, status: 'draft',
      sheetCount: sheets.length, companySheetCount: companySheets.length, readonlySheetCount: sheets.length - companySheets.length,
      components: createdComponents });
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    throw error;
  }
});

async function replaceSheets(versionId, sheets, { allowedExistingDraftComponentIds = new Set(), actorId = null } = {}) {
  const codes = new Set();
  for (let index = 0; index < sheets.length; index += 1) {
    const sheet = sheets[index];
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(sheet.code || '') || !String(sheet.name || '').trim() || codes.has(sheet.code)) throw Object.assign(new Error('工作表编码或名称无效，且编码不能重复'), { status: 400 });
    codes.add(sheet.code);
    const type = sheet.type === 'auxiliary' ? 'auxiliary' : sheet.type === 'business' ? 'business' : null;
    if (!type) throw Object.assign(new Error('工作表类型无效'), { status: 400 });
    const inlineWorkbook = sheet.inlineWorkbook ? normalizeInlineWorkbook(sheet.inlineWorkbook) : null;
    if (sheet.auxiliary?.dataBinding && (type !== 'auxiliary' || inlineWorkbook)) throw Object.assign(new Error('接口数据仅用于独立只读辅助工作表'), { status: 400 });
    if (inlineWorkbook && (sheet.headerVersionId || sheet.bodyVersionId || sheet.footerVersionId)) throw Object.assign(new Error('详细修改过的工作表不能同时引用组件'), { status: 400 });
    if (type === 'business' && !sheet.bodyVersionId && !inlineWorkbook) throw Object.assign(new Error(`业务工作表“${sheet.name}”必须选择一个 Body 组件`), { status: 400 });
    if (type === 'auxiliary' && (sheet.headerVersionId || sheet.bodyVersionId || sheet.footerVersionId)) throw Object.assign(new Error('只读辅助工作表不能绑定业务组件'), { status: 400 });
    const auxiliary = type === 'auxiliary' ? { ...auxiliaryContent(sheet.auxiliary), ...(inlineWorkbook ? {
      inlineWorkbook, rowCount: inlineWorkbook.rowCount, columnCount: inlineWorkbook.columnCount,
      cells: inlineWorkbook.cells, designerJson: inlineWorkbook.metadata.designerJson } : {}) }
      : { permissionTag: sheet.permissionTag == null ? null : normalizedTag(sheet.permissionTag), ...(inlineWorkbook ? { inlineWorkbook } : {}) };
    if (auxiliary.dataBinding) {
      auxiliary.rowCount = 20; auxiliary.columnCount = 10; auxiliary.cells = []; auxiliary.designerJson = null;
    }
    if (type === 'auxiliary' && (validateRectangle(auxiliary) || !cellsFitRectangle(auxiliary.cells, auxiliary.rowCount, auxiliary.columnCount))) {
      throw Object.assign(new Error('只读辅助工作表内容须为有效矩形区域'), { status: 400 });
    }
    const ids = [['header', sheet.headerVersionId], ['body', sheet.bodyVersionId], ['footer', sheet.footerVersionId]];
    for (const [componentType, id] of ids) {
      if (!id) continue;
      const component = await getComponentVersion(id);
      const editableDraftReference = component?.workflow_status === 'draft'
        && allowedExistingDraftComponentIds.has(Number(id)) && Number(component.ownerId) === Number(actorId);
      if (!component || (!['published', 'superseded'].includes(component.workflow_status) && !editableDraftReference)) {
        throw Object.assign(new Error('模板只能引用已发布组件，或保留当前草稿模板中由本人维护的 Draft 组件'), { status: 400 });
      }
      if (component.componentType !== componentType) throw Object.assign(new Error(`${componentType} 位置只能使用同类型组件`), { status: 400 });
    }
    if (type === 'business' && !inlineWorkbook) {
      const bodyComponent = await getComponentVersion(sheet.bodyVersionId);
      const bodyGrid = parse(bodyComponent.workbook_json, {});
      for (const [componentType, id] of [['header', sheet.headerVersionId], ['footer', sheet.footerVersionId]]) {
        if (!id) continue;
        const region = await getComponentVersion(id);
        const regionGrid = parse(region.workbook_json, {});
        if (regionGrid.columnCount !== bodyGrid.columnCount) throw Object.assign(new Error(`${componentType === 'header' ? 'Header' : 'Footer'} 列数必须与 Body 列网格一致`), { status: 400 });
      }
    }
    await run(`INSERT INTO template_sheets (template_version_id, sheet_code, display_name, sheet_order, sheet_type,
      header_component_version_id, body_component_version_id, footer_component_version_id, auxiliary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [versionId, sheet.code, String(sheet.name), index, type, sheet.headerVersionId || null, sheet.bodyVersionId || null, sheet.footerVersionId || null, json(auxiliary)]);
  }
  if (!sheets.some(sheet => sheet.type === 'business')) throw Object.assign(new Error('模板至少需要一个业务工作表'), { status: 400 });
}

exports.createTemplateVersion = asyncRoute(async (req, res) => {
  const template = await get('SELECT * FROM templates WHERE id = ?', [req.params.id]);
  if (!template) return fail(res, 404, '模板不存在');
  if (!ownerOrAdmin(req, res, template.created_by)) return;
  const source = await getTemplateVersion(req.body.fromVersionId);
  if (!source || source.template_id !== template.id || !['published', 'superseded', 'rejected'].includes(source.status)) return fail(res, 400, '只能从已发布或已退回版本创建新版本');
  const latest = await get('SELECT MAX(version) AS version FROM template_versions WHERE template_id = ?', [template.id]);
  await db.ready;
  await run('BEGIN IMMEDIATE');
  try {
    const next = await run('INSERT INTO template_versions (template_id, version, manifest_json, created_by) VALUES (?, ?, ?, ?)',
      [template.id, latest.version + 1, source.manifest_json, req.user.id]);
    const sheets = await templateSheets(source.id);
    for (const sheet of sheets) await run(`INSERT INTO template_sheets (template_version_id, sheet_code, display_name, sheet_order, sheet_type,
      header_component_version_id, body_component_version_id, footer_component_version_id, auxiliary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [next.lastID, sheet.sheet_code, sheet.display_name, sheet.sheet_order, sheet.sheet_type, sheet.header_component_version_id, sheet.body_component_version_id, sheet.footer_component_version_id, json(sheet.auxiliary)]);
    await materializeTemplate(next.lastID);
    await run('COMMIT');
    await recordBusinessAudit({ actor: req.user, action: 'template.version.create', objectType: 'template', objectId: template.id,
      businessVersion: String(latest.version + 1), before: { fromVersion: source.version }, after: { version: latest.version + 1 } });
    res.status(201).json({ versionId: next.lastID, version: latest.version + 1, status: 'draft' });
  } catch (error) { await run('ROLLBACK').catch(() => {}); throw error; }
});

exports.updateTemplateVersion = asyncRoute(async (req, res) => {
  const version = await getTemplateVersion(req.params.versionId);
  if (!version) return fail(res, 404, '模板版本不存在');
  if (!ownerOrAdmin(req, res, version.ownerId)) return;
  if (version.status !== 'draft') return fail(res, 409, '只有草稿模板版本可以编辑');
  const { name, description = '', factory = '', sheets } = req.body;
  if (!String(name || '').trim() || !Array.isArray(sheets) || !sheets.length || sheets.length > 30) return fail(res, 400, '模板名称和 1–30 个工作表为必填');
  const manifest = { ...parse(version.manifest_json, {}), name: String(name).trim(), description, factory, ownerId: version.ownerId };
  const currentSheets = await templateSheets(version.id);
  for (const current of currentSheets) {
    const next = sheets.find(sheet => sheet.code === current.sheet_code);
    if (current.auxiliary.inlineWorkbook && next && (!next.inlineWorkbook || next.type !== current.sheet_type)) {
      return fail(res, 400, `工作表“${current.display_name}”已详细修改，请在 Designer 中继续编辑，不能恢复组件组合或更改类型`);
    }
  }
  const allowComposed = manifest.designMode !== 'direct';
  if (req.body.designerJson !== undefined || sheets.some(sheet => sheet.inlineWorkbook)) {
    const previousJson = manifest.designerJson;
    manifest.designerJson = directWorkbookJson(req.body.designerJson, sheets, { allowComposed });
    manifest.designMode = allowComposed ? 'composed' : 'direct';
    manifest.templateSnapshot = directTemplateSnapshot(req.body.templateSnapshot, sheets, { allowComposed });
    if (!manifest.designerJson && previousJson) {
      const { sheets: ignoredSheets, ...settings } = previousJson;
      manifest.designerSettings = settings;
    }
  }
  const allowedExistingDraftComponentIds = new Set(currentSheets.flatMap(sheet => [
    sheet.header_component_version_id, sheet.body_component_version_id, sheet.footer_component_version_id
  ].filter(Boolean).map(Number)));
  await run('BEGIN IMMEDIATE');
  try {
    await run('DELETE FROM template_sheets WHERE template_version_id = ?', [version.id]);
    await replaceSheets(version.id, sheets, { allowedExistingDraftComponentIds, actorId: req.user.id });
    await run('UPDATE template_versions SET manifest_json = ? WHERE id = ?', [json(manifest), version.id]);
    await materializeTemplate(version.id, manifest.designerJson, manifest.templateSnapshot);
    await run('UPDATE templates SET name = ?, description = ?, factory = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [manifest.name, description, factory, version.template_id]);
    await run('COMMIT');
  } catch (error) { await run('ROLLBACK').catch(() => {}); if (error.status) return fail(res, error.status, error.message); throw error; }
  await recordBusinessAudit({ actor: req.user, action: 'template.draft.update', objectType: 'template', objectId: version.template_id,
    businessVersion: String(version.version), after: { name: manifest.name, sheetCount: sheets.length } });
  res.json({ status: 'draft' });
});

exports.submitTemplate = asyncRoute(async (req, res) => {
  const version = await getTemplateVersion(req.params.versionId);
  if (!version) return fail(res, 404, '模板版本不存在');
  if (!ownerOrAdmin(req, res, version.ownerId)) return;
  if (version.status !== 'draft') return fail(res, 409, '只有草稿模板版本可以提交审核');
  const publicationReport = await validateTemplate(version.id);
  if (!publicationReport?.passed) return res.status(400).json({ error: '模板发布检查未通过，请先修复阻断项', report: publicationReport });
  const sheets = await templateSheets(version.id);
  if (!sheets.some(sheet => sheet.sheet_type === 'business' && (sheet.body_component_version_id || sheet.auxiliary.inlineWorkbook))) return fail(res, 400, '至少配置一个直接设计或引用组件的业务工作表');
  const stale = await get(`SELECT s.display_name FROM template_sheets s
    LEFT JOIN template_component_versions h ON h.id = s.header_component_version_id
    LEFT JOIN template_component_versions b ON b.id = s.body_component_version_id
    LEFT JOIN template_component_versions f ON f.id = s.footer_component_version_id
    WHERE s.template_version_id = ? AND ((s.header_component_version_id IS NOT NULL AND h.workflow_status NOT IN ('published','superseded'))
      OR (s.body_component_version_id IS NOT NULL AND b.workflow_status NOT IN ('published','superseded'))
      OR (s.footer_component_version_id IS NOT NULL AND f.workflow_status NOT IN ('published','superseded'))) LIMIT 1`, [version.id]);
  if (stale) return fail(res, 400, `工作表“${stale.display_name}”引用了不可用的组件版本`);
  if (hasRole(req.user, 'system_admin')) return reviewTemplateVersion(req, res, version, true);
  await run(`UPDATE template_versions SET status = 'in_review', reviewed_by = NULL WHERE id = ?`, [version.id]);
  await recordBusinessAudit({ actor: req.user, action: 'template.submit', objectType: 'template', objectId: version.template_id,
    businessVersion: String(version.version), before: { status: 'draft' }, after: { status: 'in_review' } });
  res.json({ status: 'in_review' });
});

exports.reviewTemplate = asyncRoute(async (req, res) => {
  const version = await getTemplateVersion(req.params.versionId);
  if (!version) return fail(res, 404, '模板版本不存在');
  return reviewTemplateVersion(req, res, version);
});

async function reviewTemplateVersion(req, res, version, direct = false) {
  if (!hasRole(req.user, 'system_admin')) return fail(res, 403, '需要系统管理员权限');
  if (version.status !== (direct ? 'draft' : 'in_review')) return fail(res, 409, '模板状态已变化');
  const action = direct ? 'approve' : req.body.action;
  if (!['approve', 'reject'].includes(action)) return fail(res, 400, '审核操作无效');
  if (action === 'approve') {
    const publicationReport = await validateTemplate(version.id);
    if (!publicationReport?.passed) return res.status(400).json({ error: '模板发布检查未通过，不能批准发布', report: publicationReport });
  }
  const status = action === 'approve' ? 'published' : 'rejected';
  if (action === 'approve') await templateDefinitions(parse(version.metadata_json, {}));
  await db.ready;
  await run('BEGIN IMMEDIATE');
  try {
    const current = await get('SELECT status AS status FROM template_versions WHERE id=?', [version.id]);
    if (current?.status !== (direct ? 'draft' : 'in_review')) throw Object.assign(new Error('版本状态已变化，请刷新后重试'), { status: 409 });
    if (status === 'published') {
      const workbook = parse(version.workbook_json, {});
      const manifest = parse(version.manifest_json, {});
      manifest.permissionIndex = compilePermissionIndex(workbook);
      manifest.submission = compileSubmissionManifest(workbook);
      await run('UPDATE template_versions SET manifest_json = ? WHERE id = ?', [json(manifest), version.id]);
      await run(`UPDATE template_versions SET status = 'superseded' WHERE template_id = ? AND status = 'published'`, [version.template_id]);
      await run(`UPDATE template_versions SET status = 'published', reviewed_by = ?, published_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.user.id, version.id]);
      await run(`UPDATE templates SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [version.template_id]);
    } else {
      await run(`UPDATE template_versions SET status = 'rejected', reviewed_by = ? WHERE id = ?`, [req.user.id, version.id]);
    }
    await recordBusinessAudit({ actor: req.user, action: `template.${action}`, objectType: 'template', objectId: version.template_id,
      businessVersion: String(version.version), before: { status: version.status }, after: { status, approvalMode: direct ? 'administrator_direct' : 'reviewed' }, reason: direct ? '系统管理员提交，免审批直接发布' : req.body.note || null });
    await run('COMMIT');
  } catch (error) { await run('ROLLBACK').catch(() => {}); throw error; }

  res.json({ status });
}

exports.createComponentVersion && (exports._helpers = { replaceSheets, validateRectangle });

