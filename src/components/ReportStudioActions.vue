<template>
  <div class="studio-record-actions">
    <template v-if="section === 'templates'">
      <el-button link type="primary" @click="act('view')">查看</el-button>
      <el-button v-if="capabilities.design && row.status !== 'in_review'" link type="primary" @click="act('edit')">{{ row.status === 'published' ? '创建新版本' : '修改' }}</el-button>
      <el-button v-if="row.status === 'published' && capabilities.manage" link type="primary" @click="act('generate')">生成</el-button>
      <template v-if="row.status === 'in_review' && capabilities.approve && workflowFrom">
        <el-button link type="success" :loading="busy.has(`review:${row.id}`)" :disabled="busy.has(`review:${row.id}`)" @click="act('approve')">批准发布</el-button>
        <el-button link type="danger" :loading="busy.has(`review:${row.id}`)" :disabled="busy.has(`review:${row.id}`)" @click="act('reject')">退回</el-button>
      </template>
      <el-button v-else-if="row.status === 'in_review' && capabilities.approve" link type="primary" @click="act('workflow')">前往审批</el-button>
    </template>
    <el-button v-else-if="section === 'schedules' && capabilities.manage" link type="primary" :loading="busy.has(`schedule:${row.id}`)" :disabled="busy.has(`schedule:${row.id}`)" @click="act('toggle')">{{ row.enabled ? '暂停' : '启用' }}</el-button>
    <template v-else-if="section === 'results'">
      <template v-if="row.status === 'complete'">
        <el-button link type="primary" @click="act('preview')">预览与来源</el-button>
        <el-button class="studio-download" link type="primary" :loading="busy.has(`download:${row.id}:xlsx`)" @click="act('xlsx')">Excel</el-button>
        <el-button class="studio-download" link type="primary" :loading="busy.has(`download:${row.id}:pdf`)" @click="act('pdf')">PDF</el-button>
      </template>
      <el-button v-if="row.status === 'failed' && capabilities.manage" link type="primary" :loading="busy.has(`retry:${row.id}`)" :disabled="busy.has(`retry:${row.id}`)" @click="act('retry')">重新生成</el-button>
    </template>
  </div>
</template>
<script setup>
const props = defineProps({ section: String, row: { type: Object, required: true }, capabilities: { type: Object, required: true }, busy: { type: Set, required: true }, workflowFrom: [String, Array] })
const emit = defineEmits(['action'])
const act = action => emit('action', action, props.row)
</script>
