<template>
  <section class="validator-editor">
    <div class="validator-banner"><h3>单元格数据校验</h3><span>设置校验条件，再用试填和样例检查结果</span></div>
    <div class="validator-layout">
      <div class="validator-fields">
        <div class="pair"><el-form-item label="允许输入"><el-select :model-value="config.type" @update:model-value="changeType"><el-option v-for="item in validatorTypes" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item v-if="bounded" label="条件"><el-select v-model="config.operator"><el-option v-for="item in comparisons" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item></div>
        <div v-if="bounded" class="pair"><el-form-item :label="[6,7].includes(config.operator) ? '最小值' : '比较值'"><el-input v-model="config.value1" :placeholder="config.type === 'date' ? 'YYYY-MM-DD 或 =B1' : '数值或 =B1'" /></el-form-item><el-form-item v-if="[6,7].includes(config.operator)" label="最大值"><el-input v-model="config.value2" :placeholder="config.type === 'date' ? 'YYYY-MM-DD 或 =B1' : '数值或 =B1'" /></el-form-item></div>
        <small v-if="bounded" class="condition-help">{{ config.type === 'date' ? '日期按年-月-日填写，例如 2026-01-01。' : config.type === 'textLength' ? '比较值表示字符数量，请填写整数。' : config.type === 'integer' ? '比较值请填写整数。' : '比较值可填写整数或小数。' }} 也可用 =B1 引用试填表中的单元格。</small>
        <el-form-item v-if="config.type === 'list'" label="列表选项"><el-input v-model="config.list" type="textarea" :rows="3" placeholder="每行一项，也可用逗号分隔" /></el-form-item>
        <el-form-item v-if="['formula','formulaList'].includes(config.type)" :label="config.type === 'formula' ? '校验公式' : '列表来源区域'"><el-input v-model="config.formula" :placeholder="config.type === 'formula' ? '例如 A1>=B1' : '例如 $B$1:$B$3'" /><small>{{ config.type === 'formula' ? '公式结果为 TRUE 时，输入值符合条件。例如 A1>=B1，表示 A1 不能小于 B1。' : '填写提供下拉选项的单元格区域，例如 $B$1:$B$3。' }} 试填时可在表中填写引用数据；应用到模板后，相对引用以目标单元格为基准。</small></el-form-item>
        <div class="pair"><el-checkbox v-model="config.ignoreBlank">忽略空白值</el-checkbox><el-checkbox v-if="['list','formulaList'].includes(config.type)" v-model="config.dropdown">显示下拉选项</el-checkbox></div>
        <el-divider content-position="left">输入提示与错误反馈</el-divider>
        <el-checkbox v-model="config.showInput">选中单元格时显示填写提示</el-checkbox>
        <div v-if="config.showInput" class="pair"><el-form-item label="提示标题"><el-input v-model="config.inputTitle" /></el-form-item><el-form-item label="填写提示"><el-input v-model="config.inputMessage" /></el-form-item></div>
        <el-checkbox v-model="config.showError">输入不符合条件时显示错误提示</el-checkbox>
        <div class="pair"><el-form-item label="错误提示标题"><el-input v-model="config.errorTitle" /></el-form-item><el-form-item label="错误提示内容"><el-input v-model="config.errorMessage" placeholder="例如：人数不能小于 0" /></el-form-item></div>
        <div class="pair"><el-form-item label="不符合条件时"><el-select v-model="config.errorStyle"><el-option label="阻止提交" :value="0"/><el-option label="警告，允许提交" :value="1"/><el-option label="提示，允许提交" :value="2"/></el-select></el-form-item><el-form-item label="无效数据标记"><el-select v-model="config.highlight"><el-option label="红圈" value="circle"/><el-option label="右上角标" value="dogEar"/></el-select></el-form-item></div>
      </div>
      <div class="validator-preview">
        <h4>试填预览 · A1</h4>
        <p>在 A1 输入测试值，其他单元格可填写公式引用的数据。试填不会写入业务报表。</p>
        <div ref="preview" class="preview-book" role="region" aria-label="校验试填表，A1 为测试单元格" :inert="!ready || configurationInvalid" :aria-disabled="!ready || configurationInvalid" />
        <div v-if="initError" class="preview-error" role="alert">
          <p>{{ initError }}</p><el-button @click="initializePreview">重新加载试填表</el-button>
        </div>
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <p class="preview-caption" role="status" aria-live="polite" aria-atomic="true">{{ previewMessage }}</p>
      </div>
    </div>
    <div class="test-heading"><h3>发布前测试</h3><el-button text type="primary" @click="addCase">添加样例</el-button></div>
    <p class="test-help">每个样例会把测试值放入 A1。实际校验结果与预期一致才算测试通过；预期为“不符合条件”时，识别出异常值也算通过。</p>
    <p v-if="!cases.length" class="case-empty" role="status">暂无测试样例。运行测试至少需要一个样例。</p>
    <div v-for="(test,index) in cases" :key="test._key" class="test-case">
      <div class="sample-row">
        <el-form-item label="样例名称" class="sample-field"><el-input v-model="test.name" :aria-label="`样例 ${index + 1} 名称`" /></el-form-item>
        <el-form-item label="测试值" class="sample-field"><el-input :model-value="test.input.value == null ? '' : String(test.input.value)" @update:model-value="value => setTestValue(test,value)" :aria-label="`样例 ${index + 1} 测试值`" :aria-invalid="Boolean(test._issues.value)" placeholder="测试值（留空表示空白）" /></el-form-item>
        <el-form-item label="预期校验结果" class="sample-field"><el-select v-model="test.expected" :aria-label="`样例 ${index + 1} 预期校验结果`" placeholder="预期校验结果"><el-option label="符合条件" :value="true"/><el-option label="不符合条件" :value="false"/></el-select></el-form-item>
        <el-button text type="danger" :aria-label="`删除样例 ${index + 1}：${test.name}`" @click="removeCase(index)">删除</el-button>
      </div>
      <p v-for="(message,field) in test._issues" :key="field" class="case-error" role="alert">{{ message }}</p>
    </div>
    <div class="reference-actions">
      <small>已有样例保留各自的引用数据；尚未设置时使用当前试填表。统一替换会覆盖所有样例的引用数据，不改变测试值。</small>
      <el-button v-if="cases.length" :disabled="!ready || Boolean(error)" @click="applyReferenceCells">替换全部样例的引用数据</el-button>
    </div>
    <p v-if="referenceMessage" class="reference-message" role="status">{{ referenceMessage }}</p>
  </section>
</template>
<script>
import GC from '@grapecity-software/spread-sheets'
import { observeWorkbookLayout } from '@/utils/observeWorkbookLayout'
import '@grapecity-software/spread-sheets/styles/gc.spread.sheets.excel2013white.css'
import { defaultValidatorConfig, createValidator, serializeValidator, validatorTypes, comparisons } from '@/template/nativeValidator'
import { copyValidatorData, normalizeValidatorCases, exportValidatorCases, validReferenceCells, initialTypeCondition } from './nativeValidatorEditorState'
export default {
  props: { expression: Object, testCases: Array }, emits: ['changed'],
  data() {
    const cases = normalizeValidatorCases(this.testCases, Boolean(this.expression))
    return {
      config: { ...defaultValidatorConfig(), ...this.expression?.config }, cases,
      nextCaseKey: cases.length + 1, conditions: {}, validatorTypes, comparisons,
      ready: false, configurationInvalid: false, initError: '', error: '', previewMessage: '', referenceMessage: ''
    }
  },
  computed: { bounded() { return ['number','integer','date','textLength'].includes(this.config.type) } },
  mounted() { this.initializePreview() },
  beforeUnmount() { this.releasePreview() },
  watch: {
    config: { deep: true, handler() { this.updatePreview(); this.$emit('changed') } },
    cases: { deep: true, handler() { this.$emit('changed') } }
  },
  methods: {
    changeType(type) {
      if (type === this.config.type) return
      const { value1, value2, formula, list, operator } = this.config
      this.conditions[this.config.type] = { value1, value2, formula, list, operator }
      Object.assign(this.config, this.conditions[type] || initialTypeCondition(type), { type })
    },
    releasePreview() {
      this.ready = false
      const stop = this.stopLayout, book = this.book
      this.stopLayout = null; this.book = null
      try { stop?.() } finally { book?.destroy() }
    },
    initializePreview() {
      this.initError = ''; this.error = ''; this.previewMessage = ''
      try {
        this.releasePreview()
        this.book = new GC.Spread.Sheets.Workbook(this.$refs.preview, {
          sheetCount: 1, enableAccessibility: true, highlightInvalidData: true,
          newTabVisible: false, tabStripVisible: false, tabEditable: false,
          allowSheetReorder: false, allowContextMenu: false
        })
        const sheet = this.book.getSheet(0)
        const cells = this.cases[0]?.input.cells
        // Keep larger saved reference regions visible instead of truncating them.
        sheet.setRowCount(Math.max(10, validReferenceCells(cells) ? cells.length : 0))
        sheet.setColumnCount(Math.max(8, validReferenceCells(cells) ? cells.reduce((n,row) => Math.max(n,row.length),0) : 0))
        if (validReferenceCells(cells)) sheet.setArray(0,0,cells)
        this.stopLayout = observeWorkbookLayout(this.$refs.preview, this.book)
        this.book.bind(GC.Spread.Sheets.Events.ValueChanged, () => {
          this.referenceMessage = ''
          this.checkPreview(); this.$emit('changed')
        })
        this.ready = true
        this.updatePreview()
      } catch {
        try { this.releasePreview() } catch { /* Keep the retry available after partial initialization. */ }
        this.initError = '试填表未能加载，条件和样例已保留。请点击“重新加载试填表”。'
      }
    },
    setTestValue(test,value) {
      test.input.value = value === '' ? null : ['number','integer'].includes(this.config.type) && Number.isFinite(Number(value)) ? Number(value) : value
      delete test._issues.value
    },
    addCase() {
      this.cases.push({ _key: this.nextCaseKey++, _issues: {}, name: `样例 ${this.nextCaseKey - 1}`, input: { value: null }, expected: true })
    },
    removeCase(index) {
      this.cases.splice(index,1)
      this.$nextTick(() => {
        const next = this.$el.querySelectorAll('.sample-row')[Math.min(index,this.cases.length - 1)]?.querySelector('input')
        ;(next || this.$el.querySelector('.test-heading button'))?.focus()
      })
    },
    updatePreview() {
      if (!this.ready) return
      this.previewMessage = ''
      try {
        this.validateConfig()
        this.book.getSheet(0).setDataValidator(0,0,createValidator(this.config))
        this.configurationInvalid = false
        this.error = ''
        this.checkPreview()
      } catch (error) {
        this.configurationInvalid = true
        this.error = error?.message || '校验条件无法应用，请检查条件后重试。'
      }
    },
    validateConfig() {
      if (!validatorTypes.some(item => item.value === this.config.type)) throw new Error('请选择有效的允许输入类型。')
      if (this.bounded && !comparisons.some(item => item.value === this.config.operator)) throw new Error('请选择有效的比较条件。')
      if (![0,1,2].includes(this.config.errorStyle)) throw new Error('请选择有效的处理方式。')
    },
    checkPreview() {
      if (!this.ready || this.configurationInvalid) return
      try {
        const sheet = this.book.getSheet(0), validator = sheet.getDataValidator(0,0)
        if (!validator) throw new Error('校验条件尚未应用，请重新设置条件。')
        const value = sheet.getValue(0,0)
        const valid = validator.isValid(sheet,0,0,value)
        this.previewMessage = `${value == null || value === '' ? 'A1 为空' : 'A1'}：${valid ? '符合条件' : '不符合条件'}`
        this.error = ''
      } catch (error) {
        this.previewMessage = ''
        this.error = error?.message || '无法校验当前值，请检查条件后重试。'
      }
    },
    referenceCells() {
      if (!this.ready) throw new Error('试填表尚未就绪。请点击“重新加载试填表”，再保存或运行测试。')
      const sheet = this.book.getSheet(0)
      if (!sheet.endEdit()) throw new Error('试填表中有正在编辑的单元格。请按 Enter 完成输入后重试。')
      return sheet.getArray(0,0,sheet.getRowCount(),sheet.getColumnCount())
    },
    applyReferenceCells() {
      try {
        const cells = this.referenceCells()
        this.cases.forEach(test => { test.input.cells = copyValidatorData(cells); delete test._issues.cells })
        this.referenceMessage = `已用当前试填表替换 ${this.cases.length} 个样例的引用数据，测试值未改变。`
      } catch (error) { this.referenceMessage = error.message }
    },
    getData() {
      this.validateConfig()
      const expression = serializeValidator(this.config)
      const cells = this.referenceCells()
      return { expression, parameters: {}, testCases: exportValidatorCases(this.cases,cells), severity: ['blocking','warning','info'][this.config.errorStyle] }
    }
  }
}
</script>
<style scoped>
.validator-editor {
  container: native-validator / inline-size;
  width: 100%; min-width: 0;
  color: var(--portal-ink, #2c1b26);
  font-size: 14px; line-height: 1.6;
}
.validator-editor h3,.validator-editor h4 { margin: 0; color: var(--portal-ink, #2c1b26); font-size: 14px; font-weight: 600; line-height: 1.5; }
.validator-editor .validator-banner {
  display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px;
  padding: 12px 16px; margin-bottom: 20px;
  border: 1px solid var(--portal-line, #e8d9e1); background: var(--portal-paper, #f8f3f6);
}
.validator-editor .validator-banner span,.validator-editor small,.validator-editor .validator-preview p {
  font-size: 14px; color: var(--portal-muted, #6d5a65); line-height: 1.6; overflow-wrap: anywhere;
}
.validator-editor .validator-layout { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 24px; }
.validator-editor .validator-layout > *, .validator-editor .pair > * { min-width: 0; }
.validator-editor .pair { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; margin: 0 0 12px; }
.validator-editor .validator-fields :deep(.el-form-item) { margin-bottom: 12px; }
.validator-editor .pair :deep(.el-form-item) { margin-bottom: 0; }
.validator-editor :deep(.el-form-item__label) { margin-bottom: 6px; line-height: 20px; }
.validator-editor :deep(.el-select) { width: 100%; }
.validator-editor :deep(.el-checkbox) { max-width: 100%; height: auto; min-height: 32px; white-space: normal; }
.validator-editor :deep(.el-checkbox__label) { white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
.validator-editor .validator-fields > :deep(.el-checkbox) { margin-bottom: 8px; }
.validator-editor :deep(.el-divider--horizontal) { margin: 20px 0 16px; }
.validator-editor :deep(.el-divider__text) { padding-inline: 12px; font-size: 14px; font-weight: 500; color: var(--portal-muted, #6d5a65); }
.validator-editor .condition-help { display: block; margin: -4px 0 12px; }
.validator-editor .el-form-item small { display: block; margin-top: 6px; }
.validator-editor .validator-preview {
  align-self: start; padding: 16px; min-width: 0;
  background: var(--portal-paper, #f8f3f6); border: 1px solid var(--portal-line, #e8d9e1); border-radius: 8px;
}
.validator-editor .validator-preview > p { margin: 6px 0 12px; }
.validator-editor .preview-book { height: 265px; min-width: 0; background: var(--portal-surface, #ffffff); }
.validator-editor .validator-preview > .preview-caption { min-height: 22px; margin: 12px 0 0; padding-top: 8px; border-top: 1px solid var(--portal-line, #e8d9e1); }
.validator-editor .preview-error { margin-top: 12px; }
.validator-editor .preview-error p,.validator-editor .case-error { color: var(--error-text, #b42318); overflow-wrap: anywhere; }
.validator-editor .preview-error p { margin: 0 0 8px; }
.validator-editor .validator-preview :deep(.el-alert) { margin-top: 12px; }
.validator-editor .test-heading {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--portal-line, #e8d9e1);
}
.validator-editor .test-help { max-inline-size: 76ch; margin: 4px 0 16px; color: var(--portal-muted, #6d5a65); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.validator-editor .test-case { min-width: 0; }
.validator-editor .sample-row {
  display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr) minmax(160px,.8fr) 56px;
  align-items: end; gap: 12px; margin: 0; padding: 12px 0; border-bottom: 1px solid var(--portal-line, #e8d9e1);
}
.validator-editor .sample-row > * { min-width: 0; }
.validator-editor :deep(.sample-field.el-form-item) { margin: 0; }
.validator-editor .sample-row > .el-button { margin: 0; padding-inline: 8px; white-space: nowrap; }
.validator-editor .case-error { margin: 4px 0 12px; font-size: 14px; line-height: 1.6; }
.validator-editor .case-empty { margin: 12px 0; padding-block: 12px; border-bottom: 1px solid var(--portal-line, #e8d9e1); color: var(--portal-muted, #6d5a65); }
.validator-editor .reference-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px; margin-top: 16px; min-width: 0; }
.validator-editor .reference-actions small { flex: 1 1 300px; max-inline-size: 76ch; }
.validator-editor .reference-actions .el-button { flex: 0 1 auto; margin-inline-start: auto; max-width: 100%; white-space: normal; height: auto; min-height: 44px; line-height: 1.5; }
.validator-editor .reference-message { margin: 8px 0 0; color: var(--portal-muted, #6d5a65); line-height: 1.6; overflow-wrap: anywhere; }
.validator-editor :deep(button:focus-visible) { outline: 2px solid var(--portal-focus, #941966); outline-offset: 2px; }
.validator-editor :deep(input),.validator-editor :deep(textarea) { caret-color: var(--portal-focus, #941966); }
@container native-validator (max-width: 760px) {
  .validator-editor .validator-layout { grid-template-columns: minmax(0,1fr); }
}
@container native-validator (max-width: 640px) {
  .validator-editor .sample-row { grid-template-columns: repeat(2,minmax(0,1fr)); }
}
@container native-validator (max-width: 420px) {
  .validator-editor .pair { grid-template-columns: minmax(0,1fr); }
  .validator-editor .validator-preview { padding: 12px; }
  .validator-editor .validator-banner { padding: 12px; }
}
@media (max-width: 800px), (any-pointer: coarse) {
  .validator-editor :deep(.el-input__wrapper),.validator-editor :deep(.el-select__wrapper),.validator-editor :deep(.el-button),.validator-editor :deep(.el-checkbox) { min-height: 44px; }
  .validator-editor :deep(.el-input__inner),.validator-editor :deep(.el-textarea__inner),.validator-editor :deep(.el-select__selected-item) { font-size: 16px; }
}
</style>
