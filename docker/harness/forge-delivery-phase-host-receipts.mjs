import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import { validateHostRunReceipt } from './forge-host-verification-receipt.mjs';

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const PROFILE = /^[a-z][a-z0-9-]{1,63}$/u;
const BACKEND_MODULE_PATTERN = /^forge-server\/[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;
const FRONTEND_SOURCE_FILE_PATTERN = /^forge-admin-ui\/src\/[A-Za-z0-9_./@+-]+\.(?:js|jsx|ts|tsx|vue)$/u;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TIMEOUT_MS = 60_000;
const READER_CODES = new Set([
  'PHASE_HOST_RECEIPT_UNAVAILABLE', 'PHASE_HOST_RECEIPT_TIMEOUT',
  'PHASE_HOST_RECEIPT_OUTPUT_LIMIT', 'PHASE_HOST_RECEIPT_INVALID',
]);

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function checkIdentity(projectSlug, taskId) {
  if (typeof projectSlug !== 'string' || !SAFE_ID.test(projectSlug)
    || typeof taskId !== 'string' || !SAFE_ID.test(taskId)) {
    throw failure('PHASE_HOST_RECEIPT_INPUT_INVALID');
  }
}

function withoutDiagnostics(receipt) {
  if (receipt?.logs && Object.hasOwn(receipt.logs, 'excerpt')) {
    const { excerpt, ...logs } = receipt.logs;
    if (typeof excerpt !== 'string' || Buffer.byteLength(excerpt, 'utf8') > 16 * 1024
      || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(excerpt)) {
      throw failure('PHASE_HOST_RECEIPT_INVALID');
    }
    return { ...receipt, logs };
  }
  return receipt;
}

export async function readForgePhaseHostReceipt({ projectSlug, taskId, receiptId }) {
  checkIdentity(projectSlug, taskId);
  if (typeof receiptId !== 'string' || !UUID.test(receiptId)) {
    throw failure('PHASE_HOST_RECEIPT_INPUT_INVALID');
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = childProcess.spawn('docker', [
        'exec', `forge-${projectSlug}-task-${taskId}-harness-1`,
        '/usr/local/bin/forge-verify', 'receipt', '--receipt-id', receiptId,
      ], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      reject(failure('PHASE_HOST_RECEIPT_UNAVAILABLE'));
      return;
    }
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const stop = (code) => {
      finish(failure(code));
      try { child.kill('SIGTERM'); } catch { /* The bounded caller has already failed. */ }
    };
    const timer = setTimeout(() => stop('PHASE_HOST_RECEIPT_TIMEOUT'), TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) stop('PHASE_HOST_RECEIPT_OUTPUT_LIMIT');
      else chunks.push(bytes);
    });
    child.stderr.on('data', (chunk) => {
      if (settled) return;
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_STDERR_BYTES) stop('PHASE_HOST_RECEIPT_OUTPUT_LIMIT');
    });
    child.on('error', () => finish(failure('PHASE_HOST_RECEIPT_UNAVAILABLE')));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(failure('PHASE_HOST_RECEIPT_UNAVAILABLE'));
      try {
        finish(null, withoutDiagnostics(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      } catch {
        finish(failure('PHASE_HOST_RECEIPT_INVALID'));
      }
    });
  });
}

function receiptHints(proposal, profiles, inferAccessProfile = false) {
  const hints = new Map(profiles.map((profile) => [profile, []]));
  const untyped = new Set();
  const explicitlyTyped = new Set();
  const ids = new Set();
  const visited = new Set();
  let nodes = 0;
  const visit = (value, depth) => {
    if (value === null || typeof value !== 'object' || depth > 12 || visited.has(value)) return;
    if (++nodes > 4096) return;
    visited.add(value);
    if (typeof value.receiptId === 'string' && UUID.test(value.receiptId)) {
      const id = value.receiptId;
      if (Object.hasOwn(value, 'profile')) explicitlyTyped.add(id);
      if ((hints.has(value.profile) || (inferAccessProfile && !Object.hasOwn(value, 'profile')))
        && (ids.has(id) || ids.size < 32)) {
        ids.add(id);
        if (!Object.hasOwn(value, 'profile')) untyped.add(id);
        else {
          const profileHints = hints.get(value.profile);
          if (!profileHints.includes(id)) profileHints.push(id);
        }
      }
    }
    for (const nested of Object.values(value)) visit(nested, depth + 1);
  };
  visit(proposal, 0);
  return { hints, untyped: [...untyped].filter(id => !explicitlyTyped.has(id)) };
}

function selectorsCoverPhase(profile, selectors, phaseChangedPaths, phaseId) {
  const keys = Object.keys(selectors);
  if (keys.length === 0) return true;
  if (phaseId === 'database' && profile === 'backend-module-test') {
    const module = 'forge-server/forge-business/forge-business-core';
    const testRoot = `${module}/src/test/java/`;
    return keys.length === 1 && keys[0] === 'modules' && Array.isArray(selectors.modules)
      && selectors.modules.length === 1 && selectors.modules[0] === module
      && phaseChangedPaths.some(file => file.startsWith(testRoot))
      && phaseChangedPaths.every(file => typeof file === 'string' && !file.split('/').includes('..')
        && (file.startsWith('forge-server/db/migration/') || file.startsWith(testRoot)));
  }
  if (phaseId === 'backend' && ['backend-module-compile', 'backend-module-test'].includes(profile)) {
    const modules = selectors.modules;
    if (keys.length !== 1 || keys[0] !== 'modules' || !Array.isArray(modules)
      || modules.length < 1 || modules.length > 16 || new Set(modules).size !== modules.length
      || modules.some(module => typeof module !== 'string' || !BACKEND_MODULE_PATTERN.test(module)
        || module.split('/').some(part => part === '' || part === '.' || part === '..'))
      || phaseChangedPaths.length === 0
      || phaseChangedPaths.some(file => /[\\\u0000-\u001f\u007f]/u.test(file)
        || file.split('/').some(part => part === '' || part === '.' || part === '..'))) return false;
    return phaseChangedPaths.every(file => modules.some(module => file.startsWith(`${module}/`)))
      && modules.every(module => phaseChangedPaths.some(file => file.startsWith(`${module}/`)));
  }
  if (phaseId === 'access-wiring' && profile === 'backend-module-test') {
    const modules = selectors.modules;
    if (keys.length !== 1 || keys[0] !== 'modules' || !Array.isArray(modules)
      || modules.length < 1 || modules.length > 16 || new Set(modules).size !== modules.length
      || modules.some(module => typeof module !== 'string' || !BACKEND_MODULE_PATTERN.test(module)
        || module.split('/').some(part => part === '' || part === '.' || part === '..'))
      || phaseChangedPaths.length === 0
      || phaseChangedPaths.some(file => /[\\\u0000-\u001f\u007f]/u.test(file)
        || file.split('/').some(part => part === '' || part === '.' || part === '..'))) return false;
    // Access owns migrations and their module tests, not module production code.
    return phaseChangedPaths.every(file => file.startsWith('forge-server/db/migration/')
      || modules.some(module => file.startsWith(`${module}/src/test/java/`)))
      && modules.every(module => phaseChangedPaths.some(file => file.startsWith(`${module}/src/test/java/`)));
  }
  if (profile !== 'frontend-admin-lint' || keys.length !== 1 || keys[0] !== 'files'
    || !Array.isArray(selectors.files)
    || selectors.files.some((file) => typeof file !== 'string' || !FRONTEND_SOURCE_FILE_PATTERN.test(file))) return false;
  const expected = phaseChangedPaths.filter((file) => FRONTEND_SOURCE_FILE_PATTERN.test(file));
  const selected = new Set(selectors.files);
  return expected.length > 0 && expected.every((file) => selected.has(file));
}

export async function collectForgePhaseHostReceipts({
  projectSlug, taskId, sourceFingerprint, sourceCommit, patchDigest, profiles, proposal,
  phaseChangedPaths = [], phaseId, receiptReader = readForgePhaseHostReceipt,
}) {
  checkIdentity(projectSlug, taskId);
  if (typeof sourceFingerprint !== 'string' || !SHA256.test(sourceFingerprint)
    || typeof sourceCommit !== 'string' || !COMMIT.test(sourceCommit)
    || typeof patchDigest !== 'string' || !SHA256.test(patchDigest)
    || !Array.isArray(profiles) || profiles.length < 1 || profiles.length > 32
    || profiles.some((profile) => typeof profile !== 'string' || !PROFILE.test(profile))
    || !Array.isArray(phaseChangedPaths) || phaseChangedPaths.some((file) => typeof file !== 'string')
    || new Set(profiles).size !== profiles.length || typeof receiptReader !== 'function') {
    throw failure('PHASE_HOST_RECEIPT_INPUT_INVALID');
  }
  const { hints, untyped } = receiptHints(proposal, profiles, phaseId === 'access-wiring');
  const loaded = new Map();
  const receipts = [];
  const nativeReceipts = [];
  const missingProfiles = [];
  const failures = [];
  for (const receiptId of untyped) {
    try {
      const receipt = withoutDiagnostics(await receiptReader({ projectSlug, taskId, receiptId }));
      loaded.set(receiptId, { receipt });
      // Only the protected reader supplies the profile. All current/source/task/
      // status/selector validation below remains mandatory before acceptance.
      if (hints.has(receipt?.request?.profile)) hints.get(receipt.request.profile).push(receiptId);
      else failures.push({ receiptId, code: 'PHASE_HOST_RECEIPT_INVALID' });
    } catch (error) {
      failures.push({ receiptId, code: READER_CODES.has(error?.code) ? error.code : 'PHASE_HOST_RECEIPT_UNAVAILABLE' });
    }
  }
  for (const profile of profiles) {
    let accepted = false;
    for (const receiptId of hints.get(profile)) {
      if (!loaded.has(receiptId)) {
        try {
          loaded.set(receiptId, { receipt: withoutDiagnostics(await receiptReader({ projectSlug, taskId, receiptId })) });
        } catch (error) {
          loaded.set(receiptId, { code: READER_CODES.has(error?.code) ? error.code : 'PHASE_HOST_RECEIPT_UNAVAILABLE' });
        }
      }
      const item = loaded.get(receiptId);
      let code = item.code;
      if (!code) {
        try {
          validateHostRunReceipt(item.receipt, {
            projectSlug, taskId, profile, receiptId, sourceFingerprint, requireCurrent: true,
          });
          if (item.receipt.source.head !== sourceCommit) code = 'PHASE_HOST_RECEIPT_SOURCE_MISMATCH';
          else if (item.receipt.status !== 'passed') code = 'PHASE_HOST_RECEIPT_NOT_PASSED';
          else if (!selectorsCoverPhase(profile, item.receipt.request.selectors, phaseChangedPaths, phaseId)) {
            code = 'PHASE_HOST_RECEIPT_SELECTORS_NARROWED';
          }
        } catch {
          code = item.receipt?.freshness === 'stale' ? 'PHASE_HOST_RECEIPT_STALE' : 'PHASE_HOST_RECEIPT_INVALID';
        }
      }
      if (code) {
        failures.push({ profile, receiptId, code });
        continue;
      }
      // These are the same canonical JSON bytes the caller may preserve; model
      // status and diagnostic excerpts never contribute to accepted evidence.
      const bytes = Buffer.from(`${JSON.stringify(item.receipt, null, 2)}\n`, 'utf8');
      receipts.push({ profile, status: item.receipt.status,
        receiptDigest: crypto.createHash('sha256').update(bytes).digest('hex'), patchDigest });
      nativeReceipts.push(item.receipt);
      accepted = true;
      break;
    }
    if (!accepted) missingProfiles.push(profile);
  }
  return { status: missingProfiles.length === 0 ? 'verified' : 'required',
    receipts, nativeReceipts, missingProfiles, failures };
}
