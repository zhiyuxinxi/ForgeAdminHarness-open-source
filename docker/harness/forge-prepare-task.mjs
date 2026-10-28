import http from 'node:http';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const PREPARE_TASK_TOOL_NAME = 'prepare_task';
const PREPARE_TASK_ACTION = 'prepare-task';
const OPERATIONS = new Set(['inspect', 'propose']);
const STATUSES = new Set(['inspected', 'prepared', 'needs-confirmation']);
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
// Configured writer scopes use the compiler's 256-path bound, not a proposal's 64.
const MAX_AVAILABLE_SCOPE_PATHS = 256;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    fail('PREPARE_TASK_SCHEMA_INVALID', `${label} contains unsupported fields.`);
  }
}

function boundedString(value, label, maximum = 2000) {
  if (typeof value !== 'string' || value.trim().length === 0
    || Buffer.byteLength(value, 'utf8') > maximum || /\0/u.test(value)) {
    fail('PREPARE_TASK_SCHEMA_INVALID', `${label} is invalid.`);
  }
  return value;
}

function boundedStrings(value, label, maximum = 64) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    fail('PREPARE_TASK_SCHEMA_INVALID', `${label} must contain between 1 and ${maximum} strings.`);
  }
  if (value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    fail('PREPARE_TASK_SCHEMA_INVALID', `${label} must contain non-empty strings.`);
  }
  if (new Set(value).size !== value.length) {
    fail('PREPARE_TASK_SCHEMA_INVALID', `${label} must contain unique strings.`);
  }
  return [...value];
}

export function validatePrepareTaskArguments(args) {
  exactKeys(args, ['operation', ...(args?.operation === 'propose' ? ['proposal'] : [])], 'prepare_task arguments');
  if (!OPERATIONS.has(args.operation)) {
    fail('PREPARE_TASK_SCHEMA_INVALID', 'prepare_task.operation must be inspect or propose.');
  }
  if (args.operation === 'inspect') return Object.freeze({ operation: 'inspect' });
  exactKeys(args.proposal, ['goal', 'ownedPaths', 'taskProfiles', 'references', 'reviewContractSource'], 'prepare_task proposal');
  const references = args.proposal.references;
  if (!Array.isArray(references) || references.length < 1 || references.length > 64
    || references.some((reference) => typeof reference !== 'string')) {
    fail('PREPARE_TASK_SCHEMA_INVALID', 'prepare_task proposal requires between 1 and 64 read references.');
  }
  const normalizedReferences = references.map((reference) => boundedString(reference, 'prepare_task reference', 4096));
  if (new Set(normalizedReferences).size !== normalizedReferences.length) {
    fail('PREPARE_TASK_SCHEMA_INVALID', 'prepare_task reference paths must be unique.');
  }
  if (Object.hasOwn(args.proposal, 'reviewContractSource')
    && !normalizedReferences.includes(args.proposal.reviewContractSource)) {
    fail('PREPARE_TASK_SCHEMA_INVALID', 'The dual review contract must be one of the read reference files.');
  }
  return Object.freeze({
    operation: 'propose',
    proposal: Object.freeze({
      goal: boundedString(args.proposal.goal, 'prepare_task proposal.goal', 4000),
      ownedPaths: Object.freeze(boundedStrings(args.proposal.ownedPaths, 'prepare_task proposal.ownedPaths')),
      taskProfiles: Object.freeze(boundedStrings(args.proposal.taskProfiles, 'prepare_task proposal.taskProfiles', 16)),
      references: Object.freeze(normalizedReferences),
      ...(Object.hasOwn(args.proposal, 'reviewContractSource') ? { reviewContractSource: args.proposal.reviewContractSource } : {}),
    }),
  });
}

function normalizeReferencePath(value) {
  const relative = boundedString(value, 'prepare_task reference', 4096);
  if (relative !== relative.normalize('NFC') || relative !== relative.trim()
    || path.posix.isAbsolute(relative) || /[\\:\u0000-\u001f\u007f]/u.test(relative)
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('PREPARE_TASK_REFERENCE_INVALID', 'prepare_task references must be ordinary repository-relative paths.');
  }
  return relative;
}

function sameFileVersion(before, after) {
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink']
    .every((key) => before[key] === after[key]);
}

async function hashWorkspaceReference(relative, workspaceRoot) {
  const normalized = normalizeReferencePath(relative);
  const root = await realpath(workspaceRoot);
  const parts = normalized.split('/');
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index]);
    const information = await lstat(current);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      fail('PREPARE_TASK_REFERENCE_INVALID', 'prepare_task reference parents must be ordinary directories.');
    }
  }
  const target = path.join(root, ...parts);
  const resolved = await realpath(target);
  if (resolved !== target || !(resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    fail('PREPARE_TASK_REFERENCE_INVALID', 'prepare_task reference escapes the workspace or uses a filesystem alias.');
  }
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_REFERENCE_BYTES) {
    fail('PREPARE_TASK_REFERENCE_INVALID', 'prepare_task references must be ordinary files no larger than 8 MiB.');
  }
  const handle = await open(target, 'r');
  try {
    const opened = await handle.stat();
    if (!sameFileVersion(before, opened)) fail('PREPARE_TASK_REFERENCE_STALE', 'prepare_task reference changed before it was read.');
    const bytes = await handle.readFile();
    const after = await lstat(target);
    if (bytes.length !== before.size || !sameFileVersion(before, after)
      || !sameFileVersion(opened, await handle.stat())) {
      fail('PREPARE_TASK_REFERENCE_STALE', 'prepare_task reference changed while it was read.');
    }
    return Object.freeze({ path: normalized, sha256: createHash('sha256').update(bytes).digest('hex') });
  } finally {
    await handle.close();
  }
}

export async function materializePrepareTaskArguments(args, { workspaceRoot = '/workspace' } = {}) {
  const validated = validatePrepareTaskArguments(args);
  if (validated.operation === 'inspect') return validated;
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
    fail('PREPARE_TASK_REFERENCE_INVALID', 'prepare_task workspace root is invalid.');
  }
  const references = [];
  for (const reference of validated.proposal.references) {
    references.push(await hashWorkspaceReference(reference, workspaceRoot));
  }
  return Object.freeze({
    operation: 'propose',
    proposal: Object.freeze({ ...validated.proposal, references: Object.freeze(references) }),
  });
}

function validateTaskSummary(value, label) {
  if (value === null) return null;
  exactKeys(value, ['goal', 'ownedPaths', 'taskProfiles'], label);
  return Object.freeze({
    goal: boundedString(value.goal, `${label}.goal`, 4000),
    ownedPaths: Object.freeze(boundedStrings(value.ownedPaths, `${label}.ownedPaths`)),
    taskProfiles: Object.freeze(boundedStrings(value.taskProfiles, `${label}.taskProfiles`, 16)),
  });
}

export function validatePrepareTaskResult(value) {
  exactKeys(value, [
    'status', 'summary', 'currentTask', 'availableScopes',
    ...(value?.status === 'prepared' ? ['context'] : []),
  ], 'prepare_task result');
  if (!STATUSES.has(value.status)) fail('PREPARE_TASK_SCHEMA_INVALID', 'prepare_task result.status is invalid.');
  const summary = boundedString(value.summary, 'prepare_task result.summary', 4000);
  const currentTask = validateTaskSummary(value.currentTask, 'prepare_task result.currentTask');
  if (!Array.isArray(value.availableScopes) || value.availableScopes.length > 32) {
    fail('PREPARE_TASK_SCHEMA_INVALID', 'prepare_task result.availableScopes is invalid.');
  }
  const availableScopes = value.availableScopes.map((scope) => {
    exactKeys(scope, ['taskProfile', 'scopeRoot', 'ownedPaths'], 'prepare_task available scope');
    if (Object.hasOwn(scope, 'scopeRoot')) {
      if (scope.taskProfile !== 'project-files' || scope.scopeRoot !== 'current-project'
        || !Array.isArray(scope.ownedPaths) || scope.ownedPaths.length !== 0) {
        fail('PREPARE_TASK_SCHEMA_INVALID', 'prepare_task available scope must use the exact current-project marker.');
      }
      return Object.freeze({ taskProfile: 'project-files', scopeRoot: 'current-project', ownedPaths: Object.freeze([]) });
    }
    return Object.freeze({
      taskProfile: boundedString(scope.taskProfile, 'prepare_task available scope.taskProfile', 128),
      ownedPaths: Object.freeze(boundedStrings(scope.ownedPaths, 'prepare_task available scope.ownedPaths', MAX_AVAILABLE_SCOPE_PATHS)),
    });
  });
  if (value.status === 'prepared' && (!value.context || typeof value.context !== 'object' || Array.isArray(value.context))) {
    fail('PREPARE_TASK_SCHEMA_INVALID', 'A prepared task must include its protected execution context.');
  }
  if (value.status !== 'prepared' && value.context !== undefined) {
    fail('PREPARE_TASK_SCHEMA_INVALID', 'Only a prepared task may include a protected execution context.');
  }
  return Object.freeze({
    status: value.status,
    summary,
    currentTask,
    availableScopes: Object.freeze(availableScopes),
    ...(value.status === 'prepared' ? { context: value.context } : {}),
  });
}

export function publicPrepareTaskResult(result) {
  const validated = validatePrepareTaskResult(result);
  return Object.freeze({
    status: validated.status,
    summary: validated.summary,
    currentTask: validated.currentTask,
    availableScopes: validated.availableScopes,
  });
}

export function createBrokerPrepareTaskClient({
  brokerUrl = process.env.FORGE_TASKSPACE_BROKER_URL,
  tokenFile = process.env.FORGE_TASKSPACE_TOKEN_FILE,
  timeoutMs = 30_000,
} = {}) {
  if (typeof brokerUrl !== 'string' || typeof tokenFile !== 'string') return undefined;
  const endpoint = new URL(brokerUrl);
  if (endpoint.protocol !== 'http:'
    || (!['taskspace-broker', 'taskspace-broker-stable', 'taskspace-broker-enhanced', '127.0.0.1', 'localhost'].includes(endpoint.hostname)
      && !/^taskspace-broker-(?:stable|enhanced)-r[1-9][0-9]{0,5}$/u.test(endpoint.hostname))
    || endpoint.username || endpoint.password || (endpoint.pathname !== '/' && endpoint.pathname !== '')
    || !tokenFile.startsWith('/run/forge-taskspace/')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) {
    fail('PREPARE_TASK_CLIENT_INVALID', 'Broker prepare-task client configuration is invalid.');
  }
  return async (body) => {
    if (body?.action !== PREPARE_TASK_ACTION) fail('PREPARE_TASK_SCHEMA_INVALID', 'Broker prepare-task action is invalid.');
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (token.length < 32 || token.length > 256) fail('PREPARE_TASK_AUTHENTICATION_INVALID', 'TaskSpace capability token is invalid.');
    const payload = Buffer.from(JSON.stringify(body));
    const result = await new Promise((resolve, reject) => {
      const request = http.request({
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: '/v1/actions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          'x-forge-taskspace-token': token,
        },
      }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) response.destroy(new Error('Prepare-task response exceeded its limit.'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if ((response.statusCode ?? 500) >= 400 || document.ok !== true) {
              reject(Object.assign(
                new Error(`${document.error?.code ?? 'PREPARE_TASK_FAILED'}: ${document.error?.message ?? 'Task preparation failed.'}`),
                { code: document.error?.code ?? 'PREPARE_TASK_FAILED' },
              ));
            } else resolve(document.result);
          } catch (error) { reject(error); }
        });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error('PREPARE_TASK_TIMEOUT: internal Broker request timed out.')));
      request.once('error', reject);
      request.end(payload);
    });
    return validatePrepareTaskResult(result);
  };
}

export function registerPrepareTaskTool(ctx, defineTool, execute, options = {}) {
  // Direct mode receives its authority from the real user request. Exposing
  // the retired proposal tool sends the model back into duplicate preparation.
  if (process.env.FORGE_DEVELOPMENT_MODE === 'direct') return;
  if (!ctx?.tools || typeof ctx.tools.register !== 'function' || typeof defineTool !== 'function'
    || typeof execute !== 'function') {
    fail('PREPARE_TASK_TOOL_INVALID', 'prepare_task tool dependencies are unavailable.');
  }
  ctx.tools.register(defineTool({
    name: PREPARE_TASK_TOOL_NAME,
    description: 'Inspect the server-owned ordinary task scopes, or propose one exact task scope after bounded read-only repository inspection. A proposal is untrusted and cannot raise permissions; the trusted service may reject it or prepare a new protected execution generation. This tool is unavailable for governed delivery phases.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['inspect', 'propose'], description: 'Use inspect to view bounded server-owned scopes; use propose after reading relevant repository files.' },
      proposal: {
        type: 'object',
        additionalProperties: false,
        description: 'Required only for propose. The runtime reads and hashes every referenced repository file.',
        properties: {
          goal: { type: 'string', required: true, description: 'Concrete business outcome for this bounded task.' },
          ownedPaths: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact repository-relative paths the task needs to change.' },
          taskProfiles: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact task profiles supported by those paths.' },
          references: { type: 'array', required: true, items: { type: 'string' }, description: 'Repository-relative files actually read before proposing the task.' },
          reviewContractSource: { type: 'string', description: 'Optional referenced WHAT/HOW/task JSON contract requiring protected spec-compliance and code-quality verdicts before completion.' },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true, enum: ['inspected', 'prepared', 'needs-confirmation'] },
        summary: { type: 'string', required: true },
        currentTask: { required: true, oneOf: [{
          type: 'object', additionalProperties: false, properties: {
            goal: { type: 'string', required: true },
            ownedPaths: { type: 'array', required: true, items: { type: 'string' } },
            taskProfiles: { type: 'array', required: true, items: { type: 'string' } },
          },
        }, { type: 'null' }] },
        availableScopes: { type: 'array', required: true, items: {
          type: 'object', additionalProperties: false, properties: {
            taskProfile: { type: 'string', required: true },
            scopeRoot: { type: 'string', enum: ['current-project'] },
            ownedPaths: { type: 'array', required: true, items: { type: 'string' } },
          },
        } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => publicPrepareTaskResult(await execute(
      await materializePrepareTaskArguments(args, options), exec,
    )),
  }));
}

export { PREPARE_TASK_ACTION, PREPARE_TASK_TOOL_NAME };
