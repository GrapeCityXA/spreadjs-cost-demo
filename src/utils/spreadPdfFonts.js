import { loadRuntimeConfig, guideMediaUrl } from './runtimeConfig'

const FONT_FILE = 'NotoSansSC-Regular.ttf'

const registeredManagers = new WeakSet()
let fontDataPromise
let pdfPluginPromise

// List/preview pages can load PDF on demand in the documented print -> PDF order.
// The official Designer distribution may have already loaded these dependencies.
export async function ensureSpreadPdfExport(GC) {
  if (!pdfPluginPromise) {
    pdfPluginPromise = import('@grapecity-software/spread-sheets-print')
      .then(() => import('@grapecity-software/spread-sheets-pdf'))
      .catch(error => { pdfPluginPromise = null; throw error })
  }
  await pdfPluginPromise
  await ensureSpreadPdfFonts(GC)
}

async function loadNotoSansSc() {
  // The font lives on the media CDN and shares the runtime-configured base with
  // the guide videos, so it can be moved without rebuilding the frontend.
  await loadRuntimeConfig()
  const url = guideMediaUrl(FONT_FILE)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`中文 PDF 字体加载失败（${response.status}）：${url}`)
  return response.arrayBuffer()
}

export async function ensureSpreadPdfFonts(GC) {
  const manager = GC?.Spread?.Sheets?.PDF?.PDFFontsManager
  if (!manager) throw new Error('SpreadJS PDF 字体管理器尚未加载')
  if (registeredManagers.has(manager)) return

  if (!fontDataPromise) fontDataPromise = loadNotoSansSc()
  let fontData
  try {
    fontData = await fontDataPromise
  } catch (error) {
    fontDataPromise = null
    throw error
  }

  manager.registerFont('Noto Sans SC', { normal: fontData, bold: fontData })
  manager.fallbackFont = () => fontData
  registeredManagers.add(manager)
}
