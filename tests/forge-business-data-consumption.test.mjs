import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { canonicalSha256 } from '../docker/harness/forge-acceptance-aggregator.mjs';
import { createForgeBusinessDataDeniedPreview, issueForgeBusinessDataApprovalAttestation } from '../docker/harness/forge-business-data-approval.mjs';
import { BUSINESS_DATA_APPLY_ACTION, BUSINESS_DATA_APPLY_TOOL, createFixedBusinessDataConsumer,
  executeForgeBusinessDataConsumption, validateBusinessDataApplyArguments, hasDirectBusinessDataIntent } from '../docker/harness/forge-business-data-consumption.mjs';
import { registerBusinessDataApplyTool, createBrokerBusinessDataApplyClient } from '../docker/harness/forge-business-data-preview.mjs';
import { digestDirectUserTextContent } from '../docker/harness/forge-execution-context.mjs';
import { validateTaskspaceAction } from '../docker/harness/taskspace-policy.mjs';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';
import { describeGovernedTool, isReadExecution, isBusinessDataMutationExecution, toolDenialReason } from '../docker/harness/forge-phase-budget-guard.mjs';

const promptText = '按本次受保护审批修改唯一检修台账的备注，保留其他数据。取消本次未消费审批。';
const now = Date.parse('2026-10-03T12:00:00.000Z');
const context = { projectSlug: 'forge-base', taskId: 'task-data', actorUserId: '123e4567-e89b-42d3-a456-426614174000',
  conversationId: 'conversation-data', dshSessionId: 'session-data', rpcId: 'rpc-data',
  textDigest: digestDirectUserTextContent([{ type: 'text', text: promptText }]), executionId: '123e4567-e89b-42d3-a456-426614174001',
  generation: 2, sourceCommit: 'a'.repeat(40), workspaceFingerprint: 'b'.repeat(64), actionCeiling: 'workspace-write',
  expiresAt: '2026-10-03T12:05:00.000Z', promptText };
const { privateKey } = generateKeyPairSync('ed25519');
const issuer = { subjectId: 'protected-data-approver', keyId: 'data-key', role: 'business-data-approver' };
const proposal = { action: 'eq-repair-ledger-note-update', scope: { tenantId: '9201', purpose: 'exact-note-correction', maximumObjects: 1 },
  objects: [{ objectType: 'eq-repair-ledger', objectId: '9231', changes: [{ field: 'remark', before: '原备注', after: '已核实备注' }] }] };
const lookup = Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest'].map(key => [key, context[key]]));
async function fixture(operation = 'apply') {
  const preview = await createForgeBusinessDataDeniedPreview(proposal, { requestId: randomUUID(), projectSlug: context.projectSlug,
    actorUserId: context.actorUserId, source: { head: context.sourceCommit, fingerprint: `sha256:${context.workspaceFingerprint}` },
    binding: { taskId: context.taskId, conversationId: context.conversationId, dshSessionId: context.dshSessionId, rpcId: context.rpcId,
      textDigest: context.textDigest, executionId: context.executionId, generation: context.generation, callId: 'preview-data' },
    requestedAt: '2026-10-03T11:59:00.000Z', expiresAt: context.expiresAt });
  const attestation = issueForgeBusinessDataApprovalAttestation({ request: preview.request, approvalId: randomUUID(), expiresAt: context.expiresAt },
    { issuer, privateKey, observedAt: '2026-10-03T11:59:30.000Z' });
  return { action: BUSINESS_DATA_APPLY_ACTION, operation, request: preview.request, attestation, proposal: structuredClone(proposal),
    lookup, expectedExecutionId: context.executionId, expectedGeneration: context.generation, promptText, callId: 'apply-data' };
}
// This is a protocol fixture only; it does not claim a business database commit.
function protocolReceipt(body) {
  const { request, attestation, executionBinding, operation } = body;
  return { schemaVersion: 1, receiptType: 'forge-business-data/consumption', receiptId: randomUUID(), operation,
    status: operation === 'apply' ? 'applied' : 'cancelled', requestId: request.requestId, requestDigest: request.requestDigest,
    approvalId: attestation.approvalId,
    consumptionKey: canonicalSha256({ approvalId: attestation.approvalId, requestDigest: request.requestDigest, actor: request.actor, source: request.source }),
    executionBindingDigest: canonicalSha256(executionBinding), projectSlug: request.projectSlug, tenantId: request.scope.tenantId,
    actorUserId: request.actor.actorUserId, objects: structuredClone(request.objects),
    mutationCount: operation === 'apply' ? request.objects.length : 0, auditCount: operation === 'apply' ? request.objects.length : 0,
    committedAt: '2026-10-03T12:00:01.000Z' };
}
const run = (request, extra = {}) => executeForgeBusinessDataConsumption({ request, readContext: async () => context,
  inspectSource: async () => ({ head: context.sourceCommit, fingerprint: context.workspaceFingerprint }), consume: async body => protocolReceipt(body), now, ...extra });

test('semantic data intent is resolved from the protected request and preserves exact approval', async () => {
  const body=await fixture();let checked=0,consumed=0;
  const authorizeIntent=async input=>{checked++;assert.equal(input.promptTextDigest,context.textDigest);
    assert.equal(input.actorUserId,context.actorUserId);return {authorized:true,operation:input.operation,rpcId:input.rpcId};};
  await run(body,{authorizeIntent,consume:async input=>{consumed++;return protocolReceipt(input);}});
  assert.equal(checked,1);assert.equal(consumed,1);
  await assert.rejects(run(body,{authorizeIntent:async()=>({authorized:true,operation:'cancel',rpcId:context.rpcId})}),{code:'DATA_APPLY_INTENT_REQUIRED'});
  const changed=structuredClone(body);changed.proposal.objects[0].changes[0].after='未批准的新值';
  await assert.rejects(run(changed,{authorizeIntent}),{code:'OBJECT_BINDING_STALE'});
});

test('data consume: exact note action and scope reject injected targets, expanded objects and changed values before dispatch', async () => {
  const original = await fixture();
  assert.equal(validateTaskspaceAction(original).action, BUSINESS_DATA_APPLY_ACTION);
  for (const change of [
    value => { value.url = 'http://attacker/'; },
    value => { value.token = 'caller-token'; },
    value => { value.proposal.objects[0].changes[0].field = 'status'; },
    value => { value.proposal.objects[0].changes[0].after = 'unapproved'; },
    value => { value.proposal.objects[0].objectType = 'other'; },
    value => { value.proposal.scope.maximumObjects = 2; value.proposal.objects.push({ ...value.proposal.objects[0], objectId: '9232' }); },
  ]) {
    const altered = structuredClone(original); change(altered); let forwarded = 0;
    await assert.rejects(run(altered, { consume: async () => { forwarded++; } })); assert.equal(forwarded, 0);
  }
  assert.throws(() => validateTaskspaceAction({ ...original, executionBinding: { actorUserId: 'forged' } }));
});

test('data consume: authenticated context inactivity, clock and live source are checked before the fixed consumer', async () => {
  const original = await fixture(); let forwarded = 0;
  for (const extra of [
    { readContext: async () => ({ ...context, generation: 3 }) },
    { readContext: async () => { throw Object.assign(new Error('inactive protected context'), { code: 'DATA_APPLY_EXECUTION_INACTIVE' }); } },
    { inspectSource: async () => ({ head: context.sourceCommit, fingerprint: 'c'.repeat(64) }) },
    { now: Date.parse(context.expiresAt) },
  ]) await assert.rejects(run(original, { ...extra, consume: async () => { forwarded++; } }));
  let reads = 0;
  await assert.rejects(run(original, { readContext: async () => (++reads === 1 ? context : { ...context, generation: 3 }), consume: async () => { forwarded++; } }), { code: 'DATA_APPLY_CONTEXT_CHANGED' });
  assert.equal(forwarded, 0);
});

test('data consume: exact commit receipt is mandatory; an approval boolean, switched receipt or changed count cannot report success', async () => {
  const input = await fixture();
  for (const mutate of [
    value => ({ approvalValid: true, writerAuthorized: true }),
    value => ({ ...value, mutationCount: 2 }),
    value => ({ ...value, executionBindingDigest: `sha256:${'f'.repeat(64)}` }),
    value => ({ ...value, objects: [] }),
    value => ({ ...value, committedAt: context.expiresAt }),
  ]) await assert.rejects(run(input, { consume: async body => mutate(protocolReceipt(body)) }));
  const applied = await run(input); assert.equal(applied.status, 'applied'); assert.equal(applied.mutationCount, 1);
  const cancelled = await run(await fixture('cancel')); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.mutationCount, 0); assert.equal(cancelled.auditCount, 0);
});

test('data consume: fixed HTTP target sends only protected bearer, refuses redirects and redacts error content', async t => {
  const token = 't'.repeat(64); let mode = 'success'; let calls = 0; let seen;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/internal/forge/business-data/consume'); assert.equal(req.headers.authorization, `Bearer ${token}`);
    const chunks = []; for await (const chunk of req) chunks.push(chunk); seen = JSON.parse(Buffer.concat(chunks)); calls++;
    if (mode === 'success') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(protocolReceipt(seen))); }
    else { res.writeHead(mode === 'redirect' ? 302 : 409, { 'content-type': 'application/json', location: 'http://other-host/' }); res.end(JSON.stringify({ error: { code: mode === 'redirect' ? 'REDIRECT_NOT_ALLOWED' : 'APPROVAL_CANCELLED', message: token + ' private remark' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const consumer = createFixedBusinessDataConsumer({ url: `http://127.0.0.1:${server.address().port}/internal/forge/business-data/consume`, allowedHost: '127.0.0.1', tokenFile: '/run/forge-business-data/consumer.token', readTokenFile: async () => token });
  assert.equal((await run(await fixture(), { consume: consumer })).status, 'applied');
  assert.deepEqual(seen.executionBinding.source, { head: context.sourceCommit, fingerprint: `sha256:${context.workspaceFingerprint}` });
  mode = 'cancelled'; await assert.rejects(run(await fixture(), { consume: consumer }), error => error.code === 'APPROVAL_CANCELLED' && !error.message.includes(token) && !error.message.includes('private remark'));
  mode = 'redirect'; await assert.rejects(run(await fixture(), { consume: consumer }), { code: 'REDIRECT_NOT_ALLOWED' });
  assert.equal(calls, 3);
  assert.throws(() => createFixedBusinessDataConsumer({ url: 'http://example.com/internal/forge/business-data/consume', tokenFile: '/run/forge-business-data/consumer.token' }), { code: 'DATA_CONSUMER_CONFIG_INVALID' });
  assert.throws(() => createFixedBusinessDataConsumer({ url: 'http://127.0.0.1/other', tokenFile: '/run/forge-business-data/consumer.token' }), { code: 'DATA_CONSUMER_CONFIG_INVALID' });
  assert.equal(typeof createFixedBusinessDataConsumer({ url: 'http://192.168.176.1:24483/internal/forge/business-data/consume', allowedHost: '192.168.176.1', tokenFile: '/run/forge-business-data/consumer.token' }), 'function');
});

test('data consume: optional Compose configuration is disabled only when all three protected values are empty', () => {
  assert.equal(createFixedBusinessDataConsumer({ url: '', allowedHost: '', tokenFile: '' }), undefined);
  assert.equal(createFixedBusinessDataConsumer({ url: undefined, allowedHost: '', tokenFile: undefined }), undefined);
  for (const values of [
    { url: 'http://127.0.0.1/internal/forge/business-data/consume', allowedHost: '', tokenFile: '' },
    { url: '', allowedHost: '127.0.0.1', tokenFile: '/run/forge-business-data/consumer-token' },
    { url: 'http://127.0.0.1/internal/forge/business-data/consume', allowedHost: '', tokenFile: '/run/forge-business-data/consumer-token' },
  ]) assert.throws(() => createFixedBusinessDataConsumer(values), { code: 'DATA_CONSUMER_CONFIG_INVALID' });
});

test('data consume: new native tool is a separately governed data mutation, never the read-only preview', () => {
  const exec = { name: BUSINESS_DATA_APPLY_TOOL, callId: 'apply-data', arguments: { operation: 'apply' } };
  assert.equal(isBusinessDataMutationExecution(exec), true); assert.equal(isReadExecution(exec), false);
  assert.deepEqual(describeGovernedTool(BUSINESS_DATA_APPLY_TOOL), { admitted: true, classification: 'business-data-mutation', sideEffectClasses: ['business-data-write'] });
  assert.equal(describeGovernedTool('business_data_approval').classification, 'read');
  assert.match(toolDenialReason(undefined, exec), /protected task/u);
  const state = { protectedExecutionContextValidated: true, executionContextStatus: 'ready', taskContract: {}, executionIdentity: {},
    executionContextExpiresAt: '2099-01-01T00:00:00.000Z', actionCeiling: 'workspace-write', suspendHeuristicStops: true, prompt: promptText };
  assert.equal(toolDenialReason(state, exec), undefined);
  assert.equal(toolDenialReason({ ...state, actionCeiling: 'read-only' }, exec), undefined);
  assert.match(toolDenialReason({ ...state, executionProjectionRequired: true, executionProjectionStatus: 'ready', executionProjectionSnapshot: { state: { terminalOutcome: 'cancelled' } } }, exec), /stopped/u);
});

test('data consume: direct data intent is separate from source read-only and code-write authority', async () => {
  const allowed = '请按已签发审批，把指定维修台账的备注修改为“已核对”。不要修改源码。';
  const cases = [
    [allowed, true],
    ['请把维修台账备注改成已检查。', true],
    ['请通过接口更新维修台账备注。', true],
    ['请更新维修台账备注，但不得修改其他业务数据。', true],
    ['请只读检查本次审批，不要修改任何数据。', false],
    ['请修改源码，实现维修台账备注更新。', false],
    ['请修改接口，实现维修台账备注更新。', false],
    ['请通过接口更新维修台账备注？', false],
    ['请不要把维修台账备注改成已检查。', false],
    ['请更新维修台账备注，但不得修改维修台账数据。', false],
    ['请更新维修台账备注，但不得修改任何业务数据。', false],
    ['接口文档示例：“请把维修台账备注改成已检查。”', false],
  ];
  const original = await fixture();
  for (const [prompt, permitted] of cases) {
    const textDigest = digestDirectUserTextContent([{ type: 'text', text: prompt }]);
    const current = { ...context, promptText: prompt, textDigest, actionCeiling: 'read-only', sourceCommit: null, workspaceFingerprint: null };
    const request = { ...original, promptText: prompt, lookup: { ...lookup, textDigest } };
    const contract = compileForgeTaskExecutionContract({ prompt, actionCeiling: 'read-only', ownedPaths: [] });
    const state = { prompt, promptReadOnlyConstraint: true, actionCeiling: 'read-only', taskContract: contract,
      protectedExecutionContextValidated: true, executionContextStatus: 'ready', executionIdentity: {},
      executionContextExpiresAt: '2099-01-01T00:00:00.000Z', suspendHeuristicStops: true };
    const exec = { name: BUSINESS_DATA_APPLY_TOOL, callId: 'data-intent', arguments: { operation: 'apply' } };
    assert.equal(hasDirectBusinessDataIntent(prompt, 'apply'), permitted);
    assert.equal(toolDenialReason(state, exec) === undefined, permitted);
    assert.notEqual(toolDenialReason(state, { name: 'write', arguments: { path: 'src/forbidden.js', content: 'not authorized' } }), undefined);
    let forwarded = 0;
    const extra = { readContext: async () => current, consume: async body => { forwarded++; return protocolReceipt(body); } };
    if (permitted) {
      assert.equal((await run(request, extra)).status, 'applied');
      await assert.rejects(run(request, { ...extra, inspectSource: async () => ({ head: context.sourceCommit, fingerprint: 'c'.repeat(64) }) }), { code: 'DATA_APPLY_SOURCE_CHANGED' });
      await assert.rejects(run({ ...request, attestation: null }, extra), { code: 'DATA_APPLY_SCHEMA_INVALID' });
      const changedObject = structuredClone(request);
      changedObject.proposal.objects[0].objectId = '9232';
      await assert.rejects(run(changedObject, extra), { code: 'OBJECT_BINDING_STALE' });
      await assert.rejects(run({ ...request, lookup: { ...request.lookup, taskId: 'other-task' } }, extra), { code: 'DATA_APPLY_CONTEXT_MISMATCH' });
      const otherActor = '123e4567-e89b-42d3-a456-426614174099';
      await assert.rejects(run({ ...request, lookup: { ...request.lookup, actorUserId: otherActor } }, {
        ...extra, readContext: async () => ({ ...current, actorUserId: otherActor }),
      }), { code: 'ACTOR_BINDING_STALE' });
    } else await assert.rejects(run(request, extra), { code: 'DATA_APPLY_INTENT_REQUIRED' });
    assert.equal(forwarded, permitted ? 1 : 0);
  }
  assert.equal(hasDirectBusinessDataIntent('请取消这条维修台账的本次审批。不要修改源码。', 'cancel'), true);
  assert.equal(hasDirectBusinessDataIntent(allowed, 'cancel'), false);
  assert.equal(hasDirectBusinessDataIntent('请取消这条维修台账的本次审批。', 'apply'), false);
  assert.equal(hasDirectBusinessDataIntent('不要取消审批', 'cancel'), false);
});

test('data consume: native tool preserves exact approval and current call binding through authenticated Broker client', async t => {
  const original = await fixture(); let bodySeen;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/v1/actions'); assert.equal(req.headers['x-forge-taskspace-token'], 'b'.repeat(64));
    const chunks = []; for await (const chunk of req) chunks.push(chunk); bodySeen = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: await run(bodySeen) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createBrokerBusinessDataApplyClient({ brokerUrl: `http://127.0.0.1:${server.address().port}/`, tokenFile: '/run/forge-taskspace/token', readTokenFile: async () => 'b'.repeat(64) });
  let tool;
  registerBusinessDataApplyTool({ tools: { register(value) { tool = value; } } }, value => value, { resolveContext: async () => context, client });
  const args = Object.fromEntries(['operation', 'request', 'attestation', 'proposal'].map(key => [key, original[key]]));
  const result = await tool.execute(args, { callId: 'native-data-call', agent: { session: { id: context.dshSessionId } } });
  assert.equal(result.status, 'applied'); assert.equal(bodySeen.callId, 'native-data-call'); assert.deepEqual(bodySeen.lookup, lookup);
  assert.throws(() => validateBusinessDataApplyArguments({ ...args, executionBinding: {} }));
});

test('data consume: actual packaged SDK compiles the exact apply tool without enabling caller authority fields', {
  skip: process.env.FORGE_TEST_REAL_DSH_TOOLS !== '1' ? 'Requires the actual packaged dsh-tools SDK' : false,
}, async () => {
  const { defineTool } = await import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
  let tool;
  registerBusinessDataApplyTool({ tools: { register(value) { tool = value; } } }, defineTool);
  assert.deepEqual(tool.parameters.required, ['operation', 'request', 'attestation', 'proposal']);
  assert.deepEqual(tool.parameters.properties.operation.enum, ['apply', 'cancel']);
  assert.equal(tool.parameters.properties.request.additionalProperties, true);
  assert.equal(tool.parameters.properties.attestation.additionalProperties, true);
  const body = await fixture();
  const args = Object.fromEntries(['operation', 'request', 'attestation', 'proposal'].map(key => [key, body[key]]));
  await assert.rejects(tool.execute(args, {}), { code: 'DATA_APPLY_CONTEXT_REQUIRED' });
  const invalid = structuredClone(args); invalid.proposal.objects[0].changes[0].field = 'status';
  await assert.rejects(tool.execute(invalid, {}), { code: 'DATA_APPLY_SCOPE_INVALID' });
});
