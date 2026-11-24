// Sheet codes are application identifiers, not UUIDs. Keep the existing format
// using getRandomValues, which is available on HTTP as well as secure origins.
export function createSheetCode(cryptoProvider = globalThis.crypto) {
  const bytes = new Uint8Array(8)
  cryptoProvider.getRandomValues(bytes)
  return `sheet_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}
