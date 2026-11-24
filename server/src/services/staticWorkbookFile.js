const fs = require('node:fs/promises');
const path = require('node:path');
const storage = require('../config/storage');

const fail = message => Object.assign(new Error(message), { status: 409 });

async function readStaticWorkbook(storageKey, directory = storage.getArtifactDirectory()) {
  let root, file;
  try {
    // Resolve Windows short names, case variants and directory links before
    // checking containment; string prefixes cannot establish file identity.
    [root, file] = await Promise.all([fs.realpath(directory), fs.realpath(storageKey)]);
  } catch { throw fail('静态工作簿文件无法读取'); }
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw fail('静态工作簿文件位置无效');
  }
  let workbook;
  try { workbook = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { throw fail('静态工作簿文件无法读取'); }
  if (workbook?.content != null) {
    try { workbook = typeof workbook.content === 'string' ? JSON.parse(workbook.content) : workbook.content; }
    catch { throw fail('静态工作簿内容无法解析'); }
  }
  return workbook;
}

async function readRevisionWorkbook(storageKey, revisionId, connection = require('../config/database')) {
  const workbook = await readStaticWorkbook(storageKey);
  if (!workbook.activeSheetId || workbook.collaborationInfo) return workbook;
  // Older exports stripped the format marker, but kept native formulaInfo.
  // Recover the exact marker from this revision's archived collaboration data.
  const artifact = await new Promise((resolve, reject) => connection.get(
    "SELECT storage_key FROM official_artifacts WHERE revision_id = ? AND artifact_type = 'collaboration_snapshot'",
    [revisionId], (error, row) => error ? reject(error) : resolve(row)));
  if (!artifact) throw fail('此修订缺少原始协作快照，无法完整恢复公式');
  const archived = await readStaticWorkbook(artifact.storage_key);
  const metadata = (archived.snapshot?.data || archived.data)?.collaborationInfo;
  if (!metadata) throw fail('此修订的原始协作快照缺少格式信息');
  workbook.collaborationInfo = metadata;
  return workbook;
}

module.exports = { readStaticWorkbook, readRevisionWorkbook };
