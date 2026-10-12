import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('Gateway UI upgrade is versioned, rollback-capable, and service-bounded', async () => {
  const source = await readFile(path.resolve('scripts/upgrade-conversation-gateway-ui.sh'), 'utf8');
  const projectControl = await readFile(path.resolve('scripts/projectctl.sh'), 'utf8');
  assert.match(source, /--confirm-maintenance-window conversation-gateway-ui/);
  assert.match(source, /Dockerfile\.legacy-conversation-surface/);
  assert.match(source, /verify_target_harness_image_legacy_surface/);
  assert.match(source, /target\.length <= base\.length/);
  assert.match(source, /--entrypoint node/);
  assert.match(source, /vpn-legacy-conversation-surface-55/);
  assert.match(source, /pre-conversation-gateway-ui-/);
  assert.match(source, /restoring control-plane, registry, archive and state files/);
  assert.match(source, /up --detach --force-recreate --no-deps conversation-gateway/);
  assert.match(source, /protected-container-ids\.before/);
  assert.match(source, /protected-container-ids\.after/);
  assert.match(source, /legacy-session/);
  assert.match(source, /周长庆-测试-危废功能开发/);
  assert.match(source, /周长庆-测试-APP功能/);
  assert.match(source, /legacy_project_display_name='示例客户'/);
  assert.match(source, /-f "\$\{recovery_script\}"/);
  assert.doesNotMatch(source, /-x "\$\{recovery_script\}"/);
  assert.doesNotMatch(source, /up --detach --force-recreate --no-deps (forge-admin|forge-flow|forge-ui|release-runner|taskspace-broker|conversation-manager|harness)/);
  assert.match(projectControl, /conversation-gateway-ui[\s\S]*upgrade-conversation-gateway-ui\.sh/);
});

test('Gateway upgrade initializes the env temporary path after its source file', async () => {
  const source = await readFile(path.resolve('scripts/upgrade-conversation-gateway-ui.sh'), 'utf8');
  assert.match(source, /local file="\$1" key="\$2" value="\$3" temporary\s+temporary="\$\{file\}\.tmp\.\$\$"/);
  assert.doesNotMatch(source, /local file="\$1"[^\n]*temporary="\$\{file\}/);
});

test('Legacy recovery accepts reviewed Chinese titles and rejects control code points', async () => {
  const source = await readFile(path.resolve('scripts/recover-legacy-shared-conversations.sh'), 'utf8');
  assert.match(source, /all\(\$value \| explode\[\]; \. >= 32 and \. != 127 and \. != 65533\)/);
  assert.doesNotMatch(source, /test\("\[\\\\u0000-/);
  assert.match(source, /周长庆-测试-危废功能开发/);
  assert.match(source, /周长庆-测试-APP功能/);
});

test('Legacy orphan scan skips metadata that has no session directory', async () => {
  const source = await readFile(path.resolve('scripts/recover-legacy-shared-conversations.sh'), 'utf8');
  assert.match(source, /taskspace_sessions="\$\{task_root\}\/dsh-home\/sessions"\s+\[\[ -d "\$\{taskspace_sessions\}" \]\] \|\| continue/);
  assert.match(source, /find "\$\{taskspace_sessions\}" -type f -name session\.jsonl\.zstd -print/);
  assert.doesNotMatch(source, /find "\$\{task_root\}\/dsh-home\/sessions"/);
});
