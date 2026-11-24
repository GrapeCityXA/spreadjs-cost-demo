const path = require('path');

// Keep the working demo and its companion files together in persistent storage.
// Explicit environment overrides remain available for isolated acceptance tests.
const defaultDataDir = path.join(__dirname, '../../data/demo');
const defaultTemplateDir = path.join(defaultDataDir, 'templates');
const defaultArtifactDir = path.join(defaultDataDir, 'artifacts');
const defaultBackupDir = path.join(defaultDataDir, 'backups');

function getDatabasePath() {
  return process.env.COST_REPORT_DB_PATH || path.join(defaultDataDir, 'business.db');
}

function getCollaborationDatabasePath() {
  return process.env.COST_REPORT_COLLAB_DB_PATH || path.join(defaultDataDir, 'collaboration.db');
}

function getTemplateDirectory() {
  return process.env.COST_REPORT_TEMPLATE_DIR || defaultTemplateDir;
}

function getArtifactDirectory() {
  return process.env.COST_REPORT_ARTIFACT_DIR || defaultArtifactDir;
}

function getBackupDirectory() {
  return process.env.COST_REPORT_BACKUP_DIR || defaultBackupDir;
}

module.exports = { getDatabasePath, getCollaborationDatabasePath, getTemplateDirectory, getArtifactDirectory, getBackupDirectory };
