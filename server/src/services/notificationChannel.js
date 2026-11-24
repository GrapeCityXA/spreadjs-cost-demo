const { WebSocketServer, WebSocket } = require('ws');
const sqlite3 = require('sqlite3');
const { withBasePath } = require('../config/basePath');
const db = require('../config/database');
const { getDatabasePath } = require('../config/storage');
const { authenticateToken } = require('../middleware/auth');
const { createWorkflowNotifications } = require('./workflowNotifications');

let runtimePromise;
function authenticate(token) {
  if (typeof token !== 'string' || token.length > 8192) return Promise.reject(new Error('authentication_required'));
  return new Promise((resolve, reject) => {
    const req = { headers: { authorization: `Bearer ${token}` } };
    authenticateToken(req, { status() { return this; }, json() { reject(new Error('authentication_failed')); } },
      error => error ? reject(error) : resolve(req.user));
  });
}
async function runtime() {
  if (!runtimePromise) runtimePromise = (async () => {
    await db.ready;
    const connection = new sqlite3.Database(getDatabasePath());
    connection.configure('busyTimeout', 3000);
    const service = createWorkflowNotifications(connection);
    let tail = Promise.resolve();
    const queue = callback => { const next = tail.then(() => callback(service)); tail = next.catch(() => {}); return next; };
    return { connection, queue, clients: new Set() };
  })();
  return runtimePromise;
}
async function invalidate(userId) {
  const rt = await runtime();
  for (const ws of rt.clients) if (ws.userId === Number(userId) && ws.readyState === WebSocket.OPEN) {
    // The frame carries no business payload. The subsequent authenticated HTTP
    // read rechecks current roles and task assignments before returning content.
    ws.send(JSON.stringify({ type: 'notifications.changed' }));
  }
}
async function attach(server) {
  const rt = await runtime();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 });
  const upgrade = (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== withBasePath('/api/notifications/socket')) return;
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  };
  server.on('upgrade', upgrade);
  wss.on('connection', ws => {
    let token, checking = false;
    ws.alive = true;
    const timeout = setTimeout(() => ws.close(4401, 'authentication_required'), 5000);
    ws.on('error', () => {});
    ws.on('pong', () => { ws.alive = true; });
    ws.once('message', async data => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type !== 'authenticate') throw new Error('authentication_required');
        token = message.token;
        const user = await authenticate(token);
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.userId = user.id;
        clearTimeout(timeout);
        rt.clients.add(ws);
        ws.send(JSON.stringify({ type: 'ready' }));
      } catch { ws.close(4401, 'authentication_failed'); }
    });
    const heartbeat = setInterval(async () => {
      if (checking) return;
      if (!ws.alive) return ws.terminate();
      ws.alive = false;
      checking = true;
      try { if (ws.userId) await authenticate(token); ws.ping(); }
      catch { ws.close(4401, 'authentication_expired'); }
      finally { checking = false; }
    }, 30000);
    heartbeat.unref();
    ws.on('close', () => { clearTimeout(timeout); clearInterval(heartbeat); rt.clients.delete(ws); });
  });
  let lastId = 0, busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const added = await rt.queue(async service => {
        await service.processEvents();
        return new Promise((resolve, reject) => rt.connection.all('SELECT id,user_id FROM notifications WHERE id>? ORDER BY id', [lastId], (e, r) => e ? reject(e) : resolve(r)));
      });
      if (added.length) {
        lastId = added.at(-1).id;
        for (const id of new Set(added.map(n => n.user_id))) await invalidate(id);
      }
    } catch (error) { console.error('Notification delivery failed:', error.message); }
    finally { busy = false; }
  };
  await tick();
  const timer = setInterval(tick, 1000); timer.unref();
  return async () => {
    clearInterval(timer); server.off('upgrade', upgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await rt.queue(() => new Promise(resolve => rt.connection.close(resolve)));
    runtimePromise = null;
  };
}
async function close() {
  if (!runtimePromise) return;
  const rt = await runtimePromise;
  for (const ws of rt.clients) ws.terminate();
  await rt.queue(() => new Promise(resolve => rt.connection.close(resolve)));
  runtimePromise = null;
}
module.exports = { attach, invalidate, runtime, close };
