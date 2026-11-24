export function aggregateMetric(values, { fieldId, reportTypeId, period = '', organizationId = '', operation = 'sum', group = 'organization' }) {
  const selected = values.filter(v => Number(v.fieldId) === Number(fieldId) && Number(v.reportTypeId) === Number(reportTypeId)
    && (!period || v.period === period) && (!organizationId || Number(v.organizationId) === Number(organizationId)));
  const usable = selected.filter(v => v.value !== null && v.value !== undefined);
  if (!usable.length) return { rows: [], sources: selected, unit: '', message: '所选范围暂无该字段的有效定稿值。' };
  const units = new Set(usable.map(v => v.unit || ''));
  if (units.size > 1) return { rows: [], sources: selected, unit: '', message: '历史数据单位不一致，请缩小期间或公司范围后查看。' };
  if (usable.some(v => typeof v.value === 'number' && !Number.isFinite(v.value))) return { rows: [], sources: selected, unit: '', message: '数据包含超出数值范围的值，请检查来源数据。' };
  if (operation !== 'latest' && usable.some(v => !['decimal', 'integer'].includes(v.valueType) || !Number.isFinite(v.value))) {
    return { rows: [], sources: selected, unit: '', message: '此字段包含非数值数据，请使用“最新记录”。' };
  }
  const groups = new Map();
  for (const v of usable) { const key = group === 'period' ? v.period : v.organizationId; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(v) }
  const rows = [...groups.entries()].map(([key, items]) => {
    // Keep the original period/date/id precedence and first-record tie break,
    // without sorting every record just to select one latest item.
    const latest = items.reduce((current, item) =>
      (String(item.period).localeCompare(current.period) || String(item.finalizedAt).localeCompare(current.finalizedAt) || item.id - current.id) > 0 ? item : current);
    const total = operation === 'latest' ? latest.value : items.reduce((n, v) => n + v.value, 0);
    return { key: `${group}:${key}`, label: group === 'period' ? latest.period : latest.organizationName,
      value: operation === 'average' ? total / items.length : total, count: operation === 'latest' ? 1 : items.length, latest, sources: operation === 'latest' ? [latest] : items };
  });
  if (rows.some(row => typeof row.value === 'number' && !Number.isFinite(row.value))) return { rows: [], sources: selected, unit: '', message: '汇总结果超出数值范围，请缩小期间或公司范围。' };
  return { unit: [...units][0], message: '', sources: rows.flatMap(row => row.sources), rows };
}
