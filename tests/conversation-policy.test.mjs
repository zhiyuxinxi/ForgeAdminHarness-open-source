import assert from 'node:assert/strict';
import test from 'node:test';

import {
  can,
  hashPassword,
  normalizeUsername,
  stripGatewayCookies,
  validatePassword,
  verifyPassword,
} from '../docker/harness/conversation-policy.mjs';

test('role permissions separate own conversations, account administration and audit', () => {
  assert.equal(can('member', 'conversation:open-own'), true);
  assert.equal(can('member', 'workspace:write-own'), true);
  assert.equal(can('admin', 'workspace:write-own'), true);
  assert.equal(can('auditor', 'workspace:write-own'), false);
  assert.equal(can('member', 'user:manage'), false);
  assert.equal(can('member', 'material:read-shared'), true);
  assert.equal(can('member', 'material:review'), false);
  assert.equal(can('admin', 'user:manage'), true);
  assert.equal(can('admin', 'material:review'), true);
  assert.equal(can('admin', 'conversation:open-any'), false);
  assert.equal(can('auditor', 'audit:read'), true);
  assert.equal(can('auditor', 'conversation:create'), false);
  assert.equal(can('auditor', 'material:read-shared'), false);
});

test('password hashes use the pinned scrypt parameters and verify without plaintext storage', async () => {
  const password = 'Correct-horse-battery-2026!';
  const encoded = await hashPassword(password);
  assert.match(encoded, /^scrypt\$32768\$8\$1\$/);
  assert.equal(encoded.includes(password), false);
  assert.equal(await verifyPassword(password, encoded), true);
  assert.equal(await verifyPassword('incorrect-password-value', encoded), false);
  assert.throws(() => validatePassword('too-short'), /14-256/);
  assert.throws(() => validatePassword('admin-secure-password', 'admin'), /用户名/);
});

test('usernames are canonical and gateway credentials never reach Harness upstream', () => {
  assert.equal(normalizeUsername('  Alice.Smith  '), 'alice.smith');
  assert.throws(() => normalizeUsername('../escape'), /用户名/);
  assert.equal(
    stripGatewayCookies('forge_gateway_session=secret; useful=value; forge_gateway_future=secret2'),
    'useful=value',
  );
  assert.equal(stripGatewayCookies('forge_gateway_session=secret'), undefined);
});
