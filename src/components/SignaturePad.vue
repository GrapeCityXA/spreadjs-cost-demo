<template>
  <el-dialog :model-value="modelValue" class="signature-dialog" title="手写签名" width="min(720px, calc(100vw - 24px))" top="12px" destroy-on-close
    header-class="signature-dialog-header" body-class="signature-dialog-body" footer-class="signature-dialog-footer"
    :close-on-click-modal="false" :show-close="!locked" :close-on-press-escape="!locked"
    :before-close="requestClose" @opened="initialize">
    <p class="signature-location">{{ location }}<span>在下方用鼠标或手指签名，再点击“保存签名”。{{ existingImage ? '保存后将替换原签名。' : '' }}</span></p>
    <div v-if="existingImage" class="signature-previous"><span>打开画板时的签名</span><img :src="existingImage" alt="打开画板时单元格中的签名" /></div>
    <p v-if="loading || locked" class="signature-status" role="status">{{ locked ? '正在保存签名，请等待结果。' : '正在加载画板，请稍候…' }}</p>
    <div ref="padHost" class="signature-pad" :class="{ 'is-ready': initialized, 'is-locked': locked || confirming }"
      :style="padAspect ? { maxWidth: `calc(var(--signature-pad-height) * ${padAspect})` } : undefined"
      :inert="locked || loading || confirming" :aria-busy="loading || locked" role="img" aria-label="手写签名画板"
      @touchstart.capture="guardTouches" @touchcancel="endStroke" />
    <p v-if="error" role="alert" class="signature-error">{{ error }}</p>
    <p v-if="confirming" role="alert" class="signature-discard">{{ saveAttempted ? '关闭将丢弃画板中的笔画。刚才的保存结果尚未确认，关闭后请到表格核对签名。' : '本次笔画尚未保存。关闭将丢弃这些笔画，单元格中的签名不会因此改变。' }}</p>
    <template #footer>
      <div class="signature-actions">
        <template v-if="confirming">
          <el-button ref="continueButton" type="primary" @click="continueSigning">继续签名</el-button>
          <el-button :disabled="locked" @click="discard">放弃并关闭</el-button>
        </template>
        <template v-else>
          <el-button v-if="!initialized && error" class="signature-reset" :disabled="loading || locked" @click="initialize">重新加载画板</el-button>
          <el-button v-else class="signature-reset" :disabled="!initialized || locked || !hasInk" @click="clear">清空重签</el-button>
          <el-button :disabled="locked" @click="requestClose">关闭</el-button>
          <el-button type="primary" :disabled="!hasInk || !initialized || locked" :loading="locked" @click="finish">保存签名</el-button>
        </template>
      </div>
    </template>
  </el-dialog>
</template>

<script>
import $ from 'jquery'
import { isSignatureImage } from '@/template/signatureCell'
let pluginReady
async function loadPlugin() {
  if (!pluginReady) {
    // The upstream jSignature distribution registers against window.jQuery.
    window.jQuery = window.$ = $
    pluginReady = import('jsignature').catch(error => { pluginReady = null; throw error })
  }
  await pluginReady
}
export default {
  props: { modelValue: Boolean, location: String, existingImage: String, busy: Boolean, save: { type: Function, required: true } },
  emits: ['update:modelValue'],
  data: () => ({ initialized: false, hasInk: false, error: '', generation: 0, loading: false, saving: false, confirming: false, padAspect: null, saveAttempted: false }),
  computed: { locked() { return this.busy || this.saving } },
  watch: {
    modelValue(value) { if (!value) this.dispose() },
    locked(value) {
      if (!value && this.modelValue && this.$refs.padHost && !this.initialized && !this.loading && !this.error) void this.initialize()
    }
  },
  mounted() {
    window.addEventListener('beforeunload', this.beforeUnload)
    window.addEventListener('blur', this.endStroke)
  },
  beforeUnmount() {
    this.dispose()
    window.removeEventListener('beforeunload', this.beforeUnload)
    window.removeEventListener('blur', this.endStroke)
  },
  methods: {
    isCurrent(generation) { return this.modelValue && generation === this.generation },
    async initialize() {
      if (!this.modelValue || this.loading || this.initialized || this.locked) return
      const generation = ++this.generation
      this.error = ''; this.hasInk = false; this.loading = true
      try {
        await loadPlugin()
        if (!this.isCurrent(generation) || !this.$refs.padHost) return
        this._pad = $(this.$refs.padHost)
        // jSignature scales both axes on resize; its canvas must keep the same aspect ratio.
        const sizeRatio = Math.max(1, this.$refs.padHost.clientWidth) / (this.$refs.padHost.clientHeight || 250)
        this.padAspect = sizeRatio
        this._pad.jSignature({ width: '100%', height: 'ratio', sizeRatio, color: '#172b4d', lineWidth: 3, 'background-color': '#fff', 'decor-color': 'transparent', showUndoButton: false })
        this._pad.on('change.signature', () => {
          if (this.isCurrent(generation) && this._pad) this.hasInk = this._pad.jSignature('getData', 'native').length > 0
        })
        this.initialized = true
      } catch {
        if (this.isCurrent(generation)) {
          this.destroyPad()
          this.error = '画板未能加载。请点击“重新加载画板”；若仍失败，请检查网络或联系管理员。'
        }
      } finally { if (this.isCurrent(generation)) this.loading = false }
    },
    endStroke() {
      // Use the plugin's window mouseup listener to settle interrupted touch/blur strokes.
      if (this._pad && this.initialized && !this.locked) $(window).triggerHandler('mouseup')
    },
    guardTouches(event) {
      if (event.touches.length > 1) { this.endStroke(); event.preventDefault(); event.stopImmediatePropagation() }
    },
    beforeUnload(event) {
      if (this.modelValue && (this.hasInk || this.locked)) { event.preventDefault(); event.returnValue = '' }
    },
    async requestClose() {
      if (this.locked) return
      this.endStroke()
      if (!this.hasInk) { this.discard(); return }
      this.confirming = true
      await this.$nextTick()
      this.$refs.continueButton?.$el?.focus()
    },
    continueSigning() { this.confirming = false },
    discard() {
      if (this.locked) return
      this.dispose()
      this.$emit('update:modelValue', false)
    },
    clear() {
      if (!this.initialized || this.locked || this.confirming) return
      this.endStroke(); this._pad.jSignature('reset'); this.hasInk = false; this.error = ''
    },
    async finish() {
      if (!this.modelValue || !this.initialized || !this.hasInk || this.locked || this.confirming) return
      this.endStroke()
      const generation = this.generation
      this.saving = true; this.error = ''
      try {
        const image = this._pad.jSignature('getData', 'image')
        const dataUrl = `data:${image[0]},${image[1]}`
        if (!isSignatureImage(dataUrl)) throw new Error('未能生成可保存的签名图片，请点击“清空重签”后重试。')
        this.saveAttempted = true
        await this.save(dataUrl)
        if (this.isCurrent(generation)) { this.dispose(); this.$emit('update:modelValue', false) }
      } catch (error) {
        if (this.isCurrent(generation)) this.error = `${error?.message || '保存结果尚未确认，请检查连接后重试。'} 当前笔画已保留，关闭画板会清空这些笔画。`
      } finally { if (this.isCurrent(generation)) this.saving = false }
    },
    destroyPad() {
      const pad = this._pad
      this._pad = null; this.initialized = false
      try { pad?.off('.signature'); pad?.jSignature('destroy') } catch { /* Partial plugin initialization may not have a canvas yet. */ }
    },
    dispose() {
      this.generation++
      this.destroyPad()
      this.hasInk = false; this.loading = false; this.saving = false; this.confirming = false; this.error = ''; this.padAspect = null; this.saveAttempted = false
    }
  }
}
</script>

<style scoped>
:global(.el-dialog.signature-dialog) {
  display:flex; flex-direction:column; max-height:calc(100vh - 24px); max-height:calc(100dvh - 24px);
  margin-block:12px; padding:0; overflow:hidden;
  --signature-pad-height:clamp(144px, calc(100dvh - 224px), 250px);
}
:global(.signature-dialog .signature-dialog-header) { flex:none; margin:0; padding:16px 52px 12px 16px }
:global(.signature-dialog .el-dialog__title) { font-size:20px; font-weight:600; line-height:24px; color:var(--portal-ink, #2c1b26) }
:global(.signature-dialog button:focus-visible) { outline:2px solid var(--portal-focus, #941966); outline-offset:2px }
:global(.signature-dialog ::selection) { background:var(--portal-accent-surface, #f8ebf3); color:var(--portal-ink, #2c1b26) }
:global(.signature-dialog .signature-dialog-body) {
  min-height:0; padding:0 16px 16px; overflow-y:auto; overscroll-behavior:contain;
  scrollbar-gutter:stable; scrollbar-color:#8e9ba8 #f4ecef;
}
:global(.signature-dialog .signature-dialog-footer) {
  flex:none; padding:12px 16px max(12px, env(safe-area-inset-bottom));
  border-top:1px solid var(--portal-line, #e8d9e1); background:var(--portal-surface, #fff);
}
.signature-location { margin:0 0 16px; font-weight:600; line-height:1.5; color:var(--el-text-color-primary); overflow-wrap:anywhere }
.signature-location span { display:block; margin-top:6px; font-size:14px; line-height:1.5; font-weight:400; color:var(--portal-muted, #6d5a65) }
.signature-pad { width:100%; min-height:var(--signature-pad-height, 250px); margin-inline:auto; overflow:hidden; border:1px solid var(--el-border-color); border-radius:8px; background:#fff; touch-action:none }
.signature-pad.is-ready { min-height:0 }
.signature-pad.is-locked { pointer-events:none }
.signature-previous { display:flex; flex-wrap:wrap; align-items:center; gap:16px; margin-bottom:12px; color:var(--portal-muted, #6d5a65) }
.signature-previous img { max-width:min(180px, 100%); height:58px; padding:4px; object-fit:contain; border:1px solid var(--el-border-color-lighter); border-radius:4px; background:#fff }
.signature-error, .signature-discard { margin:12px 0 0; padding:12px; border:1px solid; border-radius:6px; font-size:14px; line-height:1.5; overflow-wrap:anywhere }
.signature-error { color:var(--error-text, #b42318); border-color:var(--error-line, #e8b4ae); background:var(--error-surface, #fff5f4) }
.signature-discard { color:var(--portal-ink, #2c1b26); border-color:var(--portal-line, #e8d9e1); background:var(--portal-paper, #f8f3f6) }
.signature-status { margin:0 0 12px; color:var(--portal-muted, #6d5a65); font-size:14px; line-height:1.5; overflow-wrap:anywhere }
.signature-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; --el-color-primary:var(--portal-focus, #941966); --el-color-primary-light-3:#7a1454; --el-color-primary-dark-2:#6f114b }
.signature-actions .el-button { min-height:44px; margin:0 }
.signature-actions .signature-reset { margin-inline-end:auto }
@media (max-width: 480px) {
  .signature-location { font-size:16px; line-height:1.5; margin-bottom:12px }
  .signature-previous { gap:8px }
  .signature-actions { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)) }
  .signature-actions .el-button { min-width:0; white-space:normal; height:auto; font-size:16px; padding:10px 12px }
  .signature-actions .signature-reset { margin-inline-end:0 }
  .signature-actions .el-button:last-child:nth-child(3) { grid-column:1 / -1 }
}
@media (max-height: 540px) and (min-width: 481px) {
  :global(.signature-dialog .signature-dialog-header) { padding-block:12px 8px }
  :global(.signature-dialog .signature-dialog-body) { padding-bottom:12px }
  :global(.signature-dialog .signature-dialog-footer) { padding-block:8px max(8px, env(safe-area-inset-bottom)) }
  .signature-location { margin-bottom:8px }
}
</style>
