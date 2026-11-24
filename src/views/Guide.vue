<template>
  <main ref="root" class="guide" aria-labelledby="guide-title">
    <header class="guide-intro">
      <div class="intro-copy">
        <h1 id="guide-title" tabindex="-1">让一张表，走完整个<br class="desktop-break" /><em>协同填报流程</em></h1>
        <p>从 Excel 模板到多人协作，再到审核与报表交付。<br />跟随成本指标平台，了解 SpreadJS 如何贯穿业务全程。</p>
        <div class="intro-actions">
          <slot name="intro-actions" />
          <a href="#design" :class="$slots['intro-actions'] ? 'guide-secondary' : 'guide-primary'" @click.prevent="goTo('design')">开始流程导览 <ArrowDown aria-hidden="true" /></a>
          <button type="button" class="guide-secondary" @click="watchVideo('full')"><VideoPlay aria-hidden="true" />观看完整演示</button>
        </div>
      </div>
      <figure class="intro-scene">
        <div class="scene-eyebrow"><strong>SpreadJS</strong><span>让熟悉的表格，成为协作空间</span></div>
        <button type="button" class="scene-button" aria-label="播放录屏：双人协同画面" @click="watchVideo('collaboration')"><img :src="scenes.collaborate.src" alt="两个账号并排打开同一任务，表格中呈现彩色协同选区" width="1600" height="900" fetchpriority="high" /><span class="scene-zoom">播放录屏 <VideoPlay aria-hidden="true" /></span></button>
        <figcaption><span>项目录屏画面</span> 两个账号，一张表；播放录屏观察修改同步。</figcaption>
        <button type="button" class="hero-play" @click="watchVideo('collaboration')"><VideoPlay aria-hidden="true" />1 分钟，看双人协同<ArrowRight aria-hidden="true" /></button>
      </figure>
    </header>

    <div class="guide-layout">
      <aside class="guide-index">
        <nav ref="readingIndex" aria-label="Guide 阅读目录">
          <p class="index-title">跟随业务流转</p>
          <a v-for="(step, index) in steps" :key="step.id" :href="'#' + step.id" :class="{ active: activeSection === step.id }" :aria-current="activeSection === step.id ? 'location' : undefined" @click.prevent="goTo(step.id)"><span>{{ String(index + 1).padStart(2, '0') }}</span>{{ step.short }}</a>
          <div class="index-secondary">
            <a v-for="section in sections" :key="section.id" :href="'#' + section.id" :class="{ active: activeSection === section.id }" :aria-current="activeSection === section.id ? 'location' : undefined" @click.prevent="goTo(section.id)">{{ section.label }}</a>
          </div>
        </nav>
        <p class="index-note">先看业务价值，<br />再展开技术解读。</p>
      </aside>

      <div class="guide-body">
        <section aria-labelledby="pipeline-title" class="pipeline">
          <div class="section-heading"><h2 id="pipeline-title">完整协同填报流水线</h2><p>以月度填报为主线，衔接季度评分与报表输出。</p></div>
          <ol class="pipeline-list">
            <li v-for="(step, index) in steps" :key="step.id" :aria-describedby="'phase-' + stepPhase[step.id]">
            <p v-if="phases[step.id]" :id="'phase-' + step.id" class="pipeline-phase">{{ phases[step.id] }}</p>
            <div :id="step.id" class="pipeline-step" :class="{ 'step-collaboration': step.id === 'collaborate' }" data-guide-section>
              <span class="step-number" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
              <article :aria-labelledby="step.id + '-title'">
                <div class="step-heading"><h3 :id="step.id + '-title'" tabindex="-1">{{ step.title }}</h3><span>{{ step.role }}</span></div>
                <div class="step-body" :class="{ 'has-scene': scenes[step.id], 'wide-scene': step.id === 'collaborate' }">
                  <div class="step-value"><h4>SpreadJS 的核心价值</h4><p>{{ step.value }}</p><ul class="capabilities" aria-label="相关产品能力"><li v-for="capability in step.capabilities" :key="capability">{{ capability }}</li></ul><div class="step-output"><span>本步产出</span><strong>{{ step.output }}</strong></div></div>
                  <figure v-if="scenes[step.id]" class="step-scene">
                    <button type="button" class="scene-button" :aria-label="(step.id === 'collaborate' ? '播放录屏：' : '放大看细节：') + scenes[step.id].title" @click="openScene(step.id)"><img :src="scenes[step.id].src" :alt="scenes[step.id].title" width="1600" height="900" loading="lazy" decoding="async" /><span class="scene-zoom"><template v-if="step.id === 'collaborate'">播放录屏 <VideoPlay aria-hidden="true" /></template><template v-else>放大看细节 <TopRight aria-hidden="true" /></template></span></button>
                    <figcaption>{{ scenes[step.id].caption }}<small>项目录屏画面</small></figcaption>
                  </figure>
                  <div v-else class="step-handoff"><span class="handoff-label">业务流转示意</span><ol><li v-for="(item, itemIndex) in transitions[step.id]" :key="item"><span>{{ itemIndex + 1 }}</span>{{ item }}</li></ol><p>{{ step.description }}</p></div>
                </div>
                <div class="step-actions">
                  <router-link v-if="canVisit(step.route)" :to="step.route">{{ step.action }}<ArrowRight aria-hidden="true" /></router-link>
                  <span v-else class="role-note">对应功能需使用{{ step.role.split(' / ')[0] }}账号体验</span>
                  <button v-for="id in step.videos" :key="id" type="button" @click="watchVideo(id)"><VideoPlay aria-hidden="true" />{{ videoLabel(id) }}</button>
                </div>
                <details class="technical-detail"><summary><span class="detail-expand">展开项目做法与技术解读</span><span class="detail-collapse">收起项目做法与技术解读</span></summary><p><strong>在这个项目中：</strong>{{ step.proof }}</p><p>{{ step.technical }}</p><div class="doc-links"><a v-for="key in step.docs" :key="key" :href="resources[key].url" target="_blank" rel="noopener noreferrer">{{ resources[key].label }}<TopRight aria-hidden="true" /><span class="sr-only">（新窗口）</span></a></div></details>
              </article>
            </div>
            </li>
          </ol>
          <div class="flow-return"><RefreshLeft aria-hidden="true" /><p><strong>流程也包含回路。</strong>退回后重新填报并生成新修订；定稿后的调整保留旧版本，下一个周期继续复用已发布模板。</p></div>
        </section>

        <section id="architecture" class="guide-section" data-guide-section aria-labelledby="architecture-title">
          <div class="section-heading"><h2 id="architecture-title" tabindex="-1">项目架构：表格能力与业务服务协作</h2><p>SpreadJS 提供表格交互、协同与报表呈现，项目服务负责业务规则和流程治理。</p></div>
          <div class="architecture">
            <div class="architecture-layer"><div class="layer-label">用户工作空间<small>Vue 3 · Element Plus</small></div><div class="layer-content">模板设计人员 <span>/</span> 填报与提交人员 <span>/</span> 审核与管理人员</div></div>
            <div class="architecture-layer spread-layer"><div class="layer-label">SpreadJS 表格层<small>19.2</small></div><div class="layer-content"><strong>Designer</strong><strong>协同工作簿</strong><strong>ReportSheet</strong><p>数据绑定、公式、自定义函数、数据验证、Excel / PDF 输出</p></div></div>
            <div class="architecture-transport"><span>业务请求 · HTTP / JWT</span><span>协同操作 · WebSocket</span></div>
            <div class="architecture-services"><div><h3>Express 业务服务</h3><p>模板与周期版本 · 任务分派 · 提交校验<br />审核评分 · 定稿调整 · 审计与导出</p></div><div><h3>SpreadJS 协同服务</h3><p>房间与共享文档 · OT 操作处理<br />在线状态 · 项目自定义的操作权限检查</p></div></div>
            <div class="architecture-storage"><div><h3>业务库</h3><code>business.db</code><p>权威业务记录、审批与版本</p></div><div><h3>协同库</h3><code>collaboration.db</code><p>编辑操作、快照与工作副本</p></div><div><h3>文件存储</h3><span>模板 / 正式成果</span><p>工作簿、XLSX、PDF 与附件</p></div></div>
            <div class="architecture-consumers"><strong>定稿数据的下游</strong><p>ReportSheet 报表与参考报表 <span>·</span> 无头浏览器中的 SpreadJS 导出 <span>·</span> ECharts 经营图表</p></div>
          </div>
          <details class="architecture-detail technical-detail"><summary>理解三个关键边界</summary><dl><div><dt>模板与数据分离</dt><dd>模板保存布局与绑定规则，运行时装配数据。更换周期时复用表样。</dd></div><div><dt>协同与审批分工</dt><dd>协同操作记录编辑过程，业务修订记录提交与审核。审批流由项目实现，审核查看静态提交版本。</dd></div><div><dt>模块按场景组合</dt><dd>实时填报和 ReportSheet 报表生成采用不同工作簿；外部数据源的一致性由数据服务保证，功能范围以对应模块文档为准。</dd></div></dl></details>
        </section>

        <section id="videos" class="guide-section" data-guide-section aria-labelledby="videos-title">
          <div class="section-heading"><h2 id="videos-title" tabindex="-1">在真实操作中，看见产品能力</h2><p>6 段项目录屏。可连贯观看全流程，也可以按能力选择片段。</p></div>
          <div class="video-gallery">
            <button v-for="video in videos" :key="video.id" type="button" class="video-card" @click="watchVideo(video.id)">
              <span class="video-cover"><img :src="videoMedia[video.id].poster" alt="" width="1600" height="900" loading="lazy" decoding="async" /><span class="video-play-icon"><VideoPlay aria-hidden="true" /></span><span class="video-duration">{{ videoMedia[video.id].duration }}</span></span>
              <span class="video-card-copy"><strong>{{ video.title }}</strong><small>{{ video.stage }}</small><span>{{ video.description }}</span><em>观看录屏 <ArrowRight aria-hidden="true" /></em></span>
            </button>
          </div>
        </section>

        <section id="resources" class="guide-section" data-guide-section aria-labelledby="resources-title">
          <div class="section-heading"><h2 id="resources-title" tabindex="-1">继续探索 SpreadJS</h2><p>从本项目的应用场景，深入到官方能力说明与接入文档。</p></div>
          <div class="resource-list"><a v-for="resource in resources" :key="resource.url" :href="resource.url" target="_blank" rel="noopener noreferrer">{{ resource.label }}<TopRight aria-hidden="true" /><span class="sr-only">（新窗口）</span></a></div>
          <p class="resource-note">以上能力说明已通过 SpreadJS 官方文档核对；设计器与扩展模块的部署许可及支持范围，以对应产品文档为准。</p>
        </section>
        <footer class="guide-footer"><span>成本指标平台 · SpreadJS 场景导览</span><a href="#guide-title" @click.prevent="goTo('guide-title')">返回顶部<ArrowUp aria-hidden="true" /></a></footer>
      </div>
    </div>
    <dialog ref="mediaDialog" class="guide-media-dialog" :aria-labelledby="'media-title'" @close="onMediaClosed" @click.self="closeMedia">
      <template v-if="mediaType">
        <header class="media-dialog-heading"><div><h2 id="media-title">{{ mediaType === 'image' ? selectedScene.title : selectedVideo.title }}</h2><span>{{ mediaType === 'image' ? '项目录屏画面 · 点击原尺寸可查看小字' : '项目实操录屏 · 打开后自动播放' }}</span></div><button type="button" class="media-close" autofocus aria-label="关闭预览，返回刚才位置" @click="closeMedia">关闭 <Close aria-hidden="true" /></button></header>
        <div v-if="mediaType === 'image'" class="image-viewer" :class="{ 'original-size': originalSize }" :tabindex="originalSize ? 0 : undefined" role="region" :aria-label="originalSize ? '原尺寸截图，可滑动或使用方向键查看细节' : '截图预览'"><img :src="selectedScene.src" :alt="selectedScene.title" width="1600" height="900" /></div>
        <video v-else :key="selectedVideo.id" ref="player" :src="selectedVideoSrc" :poster="videoMedia[selectedVideo.id].poster" controls playsinline preload="none" :aria-label="selectedVideo.title" @error="videoError = true">当前浏览器不支持视频播放，请使用下方链接打开录屏。</video>
        <div class="media-dialog-footer">
          <p>{{ mediaType === 'image' ? selectedScene.caption : selectedVideo.description }}</p>
          <template v-if="mediaType === 'image'">
            <button type="button" class="guide-secondary" :aria-pressed="originalSize" @click="originalSize = !originalSize">{{ originalSize ? '适应窗口' : '查看原尺寸' }}</button>
            <span v-if="originalSize" class="image-pan-hint">滑动或使用方向键查看细节</span>
          </template>
          <template v-else><span>{{ videoMedia[selectedVideo.id].duration }} · {{ selectedVideo.size }}</span><a :href="selectedVideoSrc" target="_blank" rel="noopener noreferrer">打开原视频 <TopRight aria-hidden="true" /><span class="sr-only">（新窗口）</span></a></template>
        </div>
        <p v-if="videoError && mediaType === 'video'" class="video-error" role="alert">视频暂时无法播放，请重试或打开原视频。<button type="button" @click="retryVideo">重新加载</button></p>
      </template>
    </dialog>
  </main>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowDown, ArrowUp, ArrowRight, TopRight, VideoPlay, RefreshLeft, Close } from '@element-plus/icons-vue'
import { steps, videos, resources } from '@/content/guide'
import { guideVideoUrl } from '@/utils/runtimeConfig'
import { scenes, videoMedia, phases, transitions } from '@/content/guideMedia'
import { subscribeSessionUser } from '@/utils/authSession'
import { canShowGuideEntry } from '@/utils/guideAccess'
import '@/styles/guide.css'
import '@/styles/guide-media.css'

const router = useRouter()
const route = useRoute()
const root = ref(null)
const readingIndex = ref(null)
const player = ref(null)
const mediaDialog = ref(null)
const mediaType = ref(null)
const selectedScene = ref(null)
const originalSize = ref(false)
let mediaTrigger, mediaScrollTop = 0, mediaOverflow, mediaHash
const activeSection = ref('design')
const selectedVideoId = ref('full')
const selectedVideo = computed(() => videos.find(video => video.id === selectedVideoId.value) || videos[0])
const selectedVideoSrc = computed(() => selectedVideo.value ? guideVideoUrl(selectedVideo.value.file) : '')
const videoError = ref(false)
const user = ref({})
const sections = [{ id: 'architecture', label: '项目架构' }, { id: 'videos', label: '演示视频' }, { id: 'resources', label: '官方资料' }]
const sectionIds = new Set(['guide-title', ...steps.map(step => step.id), ...sections.map(section => section.id)])
let phaseId
const stepPhase = Object.fromEntries(steps.map(step => {
  if (phases[step.id]) phaseId = step.id
  return [step.id, phaseId]
}))
let unsubscribe, scrollRoot, frame

function canVisit(path) {
  return canShowGuideEntry(user.value, router.resolve(path).meta)
}
function goTo(id) {
  if (!sectionIds.has(id)) return
  if (route.hash === '#' + id) return scrollToSection(id)
  return router.push({ path: route.path, query: route.query, hash: '#' + id })
}
function sectionFromHash(hash) {
  try {
    const id = decodeURIComponent(hash.slice(1))
    return sectionIds.has(id) ? id : 'guide-title'
  } catch { return 'guide-title' }
}
function scrollToSection(id, animate = true) {
  if (!scrollRoot || !sectionIds.has(id)) return
  const target = root.value?.querySelector(`[id="${id}"]`)
  if (!target) return
  const heading = target.matches('h1, h2, h3') ? target : target.querySelector('h2, h3')
  heading?.setAttribute('tabindex', '-1')
  heading?.focus({ preventScroll: true })
  const index = readingIndex.value?.parentElement
  const compactIndex = getComputedStyle(root.value.querySelector('.guide-layout')).display === 'block'
  const margin = Math.max(parseFloat(getComputedStyle(target).scrollMarginTop) || 20,
    compactIndex ? (index?.getBoundingClientRect().height || 0) + 12 : 0)
  // A phase opening belongs to its first step and should remain visible on arrival.
  const phase = target.previousElementSibling
  const scrollTarget = phase?.classList.contains('pipeline-phase') ? phase : target
  scrollRoot?.scrollTo({
    top: id === 'guide-title' ? 0 : scrollRoot.scrollTop + scrollTarget.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top - margin,
    behavior: !animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  })
  activeSection.value = id === 'guide-title' ? 'design' : id
}
async function showMedia(type) {
  mediaHash = route.hash
  mediaTrigger = document.activeElement
  mediaScrollTop = scrollRoot?.scrollTop || 0
  mediaOverflow = scrollRoot?.style.overflow
  if (scrollRoot) scrollRoot.style.overflow = 'hidden'
  mediaType.value = type
  videoError.value = false
  originalSize.value = false
  await nextTick()
  mediaDialog.value?.showModal()
  if (scrollRoot) scrollRoot.scrollTop = mediaScrollTop
}
async function watchVideo(id) {
  selectedVideoId.value = id
  await showMedia('video')
  const video = player.value
  if (!video) return
  try {
    await video.play()
  } catch {
    // Some browsers still block unmuted playback; start muted so the clip
    // plays, and keep controls available for the viewer to unmute.
    video.muted = true
    try { await video.play() } catch {}
  }
}
function openScene(id) {
  if (id === 'collaborate') return watchVideo('collaboration')
  return openImage(scenes[id])
}
function openImage(scene) {
  selectedScene.value = scene
  return showMedia('image')
}
function closeMedia() { mediaDialog.value?.close() }
function onMediaClosed() {
  player.value?.pause()
  mediaType.value = null
  if (scrollRoot) {
    scrollRoot.style.overflow = mediaOverflow || ''
    if (route.hash === mediaHash) scrollRoot.scrollTop = mediaScrollTop
  }
  if (route.hash !== mediaHash) scrollToSection(sectionFromHash(route.hash), false)
  else mediaTrigger?.focus({ preventScroll: true })
}
function retryVideo() { videoError.value = false; player.value?.load() }
function videoLabel(id) {
  return ({ full: '完整流程录屏', import: '导入模板录屏', composition: '组件组合录屏', data: '数据接入录屏', collaboration: '协同演示录屏', analysis: '勾稽分析录屏' })[id]
}
function trackSection() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = null
    const top = (scrollRoot?.getBoundingClientRect().top || 0) + 140
    const candidates = [...root.value.querySelectorAll('[data-guide-section]')]
    const current = candidates.filter(section => section.getBoundingClientRect().top <= top).at(-1)
    const atEnd = scrollRoot && scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 2
    activeSection.value = atEnd ? 'resources' : current?.id || 'design'
  })
}
// Reveal the current chapter in the horizontal strip without moving page focus
// or scrolling the document (scrollIntoView would also move ancestor containers).
function revealActiveIndex() {
  const nav = readingIndex.value
  const active = nav?.querySelector('[aria-current="location"]')
  if (!active || nav.scrollWidth <= nav.clientWidth) return
  const bounds = nav.getBoundingClientRect()
  const link = active.getBoundingClientRect()
  if (link.left < bounds.left || link.right > bounds.right) {
    nav.scrollTo({ left: nav.scrollLeft + link.left - bounds.left - (nav.clientWidth - link.width) / 2, behavior: 'instant' })
  }
}
watch(activeSection, revealActiveIndex, { flush: 'post' })
watch(() => route.hash, hash => {
  if (mediaType.value) closeMedia()
  else scrollToSection(sectionFromHash(hash))
}, { flush: 'post' })
function onResize() { trackSection(); revealActiveIndex() }
onMounted(() => {
  unsubscribe = subscribeSessionUser(value => { user.value = value || {} })
  scrollRoot = root.value.closest('.guide-public-scroll, .portal-content')
  scrollRoot?.addEventListener('scroll', trackSection, { passive: true })
  window.addEventListener('resize', onResize)
  if (route.hash) scrollToSection(sectionFromHash(route.hash), false)
  trackSection()
})
onBeforeUnmount(() => {
  if (mediaType.value && scrollRoot) scrollRoot.style.overflow = mediaOverflow || ''
  unsubscribe?.()
  scrollRoot?.removeEventListener('scroll', trackSection)
  window.removeEventListener('resize', onResize)
  if (frame) cancelAnimationFrame(frame)
  player.value?.pause()
})
</script>
