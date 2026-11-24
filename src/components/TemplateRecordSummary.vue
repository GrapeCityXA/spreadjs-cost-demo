<template>
  <div class="template-summary" :aria-busy="loading">
    <ul v-if="rows.length" class="template-record-list" :aria-label="kind === 'component' ? '组件版本摘要' : '模板版本摘要'">
      <li v-for="row in rows" :key="row.versionId" class="template-record">
        <div class="template-record-heading">
          <h3>{{ kind === 'component' ? row.metadata?.name || row.code : row.name }}</h3>
          <el-tag :type="statusType[row.status] || 'info'">{{ statusLabel[row.status] || row.status }}</el-tag>
        </div>
        <dl class="template-record-facts">
          <div v-if="kind === 'component'"><dt>组件编码</dt><dd>{{ row.code }}</dd></div>
          <div><dt>版本</dt><dd>v{{ row.version }}</dd></div>
          <div v-if="kind === 'component'"><dt>类型</dt><dd>{{ typeLabel[row.componentType] || row.componentType }}</dd></div>
          <template v-else><div><dt>工作表</dt><dd>{{ row.sheetCount || 0 }} 张</dd></div><div v-if="scopeLabel(row.factory)"><dt>适用范围</dt><dd>{{ scopeLabel(row.factory) }}</dd></div></template>
          <div><dt>维护人</dt><dd>{{ row.ownerName || '未注明' }}<span v-if="Number(row.ownerId) === userId">（你）</span></dd></div>
        </dl>
        <TemplateRecordActions :kind="kind" :row="row" :maintain="canMaintain(row.ownerId)" :admin="admin" :workflow-from="workflowFrom" :busy="rowBusy(kind, row)" :modifying-version-id="modifyingVersionId" @action="(action, record) => emit('action', action, record)" />
      </li>
    </ul>
    <p v-else class="template-list-empty" role="status">{{ loading ? '正在加载版本…' : error || '暂无版本，或没有符合筛选条件的记录。' }}</p>
  </div>
</template>
<script setup>
import TemplateRecordActions from './TemplateRecordActions.vue'
defineProps({ kind: String, rows: Array, statusType: Object, statusLabel: Object, typeLabel: Object, scopeLabel: Function, canMaintain: Function, rowBusy: Function, userId: Number, admin: Boolean, workflowFrom: [String, Array], modifyingVersionId: { type: Number, default: null }, loading: Boolean, error: String })
const emit = defineEmits(['action'])
</script>
