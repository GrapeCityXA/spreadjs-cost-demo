<template>
  <div class="expression-node" :class="{ 'expression-node--root': depth === 0, 'expression-node--indent': depth < 3, 'expression-node--value': kind !== 'op' }">
    <div class="expression-controls">
      <el-select ref="kindInput" :model-value="kind" @change="setKind" :aria-label="`${nodeLabel}的表达式类型`">
        <el-option label="运算 / 条件" value="op" :disabled="depth >= 32" />
        <el-option label="业务字段" value="field" /><el-option label="参数" value="param" /><el-option label="固定值" value="const" />
      </el-select>
      <el-select v-if="kind === 'op'" :class="{ 'expression-control--invalid': Boolean(nodeError) }" :model-value="modelValue.op" @change="setOperation" filterable :aria-label="`${nodeLabel}的运算方式`" :aria-invalid="Boolean(nodeError)" :aria-describedby="nodeError ? errorId : undefined">
        <el-option v-for="(label, op) in operations" :key="op" :label="label" :value="op" />
      </el-select>
      <el-input v-else-if="kind === 'field' || kind === 'param'" :model-value="modelValue[kind]" maxlength="64" :aria-label="`${nodeLabel}的${kind === 'field' ? '字段编码' : '参数引用'}`" :aria-invalid="Boolean(nodeError)" :aria-describedby="nodeError ? errorId : undefined" @update:model-value="value => $emit('update:modelValue', { [kind]: value })" :placeholder="kind === 'field' ? '字段编码，如 REVENUE' : '参数名，如 threshold'" />
      <el-input v-else :model-value="draft" :aria-label="`${nodeLabel}的固定值`" :aria-invalid="Boolean(nodeError)" :aria-describedby="[`${errorId}-hint`, nodeError ? errorId : ''].filter(Boolean).join(' ')" @update:model-value="setConstant" placeholder="数字、文本、true、false 或 null" />
    </div>
    <p v-if="kind === 'const'" :id="`${errorId}-hint`" class="constant-hint">文本可加双引号，如 "01"；空值填 null，空文本填 ""。</p>
    <p v-if="nodeError" :id="errorId" class="reference-error" role="alert">{{ nodeError }}</p>
    <div v-if="pendingChange" class="change-confirmation">
      <p role="status">{{ changeMessage }}</p>
      <div class="expression-actions"><el-button type="primary" @click="confirmChange">确认更改</el-button><el-button @click="cancelChange">保留当前内容</el-button></div>
    </div>
    <div v-if="kind === 'op'" class="expression-children">
      <div v-for="(row, index) in rows" :key="row.id" class="expression-child" role="group" :aria-labelledby="`${labelPrefix}-${path}-${row.id}-heading`">
        <div class="expression-child-heading">
          <span :id="`${labelPrefix}-${path}-${row.id}-heading`">运算项 {{ path === 'root' ? index + 1 : `${path.slice(5).split('.').map(value => Number(value) + 1).join('.')}.${index + 1}` }}</span>
          <el-button v-if="variable" text type="danger" :disabled="args.length <= 1" @click="removeArgument(index)" :aria-label="`删除${nodeLabel}的第 ${index + 1} 个运算项`">删除</el-button>
        </div>
        <RuleExpressionEditor :ref="el => setChildRef(row.id, el)" :model-value="row.arg" :reference-errors="referenceErrors" :label-prefix="labelPrefix" :path="`${path}.${index}`" @update:model-value="value => setArgument(index, value)" @draft-change="$emit('draft-change')" />
      </div>
      <el-button v-if="variable || (modelValue.op === 'round' && args.length < 2)" class="expression-add" text :disabled="depth >= 32" @click="addArgument">添加条件 / 运算项</el-button>
    </div>
  </div>
</template>

<script>
import { parseBusinessValue } from '@/utils/businessRuleEditorState'
import { expressionOperations, expressionArities, operationArguments, constantText, constantValueError, operationError } from '@/utils/ruleExpressionState'

export default {
  name: 'RuleExpressionEditor',
  props: {
    modelValue: {}, referenceErrors: { type: Object, default: () => ({}) },
    labelPrefix: { type: String, default: 'rule-expression' }, path: { type: String, default: 'root' }
  },
  emits: ['update:modelValue', 'draft-change'],
  data() {
    return {
      operations: expressionOperations, draft: constantText(this.modelValue), draftError: '',
      lastEmitted: undefined, hasEmitted: false, pendingChange: null,
      rowIds: (Array.isArray(this.modelValue?.args) ? this.modelValue.args : []).map((_, index) => index), nextRowId: this.modelValue?.args?.length || 0,
      children: {}
    }
  },
  computed: {
    kind() { return this.modelValue && typeof this.modelValue === 'object' ? ['op', 'field', 'param'].find(key => Object.hasOwn(this.modelValue, key)) || 'const' : 'const' },
    args() { return Array.isArray(this.modelValue?.args) ? this.modelValue.args : [] },
    rows() { return this.args.map((arg, index) => ({ arg, id: this.rowIds[index] })) },
    depth() { return this.path.split('.').length - 1 },
    nodeLabel() { return this.path === 'root' ? '主表达式' : '条件 ' + this.path.split('.').slice(1).map(value => Number(value) + 1).join('.') },
    errorId() { return `${this.labelPrefix}-${this.path}-error` },
    nodeError() { return this.draftError || this.referenceErrors[`expression-${this.path}`] || (this.kind === 'op' ? operationError(this.modelValue.op, this.args) : '') },
    variable() { return !expressionArities[this.modelValue?.op] && this.modelValue?.op !== 'round' },
    changeMessage() {
      if (!this.pendingChange) return ''
      const { type, value } = this.pendingChange
      if (type === 'kind') return `切换为“${{ op: '运算 / 条件', field: '业务字段', param: '参数', const: '固定值' }[value]}”会清空当前节点及其内容。`
      return `切换为“${this.operations[value]}”会移除末尾 ${Math.max(0, this.args.length - operationArguments(value, this.args).length)} 个运算项。`
    }
  },
  watch: {
    modelValue(value) {
      if (!(this.hasEmitted && Object.is(value, this.lastEmitted))) {
        this.draft = constantText(value)
        this.draftError = ''
      }
      this.hasEmitted = false
      while (this.rowIds.length < this.args.length) this.rowIds.push(this.nextRowId++)
      this.rowIds.length = this.args.length
    }
  },
  methods: {
    setChildRef(id, child) { if (child) this.children[id] = child; else delete this.children[id] },
    focusStart() { this.$refs.kindInput?.focus() },
    getDraftErrors() {
      const errors = {}
      if (this.draftError) errors[`expression-${this.path}`] = this.draftError
      if (this.pendingChange) errors[`expression-${this.path}`] = '请先确认更改或保留当前内容。'
      for (const id of this.rowIds) Object.assign(errors, this.children[id]?.getDraftErrors())
      return errors
    },
    publish(value) { this.hasEmitted = true; this.lastEmitted = value; this.$emit('update:modelValue', value) },
    setKind(kind) {
      if (kind === this.kind) { this.cancelChange(); return }
      if (kind === 'op' && this.depth >= 32) return
      this.pendingChange = { type: 'kind', value: kind }
      this.$emit('draft-change')
    },
    setOperation(op) {
      if (!Object.hasOwn(this.operations, op)) return
      if (op === this.modelValue.op) { this.cancelChange(); return }
      this.pendingChange = null
      if (operationArguments(op, this.args).length < this.args.length) {
        this.pendingChange = { type: 'operation', value: op }
        this.$emit('draft-change')
      } else this.publish({ op, args: operationArguments(op, this.args) })
    },
    confirmChange() {
      const change = this.pendingChange
      if (!change) return
      this.pendingChange = null
      this.draftError = ''
      if (change.type === 'operation') this.publish({ op: change.value, args: operationArguments(change.value, this.args) })
      else {
        const value = change.value === 'op' ? { op: 'gte', args: [{ field: 'value' }, 0] } : change.value === 'const' ? 0 : { [change.value]: '' }
        this.draft = constantText(value)
        this.publish(value)
      }
      this.$emit('draft-change')
      this.$nextTick(() => this.focusStart())
    },
    cancelChange() { this.pendingChange = null; this.$emit('draft-change'); this.$nextTick(() => this.focusStart()) },
    setConstant(text) {
      this.draft = text
      try {
        const value = parseBusinessValue(text)
        const error = constantValueError(value)
        if (error) throw new Error(error)
        this.draftError = ''
        this.publish(value)
      } catch (error) { this.draftError = error.message }
      this.$emit('draft-change')
    },
    setArgument(index, value) { const args = [...this.args]; args[index] = value; this.publish({ ...this.modelValue, args }) },
    addArgument() {
      if (this.depth >= 32 || (this.modelValue.op === 'round' && this.args.length >= 2)) return
      const id = this.nextRowId++
      this.rowIds.push(id)
      this.publish({ ...this.modelValue, args: [...this.args, 0] })
      this.$nextTick(() => this.children[id]?.focusStart())
    },
    removeArgument(index) {
      if (this.args.length <= 1 || index < 0 || index >= this.args.length) return
      this.rowIds.splice(index, 1)
      const id = this.rowIds[Math.min(index, this.rowIds.length - 1)]
      this.publish({ ...this.modelValue, args: this.args.filter((_, position) => position !== index) })
      this.$nextTick(() => this.children[id]?.focusStart())
    }
  }
}
</script>

<style scoped>
.expression-node { width: 100%; min-width: 0; container: rule-expression / inline-size; }
.expression-controls { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; align-items: start; }
.expression-controls > :is(.el-select, .el-input) { width: 100%; min-width: 0; }
.expression-children { display: grid; gap: 16px; min-width: 0; margin-block-start: 12px; }
.expression-node--root > .expression-children { padding-inline-start: 12px; border-inline-start: 1px solid var(--portal-line, #e8d9e1); }
.expression-child { min-width: 0; }
.expression-child-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-block-end: 8px; min-height: 24px; }
.expression-child-heading > span { min-width: 0; color: var(--portal-ink, #2c1b26); font-size: 14px; font-weight: 500; line-height: 1.5; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.expression-child-heading > .el-button { flex: 0 0 auto; min-width: 64px; margin: 0; }
.expression-add { justify-self: start; max-width: 100%; margin: 0; white-space: normal; height: auto; min-height: 32px; line-height: 1.5; }
.reference-error { color: var(--el-color-danger, #b42318); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; margin: 6px 0; }
.expression-controls > .expression-control--invalid :deep(.el-select__wrapper:not(.is-disabled)),
.expression-controls :deep(.el-input:not(.is-disabled):has(input[aria-invalid="true"]) .el-input__wrapper) { box-shadow: 0 0 0 1px var(--el-color-danger, #b42318) inset; }
.expression-controls > .expression-control--invalid :deep(.el-select__wrapper.is-focused:not(.is-disabled)),
.expression-controls :deep(.el-input:not(.is-disabled):has(input[aria-invalid="true"]) .el-input__wrapper.is-focus) { outline: 2px solid var(--portal-focus, #941966); outline-offset: 2px; }
.constant-hint, .change-confirmation p { font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; margin: 6px 0; color: var(--el-text-color-regular, #6d5a65); }
.change-confirmation { margin-block: 12px; padding: 12px; border: 1px solid var(--portal-line, #e8d9e1); border-radius: 4px; background: var(--portal-paper, #f8f3f6); }
.change-confirmation > p { margin: 0; color: var(--portal-ink, #2c1b26); }
.expression-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-block-start: 8px; }
.expression-actions > .el-button { flex: 0 1 auto; max-width: 100%; height: auto; min-height: 32px; margin: 0; white-space: normal; line-height: 1.5; }
@container rule-expression (min-width: 480px) {
  .expression-controls { grid-template-columns: minmax(160px, 1fr) minmax(0, 2fr); }
  .constant-hint, .expression-node--value > .reference-error { margin-inline-start: max(168px, calc((100% - 8px) / 3 + 8px)); }
}
@container rule-expression (min-width: 640px) {
  .expression-node--indent > .expression-children { padding-inline-start: 16px; border-inline-start: 1px solid var(--portal-line, #e8d9e1); }
}
@media (max-width: 800px), (any-pointer: coarse) {
  .expression-node :deep(.el-input__wrapper), .expression-node :deep(.el-select__wrapper) { min-height: 44px; box-sizing: border-box; }
  .expression-node :deep(.el-input__inner), .expression-node :deep(.el-select__selected-item) { font-size: 16px; }
  .expression-child-heading > .el-button, .expression-actions > .el-button, .expression-add { min-height: 44px; min-width: 44px; }
}
</style>
