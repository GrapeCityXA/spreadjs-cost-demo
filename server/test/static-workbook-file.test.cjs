const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readStaticWorkbook } = require('../src/services/staticWorkbookFile');

test('static workbook paths accept aliases but reject files outside the archive', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'static-workbook-path-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'artifacts'), sibling = `${root}-other`;
  await fs.mkdir(root); await fs.mkdir(sibling);
  const file = path.join(root, 'workbook.json'), outside = path.join(sibling, 'outside.json');
  const workbook = { sheets: { Sheet1: { name: 'Sheet1' } } };
  await fs.writeFile(file, JSON.stringify(workbook)); await fs.writeFile(outside, '{}');

  await t.test('canonical root and original temporary/short path identify the same file', async () => {
    assert.deepEqual(await readStaticWorkbook(file, await fs.realpath(root)), workbook);
    if (process.platform === 'win32') assert.deepEqual(await readStaticWorkbook(file.toUpperCase(), root), workbook);
  });
  await t.test('existing content wrapper remains supported', async () => {
    const wrapped = path.join(root, 'wrapped.json');
    await fs.writeFile(wrapped, JSON.stringify({ content: JSON.stringify(workbook) }));
    assert.deepEqual(await readStaticWorkbook(wrapped, root), workbook);
  });
  await t.test('sibling prefix, traversal and archive root are rejected', async () => {
    for (const target of [outside, path.join(root, '..', 'artifacts-other', 'outside.json'), root, temp]) {
      await assert.rejects(readStaticWorkbook(target, root), { status: 409, message: '静态工作簿文件位置无效' });
    }
  });
  await t.test('directory link cannot escape the archive', async () => {
    const link = path.join(root, 'linked');
    await fs.symlink(sibling, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readStaticWorkbook(path.join(link, 'outside.json'), root), { status: 409, message: '静态工作簿文件位置无效' });
  });
  await t.test('missing file is reported as unreadable', async () => {
    await assert.rejects(readStaticWorkbook(path.join(root, 'missing.json'), root), { status: 409, message: '静态工作簿文件无法读取' });
  });
});
