const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('../../tests/fixtures/direct-template-19.2.json');
const { validateInitialSnapshot } = require('../src/services/changeSetAuthorization');
const { compilePermissionIndex } = require('../src/services/permissionIndex');
const { directWorkbookJson, directTemplateSnapshot } = require('../src/services/directTemplate');

test('native direct template admits only its approved workbook layout and empty task data', () => {
  const workbook = fixture.workbook, index = compilePermissionIndex(workbook);
  const validate = snapshot => validateInitialSnapshot(snapshot, workbook, null, index);
  assert.equal(validate(fixture.initialSnapshot), null);
  const sheetId = Object.keys(fixture.initialSnapshot.sheets)[0];
  const changes = [
    snapshot => { snapshot.sheets[sheetId].data.dataTable[1][1].style.watermark = 'tampered'; },
    snapshot => { snapshot.sheets[sheetId].printInfo.paperSize.width = 1; },
    snapshot => { snapshot.sheets[sheetId].data.dataTable[1][1].tag = '{}'; },
    snapshot => { snapshot.sheets[sheetId].rowCount++; },
    snapshot => { snapshot.sheets[sheetId].data.dataTable[0] = { 0: { value: 'injected' } }; },
    snapshot => { snapshot.sheets[sheetId].data.dataTable[1][1].bindingPath = 'foreign_field'; },
    snapshot => { snapshot.docProps.docPropsCore.title = 'injected'; },
    snapshot => { Object.values(snapshot.dataManager.tables)[0].dataSourceOption.data[0].BROWSER_CURRENT_REVENUE = 99; }
  ];
  for (const change of changes) {
    const snapshot = structuredClone(fixture.initialSnapshot);
    change(snapshot);
    assert.ok(validate(snapshot), 'unpublished mutation must be rejected');
  }
});

test('direct native structure accepts the empty DataManager emitted by SpreadJS 19.2', () => {
  const workbook = structuredClone(fixture.workbook);
  const sheets = workbook.sheets.map(sheet => ({ name: sheet.name, inlineWorkbook: {
    rowCount: sheet.rowCount, columnCount: sheet.columnCount, metadata: {} }
  }));
  assert.ok(directWorkbookJson(workbook.designerJson, sheets));
  assert.ok(directTemplateSnapshot(workbook.templateSnapshot, sheets));
  assert.throws(() => directTemplateSnapshot(fixture.initialSnapshot, sheets), /数据源/);
});
