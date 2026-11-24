const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const multer = require('multer');
const db = require('../config/database');
const storage = require('../config/storage');
const collaboration = require('./collaborationServer');
const { hasTaskAssignment } = require('./taskAssignments');

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES_PER_INDICATOR = 10;
const TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;
const EVIDENCE_DIR = () => path.join(storage.getArtifactDirectory(), 'evidence');
const TEMP_DIR = () => path.join(EVIDENCE_DIR(), '.temporary');
const TYPES = {
  '.pdf': ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.webp': ['image/webp'],
  '.zip': ['application/zip', 'application/x-zip-compressed']
};
const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.dll', '.com', '.bat', '.cmd', '.msi', '.scr', '.ps1', '.sh', '.jar', '.apk', '.appx', '.deb', '.rpm', '.so', '.dylib', '.class']);
const MACRO_EXTENSIONS = new Set(['.docm', '.xlsm', '.pptm', '.xlam', '.xlsb', '.dotm', '.ppsm', '.potm']);

const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const run = (connection, sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function assertAllowedFileType(extension, mediaType) {
  if (MACRO_EXTENSIONS.has(extension) || EXECUTABLE_EXTENSIONS.has(extension)) throw fail('不允许上传宏启用或可执行文件');
  if (!TYPES[extension]) throw fail('文件类型不受支持');
  if (!TYPES[extension].includes(String(mediaType || '').toLowerCase())) throw fail('文件扩展名与 MIME 类型不匹配');
}

function uploadMiddleware() {
  return multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, callback) => {
        try { await fs.mkdir(TEMP_DIR(), { recursive: true }); callback(null, TEMP_DIR()); }
        catch (error) { callback(error); }
      },
      filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`)
    }),
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, parts: 6 },
    fileFilter: (_req, file, callback) => {
      const extension = path.extname(path.basename(file.originalname || '')).toLowerCase();
      try { assertAllowedFileType(extension, file.mimetype); }
      catch (error) { return callback(error); }
      callback(null, true);
    }
  }).single('file');
}

function zipEntries(buffer) {
  if (buffer.length < 22) throw fail('ZIP 或 Office 文件结构无效');
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw fail('ZIP 或 Office 文件结构无效');
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset + directorySize > eocd || count > 10000) throw fail('ZIP 或 Office 文件目录无效');
  const names = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw fail('ZIP 或 Office 文件目录无效');
    const flags = buffer.readUInt16LE(offset + 8);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (offset + 46 + nameLength + extraLength + commentLength > buffer.length) throw fail('ZIP 文件目录条目无效');
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    names.push((flags & 0x800 ? nameBytes.toString('utf8') : nameBytes.toString('latin1')).replace(/\\/g, '/'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function rejectUnsafeZipEntries(names) {
  if (names.some(name => /(^|\/)vbaProject\.bin$/i.test(name))) throw fail('文件包含 VBA 宏，已拒绝上传');
  const unsafe = names.find(name => EXECUTABLE_EXTENSIONS.has(path.posix.extname(name).toLowerCase())
    || MACRO_EXTENSIONS.has(path.posix.extname(name).toLowerCase()));
  if (unsafe) throw fail('ZIP 或 Office 文件包含宏启用或可执行内容，已拒绝上传');
}

async function validateFile(file, extension) {
  const buffer = await fs.readFile(file.path);
  if (!buffer.length) throw fail('不接受空文件');
  const isZip = extension === '.zip' || ['.docx', '.xlsx', '.pptx'].includes(extension);
  if (isZip) {
    const names = zipEntries(buffer);
    rejectUnsafeZipEntries(names);
    if (extension !== '.zip') {
      const expected = extension === '.docx' ? 'word/document.xml' : extension === '.xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml';
      if (!names.includes('[Content_Types].xml') || !names.includes(expected)) throw fail('Office 文件内容与扩展名不匹配');
    }
    return;
  }
  const valid = extension === '.pdf' ? buffer.subarray(0, 5).toString() === '%PDF-'
    : extension === '.png' ? buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : ['.jpg', '.jpeg'].includes(extension) ? buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
        : extension === '.webp' ? buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' : false;
  if (!valid) throw fail('文件内容与声明的类型不匹配');
}

async function scanUpload(filePath, metadata) {
  const scannerPath = process.env.ATTACHMENT_SCANNER_MODULE;
  if (!scannerPath) return { status: 'pending', details: '未配置外部扫描器' };
  const scanner = require(path.resolve(scannerPath));
  if (typeof scanner.scan !== 'function') throw new Error('ATTACHMENT_SCANNER_MODULE must export scan(filePath, metadata)');
  const result = await scanner.scan(filePath, metadata);
  if (!['clean', 'rejected', 'pending'].includes(result?.status)) throw new Error('Scanner returned an unsupported status');
  return { status: result.status, details: String(result.details || '').slice(0, 1000) || null };
}

function roleInScope(user, roleCodes, organizationId) {
  return (user.roles || []).some(role => roleCodes.includes(role.code)
    && (role.organizationId == null || Number(role.organizationId) === Number(organizationId)));
}

async function taskForAccess(taskId, actor, upload = false) {
  let task = await get(db, `SELECT t.*, cr.id AS room_id, cr.collaboration_room_key, cr.room_status,
      r.revision_status, r.revision_number
    FROM report_tasks t JOIN collaboration_rooms cr ON cr.task_id = t.id
      AND cr.revision_number = (SELECT MAX(last.revision_number) FROM collaboration_rooms last WHERE last.task_id = t.id)
    LEFT JOIN business_revisions r ON r.id = t.current_revision_id
    WHERE t.id = ?`, [taskId]);
  if (!task) throw fail('填报任务不存在', 404);
  if (!(await collaboration.canAccessRoom(actor, task))) throw fail('无权访问此任务', 403);
  if (upload) {
    if (task.task_status !== 'draft' || task.room_status !== 'open') throw fail('仅可在开放的草稿修订中上传证据', 409);
    const isFiller = roleInScope(actor, ['subsidiary_filler'], task.organization_id);
    const isSubmitter = roleInScope(actor, ['subsidiary_submitter'], task.organization_id);
    const [isAssignedFiller, isAssignedSubmitter] = await Promise.all([
      hasTaskAssignment(db, task, actor.id, 'filler'), hasTaskAssignment(db, task, actor.id, 'submitter')
    ]);
    if (!(isAssignedFiller && isFiller) && !(isAssignedSubmitter && isSubmitter)) {
      throw fail('仅此任务的指定填报人或提交人可以上传证据', 403);
    }
    if (task.current_revision_id == null || task.revision_status == null) {
      await run(db, `INSERT INTO business_revisions (task_id, revision_number, revision_status, collaboration_room_id)
        SELECT ?, COALESCE((SELECT MAX(revision_number) FROM business_revisions WHERE task_id = ?), 0) + 1, 'draft', ?
        WHERE NOT EXISTS (SELECT 1 FROM business_revisions current WHERE current.id = (SELECT current_revision_id FROM report_tasks WHERE id = ?))`,
      [task.id, task.id, task.room_id, task.id]);
      await run(db, `UPDATE report_tasks SET current_revision_id = (
          SELECT id FROM business_revisions WHERE task_id = ? AND revision_status = 'draft' ORDER BY revision_number DESC LIMIT 1
        ) WHERE id = ? AND NOT EXISTS (SELECT 1 FROM business_revisions current WHERE current.id = report_tasks.current_revision_id)`, [task.id, task.id]);
      task = await get(db, `SELECT t.*, cr.id AS room_id, cr.collaboration_room_key, cr.room_status,
          r.revision_status, r.revision_number
        FROM report_tasks t JOIN collaboration_rooms cr ON cr.task_id = t.id
          AND cr.revision_number = (SELECT MAX(last.revision_number) FROM collaboration_rooms last WHERE last.task_id = t.id)
        LEFT JOIN business_revisions r ON r.id = t.current_revision_id WHERE t.id = ?`, [task.id]);
    }
    if (task.revision_status !== 'draft') throw fail('仅可在开放的草稿修订中上传证据', 409);
  }
  return task;
}

function presentAttachment(row) {
  return { id: Number(row.id), taskId: Number(row.task_id), revisionId: Number(row.revision_id),
    revisionNumber: Number(row.revision_number), indicatorCode: row.indicator_code || null,
    originalName: row.original_name, extension: row.extension, mediaType: row.media_type,
    byteSize: Number(row.byte_size), sha256: row.sha256, scanStatus: row.scan_status,
    scanDetails: row.scan_details, uploader: row.uploader_name, createdAt: row.created_at };
}

async function listAttachments(task, actor) {
  await taskForAccess(task.id, actor, false);
  const rows = await all(db, `SELECT a.id, a.task_id, a.revision_id, r.revision_number, a.indicator_code,
      a.original_name, a.extension, a.media_type, a.byte_size, a.sha256, a.scan_status, a.scan_details,
      u.name AS uploader_name, a.created_at
    FROM attachments a JOIN business_revisions r ON r.id = a.revision_id
    JOIN users u ON u.id = a.uploaded_by
    WHERE a.task_id = ? ORDER BY r.revision_number DESC, a.created_at, a.id`, [task.id]);
  return rows.map(presentAttachment);
}

async function uploadAttachment(task, actor, file, indicatorCode) {
  let destination;
  try {
    if (!file) throw fail('请选择要上传的文件');
    task = await taskForAccess(task.id, actor, true);
    const extension = path.extname(path.basename(file.originalname || '')).toLowerCase();
    assertAllowedFileType(extension, file.mimetype);
    const safeOriginalName = path.basename(String(file.originalname || '').replace(/[\\/]/g, '_')).slice(0, 255);
    if (!safeOriginalName || safeOriginalName === '.' || safeOriginalName === '..') throw fail('原始文件名无效');
    if (Number(file.size) > MAX_FILE_BYTES) throw fail('单个文件不能超过 20 MB', 413);
    await validateFile(file, extension);
    const cleanIndicatorCode = String(indicatorCode || '').trim();
    if (cleanIndicatorCode && cleanIndicatorCode.length > 100) throw fail('指标编号无效');
    if (cleanIndicatorCode) {
      const indicator = await get(db, 'SELECT id FROM task_indicators WHERE task_id = ? AND indicator_code = ?', [task.id, cleanIndicatorCode]);
      if (!indicator) throw fail('该指标不属于当前任务', 404);
      const existing = await get(db, `SELECT COUNT(*) AS count FROM attachments
        WHERE revision_id = ? AND indicator_code = ?`, [task.current_revision_id, cleanIndicatorCode]);
      if (Number(existing.count) >= MAX_FILES_PER_INDICATOR) throw fail('每个指标最多保留 10 个附件', 409);
    }
    await fs.mkdir(EVIDENCE_DIR(), { recursive: true });
    const internalName = `${crypto.randomUUID()}${extension}`;
    destination = path.join(EVIDENCE_DIR(), internalName);
    await fs.rename(file.path, destination);
    const sha256 = crypto.createHash('sha256').update(await fs.readFile(destination)).digest('hex');
    let scan;
    try { scan = await scanUpload(destination, { extension, mediaType: file.mimetype, byteSize: Number(file.size), sha256 }); }
    catch (error) { scan = { status: 'error', details: String(error.message || '扫描器调用失败').slice(0, 1000) }; }
    if (scan.status === 'rejected') throw fail('文件未通过安全扫描', 422);
    let result;
    try {
      result = await run(db, `INSERT INTO attachments
        (task_id, revision_id, indicator_code, original_name, storage_key, media_type, byte_size, sha256, uploaded_by, extension, scan_status, scan_details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [task.id, task.current_revision_id, cleanIndicatorCode || null,
        safeOriginalName, destination, file.mimetype, Number(file.size), sha256, actor.id, extension, scan.status, scan.details]);
    } catch (error) {
      if (String(error.message).includes('indicator_attachment_limit')) throw fail('每个指标最多保留 10 个附件', 409);
      if (String(error.message).includes('attachment_revision_locked')) throw fail('该业务修订已锁定，不能再修改附件集合', 409);
      throw error;
    }
    return (await listAttachments(task, actor)).find(item => item.id === Number(result.lastID));
  } catch (error) {
    if (destination) await fs.rm(destination, { force: true }).catch(() => {});
    throw error;
  } finally {
    if (file?.path) await fs.rm(file.path, { force: true }).catch(() => {});
  }
}

async function attachmentForDownload(taskId, attachmentId, actor) {
  const task = await taskForAccess(taskId, actor, false);
  const row = await get(db, `SELECT a.*, r.revision_number, i.id AS indicator_id
    FROM attachments a JOIN business_revisions r ON r.id = a.revision_id
    LEFT JOIN task_indicators i ON i.task_id = a.task_id AND i.indicator_code = a.indicator_code
    WHERE a.id = ? AND a.task_id = ?`, [attachmentId, task.id]);
  if (!row || (row.indicator_code && !row.indicator_id)) throw fail('附件不存在', 404);
  if (row.scan_status === 'rejected') throw fail('该附件未通过安全扫描', 410);
  if (row.scan_status === 'error') throw fail('附件扫描失败，暂不可下载', 423);
  const absolutePath = path.resolve(row.storage_key);
  const root = path.resolve(EVIDENCE_DIR()) + path.sep;
  if (!absolutePath.startsWith(root)) throw fail('附件存储路径无效', 404);
  try { await fs.access(absolutePath); } catch { throw fail('附件文件不存在', 404); }
  return { task, row, absolutePath };
}

async function copyRevisionAttachments(connection, taskId, sourceRevisionId, destinationRevisionId) {
  const rows = await all(connection, `SELECT * FROM attachments WHERE task_id = ? AND revision_id = ?`, [taskId, sourceRevisionId]);
  const copiedPaths = [];
  try {
    await fs.mkdir(EVIDENCE_DIR(), { recursive: true });
    for (const row of rows) {
      const extension = row.extension || path.extname(row.original_name).toLowerCase();
      const newPath = path.join(EVIDENCE_DIR(), `${crypto.randomUUID()}${extension}`);
      await fs.copyFile(row.storage_key, newPath);
      copiedPaths.push(newPath);
      await run(connection, `INSERT INTO attachments
        (task_id, revision_id, indicator_code, original_name, storage_key, media_type, byte_size, sha256, uploaded_by, extension, scan_status, scan_details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [taskId, destinationRevisionId, row.indicator_code,
        row.original_name, newPath, row.media_type, row.byte_size, row.sha256, row.uploaded_by, extension, row.scan_status, row.scan_details]);
    }
    return copiedPaths;
  } catch (error) {
    await Promise.all(copiedPaths.map(file => fs.rm(file, { force: true }).catch(() => {})));
    throw error;
  }
}

async function cleanupTemporaryUploads(now = Date.now()) {
  let entries;
  try { entries = await fs.readdir(TEMP_DIR(), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const target = path.join(TEMP_DIR(), entry.name);
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs > TEMP_RETENTION_MS) {
      await fs.rm(target, { force: true }); removed += 1;
    }
  }
  return removed;
}

void cleanupTemporaryUploads().catch(error => console.error('Evidence temporary upload cleanup failed:', error.message));
const cleanupTimer = setInterval(() => void cleanupTemporaryUploads().catch(error => console.error('Evidence temporary upload cleanup failed:', error.message)), 60 * 60 * 1000);
cleanupTimer.unref?.();

module.exports = { uploadMiddleware, uploadAttachment, listAttachments, attachmentForDownload, taskForAccess,
  copyRevisionAttachments, cleanupTemporaryUploads, MAX_FILE_BYTES, MAX_FILES_PER_INDICATOR, TEMP_RETENTION_MS };
