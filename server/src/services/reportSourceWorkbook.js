// Runs inside the isolated SpreadJS renderer. Never load live auxiliary data here.
function prepareReportSources(sources, sourceWorkbooks, reservedNames, reservedTables = []) {
  const S = GC.Spread.Sheets;
  const used = new Set(reservedNames.map(name => name.toLowerCase()));
  const usedTables = new Set(reservedTables.map(name => name.toLowerCase()));
  const uniqueName = requested => {
    const base = requested.replace(/[\\/*?:\[\]]/g, '_').replace(/^'+|'+$/g, '') || '来源';
    let name = base.slice(0, 31), n = 1;
    while (used.has(name.toLowerCase())) { const suffix = `_${n++}`; name = base.slice(0, 31 - suffix.length) + suffix; }
    used.add(name.toLowerCase()); return name;
  };
  const groups = sourceWorkbooks || sources.map((source, index) => ({ revisionId: `legacy-${index}`,
    workbook: { namedStyles: source.workbookStyles || [], sheets: { [source.json.name]: source.json } },
    selected: [{ ...source, sheetName: source.json.name }] }));
  const result = [];
  for (const [groupIndex, group] of groups.entries()) {
    const selected = group.selected || sources.filter(source => source.revisionId === group.revisionId);
    if (!selected.length) continue;
    const raw = structuredClone(group.workbook);
    delete raw.dataManager;
    // Bindings have already been materialized by submission. Retain their values.
    for (const sheet of Object.values(raw.sheets || {})) {
      delete sheet.dataSource; delete sheet.bindingManager;
      for (const cells of Object.values(sheet.data?.dataTable || {})) for (const cell of Object.values(cells)) delete cell.bindingPath;
    }
    const book = new S.Workbook(document.createElement('div'));
    try {
      if (raw.collaborationInfo) {
        book.collaboration.registerCollaborationType(type);
        book.collaboration.fromSnapshot(raw);
      } else {
        if (raw.activeSheetId) throw new Error('定稿快照缺少协作格式信息，无法恢复公式');
        // Older archives used internal keys instead of worksheet names. Native
        // SSJSON resolves formulas in a second pass by the worksheet-name key.
        raw.sheets = Object.fromEntries(Object.values(raw.sheets).map((sheet, index) =>
          [sheet.name, { ...sheet, index: sheet.index ?? index }]));
        raw.sheetCount = Object.keys(raw.sheets).length;
        book.fromJSON(raw);
      }
      // Native snapshots omit many formula caches. Force one calculation pass so
      // the appended source sheet shows formula results as well as formulas.
      try {
        book.options.calculationMode = S.CalculationMode.auto;
        book.resumeCalcService(true);
        book.calculate();
      } catch { /* keep archived values if a source formula cannot be calculated */ }
      const initial = book.toJSON({ includeBindingSource: false });
      // toJSON may omit formula caches even after calculate; read the evaluated
      // values explicitly and retain the formulas.
      for (const [sheetName, sheetJson] of Object.entries(initial.sheets || {})) {
        const sheet = book.getSheetFromName(sheetName);
        if (!sheet) continue;
        for (const [row, cells] of Object.entries(sheetJson.data?.dataTable || {})) {
          for (const [col, cell] of Object.entries(cells)) {
            if (!cell.formula) continue;
            const value = sheet.getValue(Number(row), Number(col));
            if (value !== undefined) cell.value = value;
          }
        }
      }
      const required = new Set(selected.map(source => source.sheetName));
      for (const name of required) {
        const sheet = book.getSheetFromName(name);
        if (!sheet) throw new Error(`定稿快照缺少工作表：${name}`);
        for (const [row, cells] of Object.entries(initial.sheets[name].data?.dataTable || {})) {
          for (const [col, cell] of Object.entries(cells)) {
            if (!cell.formula) continue;
            for (const range of sheet.getPrecedents(Number(row), Number(col)) || []) {
              if (book.getSheetFromName(range.sheetName)) required.add(range.sheetName);
            }
          }
        }
      }
      book.options.calculationMode = S.CalculationMode.manual;
      book.suspendCalcService();
      const entries = book.sheets.map((sheet, index) => ({ sheet, original: sheet.name(),
        name: uniqueName(selected.find(source => source.sheetName === sheet.name())?.name
          || `引用_${group.revisionId}_${sheet.name()}`), temporary: `__source_${groupIndex}_${index}` }));
      // Two-pass renaming prevents a target name from colliding with an original.
      const occupied = new Set([...entries.map(e => e.original), ...entries.map(e => e.name)].map(n => n.toLowerCase()));
      for (const entry of entries) {
        while (occupied.has(entry.temporary.toLowerCase())) entry.temporary += '_';
        occupied.add(entry.temporary.toLowerCase()); entry.sheet.name(entry.temporary);
      }
      for (const entry of entries) entry.sheet.name(entry.name);
      // Let the SDK rewrite table references too; no regular-expression formula edits.
      let tableIndex = 0;
      for (const sheet of book.sheets) for (const table of sheet.tables.all()) {
        let name = `Source_${groupIndex}_${tableIndex++}`;
        while (usedTables.has(name.toLowerCase()) || book.sheets.some(s => s.tables.findByName(name))) name += '_';
        usedTables.add(name.toLowerCase());
        table.name(name);
      }
      const normalized = book.toJSON({ includeBindingSource: false });
      for (const entry of entries.filter(entry => required.has(entry.original))) {
        const json = normalized.sheets[entry.name];
        const archived = Object.values(raw.sheets).find(sheet => sheet.name === entry.original);
        // Formula strings and cached values coexist in SSJSON. setValue would erase formulas.
        for (const [row, cells] of Object.entries(initial.sheets[entry.original].data?.dataTable || {})) {
          for (const [col, cell] of Object.entries(cells)) {
            const saved = archived.data?.dataTable?.[row]?.[col];
            const value = saved && Object.hasOwn(saved, 'value') && saved.value != null ? saved.value : cell.value;
            if (value !== undefined) json.data.dataTable[row][col].value = value;
          }
        }
        // Workbook names/styles become sheet-local so organizations can reuse names.
        for (const key of ['names', 'namedStyles']) {
          const items = new Map((normalized[key] || []).map(item => [item.name.toLowerCase(), item]));
          for (const item of json[key] || []) items.set(item.name.toLowerCase(), item);
          json[key] = [...items.values()];
        }
        delete json.dataSource; delete json.bindingManager;
        json.isProtected = true;
        result.push({ name: entry.name, json, revisionId: group.revisionId, originalSheetName: entry.original,
          dependencyOnly: !selected.some(source => source.sheetName === entry.original) });
      }
    } finally { book.destroy(); }
  }
  return result;
}

module.exports = { prepareReportSources };
