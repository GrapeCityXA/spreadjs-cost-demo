<template>
  <div ref="page" class="guide-public-scroll">
    <a class="guide-skip-link" href="#guide-title" @click.prevent="skipToContent">跳到主要内容</a>
    <header class="guide-public-header">
      <router-link class="guide-public-brand" to="/guide">
        <strong>SpreadJS</strong><span>成本指标平台 · 场景导览</span>
      </router-link>
    </header>
    <Guide>
      <template #intro-actions>
        <router-link class="guide-primary" to="/portal/home">登录体验 <TopRight aria-hidden="true" /></router-link>
      </template>
    </Guide>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { TopRight } from '@element-plus/icons-vue'
import Guide from './Guide.vue'

const page = ref(null)
function skipToContent() {
  const heading = page.value?.querySelector('#guide-title')
  if (!heading) return
  heading.focus({ preventScroll: true })
  page.value.scrollTop = 0
}

onMounted(() => { document.title = 'SpreadJS 协同填报场景导览 · 成本指标平台' })
</script>

<style scoped>
.guide-public-scroll {
  position: relative;
  height: 100%;
  overflow: auto;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--guide-control-line) var(--guide-paper);
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  background: var(--guide-paper);
  color: var(--guide-ink);
  font-family: var(--font-sans);
}
.guide-skip-link {
  position: absolute;
  inset-block-start: 8px;
  inset-inline-start: 16px;
  z-index: 3;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.guide-skip-link:focus {
  width: auto;
  height: auto;
  min-height: 44px;
  padding: 10px 16px;
  clip-path: none;
  white-space: normal;
  color: var(--guide-blue);
  background: var(--guide-surface);
  outline: 3px solid var(--guide-blue);
  outline-offset: 2px;
}
.guide-public-header {
  max-width: 1480px;
  margin: 0 auto;
  padding: 24px 20px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.guide-public-brand {
  display: flex;
  align-items: center;
  min-height: 44px;
  flex-wrap: wrap;
  gap: 6px 16px;
  color: inherit;
  text-decoration: none;
}
.guide-public-brand strong { color: var(--guide-blue); font-size: 24px; letter-spacing: -.6px; }
.guide-public-brand span { font-size: 13px; color: var(--guide-muted); }
.guide-public-header a:focus-visible { outline: 3px solid var(--guide-blue); outline-offset: 4px; }
@media (max-width: 600px) {
  .guide-public-header { padding: 18px 16px 8px; gap: 12px; }
  .guide-public-brand { flex-direction: column; align-items: flex-start; justify-content: center; }
  .guide-public-brand span { max-width: 170px; font-size: 12px; }
}
</style>
