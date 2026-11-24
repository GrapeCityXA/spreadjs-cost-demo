const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { normalizedTag, compilePermissionIndex, permissionAt, parseTag, validatePermissionConfiguration } = require('../src/services/permissionIndex');
const policy = require('../src/services/permissionPolicy');
const options = { users: [
  { id: 1, name: '张三', departments: ['FIN'], roleScopes: [{ code: 'filler', organizationId: null }] },
  { id: 2, name: '李四', departments: ['HR'], roleScopes: [{ code: 'filler', organizationId: null }] },
  { id: 3, name: '王五', departments: ['FIN'], roleScopes: [{ code: 'reviewer', organizationId: null }] }
], roles: [{ code: 'filler' }, { code: 'reviewer' }], departments: [{ code: 'FIN' }, { code: 'HR' }] };
const grant = (dimension, values, rest = {}) => ({ permissionModel: 2, allVisible: true, permission: 'primary_input',
  editDimension: dimension, [policy.editKeys[dimension]]: values, ...rest });
const sheet = additions => ({ name: '测试表', code: 'main', rowCount: 4, columnCount: 4, cells: [], mappings: [], ...additions });
const entry = (rule, label = '单元格', dimensions = {}) => ({ rule, row: 0, col: 0, rowCount: 1, colCount: 1, label, ...dimensions });
const validate = (...entries) => policy.validateEntries(entries, options);

test('user and department editing work on every scope and match the frontend decision', async () => {
  const { cellPermission } = await import(pathToFileURL(path.resolve(__dirname, '../../src/template/permissionView.js')));
  for (const [dimension, values] of [['user', [1]], ['department', ['FIN']], ['role', ['filler']]]) {
    for (const scope of ['sheet', 'row', 'column', 'cell']) {
      const tag = normalizedTag({ ...grant(dimension, values), platform: 'cost-report-cell-permission-v1' });
      const source = sheet(scope === 'sheet' ? { tag } : scope === 'row' ? { rowTags: [{ row: 0, tag }] }
        : scope === 'column' ? { columnTags: [{ col: 0, tag }] } : { cells: [{ row: 0, column: 0, tag }] });
      const compiled = compilePermissionIndex({ sheets: [source] }).sheets[0];
      for (const user of options.users) {
        const identity = policy.identitiesFor(user)[0];
        assert.deepEqual(cellPermission(compiled, 0, 0, identity), permissionAt(compiled, 0, 0, identity));
        assert.equal(permissionAt(compiled, 0, 0, identity).editable, policy.editAllows(grant(dimension, values), identity));
      }
    }
  }
});
test('a user grant on a mapped input never defaults to granting the filler role', () => {
  const mapping = { ...grant('user', [1]), row: 0, col: 0, rowCount: 1, colCount: 1, kind: 'input', primary: true };
  const compiled = compilePermissionIndex({ sheets: [sheet({ mappings: [mapping] })] }).sheets[0];
  assert.equal(permissionAt(compiled, 0, 0, { userId: 1, roles: [], departments: [] }).editable, true);
  assert.equal(permissionAt(compiled, 0, 0, { userId: 2, roles: ['subsidiary_filler'], departments: [] }).editable, false);
});
test('editing can never bypass invisible, masked, read-only or calculated regions', () => {
  for (const restriction of [{ visibility: 'hidden' }, { visibility: 'masked' }, { permission: 'read_only' },
    { allVisible: false, dimension: 'user', visibleUsers: [2], excludedVisibility: 'masked' }]) {
    const compiled = compilePermissionIndex({ sheets: [sheet({ tag: normalizedTag(grant('user', [1])),
      cells: [{ row: 0, column: 0, tag: normalizedTag(restriction) }, { row: 0, column: 1, formula: '=1+1' }] })] }).sheets[0];
    for (const col of [0, 1]) assert.equal(permissionAt(compiled, 0, col, { userId: 1, roles: [], departments: [] }).editable, false);
  }
});
test('same-type conflicts and empty edit lists are rejected', () => {
  for (const [dimension, editors, viewers] of [['user', [1, 2], [1]], ['role', ['filler'], ['reviewer']], ['department', ['HR'], ['FIN']]])
    assert.match(validate(entry(grant(dimension, editors, { allVisible: false, dimension, [policy.viewKeys[dimension]]: viewers }))), /必须全部包含/);
  assert.match(validate(entry(grant('user', []))), /至少一个可编辑/);
});
test('cross-type configuration verifies real members and their role scopes', () => {
  const view = { allVisible: false, dimension: 'department', visibleDepartments: ['FIN'] };
  assert.equal(validate(entry(grant('user', [1], view))), '');
  assert.match(validate(entry(grant('user', [2], view))), /李四.*不可查看/);
  assert.match(validate(entry(grant('role', ['filler'], view))), /李四/);
  assert.deepEqual(policy.identitiesFor({ id: 9, roleScopes: [{ code: 'a', organizationId: 1 }, { code: 'b', organizationId: 2 }] }).map(i => i.roles), [[], ['a'], ['b']]);
});
test('parent and child visibility conflicts include the source of the restriction', () => {
  const parent = entry({ allVisible: false, dimension: 'user', visibleUsers: [2] }, '表级权限', { rowCount: 4, colCount: 4 });
  assert.match(validate(parent, entry(grant('user', [1]))), /单元格 与 表级权限 冲突/);
  assert.match(validate(entry(grant('user', [1]), '表级权限', { rowCount: 4, colCount: 4 }), entry({ permission: 'read_only' }, '第 1 行')), /只读/);
  assert.equal(validate(parent, entry(grant('user', [1]), '另一行', { row: 5 })), '');
});
test('switching dimensions serializes only the selected editor audience', () => {
  const form = policy.ruleToForm(grant('role', ['filler']));
  form.editDimension = 'user'; form.editableForUsers = [1];
  assert.equal(policy.hasLegacy(form), false);
  const saved = policy.formToRule(form);
  assert.deepEqual(saved.editableForUsers, [1]); assert.equal(saved.editableForRoles, undefined);
  assert.equal(validate(entry(saved)), '');
});
test('legacy conversion keeps old restrictions visible until an explicit conservative conversion', () => {
  const old = { permission: 'primary_input', editableForRoles: ['filler'], denyEditForRoles: ['reviewer'], maskedForDepartments: ['HR'] };
  const form = policy.ruleToForm(old);
  assert.equal(policy.hasLegacy(form), true);
  const next = policy.convertLegacy(form, options.users, 'cell');
  assert.equal(policy.hasLegacy(next), false);
  assert.deepEqual(next.visibleUsers, [1, 3]);
  assert.deepEqual(next.editableForUsers, [1]);
  assert.equal(validate(entry(policy.formToRule(next))), '');
});
test('invalid user identifiers and forged conflicts fail backend validation', () => {
  for (const users of [['1'], [-1], [0], [1.5], '1']) assert.throws(() => parseTag(normalizedTag({ editableForUsers: users }), '测试'), /人员/);
  assert.throws(() => validatePermissionConfiguration({ sheets: [sheet({ tag: normalizedTag(grant('user', [1])),
    rowTags: [{ row: 0, tag: normalizedTag({ allVisible: false, dimension: 'user', visibleUsers: [2] }) }] })] }, options), /冲突/);
});
test('frontend and backend share the exact same configuration validation policy', async () => {
  const fs = require('node:fs');
  const backend = fs.readFileSync(path.resolve(__dirname, '../src/services/permissionPolicy.js'), 'utf8');
  const frontend = fs.readFileSync(path.resolve(__dirname, '../../src/template/permissionPolicy.js'), 'utf8');
  assert.equal(frontend, backend.replace('module.exports =', 'export'));
});

