<template>
  <div v-if="showcase" class="demo-next" role="note">
    <span class="demo-next-text">{{ text }}</span>
    <el-button size="small" type="primary" plain :loading="busy" @click="next">{{ label }}</el-button>
  </div>
</template>

<script>
import { SHOWCASE } from '@/config/showcase'
import { switchDemoIdentity } from '@/utils/demoSession'

export default {
  name: 'DemoNextStep',
  props: {
    text: { type: String, required: true },
    label: { type: String, required: true },
    to: { type: String, required: true },
    role: { type: String, default: '' }
  },
  data() { return { showcase: SHOWCASE, busy: false } },
  methods: {
    async next() {
      if (this.busy) return
      this.busy = true
      try {
        if (this.role) {
          await switchDemoIdentity(this.role)
          // A full reload drops the previous identity's collaboration room and task state.
          window.location.assign(`${import.meta.env.BASE_URL}${this.to.replace(/^\/+/, '')}`)
          return
        }
        const failure = await this.$router.push(this.to)
        if (failure) this.$message?.warning?.('暂时无法打开目标页面')
      } catch (error) {
        this.$message?.error?.(error?.message || '切换演示视角失败')
      } finally {
        this.busy = false
      }
    }
  }
}
</script>

<style scoped>
.demo-next {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin: 0 0 18px;
  padding: 10px 14px;
  border: 1px solid #e6c9da;
  border-left: 3px solid #941966;
  background: #fbf4f8;
  border-radius: 4px;
  font-size: 13px;
  color: #4a233b;
}
.demo-next-text { min-width: 0; }
.demo-next :deep(.el-button--primary.is-plain) {
  --el-button-text-color: #941966;
  --el-button-border-color: #d0a0bd;
  --el-button-bg-color: #fff;
  --el-button-hover-text-color: #fff;
  --el-button-hover-bg-color: #941966;
  --el-button-hover-border-color: #941966;
}
</style>
