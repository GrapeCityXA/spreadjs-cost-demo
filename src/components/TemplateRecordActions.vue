<template>
  <div class="template-record-actions">
    <el-tooltip v-for="action in actions" :key="action.key" :content="action.tip" placement="top" :show-after="250" popper-class="template-help-tooltip" :trigger="['hover', 'focus']" :trigger-keys="[]">
      <el-button link :type="action.type" :disabled="action.disabled" :loading="action.loading" @click="emit('action', action.key, row)">{{ action.label }}</el-button>
    </el-tooltip>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import { templateRecordActions } from './templateRecordActions'
const props = defineProps({ kind: String, row: Object, maintain: Boolean, admin: Boolean, workflowFrom: [String, Array], busy: Boolean, modifyingVersionId: { type: Number, default: null } })
const emit = defineEmits(['action'])
const actions = computed(() => templateRecordActions(props.kind, props.row, props))
</script>
