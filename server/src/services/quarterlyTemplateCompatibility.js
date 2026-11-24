// Keep the resource picker and activation guard on the same financial mapping rule.
function quarterlyTemplateCompatibility(workbook) {
  const conflicts = (workbook?.sheets || []).flatMap(sheet => (sheet.mappings || [])
    .filter(mapping => /profit|revenue|利润|营业收入|营收/i.test(
      `${mapping.fieldCode || ''} ${mapping.displayName || ''} ${mapping.label || ''}`)
      && mapping.primary === true && mapping.permission === 'primary_input')
    .map(mapping => ({ sheetName: sheet.name || sheet.code,
      fieldName: mapping.displayName || mapping.label || mapping.fieldCode,
      namedArea: mapping.namedArea })));
  return { compatible: conflicts.length === 0, conflicts,
    message: conflicts.length ? '季度营收与利润必须从已定稿月报派生，当前模板仍允许直接填报。请换用财务区域只读的已发布模板，或由模板管理员创建新版本修正权限并发布后再选择。' : '' };
}

module.exports = { quarterlyTemplateCompatibility };
