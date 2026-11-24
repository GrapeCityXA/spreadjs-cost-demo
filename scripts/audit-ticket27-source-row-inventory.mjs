import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = JSON.parse(await readFile(path.join(root, 'shared/quarterly-reference-profile.json'), 'utf8'));
const sourcePath = path.join(root, profile.sourceName);
const sourceBytes = await readFile(sourcePath);
const actualSha256 = createHash('sha256').update(sourceBytes).digest('hex');
if (actualSha256 !== profile.sha256) {
  throw new Error(`Ticket 27 source workbook fingerprint mismatch: expected ${profile.sha256}, got ${actualSha256}`);
}

const requireServer = createRequire(path.join(root, 'server', 'package.json'));
const ExcelJS = requireServer('exceljs');
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(sourceBytes);

const rows = [];
let populatedCellCount = 0;
let formulaCellCount = 0;
for (const sheetName of profile.companySheetNames) {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`Ticket 27 company sheet missing from source: ${sheetName}`);
  const populatedRows = [];
  for (let rowIndex = 1; rowIndex <= sheet.rowCount; rowIndex += 1) {
    const cells = [];
    for (let columnIndex = 1; columnIndex <= sheet.columnCount; columnIndex += 1) {
      const cell = sheet.getCell(rowIndex, columnIndex);
      if (cell.value == null) continue;
      cells.push(cell.address);
      populatedCellCount += 1;
      if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.SharedFormula) formulaCellCount += 1;
    }
    if (cells.length) populatedRows.push({ rowIndex, cells });
  }
  rows.push({ sheetName, populatedRows });
}

const lines = [
  '# Ticket 27 company-sheet source row locator',
  '',
  '**Status: locator only — unapproved and not applied to Template #7.**',
  '',
  `Source workbook: \`${profile.sourceName}\`  `,
  `SHA-256: \`${actualSha256}\`  `,
  `Company sheets indexed: ${rows.length}  `,
  `Populated source cells located: ${populatedCellCount}  `,
  `Formula cells found: ${formulaCellCount}`,
  '',
  'This generated inventory records cell addresses only. It does not copy cell contents, infer field names or data types, identify Organization IDs, register mappings, or approve source values, formula behavior, rules, permissions, scores, or outcomes. Use the addresses to locate candidate areas during business review; the completed and approved [business input worksheet](ticket27-business-inputs-template.md) remains the authority.',
  ''
];

for (const { sheetName, populatedRows } of rows) {
  lines.push(`## ${sheetName}`, '', '| Source row | Populated cell addresses |', '| ---: | --- |');
  for (const { rowIndex, cells } of populatedRows) {
    lines.push(`| ${rowIndex} | ${cells.map(address => `\`${address}\``).join(', ')} |`);
  }
  if (!populatedRows.length) lines.push('| — | No populated cells |');
  lines.push('');
}

await writeFile(path.join(root, 'docs/migrations/ticket27-company-sheet-row-locator.md'), `${lines.join('\n')}\n`, 'utf8');
console.log(`Wrote Ticket 27 source row locator for ${rows.length} company sheets (${populatedCellCount} populated cells, ${formulaCellCount} formula cells).`);
