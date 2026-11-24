export function createDefaultCode(functionName = 'MYFUNCTION', className = 'MyFunction') {
  return `class ${className} extends GC.Spread.CalcEngine.Functions.Function {
  constructor() {
    super(${JSON.stringify(functionName)}, 1, 1);
    this.typeName = ${JSON.stringify(`CustomFunctions.${className}`)};
  }

  evaluate(value) {
    // 在这里编写计算逻辑；参数数量按此方法的声明自动识别。
    return value;
  }

  toJSON() {
    return { typeName: this.typeName };
  }

  fromJSON(settings) {
    if (!settings) return;
    // 添加实例属性后，在这里恢复，并在 toJSON 中保存。
  }
}`
}

export function unusedFunctionTemplate(rules, ruleId) {
  const used = new Set()
  for (const row of rules) {
    if (ruleId && Number(row.ruleId) === Number(ruleId)) continue
    const expression = row.expression || {}
    for (const name of [expression.functionName, expression.className, expression.typeName,
      expression.sourceCode?.match(/\bclass\s+(\w+)\s+extends/)?.[1],
      expression.sourceCode?.match(/\bsuper\s*\(\s*["']([^"']+)["']/)?.[1]]) {
      if (name) used.add(name.toUpperCase())
    }
  }
  let suffix = ''
  for (let index = 2; used.has(`MYFUNCTION${suffix}`) || used.has(`CUSTOMFUNCTIONS.MYFUNCTION${suffix}`); index++) suffix = String(index)
  return createDefaultCode(`MYFUNCTION${suffix}`, `MyFunction${suffix}`)
}

export const defaultCode = createDefaultCode()
