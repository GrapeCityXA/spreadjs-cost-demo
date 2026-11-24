// Optional deployment prefix, e.g. /spreadjs/cost-report. When set, the app
// serves its API, static files and WebSockets under that prefix so an upstream
// proxy can forward the path unchanged. Empty means the app stays at the root.
function normalizeBasePath(value) {
  const text = String(value || '').trim();
  if (!text || text === '/') return '';
  return `/${text.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

const APP_BASE_PATH = normalizeBasePath(process.env.APP_BASE_PATH);

function withBasePath(pathname) {
  const suffix = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${APP_BASE_PATH}${suffix}`;
}

module.exports = { APP_BASE_PATH, withBasePath };
