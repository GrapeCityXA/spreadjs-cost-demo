import { ref } from 'vue'
import { API_BASE_URL } from '@/api/base'

const BASE_URL = import.meta.env.BASE_URL
const DEFAULT_MEDIA_BASE = `${BASE_URL}media`.replace(/\/+$/, '')

export const guideMediaBaseUrl = ref(DEFAULT_MEDIA_BASE)
let loaded = null

// Keep relative media paths inside the deployed subpath; absolute CDN URLs win.
function resolveMediaBase(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return DEFAULT_MEDIA_BASE
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith('//')) return text.replace(/\/+$/, '')
  if (text.startsWith(BASE_URL)) return text.replace(/\/+$/, '')
  return `${BASE_URL}${text.replace(/^\/+/, '')}`.replace(/\/+$/, '')
}

export function loadRuntimeConfig() {
  if (loaded) return loaded
  loaded = fetch(`${API_BASE_URL}/app-config`, {
    headers: { Accept: 'application/json' }
  }).then(response => response.ok ? response.json() : null).then(config => {
    const value = typeof config?.guideMediaBaseUrl === 'string' ? config.guideMediaBaseUrl : ''
    guideMediaBaseUrl.value = resolveMediaBase(value)
  }).catch(() => {})
  return loaded
}

export function guideMediaUrl(file) {
  return `${guideMediaBaseUrl.value}/${file}`
}

export function guideVideoUrl(file) {
  return guideMediaUrl(file)
}
