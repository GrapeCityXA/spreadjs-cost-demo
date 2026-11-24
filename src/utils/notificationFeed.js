// Only invalidation signals travel over this socket. Inbox content is fetched
// through the normal authenticated API, including on every reconnection.
export function connectNotificationFeed({ url, token, onChange, onState, WebSocketImpl = WebSocket,
  schedule = setTimeout, cancel = clearTimeout }) {
  let socket, timer, stopped = false, failures = 0;
  function connect() {
    if (stopped) return;
    onState('connecting');
    socket = new WebSocketImpl(url);
    const current = socket;
    current.onopen = () => { if (!stopped) current.send(JSON.stringify({ type: 'authenticate', token })); };
    current.onmessage = event => {
      if (stopped || current !== socket) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'ready') { failures = 0; onState('connected'); onChange(); }
      else if (message.type === 'notifications.changed') onChange();
    };
    current.onerror = () => { /* onclose owns reconnect, including failed handshakes */ };
    current.onclose = event => {
      if (stopped || current !== socket) return;
      if (event.code === 4401) { onState('expired'); onChange(); return; }
      onState('reconnecting');
      timer = schedule(connect, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)));
    };
  }
  connect();
  return () => { stopped = true; cancel(timer); socket?.close(); };
}
