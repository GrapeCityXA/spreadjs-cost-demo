const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'composed-formula-'));
process.env.COST_REPORT_DB_PATH = path.join(root, 'business.db');
process.env.COST_REPORT_COLLAB_DB_PATH = path.join(root, 'collaboration.db');
process.env.COST_REPORT_TEMPLATE_DIR = path.join(root, 'templates');
process.env.COST_REPORT_ARTIFACT_DIR = path.join(root, 'artifacts');
const db = require('../src/config/database');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../src/middleware/auth');
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function(error) {
  if (error) reject(error); else resolve(this);
}));

test('composition persists shifted body/footer formulas and never shifts a saved detailed sheet twice', async () => {
  let server;
  try {
    await db.ready;
    const user = await run("INSERT INTO users(username,password,name,permissions) VALUES ('formula_test','unused','Formula test','[]')");
    await run("INSERT INTO user_roles(user_id,role_code) VALUES (?, 'system_admin')", [user.lastID]);
    const token = jwt.sign({ id: user.lastID }, JWT_SECRET, { expiresIn: '5m' });
    const app = express();
    app.use(express.json());
    app.use('/api/template-governance', require('../src/routes/templateGovernanceRoutes'));
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const request = async (route, body, method = body ? 'POST' : 'GET') => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/template-governance${route}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const payload = await response.json();
      assert.ok(response.ok, JSON.stringify(payload));
      return payload;
    };
    const components = {};
    for (const [componentType, rowCount, cells] of [
      ['header', 2, [{ row: 0, column: 0, value: 10 }, { row: 1, column: 1, formula: '=A1*2' }]],
      ['body', 3, [{ row: 0, column: 0, value: 5 }, { row: 1, column: 0, value: 7 },
        { row: 2, column: 1, formula: '=SUM(A1:A2)' }, { row: 2, column: 2, formula: '=A1+$A$1+A$1+$A2' }]],
      ['footer', 2, [{ row: 0, column: 0, value: 4 }, { row: 1, column: 1, formula: '=A1*3' },
        { row: 1, column: 2, formula: '="A1"&A1' }]]
    ]) {
      const component = await request('/components', { code: `offset_${componentType}`, name: componentType,
        componentType, rowCount, columnCount: 3, cells });
      await request(`/components/${component.componentId}/versions/${component.versionId}/submit`, {});
      components[componentType] = component.versionId;
    }
    const sheet = { code: 'main', name: 'main', type: 'business', headerVersionId: components.header,
      bodyVersionId: components.body, footerVersionId: components.footer };
    const created = await request('/templates', { name: 'Formula offsets', sheets: [sheet] });
    const route = `/templates/versions/${created.versionId}`;
    const read = async () => (await request(route)).template.workbook;
    const first = await read();
    const formulas = book => book.sheets[0].cells.filter(cell => cell.formula).map(({ row, column, formula }) => [row, column, formula]);
    assert.deepEqual(first.sheets[0].sections.map(section => section.startRow), [0, 2, 5]);
    assert.deepEqual(formulas(first), [
      [1, 1, '=A1*2'], [4, 1, '=SUM(A3:A4)'], [4, 2, '=A3+$A$1+A$1+$A4'],
      [6, 1, '=A6*3'], [6, 2, '="A1"&A6']
    ]);
    await request(route, { name: 'Formula offsets', sheets: [sheet] }, 'PUT');
    assert.deepEqual(formulas(await read()), formulas(first), 'saving composition again must start from component coordinates');
    const withoutHeader = await request('/templates', { name: 'No header', sheets: [{ ...sheet, headerVersionId: null }] });
    const second = (await request(`/templates/versions/${withoutHeader.versionId}`)).template.workbook;
    assert.deepEqual(second.sheets[0].sections.map(section => section.startRow), [0, 3]);
    assert.equal(second.sheets[0].cells.find(cell => cell.row === 4 && cell.column === 1).formula, '=A4*3');
    // Persist a sheet that has already been assembled by the browser.
    const native = { name: 'main', rowCount: 7, columnCount: 3, data: { dataTable: {
      4: { 1: { formula: 'SUM(A3:A4)' } }, 6: { 1: { formula: 'A6*3' } }
    } } };
    await request(route, { name: 'Formula offsets', sheets: [{ code: 'main', name: 'main', type: 'business',
      inlineWorkbook: { rowCount: 7, columnCount: 3, cells: first.sheets[0].cells,
        metadata: { designerJson: native, mappings: [] } } }] }, 'PUT');
    assert.deepEqual(formulas(await read()), formulas(first), 'detailed sheets already use final coordinates');
    if (process.env.FORMULA_FIXTURE_PATH) fs.writeFileSync(process.env.FORMULA_FIXTURE_PATH, JSON.stringify(first));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
    await new Promise(resolve => db.collaborationDb.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
