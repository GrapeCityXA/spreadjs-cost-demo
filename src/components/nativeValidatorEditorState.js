const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const copyValidatorData = value => JSON.parse(JSON.stringify(value))
const cellValue = value => value == null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))
export const validReferenceCells = cells => Array.isArray(cells) && cells.every(row => Array.isArray(row) && row.every(cellValue))

export function normalizeValidatorCases(testCases, existing) {
  const source = Array.isArray(testCases) && (existing || testCases.length) ? testCases : existing ? [] : [
    { name: '正常值', input: { value: 1 }, expected: true },
    { name: '异常值', input: { value: -1 }, expected: false }
  ]
  return source.map((item, index) => {
    const test = record(item) ? item : {}
    const input = record(test.input) ? test.input : {}
    const issues = {}
    if (!record(test.input) || !cellValue(input.value)) issues.value = '请核对并重新填写测试值；空白值可清空后保留。'
    if (input.cells != null && !validReferenceCells(input.cells)) issues.cells = '引用数据格式不正确。请删除此样例，或点击“替换全部样例的引用数据”（会覆盖所有样例）。'
    return {
      ...copyValidatorData(test), name: typeof test.name === 'string' ? test.name : `样例 ${index + 1}`,
      input: { ...copyValidatorData(input), value: cellValue(input.value) ? input.value ?? null : null },
      expected: typeof test.expected === 'boolean' ? test.expected : null,
      _key: index + 1, _issues: issues
    }
  })
}

export function exportValidatorCases(cases, cells) {
  return cases.map((test, index) => {
    const label = test.name.trim() || `样例 ${index + 1}`
    if (Object.keys(test._issues).length) throw new Error(`${label}：${Object.values(test._issues)[0]}`)
    if (typeof test.expected !== 'boolean') throw new Error(`${label}：请选择预期校验结果：符合条件或不符合条件。`)
    if (!test.name.trim()) throw new Error(`请填写第 ${index + 1} 个样例的名称。`)
    const { _key, _issues, ...saved } = test
    return copyValidatorData({ ...saved, input: { ...test.input, cells: test.input.cells ?? cells } })
  })
}

export function initialTypeCondition(type) {
  if (type === 'date') {
    const year = new Date().getFullYear()
    return { value1: `${year}-01-01`, value2: `${year}-12-31` }
  }
  return { value1: '0', value2: '100', formula: type === 'formulaList' ? '$B$1:$B$3' : 'A1>=0', list: '是,否' }
}
