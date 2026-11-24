const fs = require('node:fs');
const path = require('node:path');

const configPath = path.resolve(__dirname, '../../config/showcase.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// The file is intentionally committed: these are public demo settings, not secrets.
// Environment variables remain optional overrides for local experiments.
function getShowcaseConfig() {
  const config = readConfig();
  const reset = config.showcaseReset || {};
  return {
    guideMediaBaseUrl: process.env.GUIDE_MEDIA_BASE_URL || config.guideMediaBaseUrl || '/media',
    seedDemoContent: config.seedDemoContent !== false,
    reset: {
      // These are public showcase defaults; environment variables remain optional overrides.
      enabled: bool(process.env.SHOWCASE_RESET_ENABLED, reset.enabled !== false),
      idleHours: number(process.env.SHOWCASE_RESET_IDLE_HOURS || process.env.SHOWCASE_RESET_INTERVAL_HOURS, number(reset.idleHours, 2)),
      backupRetain: number(process.env.SHOWCASE_RESET_BACKUP_RETAIN, number(reset.backupRetain, 7)),
    }
  };
}

module.exports = { configPath, getShowcaseConfig };
