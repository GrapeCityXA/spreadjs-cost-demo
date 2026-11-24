const db = require('../config/database');
const { recordBusinessAudit } = require('../services/businessAudit');
const collaboration = require('../services/collaborationServer');
const { buildMonthlyFillingSummary } = require('../services/monthlyFillingSummary');
const { hasRole } = require('../middleware/auth');
const { effectiveTaskAssignments } = require('../services/taskAssignments');
const { listTaskAssignees } = require('../services/taskAssignees');

const get = (connection, sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params,
  (error, row) => error ? reject(error) : resolve(row)));
const all = (connection, sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params,
  (error, rows) => error ? reject(error) : resolve(rows)));
const run = (connection, sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) {
  if (error) reject(error); else resolve(this);
}));
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const allowedResponsibilities = new Set(['filler', 'submitter', 'department_reviewer', 'finalizer']);
const defaultSchedule = Object.freeze({ daysBefore: [3, 1], deadlineMorning: true, dailyAfterExpiry: true });

function responsibilityIsUnfinished(taskStatus, responsibility) {
  if (['finalized', 'cancelled'].includes(taskStatus)) return false;
  return !(['submitted', 'reviewing'].includes(taskStatus) && ['filler', 'submitter'].includes(responsibility));
}

function taskIsOverdue(taskStatus, cancelled, submittedAt, deadlineAt, now = new Date()) {
  if (cancelled) return false;
  const deadline = normalizedDate(deadlineAt);
  if (!deadline) return false;
  const isSubmitted = ['submitted', 'reviewing', 'finalized'].includes(taskStatus) || Boolean(submittedAt);
  return isSubmitted ? utcDatabaseDate(submittedAt) > deadline : deadline < now;
}

function parse(value, fallback) {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
}

function cleanReason(value) {
  return typeof value === 'string' ? value.trim().slice(0, 2000) : '';
}

function normalizedDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text}+08:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function utcDatabaseDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value.trim())) {
    return normalizedDate(`${value.trim().replace(' ', 'T')}Z`);
  }
  return normalizedDate(value);
}

function isoShanghai(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function reminderAt(date, hour = 9) {
  return new Date(`${isoShanghai(date)}T${String(hour).padStart(2, '0')}:00:00+08:00`);
}

function normalizeSchedule(value) {
  const days = [...new Set((Array.isArray(value?.daysBefore) ? value.daysBefore : defaultSchedule.daysBefore)
    .map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 30))].sort((a, b) => b - a);
  return { daysBefore: days, deadlineMorning: value?.deadlineMorning !== false,
    dailyAfterExpiry: value?.dailyAfterExpiry !== false };
}

async function currentAssignments(task) {
  const assignments = await effectiveTaskAssignments(db, task);
  return Promise.all(assignments.map(async item => {
    const user = item.userName ? item : await get(db, 'SELECT name AS userName, username FROM users WHERE id=?', [item.userId]);
    return { ...item, userName: item.userName || user?.userName || user?.username || null };
  }));
}

async function taskById(taskId) {
  return get(db, `SELECT t.*, rt.display_name AS report_type_name, rt.cadence,
    o.name AS organization_name, o.code AS organization_code
    FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id
    JOIN organizations o ON o.id=t.organization_id WHERE t.id=?`, [taskId]);
}

async function effectiveDeadline(taskId, baseDeadline) {
  const extension = await get(db, `SELECT new_deadline_at, reason, changed_at, u.name AS changed_by_name
    FROM task_deadline_changes d JOIN users u ON u.id=d.changed_by WHERE d.task_id=? ORDER BY d.id DESC LIMIT 1`, [taskId]);
  return extension ? { deadlineAt: extension.new_deadline_at, extensionReason: extension.reason,
    extensionChangedAt: extension.changed_at, extensionChangedBy: extension.changed_by_name }
    : { deadlineAt: baseDeadline, extensionReason: null, extensionChangedAt: null, extensionChangedBy: null };
}

function reminderEvents(deadlineAt, schedule, now) {
  const deadline = normalizedDate(deadlineAt);
  if (!deadline) return [];
  const result = [];
  for (const days of schedule.daysBefore) {
    const at = new Date(deadline.getTime() - days * 24 * 60 * 60 * 1000);
    result.push({ key: `before-${days}-${deadline.toISOString()}`, type: `due_in_${days}_days`, at,
      label: `截止前${days}天` });
  }
  if (schedule.deadlineMorning) {
    const at = reminderAt(deadline);
    result.push({ key: `deadline-${deadline.toISOString()}`, type: 'deadline_today', at, label: '今日截止' });
  }
  if (schedule.dailyAfterExpiry && isoShanghai(now) > isoShanghai(deadline)) {
    const todayAt = reminderAt(now);
    if (todayAt <= now) result.push({ key: `overdue-${isoShanghai(todayAt)}-${deadline.toISOString()}`,
      type: 'overdue_daily', at: todayAt, label: '逾期未提交' });
  }
  return result.filter(item => item.at <= now);
}

async function processDueReminders(now = new Date()) {
  const tasks = await all(db, `SELECT t.id, t.report_type_id, t.organization_id, t.period_code, t.task_status,
      t.configuration_snapshot_json, rt.display_name AS report_type_name, o.name AS organization_name
    FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id JOIN organizations o ON o.id=t.organization_id
    LEFT JOIN task_cancellations c ON c.task_id=t.id
    WHERE t.task_status='draft' AND c.task_id IS NULL`);
  for (const task of tasks) {
    const deadline = await effectiveDeadline(task.id, (await taskById(task.id)).deadline_at);
    const config = await get(db, 'SELECT schedule_json FROM report_type_reminder_schedules WHERE report_type_id=?', [task.report_type_id]);
    const schedule = normalizeSchedule(parse(config?.schedule_json, defaultSchedule));
    const events = reminderEvents(deadline.deadlineAt, schedule, now);
    if (!events.length) continue;
    const assignments = await currentAssignments(task);
    const recipients = [...new Set(assignments.filter(item => ['filler', 'submitter'].includes(item.responsibility)).map(item => item.userId))];
    for (const event of events) for (const userId of recipients) {
      const exists = await get(db, 'SELECT 1 AS found FROM task_reminder_deliveries WHERE task_id=? AND user_id=? AND reminder_key=?', [task.id, userId, event.key]);
      if (exists) continue;
      const notification = await run(db, `INSERT INTO notifications
        (user_id, task_id, notification_type, payload_json, scheduled_at, sent_at, status)
        VALUES (?, ?, 'task_reminder', ?, ?, CURRENT_TIMESTAMP, 'sent')`, [userId, task.id, JSON.stringify({
        label: event.label, reportType: task.report_type_name, organization: task.organization_name,
        periodCode: task.period_code, deadlineAt: deadline.deadlineAt, eventType: event.type
      }), event.at.toISOString()]);
      await run(db, 'INSERT OR IGNORE INTO task_reminder_deliveries(task_id,user_id,reminder_key,notification_id) VALUES (?,?,?,?)',
        [task.id, userId, event.key, notification.lastID]);
    }
  }
}

let scheduledReminderRun = Promise.resolve();
const scheduler = setInterval(() => {
  scheduledReminderRun = processDueReminders().catch(error => console.error('Task reminder scheduler failed:', error.message));
}, 60_000);
scheduler.unref?.();

async function stopReminderScheduler() {
  clearInterval(scheduler);
  await scheduledReminderRun;
}

async function progressRow(task) {
  const [room, revision, cancelled, deadline, assignments] = await Promise.all([
    get(db, `SELECT cr.id, cr.room_status, cr.latest_version, cr.collaboration_room_key
      FROM collaboration_rooms cr WHERE cr.task_id=? ORDER BY cr.revision_number DESC LIMIT 1`, [task.id]),
    get(db, `SELECT r.id, r.revision_number, r.revision_status, r.submitted_by, r.submitted_at,
        u.name AS submitter_name, u.username AS submitter_username
      FROM business_revisions r LEFT JOIN users u ON u.id=r.submitted_by WHERE r.id=?`, [task.current_revision_id]),
    get(db, 'SELECT reason, cancelled_at FROM task_cancellations WHERE task_id=?', [task.id]),
    effectiveDeadline(task.id, task.deadline_at), currentAssignments(task)
  ]);
  const latestEdit = room ? await get(db.collaborationDb, `SELECT op.actor_user_id AS userId, op.created_at AS editedAt
    FROM collaboration_operations op JOIN collaboration_rooms cr ON cr.id=op.room_id
    WHERE cr.room_key=? ORDER BY op.version DESC LIMIT 1`, [room.collaboration_room_key]) : null;
  const editor = latestEdit ? await get(db, 'SELECT name, username FROM users WHERE id=?', [latestEdit.userId]) : null;
  let onlineUsers = 0; let precheck = null;
  if (room) {
    onlineUsers = (await get(db.collaborationDb, `SELECT COUNT(*) AS total FROM collaboration_presence
      WHERE room_id=? AND last_seen_at >= datetime('now','-90 seconds')`, [room.id]))?.total || 0;
    try {
      const template = await get(db, `SELECT workbook_json,manifest_json FROM template_versions WHERE id=?`, [task.template_version_id]);
      const runtime = await collaboration.getRuntime();
      const snapshot = await runtime.documentServices.fetch(room.collaboration_room_key).catch(() => null);
      const summary = await buildMonthlyFillingSummary({ task: { id: task.id, reportTypeId: task.report_type_id,
        periodCode: task.period_code, configuration: parse(task.configuration_snapshot_json, {}) },
      organization: { id: task.organization_id, code: task.organization_code, name: task.organization_name },
      workbook: parse(template?.workbook_json, {}), manifest: parse(template?.manifest_json, {}), snapshot,
      roomVersion: Number(room.latest_version) });
      precheck = summary.precheck ? { version: summary.precheck.version, blockingCount: summary.precheck.blockingCount,
        warningCount: summary.precheck.warningCount, stale: summary.precheck.stale } : null;
    } catch { precheck = null; }
  }
  const status = cancelled ? 'cancelled' : task.task_status;
  const overdue = taskIsOverdue(task.task_status, cancelled, revision?.submitted_at, deadline.deadlineAt);
  return {
    id: task.id, reportTypeId: task.report_type_id, reportTypeName: task.report_type_name, cadence: task.cadence,
    periodCode: task.period_code, organizationId: task.organization_id, organizationName: task.organization_name,
    organizationCode: task.organization_code, roomCreated: Boolean(room), roomStatus: room?.room_status || null,
    hasEdits: Number(room?.latest_version || 0) > 0, onlineUsers, lastEditor: editor?.name || editor?.username || null,
    lastEditedAt: latestEdit?.editedAt || null, precheck, status, baseDeadlineAt: task.deadline_at,
    ...deadline, overdue: Boolean(overdue), cancellationReason: cancelled?.reason || null,
    cancelledAt: cancelled?.cancelled_at || null, submittedBy: revision?.submitter_name || revision?.submitter_username || null,
    submittedAt: revision?.submitted_at || null, revisionNumber: revision?.revision_number || null,
    revisionStatus: revision?.revision_status || null, reviewState: task.task_status === 'submitted' ? '待审核'
      : task.task_status === 'reviewing' ? '审核中' : task.task_status === 'finalized' ? '已定稿' : '未提交',
    assignments
  };
}

exports.listProgress = asyncRoute(async (_req, res) => {
  await processDueReminders().catch(error => console.error('Task reminder processing failed:', error.message));
  const tasks = await all(db, `SELECT t.*, rt.display_name AS report_type_name, rt.cadence,
      o.name AS organization_name, o.code AS organization_code
    FROM report_tasks t JOIN report_types rt ON rt.id=t.report_type_id JOIN organizations o ON o.id=t.organization_id
    ORDER BY t.period_code DESC, rt.display_name, o.name, t.id`);
  const rows = await Promise.all(tasks.map(progressRow));
  const schedules = await all(db, `SELECT rt.id AS reportTypeId, rt.display_name AS reportTypeName, rt.cadence,
      s.schedule_json AS scheduleJson FROM report_types rt LEFT JOIN report_type_reminder_schedules s ON s.report_type_id=rt.id
    WHERE rt.status='active' ORDER BY rt.display_name`);
  res.json({ tasks: rows, reminderSchedules: schedules.map(item => ({ reportTypeId: item.reportTypeId,
    reportTypeName: item.reportTypeName, cadence: item.cadence, schedule: normalizeSchedule(parse(item.scheduleJson, defaultSchedule)) })) });
});

exports.updateReminderSchedule = asyncRoute(async (req, res) => {
  const reportTypeId = Number(req.params.reportTypeId);
  const reportType = Number.isInteger(reportTypeId) && reportTypeId > 0 ? await get(db, 'SELECT id FROM report_types WHERE id=? AND status=\'active\'', [reportTypeId]) : null;
  if (!reportType) return res.status(404).json({ error: '报告类型不存在或已停用' });
  const body = req.body || {};
  if (body.schedule?.daysBefore != null && (!Array.isArray(body.schedule.daysBefore)
    || body.schedule.daysBefore.some(day => !Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > 30))) {
    return res.status(400).json({ error: '提前提醒天数须为 1 到 30 的整数列表' });
  }
  const schedule = normalizeSchedule(body.schedule || {});
  const previous = await get(db, 'SELECT schedule_json FROM report_type_reminder_schedules WHERE report_type_id=?', [reportTypeId]);
  await run(db, 'BEGIN IMMEDIATE');
  try {
    await run(db, `INSERT INTO report_type_reminder_schedules(report_type_id,schedule_json,updated_by)
      VALUES (?,?,?) ON CONFLICT(report_type_id) DO UPDATE SET schedule_json=excluded.schedule_json,
      updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`, [reportTypeId, JSON.stringify(schedule), req.user.id]);
    await recordBusinessAudit({ connection: db, actor: req.user, action: 'report_type.reminders.update', objectType: 'report_type',
      objectId: reportTypeId, before: parse(previous?.schedule_json, defaultSchedule), after: schedule, reason: '提醒计划配置' });
    await run(db, 'COMMIT');
  } catch (error) { await run(db, 'ROLLBACK').catch(() => {}); throw error; }
  res.json({ reportTypeId, schedule });
});

exports.listAssignees = asyncRoute(async (req, res) => {
  const taskId = Number(req.params.taskId), responsibility = req.query.responsibility;
  if (!Number.isSafeInteger(taskId) || taskId <= 0 || !allowedResponsibilities.has(responsibility)) return res.status(400).json({ error: '任务或职责无效' });
  const task = await taskById(taskId);
  if (!task) return res.status(404).json({ error: '报告任务不存在' });
  if (!responsibilityIsUnfinished(task.task_status, responsibility)) return res.status(409).json({ error: '该职责已经完成，或任务已定稿/取消，不能重新分配' });
  res.json({ users: await listTaskAssignees(db, task.organization_id, responsibility) });
});

exports.reassign = asyncRoute(async (req, res) => {
  const taskId = Number(req.params.taskId); const task = Number.isInteger(taskId) ? await taskById(taskId) : null;
  const reason = cleanReason(req.body?.reason); const responsibility = req.body?.responsibility;
  const userId = Number(req.body?.userId);
  const requestedPreviousUserId = Number(req.body?.previousUserId) || null;
  const addAssignment = req.body?.mode === 'add';
  if (req.body?.mode != null && !['add', 'replace'].includes(req.body.mode)) return res.status(400).json({ error: '责任分配模式无效' });
  if (!task) return res.status(404).json({ error: '报告任务不存在' });
  if (!allowedResponsibilities.has(responsibility) || !Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: '职责或新责任人无效' });
  if (!reason) return res.status(400).json({ error: '重新分配必须填写原因' });
  if (!responsibilityIsUnfinished(task.task_status, responsibility)) return res.status(409).json({ error: '该职责已经完成，或任务已定稿/取消，不能重新分配' });
  const user = await get(db, 'SELECT id,name,username,account_status FROM users WHERE id=?', [userId]);
  if (!user || user.account_status !== 'active') return res.status(400).json({ error: '新责任人不存在或已停用' });
  const [qualified] = await listTaskAssignees(db, task.organization_id, responsibility, userId);
  if (!qualified) return res.status(400).json({ error: '新责任人未持有此组织范围内的对应职责' });
  let previousUserId = null;
  await run(db, 'BEGIN IMMEDIATE');
  try {
    const freshTask = await taskById(task.id);
    if (!responsibilityIsUnfinished(freshTask.task_status, responsibility)) {
      await run(db, 'ROLLBACK');
      return res.status(409).json({ error: '该职责已经完成，或任务已定稿/取消，不能重新分配' });
    }
    const config = parse(freshTask.configuration_snapshot_json, {});
    const assignments = Array.isArray(config.assignments) ? [...config.assignments] : [];
    const matchingAssignments = assignments.map((item, index) => ({ item, index }))
      .filter(entry => entry.item.responsibility === responsibility);
    if (requestedPreviousUserId && !matchingAssignments.some(entry => Number(entry.item.userId) === requestedPreviousUserId)) {
      await run(db, 'ROLLBACK');
      return res.status(409).json({ error: '当前责任人已变化，请刷新任务后重试' });
    }
    if (addAssignment && matchingAssignments.some(entry => Number(entry.item.userId) === userId)) {
      await run(db, 'ROLLBACK');
      return res.status(409).json({ error: '该用户已持有此任务职责' });
    }
    if (!addAssignment && !requestedPreviousUserId && matchingAssignments.length > 1) {
      await run(db, 'ROLLBACK');
      return res.status(400).json({ error: '该职责有多位当前责任人，请指定要改派的原责任人' });
    }
    const selected = !addAssignment && matchingAssignments.find(entry => requestedPreviousUserId
      ? Number(entry.item.userId) === requestedPreviousUserId : true);
    const previousIndex = selected?.index ?? -1;
    const previous = previousIndex >= 0 ? assignments[previousIndex] : null;
    previousUserId = Number(previous?.userId ?? previous?.user_id) || null;
    if (previousUserId === userId) {
      await run(db, 'ROLLBACK');
      return res.status(409).json({ error: '此职责当前已分配给该用户' });
    }
    const assignment = { ...(previous || {}), responsibility, userId, userName: user.name, username: user.username };
    if (previousIndex >= 0) assignments[previousIndex] = assignment; else assignments.push(assignment);
    config.assignments = assignments;
    await run(db, 'UPDATE report_tasks SET configuration_snapshot_json=? WHERE id=?', [JSON.stringify(config), task.id]);
    await run(db, `INSERT INTO task_assignment_history(task_id,responsibility,previous_user_id,new_user_id,changed_by,reason)
      VALUES (?,?,?,?,?,?)`, [task.id, responsibility, previousUserId, userId, req.user.id, reason]);
    await recordBusinessAudit({ connection: db, actor: req.user, organizationId: task.organization_id, action: addAssignment ? 'report_task.assign' : 'report_task.reassign',
      objectType: 'report_task', objectId: task.id, before: { responsibility, userId: previousUserId },
      after: { responsibility, userId, userName: user.name }, reason });
    await run(db, 'COMMIT');
  } catch (error) { await run(db, 'ROLLBACK').catch(() => {}); throw error; }
  res.json({ taskId: task.id, responsibility, previousUserId, assignment: { responsibility, userId, userName: user.name }, reason });
});

exports.extendDeadline = asyncRoute(async (req, res) => {
  const taskId = Number(req.params.taskId); const task = Number.isInteger(taskId) ? await taskById(taskId) : null;
  const reason = cleanReason(req.body?.reason); const nextDate = normalizedDate(req.body?.deadlineAt);
  if (!task) return res.status(404).json({ error: '报告任务不存在' });
  if (['finalized', 'cancelled'].includes(task.task_status)) return res.status(409).json({ error: '已定稿或已取消的任务不能延长截止时间' });
  if (!reason) return res.status(400).json({ error: '延长截止时间必须填写原因' });
  const current = await effectiveDeadline(task.id, task.deadline_at);
  const previousDate = normalizedDate(current.deadlineAt);
  if (!nextDate || !previousDate || nextDate <= previousDate) return res.status(400).json({ error: '新截止时间必须晚于当前截止时间并包含有效时区' });
  await run(db, 'BEGIN IMMEDIATE');
  try {
    await run(db, `INSERT INTO task_deadline_changes(task_id,previous_deadline_at,new_deadline_at,changed_by,reason)
      VALUES (?,?,?,?,?)`, [task.id, current.deadlineAt, nextDate.toISOString(), req.user.id, reason]);
    await recordBusinessAudit({ connection: db, actor: req.user, organizationId: task.organization_id, action: 'report_task.deadline.extend',
      objectType: 'report_task', objectId: task.id, before: { deadlineAt: current.deadlineAt },
      after: { deadlineAt: nextDate.toISOString() }, reason });
    await run(db, 'COMMIT');
  } catch (error) { await run(db, 'ROLLBACK').catch(() => {}); throw error; }
  res.json({ taskId: task.id, previousDeadlineAt: current.deadlineAt, deadlineAt: nextDate.toISOString(), reason });
});

exports.cancel = asyncRoute(async (req, res) => {
  const taskId = Number(req.params.taskId); const task = Number.isInteger(taskId) ? await taskById(taskId) : null;
  const reason = cleanReason(req.body?.reason);
  if (!task) return res.status(404).json({ error: '报告任务不存在' });
  if (!reason) return res.status(400).json({ error: '取消任务必须填写原因' });
  if (['submitted', 'reviewing', 'finalized'].includes(task.task_status)) return res.status(409).json({ error: '已提交的任务不能取消' });
  if (task.task_status === 'cancelled') return res.status(409).json({ error: '任务已经取消' });
  await run(db, 'BEGIN IMMEDIATE');
  try {
    await run(db, `INSERT INTO task_cancellations(task_id,cancelled_by,reason) VALUES (?,?,?)`, [task.id, req.user.id, reason]);
    await run(db, `UPDATE report_tasks SET task_status='cancelled' WHERE id=?`, [task.id]);
    await recordBusinessAudit({ connection: db, actor: req.user, organizationId: task.organization_id, action: 'report_task.cancel',
      objectType: 'report_task', objectId: task.id, before: { status: task.task_status }, after: { status: 'cancelled' }, reason });
    await run(db, 'COMMIT');
  } catch (error) { await run(db, 'ROLLBACK').catch(() => {}); throw error; }
  res.json({ taskId: task.id, status: 'cancelled', reason });
});

exports.listNotifications = asyncRoute(async (req, res) => {
  const rt = await require('../services/notificationChannel').runtime();
  res.json(await rt.queue(service => service.list(req.user.id)));
});

exports.markNotificationRead = asyncRoute(async (req, res) => {
  const channel = require('../services/notificationChannel');
  const rt = await channel.runtime();
  try { await rt.queue(service => service.read(Number(req.params.notificationId), req.user.id)); }
  catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); throw error; }
  await channel.invalidate(req.user.id);
  res.json({ id: Number(req.params.notificationId), status: 'read' });
});

exports._test = { processDueReminders, reminderEvents, normalizeSchedule, responsibilityIsUnfinished, taskIsOverdue,
  stopReminderScheduler };
