const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const { APP_BASE_PATH, withBasePath } = require('./config/basePath');
const db = require('./config/database');
const { getShowcaseConfig } = require('./config/showcaseConfig');
const { touchActivity } = require('./services/showcaseActivity');
// Optional deployment prefix. The frontend is built with the same VITE_BASE_PATH,
// so every browser request already carries the prefix; strip it here so the
// existing routes and static files keep working unchanged.
if (APP_BASE_PATH) {
  app.use((req, res, next) => {
    const url = req.url || '/';
    if (url === APP_BASE_PATH || url.startsWith(`${APP_BASE_PATH}/`) || url.startsWith(`${APP_BASE_PATH}?`)) {
      req.url = url.slice(APP_BASE_PATH.length) || '/';
      if (!req.url.startsWith('/')) req.url = `/${req.url}`;
    }
    next();
  });
}
// 中间件
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
// Platform warm-up probes must not keep the demo alive: hosting health checks
// periodically request "/", which would otherwise refresh the idle timer and
// prevent the showcase reset.
const ACTIVITY_EXEMPT_PATHS = new Set(['/', '/health', '/favicon.ico', '/robots.txt', '/guide', '/index.html']);
app.use((req, res, next) => {
  if (!ACTIVITY_EXEMPT_PATHS.has(req.path)) touchActivity();
  db.ready.then(() => next(), next);
});

// 路由
const authRoutes = require('./routes/authRoutes');
const templateGovernanceRoutes = require('./routes/templateGovernanceRoutes');
const dataQueryRoutes = require('./routes/dataQueryRoutes');
const organizationAdminRoutes = require('./routes/organizationAdminRoutes');
const fieldCatalogRoutes = require('./routes/fieldCatalogRoutes');
const ruleCatalogRoutes = require('./routes/ruleCatalogRoutes');
const periodConfigurationRoutes = require('./routes/periodConfigurationRoutes');
const collaborationRoutes = require('./routes/collaborationRoutes');
const quarterlyReviewRoutes = require('./routes/quarterlyReviewRoutes');
const historicalImportRoutes = require('./routes/historicalImportRoutes');
const taskOperationsRoutes = require('./routes/taskOperationsRoutes');
const originalDataExportRoutes = require('./routes/originalDataExportRoutes');
const managementDashboardRoutes = require('./routes/managementDashboardRoutes');
const systemOperationsRoutes = require('./routes/systemOperationsRoutes');

// Public runtime configuration; changing GUIDE_MEDIA_BASE_URL only requires a backend restart.
app.get('/api/app-config', (req, res) => {
  res.json({ guideMediaBaseUrl: getShowcaseConfig().guideMediaBaseUrl });
});

// API路由
app.use('/api/auth', authRoutes);
app.use('/api/workflows', require('./routes/workflowRoutes'));
app.use('/api/report-studio', require('./routes/reportStudioRoutes'));
app.use('/api/template-governance', templateGovernanceRoutes);
app.use('/api/data', dataQueryRoutes);
app.use('/api/admin', organizationAdminRoutes);
app.use('/api/fields', fieldCatalogRoutes);
app.use('/api/rules', ruleCatalogRoutes);
app.use('/api/managed-functions', require('./routes/managedFunctionRoutes'));
app.use('/api/function-playground', require('./routes/functionPlaygroundRoutes'));
app.use('/api/period-configuration', periodConfigurationRoutes);
app.use('/api/collaboration', collaborationRoutes);
app.use('/api/quarterly-review', quarterlyReviewRoutes);
app.use('/api/historical-imports', historicalImportRoutes);
app.use('/api/task-operations', taskOperationsRoutes);
app.use('/api/exports', originalDataExportRoutes);
app.use('/api/management-dashboard', managementDashboardRoutes);
app.use('/api/system-operations', systemOperationsRoutes);

const originalDataExports = require('./services/originalDataExports');
db.ready.then(() => originalDataExports.initialize()).catch(error => console.error('Failed to initialize export jobs', error));

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------- 静态前端
// 单应用部署时由本进程同时提供前端页面和录屏；
// 反向代理部署里页面请求由代理处理、不会走到这里，行为不变。
// STATIC_ROOT / MEDIA_ROOT 可用环境变量覆盖（例如 /srv/cost-report/dist 等）。
const fs = require('node:fs');
const path = require('node:path');
const STATIC_ROOT = process.env.STATIC_ROOT || path.resolve(__dirname, '../../dist');
const MEDIA_ROOT = process.env.MEDIA_ROOT || path.resolve(__dirname, '../../guide-media');

if (fs.existsSync(STATIC_ROOT)) {
  // 与 server/deploy/nginx.conf 保持一致：入口 302 到 /guide，HTML 不缓存，
  // 带内容哈希的 assets/fonts 缓存 7 天。
  app.get('/', (req, res) => {
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, withBasePath('/guide') + query);
  });

  if (fs.existsSync(MEDIA_ROOT)) {
    app.use('/media', express.static(MEDIA_ROOT, { maxAge: '7d' }));
  }

  app.use(express.static(STATIC_ROOT, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
      } else if (/[\\/](assets|fonts)[\\/]/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));

  // The landing page is a standalone static entry, not a Vue route. Serve the
  // clean /landing URL directly when the build includes landing.html.
  const LANDING_FILE = path.join(STATIC_ROOT, 'landing.html');
  if (fs.existsSync(LANDING_FILE)) {
    app.get(['/landing', '/landing/'], (req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
      res.sendFile(LANDING_FILE);
    });
  }

  // History 路由回退：非 API 的 GET 都交给前端入口；未知的 /api 路径保持 404，
  // 避免把接口错误伪装成 HTML。协同 WebSocket 走 upgrade 事件，不经过这里。
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/collaboration') return next();
    res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
    res.sendFile(path.join(STATIC_ROOT, 'index.html'));
  });
}

// 错误处理
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: '服务器内部错误' });
});

module.exports = app;
