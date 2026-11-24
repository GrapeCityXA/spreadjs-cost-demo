// View position and selection are not template edits. Keep all content, formatting,
// formulas, binding paths and permissions in the comparison, including empty cells.
const viewKeys = new Set(['activeRow', 'activeCol', 'selections', 'selection', 'scrollTop', 'scrollLeft',
  'topRow', 'leftCol', 'leftColumn', 'viewportTopRow', 'viewportLeftColumn', 'zoomFactor',
  'isSelected', 'topCellIndex', 'leftCellIndex'])
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]))
  return value
}
export function sheetDesignFingerprint(native, mappings = [], nativeValidations = []) {
  const structure = Object.fromEntries(Object.entries(native).filter(([key]) => !viewKeys.has(key) && key !== 'order' && key !== 'index'))
  // SpreadJS lazily serializes its default header font after the first paint.
  // An omitted default and an explicit Body theme font have identical meaning.
  for (const area of ['rowHeaderData', 'colHeaderData']) {
    if (!structure[area]) continue
    const header = { ...structure[area] }
    if (JSON.stringify(stable(header.defaultDataNode)) === '{"style":{"themeFont":"Body"}}') delete header.defaultDataNode
    if (Object.keys(header).length) structure[area] = header
    else delete structure[area]
  }
  return JSON.stringify(stable({ structure, mappings: mappings.map(({ issue, ruleCodesText, ...mapping }) => mapping), nativeValidations }))
}

export function templateSheetPayload(definition) {
  return { code: definition.sheet_code, name: definition.display_name, type: definition.sheet_type,
    headerVersionId: definition.header_component_version_id, bodyVersionId: definition.body_component_version_id,
    footerVersionId: definition.footer_component_version_id, permissionTag: definition.auxiliary?.permissionTag || null,
    ...(definition.auxiliary?.inlineWorkbook ? { inlineWorkbook: definition.auxiliary.inlineWorkbook } : {}),
    ...(definition.sheet_type === 'auxiliary' ? { auxiliary: definition.auxiliary } : {}) }
}
