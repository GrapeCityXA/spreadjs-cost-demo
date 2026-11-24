<template>
  <div class="studio-summary">
    <ul v-if="rows.length" class="studio-record-list" :aria-label="`${title}摘要`">
      <li v-for="row in rows" :key="row.id" class="studio-record">
        <div class="studio-record-heading">
          <h2>{{ row.name || '未命名' }}</h2>
          <el-tag v-if="section === 'schedules'" :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '运行中' : '已暂停' }}</el-tag>
          <el-tag v-else :type="tagType(row.status)">{{ labels[row.status] || '状态未知' }}</el-tag>
        </div>
        <dl class="studio-record-facts">
          <template v-if="section === 'schedules'">
            <div><dt>模板版本</dt><dd>{{ templateLabel(row.template_id) }}</dd></div>
            <div><dt>生成时间</dt><dd>每月 {{ row.day }} 日 {{ row.time }}（北京时间）</dd></div>
            <div><dt>报告期间</dt><dd>{{ row.month_offset === -1 ? '上月' : '当月' }}</dd></div>
            <div><dt>下次运行</dt><dd>{{ formatTime(row.next_run) }}</dd></div>
          </template>
          <template v-else>
            <div v-if="section === 'results'"><dt>报告期间</dt><dd>{{ row.query?.periodCode || '未注明' }}</dd></div>
            <div><dt>模板版本</dt><dd>V{{ row.version }}</dd></div>
            <div><dt>{{ section === 'templates' ? '创建时间' : '生成时间' }}</dt><dd>{{ formatTime(row.created_at) }}</dd></div>
          </template>
        </dl>
        <p v-if="row.error_text" class="studio-record-error">{{ row.error_text }}</p>
        <ReportStudioActions :section="section" :row="row" :capabilities="capabilities" :busy="busy" :workflow-from="workflowFrom" @action="(action, record) => emit('action', action, record)" />
      </li>
    </ul>
    <p v-else class="studio-empty" role="status">暂无{{ title }}，或没有符合筛选条件的记录。</p>
  </div>
</template>
<script setup>
import ReportStudioActions from './ReportStudioActions.vue'
defineProps({ section: String, title: String, rows: Array, capabilities: Object, busy: Set, workflowFrom: [String, Array], labels: Object, tagType: Function, templateLabel: Function, formatTime: Function })
const emit = defineEmits(['action'])
</script>
