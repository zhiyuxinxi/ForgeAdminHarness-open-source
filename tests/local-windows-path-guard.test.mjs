import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertLocalOrdinaryPath, assertLocalOutputPath, prepareLocalDirectory } from '../scripts/local-windows-path-guard.mjs';

test('accepts fixed-drive ordinary paths and creates only one child below a verified parent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-local-path-')); const file = path.join(root, 'input.txt'); await writeFile(file, 'x');
  assert.equal(await assertLocalOrdinaryPath(file, 'input'), file);
  assert.equal(await assertLocalOutputPath(path.join(root, 'output.json')), path.join(root, 'output.json'));
  const created = path.join(root, 'receipts'); assert.equal(await prepareLocalDirectory(created, 'receipts'), created);
  assert.equal((await lstat(created)).isDirectory(), true);
});

test('rejects UNC, device, remote-style, and comma-delimited paths before filesystem access', async () => {
  for (const value of [
    '\\\\server\\share\\input.json', '\\\\?\\C:\\input.json', '\\\\.\\C:\\input.json', '\\??\\C:\\input.json',
    '//server/share/input.json', 'https://server/input.json', `${path.parse(process.cwd()).root}unsafe,name`,
  ]) await assert.rejects(() => assertLocalOrdinaryPath(value, 'input'), { code: 'LOCAL_PATH_INVALID' });
});

test('rejects a junction/reparse traversal and does not recursively create through a missing parent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-local-path-junction-')); const target = path.join(root, 'target'); const junction = path.join(root, 'junction');
  await mkdir(target); await writeFile(path.join(target, 'input.txt'), 'x'); await symlink(target, junction, 'junction');
  await assert.rejects(() => assertLocalOrdinaryPath(path.join(junction, 'input.txt'), 'junction input'), { code: 'LOCAL_PATH_INVALID' });
  const nested = path.join(root, 'missing-parent', 'receipts');
  await assert.rejects(() => prepareLocalDirectory(nested, 'receipt root'), { code: 'LOCAL_PATH_INVALID' });
  await assert.rejects(() => lstat(path.join(root, 'missing-parent')), { code: 'ENOENT' });
});
