const assert = require('node:assert/strict');

module.exports = async ({ request, token, bodyVersionId }) => {
  const sheets = ['edited', 'untouched'].map(code => ({ code, name: code, type: 'business', bodyVersionId }));
  const created = await request('/template-governance/templates', { method: 'POST', token, body: { name: '组合与详细设计混合验证', sheets } });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const route = `/template-governance/templates/versions/${created.payload.versionId}`;
  const read = async () => (await request(route, { token })).payload.template;
  const original = await read();
  const native = { name: 'edited', rowCount: 5, columnCount: 6, order: 0,
    data: { dataTable: { 0: { 0: { value: '手工修改保留', style: { backColor: '#ff0000' } } } } } };
  const secondNative = { name: 'untouched', rowCount: original.workbook.sheets[1].rowCount,
    columnCount: original.workbook.sheets[1].columnCount, order: 1 };
  const detailed = { code: 'edited', name: 'edited', type: 'business', inlineWorkbook: {
    rowCount: 5, columnCount: 6, cells: [{ row: 0, column: 0, value: '手工修改保留' }],
    metadata: { designerJson: native, mappings: [], nativeValidations: [], permissionTags: { rows: [{ row: 1, tag: { schemaVersion: 1, visibility: 'hidden' } }] } }
  } };
  const payload = { name: original.name, sheets: [detailed, sheets[1]],
    designerJson: { version: '19.2.0', names: [{ name: 'WorkbookName', formula: '1' }], sheets: { first: native, second: secondNative } },
    templateSnapshot: { version: '19.2.0', sheets: { first: native, second: secondNative } } };
  const save = async body => request(route, { method: 'PUT', token, body });
  assert.equal((await save(payload)).response.status, 200);
  let detail = await read();
  assert.equal(detail.manifest.designMode, 'composed', 'composed template keeps its composition entry');
  assert.equal(detail.sheets[0].body_component_version_id, null);
  assert.equal(detail.sheets[1].body_component_version_id, bodyVersionId, 'untouched sheet keeps component reference');
  assert.equal(detail.workbook.sheets[0].cells[0].value, '手工修改保留');
  assert.equal((await save({ name: original.name, sheets })).response.status, 400, 'cannot overwrite detailed sheet with components');
  assert.equal((await save({ ...payload, sheets: [{ ...detailed, bodyVersionId }, sheets[1]] })).response.status, 400);
  assert.equal((await save({ ...payload, designerJson: null, templateSnapshot: null })).response.status, 200);
  detail = await read();
  assert.equal(detail.workbook.designerJson, undefined, 'stale full cache cleared after composition edit');
  assert.deepEqual(detail.workbook.designerSettings.names, payload.designerJson.names, 'workbook-level names preserved');
  assert.equal(detail.workbook.sheets[0].designerJson.data.dataTable[0][0].style.backColor, '#ff0000');
  assert.equal(detail.workbook.sheets[0].rowTags[0].row, 1);
  console.log('Composed detail passed: per-sheet detach, preserve composition, style and permissions, overwrite protection, cache invalidation.');
};
