import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digestDirectUserTextContent } from './forge-execution-context.mjs';
import { createForgeBusinessDataDeniedPreview, validateBusinessDataPreviewProposal } from './forge-business-data-approval.mjs';
import { BUSINESS_DATA_APPLY_ACTION, BUSINESS_DATA_APPLY_TOOL, validateBusinessDataApplyArguments } from './forge-business-data-consumption.mjs';

export const BUSINESS_DATA_PREVIEW_ACTION = 'business-data-preview';
export const BUSINESS_DATA_PREVIEW_TOOL = 'business_data_approval';
const LOOKUP = ['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest'];
const BINDING = ['taskId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest', 'executionId', 'generation'];

function fail(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) fail('DATA_PREVIEW_SCHEMA_INVALID', 'Unsupported or missing preview fields.');
}
export function validateBusinessDataPreviewArguments(args) {
  exact(args, ['operation', 'proposal']);
  if (args.operation !== 'request') fail('DATA_PREVIEW_SCHEMA_INVALID', 'Only request is supported; no approval or apply operation is available.');
  return { operation: 'request', proposal: validateBusinessDataPreviewProposal(args.proposal) };
}

export async function executeForgeBusinessDataPreview({ request, readContext, inspectSource, now = Date.now() }) {
  exact(request, ['action', 'operation', 'proposal', 'lookup', 'expectedExecutionId', 'expectedGeneration', 'promptText', 'callId']);
  if (request.action !== BUSINESS_DATA_PREVIEW_ACTION) fail('DATA_PREVIEW_SCHEMA_INVALID', 'Invalid preview action.');
  exact(request.lookup, LOOKUP);
  const args = validateBusinessDataPreviewArguments({ operation: request.operation, proposal: request.proposal });
  const context = await readContext();
  if (!context || LOOKUP.some((key) => context[key] !== request.lookup[key])
    || context.executionId !== request.expectedExecutionId || context.generation !== request.expectedGeneration
    || Date.parse(context.expiresAt) <= now || !Number.isFinite(Date.parse(context.expiresAt))
    || typeof request.promptText !== 'string' || Buffer.byteLength(request.promptText, 'utf8') > 48 * 1024
    || digestDirectUserTextContent([{ type: 'text', text: request.promptText }]) !== context.textDigest) {
    fail('DATA_PREVIEW_CONTEXT_MISMATCH', 'Preview must bind the current protected actor, task, execution and direct user request.');
  }
  const source = await inspectSource();
  if ((context.sourceCommit !== null && context.sourceCommit !== undefined && context.sourceCommit !== source.head)
    || (context.workspaceFingerprint !== null && context.workspaceFingerprint !== undefined
      && context.workspaceFingerprint !== source.fingerprint)) {
    fail('DATA_PREVIEW_SOURCE_CHANGED', 'The protected source binding changed; prepare the current request before previewing.');
  }
  // A field proposal is not evidence that the user supplied those values, even
  // though the enclosing tool call is bound to that user's current request.
  return createForgeBusinessDataDeniedPreview(args.proposal, {
    requestId: randomUUID(), projectSlug: context.projectSlug, actorUserId: context.actorUserId,
    source: { head: source.head, fingerprint: `sha256:${source.fingerprint}` },
    binding: { ...Object.fromEntries(BINDING.map((key) => [key, context[key]])), callId: request.callId },
    requestedAt: new Date(now).toISOString(), expiresAt: new Date(Math.min(now + 5 * 60_000, Date.parse(context.expiresAt))).toISOString(),
  });
}

export function createBrokerBusinessDataPreviewClient({
  brokerUrl = process.env.FORGE_TASKSPACE_BROKER_URL,
  tokenFile = process.env.FORGE_TASKSPACE_TOKEN_FILE, timeoutMs = 10_000, readTokenFile = readFile,
  action = BUSINESS_DATA_PREVIEW_ACTION,
} = {}) {
  if (typeof brokerUrl !== 'string' || typeof tokenFile !== 'string') return undefined;
  const endpoint = new URL(brokerUrl);
  if (endpoint.protocol !== 'http:' || !['taskspace-broker', '127.0.0.1', 'localhost'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/'
    || !tokenFile.startsWith('/run/forge-taskspace/') || path.posix.normalize(tokenFile) !== tokenFile
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000
    || ![BUSINESS_DATA_PREVIEW_ACTION, BUSINESS_DATA_APPLY_ACTION, 'managed-files'].includes(action)) {
    fail('DATA_PREVIEW_CLIENT_INVALID', 'Use the fixed internal Broker and its TaskSpace token file.');
  }
  return async (body) => {
    if (body.action !== action) fail('DATA_PREVIEW_SCHEMA_INVALID', 'Invalid Broker action.');
    const token = (await readTokenFile(tokenFile, 'utf8')).trim();
    if (token.length < 32 || token.length > 256 || /[\r\n]/u.test(token)) fail('DATA_PREVIEW_TOKEN_INVALID', 'Invalid TaskSpace token.');
    const payload = Buffer.from(JSON.stringify(body));
    if (payload.length > (action === 'managed-files' ? 2 * 1024 * 1024 : 64 * 1024)) fail('DATA_PREVIEW_SCHEMA_INVALID', 'Typed request is too large.');
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: endpoint.hostname, port: endpoint.port, path: '/v1/actions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length, 'x-forge-taskspace-token': token } }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > (action === 'managed-files' ? 2 * 1024 * 1024 : 256 * 1024)) response.destroy(new Error('DATA_PREVIEW_RESPONSE_LIMIT'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300 || document.ok !== true) {
              fail(document.error?.code ?? 'DATA_PREVIEW_REJECTED', document.error?.message ?? 'Broker rejected the preview.');
            }
            resolve(document.result);
          } catch (error) { reject(error); }
        });
      });
      const timer = setTimeout(() => request.destroy(new Error('DATA_PREVIEW_TIMEOUT')), timeoutMs);
      request.once('close', () => clearTimeout(timer)); request.once('error', reject); request.end(payload);
    });
  };
}

export function createBrokerBusinessDataApplyClient(options = {}) {
  return createBrokerBusinessDataPreviewClient({ ...options, action: BUSINESS_DATA_APPLY_ACTION });
}

export function registerBusinessDataApplyTool(ctx, defineTool, { resolveContext, client } = {}) {
  ctx.tools.register(defineTool({
    name: BUSINESS_DATA_APPLY_TOOL,
    description: 'Apply or cancel one exact protected approval for repair-ledger remark changes. A signed receipt is mandatory; generic confirmation or code-write permission is insufficient. The fixed database service verifies the signature, atomically consumes the approval, checks actual rows and commits updates/audit. Explicit cancel records the approval as cancelled in that transaction; stopping a native chat turn does not automatically revoke an already signed approval. Do not retry a transport failure until the same approval result has been inspected. No URL, token, table or SQL can be supplied.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['apply', 'cancel'] },
      request: { type: 'object', required: true, additionalProperties: true, description: 'The exact sealed approval request returned by the preview. Do not alter any field.' },
      attestation: { type: 'object', required: true, additionalProperties: true, description: 'The exact protected Ed25519 approval issued for this request. The model cannot issue or sign it.' },
      proposal: { type: 'object', required: true, additionalProperties: true, description: 'The exact preview proposal, limited to eq-repair-ledger-note-update and remark only. Runtime validation rejects all other fields or actions.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      const normalized = validateBusinessDataApplyArguments(args);
      const context = await resolveContext?.(exec);
      if (!context || context.dshSessionId !== exec?.agent?.session?.id || typeof client !== 'function'
        || typeof exec?.callId !== 'string' || !/^[^\p{Cc}]{1,256}$/u.test(exec.callId)) fail('DATA_APPLY_CONTEXT_REQUIRED', 'A current protected execution and Broker are required.');
      const result = await client({ action: BUSINESS_DATA_APPLY_ACTION, ...normalized,
        lookup: Object.fromEntries(LOOKUP.map(key => [key, context[key]])), expectedExecutionId: context.executionId,
        expectedGeneration: context.generation, promptText: context.promptText, callId: exec.callId });
      // The Broker independently validates the complete receipt against its
      // freshly observed execution binding. The tool also rejects a switched
      // approval or payload without inventing a database observation itself.
      if (result?.schemaVersion !== 1 || result.receiptType !== 'forge-business-data/consumption'
        || result.operation !== normalized.operation || result.status !== (normalized.operation === 'apply' ? 'applied' : 'cancelled')
        || result.requestId !== normalized.request.requestId || result.requestDigest !== normalized.request.requestDigest
        || result.approvalId !== normalized.attestation.approvalId || !isDeepStrictEqual(result.objects, normalized.request.objects)
        || result.actorUserId !== context.actorUserId || result.projectSlug !== context.projectSlug
        || result.tenantId !== normalized.request.scope.tenantId
        || result.mutationCount !== (normalized.operation === 'apply' ? normalized.request.objects.length : 0)
        || result.auditCount !== result.mutationCount) fail('DATA_APPLY_RESPONSE_INVALID', 'The Broker receipt is not for this exact data operation.');
      return result;
    },
  }));
}

export function registerBusinessDataPreviewTool(ctx, defineTool, { resolveContext, client } = {}) {
  ctx.tools.register(defineTool({
    name: BUSINESS_DATA_PREVIEW_TOOL,
    description: 'Request an exact business-data field-change preview and evaluate its approval gate. Historical OK or natural-language confirmation never authorizes data mutation. Values are caller-proposed and unverified against a database. This tool cannot approve or write data; it returns APPROVAL_REQUIRED with writerAuthorized=false.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['request'] },
      proposal: { type: 'object', required: true, additionalProperties: false, properties: {
        action: { type: 'string', required: true, description: 'Proposed data action, for example eq-repair-ledger-batch-edit.' },
        scope: { type: 'object', required: true, additionalProperties: false, properties: {
          tenantId: { type: 'string', required: true }, purpose: { type: 'string', required: true, description: 'A purpose identifier, such as repair-ledger-batch-adjustment. Translate the user purpose to 1-128 ASCII letters, digits, dots, underscores, colons or hyphens, starting with a letter or digit. This identifier is not an approval.' },
          maximumObjects: { type: 'integer', required: true, description: 'Maximum proposed objects, from 1 through 100; enforced at execution.' },
        } },
        objects: { type: 'array', required: true, description: 'From 1 through maximumObjects entries; enforced at execution.', items: {
          type: 'object', additionalProperties: false, properties: {
            objectType: { type: 'string', required: true }, objectId: { type: 'string', required: true },
            changes: { type: 'array', required: true, description: 'From 1 through 32 distinct changed fields; enforced at execution.', items: {
              type: 'object', additionalProperties: false, properties: {
                field: { type: 'string', required: true },
                before: { required: true, oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] },
                after: { required: true, oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] },
              },
            } },
          },
        } },
      } },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      const normalized = validateBusinessDataPreviewArguments(args);
      const context = await resolveContext?.(exec);
      if (!context || context.dshSessionId !== exec?.agent?.session?.id
        || typeof exec?.callId !== 'string' || exec.callId.length < 1 || typeof client !== 'function') {
        fail('DATA_PREVIEW_CONTEXT_REQUIRED', 'The current protected execution context and Broker are required.');
      }
      const body = { action: BUSINESS_DATA_PREVIEW_ACTION, ...normalized,
        lookup: Object.fromEntries(LOOKUP.map((key) => [key, context[key]])),
        expectedExecutionId: context.executionId, expectedGeneration: context.generation,
        promptText: context.promptText, callId: exec.callId,
      };
      const result = await client(body);
      const expected = await createForgeBusinessDataDeniedPreview(normalized.proposal, {
        requestId: result?.request?.requestId, projectSlug: context.projectSlug, actorUserId: context.actorUserId,
        source: result?.request?.source,
        binding: { ...Object.fromEntries(BINDING.map((key) => [key, context[key]])), callId: exec.callId },
        requestedAt: result?.request?.requestedAt, expiresAt: result?.request?.expiresAt,
      });
      if (!isDeepStrictEqual(result, expected)
        || (context.sourceCommit && result.request.source.head !== context.sourceCommit)
        || (context.workspaceFingerprint && result.request.source.fingerprint !== `sha256:${context.workspaceFingerprint}`)) {
        fail('DATA_PREVIEW_RESPONSE_INVALID', 'Broker preview does not match this exact request and unverified proposal.');
      }
      return result;
    },
  }));
}
