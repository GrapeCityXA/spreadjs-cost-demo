<template>
  <button type="button" class="catalog-insert-button" :class="variant === 'component' ? 'component-card' : 'field-card'" :disabled="disabled"
    :aria-label="`${action}：${title}`" :aria-describedby="hasDescription ? descriptionId : undefined" @click="$emit('select')">
    <span :class="variant === 'component' ? 'component-icon' : 'field-glyph'" aria-hidden="true">{{ glyph }}</span>
    <span class="field-copy"><strong :title="title">{{ title }}</strong><small v-if="hasDescription" :id="descriptionId" :title="description">{{ description }}</small></span>
    <el-tag size="small" :type="tone" :effect="variant === 'component' ? 'light' : 'plain'" aria-hidden="true">{{ action }}</el-tag>
  </button>
</template>

<script>
import { useId } from 'vue'

// Presentation only: the parent owns authorization, target selection and insertion.
export default {
  name: 'CatalogInsertButton',
  emits: ['select'],
  setup() {
    return { descriptionId: `catalog-description-${useId()}` }
  },
  computed: {
    hasDescription() { return typeof this.description === 'string' && this.description.trim().length > 0 }
  },
  props: {
    title: { type: String, required: true },
    description: { type: String, default: '' },
    glyph: { type: String, default: '' },
    action: { type: String, default: '添加' },
    disabled: { type: Boolean, default: false },
    tone: { type: String, default: 'primary', validator: value => ['primary', 'success', 'info', 'warning', 'danger'].includes(value) },
    variant: { type: String, default: 'field', validator: value => ['field', 'component'].includes(value) }
  }
}
</script>

<style src="@/styles/catalog-item.css"></style>
