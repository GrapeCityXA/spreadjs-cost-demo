const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cost-binding-test-'));
process.env.COST_REPORT_DB_PATH = path.join(root, 'business.db');
process.env.COST_REPORT_COLLAB_DB_PATH = path.join(root, 'collaboration.db');
process.env.COST_REPORT_TEMPLATE_DIR = path.join(root, 'templates');
process.env.COST_REPORT_ARTIFACT_DIR = path.join(root, 'artifacts');
const fixture = require('../../tests/fixtures/binding-protocol-19.2.json');
const { authorizeChangeSet, validateInitialSnapshot } = require('../src/services/changeSetAuthorization');
const { compilePermissionIndex } = require('../src/services/permissionIndex');
const { readBoundValue, materializeBoundSnapshot } = require('../src/services/bindingSource');
const { extractBusinessValues } = require('../src/services/businessSubmission');
const { type } = require('@grapecity-software/spread-sheets-collaboration');
const clone = value => JSON.parse(JSON.stringify(value));
const mappings = ['REVENUE','COST'].map((code,i) => ({ id: code, kind: 'input', fieldDefinitionId:i+1, fieldCode:code,
  bindingPath:code, bindingVersion:2, row:i+1, col:1, rowCount:1, colCount:1, primary:true,
  permission:'primary_input', editableForRoles:['subsidiary_filler'] }));
const workbook = {sheets:[{code:'MAIN',name:'Sheet1', rowCount:8,columnCount:6,mappings,
  cells:mappings.map(m=>({row:m.row,column:m.col,bindingPath:m.bindingPath}))}]};
const index = compilePermissionIndex(workbook);
const actor = {id:1,roles:[{code:'subsidiary_filler',organizationId:1}]};
const sheet = snapshot => Object.values(snapshot.sheets)[0];

test('native 19.2 seed validates and bindings cannot be replaced or prefilled', () => {
  assert.equal(validateInitialSnapshot(fixture.before,workbook,null,index),null);
  const dirty=clone(fixture.before); Object.values(dirty.dataManager.tables)[0].dataSourceOption.data[0].REVENUE=999;
  assert.match(validateInitialSnapshot(dirty,workbook,null,index),/初始绑定数据/);
  const changed=clone(fixture.before);sheet(changed).data.dataTable[1][1].bindingPath='COST';
  assert.match(validateInitialSnapshot(changed,workbook,null,index),/绑定路径/);
  const remote=clone(fixture.before);Object.values(remote.dataManager.tables)[0].dataSourceOption.remote={read:{url:'http://invalid'}};
  assert.match(validateInitialSnapshot(remote,workbook,null,index),/数据源结构/);
});

test('native datasource operations replay and enforce permissions for every field', async () => {
  let state=clone(fixture.before);
  for(const change of fixture.changes) {
    assert.equal(authorizeChangeSet(change,state,index,actor,1),null);
    const fragments=type.createFragments(state);
    await type.applyFragments({getFragment:async id=>fragments[id],createFragment:(id,data)=>{fragments[id]=data;},updateFragment:(id,data)=>{fragments[id]=data;},deleteFragment:id=>{delete fragments[id];}},clone(change));
    state=type.composeFragments(fragments);
  }
  assert.equal(readBoundValue(state,sheet(state),'REVENUE'),100.25);
  assert.equal(readBoundValue(state,sheet(state),'COST'),20);
  const restricted=clone(index);restricted.sheets[0].editableRanges=restricted.sheets[0].editableRanges.slice(0,1);
  assert.match(authorizeChangeSet(fixture.changes[1],state,restricted,actor,1),/超出/);
  const malicious=clone(fixture.changes[0]);malicious.ops[0].payload.item.COST=888;
  assert.match(authorizeChangeSet(malicious,state,restricted,actor,1),/超出/);
  malicious.ops[0].payload.index=1;
  assert.match(authorizeChangeSet(malicious,state,index,actor,1),/格式无效/);
  assert.match(authorizeChangeSet(fixture.changes[0],state,index,{id:2,roles:[]},1),/超出/);
});

test('submission reads datasource rather than stale cells or named areas; export materializes values', () => {
  const snapshot=clone(fixture.after);sheet(snapshot).data.dataTable[1][1].value=999;
  const fields=new Map(mappings.map(m=>[m.fieldDefinitionId,{id:m.fieldDefinitionId,code:m.fieldCode,data_type:'decimal',precision:2}]));
  const manifest={submission:{version:1,sheets:[{code:'MAIN',name:'Sheet1',order:0,mappings}]}};
  const values=extractBusinessValues({manifest,workbook,snapshot,fields,actorId:1,collaborationVersion:3});
  assert.deepEqual(values.map(v=>v.typedValue.value),['100.25','20']);
  const exported=materializeBoundSnapshot(snapshot);
  assert.equal(sheet(exported).data.dataTable[1][1].value,100.25);
  assert.equal(exported.dataManager,undefined);
  assert.equal(sheet(exported).data.dataTable[1][1].bindingPath,undefined);
  assert.equal(readBoundValue(snapshot,sheet(snapshot),'REVENUE'),100.25);
});

test('an optional blank scalar binding is omitted instead of treated as an incomplete table row', () => {
  const snapshot=clone(fixture.after); Object.values(snapshot.dataManager.tables)[0].dataSourceOption.data[0].COST=null;
  const fields=new Map(mappings.map(m=>[m.fieldDefinitionId,{id:m.fieldDefinitionId,code:m.fieldCode,data_type:'decimal',precision:2}]));
  const manifest={submission:{version:1,sheets:[{code:'MAIN',name:'Sheet1',order:0,mappings}]}};
  const values=extractBusinessValues({manifest,workbook,snapshot,fields,actorId:1,collaborationVersion:3});
  assert.deepEqual(values.map(v=>v.typedValue.value),['100.25']);
});

test('withdrawal seeds retain bound data and reject a changed source value', () => {
  assert.equal(validateInitialSnapshot(fixture.after,workbook,fixture.after,index),null);
  const changed=clone(fixture.after);Object.values(changed.dataManager.tables)[0].dataSourceOption.data[0].REVENUE=11;
  assert.match(validateInitialSnapshot(changed,workbook,fixture.after,index),/源修订/);
});

test('published bound formulas accept calculated defaults and native cross-sheet reference spelling', () => {
  const snapshot = clone(fixture.before), contract = clone(workbook);
  const first = sheet(snapshot);
  const formula = { refs: { R0: { type: 0, sheetId: first.__ID__, row: 2, col: 1, flags: 6 } },
    parts: [{ ref: 'R0' }, { text: '+1' }] };
  first.data.dataTable[1][1].formulaInfo = formula;
  contract.sheets[0].cells[0].formula = 'Sheet1!B3+1';
  contract.designerJson = {};
  contract.templateSnapshot = clone(snapshot);
  const record = data => Object.values(data.dataManager.tables)[0].dataSourceOption.data[0];
  record(snapshot).REVENUE = 1;
  assert.equal(validateInitialSnapshot(snapshot, contract, null, index), null);
  const badCache = clone(snapshot); record(badCache).REVENUE = 999;
  assert.match(validateInitialSnapshot(badCache, contract, null, index), /初始绑定数据/);
  const badFormula = clone(snapshot);
  sheet(badFormula).data.dataTable[1][1].formulaInfo.parts[1].text = '+2';
  record(badFormula).REVENUE = 2;
  assert.match(validateInitialSnapshot(badFormula, contract, null, index), /未发布的公式/);
  const badInput = clone(snapshot); record(badInput).COST = 123; record(badInput).REVENUE = 124;
  assert.match(validateInitialSnapshot(badInput, contract, null, index), /初始绑定数据/);
  assert.equal(validateInitialSnapshot(snapshot, contract, snapshot, index), null);
});

test.after(async()=>{const db=require('../src/config/database');await db.ready;await new Promise(resolve=>db.close(resolve));await new Promise(resolve=>db.collaborationDb.close(resolve));});
