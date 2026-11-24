<template>
  <div class="reporting-period-picker" :class="{ 'has-period-error': invalid && !disabled }" v-period-feedback="{ invalid, description: descriptionId }">
    <label v-if="cadence === 'monthly'" :for="`${pickerId}-month`">报告月份
      <el-date-picker :id="`${pickerId}-month`" v-model="month" popper-class="reporting-period-popper" :popper-options="periodPopperOptions" type="month" format="YYYY 年 MM 月" value-format="YYYY-MM" placeholder="选择报告月份" :editable="false" :disabled="disabled" />
    </label>
    <div v-else class="quarter-controls">
      <label :for="`${pickerId}-year`">报告年份
        <el-date-picker :id="`${pickerId}-year`" v-model="year" popper-class="reporting-period-popper" :popper-options="periodPopperOptions" type="year" format="YYYY 年" value-format="YYYY" placeholder="选择年份" :editable="false" :disabled="disabled" @change="updateQuarter" />
      </label>
      <label :for="`${pickerId}-quarter`">报告季度
        <el-select :id="`${pickerId}-quarter`" v-model="quarter" popper-class="reporting-period-popper" aria-label="报告季度" placeholder="选择季度" clearable :disabled="disabled" @change="updateQuarter">
          <el-option v-for="(label, index) in quarters" :key="index" :value="String(index + 1)" :label="label" />
        </el-select>
      </label>
    </div>
    <p v-if="invalid" :id="`${pickerId}-error`" class="period-warning" role="alert">报告期间“{{ modelValue }}”的格式不符合{{ cadence === 'monthly' ? '月报' : '季报' }}要求。<template v-if="!disabled">请重新选择{{ cadence === 'monthly' ? '报告月份' : '报告年份和季度' }}。</template></p>
    <p v-if="!invalid || disabled" :id="`${pickerId}-hint`" class="period-hint" aria-live="polite">{{ hint }}</p>
  </div>
</template>
<script setup>
import { computed, ref, watch, useId } from 'vue'
const props = defineProps({ modelValue: { type: String, default: '' }, cadence: { type: String, default: 'monthly' }, disabled: Boolean, disabledHint: { type: String, default: '该填报计划的报告类型和报告期间已锁定，无法修改。' } })
const emit = defineEmits(['update:modelValue'])
const pickerId = `reporting-period-${useId()}`
// In short landscape viewports the calendar may need to overlap its trigger.
const periodPopperOptions = { modifiers: [{ name: 'preventOverflow', options: { altAxis: true, tether: false, padding: 8 } }] }
const quarters = ['第一季度（1—3月）', '第二季度（4—6月）', '第三季度（7—9月）', '第四季度（10—12月）']
const year = ref(''), quarter = ref('')
const hint = computed(() => {
  if (props.disabled) return props.disabledHint
  if (props.cadence === 'quarterly') {
    if (year.value && !quarter.value) return '已选择年份，还需选择报告季度。'
    if (!year.value && quarter.value) return '已选择季度，还需选择报告年份。'
    return '选择数据所属年份和季度；截止日期在“组织与期限”中设置。'
  }
  return '选择数据所属月份；截止日期在“组织与期限”中设置。'
})
const valid = computed(() => (props.cadence === 'monthly' ? /^\d{4}-(0[1-9]|1[0-2])$/ : /^\d{4}-Q[1-4]$/).test(props.modelValue))
const invalid = computed(() => Boolean(props.modelValue) && !valid.value)
const descriptionId = computed(() => [invalid.value && `${pickerId}-error`, (!invalid.value || props.disabled) && `${pickerId}-hint`].filter(Boolean).join(' '))
// Element Plus Select does not forward arbitrary ARIA attributes to its input.
// Run after mount/update so both picker modes describe the actual focus target.
const vPeriodFeedback = (element, { value }) => {
  for (const input of element.querySelectorAll('input[role="combobox"]')) {
    input.setAttribute('aria-describedby', value.description)
    input.setAttribute('aria-invalid', String(value.invalid))
  }
}
function updateValue(value) { if (!props.disabled) emit('update:modelValue', value || '') }
const month = computed({ get: () => valid.value ? props.modelValue : '', set: updateValue })
const quarterCode = () => year.value && quarter.value ? `${year.value}-Q${quarter.value}` : ''
function updateQuarter() { updateValue(quarterCode()) }
watch(() => [props.modelValue, props.cadence], ([value, cadence], previous = []) => {
  // Keep a partially selected year/quarter when our own empty value is echoed.
  if (cadence === previous[1] && value === quarterCode()) return
  const parts = cadence === 'quarterly' && /^(\d{4})-Q([1-4])$/.exec(value)
  year.value = parts ? parts[1] : ''; quarter.value = parts ? parts[2] : ''
}, { immediate: true })
</script>
<style scoped>
.reporting-period-picker {
  container: reporting-period / inline-size;
  min-width: 0;
  --period-error-color: #b42318;
}
.reporting-period-picker label { display: flex; flex-direction: column; gap: 8px; font-size: 14px; line-height: 1.5; color: var(--el-text-color-regular); }
.quarter-controls { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.quarter-controls > label { min-width: 0; }
.reporting-period-picker :deep(.el-date-editor), .reporting-period-picker :deep(.el-select) { width: 100%; min-width: 0; flex: none; }
.period-hint, .period-warning { font-size: 14px; line-height: 1.6; margin: 8px 0 0; overflow-wrap: anywhere; }
.period-hint { color: var(--portal-muted, #6d5a65); }
.period-warning { color: var(--period-error-color); }
.has-period-error :deep(.el-input__wrapper), .has-period-error :deep(.el-select__wrapper) {
  box-shadow: 0 0 0 1px var(--period-error-color) inset;
}
.has-period-error :deep(.el-input__wrapper:focus-within), .has-period-error :deep(.el-select__wrapper:focus-within) {
  outline: 2px solid var(--period-error-color);
  outline-offset: 2px;
}
/* Reserve space for the full quarter label, including its month range and icons. */
@container reporting-period (min-width: 400px) {
  .quarter-controls { grid-template-columns: minmax(140px, .8fr) minmax(220px, 1.2fr); }
}
@media (max-width: 600px), (any-pointer: coarse) {
  .reporting-period-picker :deep(.el-input__wrapper), .reporting-period-picker :deep(.el-select__wrapper) { min-height: 44px; }
  .reporting-period-picker :deep(.el-date-editor.el-input) { height: 44px; }
  .reporting-period-picker :deep(.el-input__inner), .reporting-period-picker :deep(.el-select__wrapper) { font-size: 16px; }
}
</style>

<style>
/* Teleported panels need their own scoped theme; dialog variables do not reach them. */
.reporting-period-popper {
  --el-color-primary: #941966;
  --el-color-primary-light-3: #7a1454;
  --el-text-color-secondary: #6d5a65;
  max-width: calc(100vw - 16px);
}
.reporting-period-popper .el-picker-panel {
  max-width: calc(100vw - 18px);
  max-height: calc(100vh - 24px);
  max-height: calc(100dvh - 24px);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: #909399 #f8f3f6;
}
.reporting-period-popper .el-date-picker__content { width: auto; }
.reporting-period-popper .el-picker-panel__icon-btn { min-width: 44px; min-height: 44px; margin-top: 0; }
.reporting-period-popper .el-date-picker__header { display: flex; align-items: center; justify-content: space-between; }
.reporting-period-popper .el-date-picker__header-label { display: inline-flex; align-items: center; justify-content: center; flex: 1; min-height: 44px; border-radius: 4px; text-align: center; }
.reporting-period-popper .el-select-dropdown__item { min-height: 44px; height: auto; padding-block: 8px; line-height: 1.6; white-space: normal; overflow-wrap: anywhere; }
.reporting-period-popper .el-select-dropdown__item.is-selected { background: var(--el-color-primary-light-9); font-weight: 600; }
.reporting-period-popper :is(button, .el-date-picker__header-label):focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
@media (max-width: 600px), (any-pointer: coarse) {
  .reporting-period-popper :is(.el-select-dropdown__item, .el-month-table, .el-year-table) { font-size: 16px; }
}
</style>
