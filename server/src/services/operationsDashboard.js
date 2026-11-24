const { createWorkflowCenter } = require('./workflowCenter');
const { assertReader } = require('./managementDashboard');
const { readStaticWorkbook } = require('./staticWorkbookFile');
const { collectFunctionRefs } = require('./managedFunctions');
const parse = (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } };
const fail = (message, status) => Object.assign(new Error(message), { status });

function createOperationsDashboard(db) {
  const all = (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (e, r) => e ? reject(e) : resolve(r)));
  async function visibleTasks(actor) {
    assertReader(actor);
    return (await createWorkflowCenter(db).list(actor)).items.filter(t => t.taskId);
  }
  async function overview(actor) {
    assertReader(actor);
    const workflow = await createWorkflowCenter(db).list(actor);
    const canManage = workflow.canManage === true;
    const tasks = workflow.items.filter(t => t.taskId), ids = tasks.map(t => t.taskId);
    const fields = await all("SELECT id,code,display_name AS name,data_type AS type,unit FROM field_definitions WHERE status='approved' ORDER BY display_name,id");
    if (!ids.length) return { tasks: [], fields, values: [], types: [], canManage };
    const marks = ids.map(() => '?').join(',');
    const revisions = await all(`SELECT r.*,v.report_json AS validationJson,v.captured_at AS checkedAt,
      (SELECT count(*) FROM anomaly_snapshots a WHERE a.revision_id=r.id) AS legacyWarningCount
      FROM business_revisions r LEFT JOIN revision_validation_snapshots v ON v.revision_id=r.id
      WHERE r.task_id IN (${marks}) ORDER BY r.revision_number DESC`, ids);
    const values = await all(`SELECT v.id,v.revision_id AS revisionId,v.field_definition_id AS fieldId,v.record_key AS recordKey,
      v.value_type AS valueType,v.text_value,v.decimal_value,v.integer_value,v.boolean_value,v.date_value,v.json_value,
      COALESCE(v.unit_snapshot,f.unit,'') AS unit,v.source_formula AS formula,v.source_sheet AS sheetName,
      v.source_row AS row,v.source_column AS col,t.id AS taskId,t.organization_id AS organizationId,
      o.name AS organizationName,t.period_code AS period,t.report_type_id AS reportTypeId,r.revision_number AS revisionNumber,r.finalized_at AS finalizedAt
      FROM business_values v JOIN business_revisions r ON r.id=v.revision_id AND r.revision_status='finalized' AND r.is_current_effective=1
      JOIN report_tasks t ON t.id=r.task_id JOIN organizations o ON o.id=t.organization_id
      JOIN field_definitions f ON f.id=v.field_definition_id AND f.status='approved'
      WHERE t.id IN (${marks}) ORDER BY t.period_code,t.id,v.id`, ids);
    const types = await all(`SELECT DISTINCT rt.id,rt.display_name AS name,rt.cadence FROM report_types rt JOIN report_tasks t ON t.report_type_id=rt.id WHERE t.id IN (${marks})`, ids);
    return { fields, types, canManage, values: values.map(valueRow), tasks: tasks.map(t => {
      const submitted = revisions.find(r => r.task_id === t.taskId && r.submitted_at);
      const effective = revisions.find(r => r.task_id === t.taskId && r.revision_status === 'finalized' && r.is_current_effective);
      return { ...t, submittedRevisionId: submitted?.id, submittedRevisionNumber: submitted?.revision_number,
        effectiveRevisionId: effective?.id, effectiveRevisionNumber: effective?.revision_number,
        validation: parse(submitted?.validationJson), checkedAt: submitted?.checkedAt,
        legacyWarningCount: submitted?.legacyWarningCount || 0 };
    }) };
  }
  async function detail(actor, taskId, revisionId) {
    const visible = await visibleTasks(actor), task = visible.find(t => t.taskId === taskId);
    if (!task) throw fail('无权查看此填报任务', 403);
    const [revision] = await all(`SELECT r.*,v.report_json AS validationJson,v.captured_at AS checkedAt,u.name AS checkedBy
      FROM business_revisions r LEFT JOIN revision_validation_snapshots v ON v.revision_id=r.id
      LEFT JOIN users u ON u.id=v.actor_user_id WHERE r.task_id=? AND r.id=? AND r.submitted_at IS NOT NULL`, [taskId, revisionId]);
    if (!revision) throw fail('提交版本不存在', 404);
    const [artifact] = await all(`SELECT storage_key FROM official_artifacts WHERE revision_id=? AND artifact_type IN ('finalized_workbook_json','spreadjs_workbook_json') ORDER BY CASE artifact_type WHEN 'finalized_workbook_json' THEN 0 ELSE 1 END,id DESC LIMIT 1`, [revisionId]);
    let workbook = null, workbookError = '';
    if (artifact) { try { workbook = await readStaticWorkbook(artifact.storage_key); } catch (e) { workbookError = e.message; } }
    else workbookError = '此版本没有归档工作簿';
    const values = await all(`SELECT v.*,v.field_definition_id AS fieldId,v.record_key AS recordKey,v.value_type AS valueType,
      v.source_formula AS formula,v.source_sheet AS sheetName,v.source_row AS row,v.source_column AS col,
      COALESCE(v.unit_snapshot,f.unit,'') AS unit,f.display_name AS name,f.code FROM business_values v
      JOIN field_definitions f ON f.id=v.field_definition_id WHERE v.revision_id=? ORDER BY f.display_name,v.id`, [revisionId]);
    const warnings = await all('SELECT id,message,explanation,disposition,rule_code AS ruleCode,field_code AS fieldCode FROM anomaly_snapshots WHERE revision_id=? ORDER BY id', [revisionId]);
    const [template] = await all('SELECT tv.workbook_json FROM template_versions tv JOIN report_tasks t ON tv.id=t.template_version_id WHERE t.id=?', [taskId]);
    const contract = parse(template?.workbook_json, {});
    const functions = collectFunctionRefs(contract).map(f => ({ name: f.name || f.functionName, versionId: f.versionId, typeName: f.sourceTypeName || f.typeName }));
    const names = new Map((contract.sheets || []).map(s => [s.code, s.name]));
    return { task, revision: { id: revision.id, number: revision.revision_number, status: revision.revision_status, effective: Boolean(revision.is_current_effective), submittedAt: revision.submitted_at, finalizedAt: revision.finalized_at },
      workbook, workbookError, values: values.map(v => ({ ...valueRow(v), sheetName: names.get(v.sheetName) || v.sheetName })),
      validation: parse(revision.validationJson), checkedAt: revision.checkedAt, checkedBy: revision.checkedBy, warnings, functions };
  }
  return { overview, detail };
}
function valueRow(row) {
  const raw = ({ decimal: row.decimal_value, integer: row.integer_value, boolean: row.boolean_value, date: row.date_value, text: row.text_value, json: row.json_value })[row.valueType];
  const value = raw == null ? null : ['decimal', 'integer'].includes(row.valueType) ? Number(raw) : row.valueType === 'boolean' ? Boolean(raw) : raw;
  const result = { ...row, value };
  for (const key of ['decimal_value','integer_value','boolean_value','date_value','text_value','json_value']) delete result[key];
  return result;
}
module.exports = { createOperationsDashboard, valueRow };
