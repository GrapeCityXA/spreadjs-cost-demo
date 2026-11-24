// Signature pixels are input data; the marker and IMAGE formatter are template structure.
export const SIGNATURE_FORMAT = '=IMAGE(@,"手写签名",0)'
export function readCellTag(raw) {
  try { const tag = typeof raw === 'string' ? JSON.parse(raw) : raw; return tag && typeof tag === 'object' && !Array.isArray(tag) ? tag : {} } catch { return {} }
}
export function isSignatureCell(sheet, row, col) {
  return readCellTag(sheet?.getTag(row, col)).signature?.version === 1
}
export function signatureAnchor(sheet, row, col) {
  const span = sheet.getSpan(row, col)
  return span ? { row: span.row, col: span.col } : { row, col }
}
export function isSignatureImage(value) {
  return typeof value === 'string' && value.length <= 512 * 1024 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
}
