import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, unlinkSync,
} from 'node:fs';
import { posix } from 'node:path';

const name = 'forge-typed-file-removal';
const inject = Object.freeze(['tools', 'fs', 'sandboxPolicy']);
const PROTECTED_FILE = /^(?:AGENTS\.md|PROJECT_CONTEXT\.md|project\.manifest\.json|pom\.xml|package\.json|.*lock(?:\.json|\.yaml)?|pnpm-workspace\.yaml|(?:js|ts)config(?:\.[^.]+)?\.json|(?:eslint|vite|vitest)\.config\.[^.]+|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/iu;
const MAX_BYTES = 8 * 1024 * 1024;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function removalPath(args, workspaceRoot = '/workspace') {
  if (!args || Object.keys(args).length !== 1 || typeof args.file_path !== 'string') {
    fail('FORGE_REMOVE_ARGUMENTS', 'remove_file requires exactly one file_path.');
  }
  let relative = args.file_path;
  if (relative.startsWith(`${workspaceRoot}/`)) relative = relative.slice(workspaceRoot.length + 1);
  else if (relative.startsWith('./')) relative = relative.slice(2);
  if (!relative || relative.length > 1024 || relative !== relative.normalize('NFC')
    || relative !== relative.trim() || /[\\:\u0000-\u001f\u007f]/u.test(relative)
    || relative.split('/').some((part) => !part || part.startsWith('.'))) {
    fail('FORGE_REMOVE_PATH', 'Use one ordinary repository-relative file path inside this workspace.');
  }
  if (PROTECTED_FILE.test(posix.basename(relative)) || /\.(?:pem|key|p12|pfx)$/iu.test(relative)) {
    fail('FORGE_REMOVE_PROTECTED', 'This tool cannot remove dependency, platform, or credential configuration.');
  }
  return { relative, absolute: `${workspaceRoot}/${relative}` };
}

function sameVersion(a, b) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every((key) => a[key] === b[key]);
}

// Linux directory handles keep every lookup under its original, non-symlink parent.
// The phase guard owns the write reservation; the native observation policy owns freshness.
async function removeObservedFile(ctx, args, exec, { workspaceRoot = '/workspace' } = {}) {
  if (typeof ctx.fs.removeObservedFile === 'function') return ctx.fs.removeObservedFile(ctx, args, exec, { workspaceRoot });
  const { relative, absolute } = removalPath(args, workspaceRoot);
  const policy = await ctx.sandboxPolicy.resolve(exec?.agent ? { session: exec.agent.session } : {});
  if (!policy || !['workspace-write', 'danger-full-access'].includes(policy.mode)
    || policy.workspaceRoot !== workspaceRoot) {
    fail('FS_SANDBOX_DENIED', 'remove_file requires the current writable workspace sandbox.');
  }
  if (process.platform !== 'linux') fail('FORGE_REMOVE_PLATFORM', 'remove_file requires the Linux Harness runtime.');
  exec?.signal?.throwIfAborted();
  const target = await ctx.fs.resolve(absolute, { cwd: workspaceRoot, signal: exec?.signal });
  if (ctx.fs.processPath(target) !== absolute) fail('FORGE_REMOVE_PATH', 'File aliases are not removable.');
  const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined);
  if (typeof intent?.version !== 'string') fail('FS_NOT_OBSERVED', 'Read this file before removing it.');
  const handles = [];
  const directories = [];
  try {
    if (realpathSync(workspaceRoot) !== workspaceRoot) fail('FORGE_REMOVE_PATH', 'Workspace aliases are not removable.');
    let directory = workspaceRoot;
    for (const part of ['', ...relative.split('/').slice(0, -1)]) {
      const pathname = part ? `/proc/self/fd/${handles.at(-1)}/${part}` : directory;
      const fd = openSync(pathname, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(fd);
      if (part) directory += `/${part}`;
      directories.push({ pathname: directory, version: fstatSync(fd, { bigint: true }) });
    }
    const anchored = `/proc/self/fd/${handles.at(-1)}/${posix.basename(relative)}`;
    const fd = openSync(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(fd);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) fail('FORGE_REMOVE_NOT_REGULAR', 'Only one ordinary, non-linked file can be removed.');
    if (before.size > BigInt(MAX_BYTES)) fail('FS_TOO_LARGE', 'File exceeds the bounded removal size.');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail('FS_STALE_VERSION', 'File was truncated before removal.');
      offset += count;
    }
    const observed = await ctx.fs.stat(target, exec?.signal);
    if (observed?.version !== intent.version) fail('FS_STALE_VERSION', 'File changed since it was read; read it again before removal.');
    exec?.signal?.throwIfAborted();
    for (const parent of directories) {
      const current = lstatSync(parent.pathname, { bigint: true });
      if (!current.isDirectory() || current.dev !== parent.version.dev || current.ino !== parent.version.ino) {
        fail('FS_STALE_VERSION', 'A parent directory changed before removal.');
      }
    }
    if (!sameVersion(before, fstatSync(fd, { bigint: true }))
      || !sameVersion(before, lstatSync(anchored, { bigint: true }))) {
      fail('FS_STALE_VERSION', 'File identity or contents changed before removal.');
    }
    unlinkSync(anchored);
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
    return { path: relative, deleted: true, previousSha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    for (const fd of handles.reverse()) closeSync(fd);
  }
}

function registerRemovalTool(ctx, defineTool) {
  ctx.tools.register(defineTool({
    name: 'remove_file',
    description: 'Remove one task-owned ordinary source file after reading it with read. Uses the observed file version; no directories, recursive deletion, configuration, or shell. Existing task write permission and verification admission are required.',
    parameters: { file_path: { type: 'string', required: true, description: 'Exact repository-relative path of the file just read.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true },
        previousSha256: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => removeObservedFile(ctx, args, exec),
  }));
}

function referenceCopyPaths(args, workspaceRoot = '/workspace', inputRoot = '/project-inputs') {
  if (!args || Object.keys(args).sort().join(',') !== 'file_path,source_path,source_sha256'
    || typeof args.source_path !== 'string' || !/^[0-9a-f]{64}$/u.test(args.source_sha256 ?? '')) {
    fail('FORGE_COPY_ARGUMENTS', 'copy_file requires source_path, file_path and the exact source_sha256.');
  }
  const sourceRelative = args.source_path.startsWith(`${inputRoot}/`)
    ? args.source_path.slice(inputRoot.length + 1) : '';
  if (!sourceRelative || sourceRelative.length > 1024 || sourceRelative !== sourceRelative.normalize('NFC')
    || sourceRelative !== sourceRelative.trim() || /[\\:\u0000-\u001f\u007f]/u.test(sourceRelative)
    || sourceRelative.split('/').some((part) => !part || part.startsWith('.'))
    || /\.(?:pem|key|p12|pfx)$/iu.test(sourceRelative)) {
    fail('FORGE_COPY_SOURCE_PATH', 'The source must be an ordinary file under the private read-only /project-inputs mount.');
  }
  let destination;
  try { destination = removalPath({ file_path: args.file_path }, workspaceRoot); }
  catch { fail('FORGE_COPY_DESTINATION_PATH', 'The destination must be one task-owned ordinary source file, not configuration or a secret.'); }
  return { ...destination, sourceRelative, sourceAbsolute: `${inputRoot}/${sourceRelative}` };
}

async function copyReferenceFile(ctx, args, exec, { workspaceRoot = '/workspace', inputRoot = '/project-inputs' } = {}) {
  if (typeof ctx.fs.copyReferenceFile === 'function') return ctx.fs.copyReferenceFile(ctx, args, exec, { workspaceRoot, inputRoot });
  const paths = referenceCopyPaths(args, workspaceRoot, inputRoot);
  const policy = await ctx.sandboxPolicy.resolve(exec?.agent ? { session: exec.agent.session } : {});
  if (!policy || !['workspace-write', 'danger-full-access'].includes(policy.mode) || policy.workspaceRoot !== workspaceRoot) {
    fail('FS_SANDBOX_DENIED', 'copy_file requires the current writable workspace sandbox.');
  }
  if (process.platform !== 'linux') fail('FORGE_COPY_PLATFORM', 'copy_file requires the Linux Harness runtime.');
  exec?.signal?.throwIfAborted();
  const source = await ctx.fs.resolve(paths.sourceAbsolute, { cwd: workspaceRoot, signal: exec?.signal });
  const target = await ctx.fs.resolve(paths.absolute, { cwd: workspaceRoot, signal: exec?.signal });
  if (ctx.fs.processPath(source) !== paths.sourceAbsolute || ctx.fs.processPath(target) !== paths.absolute) {
    fail('FORGE_COPY_PATH_ALIAS', 'Source and destination aliases are not supported.');
  }
  const observation = await ctx.waterfall('fs/edit-intent', source, exec, () => undefined);
  if (typeof observation?.version !== 'string') fail('FS_NOT_OBSERVED', 'Read the complete reference file before copying it.');
  const handles = [];
  const parents = [];
  try {
    if (realpathSync(inputRoot) !== inputRoot) fail('FORGE_COPY_PATH_ALIAS', 'The private input root cannot be an alias.');
    let directory = inputRoot;
    for (const part of ['', ...paths.sourceRelative.split('/').slice(0, -1)]) {
      const anchored = part ? `/proc/self/fd/${handles.at(-1)}/${part}` : directory;
      const fd = openSync(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(fd);
      if (part) directory += `/${part}`;
      parents.push({ pathname: directory, version: fstatSync(fd, { bigint: true }) });
    }
    const anchored = `/proc/self/fd/${handles.at(-1)}/${posix.basename(paths.sourceRelative)}`;
    const fd = openSync(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(fd);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) fail('FORGE_COPY_NOT_REGULAR', 'Only one ordinary, non-linked reference file can be copied.');
    if (before.size > BigInt(MAX_BYTES)) fail('FS_TOO_LARGE', 'Reference file exceeds the bounded copy size.');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail('FS_STALE_VERSION', 'Reference file changed while being read.');
      offset += count;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== args.source_sha256) fail('FORGE_COPY_SOURCE_DIGEST', 'Reference bytes differ from the requested SHA256; nothing was written.');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail('FORGE_COPY_TEXT_REQUIRED', 'Only complete valid UTF-8 reference text can be copied.'); }
    if (content.includes('\0') || !Buffer.from(content, 'utf8').equals(bytes)) {
      fail('FORGE_COPY_TEXT_REQUIRED', 'Reference text must round-trip exactly without binary or replacement bytes.');
    }
    const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined);
    const current = await ctx.fs.stat(source, exec?.signal);
    if (current?.version !== observation.version) fail('FS_STALE_VERSION', 'Reference changed since it was read.');
    for (const parent of parents) {
      const now = lstatSync(parent.pathname, { bigint: true });
      if (!now.isDirectory() || now.dev !== parent.version.dev || now.ino !== parent.version.ino) {
        fail('FS_STALE_VERSION', 'A reference parent changed before copying.');
      }
    }
    if (!sameVersion(before, fstatSync(fd, { bigint: true })) || !sameVersion(before, lstatSync(anchored, { bigint: true }))) {
      fail('FS_STALE_VERSION', 'Reference identity or bytes changed before copying.');
    }
    exec?.signal?.throwIfAborted();
    // Use the same observed-version, sandboxed atomic writer as the native write tool.
    // The phase guard still reserves and authorizes the destination file_path.
    const outcome = await ctx.fs.writeText(target, content, intent, exec?.signal, policy);
    ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec);
    return { path: paths.relative, sourcePath: paths.sourceAbsolute, sourceSha256: sha256,
      bytes: bytes.length, operation: outcome.operation, copied: true };
  } finally {
    for (const fd of handles.reverse()) closeSync(fd);
  }
}

function registerReferenceCopyTool(ctx, defineTool) {
  ctx.tools.register(defineTool({
    name: 'copy_file',
    description: 'Copy one complete UTF-8 file from private read-only /project-inputs to an authorized task-owned source path, preserving every byte. Read the source and any existing destination first. Requires the exact source SHA256 and existing scoped write authority; no shell, directories, configuration, or links. Use edit afterward for actual source changes.',
    parameters: {
      source_path: { type: 'string', required: true, description: 'Exact absolute private /project-inputs path already read.' },
      file_path: { type: 'string', required: true, description: 'Exact task-owned repository-relative destination.' },
      source_sha256: { type: 'string', required: true, description: 'Expected SHA256 of the original bytes, 64 lowercase hex characters.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true }, sourcePath: { type: 'string', required: true },
      sourceSha256: { type: 'string', required: true }, bytes: { type: 'integer', required: true },
      operation: { type: 'string', required: true }, copied: { type: 'boolean', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, exec) => copyReferenceFile(ctx, args, exec),
  }));
}

async function apply(ctx) {
  const { defineTool } = await import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
  registerRemovalTool(ctx, defineTool);
  registerReferenceCopyTool(ctx, defineTool);
}

export { apply, inject, name, registerRemovalTool, removalPath, removeObservedFile,
  referenceCopyPaths, copyReferenceFile, registerReferenceCopyTool };
