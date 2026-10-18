import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { canonicalSha256 } from './forge-acceptance-aggregator.mjs';
import { digestDirectUserTextContent, hasGlobalReadOnlyIntent } from './forge-execution-context.mjs';
import { createForgeBusinessDataApprovalRequest, validateBusinessDataPreviewProposal } from './forge-business-data-approval.mjs';

export const BUSINESS_DATA_APPLY_ACTION = 'business-data-apply';
export const BUSINESS_DATA_APPLY_TOOL = 'business_data_apply';
const ACTION = 'eq-repair-ledger-note-update';
const LOOKUP = ['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RECEIPT_KEYS = ['schemaVersion', 'receiptType', 'receiptId', 'operation', 'status', 'requestId', 'requestDigest', 'approvalId', 'consumptionKey', 'executionBindingDigest', 'projectSlug', 'tenantId', 'actorUserId', 'objects', 'mutationCount', 'auditCount', 'committedAt'];
function fail(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) fail('DATA_APPLY_SCHEMA_INVALID', `${label} has unsupported or missing fields.`);
}
function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }

// This is authority for this one data tool, never a source-write ceiling.
// Quoted examples and proposed payloads cannot supply the direct instruction.
export function hasDirectBusinessDataIntent(prompt, operation) {
  if (typeof prompt !== 'string' || !['apply', 'cancel'].includes(operation)) return false;
  const direct = prompt.replace(/```[^]*?```|~~~[^]*?~~~/gu, ' ')
    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\r\n]*"|'[^'\r\n]*'/gu, ' ');
  const sourceOnly = /^(?:(?:请|但|但是|本次|本轮)\s*)?(?:不要|不得|禁止|暂不|先不|不)\s*(?:修改|改动|写入|编辑|改|写)\s*(?:任何|全部|所有)?(?:源码|代码|源文件|文件|仓库)(?:文件)?[。；;！？!?]?$/u;
  const otherDataOnly = /^(?:(?:请|但|但是|本次|本轮)\s*)?(?:不要|不得|禁止|暂不|先不|不)\s*(?:修改|改动|更新|写入|编辑|变更|改|写)\s*(?:其他|其它)(?:业务)?数据[。；;！？!?]?$/u;
  const clauses = (direct.match(/[^，,。；;！？!?\r\n]+(?:[，,。；;！？!?]|$)/gu) ?? [])
    .map(value => value.trim()).filter(value => !sourceOnly.test(value.replace(/[，,]$/u, ''))
      && !otherDataOnly.test(value.replace(/[，,]$/u, '')));
  const dataPrompt = clauses.join('\n');
  if (hasGlobalReadOnlyIntent(dataPrompt)
    || /(?:不要|不得|禁止|暂不|先不|不允许|不授权).{0,24}(?:修改|更新|写入|变更|操作|执行|取消|撤销).{0,24}(?:数据|台账|审批|批准|apply|cancel)/iu.test(dataPrompt)
    || /(?:不要|不得|禁止|暂不|先不|不允许|不授权).{0,24}(?:数据|台账).{0,24}(?:改成|改为|设为)/u.test(dataPrompt)
    || /(?:仅|只)(?:做|进行)?(?:预览|查看|检查|分析|审查|说明|解释)/u.test(dataPrompt)) return false;
  const dataTarget = /(?:业务数据|数据库|维修台账|检修台账|台账.{0,32}(?:备注|remark)|eq-repair-ledger)/iu;
  return clauses.some(clause => {
    const subject = clause.replace(/(?:通过|调用|使用)接口\s*(?=修改|更新|写入|变更|改成|改为|设为)/gu, '');
    if (/[？?]\s*$/u.test(clause) || /(?:源码|代码|实现|接口|单元测试)/u.test(subject)) return false;
    if (operation === 'cancel' && /(?:取消|撤销).{0,48}(?:审批|批准|approval)|(?:审批|批准|approval).{0,48}(?:取消|撤销)/iu.test(clause)) return true;
    if (operation === 'apply' && dataTarget.test(clause)
      && /(?:修改|更新|写入|变更|改成|改为|设为)/u.test(clause)) return true;
    return dataTarget.test(dataPrompt) && /business_data_apply/u.test(dataPrompt)
      && new RegExp('(?:执行|调用|使用).{0,48}operation\\s*=\\s*' + operation + '\\b', 'iu').test(clause);
  });
}

export function validateBusinessDataApplyArguments(input) {
  exact(input, ['operation', 'request', 'attestation', 'proposal'], 'Business data operation');
  if (!['apply', 'cancel'].includes(input.operation)) fail('DATA_APPLY_SCHEMA_INVALID', 'Only apply or cancel is supported.');
  const proposal = validateBusinessDataPreviewProposal(input.proposal);
  if (proposal.action !== ACTION || proposal.objects.some(item => item.objectType !== 'eq-repair-ledger'
    || item.changes.length !== 1 || item.changes[0].field !== 'remark'
    || [item.changes[0].before, item.changes[0].after].some(value => value !== null && typeof value !== 'string'))) {
    fail('DATA_APPLY_SCOPE_INVALID', 'This consumer supports only exact repair ledger remark changes.');
  }
  if (!input.request || typeof input.request !== 'object' || Array.isArray(input.request)) fail('DATA_APPLY_SCHEMA_INVALID', 'A sealed approval request is required.');
  const { requestDigest, ...rawRequest } = input.request;
  const request = createForgeBusinessDataApprovalRequest(rawRequest);
  if (requestDigest !== request.requestDigest || !isDeepStrictEqual(input.request, request)) fail('REQUEST_INTEGRITY_INVALID', 'Approval request integrity does not match.');
  const objects = proposal.objects.map(item => ({ objectType: item.objectType, objectId: item.objectId,
    beforeSha256: canonicalSha256({ remark: item.changes[0].before }), afterSha256: canonicalSha256({ remark: item.changes[0].after }), fields: ['remark'] }));
  if (request.action !== ACTION || !isDeepStrictEqual(request.scope, proposal.scope) || !isDeepStrictEqual(request.objects, objects)) {
    fail('OBJECT_BINDING_STALE', 'The proposed objects, fields or values differ from the exact approved request.');
  }
  const attestation = input.attestation;
  exact(attestation, ['schemaVersion', 'attestationType', 'approvalId', 'requestDigest', 'decision', 'approvedAt', 'expiresAt', 'authorizedActorUserId', 'issuer', 'signature'], 'Protected approval');
  exact(attestation.issuer, ['subjectId', 'keyId', 'role'], 'Protected issuer');
  if (attestation.schemaVersion !== 1 || attestation.attestationType !== 'forge-business-data/protected-approval'
    || attestation.decision !== 'approved' || !UUID.test(attestation.approvalId ?? '')
    || attestation.requestDigest !== request.requestDigest || attestation.authorizedActorUserId !== request.actor.actorUserId
    || attestation.issuer.role !== 'business-data-approver' || !SAFE.test(attestation.issuer.subjectId ?? '') || !SAFE.test(attestation.issuer.keyId ?? '')
    || attestation.issuer.subjectId === request.actor.actorUserId || !/^[A-Za-z0-9_-]{86}$/u.test(attestation.signature ?? '')
    || !timestamp(attestation.approvedAt) || !timestamp(attestation.expiresAt)
    || Date.parse(attestation.approvedAt) < Date.parse(request.requestedAt)
    || Date.parse(attestation.expiresAt) <= Date.parse(attestation.approvedAt)
    || Date.parse(attestation.expiresAt) > Date.parse(request.expiresAt)) fail('ATTESTATION_INVALID', 'Protected approval binding is invalid.');
  // This is structural admission only. The fixed database consumer must verify
  // the actual Ed25519 signature against its protected issuer key in all cases.
  return { operation: input.operation, request, attestation: structuredClone(attestation), proposal };
}

export function validateBusinessDataConsumptionReceipt(receipt, body) {
  exact(receipt, RECEIPT_KEYS, 'Consumption receipt');
  const { request, attestation, executionBinding, operation } = body;
  const count = operation === 'apply' ? request.objects.length : 0;
  const consumptionKey = canonicalSha256({ approvalId: attestation.approvalId, requestDigest: request.requestDigest, actor: request.actor, source: request.source });
  if (receipt.schemaVersion !== 1 || receipt.receiptType !== 'forge-business-data/consumption' || !UUID.test(receipt.receiptId ?? '')
    || receipt.operation !== operation || receipt.status !== (operation === 'apply' ? 'applied' : 'cancelled')
    || receipt.requestId !== request.requestId || receipt.requestDigest !== request.requestDigest || receipt.approvalId !== attestation.approvalId
    || receipt.consumptionKey !== consumptionKey || receipt.executionBindingDigest !== canonicalSha256(executionBinding)
    || receipt.projectSlug !== request.projectSlug || receipt.tenantId !== request.scope.tenantId || receipt.actorUserId !== request.actor.actorUserId
    || !isDeepStrictEqual(receipt.objects, request.objects) || receipt.mutationCount !== count || receipt.auditCount !== count
    || !timestamp(receipt.committedAt) || Date.parse(receipt.committedAt) < Date.parse(executionBinding.observedAt)
    || Date.parse(receipt.committedAt) >= Math.min(Date.parse(request.expiresAt), Date.parse(attestation.expiresAt), Date.parse(executionBinding.expiresAt))) {
    fail('DATA_CONSUMPTION_RECEIPT_INVALID', 'The database consumer did not return this exact committed operation.');
  }
  return structuredClone(receipt);
}

export async function executeForgeBusinessDataConsumption({ request: body, readContext, inspectSource, authorizeIntent, consume, now = Date.now() }) {
  exact(body, ['action', 'operation', 'request', 'attestation', 'proposal', 'lookup', 'expectedExecutionId', 'expectedGeneration', 'promptText', 'callId'], 'Broker data operation');
  if (body.action !== BUSINESS_DATA_APPLY_ACTION) fail('DATA_APPLY_SCHEMA_INVALID', 'Invalid data action.');
  exact(body.lookup, LOOKUP, 'Execution lookup');
  const args = validateBusinessDataApplyArguments({ operation: body.operation, request: body.request, attestation: body.attestation, proposal: body.proposal });
  const context = await readContext();
  if (!context || LOOKUP.some(key => context[key] !== body.lookup[key]) || context.executionId !== body.expectedExecutionId
    || context.generation !== body.expectedGeneration || !Number.isSafeInteger(context.generation) || context.generation < 1
    || !timestamp(context.expiresAt) || Date.parse(context.expiresAt) <= now
    || typeof body.promptText !== 'string' || Buffer.byteLength(body.promptText, 'utf8') > 48 * 1024
    || digestDirectUserTextContent([{ type: 'text', text: body.promptText }]) !== context.textDigest
    || typeof body.callId !== 'string' || !/^[^\p{Cc}]{1,256}$/u.test(body.callId)) {
    fail('DATA_APPLY_CONTEXT_MISMATCH', 'A current protected execution binding and direct request are required.');
  }
  if (typeof authorizeIntent === 'function') {
    const authorization = await authorizeIntent({ ...Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'rpcId'].map(key => [key, context[key]])), promptTextDigest: context.textDigest, operation: args.operation });
    if (authorization?.authorized !== true || authorization.operation !== args.operation || authorization.rpcId !== context.rpcId) {
      fail('DATA_APPLY_INTENT_REQUIRED', 'The current protected request did not authorize this data operation.');
    }
  } else if (!hasDirectBusinessDataIntent(body.promptText, args.operation)) {
    fail('DATA_APPLY_INTENT_REQUIRED', 'This exact data operation requires a current direct user instruction; source-write authority is insufficient.');
  }
  const source = await inspectSource();
  if ((context.sourceCommit != null && source.head !== context.sourceCommit)
    || (context.workspaceFingerprint != null && source.fingerprint !== context.workspaceFingerprint)
    || args.request.source.head !== source.head || args.request.source.fingerprint !== `sha256:${source.fingerprint}`) {
    fail('DATA_APPLY_SOURCE_CHANGED', 'The exact approved source and current protected source must match.');
  }
  if (args.request.projectSlug !== context.projectSlug || args.request.actor.actorUserId !== context.actorUserId) fail('ACTOR_BINDING_STALE', 'The approval is not for this authenticated actor and project.');
  if (now < Date.parse(args.attestation.approvedAt) || now >= Math.min(Date.parse(args.request.expiresAt), Date.parse(args.attestation.expiresAt))) fail('APPROVAL_EXPIRED', 'The approval is not currently valid.');
  // Inspecting source cannot revive an inactive/replaced protected context.
  // Consumed means the prompt was admitted, not that a native model turn is
  // still running. Only the explicit cancel operation revokes this approval
  // in the business database; stopping a native turn is not such a revocation.
  if (!isDeepStrictEqual(context, await readContext())) fail('DATA_APPLY_CONTEXT_CHANGED', 'The protected execution changed before dispatch.');
  if (typeof consume !== 'function') fail('DATA_CONSUMER_UNAVAILABLE', 'No protected fixed database consumer is configured.');
  const executionBinding = { ...Object.fromEntries(LOOKUP.map(key => [key, context[key]])), executionId: context.executionId,
    generation: context.generation, callId: body.callId, source: { head: source.head, fingerprint: `sha256:${source.fingerprint}` },
    observedAt: new Date(now).toISOString(), expiresAt: context.expiresAt };
  const input = { schemaVersion: 1, ...args, executionBinding };
  return validateBusinessDataConsumptionReceipt(await consume(input), input);
}

export function createFixedBusinessDataConsumer({
  url = process.env.FORGE_BUSINESS_DATA_CONSUMER_URL,
  allowedHost = process.env.FORGE_BUSINESS_DATA_CONSUMER_ALLOWED_HOST,
  tokenFile = process.env.FORGE_BUSINESS_DATA_CONSUMER_TOKEN_FILE,
  readTokenFile = readFile, timeoutMs = 10_000,
} = {}) {
  if ([url, tokenFile, allowedHost].every(value => value === undefined || value === '')) return undefined;
  let endpoint;
  try { endpoint = new URL(url); } catch { fail('DATA_CONSUMER_CONFIG_INVALID', 'The protected data consumer URL is invalid.'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/internal/forge/business-data/consume'
    || typeof allowedHost !== 'string' || allowedHost.length === 0 || endpoint.hostname !== allowedHost
    || typeof tokenFile !== 'string' || !tokenFile.startsWith('/run/forge-business-data/') || path.posix.normalize(tokenFile) !== tokenFile
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) {
    fail('DATA_CONSUMER_CONFIG_INVALID', 'Use one protected fixed internal consumer and its protected token file.');
  }
  return async body => {
    let token;
    try { token = (await readTokenFile(tokenFile, 'utf8')).trim(); } catch { fail('DATA_CONSUMER_TOKEN_UNAVAILABLE', 'The protected consumer credential is unavailable.'); }
    if (typeof token !== 'string' || token.length < 32 || token.length > 256 || /[\r\n]/u.test(token)) fail('DATA_CONSUMER_TOKEN_INVALID', 'The protected consumer credential is invalid.');
    const payload = Buffer.from(JSON.stringify(body));
    if (payload.length > 128 * 1024) fail('DATA_APPLY_SCHEMA_INVALID', 'The bounded data request is too large.');
    return new Promise((resolve, reject) => {
      const transport = endpoint.protocol === 'https:' ? https : http;
      const req = transport.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length, authorization: `Bearer ${token}` } }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 128 * 1024) response.destroy(new Error('Response limit exceeded')); else chunks.push(chunk); });
        response.once('error', () => reject(Object.assign(new Error('DATA_CONSUMER_TRANSPORT_FAILED: No committed result was established.'), { code: 'DATA_CONSUMER_TRANSPORT_FAILED' })));
        response.once('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if ((response.statusCode ?? 500) !== 200) {
              const code = /^[A-Z][A-Z0-9_]{1,79}$/u.test(value?.error?.code ?? '') ? value.error.code : 'DATA_CONSUMER_REJECTED';
              fail(code, 'The database consumer rejected this exact operation.');
            }
            resolve(validateBusinessDataConsumptionReceipt(value, body));
          } catch (error) {
            reject(Object.assign(new Error(`${error.code ?? 'DATA_CONSUMER_RESPONSE_INVALID'}: No matching committed receipt was established.`), { code: error.code ?? 'DATA_CONSUMER_RESPONSE_INVALID' }));
          }
        });
      });
      const timer = setTimeout(() => req.destroy(new Error('Consumer timeout')), timeoutMs);
      req.once('close', () => clearTimeout(timer));
      req.once('error', () => reject(Object.assign(new Error('DATA_CONSUMER_TRANSPORT_FAILED: No committed result was established; inspect this request before any retry.'), { code: 'DATA_CONSUMER_TRANSPORT_FAILED' })));
      req.end(payload);
    });
  };
}
