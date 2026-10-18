import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCommand } from '../docker/harness/release-runner.mjs';

const limit = 2 * 1024 * 1024;

test('build output tail stays bounded and retains completion after verbose downloads', async () => {
  const result = await runCommand(process.execPath, ['-e', `
    process.stdout.write(Buffer.alloc(${limit + 65536}, 120), () => {
      process.stderr.write('BUILD SUCCESS\\n');
    });
  `], { outputMode: 'tail' });
  assert.equal(result.code, 0);
  assert.equal(result.outputTruncated, true);
  assert.ok(Buffer.byteLength(result.output) <= limit);
  assert.ok(result.output.endsWith('BUILD SUCCESS\n'));
});

test('verbose build failure preserves real exit code and final diagnostic', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', `
    process.stdout.write(Buffer.alloc(${limit + 65536}, 120), () => {
      process.stderr.write('COMPILATION FAILED: example.java:42\\n', () => process.exit(7));
    });
  `], { outputMode: 'tail' }), error => {
    assert.match(error.message, /failed with exit 7/);
    assert.match(error.output, /COMPILATION FAILED: example\.java:42/);
    return true;
  });
});

test('commands requiring complete output still reject overflow', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', `
    process.stdout.write(Buffer.alloc(${limit + 65536}, 120));
  `]), /output exceeded the runner limit/);
});
