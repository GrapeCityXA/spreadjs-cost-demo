<template>
  <el-dialog v-model="visible" :title="title" class="field-proposal-dialog" :width="width"
    :before-close="requestClose" :show-close="!saving" :close-on-click-modal="false" :close-on-press-escape="!saving" destroy-on-close>
    <p class="field-proposal-hint">{{ isSystemAdmin ? '无需审批，提交成功后字段立即生效。' : '提交后等待审批；批准后，字段可用于模板。' }}</p>
    <div v-if="errorCount || failure" ref="status" class="field-proposal-status" role="alert" tabindex="-1">
      <p v-if="failure && !errorCount">{{ failure }}</p>
      <template v-if="errorCount"><p>有 {{ errorCount }} 项需要修改，点击提示可定位：</p><ul>
        <li v-for="(error, key) in errors" :key="key"><button type="button" @click="focusField(key)">{{ error }}</button></li>
      </ul></template>
    </div>
    <el-form :model="form" :disabled="saving || uncertain" label-position="top" class="field-proposal-form" @submit.prevent="submit">
      <el-form-item v-for="field in fields" :key="field.key" :label="field.label" :required="field.required"
        :for="fieldId(field.key)" :class="{ 'full-row': field.full, 'has-error': errors[field.key] }">
        <el-select v-if="field.key === 'type'" :id="fieldId(field.key)" v-model="form.type" popper-class="field-proposal-select-menu" v-bind="a11y(field)">
          <el-option v-for="type in types" :key="type.value" :label="type.label" :value="type.value" />
        </el-select>
        <el-input-number v-else-if="field.key === 'precision'" :id="fieldId(field.key)" v-model="form.precision" :min="0" :max="12" :disabled="form.type !== 'decimal' || saving || uncertain" v-bind="a11y(field)" />
        <el-switch v-else-if="field.key === 'editable'" :id="fieldId(field.key)" v-model="form.editable" active-text="可编辑" inactive-text="只读" v-bind="a11y(field)" />
        <el-input v-else :id="fieldId(field.key)" v-model="form[field.key]" :type="field.multiline ? 'textarea' : 'text'" :rows="3"
          :disabled="(field.key === 'code' && Boolean(form.supersedesFieldId)) || saving || uncertain" :placeholder="field.placeholder" v-bind="a11y(field)" />
        <p v-if="field.hint" :id="`${fieldId(field.key)}-hint`" class="field-proposal-hint">{{ field.hint }}</p>
        <p v-if="errors[field.key]" :id="`${fieldId(field.key)}-error`" class="field-proposal-error">{{ errors[field.key] }}</p>
      </el-form-item>
    </el-form>
    <template #footer>
      <span v-if="saving" class="field-proposal-saving" role="status">正在提交，请稍候…</span>
      <el-button :disabled="saving" @click="requestClose()">{{ uncertain ? '关闭表单' : '取消' }}</el-button>
      <el-button type="primary" :loading="saving" :disabled="uncertain" @click="submit">{{ submitLabel }}</el-button>
    </template>
  </el-dialog>
</template>

<script>
import { fieldCatalogApi } from '@/api'
import { createFieldProposal, fieldProposalTypes, validateFieldProposal, fieldProposalFailure, submitFieldProposal, persistFieldProposal } from './fieldProposalState'
let nextId = 0
export default {
  name: 'FieldProposalDialog',
  props: { isSystemAdmin: Boolean, width: { type: String, default: 'min(700px, calc(100% - 32px))' } },
  emits: ['saved'],
  data() { return { visible: false, saving: false, uncertain: false, failure: '', errors: {}, validated: false,
    form: createFieldProposal(), baseline: '', session: 0, confirming: false, types: fieldProposalTypes, prefix: `field-proposal-${++nextId}` } },
  computed: {
    title() { return this.form.id ? '修正字段提案' : this.form.supersedesFieldId ? '提出字段新版本' : (this.isSystemAdmin ? '新建字段' : '新建字段提案') },
    submitLabel() { return this.isSystemAdmin ? (this.form.id ? '修正并生效' : '创建并生效') : (this.form.id ? '重新提交提案' : '提交提案') },
    dirty() { return JSON.stringify(this.form) !== this.baseline },
    errorCount() { return Object.keys(this.errors).length },
    fields() { return [
      { key: 'code', label: '字段编码', required: true, placeholder: '例如：MONTHLY_REVENUE', hint: this.form.supersedesFieldId ? '新版本沿用原字段编码，不可修改。' : '2–64 位，仅限大写字母、数字和下划线，且以字母开头。' },
      { key: 'displayName', label: '中文名称', required: true, placeholder: '例如：营业收入', hint: '需包含中文，最多 120 个字符。' },
      { key: 'type', label: '字段类型', required: true },
      { key: 'unit', label: '单位', placeholder: '例如：人民币元', hint: '选填，不超过 80 个字符。' },
      { key: 'precision', label: '小数精度', hint: this.form.type === 'decimal' ? '设置最多允许的小数位数，范围 0–12。' : '当前字段类型不需要设置小数位数。' },
      { key: 'editable', label: '可编辑', hint: '关闭后为只读字段。' },
      ...(this.form.type === 'enum' ? [{ key: 'optionsText', label: '枚举选项', full: true, multiline: true, required: true, placeholder: '例如：\n待处理\n已完成', hint: '每行一项，共 1–200 项；不可重复，每项最多 120 个字符。' }] : []),
      { key: 'applicabilityText', label: '适用范围（JSON）', full: true, multiline: true, placeholder: '例如：{"reportTypes":["monthly"]}', hint: '{} 表示全部适用。有范围限制时填写 JSON 对象，最多 4000 个字符（不计格式空白）。' },
      ...(this.form.supersedesFieldId ? [{ key: 'reason', label: '版本变更原因', full: true, placeholder: '例如：金额单位由元改为万元', hint: '选填，说明本次修改了什么。' }] : [])
    ] }
  },
  watch: { form: { deep: true, handler() {
    if (!this.saving && !this.uncertain) {
      this.failure = ''
      if (this.validated) this.errors = validateFieldProposal(this.form).errors
    }
  } } },
  mounted() { window.addEventListener('beforeunload', this.beforeUnload) },
  beforeUnmount() { this.session++; this._controller?.abort(); window.removeEventListener('beforeunload', this.beforeUnload) },
  methods: {
    fieldId(key) { return `${this.prefix}-${key}` },
    a11y(field) { return { 'aria-required': field.required ? 'true' : undefined, 'aria-invalid': this.errors[field.key] ? 'true' : undefined,
      'aria-describedby': [field.hint && `${this.fieldId(field.key)}-hint`, this.errors[field.key] && `${this.fieldId(field.key)}-error`].filter(Boolean).join(' ') || undefined } },
    open(proposal = {}, draft = {}) {
      if (this.visible || this.saving) return
      this.session++; this.validated = false; this.errors = {}; this.failure = ''; this.uncertain = false
      this.form = createFieldProposal(proposal, draft); this.baseline = JSON.stringify(this.form); this.visible = true
    },
    async focusField(key) { await this.$nextTick(); document.getElementById(this.fieldId(key))?.focus() },
    beforeUnload(event) { if (this.visible && (this.dirty || this.saving || this.uncertain)) { event.preventDefault(); event.returnValue = '' } },
    async canLeave() {
      if (!this.visible) return true
      if (this.saving) { this.failure = '正在提交，请等待结果后再离开。'; return false }
      if (!this.dirty && !this.uncertain) return true
      if (this.confirming) return false
      this.confirming = true
      try {
        await this.$confirm(this.uncertain ? '关闭会清空当前表单，但不会撤销已发出的提交。请先记下字段编码，关闭后到业务字段目录核对结果。' : '关闭后，已填写的字段信息不会保存。',
          this.uncertain ? '提交结果未确认，仍要关闭？' : '放弃本次填写？', {
            confirmButtonText: this.uncertain ? '关闭表单' : '放弃填写', cancelButtonText: this.uncertain ? '返回表单' : '继续填写', type: 'warning',
            closeOnClickModal: false, customClass: 'field-proposal-confirm'
          })
        return true
      } catch { return false }
      finally { this.confirming = false }
    },
    async requestClose(done) { if (await this.canLeave()) { this.session++; this.visible = false; if (typeof done === 'function') done() } },
    async submit() {
      if (!this.visible || this.saving || this.uncertain) return
      this.validated = true; this.failure = ''
      const { errors, payload } = validateFieldProposal(this.form)
      this.errors = errors
      if (Object.keys(errors).length) { await this.focusField(Object.keys(errors)[0]); return }
      this.saving = true
      const session = this.session, { id, supersedesFieldId } = this.form
      this._controller = new AbortController()
      try {
        const result = await submitFieldProposal(signal => persistFieldProposal(fieldCatalogApi, { id, supersedesFieldId }, payload, signal), { signal: this._controller.signal })
        if (session !== this.session || !this.visible) return
        this.baseline = JSON.stringify(this.form); this.visible = false
        this.$message.success(result?.status === 'approved' ? (supersedesFieldId ? '字段新版本已生效' : '字段已生效，可在已批准字段中查看') : '字段提案已提交，等待审批')
        this.$emit('saved', result || {})
      } catch (error) {
        if (session !== this.session || !this.visible) return
        this.saving = false
        const failure = fieldProposalFailure(error)
        this.uncertain = Boolean(failure.uncertain); this.failure = failure.message
        if (failure.field && this.fields.some(field => field.key === failure.field)) { this.errors = { [failure.field]: failure.message }; await this.focusField(failure.field) }
        else { await this.$nextTick(); this.$refs.status?.focus() }
      } finally { if (session === this.session) { this.saving = false; this._controller = null } }
    }
  }
}
</script>

<style src="@/styles/field-proposal.css"></style>
