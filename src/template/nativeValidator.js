import GC from '@grapecity-software/spread-sheets'
import '@/utils/spreadjsLicense'

export const isNativeRule = expression => expression?.engine === 'spreadjs-validator'
export const validatorTypes = [{ value: 'number', label: '小数' }, { value: 'integer', label: '整数' }, { value: 'date', label: '日期' }, { value: 'textLength', label: '文本长度' }, { value: 'list', label: '下拉列表' }, { value: 'formulaList', label: '引用区域列表' }, { value: 'formula', label: '自定义公式' }]
export const comparisons = [{ value: 6, label: '介于' }, { value: 7, label: '不介于' }, { value: 0, label: '等于' }, { value: 1, label: '不等于' }, { value: 2, label: '大于' }, { value: 3, label: '大于或等于' }, { value: 4, label: '小于' }, { value: 5, label: '小于或等于' }]
export const defaultValidatorConfig = () => ({ type: 'number', operator: 3, value1: '0', value2: '100', list: '是,否', formula: 'A1>=0', ignoreBlank: true, dropdown: true, showInput: true, inputTitle: '填写提示', inputMessage: '', showError: true, errorTitle: '填写不符合要求', errorMessage: '请检查输入值', errorStyle: 0, highlight: 'circle', color: '#cf4c42' })

export function createValidator(config) {
  const c = { ...defaultValidatorConfig(), ...config }, d = GC.Spread.Sheets.DataValidation
  const bounded = ['number', 'integer', 'date', 'textLength'].includes(c.type)
  const parse = value => {
    if (String(value).trim().startsWith('=')) return String(value).trim()
    if (String(value).trim() === '') throw new Error('请填写比较值')
    if (c.type === 'date') { const date = new Date(`${value}T00:00:00`); if (!Number.isFinite(date.getTime())) throw new Error('请输入有效日期'); return date }
    const n = Number(value); if (!Number.isFinite(n)) throw new Error('比较值必须是数字或以 = 开头的单元格引用')
    if (['integer', 'textLength'].includes(c.type) && !Number.isInteger(n)) throw new Error('比较值必须为整数')
    return n
  }
  const v1 = bounded ? parse(c.value1) : null, v2 = bounded && [6, 7].includes(c.operator) ? parse(c.value2) : undefined
  if (v2 !== undefined && typeof v1 !== 'string' && typeof v2 !== 'string' && v1 > v2) throw new Error('下限不能大于上限')
  let validator
  if (c.type === 'number' || c.type === 'integer') validator = d.createNumberValidator(c.operator, v1, v2, c.type === 'integer')
  else if (c.type === 'date') validator = d.createDateValidator(c.operator, v1, v2)
  else if (c.type === 'textLength') validator = d.createTextLengthValidator(c.operator, v1, v2)
  else if (c.type === 'list') {
    const list = String(c.list).split(/[,，\n]/).map(s => s.trim()).filter(Boolean).join(',')
    if (!list) throw new Error('至少填写一个列表选项')
    validator = d.createListValidator(list)
  } else {
    if (!String(c.formula).trim()) throw new Error('请填写公式或引用区域')
    validator = c.type === 'formulaList' ? d.createFormulaListValidator(c.formula) : d.createFormulaValidator(c.formula)
  }
  validator.ignoreBlank(c.ignoreBlank); validator.inCellDropdown(c.dropdown)
  validator.showInputMessage(c.showInput); validator.inputTitle(c.inputTitle); validator.inputMessage(c.inputMessage)
  validator.showErrorMessage(c.showError); validator.errorTitle(c.errorTitle); validator.errorMessage(c.errorMessage); validator.errorStyle(c.errorStyle)
  validator.highlightStyle({ type: c.highlight === 'dogEar' ? d.HighlightType.dogEar : d.HighlightType.circle, color: c.color, ...(c.highlight === 'dogEar' ? { position: d.HighlightPosition.topRight } : {}) })
  return validator
}
export function restoreValidator(expression) {
  if (!isNativeRule(expression)) throw new Error('请选择单元格数据校验规则')
  const validator = new GC.Spread.Sheets.DataValidation.DefaultDataValidator()
  validator.fromJSON(JSON.parse(JSON.stringify(expression.validator)))
  return validator
}
export function serializeValidator(config) { return { engine: 'spreadjs-validator', version: 1, config: { ...config }, validator: createValidator(config).toJSON() } }
export function testNativeRule(expression, cases) {
  const book = new GC.Spread.Sheets.Workbook(document.createElement('div'), { sheetCount: 1 })
  try {
    const sheet = book.getSheet(0); sheet.setRowCount(20); sheet.setColumnCount(10)
    return cases.map(test => {
      try {
        sheet.setArray(0, 0, Array.from({ length: 20 }, () => Array(10).fill(null)))
        if (test.input.cells) sheet.setArray(0, 0, test.input.cells)
        let value = test.input.value
        if (expression.config.type === 'date' && value) value = new Date(`${value}T00:00:00`)
        sheet.setValue(0, 0, value)
        const validator = restoreValidator(expression)
        sheet.setDataValidator(0, 0, validator)
        const actual = validator.isValid(sheet, 0, 0, value)
        return { name: test.name, expected: test.expected, actual, passed: actual === test.expected }
      } catch (error) { return { name: test.name, expected: test.expected, passed: false, error: error.message } }
    })
  } finally { book.destroy() }
}

export function applyNativeRule(sheet, ranges, expression) {
  for (const range of ranges) {
    const row = Math.max(0, range.row), col = Math.max(0, range.col)
    sheet.setDataValidator(row, col, range.row < 0 ? sheet.getRowCount() : range.rowCount, range.col < 0 ? sheet.getColumnCount() : range.colCount, restoreValidator(expression))
  }
}

// Read the validators from the workbook itself; no field tags or catalog lookups.
export function validateNativeCells(book, canRead = () => true) {
  const errors = [], hints = []
  let checkedCount = 0, skippedCount = 0
  for (let s = 0; s < book.getSheetCount(); s++) {
    const sheet = book.getSheet(s)
    for (let row = 0; row < sheet.getRowCount(); row++) for (let col = 0; col < sheet.getColumnCount(); col++) {
      const validator = sheet.getDataValidator(row, col)
      if (!validator) continue
      if (!canRead(s, row, col)) { skippedCount++; continue }
      checkedCount++
      try {
        if (validator.isValid(sheet, row, col, sheet.getValue(row, col))) continue
        const message = `${sheet.name()} · R${row + 1}C${col + 1}：${validator.errorMessage() || '数据不符合校验条件'}`
        ;(validator.errorStyle() === 0 ? errors : hints).push({ code: 'native_validation', message, sheetName: sheet.name(), sheetIndex: s, row, col })
      } catch (error) { errors.push({ code: 'native_validation', sheetName: sheet.name(), row, col, message: `${sheet.name()} · R${row + 1}C${col + 1} 校验失败：${error.message}` }) }
    }
  }
  return { errors, hints, checkedCount, skippedCount }
}
