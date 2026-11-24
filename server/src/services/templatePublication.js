const { templateDefinitions } = require('./managedFunctions');
const { validPath } = require('./bindingSource');
const db = require('../config/database');
const quarterlyReferenceProfile = require('../../../shared/quarterly-reference-profile.json');
const { evaluateExpression, resultsEqual } = require('./ruleEvaluator');
const { compilePermissionIndex, permissionAt, validatePermissionConfiguration } = require('./permissionIndex');
const { permissionOptions } = require('./permissionOptions');
const { requiresAuthoritativeFormula } = require('./formulaPrecheck');

const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } };

function check(code, label, issues = []) {
  return { code, label, passed: issues.length === 0, issues };
}

function rolePreview(workbook, roleCode) {
  let permissionIndex = null;
  try { permissionIndex = compilePermissionIndex(workbook); } catch { /* Invalid Tags are reported by the publication check. */ }
  const sheets = (workbook?.sheets || []).map((sheet, sheetIndex) => ({
    code: sheet.code,
    name: sheet.name,
    readOnly: Boolean(sheet.readOnly),
    mappings: (sheet.mappings || []).map(mapping => {
      const regionPermissions = [];
      for (let row = mapping.row; row < mapping.row + mapping.rowCount; row += 1)
        for (let col = mapping.col; col < mapping.col + mapping.colCount; col += 1)
          if (permissionIndex?.sheets?.[sheetIndex]) regionPermissions.push(permissionAt(permissionIndex.sheets[sheetIndex], row, col,
            { roles: [roleCode], departments: [] }));
      const indexedVisibility = regionPermissions.some(item => item.visibility === 'hidden') ? 'hidden'
        : regionPermissions.some(item => item.visibility === 'masked') ? 'masked' : null;
      const visibility = indexedVisibility || mapping.visibilityByRole?.[roleCode] || mapping.visibility || 'visible';
      const hidden = (mapping.hiddenForRoles || []).includes(roleCode) || visibility === 'hidden';
      const masked = !hidden && ((mapping.maskedForRoles || []).includes(roleCode) || visibility === 'masked');
      const roleEditable = Array.isArray(mapping.editableForRoles)
        ? mapping.editableForRoles.includes(roleCode)
        : roleCode === 'subsidiary_filler';
      const locked = Boolean(sheet.readOnly || mapping.locked || mapping.kind === 'calc' || mapping.permission !== 'primary_input' || !roleEditable
        || regionPermissions.some(item => !item.editable));
      return {
        fieldCode: mapping.fieldCode,
        namedArea: mapping.namedArea,
        row: mapping.row,
        col: mapping.col,
        visibility: hidden ? 'hidden' : masked ? 'masked' : 'visible',
        editability: hidden || locked ? 'locked' : 'editable',
        masked
      };
    })
  }));
  return { roleCode, sheets };
}

function compileSubmissionManifest(workbook) {
  const sheets = workbook?.sheets || [];
  return {
    version: 1,
    sheets: sheets.map((sheet, sheetIndex) => ({
      code: sheet.code,
      name: sheet.name,
      order: sheetIndex,
      type: sheet.type,
      readOnly: Boolean(sheet.readOnly),
      mappings: (sheet.type === 'auxiliary' || sheet.readOnly ? [] : sheet.mappings || []).map(mapping => ({
        ...mapping,
        sheet: sheet.code,
        sheetIndex,
        sourceLocation: { row: Number(mapping.row), column: Number(mapping.col), rowCount: Number(mapping.rowCount), columnCount: Number(mapping.colCount) }
      }))
    }))
  };
}

async function validateTemplate(versionId) {
  const version = await get(`SELECT tv.*, t.name AS template_name FROM template_versions tv
    JOIN templates t ON t.id = tv.template_id WHERE tv.id = ?`, [versionId]);
  if (!version) return null;
  const manifest = parse(version.manifest_json, {});
  const workbook = parse(version.workbook_json, {});
  const sheetRows = await all('SELECT * FROM template_sheets WHERE template_version_id = ? ORDER BY sheet_order', [versionId]);
  const issues = [];
  try { await templateDefinitions(workbook); } catch (error) { issues.push({ code: 'version_metadata_invalid', message: error.message }); }
  try { validatePermissionConfiguration(workbook, await permissionOptions()); }
  catch (error) { issues.push({ code: 'permission_tag_invalid', message: error.message }); }
  const mappings = (workbook?.sheets || []).flatMap(sheet => (sheet.mappings || []).map(mapping => ({ ...mapping, _sheet: sheet })));
  const componentIds = [...new Set(sheetRows.flatMap(row => [row.header_component_version_id, row.body_component_version_id, row.footer_component_version_id].filter(Boolean)))];
  const components = componentIds.length ? await all(`SELECT cv.*, c.component_type FROM template_component_versions cv
    JOIN template_components c ON c.id = cv.component_id WHERE cv.id IN (${componentIds.map(() => '?').join(',')})`, componentIds) : [];
  const byComponent = new Map(components.map(row => [Number(row.id), row]));
  const fieldCodes = [...new Set(mappings.filter(mapping => mapping.fieldDefinitionId && mapping.sourceType !== 'business_formula').map(mapping => mapping.fieldCode).filter(Boolean))];
  const fields = fieldCodes.length ? await all(`SELECT id, code, status, version, editable FROM field_definitions WHERE code IN (${fieldCodes.map(() => '?').join(',')})`, fieldCodes) : [];
  const fieldsByCode = new Map(fields.map(row => [row.code, row]));
  if (workbook.designerJson && !workbook.templateSnapshot) issues.push({ code: 'version_metadata_invalid', message: '完整模板缺少协作版式，请在 Designer 中重新保存草稿' });
  const directSheets = (workbook.sheets || []).filter(sheet => sheet.designMode === 'direct');
  const importedValidationRuleIds = [...components.flatMap(component => parse(component.metadata_json, {}).nativeValidations || []),
    ...directSheets.flatMap(sheet => sheet.nativeValidations || [])]
    .map(validation => Number(validation.ruleVersionId)).filter(Number.isFinite);
  const referencedRuleIds = [...new Set([
    ...mappings.flatMap(mapping => [...(mapping.ruleVersionIds || []), mapping.formulaVersionId].filter(Boolean).map(Number)),
    ...importedValidationRuleIds
  ])];
  const rules = referencedRuleIds.length ? await all(`SELECT v.*, d.code, d.rule_type FROM rule_versions v JOIN rule_definitions d ON d.id = v.rule_id
    WHERE v.id IN (${referencedRuleIds.map(() => '?').join(',')})`, referencedRuleIds) : [];
  const rulesById = new Map(rules.map(row => [Number(row.id), row]));

  for (const row of sheetRows) {
    if (row.sheet_type !== 'business') continue;
    const parts = [['header', row.header_component_version_id], ['body', row.body_component_version_id], ['footer', row.footer_component_version_id]];
    for (const [type, id] of parts) {
      if (!id) continue;
      const component = byComponent.get(Number(id));
      if (!component || !['published', 'superseded'].includes(component.workflow_status)) {
        issues.push({ code: 'component_unavailable', message: `${type.toUpperCase()} 组件版本不可用`, sheet: row.sheet_code, objectId: id, componentVersionId: Number(id) });
      }
    }
  }

  const formulaMappings = mappings.filter(mapping => mapping.formulaVersionId && mapping.formulaSource);
  const formulaFields = new Set(formulaMappings.map(mapping => mapping.fieldCode));
  const mappedFieldCodes = new Set(mappings.map(mapping => mapping.fieldCode).filter(Boolean));
  const formulaGraph = new Map();
  const missingFormulaReferences = [];
  for (const mapping of formulaMappings) {
    const rule = rulesById.get(Number(mapping.formulaVersionId));
    const refs = new Set();
    const referencedFields = new Set();
    const collect = node => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.field === 'string') {
        referencedFields.add(node.field);
        if (formulaFields.has(node.field)) refs.add(node.field);
      }
      if (Array.isArray(node.args)) node.args.forEach(collect);
    };
    if (rule) collect(parse(rule.expression_json));
    formulaGraph.set(mapping.fieldCode, refs);
    for (const fieldCode of referencedFields) {
      if (!mappedFieldCodes.has(fieldCode)) missingFormulaReferences.push({
        fieldCode,
        mapping,
        ruleVersionId: Number(rule?.id || mapping.formulaVersionId)
      });
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const cycleNodes = new Set();
  function visitFormula(fieldCode, path = []) {
    if (visiting.has(fieldCode)) {
      const start = path.indexOf(fieldCode);
      path.slice(start).forEach(code => cycleNodes.add(code));
      return;
    }
    if (visited.has(fieldCode)) return;
    visiting.add(fieldCode);
    for (const dependency of formulaGraph.get(fieldCode) || []) visitFormula(dependency, [...path, fieldCode]);
    visiting.delete(fieldCode);
    visited.add(fieldCode);
  }
  for (const fieldCode of formulaGraph.keys()) visitFormula(fieldCode);

  for (const mapping of mappings) {
    const location = { sheet: mapping._sheet.code, namedArea: mapping.namedArea, objectId: mapping.id || null, mappingId: mapping.id || null,
      componentVersionId: mapping.componentVersionId || null };
    if (!/^[A-Z][A-Z0-9_]{0,254}$/.test(mapping.namedArea || '')) issues.push({ code: 'named_area_invalid', message: '命名区域必须是唯一的英文大写标识符', ...location });
    if (!Number.isInteger(mapping.row) || !Number.isInteger(mapping.col) || !Number.isInteger(mapping.rowCount) || !Number.isInteger(mapping.colCount)
      || mapping.row < 0 || mapping.col < 0 || mapping.rowCount < 1 || mapping.colCount < 1
      || mapping.row + mapping.rowCount > mapping._sheet.rowCount || mapping.col + mapping.colCount > mapping._sheet.columnCount) {
      issues.push({ code: 'mapping_out_of_bounds', message: '映射区域超出工作表范围', ...location });
    }
    if (!mapping.fieldCode && !mapping.formulaSource) issues.push({ code: 'mapping_source_missing', message: '映射缺少字段或公式来源', ...location });
    const anchor = (mapping._sheet.cells || []).find(cell => Number(cell.row) === Number(mapping.row) && Number(cell.column ?? cell.col) === Number(mapping.col));
    let tag = anchor?.tag;
    if (typeof tag === 'string') tag = parse(tag, null);
    if (mapping.bindingPath ? (!validPath(mapping.bindingPath) || mapping.bindingPath !== mapping.fieldCode || mapping.kind !== 'input' || mapping.rowCount !== 1 || mapping.colCount !== 1 || anchor?.bindingPath !== mapping.bindingPath || tag?.platform !== 'cost-report-cell-permission-v1' || tag.permission !== mapping.permission) : (!tag || tag.platform !== 'cost-report-mapping-v1' || tag.namedArea !== mapping.namedArea || tag.fieldCode !== mapping.fieldCode)) {
      issues.push({ code: 'mapping_tag_missing', message: '映射单元格缺少匹配的治理 Tag', ...location });
    }
    if (mapping.primary && mapping.permission !== 'primary_input') issues.push({ code: 'primary_permission_mismatch', message: '主输入映射必须标记为可编辑 Primary Input', ...location });
    if (mapping.permission === 'primary_input' && !mapping.primary) issues.push({ code: 'editable_region_unregistered', message: '可编辑区域必须登记为唯一 Primary Input', ...location });
    if (tag && mapping.visibility && tag.visibility !== mapping.visibility) issues.push({ code: 'mapping_tag_mismatch', message: '单元格 Tag 与映射可见性不一致', ...location });
    if (mapping.fieldDefinitionId && mapping.sourceType !== 'business_formula') {
      const field = fieldsByCode.get(mapping.fieldCode);
      if (!field || field.status !== 'approved') issues.push({ code: 'field_unapproved', message: `字段 ${mapping.fieldCode || mapping.fieldDefinitionId} 未批准或已移除`, ...location });
      else if (Number(mapping.fieldDefinitionId) !== Number(field.id)) issues.push({ code: 'field_identity_mismatch', message: '字段编码与字段编号不匹配', ...location });
      else if (mapping.primary && (!field.editable || mapping.permission !== 'primary_input')) issues.push({ code: 'field_not_editable', message: '不可编辑字段不能配置为主输入', ...location });
    }
    if (!mapping.fieldDefinitionId && mapping.sourceType !== 'business_formula' && !mapping.formulaVersionId) {
      issues.push({ code: 'field_unapproved', message: `字段 ${mapping.fieldCode || '未命名'} 缺少已批准字段编号`, ...location });
    }
    for (const id of mapping.ruleVersionIds || []) {
      const rule = rulesById.get(Number(id));
      if (!rule || rule.status !== 'published' || rule.rule_type !== 'validation') issues.push({ code: 'validation_rule_unavailable', message: `校验规则版本 ${id} 未发布或类型不正确`, ...location, ruleVersionId: id });
    }
    for (const componentId of [mapping.componentVersionId]) {
      if (componentId && !byComponent.has(Number(componentId))) issues.push({ code: 'component_reference_missing', message: '映射引用的组件版本不存在', ...location });
    }
    if (requiresAuthoritativeFormula(mapping) || mapping.formulaSource || mapping.formulaVersionId) {
      const rule = rulesById.get(Number(mapping.formulaVersionId));
      if (!rule || rule.status !== 'published' || rule.rule_type !== 'formula' || rule.code !== mapping.formulaSource) {
        issues.push({ code: 'formula_unavailable', message: `“${mapping.displayName || mapping.fieldCode || mapping.namedArea}”（${mapping.namedArea}）缺少已发布的后端公式；系统计算须绑定业务公式，手工填报须改为标量输入。`, ...location });
      } else {
        const cases = parse(rule.test_cases_json, []);
        if (!Array.isArray(cases) || cases.length === 0) issues.push({ code: 'formula_samples_missing', message: '业务公式必须有预期结果样例', ...location, ruleVersionId: rule.id });
        else for (const sample of cases) {
          try {
            const actual = evaluateExpression(parse(rule.expression_json), sample.input || {}, parse(rule.parameters_json, {}));
            if (!resultsEqual(actual, sample.expected)) throw new Error('结果与预期值不一致');
          } catch (error) {
            issues.push({ code: 'formula_sample_failed', message: `公式样例“${sample.name || '未命名'}”失败：${error.message}`, ...location, ruleVersionId: rule.id });
          }
        }
        if (cycleNodes.has(mapping.fieldCode) || cycleNodes.has(rule.code)) issues.push({ code: 'formula_circular', message: '业务公式之间存在循环依赖', ...location, ruleVersionId: rule.id });
      }
    }
  }

  for (const missing of missingFormulaReferences) {
    const mapping = missing.mapping;
    issues.push({
      code: 'formula_reference_missing',
      message: `公式 ${mapping.formulaSource || mapping.fieldCode} 引用了模板中未映射的字段 ${missing.fieldCode}`,
      sheet: mapping._sheet.code,
      namedArea: mapping.namedArea,
      objectId: mapping.id || null,
      mappingId: mapping.id || null,
      componentVersionId: mapping.componentVersionId || null,
      fieldCode: missing.fieldCode,
      ruleVersionId: missing.ruleVersionId
    });
  }

  const primaryCounts = new Map();
  for (const mapping of mappings) if (mapping.primary && mapping.permission === 'primary_input') primaryCounts.set(mapping.fieldCode, (primaryCounts.get(mapping.fieldCode) || 0) + 1);
  for (const [fieldCode, count] of primaryCounts) {
    if (count <= 1) continue;
    const targets = mappings.filter(mapping => mapping.fieldCode === fieldCode && mapping.primary && mapping.permission === 'primary_input')
      .map(mapping => ({ componentVersionId: mapping.componentVersionId || null, mappingId: mapping.id || null,
        namedArea: mapping.namedArea, sheet: mapping._sheet.code }))
      .filter(target => target.componentVersionId);
    issues.push({ code: 'duplicate_primary_input', message: `字段 ${fieldCode} 有 ${count} 个主输入来源`, fieldCode, objects: targets });
  }

  for (const sheet of directSheets) for (const cell of sheet.cells || []) {
    if (cell.bindingPath && !(sheet.mappings || []).some(mapping => mapping.bindingPath === cell.bindingPath
      && mapping.row === cell.row && mapping.col === cell.column)) {
      issues.push({ code: 'mapping_source_missing', message: '绑定单元格尚未关联已批准字段，请从字段目录重新绑定',
        sheet: sheet.code, row: cell.row, col: cell.column });
    }
  }
  // Native DataValidators are part of the approved template structure itself.
  // No parallel tag or per-cell catalog registration is required.

  if (!String(manifest.name || version.template_name || '').trim() || !Number.isInteger(Number(version.version)) || !version.created_by) {
    issues.push({ code: 'version_metadata_invalid', message: '模板名称、版本或维护人元数据缺失' });
  }
  const sourceWorkbook = manifest.sourceWorkbook;
  const isQuarterlyReferenceImport = sourceWorkbook?.name === quarterlyReferenceProfile.sourceName
    && sourceWorkbook?.sha256 === quarterlyReferenceProfile.sha256 && sourceWorkbook?.importedReadOnly === true;
  if (isQuarterlyReferenceImport) {
    const expectedCompanyNames = new Set(quarterlyReferenceProfile.companySheetNames);
    const expectedAuxiliaryNames = new Set(quarterlyReferenceProfile.auxiliarySheetNames);
    const structureMatches = (workbook?.sheets || []).length === quarterlyReferenceProfile.sheetNames.length
      && (workbook?.sheets || []).every((sheet, index) => sheet.name === quarterlyReferenceProfile.sheetNames[index]
        && (expectedCompanyNames.has(sheet.name)
          ? sheet.type === 'business' && sheet.readOnly !== true
          : expectedAuxiliaryNames.has(sheet.name) && sheet.type === 'auxiliary' && sheet.readOnly === true));
    if (!structureMatches) issues.push({ code: 'reference_sheet_structure_invalid',
      message: '季度参考模板必须按登记顺序保留 13 张业务公司页和 9 张只读辅助页' });
    const missingCompanyMappings = [...expectedCompanyNames].filter(name => {
      const sheet = (workbook?.sheets || []).find(candidate => candidate.name === name);
      return !sheet?.mappings?.some(mapping => mapping.fieldCode && mapping.fieldDefinitionId);
    });
    if (missingCompanyMappings.length) issues.push({ code: 'reference_company_mapping_missing',
      message: `以下公司页尚未登记任何已批准字段映射：${missingCompanyMappings.join('、')}`,
      sheets: missingCompanyMappings });
  }
  const countsBySheet = new Map();
  const namedAreasBySheet = new Map();
  for (const mapping of mappings) {
    const sheetCode = mapping._sheet.code;
    countsBySheet.set(sheetCode, (countsBySheet.get(sheetCode) || 0) + 1);
    const names = namedAreasBySheet.get(sheetCode) || new Set();
    if (names.has(mapping.namedArea)) {
      const targets = mappings.filter(candidate => candidate._sheet.code === sheetCode && candidate.namedArea === mapping.namedArea)
        .map(candidate => ({ componentVersionId: candidate.componentVersionId || null, mappingId: candidate.id || null,
          namedArea: candidate.namedArea, sheet: sheetCode, row: candidate.row, col: candidate.col,
          cell: Number.isInteger(Number(candidate.row)) && Number.isInteger(Number(candidate.col)) ? `${Number(candidate.row) + 1},${Number(candidate.col) + 1}` : null }))
        .filter(target => target.componentVersionId);
      issues.push({ code: 'duplicate_named_area', message: `工作表内命名区域 ${mapping.namedArea} 重复`, sheet: sheetCode, namedArea: mapping.namedArea, objects: targets });
    }
    names.add(mapping.namedArea);
    namedAreasBySheet.set(sheetCode, names);
  }

  const groups = [
    check('components', '组件兼容性与版本引用', issues.filter(item => ['component_unavailable', 'component_reference_missing'].includes(item.code))),
    check('fields', '批准字段与 Primary Input', issues.filter(item => ['field_unapproved', 'field_identity_mismatch', 'field_not_editable', 'primary_permission_mismatch', 'duplicate_primary_input'].includes(item.code))),
    check('mappings', '命名区域、Tags 与可编辑区域', issues.filter(item => ['named_area_invalid', 'mapping_out_of_bounds', 'mapping_source_missing', 'mapping_tag_missing', 'mapping_tag_mismatch', 'editable_region_unregistered', 'duplicate_named_area', 'import_overflow', 'permission_tag_invalid'].includes(item.code))),
    check('rules', '历史业务校验引用', issues.filter(item => ['validation_rule_unavailable', 'unmanaged_validation'].includes(item.code))),
    check('formulas', '后端公式与样例结果', issues.filter(item => ['formula_unavailable', 'formula_samples_missing', 'formula_sample_failed', 'formula_circular', 'formula_reference_missing'].includes(item.code))),
    check('metadata', '模板版本元数据', issues.filter(item => item.code === 'version_metadata_invalid')),
    check('reference_migration', '季度参考模板结构与公司页映射', issues.filter(item => ['reference_sheet_structure_invalid', 'reference_company_mapping_missing'].includes(item.code)))
  ];
  const report = { versionId: Number(versionId), status: issues.length ? 'blocked' : 'passed', passed: issues.length === 0,
    checkedAt: new Date().toISOString(), checks: groups, issues, rolePreview: rolePreview(workbook, 'subsidiary_filler') };
  return report;
}

module.exports = { validateTemplate, rolePreview, compileSubmissionManifest };

