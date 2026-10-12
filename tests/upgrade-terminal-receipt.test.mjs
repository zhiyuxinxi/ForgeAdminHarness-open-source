import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = await readFile('scripts/upgrade-forge-delivery-toolkit.sh', 'utf8');
const start = source.indexOf('write_upgrade_terminal_receipt() {');
assert.ok(start > 0);
const end = source.indexOf('\n}\n', start);
assert.ok(end > start);
const writer = source.slice(start, end + 2);

async function runFixture(context, scenario) {
  if (process.platform !== 'linux') { context.skip('Actual Linux Bash, jq and file publication semantics required.'); return null; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-upgrade-receipt-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'source/scripts'), { recursive: true });
  await mkdir(path.join(root, 'source/config'), { recursive: true });
  await writeFile(path.join(root, 'source/scripts/upgrade-forge-delivery-toolkit.sh'), source);
  await writeFile(path.join(root, 'source/config/versions.env'), 'HARNESS_IMAGE_REVISION=fixture\n');
  const script = String.raw`set -euo pipefail
fixture="$1"; scenario="$2"
DELIVERY_ROOT="$fixture/runtime"; REPO_ROOT="$fixture/source"; SCRIPT_DIR="$REPO_ROOT/scripts"
backup_root="$DELIVERY_ROOT/platform-backups/pre-forge-delivery-toolkit-fixture"
mkdir -p "$backup_root"; chmod 0700 "$backup_root"
maintenance_epoch=toolkit-fixture; confirmation=forge-delivery-toolkit; project_slugs=(fixture)
target_image_id=sha256:${'a'.repeat(64)}; conversation_manager_image_id="$target_image_id"; expected_base_image_id=sha256:${'b'.repeat(64)}
upgrade_script_sha256="$(sha256sum "$SCRIPT_DIR/upgrade-forge-delivery-toolkit.sh" | awk '{print $1}')"
upgrade_versions_sha256="$(sha256sum "$REPO_ROOT/config/versions.env" | awk '{print $1}')"
printf 'platform\tconversation-gateway\toriginal\trunning\n' >"$backup_root/selected.before.tsv"
printf 'fixture\tforge-ui\tapplication\trunning\t-\n' >"$backup_root/preserved.before.tsv"
cp "$backup_root/selected.before.tsv" "$backup_root/selected.rollback.tsv"
cp "$backup_root/preserved.before.tsv" "$backup_root/preserved.rollback.tsv"
printf '{"ok":true,"status":"open"}\n' >"$backup_root/gateway-rollback-health.json"
${writer}
case "$scenario" in
  rollback)
    write_upgrade_terminal_receipt rolled-back 143
    first="$(sha256sum "$backup_root/upgrade-receipt.json")"
    if write_upgrade_terminal_receipt committed 0; then exit 21; fi
    test "$first" = "$(sha256sum "$backup_root/upgrade-receipt.json")"
    ;;
  committed)
    printf 'platform\tconversation-gateway\tcandidate\trunning\n' >"$backup_root/selected.committed.tsv"
    cp "$backup_root/preserved.before.tsv" "$backup_root/preserved.committed.tsv"
    printf '{"ok":true,"status":"open","epoch":"toolkit-fixture"}\n' >"$backup_root/gateway-committed-health.json"
    write_upgrade_terminal_receipt committed 0
    ;;
  incomplete)
    rm "$backup_root/selected.rollback.tsv" "$backup_root/preserved.rollback.tsv" "$backup_root/gateway-rollback-health.json"
    write_upgrade_terminal_receipt rollback-incomplete 7
    ;;
  changed)
    printf changed >"$backup_root/preserved.rollback.tsv"
    if write_upgrade_terminal_receipt rolled-back 143; then exit 22; fi
    test ! -e "$backup_root/upgrade-receipt.json"
    ;;
  symlink)
    rm "$backup_root/gateway-rollback-health.json"
    ln -s "$REPO_ROOT/config/versions.env" "$backup_root/gateway-rollback-health.json"
    if write_upgrade_terminal_receipt rolled-back 143; then exit 23; fi
    test ! -e "$backup_root/upgrade-receipt.json"
    ;;
  drift)
    printf '# changed\n' >>"$REPO_ROOT/config/versions.env"
    if write_upgrade_terminal_receipt rolled-back 143; then exit 24; fi
    test ! -e "$backup_root/upgrade-receipt.json"
    ;;
esac
`;
  const result = spawnSync('bash', ['-s', '--', root, scenario], { input: script, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  return { root, backup: path.join(root, 'runtime/platform-backups/pre-forge-delivery-toolkit-fixture') };
}

for (const scenario of ['rollback', 'committed', 'incomplete']) {
  test(`native upgrade receipt records ${scenario} without overwriting its terminal`, async context => {
    const fixture = await runFixture(context, scenario); if (!fixture) return;
    const filename = path.join(fixture.backup, 'upgrade-receipt.json');
    const receipt = JSON.parse(await readFile(filename));
    const metadata = await stat(filename);
    assert.equal(metadata.mode & 0o777, 0o444);
    assert.equal(metadata.nlink, 1);
    assert.equal(receipt.receiptType, 'forge-platform-upgrade-terminal/v1');
    assert.equal(receipt.outcome, { rollback: 'rolled-back', committed: 'committed', incomplete: 'rollback-incomplete' }[scenario]);
    assert.equal(receipt.upgradeSucceeded, scenario === 'committed');
    assert.equal(receipt.rollbackVerified, scenario === 'rollback');
    assert.equal(receipt.exitCode, { rollback: 143, committed: 0, incomplete: 7 }[scenario]);
    assert.equal(receipt.producer.scriptSha256, sha(source));
    assert.equal(receipt.maintenanceConfirmation, 'forge-delivery-toolkit');
    assert.deepEqual(receipt.projects, ['fixture']);
    for (const record of receipt.artifacts) {
      const bytes = await readFile(path.join(fixture.backup, record.path));
      assert.equal(record.sha256, sha(bytes));
      assert.equal(record.bytes, bytes.length);
    }
  });
}
for (const scenario of ['changed', 'symlink', 'drift']) {
  test(`native upgrade receipt refuses ${scenario} evidence`, async context => { await runFixture(context, scenario); });
}
test('native callers publish only after their existing completion checks', () => {
  if (process.platform === 'linux') {
    const syntax = spawnSync('bash', ['-n', 'scripts/upgrade-forge-delivery-toolkit.sh'], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
  assert.ok(source.indexOf('wait_restored_gateway_open "${gateway_before_id}"') < source.indexOf('write_upgrade_terminal_receipt rolled-back "${code}"'));
  const committedCall = source.indexOf('write_upgrade_terminal_receipt committed 0');
  assert.ok(source.indexOf('capture_selected_topology "${backup_root}/selected.committed.tsv"') < committedCall);
  assert.ok(source.indexOf('committed=true; trap - ERR EXIT') < committedCall);
  assert.match(source, /write_upgrade_terminal_receipt manual-recovery-required "\$\{code\}"/u);
});

test('SIGTERM records the interruption status instead of the preceding successful command', async context => {
  if (process.platform !== 'linux') { context.skip('Actual Linux Bash signal semantics required.'); return; }
  const traps = source.slice(source.indexOf('trap rollback ERR EXIT')).split('\n').slice(0, 3).join('\n');
  const script = `rollback() { local code=$?; trap - ERR EXIT; printf 'rollback:%s\\n' "$code"; exit "$code"; }\n${traps}\nprintf 'ready\\n'\nwhile :; do sleep 0.1; done\n`;
  const child = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let sent = false;
  child.stdout.on('data', chunk => {
    output += chunk;
    if (!sent && output.includes('ready\n')) { sent = true; child.kill('SIGTERM'); }
  });
  const terminal = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  assert.equal(sent, true);
  assert.deepEqual(terminal, { code: 143, signal: null });
  assert.match(output, /rollback:143\n/u);
});
