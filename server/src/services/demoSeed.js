const { getShowcaseConfig } = require('../config/showcaseConfig');
const { seedDemoUsers } = require('../../scripts/seed-demo-users.cjs');
const reportStudio = require('./reportStudio');
const { seedShowcaseContent } = require('../../scripts/seed-showcase-content.cjs');

let seeding = null;

async function ensureDemoBaseline() {
  if (getShowcaseConfig().seedDemoContent === false) return { skipped: true };
  if (seeding) return seeding;
  seeding = (async () => {
    await seedDemoUsers();
    // report_studio_templates is created lazily by the report studio service.
    await reportStudio.initialize();
    return seedShowcaseContent();
  })();
  try { return await seeding; }
  finally { seeding = null; }
}

module.exports = { ensureDemoBaseline };
