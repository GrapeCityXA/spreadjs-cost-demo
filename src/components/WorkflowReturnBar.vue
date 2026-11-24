<template>
  <nav v-if="destination" class="workflow-return-bar" aria-label="流程返回">
    <router-link v-slot="{ href }" :to="destination" custom>
      <a ref="returnLink" class="workflow-return-link" :href="href" :aria-disabled="returning || undefined" :aria-busy="returning || undefined" @click="returnToList">
        <el-icon class="return-icon" aria-hidden="true"><ArrowLeft /></el-icon><span>{{ returning ? `正在返回${label}…` : `返回${label}` }}</span>
      </a>
    </router-link>
    <span class="workflow-return-context">流程中心 / {{ label }} / <span aria-current="page">{{ currentPageTitle }}</span></span>
    <p v-if="navigationError" class="workflow-return-error" role="alert">
      <span>{{ navigationError }}</span><el-button text class="workflow-return-retry" @click="returnToList">重试返回</el-button>
    </p>
  </nav>
</template>
<script>
import { workflowReturnLocation } from '@/utils/workflowNavigation'
import { ArrowLeft } from '@element-plus/icons-vue'
import { isNavigationFailure, NavigationFailureType } from 'vue-router'

export default {
  components: { ArrowLeft },
  data: () => ({ returning: false, navigationError: '', navigationSequence: 0 }),
  computed: {
    destination() { return workflowReturnLocation(this.$route) },
    label() { return ({ todo: '我的待办', initiated: '我发起的', handled: '我的已办', manage: '流程管理', start: '发起流程' })[this.$route.query.workflowFrom] || '流程中心' },
    currentPageTitle() {
      const title = this.$route.meta?.title
      return typeof title === 'string' && title.trim() ? title.trim() : '当前页面'
    }
  },
  watch: {
    '$route.fullPath'() { this.resetNavigation() }
  },
  beforeUnmount() { this.resetNavigation() },
  methods: {
    resetNavigation() { this.navigationSequence++; this.returning = false; this.navigationError = '' },
    async returnToList(event) {
      // Let the browser handle modified clicks and new-tab navigation normally.
      if (event?.defaultPrevented || event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.altKey || (event?.button != null && event.button !== 0)) return
      event?.preventDefault()
      if (this.returning || !this.destination) return
      const destination = this.destination
      const failureMessage = `暂时无法返回“${this.label}”，请重试。`
      const origin = this.$route.fullPath
      const sequence = ++this.navigationSequence
      const trigger = event?.currentTarget
      const hadFocus = trigger && document.activeElement === trigger
      const isCurrent = () => sequence === this.navigationSequence && this.$route.fullPath === origin
      this.returning = true
      this.navigationError = ''
      try {
        const failure = await this.$router.push(destination)
        if (!isCurrent()) return
        // A cancelled leave confirmation or superseded navigation is not an error.
        if (failure && !isNavigationFailure(failure, NavigationFailureType.aborted | NavigationFailureType.cancelled | NavigationFailureType.duplicated)) {
          this.navigationError = failureMessage
        }
      } catch {
        if (isCurrent()) this.navigationError = failureMessage
      } finally {
        if (isCurrent()) {
          this.returning = false
          await this.$nextTick()
          if (isCurrent() && hadFocus && (document.activeElement === trigger || document.activeElement === document.body)) this.$refs.returnLink?.focus()
        }
      }
    }
  }
}
</script>
<style scoped>
.workflow-return-bar { display:flex; flex-wrap:wrap; align-items:center; gap:4px 16px; padding:4px 12px; background:var(--portal-surface,#fff); border-bottom:1px solid var(--portal-line,#e8d9e1); }
.workflow-return-link { display:inline-flex; align-items:center; gap:8px; flex:none; max-width:100%; min-height:32px; box-sizing:border-box; padding:6px 12px; border-radius:4px; color:var(--portal-focus,#941966); font-size:14px; line-height:1.5; text-decoration:none; overflow-wrap:anywhere; }
.workflow-return-link:not([aria-busy="true"]):hover { background:var(--portal-paper,#f8f3f6); text-decoration:underline; text-underline-offset:3px; }
.workflow-return-link:not([aria-busy="true"]):active { background:var(--portal-accent-surface,#f8ebf3); }
.workflow-return-link[aria-busy="true"] { cursor:progress; }
.workflow-return-link > span { min-width:0; }
.return-icon { flex:none; font-size:16px; }
.workflow-return-context { flex:1 1 14rem; min-width:0; color:var(--portal-muted,#6d5a65); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
.workflow-return-context [aria-current="page"] { color:var(--portal-ink,#2c1b26); font-weight:600; }
.workflow-return-link:focus-visible, .workflow-return-retry:focus-visible { outline:2px solid var(--portal-focus,#941966); outline-offset:-2px; }
.workflow-return-error { display:flex; flex-wrap:wrap; align-items:center; gap:4px 12px; flex-basis:100%; min-width:0; margin:0; padding-inline:12px; color:#b42318; font-size:14px; line-height:1.6; overflow-wrap:anywhere; }
.workflow-return-error > span { min-width:0; }
.workflow-return-retry { min-height:32px; height:auto; margin:0; padding:6px 0; color:var(--portal-focus,#941966); line-height:1.5; white-space:normal; }
.workflow-return-retry:hover { text-decoration:underline; text-underline-offset:3px; }
@media (max-width:1023px), (any-pointer:coarse) {
  .workflow-return-link, .workflow-return-retry { min-height:44px; font-size:16px; }
  .workflow-return-context { font-size:14px; }
}
@media (max-width:639px) {
  .workflow-return-bar { padding:4px 4px 8px; gap:0 12px; }
  .workflow-return-context { flex-basis:100%; padding-inline:12px; box-sizing:border-box; }
}
</style>
