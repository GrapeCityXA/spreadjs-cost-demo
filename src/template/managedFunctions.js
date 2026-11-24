import GC from '@grapecity-software/spread-sheets'
import { managedFunctionApi } from '@/api'

const copy = value => JSON.parse(JSON.stringify(value))
const constructors = new Map(), pending = new Map()

async function prepareFunctions(refs) {
  const missing = [...new Set(refs.map(ref => Number(ref.versionId)))].filter(id => !constructors.has(id) && !pending.has(id))
  for (let offset = 0; offset < missing.length; offset += 100) {
    const ids = missing.slice(offset, offset + 100)
    const request = managedFunctionApi.definitions(ids).then(({ definitions }) => {
      for (const id of ids) {
        const definition = definitions.find(item => item.id === id)
        if (!definition) throw new Error(`已发布函数版本 ${id} 不存在`)
        installFunction(definition)
      }
    }).finally(() => ids.forEach(id => pending.delete(id)))
    ids.forEach(id => pending.set(id, request))
  }
  await Promise.all(refs.map(ref => pending.get(Number(ref.versionId))).filter(Boolean))
}

function installFunction(definition) {
  const versionId = definition.id
  // The source comes exclusively from the authenticated published-only endpoint.
  // Never evaluate source embedded in template JSON or an unpublished draft.
  const className = definition.className || 'MyFunction'
  if (!/^[A-Za-z_$][\w$]*$/.test(className)) throw new Error('已发布函数 class 名无效')
  const Constructor = new Function('GC', '"use strict";\n' + definition.sourceCode + '\n;return ' + className + ';')(GC)
  class ManagedFunction extends GC.Spread.CalcEngine.Functions.Function {
    constructor() {
      super(definition.functionName, definition.minArgs, definition.maxArgs)
      this.typeName = `CostReport.Function_${versionId}`
      this.versionId = versionId
      this.implementation = new Constructor()
      if (!(this.implementation instanceof GC.Spread.CalcEngine.Functions.Function)) throw new Error('已发布函数类型无效')
      this.fromJSON(functionDescriptor({ versionId, expression: definition }))
    }
    fromJSON(settings) {
      if (settings.versionId !== versionId || settings.typeName !== this.typeName || settings.name !== definition.functionName
        || settings.instanceState?.typeName !== definition.typeName) throw new Error('自定义函数版本标识不匹配')
      this.implementation.fromJSON(copy(settings.instanceState))
    }
    toJSON() {
      return { ...functionDescriptor({ versionId, expression: definition }), instanceState: copy(this.implementation.toJSON()) }
    }
    acceptsArray(index) { return Boolean(this.implementation.acceptsArray(index)) }
    acceptsError(...args) { return Boolean(this.implementation.acceptsError(...args)) }
    acceptsMissingArgument(index) { return Boolean(definition.parameters?.[index]?.optional || this.implementation.acceptsMissingArgument(index)) }
    description() { return this.implementation.description() }
    isVolatile() { return Boolean(this.implementation?.isVolatile()) }
    evaluate(...args) {
      try {
        const result = this.implementation.evaluate(...args)
        if (result?.then) throw new Error('已发布函数必须同步返回结果')
        return result
      } catch { return new GC.Spread.CalcEngine.CalcError('#VALUE!') }
    }
  }
  constructors.set(versionId, ManagedFunction)
}

export function managedType(versionId) {
  const Constructor = constructors.get(Number(versionId))
  if (!Constructor) throw new Error(`请先加载已发布函数版本 ${versionId}`)
  return Constructor
}

// JSON restores version-pinned instances after published definitions preload.
const originalResolver = GC.Spread.Sheets.getTypeFromString
GC.Spread.Sheets.getTypeFromString = function (typeName) {
  const match = /^CostReport\.Function_(\d+)$/.exec(typeName)
  return match ? managedType(Number(match[1])) : originalResolver.apply(this, arguments)
}

export function functionDescriptor(rule) {
  const definition = rule.expression
  return { typeName: `CostReport.Function_${rule.versionId}`, versionId: Number(rule.versionId),
    name: definition.functionName, minArgs: definition.minArgs, maxArgs: definition.maxArgs,
    acceptsArray: definition.acceptsArray, acceptsMissing: definition.acceptsMissing,
    sourceTypeName: definition.typeName, instanceState: copy(definition.instanceState) }
}
export function collectFunctionRefs(source) {
  const found = new Map()
  function visit(value) {
    if (!value || typeof value !== 'object') return
    if (/^CostReport\.Function_\d+$/.test(value.typeName || '')) found.set(value.versionId, value)
    for (const child of Object.values(value)) visit(child)
  }
  visit(source); return [...found.values()]
}
export async function registerTemplateFunctions(workbook, source) {
  const refs = collectFunctionRefs(source), names = new Map()
  await prepareFunctions(refs)
  for (const descriptor of refs) {
    if (names.has(descriptor.name) && names.get(descriptor.name) !== descriptor.versionId) throw new Error(`模板中 ${descriptor.name} 存在多个版本，请统一版本后使用`)
    names.set(descriptor.name, descriptor.versionId)
    const instance = new (managedType(descriptor.versionId))()
    instance.fromJSON(descriptor); workbook.addCustomFunction(instance)
  }
}

export async function prepareTemplateFunctions(source) {
  await prepareFunctions(collectFunctionRefs(source))
}
