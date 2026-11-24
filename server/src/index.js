const app = require('./app');
const db = require('./config/database');
const http = require('http');
const collaboration = require('./services/collaborationServer');
const restoreRecovery = require('./services/restoreRecovery');
const notificationChannel = require('./services/notificationChannel');
const reportStudio = require('./services/reportStudio');
const showcaseReset = require('./services/showcaseReset');
const demoSeed = require('./services/demoSeed');
let stopNotifications;

// 某些 Windows 托管环境会把 PORT 传成命名管道，本地和容器里是端口号
const rawPort = String(process.env.PORT || '3000');
const PORT = /^\d+$/.test(rawPort) ? Number(rawPort) : rawPort;
const HOST = process.env.HOST && typeof PORT === 'number' ? process.env.HOST : undefined;
const onListen = () => console.log(`服务器运行在端口 ${PORT}`);
let server;
const httpServer = http.createServer(app);

db.ready.then(() => {
  return demoSeed.ensureDemoBaseline();
}).then(() => {
  return collaboration.attach(httpServer);
}).then(() => {
  return notificationChannel.attach(httpServer).then(stop => { stopNotifications = stop; });
}).then(() => {
  return restoreRecovery.recoverPendingRestoreAudit();
}).then(() => {
  return reportStudio.start();
}).then(() => {
  showcaseReset.startScheduler();
}).then(() => {
  server = HOST
    ? httpServer.listen(PORT, HOST, onListen)
    : httpServer.listen(PORT, onListen);
}).catch(error => {
  console.error('数据库迁移失败，服务器未启动:', error);
  process.exitCode = 1;
});

async function shutdown() {
  showcaseReset.stopScheduler();
  await reportStudio.stop();
  await stopNotifications?.();
  const closeDatabases = () => {
    db.close(() => db.collaborationDb.close(() => process.exit(0)));
  };
  if (server) server.close(closeDatabases);
  else closeDatabases();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
