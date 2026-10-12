import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliveryCenterMetadata } from './delivery-center-semantics.mjs';

const FENCE = '```json delivery-center';
const SCOPE = ':(glob)code-copilot/changes/**/*.md';
const HASH = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const LIMITS = { commits: 64, files: 256, blobBytes: 2 * 1024 * 1024, totalBytes: 24 * 1024 * 1024,
  outputBytes: 4 * 1024 * 1024, commandMs: 10000, collectionMs: 45000, versions: 4096 };
const cache = new Map();
const failure = code => Object.assign(new Error(code), { code });
const docPath = value => typeof value === 'string' && value.startsWith('code-copilot/changes/')
  && value.endsWith('.md') && !/[\u0000-\u001f\\]/u.test(value) && !value.split('/').includes('..');
const versionKey = row => `${row.commit}\0${row.path}\0${row.blob}`;

export function deliveryDocumentDiagnostic(value) {
  const result = {};
  if (['invalid-json', 'invalid-metadata', 'unterminated-fence'].includes(value?.reason)) result.reason = value.reason;
  if (docPath(value?.path) && value.path.length <= 512 && value.path.split('/').every(part => part && part !== '.')) result.path = value.path;
  if (Number.isSafeInteger(value?.fenceLine) && value.fenceLine > 0 && value.line === value.fenceLine + 1) {
    result.fenceLine = value.fenceLine; result.line = value.line;
  }
  if (result.reason === 'invalid-metadata' && Number.isSafeInteger(value?.recordIndex) && value.recordIndex >= 0) result.recordIndex = value.recordIndex;
  return result;
}

function git(root, args, { input, deadline, allowedCodes = [0], maxBytes = LIMITS.outputBytes } = {}) {
  return new Promise((resolve, reject) => {
    const remaining = Math.min(LIMITS.commandMs, (deadline ?? Infinity) - Date.now());
    if (remaining <= 0) { reject(failure('COMMITTED_DOCUMENT_UNREADABLE')); return; }
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
    const child = spawn('git', ['-c', `safe.directory=${root}`, '-c', 'core.fsmonitor=false', '-C', root, ...args],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0; let error = null;
    const stop = code => { error ??= failure(code); child.kill(); };
    const timer = setTimeout(() => stop('COMMITTED_DOCUMENT_UNREADABLE'), remaining);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) stop('COMMITTED_DOCUMENT_PROJECTION_LIMIT');
      else chunks.push(chunk);
    });
    child.stderr.on('data', () => {}); // Never publish local paths or repository diagnostics.
    child.on('error', () => { error ??= failure('COMMITTED_DOCUMENT_UNREADABLE'); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (error || !allowedCodes.includes(code)) reject(error ?? failure('COMMITTED_DOCUMENT_UNREADABLE'));
      else resolve({ code, bytes: Buffer.concat(chunks) });
    });
    child.stdin.end(input);
  });
}

function parseLog(bytes) {
  const tokens = bytes.toString('utf8').split('\0'); const rows = []; let commit = null; let committedAt = null; const commits = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].trim();
    const header = /^DC_COMMIT ([a-f0-9]{40,64}) (\S+)$/u.exec(token);
    if (header) { [, commit, committedAt] = header; commits.add(commit); continue; }
    const raw = /^:\d+ \d+ ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) ([AMDT])$/u.exec(token);
    if (!raw) continue;
    const name = tokens[++index];
    if (commit && docPath(name)) rows.push({ commit, committedAt, path: name, blob: raw[2], previousBlob: raw[1], deleted: raw[3] === 'D' });
  }
  return { rows, commits: [...commits] };
}

async function readLog(root, revision, deadline, { markerOnly = false, paths = [SCOPE], count = LIMITS.commits + 1 } = {}) {
  const args = ['log', '-m', '--first-parent', '--no-ext-diff', '--no-textconv', '--format=DC_COMMIT %H %cI%x00',
    '--raw', '-z', '--no-abbrev', '--no-renames', '--diff-filter=AMDT', `--max-count=${count}`];
  if (markerOnly) args.push('-G', '^```json delivery-center[[:space:]]*$');
  if (Array.isArray(revision)) args.push('--no-walk=unsorted');
  return parseLog((await git(root, [...args, ...(Array.isArray(revision) ? revision : [revision]), '--', ...paths], { deadline })).bytes);
}

export function parseDeliveryDocumentDefinitions(content, source) {
  const lines = content.split(/\r?\n/u); const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trimEnd() !== FENCE) continue;
    const start = index + 1; const body = [];
    const invalid = (reason, recordIndex) => Object.assign(failure('COMMITTED_DOCUMENT_INVALID_JSON'),
      deliveryDocumentDiagnostic({ path: source?.path, fenceLine: start, line: start + 1, reason, recordIndex }));
    while (++index < lines.length && !/^```\s*$/u.test(lines[index])) body.push(lines[index]);
    if (index >= lines.length) throw invalid('unterminated-fence');
    let parsed;
    try { parsed = JSON.parse(body.join('\n')); } catch { throw invalid('invalid-json'); }
    const records = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object'
      ? Array.isArray(parsed.records) ? parsed.records : [parsed] : null;
    if (!records) throw invalid('invalid-metadata');
    const invalidRecord = records.findIndex(row => !row || typeof row !== 'object' || Array.isArray(row) || !deliveryCenterMetadata(row));
    if (invalidRecord >= 0) throw invalid('invalid-metadata', invalidRecord);
    result.push({ ...source, line: start + 1, fenceLine: start, records });
  }
  return result;
}

const parseDefinitions = parseDeliveryDocumentDefinitions;

async function currentBlobs(root, head, names, deadline) {
  const result = new Map();
  for (let offset = 0; offset < names.length; offset += 64) {
    const { bytes } = await git(root, ['ls-tree', '-r', '-z', head, '--', ...names.slice(offset, offset + 64)], { deadline });
    for (const entry of bytes.toString('utf8').split('\0')) {
      const match = /^(\d+) blob ([a-f0-9]{40,64})\t([\s\S]+)$/u.exec(entry);
      if (match && /^100/u.test(match[1]) && docPath(match[3])) result.set(match[3], match[2]);
    }
  }
  return result;
}

async function markedPaths(root, head, paths, deadline) {
  const result = new Set();
  for (let offset = 0; offset < paths.length; offset += 64) {
    const { bytes } = await git(root, ['grep', '-l', '-z', '-F', FENCE, head, '--', ...paths.slice(offset, offset + 64)], { deadline, allowedCodes: [0, 1] });
    for (const entry of bytes.toString('utf8').split('\0')) {
      const name = entry.slice(entry.indexOf(':') + 1);
      if (entry.startsWith(`${head}:`) && docPath(name)) result.add(name);
    }
  }
  return result;
}

/** Read only committed, explicitly marked definitions in the integration repo. */
export async function collectCommittedDeliveryDocuments({ projectSlug, repositoryRoot }) {
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)) throw failure('COMMITTED_DOCUMENT_PATH_UNSAFE');
  const info = await lstat(repositoryRoot).catch(() => { throw failure('COMMITTED_DOCUMENT_UNREADABLE'); });
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('COMMITTED_DOCUMENT_PATH_UNSAFE');
  const root = await realpath(repositoryRoot); const key = `${projectSlug}\0${root}`; const deadline = Date.now() + LIMITS.collectionMs;
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], { deadline })).bytes.toString('utf8').trim();
  if (!HASH.test(head)) throw failure('COMMITTED_DOCUMENT_UNREADABLE');
  const prior = cache.get(key);
  if (prior?.head === head) return structuredClone(prior.result);
  const ancestor = prior ? await git(root, ['merge-base', '--is-ancestor', prior.head, head], { deadline, allowedCodes: [0, 1] }) : null;
  const incremental = ancestor?.code === 0;
  const revision = incremental ? `${prior.head}..${head}` : head;
  const changes = await readLog(root, revision, deadline);
  // Search markers only within the already bounded commit window. A repository
  // with years of ordinary Markdown must not cause an unbounded pickaxe walk.
  const markerChanges = changes.commits.length ? await readLog(root, changes.commits.slice(0, LIMITS.commits), deadline, { markerOnly: true }) : { rows: [] };
  const changedNames = [...new Set(changes.rows.map(row => row.path))];
  const marked = await markedPaths(root, head, incremental && changes.commits.length <= LIMITS.commits ? changedNames : [SCOPE], deadline);
  const previousVersions = new Map(prior?.versions ?? []);
  const knownNames = new Set([...previousVersions.values()].map(value => value.path));
  const candidateNames = [...new Set([...marked].sort().concat([...knownNames].sort(), markerChanges.rows.map(row => row.path).sort()))];
  const names = candidateNames.slice(0, LIMITS.files); const admitted = new Set(names);
  const current = await currentBlobs(root, head, names, deadline);
  const admittedCommits = new Set(changes.commits.slice(0, LIMITS.commits));
  const rows = changes.rows.filter(row => admitted.has(row.path) && admittedCommits.has(row.commit) && !row.deleted);
  // Current definitions take priority over older history beyond the bounded window.
  for (const [name, blob] of current) {
    if (rows.some(row => row.path === name && row.blob === blob) || [...previousVersions.values()].some(row => row.path === name && row.blob === blob)) continue;
    const last = await readLog(root, head, deadline, { paths: [name], count: 1 });
    const found = last.rows.find(row => row.path === name && row.blob === blob && !row.deleted);
    if (!found) throw failure('COMMITTED_DOCUMENT_UNREADABLE');
    rows.unshift(found);
  }
  const fresh = [...new Map(rows.map(row => [versionKey(row), row])).values()].filter(row => !previousVersions.has(versionKey(row)));
  const blobs = [...new Set(fresh.map(row => row.blob))]; let historicalSkipped = 0;
  if (blobs.length) {
    const checked = await git(root, ['cat-file', '--batch-check'], { input: `${blobs.join('\n')}\n`, deadline });
    const sizes = new Map(checked.bytes.toString('utf8').trim().split('\n').map(line => {
      const parts = line.trim().split(' ');
      if (parts[1] !== 'blob' || !HASH.test(parts[0]) || !/^\d+$/u.test(parts[2] ?? '')) throw failure('COMMITTED_DOCUMENT_UNREADABLE');
      return [parts[0], Number(parts[2])];
    }));
    const currentHashes = new Set(current.values()); let bytes = 0; const selected = [];
    for (const blob of [...blobs].sort((a, b) => Number(currentHashes.has(b)) - Number(currentHashes.has(a)))) {
      const size = sizes.get(blob);
      if (size === undefined) throw failure('COMMITTED_DOCUMENT_UNREADABLE');
      if (size > LIMITS.blobBytes || bytes + size > LIMITS.totalBytes) {
        if (currentHashes.has(blob)) throw failure('COMMITTED_DOCUMENT_PROJECTION_LIMIT');
        historicalSkipped += fresh.filter(row => row.blob === blob).length; continue;
      }
      bytes += size; selected.push(blob);
    }
    if (selected.length) {
      const loaded = (await git(root, ['cat-file', '--batch'], { input: `${selected.join('\n')}\n`, deadline,
        maxBytes: LIMITS.totalBytes + selected.length * 128 })).bytes;
      const contents = new Map(); let offset = 0;
      for (const expected of selected) {
        const end = loaded.indexOf(10, offset);
        if (end < 0) throw failure('COMMITTED_DOCUMENT_UNREADABLE');
        const [blob, type, length] = loaded.subarray(offset, end).toString('ascii').split(' ');
        const size = Number(length);
        if (blob !== expected || type !== 'blob' || size !== sizes.get(blob) || end + size + 1 >= loaded.length) throw failure('COMMITTED_DOCUMENT_UNREADABLE');
        const content = loaded.subarray(end + 1, end + 1 + size);
        contents.set(blob, { text: content.toString('utf8'), contentDigest: createHash('sha256').update(content).digest('hex') });
        offset = end + size + 2;
      }
      for (const row of fresh) {
        const content = contents.get(row.blob); if (!content) continue;
        try {
          const definitions = parseDefinitions(content.text, { ...row, contentDigest: content.contentDigest });
          previousVersions.set(versionKey(row), { ...row, definitions });
        } catch (error) {
          if (error.code !== 'COMMITTED_DOCUMENT_INVALID_JSON' || current.get(row.path) === row.blob) throw error;
          // Once a bad current document is corrected, retain that old failure as
          // a coverage fact rather than permanently blocking the repaired HEAD.
          previousVersions.set(versionKey(row), { ...row, definitions: [], invalidDefinition: true, diagnostic: deliveryDocumentDiagnostic(error) });
        }
      }
    }
  }
  if (previousVersions.size > LIMITS.versions) throw failure('COMMITTED_DOCUMENT_PROJECTION_LIMIT');
  const observedHead = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], { deadline })).bytes.toString('utf8').trim();
  if (head !== observedHead) throw failure('COMMITTED_DOCUMENT_SOURCE_CHANGED');
  const documents = [...previousVersions.values()].flatMap(row => row.definitions.map(definition => ({ ...definition, isCurrent: current.get(row.path) === row.blob })));
  const invalidHistory = [...previousVersions.values()].filter(row => row.invalidDefinition)
    .map(row => ({ commit: row.commit, blob: row.blob, path: row.path, code: 'COMMITTED_DOCUMENT_INVALID_JSON', ...deliveryDocumentDiagnostic(row.diagnostic) }));
  const result = { documents, coverage: { source: 'committed-integration-documents', head, pathScope: 'code-copilot/changes/**/*.md',
    scope: 'committed-in-integration-repository-only', includesUncommittedConversations: false,
    historyMode: incremental ? 'incremental' : 'bounded-history', scannedCommits: Math.min(changes.commits.length, LIMITS.commits),
    historyLimit: LIMITS.commits, historicalRangeComplete: changes.commits.length <= LIMITS.commits
      && (!incremental || prior.result.coverage.historicalRangeComplete) && candidateNames.length <= LIMITS.files
      && !historicalSkipped && !invalidHistory.length,
    excludedMarkedFiles: Math.max(0, candidateNames.length - LIMITS.files), skippedHistoricalVersions: historicalSkipped,
    invalidHistoricalDefinitions: invalidHistory, definitionBlocks: documents.length } };
  cache.set(key, { head, versions: [...previousVersions], result });
  return structuredClone(result);
}
