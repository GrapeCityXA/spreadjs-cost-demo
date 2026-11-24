// Kept identical to the frontend policy (apart from its module export).
const editKeys = { user: 'editableForUsers', role: 'editableForRoles', department: 'editableForDepartments' };
const viewKeys = { user: 'visibleUsers', role: 'visibleRoles', department: 'visibleDepartments' };
const legacyKeys = ['visibility', 'hiddenForRoles', 'maskedForRoles', 'denyEditForRoles',
  'hiddenForDepartments', 'maskedForDepartments', 'denyEditForDepartments'];
const has = (list, values) => (list || []).some(value => (values || []).includes(value));
const userMatches = (list, identity) => (list || []).some(id => Number(id) === Number(identity.userId));
function editAllows(rule, identity) {
  return userMatches(rule.editableForUsers, identity) || has(rule.editableForRoles, identity.roles)
    || has(rule.editableForDepartments, identity.departments);
}
function canView(rule, identity) {
  if (['hidden', 'masked'].includes(rule.visibility) || has(rule.hiddenForRoles, identity.roles)
    || has(rule.maskedForRoles, identity.roles) || has(rule.hiddenForDepartments, identity.departments)
    || has(rule.maskedForDepartments, identity.departments)) return false;
  if (rule.allVisible !== false) return true;
  if (rule.dimension === 'user') return userMatches(rule.visibleUsers, identity);
  return has(rule[viewKeys[rule.dimension]], rule.dimension === 'role' ? identity.roles : identity.departments);
}
function identitiesFor(user) {
  // Check each role scope independently: roles in different organizations must not be combined.
  const scopes = user.roleScopes || [];
  return [...new Set([null, ...scopes.map(role => role.organizationId)])].map(scope => ({
    userId: user.id, roles: scopes.filter(role => role.organizationId == null || role.organizationId === scope).map(role => role.code),
    departments: user.departments || []
  }));
}
function hasLegacy(rule) {
  return Boolean(rule.legacyPermission) || legacyKeys.some(key => key === 'visibility' ? ['hidden', 'masked'].includes(rule[key]) : rule[key]?.length)
    || (!rule.editDimension && Object.values(editKeys).filter(key => rule[key]?.length).length > 1);
}
function ruleToForm(rule = {}, scope = 'cell') {
  return { ...rule, legacyPermission: hasLegacy(rule), viewMode: rule.allVisible === false
    ? ((rule[viewKeys[rule.dimension]] || []).length ? rule.dimension : 'none') : 'all',
    permission: rule.permission || 'inherit',
    editDimension: rule.editDimension || Object.keys(editKeys).find(key => rule[editKeys[key]]?.length) || 'role',
    visibleUsers: rule.visibleUsers || [], visibleRoles: rule.visibleRoles || [], visibleDepartments: rule.visibleDepartments || [],
    editableForUsers: rule.editableForUsers || [], editableForRoles: rule.editableForRoles || [], editableForDepartments: rule.editableForDepartments || [],
    excludedVisibility: rule.excludedVisibility || (scope === 'cell' ? 'masked' : 'hidden') };
}
function formToRule(form) {
  const rule = { permissionModel: 2, allVisible: form.viewMode === 'all',
    dimension: ['user', 'role', 'department'].includes(form.viewMode) ? form.viewMode : 'user',
    excludedVisibility: form.excludedVisibility || 'hidden' };
  if (!rule.allVisible) rule[viewKeys[rule.dimension]] = form.viewMode === 'none' ? [] : [...(form[viewKeys[rule.dimension]] || [])];
  if (form.permission !== 'inherit') rule.permission = form.permission;
  if (form.permission === 'primary_input') {
    rule.editDimension = form.editDimension;
    rule[editKeys[form.editDimension]] = [...(form[editKeys[form.editDimension]] || [])];
  }
  return rule;
}
function convertLegacy(rule, users, scope) {
  // Freeze to current people conservatively. This is explicit because future memberships won't be included.
  const viewers = users.filter(user => identitiesFor(user).every(identity => canView(rule, identity)));
  const editors = viewers.filter(user => identitiesFor(user).every(identity => editAllows(rule, identity)
    && !has(rule.denyEditForRoles, identity.roles) && !has(rule.denyEditForDepartments, identity.departments)));
  const next = { ...rule };
  for (const key of ['legacyPermission', ...legacyKeys, ...Object.values(editKeys)]) delete next[key];
  return ruleToForm({ ...next, permissionModel: 2, allVisible: false, dimension: 'user', visibleUsers: viewers.map(user => user.id),
    permission: rule.permission === 'primary_input' ? (editors.length ? 'primary_input' : 'read_only') : (rule.permission === 'system' ? 'system' : 'read_only'),
    editDimension: 'user', ...(rule.permission === 'primary_input' && editors.length ? { editableForUsers: editors.map(user => user.id) } : {}) }, scope);
}
function validateRule(rule, options) {
  if (rule.permissionModel !== 2) return '';
  if (hasLegacy(rule)) return '请先转换旧版限制，再应用简化权限。';
  if (rule.permission && !['primary_input', 'read_only', 'system'].includes(rule.permission)) return '编辑方式无效。';
  if (rule.allVisible === false && !Object.hasOwn(viewKeys, rule.dimension)) return '请选择查看方式。';
  if (rule.permission === 'primary_input') {
    const key = editKeys[rule.editDimension];
    if (!key || !Array.isArray(rule[key]) || !rule[key].length) return '请选择至少一个可编辑对象。';
    if (Object.values(editKeys).some(other => other !== key && rule[other]?.length)) return '编辑对象只能使用一种选择方式。';
    if (rule.allVisible === false && !(rule[viewKeys[rule.dimension]] || []).length) return '不可查看的区域不能允许编辑。';
    if (rule.allVisible === false && rule.dimension === rule.editDimension
      && rule[key].some(value => !(rule[viewKeys[rule.dimension]] || []).includes(value))) return '可编辑对象必须全部包含在可查看对象中。';
  }
  if (options) {
    for (const [dimension, key] of Object.entries(viewKeys)) {
      const selected = rule.dimension === dimension && rule.allVisible === false ? rule[key] || [] : [];
      if (selected.some(value => !(options[dimension === 'user' ? 'users' : dimension === 'role' ? 'roles' : 'departments'] || [])
        .some(item => (dimension === 'user' ? item.id : item.code) === value))) return '查看名单含已停用或不存在的对象，请重新选择。';
    }
    for (const [dimension, key] of Object.entries(editKeys)) if ((rule[key] || []).some(value =>
      !(options[dimension === 'user' ? 'users' : dimension === 'role' ? 'roles' : 'departments'] || [])
        .some(item => (dimension === 'user' ? item.id : item.code) === value))) return '编辑名单含已停用或不存在的对象，请重新选择。';
  }
  return '';
}
const overlaps = (a, b) => a.row < b.row + b.rowCount && b.row < a.row + a.rowCount
  && a.col < b.col + b.colCount && b.col < a.col + a.colCount;
function validateEntries(entries, options, focus) {
  const relevant = entry => !focus || focus.some(area => overlaps(entry, area));
  for (const entry of entries.filter(relevant)) {
    const error = validateRule(entry.rule, options);
    if (error) return `${entry.label}：${error}`;
  }
  for (const grant of entries.filter(entry => relevant(entry) && entry.rule.permissionModel === 2 && entry.rule.permission === 'primary_input')) {
    const rule = grant.rule;
    for (const restriction of entries.filter(entry => overlaps(grant, entry))) {
      const other = restriction.rule;
      const prefix = `${grant.label} 与 ${restriction.label} 冲突：`;
      if (['read_only', 'system'].includes(other.permission)) return prefix + '该范围已设为只读，不能同时允许编辑。';
      if (['hidden', 'masked'].includes(other.visibility)) return prefix + '可编辑区域必须可见，不能隐藏或脱敏。';
      if (other.allVisible === false && !(other[viewKeys[other.dimension]] || []).length) return prefix + '可编辑对象没有查看权限。';
      if (other.allVisible === false && other.dimension === rule.editDimension
        && rule[editKeys[rule.editDimension]].some(value => !(other[viewKeys[other.dimension]] || []).includes(value)))
        return prefix + '可编辑对象超出了查看范围。';
      const candidates = (options?.users || []).flatMap(user => identitiesFor(user).filter(identity => editAllows(rule, identity)).map(identity => ({ user, identity })));
      for (const { user, identity } of candidates) {
        if (!canView(other, identity)) return prefix + `${user.name || user.username} 可编辑但不可查看，请调整查看或编辑范围。`;
        if (has(other.denyEditForRoles, identity.roles) || has(other.denyEditForDepartments, identity.departments))
          return prefix + `${user.name || user.username} 被旧版限制禁止编辑，请先转换对应层级的权限。`;
      }
      // An empty cross-dimension group gives no evidence that its members can view.
      if (other.allVisible === false && other.dimension !== rule.editDimension && !candidates.length)
        return prefix + '无法核验跨类型的查看和编辑范围，请使用相同选择方式，或指定可查看的人员。';
    }
  }
  return '';
}
function entriesForSheet(sheet) {
  const parse = raw => typeof raw === 'string' ? JSON.parse(raw) : raw;
  const entries = [];
  const add = (raw, row, col, rowCount, colCount, label) => { if (raw) entries.push({ rule: parse(raw), row, col, rowCount, colCount, label }); };
  add(sheet.tag, 0, 0, sheet.rowCount, sheet.columnCount, '表级权限');
  if (sheet.readOnly) add({ permission: 'read_only' }, 0, 0, sheet.rowCount, sheet.columnCount, '只读工作表');
  for (const item of sheet.rowTags || []) add(item.tag, item.row, 0, 1, sheet.columnCount, `第 ${item.row + 1} 行`);
  for (const item of sheet.columnTags || []) add(item.tag, 0, item.col, sheet.rowCount, 1, `第 ${item.col + 1} 列`);
  for (const cell of sheet.cells || []) add(cell.tag, cell.row, cell.column ?? cell.col, 1, 1, `R${cell.row + 1}C${(cell.column ?? cell.col) + 1}`);
  for (const mapping of sheet.mappings || []) if (mapping.permissionModel === 2)
    add(mapping, mapping.row, mapping.col, mapping.rowCount, mapping.colCount, `字段 ${mapping.fieldCode || mapping.namedArea || '输入区域'}`);
  return entries;
}
export { editKeys, viewKeys, legacyKeys, editAllows, canView, identitiesFor, hasLegacy, ruleToForm, formToRule, convertLegacy, validateRule, validateEntries, entriesForSheet };
