<template>
  <section class="business-rule-editor" aria-label="业务规则配置">
    <p v-if="initializationError" class="business-error" role="alert">{{ initializationError }}</p>
    <template v-else>
      <p v-if="errorCount" ref="errorSummary" class="business-error" role="alert" tabindex="-1">有 {{ errorCount }} 处需要修改，请按提示修正后重试。{{ errors.expression || errors.parameters || errors.cases || '' }}</p>
      <div class="editor-heading"><h3>规则表达式</h3></div>
      <p class="business-hint">选择运算方式，再填写参与计算的业务字段、参数或固定值。</p>
      <RuleExpressionEditor ref="expressionEditor" v-model="expression" :reference-errors="errors" :label-prefix="editorId" @draft-change="changed" />
      <div class="editor-heading"><h3>参数</h3><el-button :id="`${editorId}-add-parameter`" text type="primary" @click="addParameter">添加参数</el-button></div>
      <p :id="`${editorId}-name-hint`" class="business-hint">参数可用于设置阈值等可复用的值。名称须与表达式中的参数引用一致，以英文字母开头，可含数字、_、.、-，最多 64 字符。</p>
      <p :id="`${editorId}-value-hint`" class="business-hint">数字填 100，判断值填 true 或 false；文本建议加双引号，如 "正常" 或 "01"。空值填 null，空文本填 ""，也支持 JSON 数组和对象。</p>
      <p v-if="!parameters.length" class="business-hint">未使用参数时可留空；若上方选择了“参数”，请在此添加同名参数并填写值。</p>
      <div v-for="(param, i) in parameters" :key="param.id" class="parameter-row">
        <el-form-item label="参数名" :for="fieldId(`parameter-${param.id}-name`)" :error="errors[`parameter-${param.id}-name`]" required>
          <el-input :id="fieldId(`parameter-${param.id}-name`)" v-model="param.name" placeholder="如 threshold" maxlength="64" :aria-label="`第 ${i + 1} 个参数的名称`" :aria-invalid="Boolean(errors[`parameter-${param.id}-name`])" :aria-describedby="describedBy(`parameter-${param.id}-name`, 'name')" />
          <template #error="{ error }"><div :id="fieldId(`parameter-${param.id}-name`) + '-error'" class="el-form-item__error" role="alert">{{ error }}</div></template>
        </el-form-item>
        <el-form-item label="参数值" :for="fieldId(`parameter-${param.id}-value`)" :error="errors[`parameter-${param.id}-value`]" required>
          <el-input :id="fieldId(`parameter-${param.id}-value`)" v-model="param.value" placeholder="如 100" :aria-label="`参数 ${param.name || i + 1} 的值`" :aria-invalid="Boolean(errors[`parameter-${param.id}-value`])" :aria-describedby="describedBy(`parameter-${param.id}-value`, 'value')" />
          <template #error="{ error }"><div :id="fieldId(`parameter-${param.id}-value`) + '-error'" class="el-form-item__error" role="alert">{{ error }}</div></template>
        </el-form-item>
        <el-button text class="row-delete" :aria-label="`删除参数 ${param.name || i + 1}`" @click="removeParameter(i)">删除参数</el-button>
      </div>
      <div class="editor-heading"><h3>测试样例 <small>{{ cases.length }} / {{ caseLimit }}</small></h3><el-button :id="`${editorId}-add-case`" text type="primary" :disabled="cases.length >= caseLimit || undefined" @click="addCase">添加样例</el-button></div>
      <p v-if="cases.length >= caseLimit" class="business-hint" role="status">最多 {{ caseLimit }} 个样例，请删除不需要的样例后再添加。</p>
      <p class="business-hint">为每个字段填写测试输入，并填写规则应返回的预期结果。编辑规则时，“运行测试”会先保存草稿，再核对实际结果是否符合预期。</p>
      <p class="business-hint">新增或修改字段编码后，请补填新字段的测试输入。填写方式与参数值相同。</p>
      <p v-if="!cases.length" class="business-hint">暂无测试样例。运行测试前，请至少添加 1 个样例。</p>
      <article v-for="(test, i) in cases" :key="test.id" class="business-case" :aria-label="`测试样例 ${i + 1}：${test.name || '未命名'}`">
        <div class="parameter-row">
          <el-form-item label="样例名称" :for="fieldId(`case-${test.id}-name`)" :error="errors[`case-${test.id}-name`]" required>
            <el-input :id="fieldId(`case-${test.id}-name`)" v-model="test.name" placeholder="如：达到收入预警线" maxlength="120" :aria-label="`第 ${i + 1} 个样例的名称`" :aria-invalid="Boolean(errors[`case-${test.id}-name`])" :aria-describedby="describedBy(`case-${test.id}-name`, '')" />
            <template #error="{ error }"><div :id="fieldId(`case-${test.id}-name`) + '-error'" class="el-form-item__error" role="alert">{{ error }}</div></template>
          </el-form-item>
          <el-form-item label="预期结果" :for="fieldId(`case-${test.id}-expected`)" :error="errors[`case-${test.id}-expected`]" required>
            <el-input :id="fieldId(`case-${test.id}-expected`)" v-model="test.expectedText" placeholder="如 true、false 或 100" :aria-label="`样例 ${test.name || i + 1} 的预期结果`" :aria-invalid="Boolean(errors[`case-${test.id}-expected`])" :aria-describedby="describedBy(`case-${test.id}-expected`, 'value')" />
            <template #error="{ error }"><div :id="fieldId(`case-${test.id}-expected`) + '-error'" class="el-form-item__error" role="alert">{{ error }}</div></template>
          </el-form-item>
          <el-button text class="row-delete" :aria-label="`删除样例 ${test.name || i + 1}`" @click="removeCase(i)">删除样例</el-button>
        </div>
        <el-form-item v-for="field in inputFields" :key="field" :label="`测试输入：${field}`" :for="fieldId(`case-${test.id}-input-${field}`)" :error="errors[`case-${test.id}-input-${field}`]" required>
          <el-input :id="fieldId(`case-${test.id}-input-${field}`)" v-model="test.values[field]" placeholder="如 100；测试空值请填 null" :aria-label="`样例 ${test.name || i + 1} 的 ${field} 测试输入`" :aria-invalid="Boolean(errors[`case-${test.id}-input-${field}`])" :aria-describedby="describedBy(`case-${test.id}-input-${field}`, 'value')" />
          <template #error="{ error }"><div :id="fieldId(`case-${test.id}-input-${field}`) + '-error'" class="el-form-item__error" role="alert">{{ error }}</div></template>
        </el-form-item>
      </article>
    </template>
  </section>
</template>

<script>
import RuleExpressionEditor from './RuleExpressionEditor.vue'
import { BUSINESS_CASE_LIMIT, expressionReferences, validateBusinessRuleDraft } from '@/utils/businessRuleEditorState'

let editorSequence = 0
const encodeValue = value => value === undefined ? '' : JSON.stringify(value)
export default {
  components: { RuleExpressionEditor },
  props: { initialExpression: { type: [Object, String, Number, Boolean], default: undefined }, initialParameters: Object, testCases: Array },
  emits: ['changed'],
  data() {
    let expression, parameters = [], cases = [], initializationError = ''
    try {
      expression = JSON.parse(JSON.stringify(this.initialExpression === undefined ? { op: 'gte', args: [{ field: 'value' }, 0] } : this.initialExpression))
      expressionReferences(expression)
      if (this.initialParameters && (typeof this.initialParameters !== 'object' || Array.isArray(this.initialParameters))) throw new Error('参数数据格式无效')
      parameters = Object.entries(this.initialParameters || {}).map(([name, value], i) => ({ id: `p${i}`, name, value: encodeValue(value) }))
      if (this.testCases != null && !Array.isArray(this.testCases)) throw new Error('测试样例数据格式无效')
      cases = (this.testCases || []).map((test, i) => {
        if (!test || typeof test !== 'object' || (test.input != null && (typeof test.input !== 'object' || Array.isArray(test.input)))) throw new Error(`第 ${i + 1} 个测试样例数据格式无效`)
        return { id: `c${i}`, name: String(test.name || ''), expectedText: encodeValue(test.expected), values: Object.assign(Object.create(null), Object.fromEntries(Object.entries(test.input || {}).map(([key, value]) => [key, encodeValue(value)]))) }
      })
    } catch (error) { initializationError = `${error.message}。请关闭编辑器，刷新规则后重试。` }
    return { editorId: `business-rule-${++editorSequence}`, expression, parameters, cases, initializationError, errors: {}, validationAttempted: false, nextRowId: parameters.length + cases.length, caseLimit: BUSINESS_CASE_LIMIT }
  },
  computed: {
    inputFields() { try { return expressionReferences(this.expression).fields } catch { return [] } },
    errorCount() { return Object.keys(this.errors).length }
  },
  watch: {
    expression: { deep: true, handler: 'changed' },
    parameters: { deep: true, handler: 'changed' },
    cases: { deep: true, handler: 'changed' }
  },
  methods: {
    fieldId(key) { return `${this.editorId}-${key}` },
    describedBy(key, hint) { return [hint ? `${this.editorId}-${hint}-hint` : '', this.errors[key] ? `${this.fieldId(key)}-error` : ''].filter(Boolean).join(' ') || undefined },
    changed() {
      if (this.validationAttempted) this.errors = { ...validateBusinessRuleDraft(this.expression, this.parameters, this.cases).errors, ...this.$refs?.expressionEditor?.getDraftErrors() }
      this.$emit('changed')
    },
    focusField(id) { this.$nextTick(() => this.$el.querySelector(`[id="${id}"]`)?.focus()) },
    addParameter() {
      const row = { id: `p${++this.nextRowId}`, name: '', value: '0' }
      this.parameters.push(row); this.focusField(this.fieldId(`parameter-${row.id}-name`))
    },
    removeParameter(index) {
      this.parameters.splice(index, 1)
      const next = this.parameters[Math.min(index, this.parameters.length - 1)]
      this.focusField(next ? this.fieldId(`parameter-${next.id}-name`) : `${this.editorId}-add-parameter`)
    },
    addCase() {
      if (this.cases.length >= this.caseLimit) return
      const serial = ++this.nextRowId, row = { id: `c${serial}`, name: `样例 ${serial}`, expectedText: 'true', values: Object.create(null) }
      this.cases.push(row); this.focusField(this.fieldId(`case-${row.id}-name`))
    },
    removeCase(index) {
      this.cases.splice(index, 1)
      const next = this.cases[Math.min(index, this.cases.length - 1)]
      this.focusField(next ? this.fieldId(`case-${next.id}-name`) : `${this.editorId}-add-case`)
    },
    getData() {
      if (this.initializationError) throw new Error(this.initializationError)
      this.validationAttempted = true
      const result = validateBusinessRuleDraft(this.expression, this.parameters, this.cases)
      this.errors = { ...result.errors, ...this.$refs?.expressionEditor?.getDraftErrors() }
      if (this.errorCount) {
        this.$nextTick(() => this.$nextTick(() => {
          if (!this.$el?.isConnected) return
          const invalid = this.$el.querySelector('input[aria-invalid="true"], [aria-invalid="true"] input')
          const target = invalid || this.$refs.errorSummary
          target?.focus(); target?.scrollIntoView({ block: 'nearest' })
        }))
        throw new Error(Object.values(this.errors)[0])
      }
      return JSON.parse(JSON.stringify(result.data))
    }
  }
}
</script>

<style scoped>
.business-rule-editor { width: 100%; min-width: 0; color: var(--portal-ink, #2c1b26); }
.editor-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px 16px; margin: 24px 0 8px; }
.editor-heading:first-child { margin-top: 0; }
.editor-heading h3 { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; }
.editor-heading small { margin-inline-start: 8px; color: var(--portal-muted, #6d5a65); font-weight: 400; font-variant-numeric: tabular-nums; }
.editor-heading .el-button { margin: 0; }
.parameter-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)) auto; gap: 12px; align-items: start; margin: 12px 0; }
.parameter-row > .el-form-item { min-width: 0; margin-bottom: 0; }
.parameter-row > .row-delete { min-width: 88px; margin: 29px 0 0; }
.row-delete:not(.is-disabled):hover, .row-delete:not(.is-disabled):focus-visible { color: #b42318; background: #fff5f4; }
.business-case { min-width: 0; padding: 16px; margin: 12px 0; background: var(--portal-paper, #f8f3f6); border: 1px solid var(--portal-line, #e8d9e1); border-radius: 6px; }
.business-case > .parameter-row:first-child { margin-top: 0; }
.business-case > .el-form-item:last-child { margin-bottom: 0; }
.business-rule-editor :deep(.el-form-item__label) { height: auto; overflow-wrap: anywhere; line-height: 1.5; margin-bottom: 8px; }
.business-rule-editor :deep(.el-form-item__error) { position: static; line-height: 1.5; overflow-wrap: anywhere; padding-top: 6px; }
.business-rule-editor :deep(.el-input:has(input[aria-invalid="true"]) .el-input__wrapper) { box-shadow: 0 0 0 1px #b42318 inset; }
.business-rule-editor :deep(button:focus-visible), .business-error:focus-visible { outline: 2px solid var(--portal-focus, #941966); outline-offset: 2px; }
.business-hint { margin: 6px 0; color: var(--portal-muted, #6d5a65); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.business-error { margin: 0 0 16px; padding: 12px 16px; border: 1px solid #e8b4ae; border-radius: 4px; background: #fff5f4; color: #922419; line-height: 1.6; overflow-wrap: anywhere; }
@media (max-width: 600px) {
  .parameter-row { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .parameter-row > .row-delete { margin: 0; justify-self: end; }
  .business-case { padding: 12px; }
}
</style>
