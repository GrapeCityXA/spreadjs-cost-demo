const assert = require('node:assert/strict');

module.exports = async function ({ request, db, designerToken, reviewerToken, field }) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const tag = { schemaVersion: 1, platform: 'cost-report-cell-permission-v1', permission: 'primary_input', visibility: 'visible', editableForRoles: ['subsidiary_filler'] };
  const mapping = { id: 'direct-revenue', fieldDefinitionId: field.id, fieldVersion: field.version, fieldCode: field.code,
    bindingPath: field.code, namedArea: `INPUT_${field.code}`, kind: 'input', row: 1, col: 1, rowCount: 1, colCount: 1,
    primary: true, permission: 'primary_input', visibility: 'visible' };
  const native = { name: '直接设计', rowCount: 20, columnCount: 8, order: 0,
    data: { dataTable: { 1: { 1: { bindingPath: field.code, tag: JSON.stringify(tag) } } } } };
  const sheet = { code: 'direct_sheet', name: native.name, type: 'business', inlineWorkbook: {
    rowCount: 20, columnCount: 8, cells: [{ row: 1, column: 1, bindingPath: field.code, tag }],
    metadata: { designerJson: native, mappings: [mapping], nativeValidations: [], permissionTags: {} }
  } };
  const second = { code: 'summary_sheet', name: '汇总', type: 'business', inlineWorkbook: {
    rowCount: 10, columnCount: 5, cells: [{ row: 0, column: 0, formula: "'直接设计'!B2" }],
    metadata: { designerJson: { name: '汇总', order: 1, rowCount: 10, columnCount: 5,
      data: { dataTable: { 0: { 0: { formula: "'直接设计'!B2" } } } } }, mappings: [], nativeValidations: [], permissionTags: {} }
  } };
  const body = { name: '无需组件的完整模板', factory: 'ALL', sheets: [sheet, second],
    designerJson: { version: '19.2.0', sheets: { first: native, second: second.inlineWorkbook.metadata.designerJson } } };
  body.templateSnapshot = { version: '19.2.0', sheets: { first: native, second: second.inlineWorkbook.metadata.designerJson } };
  const componentCount = async () => (await db._helpers.get(db, 'SELECT COUNT(*) count FROM template_components')).count;
  const before = await componentCount();
  const create = async payload => request('/template-governance/templates', { method: 'POST', token: designerToken, body: payload });
  const noSource = clone(body); delete noSource.designerJson;
  assert.equal((await create(noSource)).response.status, 400, 'direct sheets require a full workbook');
  const bound = clone(body); bound.designerJson.dataSource = { sensitive: 100 };
  assert.equal((await create(bound)).response.status, 400, 'template cannot embed a business data source');
  const invalid = clone(body); invalid.designerJson.sheets.first.name = 'mismatch';
  assert.equal((await create(invalid)).response.status, 400, 'sheet names must match');
  const created = await create(body);
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const { versionId, templateId } = created.payload;
  const route = `/template-governance/templates/versions/${versionId}`;
  const get = () => request(route, { token: designerToken });
  let detail = (await get()).payload.template;
  assert.equal(detail.manifest.designMode, 'direct');
  assert.equal(detail.sheets[0].body_component_version_id, null);
  assert.equal(detail.workbook.sheets[0].mappings[0].sheet, 'direct_sheet');
  assert.equal(detail.workbook.sheets[1].cells[0].formula, "'直接设计'!B2");
  assert.equal(detail.workbook.designerJson.sheets.first.name, '直接设计');
  assert.equal(await componentCount(), before, 'no hidden component is created');
  const updated = await request(route, { method: 'PUT', token: designerToken, body: { ...body, name: '独立模板第二次保存' } });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal((await get()).payload.template.manifest.name, '独立模板第二次保存');
  const nativeValidation = clone(body);
  nativeValidation.sheets[0].inlineWorkbook.metadata.nativeValidations = [{ row: 2, col: 2, cell: 'C3' }];
  await request(route, { method: 'PUT', token: designerToken, body: nativeValidation });
  let checks = await request(`${route}/publication-checks`, { token: designerToken });
  assert.equal(checks.payload.report.passed, true, 'native validators are governed by template publication without duplicate registration');
  await request(route, { method: 'PUT', token: designerToken, body });
  checks = await request(`${route}/publication-checks`, { token: designerToken });
  assert.equal(checks.payload.report.passed, true, JSON.stringify(checks.payload));
  const lifecycle = `/template-governance/templates/${templateId}/versions/${versionId}`;
  assert.equal((await request(`${lifecycle}/submit`, { method: 'POST', token: designerToken, body: {} })).response.status, 200);
  assert.equal((await request(`${lifecycle}/review`, { method: 'POST', token: designerToken, body: { action: 'approve' } })).response.status, 403);
  assert.equal((await request(`${lifecycle}/review`, { method: 'POST', token: reviewerToken, body: { action: 'approve' } })).response.status, 200);
  detail = (await get()).payload.template;
  assert.equal(detail.status, 'published');
  assert.equal(detail.manifest.permissionIndex.sheets.length, 2);
  assert.equal((await request(route, { method: 'PUT', token: designerToken, body })).response.status, 409);
  const next = await request(`/template-governance/templates/${templateId}/versions`, {
    method: 'POST', token: designerToken, body: { fromVersionId: versionId } });
  assert.equal(next.response.status, 201, JSON.stringify(next.payload));
  const nextDetail = (await request(`/template-governance/templates/versions/${next.payload.versionId}`, { token: designerToken })).payload.template;
  assert.equal(nextDetail.status, 'draft');
  assert.deepEqual(nextDetail.workbook.designerJson, detail.workbook.designerJson);
  assert.equal(await componentCount(), before);
  console.log('Direct template lifecycle passed: standalone multi-sheet draft, field binding, governance, publish, immutable version and clone.');
};
