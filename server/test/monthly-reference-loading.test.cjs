const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');

// Exercise the real report queries without opening or migrating any workspace database.
const db = new sqlite3.Database(':memory:');
const databaseModule = require.resolve('../src/config/database');
require.cache[databaseModule] = { id: databaseModule, filename: databaseModule, loaded: true, exports: db };
const { loadMonthlyReferenceReport, listMonthlyReferenceVersions } = require('../src/services/monthlyReferenceReport');
const exec = sql => new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
const load = () => loadMonthlyReferenceReport({ periodCode: '2027-01', reportTypeId: 4 });
test.after(() => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())));

test('loads explicit collaboration fields only from effective finalized monthly revisions', async t => {
  await exec(`
    CREATE TABLE report_types (id INTEGER PRIMARY KEY, cadence TEXT, display_name TEXT);
    CREATE TABLE organizations (id INTEGER PRIMARY KEY, code TEXT, name TEXT);
    CREATE TABLE period_packages (id INTEGER PRIMARY KEY, version INTEGER, template_version_id INTEGER,
      report_type_id INTEGER, period_code TEXT, status TEXT);
    CREATE TABLE report_tasks (id INTEGER PRIMARY KEY, organization_id INTEGER, package_id INTEGER,
      report_type_id INTEGER, period_code TEXT, current_revision_id INTEGER);
    CREATE TABLE business_revisions (id INTEGER PRIMARY KEY, revision_status TEXT, is_current_effective INTEGER);
    CREATE TABLE field_definitions (id INTEGER PRIMARY KEY, code TEXT, display_name TEXT);
    CREATE TABLE business_values (revision_id INTEGER, field_definition_id INTEGER, decimal_value TEXT,
      integer_value INTEGER, text_value TEXT, record_key TEXT);
    CREATE TABLE package_targets (package_id INTEGER, organization_id INTEGER, field_definition_id INTEGER,
      target_phase TEXT, phase_period TEXT, amount_decimal TEXT);
    INSERT INTO report_types VALUES (4, 'monthly', '手工体验月报 A'), (5, 'monthly', '另一个报告类型');
    INSERT INTO organizations VALUES (1, 'DEMO_ORG', '体验组织');
    INSERT INTO period_packages VALUES (4, 1, 12, 4, '2027-01', 'active');
    INSERT INTO report_tasks VALUES (4, 1, 4, 4, '2027-01', 7), (5, 1, 4, 5, '2027-01', 8);
    INSERT INTO business_revisions VALUES (7, 'submitted', 0), (8, 'finalized', 1), (9, 'finalized', 0);
    INSERT INTO field_definitions VALUES
      (1, 'BROWSER_CURRENT_REVENUE', '本月营业收入'), (2, 'BROWSER_CURRENT_PROFIT', '本月利润总额'),
      (3, 'BROWSER_PRIOR_REVENUE', '上年同月营业收入'), (4, 'BROWSER_PRIOR_PROFIT', '上年同月利润总额'),
      (5, 'UNREGISTERED_PROFIT', '本月利润总额'), (6, 'profit', '利润');
    INSERT INTO business_values (revision_id, field_definition_id, decimal_value) VALUES
      (7, 2, '11'), (7, 3, '100'), (7, 4, '10'), (7, 5, '999'), (8, 2, '800'), (9, 2, '900');
    INSERT INTO package_targets VALUES (4, 1, 2, 'cumulative', '2027-01', '10');
  `);
  await t.test('submitted data stays unavailable', async () => {
    const report = await load();
    assert.equal(report.finalizedOrganizations, 0);
    assert.equal(report.rows[0].metrics.profit.currentYearToDate.value, null);
  });
  await t.test('finalized but not effective data stays unavailable', async () => {
    await exec("UPDATE business_revisions SET revision_status = 'finalized' WHERE id = 7");
    assert.equal((await load()).rows[0].metrics.profit.currentYearToDate.value, null);
  });
  await t.test('profit is visible, missing revenue stays missing, and unrelated values are excluded', async () => {
    await exec('UPDATE business_revisions SET is_current_effective = 1 WHERE id = 7');
    const report = await load();
    const { profit, revenue } = report.rows[0].metrics;
    assert.equal(report.finalizedOrganizations, 1);
    assert.equal(profit.currentMonth, 11);
    assert.equal(profit.currentYearToDate.value, 11);
    assert.equal(profit.cumulativeCompletionRate, 1.1);
    assert.equal(profit.priorYearToDate.value, null, 'same-year prior inputs cannot replace prior-year finalized history');
    assert.equal(revenue.currentMonth, null);
    assert.equal(revenue.currentYearToDate.complete, false);
    assert.deepEqual(report.rows[0].sourceRevisions, [{ periodCode: '2027-01', revisionId: 7 }]);
    assert.equal(report.consolidationAvailable, false);
    assert.equal(report.totals.profit.currentYearToDate.value, null, 'individual display must not enable ungoverned consolidation');
  });
  await t.test('revenue and prior-year effective history use explicit field codes', async () => {
    await exec(`INSERT INTO business_values (revision_id, field_definition_id, decimal_value) VALUES (7, 1, '120');
      INSERT INTO business_revisions VALUES (10, 'finalized', 1);
      INSERT INTO report_tasks VALUES (6, 1, 4, 4, '2026-01', 10);
      INSERT INTO business_values (revision_id, field_definition_id, decimal_value) VALUES (10, 2, '10'), (10, 1, '100');`);
    const report = await load();
    assert.equal(report.rows[0].metrics.revenue.currentYearToDate.value, 120);
    assert.equal(report.rows[0].metrics.revenue.yearOverYearChange, 0.2);
    assert.equal(report.rows[0].metrics.profit.priorYearSameMonth, 10);
  });
  await t.test('duplicate metric fields remain an explicit mapping error', async () => {
    await exec("INSERT INTO business_values (revision_id, field_definition_id, decimal_value) VALUES (7, 6, '2')");
    await assert.rejects(load(), error => error.status === 409 && /多个字段/.test(error.message));
    await exec('DELETE FROM business_values WHERE field_definition_id = 6');
  });
  await t.test('explicit versions isolate organizations, targets, revisions and historical values', async () => {
    await exec(`
      INSERT INTO organizations VALUES (2, 'SECOND', '第二组织');
      INSERT INTO period_packages VALUES (11, 2, 13, 4, '2027-01', 'active'),
        (12, 1, 12, 4, '2026-01', 'closed'), (13, 3, 13, 4, '2027-01', 'draft');
      INSERT INTO business_revisions VALUES (11, 'finalized', 1), (12, 'finalized', 1), (13, 'finalized', 1);
      INSERT INTO report_tasks VALUES (11, 1, 11, 4, '2027-01', 11), (12, 2, 11, 4, '2027-01', 12),
        (13, 1, 12, 4, '2026-01', 13);
      INSERT INTO business_values (revision_id, field_definition_id, decimal_value) VALUES
        (11, 2, '220'), (12, 2, '50'), (13, 2, '9999');
      INSERT INTO package_targets VALUES (11, 1, 2, 'cumulative', '2027-01', '200'),
        (11, 1, 2, 'annual', '2027', '2000');
    `);
    const query = { periodCode: '2027-01', reportTypeId: 4 };
    const versions = await listMonthlyReferenceVersions(query);
    assert.deepEqual(versions.map(item => item.id), [11, 4]);
    await assert.rejects(load(), error => error.status === 409 && /选择配置版本/.test(error.message));
    const first = await loadMonthlyReferenceReport({ ...query, configurationPackageId: 4 });
    assert.equal(first.participatingOrganizations, 1);
    assert.equal(first.rows[0].metrics.profit.currentMonth, 11);
    assert.equal(first.rows[0].metrics.profit.cumulativeTarget, 10);
    assert.equal(first.rows[0].metrics.profit.priorYearSameMonth, 10, 'other-package historical value is excluded');
    const second = await loadMonthlyReferenceReport({ ...query, configurationPackageId: '11' });
    assert.equal(second.configurationVersion, 2);
    assert.equal(second.templateVersionId, 13);
    assert.equal(second.finalizedOrganizations, 2);
    assert.equal(second.participatingOrganizations, 2);
    const row = second.rows.find(item => item.organizationId === 1);
    assert.equal(row.reportRevisionId, 11);
    assert.equal(row.metrics.profit.currentMonth, 220);
    assert.equal(row.metrics.profit.cumulativeTarget, 200);
    assert.equal(row.metrics.profit.annualTarget, 2000);
    assert.equal(row.metrics.profit.priorYearSameMonth, null);
    assert.deepEqual(row.sourceRevisions, [{ periodCode: '2027-01', revisionId: 11 }]);
    for (const id of [12, 13, 999]) await assert.rejects(loadMonthlyReferenceReport({ ...query, configurationPackageId: id }), error => error.status === 409);
    await assert.rejects(loadMonthlyReferenceReport({ ...query, reportTypeId: 5, configurationPackageId: 11 }), error => error.status === 409);
    for (const id of ['', 'oops', 0, -1, 1.5]) await assert.rejects(loadMonthlyReferenceReport({ ...query, configurationPackageId: id }), error => error.status === 400);
  });
});
