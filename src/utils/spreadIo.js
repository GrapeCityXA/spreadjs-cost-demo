let ioPluginPromise

// Opening the template list or composition form does not need Excel file IO.
export function ensureSpreadIo() {
  if (!ioPluginPromise) {
    ioPluginPromise = import('@grapecity-software/spread-sheets-io')
      .catch(error => {
        ioPluginPromise = null
        // Browsers may cache a failed module fetch for the life of the document.
        throw new Error('Excel 功能加载失败，请检查网络后刷新页面再试', { cause: error })
      })
  }
  return ioPluginPromise
}
