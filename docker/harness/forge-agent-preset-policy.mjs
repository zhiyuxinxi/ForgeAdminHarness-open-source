import { createHash } from 'node:crypto';
import { chmod, lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const POLICY_VERSION = 'forge-agent-preset-governance/v1';
const ALLOWED_PRESETS = Object.freeze(['standard']);
const DISABLED_PRESETS = Object.freeze(['code', 'cordis', 'minimal']);
const SOURCE_HASHES = Object.freeze({
  code: 'bdecfe0b26a9d56a2ffcb79694fc123bc395247969e135c62945a1ec8fb92e87',
  cordis: 'ddd9d54859c8888256046d32f569be7a07ae135c8380a75341fa4d9fcfe8ca94',
  minimal: 'c952e72ff87cb09e6d2700dcf806c6584a67cf867adcd103ec822a6c538d4f87',
  standard: 'fa14feb98daef20b810fef30bb7239a89a786de3c45c602b37743f7100d9a5af',
});
const PATCHED_HASHES = Object.freeze({
  standard: 'd7df826813b60c12bedfd4b6ab80b733a341603fd193ca37ff763951c3c596dc',
});
const SOURCE_PERSONA = [
  '    text: >-',
  '      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
].join('\n');
const GOVERNANCE_PERSONA = [
  "    text: |-",
  "      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.",
  "",
  "      FORGE_HARNESS_GOVERNANCE_V1: Follow the user goal and explicit same-task conversation intent. Repository AGENTS.md and PROJECT_CONTEXT.md provide project facts. Identity, owned paths, permissions, tenant isolation, secrets and dangerous-operation authority remain mandatory.",
  "",
  "      Invoke forge-task-contract, forge-task-router and relevant domain Skills when their information is needed. Ordinary development suspends mandatory Skill order, RED-before-edit, fixed phase percentages, edit counts, repeated independent AI review and forced closeout. This platform policy takes precedence over legacy Skill wording that requires those drafting rituals. Component, style and architecture preferences are advisory. Preserve genuine task scope and data dependencies.",
  "",
  "      Use structured read, grep, glob, edit, write and remove_file tools for repository work. Arbitrary shell and direct Git commands fail closed; Bash is reserved only for exact /usr/local/bin/forge-governance, /usr/local/bin/forge-verify, /usr/local/bin/forge-release and /usr/local/bin/forge-delivery argv shapes. forge-delivery is a CLI invoked through Bash for help, current-workspace change status/init/transition, handoff create/verify and contract inspect/bind/verify; state writes require the current scoped writer contract and source paths stay inside its owned scope. Its state labels and handoff records never prove tests, execution, acceptance or release; verify record is not a model-facing operation. forge-release is a CLI invoked through Bash, not a separately registered tool. Use its supported inspection and authorized checkpoint, integrate and release actions under the valid Forge Task Execution Contract, which binds authority and owned paths. The trusted runtime renews eligible same-task draft leases; the model cannot forge or refresh authority.",
  "",
  "      Draft, inspect and add focused regression tests in the order that advances the user goal. Run focused checks during iteration; do not run the full suite after every edit. Start long verification in the supported background mode, keep its job ID, and continue independent work or report pending status. Observe the existing job instead of resubmitting it. Reuse only evidence accepted by the trusted source and input checks.",
  "",
  "      Integration and release still require actual applicable compilation, build, necessary startup, tests, permissions, data integrity, migration safety, source/evidence binding, serialized publication and health. A draft can be saved or reported before these pass. Before claiming delivery, invoke forge-evidence-truth when needed to reconcile evidence. Missing, failed, unknown or timed-out required checks forbids claiming completed, passed, verified, or accepted. Do not invent a pass, bypass protected evidence or treat an advisory finding as a mandatory review."
].join('\n');

function fail(message) {
  throw new Error(`forge-agent-preset-policy: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function governedPersona(source, preset) {
  const first = source.indexOf(SOURCE_PERSONA);
  if (first < 0 || source.indexOf(SOURCE_PERSONA, first + SOURCE_PERSONA.length) >= 0) {
    fail(`${preset} does not contain exactly one reviewed upstream persona`);
  }
  return source.replace(SOURCE_PERSONA, GOVERNANCE_PERSONA);
}

async function checkedRoot(input) {
  if (!path.isAbsolute(input)) fail('--root must be an absolute path');
  const resolved = path.resolve(input);
  const metadata = await lstat(resolved).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) fail('preset root is missing, linked, or not a directory');
  if (await realpath(resolved) !== resolved) fail('preset root is not canonical');
  if (path.basename(resolved) !== 'agent-presets'
      || path.basename(path.dirname(resolved)) !== 'config'
      || path.basename(path.dirname(path.dirname(resolved))) !== 'dsh') {
    fail('preset root is outside the exact pinned DSH config tree');
  }
  return resolved;
}

async function presetDirectories(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    const metadata = await lstat(target);
    if (!entry.isDirectory() || metadata.isSymbolicLink()) fail(`unexpected non-directory preset entry: ${entry.name}`);
    names.push(entry.name);
  }
  return names.sort((left, right) => left.localeCompare(right, 'en'));
}

async function presetFile(root, preset) {
  const directory = path.join(root, preset);
  const directoryMetadata = await lstat(directory).catch(() => null);
  if (!directoryMetadata?.isDirectory() || directoryMetadata.isSymbolicLink()) fail(`${preset} directory is unsafe`);
  const file = path.join(directory, 'agent.cordis.yml');
  const metadata = await lstat(file).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) fail(`${preset} composition is unsafe`);
  return file;
}

async function sourceCandidates(root) {
  const expected = [...ALLOWED_PRESETS, ...DISABLED_PRESETS].sort((left, right) => left.localeCompare(right, 'en'));
  const actual = await presetDirectories(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`upstream preset roster changed: ${actual.join(', ')}`);
  }
  const candidates = new Map();
  for (const preset of expected) {
    const file = await presetFile(root, preset);
    const bytes = await readFile(file);
    const digest = sha256(bytes);
    if (digest !== SOURCE_HASHES[preset]) fail(`${preset} upstream composition hash changed: ${digest}`);
    if (ALLOWED_PRESETS.includes(preset)) {
      const candidate = Buffer.from(governedPersona(bytes.toString('utf8'), preset), 'utf8');
      candidates.set(preset, { file, bytes: candidate, sha256: sha256(candidate) });
    }
  }
  return candidates;
}

async function verify(root) {
  const actual = await presetDirectories(root);
  if (JSON.stringify(actual) !== JSON.stringify(ALLOWED_PRESETS)) {
    fail(`runtime preset roster must be exactly ${ALLOWED_PRESETS.join(', ')}, found ${actual.join(', ')}`);
  }
  const receipts = [];
  for (const preset of ALLOWED_PRESETS) {
    const file = await presetFile(root, preset);
    const bytes = await readFile(file);
    const digest = sha256(bytes);
    if (digest !== PATCHED_HASHES[preset]) fail(`${preset} governed composition hash mismatch: ${digest}`);
    const text = bytes.toString('utf8');
    for (const marker of [
      'FORGE_HARNESS_GOVERNANCE_V1',
      'Invoke forge-task-contract, forge-task-router',
      'Arbitrary shell and direct Git commands fail closed',
      'invoke forge-evidence-truth',
      'forbids claiming completed',
    ]) {
      if (!text.includes(marker)) fail(`${preset} is missing governance marker: ${marker}`);
    }
    if (/\bcomplete:\s*true\b/u.test(text)) fail(`${preset} suppresses required prompt assembly`);
    receipts.push({ preset, sha256: digest, bytes: bytes.length });
  }
  return {
    ok: true,
    schemaVersion: POLICY_VERSION,
    allowedPresets: [...ALLOWED_PRESETS],
    includeUserRoot: false,
    presets: receipts,
  };
}

async function apply(root) {
  const candidates = await sourceCandidates(root);
  for (const preset of ALLOWED_PRESETS) {
    const candidate = candidates.get(preset);
    if (PATCHED_HASHES[preset] !== candidate.sha256) {
      fail(`${preset} patched hash constant is stale: ${candidate.sha256}`);
    }
    await writeFile(candidate.file, candidate.bytes, { flag: 'w', mode: 0o644 });
    await chmod(candidate.file, 0o644);
  }
  for (const preset of DISABLED_PRESETS) {
    const directory = path.join(root, preset);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(`${preset} disable target is unsafe`);
    await rm(directory, { recursive: true, force: false });
  }
  return verify(root);
}

async function upgrade(root) {
  const roster = await presetDirectories(root);
  if (JSON.stringify(roster) !== JSON.stringify(ALLOWED_PRESETS)) fail('upgrade requires the pinned governed preset roster');
  const file = await presetFile(root, 'standard');
  const bytes = await readFile(file);
  if (sha256(bytes) === PATCHED_HASHES.standard) return verify(root);
  if (![
    'db71a58c3ac65b19069ad1e19e9146c8899a1cc48953301686238e3705290b52',
    '13de6951b83315a8b1ad210701abf531a82bc7b92084f1e9ef4cb20df733a337',
    '38c8c7cf621b70b237ca7e695987a2cf3e8bf0230acde5a4d0fae4296c4d8793',
    '9eaf793755e422e967fae3080ea1ddec783dc4bf0f679e011a10af78596ee6be',
  ].includes(sha256(bytes))) {
    fail('upgrade refuses an unknown governed persona');
  }
  const text = bytes.toString('utf8');
  const start = text.indexOf('    text: |-');
  const end = text.indexOf('\n\n- id: agent-instructions', start);
  const original = text.slice(0, start) + SOURCE_PERSONA + text.slice(end);
  if (start < 0 || end < 0 || sha256(Buffer.from(original)) !== SOURCE_HASHES.standard) {
    fail('upgrade could not recover the exact pinned upstream composition');
  }
  const candidate = Buffer.from(governedPersona(original, 'standard'));
  if (sha256(candidate) !== PATCHED_HASHES.standard) fail('upgrade candidate hash mismatch');
  await writeFile(file, candidate, { flag: 'w', mode: 0o644 });
  return verify(root);
}

function parseArguments(argv) {
  const [command, flag, value, ...rest] = argv;
  if (!['apply', 'preview', 'verify', 'upgrade'].includes(command) || flag !== '--root' || !value || rest.length > 0) {
    fail('usage: forge-agent-preset-policy.mjs <apply|preview|verify|upgrade> --root <absolute-dsh-agent-presets-root>');
  }
  return { command, root: value };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = await checkedRoot(options.root);
  if (options.command === 'preview') {
    const candidates = await sourceCandidates(root);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schemaVersion: POLICY_VERSION,
      candidates: [...candidates].map(([preset, item]) => ({ preset, sha256: item.sha256, bytes: item.bytes.length })),
    })}\n`);
    return;
  }
  const receipt = options.command === 'apply' ? await apply(root) : options.command === 'upgrade' ? await upgrade(root) : await verify(root);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { apply, governedPersona, verify };
