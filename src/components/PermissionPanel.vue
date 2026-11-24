<template>
  <section class="scope-permissions" :aria-busy="loading">
    <p v-if="loading" role="status" class="permission-note">正在读取人员、角色和部门…</p>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon><el-button :loading="loading" @click="$emit('retry')">重新加载名单</el-button></el-alert>
    <el-alert v-if="detached" title="选区已改变，请返回原选区应用，或放弃修改后配置新选区。" type="warning" :closable="false" show-icon>
      <div class="detached-actions">
        <el-button size="small" @click="$emit('return-selection')">回到原选区</el-button>
        <el-button size="small" type="primary" @click="$emit('discard')">放弃修改并编辑当前单元格</el-button>
      </div>
    </el-alert>
    <div v-if="dirty && !detached" class="permission-draft"><p class="permission-note" role="status">修改尚未应用。</p><el-button link @click="$emit('discard')">放弃未应用修改</el-button></div>
    <el-form label-position="top" size="small" :disabled="disabled">
      <el-form-item label="权限层级"><el-radio-group :model-value="scope" @change="$emit('scope', $event)"><el-radio-button value="sheet">表</el-radio-button><el-radio-button value="row">行</el-radio-button><el-radio-button value="column">列</el-radio-button><el-radio-button value="cell">单元格</el-radio-button></el-radio-group></el-form-item>
      <p class="permission-target"><span class="permission-target-label">配置对象：</span><strong>{{ target }}</strong></p>
      <template v-if="form">
        <el-alert v-if="mixed" title="选区包含不同权限。应用后将统一为下方设置。" type="info" :closable="false" />
        <el-alert v-if="legacy" title="此处仍使用旧版限制" type="warning" :closable="false" show-icon>
          <p>{{ legacySummary }}</p><p>转换会按当前人员名单保守保留权限，不自动包含未来新增人员。请检查转换结果后应用。</p>
          <el-button :disabled="loading || !!loadError || detached" @click="$emit('convert')">转换为人员名单</el-button>
        </el-alert>
        <div class="permission-field-group">
          <el-form-item label="谁可以查看"><el-select v-model="form.viewMode" aria-label="谁可以查看" popper-class="permission-options-menu" @change="viewChanged"><el-option label="本级不限定查看对象" value="all"/><el-option v-for="item in dimensions" :key="item.value" :label="item.label" :value="item.value"/><el-option label="不允许查看" value="none"/></el-select></el-form-item>
          <el-form-item v-if="viewKey" label="可查看对象"><el-select v-model="form[viewKey]" aria-label="可查看对象" multiple filterable :disabled="loading || !!loadError" placeholder="选择可查看对象" no-data-text="暂无可选对象" no-match-text="没有匹配的对象" popper-class="permission-options-menu"><el-option v-for="item in audienceOptions(form.viewMode)" :key="item.value" :value="item.value" :label="item.label"/></el-select></el-form-item>
          <el-form-item v-if="form.viewMode !== 'all'" label="无查看权限时"><el-select v-model="form.excludedVisibility" aria-label="无查看权限时" popper-class="permission-options-menu"><el-option label="隐藏内容" value="hidden"/><el-option label="显示 ••••" value="masked"/></el-select></el-form-item>
        </div>
        <div class="permission-field-group">
          <el-form-item label="谁可以编辑"><el-select v-model="form.permission" aria-label="谁可以编辑" :disabled="form.kind === 'calc' || form.viewMode === 'none'" popper-class="permission-options-menu"><el-option label="沿用已有填报范围" value="inherit"/><el-option label="只读（不可编辑）" value="read_only"/><el-option label="指定可编辑对象" value="primary_input"/><el-option v-if="form.kind === 'calc'" label="系统计算" value="system"/></el-select></el-form-item>
          <template v-if="form.permission === 'primary_input'">
            <el-form-item label="编辑对象选择方式"><el-select v-model="form.editDimension" aria-label="编辑对象选择方式" popper-class="permission-options-menu"><el-option v-for="item in dimensions" :key="item.value" :label="item.label" :value="item.value"/></el-select></el-form-item>
            <el-form-item label="可编辑对象"><el-select v-model="form[editKey]" aria-label="可编辑对象" multiple filterable :disabled="loading || !!loadError" placeholder="选择可编辑对象" no-data-text="暂无可选对象" no-match-text="没有匹配的对象" popper-class="permission-options-menu"><el-option v-for="item in audienceOptions(form.editDimension)" :key="item.value" :value="item.value" :label="item.label"/></el-select></el-form-item>
          </template>
          <p class="permission-note permission-field-note">{{ form.kind === 'calc' ? '系统计算字段不可手动编辑。' : '可编辑对象必须有查看权限，隐藏或脱敏时不可编辑。' }}</p>
        </div>
        <el-alert v-if="validation || conflict" :title="validation || conflict" type="error" :closable="false" show-icon role="alert" />
        <p class="permission-note permission-summary">表、行、列、单元格权限共同生效。应用时会检查冲突；保存模板后生效。</p>
        <div class="permission-actions"><el-button type="primary" :disabled="loading || !!loadError || detached || legacy || !!conflict" @click="$emit('apply')">应用权限</el-button><el-button :disabled="detached" @click="$emit('clear')">清除本级权限</el-button></div>
      </template>
      <p v-else class="permission-note" role="status">请在画布选择要配置权限的区域。</p>
    </el-form>
  </section>
</template>
<script>
import { editKeys, viewKeys, hasLegacy, formToRule, validateEntries } from '../template/permissionPolicy.js'
import { SHOWCASE } from '@/config/showcase'
export default {
  props: { form: Object, options: { type: Object, default: () => ({ users: [], roles: [], departments: [] }) }, loading: Boolean, loadError: String, dirty: Boolean, detached: Boolean, validation: String, scope: String, target: String, mixed: Boolean, disabled: Boolean },
  emits: ['scope', 'apply', 'clear', 'retry', 'discard', 'convert', 'change', 'return-selection'],
  data: () => ({}),
  computed: {
    dimensions() {
      const items = [{ value: 'user', label: '按人员' }]
      if (!SHOWCASE) items.push({ value: 'role', label: '按角色' })
      if (Array.isArray(this.options?.departments) && this.options.departments.length) items.push({ value: 'department', label: '按部门' })
      return items
    },
    viewKey() { return viewKeys[this.form?.viewMode] },
    editKey() { return editKeys[this.form?.editDimension] },
    legacy() { return !!this.form && hasLegacy(this.form) },
    legacySummary() {
      const names = { visibility: '隐藏或脱敏', hiddenForRoles: '角色不可查看', maskedForRoles: '角色仅可看脱敏内容', denyEditForRoles: '角色不可编辑', hiddenForDepartments: '部门不可查看', maskedForDepartments: '部门仅可看脱敏内容', denyEditForDepartments: '部门不可编辑' }
      const active = Object.entries(names).filter(([key]) => key === 'visibility' ? ['hidden', 'masked'].includes(this.form[key]) : this.form[key]?.length).map(([, label]) => label)
      return active.length ? '已设置：' + active.join('、') + '。' : '已同时设置多种编辑对象。'
    },
    conflict() {
      if (!this.form || this.legacy || this.loading || this.loadError) return ''
      if (this.viewKey && !this.form[this.viewKey]?.length) return '请选择至少一个可查看对象；如需全部隐藏，请选择“不允许查看”。'
      return validateEntries([{ rule: formToRule(this.form), row: 0, col: 0, rowCount: 1, colCount: 1, label: '当前设置' }], this.options)
    }
  },
  watch: {
    form: {
      deep: true,
      handler() {
        if (this.form && !this.dimensions.some(item => item.value === this.form.editDimension)) this.form.editDimension = 'user'
        this.$emit('change')
      }
    },
    dimensions: {
      immediate: true,
      handler(list) {
        if (this.form && !list.some(item => item.value === this.form.editDimension)) this.form.editDimension = 'user'
      }
    }
  },
  methods: {
    viewChanged(value) { if (value === 'none') this.form.permission = this.form.kind === 'calc' ? 'system' : 'read_only' },
    audienceOptions(dimension) {
      return (this.options[dimension === 'user' ? 'users' : dimension === 'role' ? 'roles' : 'departments'] || []).map(item => ({ value: dimension === 'user' ? item.id : item.code,
        label: dimension === 'user' ? (item.name || item.username) + (!SHOWCASE && item.organizationName ? ' · ' + item.organizationName : '') : item.name }))
    }
  }
}
</script>
<style scoped>
.scope-permissions {
  container: permission-panel / inline-size;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--portal-ink, #2c1b26);
  --el-color-primary: var(--portal-focus, #941966);
  --el-component-size-small: 32px;
  --el-font-size-small: 14px;
  --el-text-color-placeholder: #6d5a65;
}
.permission-target { margin: 0 0 24px; padding-bottom: 12px; border-bottom: 1px solid var(--portal-line, #e8d9e1); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.permission-target-label { color: var(--portal-muted, #6d5a65); }
.permission-target strong { font-weight: 600; }
.permission-field-group { display: flow-root; margin-bottom: 24px; }
.permission-field-group :deep(.el-form-item:last-child) { margin-bottom: 0; }
.permission-note { margin: 8px 0 16px; font-size: 12px; line-height: 1.6; color: var(--portal-muted, #6d5a65); }
.permission-field-group .permission-field-note { margin: -8px 0 0; }
.permission-summary { margin-block: 12px; }
.permission-draft { margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--portal-line, #e8d9e1); }
.detached-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.permission-draft .permission-note { margin-top: 0; }
.permission-draft .permission-note { margin-bottom: 4px; }
.permission-draft .el-button { padding-inline: 0; }
.permission-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 12px; padding-bottom: 4px; }
.permission-actions .el-button { margin: 0; min-width: 0; padding-inline: 8px; }
.scope-permissions .el-alert { margin-bottom: 16px; }
.scope-permissions :deep(.el-alert__content) { min-width: 0; }
.scope-permissions :deep(.el-alert__title) { line-height: 1.6; }
.scope-permissions :deep(.el-form-item) { margin-bottom: 16px; }
.scope-permissions :deep(.el-form-item__label) { font-size: 14px; line-height: 1.5; height: auto; margin-bottom: 8px; }
.scope-permissions :deep(.el-form-item__content) { min-width: 0; }
.scope-permissions :deep(.el-form-item__error) { position: static; line-height: 1.5; font-size: 12px; color: #b42318; }
.scope-permissions :deep(.el-select) { width: 100%; min-width: 0; }
.scope-permissions :deep(.el-select__wrapper) { min-height: 32px; font-size: 14px; }
.scope-permissions :deep(.el-radio-group) { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); width: 100%; gap: 4px; }
.scope-permissions :deep(.el-radio-button__inner) { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 32px; padding: 6px; white-space: normal; font-size: 14px; line-height: 1.4; border: 1px solid var(--el-border-color); border-radius: 4px; box-shadow: none; }
.scope-permissions :deep(.el-radio-button), .scope-permissions :deep(.el-button--primary) { --el-color-primary: var(--portal-focus, #941966); }
.scope-permissions :deep(.el-button) { height: auto; min-height: 32px; white-space: normal; line-height: 1.5; font-size: 14px; }
.scope-permissions :deep(.el-button--primary) { --el-button-hover-bg-color: #7a1454; --el-button-hover-border-color: #7a1454; --el-button-active-bg-color: #6f114b; --el-button-active-border-color: #6f114b; }
.scope-permissions :deep(.el-button > span) { min-width: 0; }
.scope-permissions :deep(.el-switch) { min-height: 32px; height: auto; }
.scope-permissions :deep(.el-switch__label) { height: auto; }
.scope-permissions :deep(.el-switch__label *) { font-size: 14px; line-height: 1.5; }
.scope-permissions :deep(.el-tag) { --el-tag-text-color: var(--portal-muted, #6d5a65); height: auto; min-height: 24px; max-width: 100%; white-space: normal; }
.scope-permissions :deep(.el-tag__content), .scope-permissions :deep(.el-select__tags-text) { min-width: 0; white-space: normal; overflow-wrap: anywhere; text-overflow: clip; line-height: 1.5; }
.scope-permissions :deep(.el-select__tags-text) { max-width: none; }
.scope-permissions :deep(button:focus-visible), .scope-permissions :deep(.el-radio-button__original-radio:focus-visible + .el-radio-button__inner) { outline: 2px solid var(--portal-focus, #941966); outline-offset: 2px; }
@container permission-panel (max-width: 280px) {
  .scope-permissions :deep(.el-radio-group) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 900px), (any-pointer: coarse) {
  .scope-permissions { --el-component-size-small: 44px; }
  .scope-permissions :deep(.el-button), .scope-permissions :deep(.el-select__wrapper), .scope-permissions :deep(.el-radio-button__inner) { min-height: 44px; font-size: 16px; }
  .permission-target { font-size: 16px; }
  .permission-note, .scope-permissions :deep(.el-form-item__error) { font-size: 14px; }
  .scope-permissions :deep(.el-select__input), .scope-permissions :deep(.el-select__placeholder), .scope-permissions :deep(.el-switch__label *) { font-size: 16px; }
  .scope-permissions :deep(.el-tag) { min-height: 44px; font-size: 14px; padding-inline: 8px 0; }
  .scope-permissions :deep(.el-tag__close) { width: 44px; height: 44px; flex-shrink: 0; margin: 0; }
  .scope-permissions :deep(.el-alert__title) { font-size: 14px; }
}
</style>
<style>
/* Select menus are teleported outside the scoped permission panel. */
.permission-options-menu { --el-color-primary: var(--portal-focus, #941966); max-width: calc(100vw - 24px); }
.permission-options-menu .el-select-dropdown__item { height: auto; min-height: 34px; padding-block: 7px; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
.permission-options-menu .el-select-dropdown__empty { white-space: normal; padding: 12px; line-height: 1.5; }
@media (max-width: 900px), (any-pointer: coarse) {
  .permission-options-menu .el-select-dropdown__item { min-height: 44px; font-size: 16px; padding-block: 10px; }
}
</style>
