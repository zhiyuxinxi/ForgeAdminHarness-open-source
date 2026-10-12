import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { audit } from '../docker/harness/forge-governance.mjs';
import { normalizeReferenceProvenancePolicy } from '../docker/harness/forge-reference-provenance.mjs';

const rules = JSON.parse(readFileSync(new URL('../docker/harness/forge-governance-policy.json', import.meta.url), 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const contractId = sha('synthetic test contract');
const review = sha('synthetic review binding, never a real licence grant');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function put(root, file, content) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

function declaration(file, content, extra = {}) {
  return { path: file, oldPath: null, status: 'U', sha256: sha(content), origin: 'original-change',
    sourceIds: [], reviewEvidenceSha256: review, dependencyReviewSha256: null, ...extra };
}

async function fixture(t, baseline = {}) {
  const parent = os.tmpdir();
  const root = await mkdtemp(path.join(parent, 'forge-origin-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(parent));
    assert.ok(path.basename(root).startsWith('forge-origin-test-'));
    await rm(root, { recursive: true, force: true });
  });
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Origin Fixture');
  git(root, 'config', 'user.email', 'origin@example.invalid');
  git(root, 'config', 'forge-delivery.project-slug', 'forge-origin-test');
  await put(root, '.gitkeep', 'baseline\n');
  for (const [file, content] of Object.entries(baseline)) await put(root, file, content);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
  const head = git(root, 'rev-parse', 'HEAD');
  const policy = { schemaVersion: 1, contractId, repository: 'forge-origin-test', baseCommit: head, head,
    sourceManifestSha256: sha('synthetic selected-source inventory'), reviewEvidenceSha256: review,
    sources: [], files: [], prohibitedPaths: [], prohibitedIdentifiers: [] };
  const options = { root, base: head, paths: [], taskScope: { contractId, ownedPaths: ['notes'] } };
  return { root, policy, options, check: () => audit({ ...options, sourceProvenancePolicy: policy }, rules) };
}

function source(content, permission = 'unproven') {
  return { id: 'REFERENCE-1', path: 'skill/SKILL.md', sha256: sha(content), repository: null, commit: null,
    licenseExpression: null, licenseDocumentSha256: null, licenseReviewSha256: null, permission };
}

function has(receipt, code) {
  return receipt.referenceProvenance.findings.some(item => item.code === code);
}

test('actual protected task diff is bound while the checker does not issue rights or issuer authenticity', async t => {
  const f = await fixture(t);
  await put(f.root, 'notes/change.md', 'Original note.\n');
  f.policy.files = [declaration('notes/change.md', 'Original note.\n')];
  const receipt = await f.check();
  assert.equal(receipt.ok, true, JSON.stringify(receipt.findings));
  assert.equal(receipt.referenceProvenance.ok, true);
  assert.equal(receipt.referenceProvenance.licenceGrantIssued, false);
  assert.equal(receipt.referenceProvenance.protectedIssuerVerified, false);
  assert.equal(receipt.referenceProvenance.scope.completeTaskScope, true);
  assert.equal(receipt.referenceProvenance.files[0].sha256, sha('Original note.\n'));
  assert.equal(Object.hasOwn(await audit(f.options, rules), 'referenceProvenance'), false);
});

test('known source bytes cannot be relabelled original or adopted without a bound licence review', async t => {
  const f = await fixture(t);
  const content = 'A reference-only source.\n';
  await put(f.root, 'notes/change.md', content);
  f.policy.files = [declaration('notes/change.md', content)];
  f.policy.sources = [source(content)];
  assert.ok(has(await f.check(), 'UNDECLARED_REFERENCE_COPY'));
  f.policy.files[0].origin = 'reference';
  f.policy.files[0].sourceIds = ['REFERENCE-1'];
  assert.ok(has(await f.check(), 'SOURCE_PERMISSION_UNPROVEN'));
  f.policy.sources[0] = { ...source(content, 'approved'), repository: 'https://example.invalid/reference',
    commit: 'c'.repeat(40), licenseExpression: 'MIT', licenseDocumentSha256: sha('synthetic licence fixture'),
    licenseReviewSha256: review };
  assert.equal((await f.check()).referenceProvenance.ok, true);
  f.policy.sources[0].licenseDocumentSha256 = null;
  await assert.rejects(f.check, /approved source requires/u);
});

test('actual changed bytes and both omitted and extra origin records fail closed', async t => {
  const f = await fixture(t);
  await put(f.root, 'notes/change.md', 'Changed after review.\n');
  f.policy.files = [declaration('notes/change.md', 'Reviewed bytes.\n')];
  assert.ok(has(await f.check(), 'FILE_BINDING_MISMATCH'));
  f.policy.files[0].sha256 = sha('Changed after review.\n');
  await put(f.root, 'notes/unlisted.md', 'Additional task file.\n');
  assert.ok(has(await f.check(), 'MISSING_ORIGIN'));
  f.policy.files.push(declaration('notes/absent.md', 'Not in actual diff.\n'));
  assert.ok(has(await f.check(), 'EXTRA_DECLARATION'));
});

test('Git renames retain their actual origin and cannot escape a prohibited source directory', async t => {
  const content = 'Unique reviewed baseline document with enough content to detect an exact rename.\n';
  const f = await fixture(t, { 'notes/reference.md': content });
  await rename(path.join(f.root, 'notes/reference.md'), path.join(f.root, 'notes/moved.md'));
  git(f.root, 'add', 'notes');
  f.policy.files = [declaration('notes/moved.md', content, { status: 'R', oldPath: 'notes/reference.md' })];
  assert.equal((await f.check()).referenceProvenance.ok, true);
  f.policy.files[0].oldPath = 'notes/unrelated.md';
  assert.ok(has(await f.check(), 'FILE_BINDING_MISMATCH'));
  f.policy.files[0].oldPath = 'notes/reference.md';
  f.policy.prohibitedPaths = ['notes/reference.md'];
  assert.ok(has(await f.check(), 'PROHIBITED_PATH'));
});

test('deletion is inventoried without pretending removed source bytes need a new licence grant', async t => {
  const f = await fixture(t, { 'notes/removed.md': 'Old material.\n' });
  await rm(path.join(f.root, 'notes/removed.md'));
  f.policy.files = [declaration('notes/removed.md', '', { status: 'D', sha256: null, origin: 'deletion' })];
  assert.equal((await f.check()).referenceProvenance.ok, true);
});

test('opaque additions cannot disappear from a complete provenance result', async t => {
  const f = await fixture(t);
  await put(f.root, 'notes/change.md', 'Original note.\n');
  await put(f.root, 'notes/runtime.bin', Buffer.from([0, 255, 2]));
  f.policy.files = [declaration('notes/change.md', 'Original note.\n'),
    declaration('notes/runtime.bin', Buffer.from([0, 255, 2]))];
  const result = await f.check();
  assert.equal(result.ok, false);
  assert.equal(result.referenceProvenance.scope.completeTaskScope, false);
  assert.ok(has(result, 'UNREVIEWED_PAYLOAD'));
  assert.ok(result.referenceProvenance.files.some(file => file.path === 'notes/runtime.bin'));
});

test('changed dependency manifest and retained prohibited identifier need independent checks', async t => {
  const f = await fixture(t);
  const content = '{"name":"task-fixture","private":true,"dependencies":{"nanoid":"5.0.0"}}\n';
  await put(f.root, 'notes/package.json', content);
  f.policy.files = [declaration('notes/package.json', content)];
  assert.ok(has(await f.check(), 'DEPENDENCY_REVIEW_MISSING'));
  f.policy.files[0].dependencyReviewSha256 = review;
  assert.equal((await f.check()).referenceProvenance.ok, true);
  f.policy.prohibitedIdentifiers = ['task-fixture'];
  assert.ok(has(await f.check(), 'PROHIBITED_IDENTIFIER'));
});

test('review is invalid for a different repository, baseline, HEAD or task', async t => {
  const f = await fixture(t);
  await put(f.root, 'notes/change.md', 'Original note.\n');
  f.policy.files = [declaration('notes/change.md', 'Original note.\n')];
  for (const [key, value] of [['repository', 'other-project'], ['baseCommit', 'a'.repeat(40)], ['head', 'b'.repeat(40)]]) {
    const original = f.policy[key];
    f.policy[key] = value;
    assert.ok(has(await f.check(), 'SCOPE_MISMATCH'), key);
    f.policy[key] = original;
  }
  f.policy.contractId = 'd'.repeat(64);
  await assert.rejects(f.check, /complete matching task scope/u);
});

test('origin policy refuses duplicate paths, traversal, credential sources and incomplete approval data', async t => {
  const f = await fixture(t);
  f.policy.files = [declaration('notes/change.md', 'Original note.\n')];
  const cases = [
    p => { p.files.push(structuredClone(p.files[0])); },
    p => { p.files[0].path = '../outside.md'; },
    p => { p.sources = [{ ...source('text'), path: '.cursor/mcp.json' }]; },
    p => { p.sources = [source('text', 'approved')]; },
    p => { p.files[0].origin = 'deletion'; },
  ];
  for (const mutate of cases) {
    const candidate = structuredClone(f.policy);
    mutate(candidate);
    assert.throws(() => normalizeReferenceProvenancePolicy(candidate), /Invalid reference provenance policy/u);
  }
  const original = structuredClone(f.policy);
  normalizeReferenceProvenancePolicy(f.policy);
  assert.deepEqual(f.policy, original);
});

test('bounded policy rejects an oversized reviewed inventory before transport', async t => {
  const f = await fixture(t);
  f.policy.files = Array.from({ length: 500 }, (_, i) => declaration('notes/item-' + i + '.md', 'original'));
  assert.throws(() => normalizeReferenceProvenancePolicy(f.policy), /policy size/u);
});

test('CLI consumes the same reviewed policy only with the matching complete task scope', async t => {
  const f = await fixture(t);
  await put(f.root, 'notes/change.md', 'Original note.\n');
  f.policy.files = [declaration('notes/change.md', 'Original note.\n')];
  const cli = path.resolve(import.meta.dirname, '../docker/harness/forge-governance');
  const prefix = [cli, 'audit', '--root', f.root, '--base', f.policy.baseCommit, '--format', 'json'];
  const supplied = ['--source-provenance-policy', JSON.stringify(f.policy)];
  const invoke = args => spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  const rejected = invoke([...prefix, ...supplied]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout + rejected.stderr, /complete matching task scope/u);
  const result = invoke([...prefix, '--task-contract-id', contractId, '--task-owned-path', 'notes', ...supplied]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).referenceProvenance.ok, true);
  const diagnostic = invoke([...prefix, '--path', 'notes/change.md', ...supplied]);
  assert.notEqual(diagnostic.status, 0);
});
