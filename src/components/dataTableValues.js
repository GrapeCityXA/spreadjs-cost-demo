const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const decimal = /^[+-]?\d+(?:\.\d+)?$/

export function columnValue(row, property) {
  return property?.split('.').reduce((value, key) => value?.[key], row)
}

export function valueText(value) {
  if (value === null || value === undefined || value === '') return '（空白）'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}

export function valueKey(value) {
  return value === null || value === undefined || value === '' ? 'empty:' : `${typeof value}:${String(value)}`
}

// Compare decimal strings without rounding financial values through Number.
export function compareValues(a, b) {
  if (valueKey(a) === valueKey(b)) return 0
  if (valueKey(a) === 'empty:') return 1
  if (valueKey(b) === 'empty:') return -1
  const left = String(a), right = String(b)
  if (decimal.test(left) && decimal.test(right)) {
    const scale = Math.max(left.split('.')[1]?.length || 0, right.split('.')[1]?.length || 0)
    const scaled = value => {
      const [whole, fraction = ''] = value.split('.')
      return BigInt(whole + fraction.padEnd(scale, '0'))
    }
    const x = scaled(left), y = scaled(right)
    return x < y ? -1 : x > y ? 1 : 0
  }
  return collator.compare(left, right)
}

export function columnFilters(rows, readValue) {
  const values = new Map()
  for (const row of rows) {
    const value = readValue(row)
    values.set(valueKey(value), value)
  }
  return [...values.entries()].sort((a, b) => compareValues(a[1], b[1]))
    .map(([value, raw]) => ({ value, text: valueText(raw) }))
}
