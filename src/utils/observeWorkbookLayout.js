// SpreadJS refresh must run after its host has a measurable layout.
// Coalesce resize notifications and cancel pending work before destroying the control.
export function observeWorkbookLayout(host, control) {
  let frame = null
  const refresh = () => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = null
      if (host.isConnected && host.clientWidth > 0 && host.clientHeight > 0) control.refresh()
    })
  }
  const observer = new ResizeObserver(refresh)
  observer.observe(host)
  refresh()
  return () => {
    observer.disconnect()
    if (frame !== null) cancelAnimationFrame(frame)
  }
}
