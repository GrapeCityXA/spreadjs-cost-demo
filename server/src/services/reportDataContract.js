const crypto = require('node:crypto');
const db = require('../config/database');
const all = (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (e, r) => e ? reject(e) : resolve(r)));
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const auxiliary = sheet => ['auxiliary', 'readonly_auxiliary'].includes(sheet.type) || sheet.readOnly === true;
const typeFor = type => ({ decimal: 'number', integer: 'number', boolean: 'boolean', date: 'date', datetime: 'date' })[type] || 'string';
const systemColumns = [
  ['organizationName', '组织', 'string'], ['periodCode', '期间', 'string'],
  ['organizationCode', '组织编码', 'string'], ['taskId', '任务编号', 'number'],
  ['revisionId', '定稿修订编号', 'number'], ['recordKey', '明细记录键', 'string'],
].map(([key, label, dataType]) => ({ key, label, dataType }));
const detailName = (sheet, area) => 'Detail_' + crypto.createHash('sha256').update(JSON.stringify([sheet, area])).digest('hex').slice(0, 16);

// The contract stores field identities and layout metadata, never business values or credentials.
async function contractFor(reportTypeId) {
  reportTypeId = Number(reportTypeId);
  const [type] = await all('SELECT id,display_name AS name,cadence FROM report_types WHERE id=?', [reportTypeId]);
  if (!Number.isSafeInteger(reportTypeId) || type?.cadence !== 'monthly') throw Object.assign(new Error('请选择月度填报类型'), { status: 400 });
  const fields = new Map((await all("SELECT * FROM field_definitions WHERE status='approved' ORDER BY id")).map(f => [f.id, f]));
  const main = { name: 'ReportData', label: '业务主表', kind: 'master', columns: [...systemColumns] };
  const tables = new Map([[main.name, main]]);
  const tableFor = (sheetCode, area, label) => {
    const name = detailName(sheetCode, area);
    if (!tables.has(name)) tables.set(name, { name, label: `${label || sheetCode} · ${area || '明细'}`, kind: 'detail', sheetCode, area, columns: [...systemColumns] });
    return tables.get(name);
  };
  const addField = (table, id) => {
    const field = fields.get(Number(id));
    if (!field || table.columns.some(c => c.fieldId === field.id)) return;
    table.columns.push({ key: `field_${field.id}`, fieldId: field.id, code: field.code, label: field.display_name,
      dataType: typeFor(field.data_type), valueType: field.data_type, unit: field.unit || '', precision: field.precision });
  };
  // The catalog determines available fields, regardless of template usage or existing values.
  for (const field of fields.values()) addField(main, field.id);
  const versions = await all(`SELECT DISTINCT tv.id,tv.workbook_json FROM template_versions tv
    JOIN period_packages p ON p.template_version_id=tv.id WHERE p.report_type_id=? AND tv.status IN ('published','superseded') ORDER BY tv.id`, [reportTypeId]);
  for (const version of versions) {
    const sheets = parse(version.workbook_json).sheets || [];
    const excluded = new Set(sheets.filter(auxiliary).flatMap(s => [s.code, s.name, s.name?.slice(0, 31)]));
    const mappings = await all('SELECT * FROM template_mappings WHERE template_version_id=?', [version.id]);
    const definitions = [
      ...mappings.map(m => ({ ...parse(m.mapping_json), sheetCode: m.sheet_code, fieldDefinitionId: m.field_definition_id,
        namedArea: m.named_area, kind: m.source_kind })),
      ...sheets.filter(s => !auxiliary(s)).flatMap(s => (s.mappings || []).map(m => ({ ...m, sheetCode: s.code }))),
    ];
    for (const mapping of definitions) {
      if (excluded.has(mapping.sheetCode)) continue;
      const sheet = sheets.find(s => s.code === mapping.sheetCode);
      const target = mapping.kind === 'table' ? tableFor(mapping.sheetCode, mapping.namedArea || '', sheet?.name) : main;
      if (mapping.kind === 'table') for (const column of mapping.datasetColumns || []) addField(target, column.fieldDefinitionId);
      else addField(target, mapping.fieldDefinitionId);
    }
  }
  // Historical imports may have no published mapping. Include their real field metadata too.
  const observed = await all(`SELECT DISTINCT v.field_definition_id,(v.record_key<>'') AS hasRecords,v.source_sheet,v.source_named_area,tv.workbook_json
    FROM business_values v JOIN business_revisions r ON r.id=v.revision_id AND r.is_current_effective=1 AND r.revision_status='finalized'
    JOIN report_tasks t ON t.current_revision_id=r.id JOIN template_versions tv ON tv.id=t.template_version_id
    WHERE t.report_type_id=? AND t.task_status NOT IN ('cancelled','canceled')`, [reportTypeId]);
  for (const value of observed) {
    const sheets = parse(value.workbook_json).sheets || [];
    const sheet = sheets.find(s => [s.code, s.name, s.name?.slice(0, 31)].includes(value.source_sheet));
    if (sheet && auxiliary(sheet)) continue;
    const code = sheet?.code || value.source_sheet || '';
    const target = value.hasRecords ? tableFor(code, value.source_named_area || '', sheet?.name) : main;
    addField(target, value.field_definition_id);
  }
  return withColumnNames({ reportTypeId, reportTypeName: type.name, tables: [...tables.values()] });
}

// Keep wire keys stable; DataManager column names are a separate, versioned mapping.
function withColumnNames(contract, previous) {
  return { ...contract, columnMapping: 'named-v1', tables: contract.tables.map(table => {
    const saved = previous?.tables?.find(t => t.name === table.name);
    const used = new Set();
    const pinned = new Map();
    for (const column of table.columns) {
      const name = saved?.columns?.find(c => c.key === column.key)?.bindingName;
      if (name === undefined) continue;
      if (typeof name !== 'string' || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) || name.length > 160 || used.has(name)) {
        throw Object.assign(new Error('报表映射列名无效或重复，请重新打开模板'), { status: 400 });
      }
      used.add(name); pinned.set(column.key, name);
    }
    return { ...table, columns: table.columns.map(column => {
      let bindingName = pinned.get(column.key);
      if (!bindingName) {
        let base = (column.label || column.key).trim().replace(/[^\p{L}\p{N}_]/gu, '_').slice(0, 100) || '字段';
        if (!/^[\p{L}_]/u.test(base)) base = `字段_${base}`;
        bindingName = base;
        for (let n = 1; used.has(bindingName); n++) bindingName = `${base}_${column.key}_${n}`;
        used.add(bindingName);
      }
      return { ...column, bindingName };
    }) };
  }) };
}

function projectTables(contract, values, limit = Infinity) {
  const tables = contract.tables.map(table => ({ ...table, rows: [] }));
  const main = tables.find(t => t.kind === 'master');
  const groups = new Map();
  for (const value of values) {
    if (!groups.has(value.revisionId)) groups.set(value.revisionId, []);
    groups.get(value.revisionId).push(value);
  }
  let count = 0;
  const record = (table, value, key) => Object.fromEntries(table.columns.map(c => [c.key,
    c.fieldId ? null : c.key === 'recordKey' ? key : value[c.key] ?? null]));
  for (const group of groups.values()) {
    if (count >= limit) break;
    const head = record(main, group[0], '');
    main.rows.push(head); count++;
    const details = new Map();
    for (const value of group) {
      const table = value.recordKey ? tables.find(t => t.kind === 'detail' && t.sheetCode === value.sheetCode && t.area === (value.sourceNamedArea || '')) : main;
      if (!table) continue;
      const column = table.columns.find(c => c.fieldId === value.fieldDefinitionId);
      if (!column) continue;
      if (!value.recordKey) { head[column.key] = value.value; continue; }
      const key = JSON.stringify([table.name, value.recordKey]);
      if (!details.has(key)) {
        if (count >= limit) continue;
        const row = record(table, value, value.recordKey);
        table.rows.push(row); details.set(key, row); count++;
      }
      details.get(key)[column.key] = value.value;
    }
  }
  return tables;
}

function columnsFor(table) {
  return Object.fromEntries(table.columns.map(c => [c.bindingName || c.key, { dataName: c.key, caption: c.label, dataType: c.dataType,
    ...(c.key === 'revisionId' && table.kind === 'master' ? { isPrimaryKey: true } : {}) }]));
}
function designRows(table) {
  const empty = c => c.dataType === 'number' ? 0 : c.dataType === 'boolean' ? false : c.dataType === 'date' ? null : '';
  // Only the design endpoint calls this. Official results retain their real nulls.
  return (table.rows.length ? table.rows : [{}]).map(row => Object.fromEntries(
    table.columns.map(c => [c.key, row[c.key] ?? empty(c)])
  ));
}
module.exports = { contractFor, projectTables, columnsFor, withColumnNames, designRows };
