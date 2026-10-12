import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createForgeBusinessDataApprovalRequest, evaluateForgeBusinessDataApproval,
  validateBusinessDataPreviewProposal } from '../docker/harness/forge-business-data-approval.mjs';
import { BUSINESS_DATA_PREVIEW_ACTION, BUSINESS_DATA_PREVIEW_TOOL, createBrokerBusinessDataPreviewClient,
  executeForgeBusinessDataPreview, registerBusinessDataPreviewTool } from '../docker/harness/forge-business-data-preview.mjs';
import { digestDirectUserTextContent } from '../docker/harness/forge-execution-context.mjs';
import { isReadExecution, isMutationExecution, describeGovernedTool } from '../docker/harness/forge-phase-budget-guard.mjs';

const promptText = '历史消息：OK。现在拟批量修改两条台账；以下只是请求快照，不是数据库查询结果。';
const context = {
  projectSlug: 'forge-base', taskId: 'task-preview', actorUserId: '123e4567-e89b-42d3-a456-426614174000',
  conversationId: 'conversation-preview', dshSessionId: 'session-preview', rpcId: 'rpc-preview',
  textDigest: digestDirectUserTextContent([{ type: 'text', text: promptText }]),
  executionId: '123e4567-e89b-42d3-a456-426614174001', generation: 3,
  sourceCommit: 'a'.repeat(40), workspaceFingerprint: 'b'.repeat(64),
  expiresAt: '2099-01-01T00:00:00.000Z', promptText,
};
const proposal = {
  action: 'eq-repair-ledger-batch-edit', scope: { tenantId: '9201', purpose: 'coverage-preview', maximumObjects: 2 },
  objects: ['9231', '9291'].map((objectId, index) => ({ objectType: 'EqRepairLedger', objectId,
    changes: [{ field: 'acceptanceNo', before: `BEFORE-${index}`, after: `AFTER-${index}` }] })),
};
const args = { operation: 'request', proposal };
const request = () => ({ action: BUSINESS_DATA_PREVIEW_ACTION, ...structuredClone(args),
  lookup: Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest'].map(key => [key, context[key]])),
  expectedExecutionId: context.executionId, expectedGeneration: context.generation, promptText, callId: 'call-preview',
});
const run = (body = request(), overrides = {}) => executeForgeBusinessDataPreview({ request: body,
  readContext: async () => context, inspectSource: async () => ({ head: context.sourceCommit, fingerprint: context.workspaceFingerprint }),
  now: Date.parse('2026-10-03T12:00:00.000Z'), ...overrides,
});

test('business data preview: real missing-approval branch rejects without inventing current database facts', async () => {
  const preview = await run();
  const result = await evaluateForgeBusinessDataApproval({ request: preview.request, attestation: null, current: null });
  assert.equal(result.reasonCode, 'APPROVAL_REQUIRED');
  assert.equal(result.writerAuthorized, false);
  assert.equal(result.approvalValid, false);
  const tampered = structuredClone(preview.request); tampered.scope.tenantId = 'other';
  await assert.rejects(evaluateForgeBusinessDataApproval({ request: tampered, attestation: null, current: null }), { code: 'REQUEST_INTEGRITY_INVALID' });
  // Natural language is not a protected attestation, even if the word is OK.
  await assert.rejects(evaluateForgeBusinessDataApproval({ request: preview.request, attestation: 'OK', current: null }), { code: 'SCHEMA_INVALID' });
});

test('business data preview: exact two-object projection has hashes and honest unverified provenance', async () => {
  const preview = await run();
  assert.deepEqual(preview.objects, proposal.objects);
  assert.equal(preview.snapshotSource, 'caller-proposed/unverified');
  assert.equal(preview.snapshotCoverage, 'listed-fields-only');
  assert.equal(preview.databaseVerified, false);
  assert.equal(preview.writerAuthorized, false);
  assert.equal(preview.binding.textDigest, context.textDigest);
  const hash = createHash('sha256').update(JSON.stringify({ acceptanceNo: 'BEFORE-0' })).digest('hex');
  assert.equal(preview.request.objects[0].beforeSha256, `sha256:${hash}`);
  assert.ok(Object.isFrozen(preview.objects[0].changes));
  const { requestDigest, ...input } = preview.request;
  assert.equal(createForgeBusinessDataApprovalRequest(input).requestDigest, requestDigest);
});

test('business data preview: caller cannot inject authority, hidden fields, duplicate objects or unbounded values', () => {
  for (const change of [
    value => { value.attestation = 'OK'; },
    value => { value.databaseVerified = true; },
    value => { value.objects.push(value.objects[0]); },
    value => { value.objects[0].changes.push(value.objects[0].changes[0]); },
    value => { value.objects[0].changes[0].after = { arbitrary: 'query' }; },
    value => { value.objects[0].changes[0].after = 'x'.repeat(2049); },
    value => { value.objects[0].changes[0].after = value.objects[0].changes[0].before; },
  ]) {
    const value = structuredClone(proposal); change(value);
    assert.throws(() => validateBusinessDataPreviewProposal(value), { code: 'SCHEMA_INVALID' });
  }
});

test('business data preview: fresh actor, generation, direct prompt and source changes reject before preview', async () => {
  for (const change of [
    body => { body.lookup.actorUserId = '123e4567-e89b-42d3-a456-426614174099'; },
    body => { body.expectedGeneration++; },
    body => { body.promptText = 'OK'; },
  ]) {
    const body = request(); change(body);
    await assert.rejects(run(body), { code: 'DATA_PREVIEW_CONTEXT_MISMATCH' });
  }
  await assert.rejects(run(request(), { readContext: async () => ({ ...context, expiresAt: '2020-01-01T00:00:00.000Z' }) }), { code: 'DATA_PREVIEW_CONTEXT_MISMATCH' });
  await assert.rejects(run(request(), { inspectSource: async () => ({ head: 'c'.repeat(40), fingerprint: context.workspaceFingerprint }) }), { code: 'DATA_PREVIEW_SOURCE_CHANGED' });
});

test('business data preview: native tool and authenticated HTTP client preserve call binding and reject tampered responses', async (t) => {
  let tamper = false; let calls = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/v1/actions'); assert.equal(req.headers['x-forge-taskspace-token'], 't'.repeat(64));
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls++;
    assert.equal(body.promptText, promptText);
    const result = structuredClone(await run(body));
    if (tamper) result.writerAuthorized = true;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const client = createBrokerBusinessDataPreviewClient({ brokerUrl: `http://127.0.0.1:${server.address().port}`,
    tokenFile: '/run/forge-taskspace/capability-token', readTokenFile: async () => 't'.repeat(64) });
  let definition;
  registerBusinessDataPreviewTool({ tools: { register(value) { definition = value; } } }, value => value, {
    resolveContext: async () => context, client,
  });
  const exec = { callId: 'call-preview', agent: { session: { id: context.dshSessionId } } };
  assert.equal(definition.name, BUSINESS_DATA_PREVIEW_TOOL);
  assert.equal((await definition.execute(args, exec)).gate.reasonCode, 'APPROVAL_REQUIRED');
  tamper = true;
  await assert.rejects(definition.execute(args, exec), { code: 'DATA_PREVIEW_RESPONSE_INVALID' });
  await assert.rejects(definition.execute(args, { ...exec, agent: { session: { id: 'wrong-session' } } }), { code: 'DATA_PREVIEW_CONTEXT_REQUIRED' });
  await assert.rejects(definition.execute({ ...args, approval: 'OK' }, exec), { code: 'DATA_PREVIEW_SCHEMA_INVALID' });
  assert.equal(calls, 2);
});

test('business data preview: phase guard classifies the exact tool as read-only without writer admission', () => {
  const exec = { name: BUSINESS_DATA_PREVIEW_TOOL, arguments: args };
  assert.equal(isReadExecution(exec), true);
  assert.equal(isMutationExecution(exec), false);
  assert.equal(describeGovernedTool(exec.name).classification, 'read');
});

test('business data preview: actual packaged SDK compiles nested scalars and retains execution bounds', {
  skip: process.env.FORGE_TEST_REAL_DSH_TOOLS !== '1' ? 'Requires the actual packaged dsh-tools SDK' : false,
}, async () => {
  const { defineTool } = await import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
  let tool;
  registerBusinessDataPreviewTool({ tools: { register(value) { tool = value; } } }, defineTool);
  const changes = tool.parameters.properties.proposal.properties.objects.items.properties.changes.items;
  assert.deepEqual(changes.required, ['field', 'before', 'after']);
  assert.deepEqual(changes.properties.before.oneOf.map(value => value.type), ['string', 'number', 'boolean', 'null']);
  assert.deepEqual(changes.properties.after, changes.properties.before);
  assert.equal(tool.output.schema.additionalProperties, true);
  for (const [before, after] of [['old', 'new'], [1, 2], [false, true], [null, 'set']]) {
    const value = structuredClone(args);
    value.proposal.objects[0].changes[0] = { field: 'sample', before, after };
    await assert.rejects(tool.execute(value, {}), { code: 'DATA_PREVIEW_CONTEXT_REQUIRED' });
  }
  const invalidScalar = structuredClone(args);
  invalidScalar.proposal.objects[0].changes[0].after = { nested: true };
  await assert.rejects(tool.execute(invalidScalar, {}), { code: 'INVALID_ARGS' });
  for (const mutate of [
    value => { value.proposal.scope.maximumObjects = 0; },
    value => { value.proposal.scope.maximumObjects = 101; },
    value => { value.proposal.objects = []; },
    value => { value.proposal.objects[0].changes = Array.from({ length: 33 }, (_, index) => ({ field: `f${index}`, before: 0, after: 1 })); },
  ]) {
    const value = structuredClone(args); mutate(value);
    await assert.rejects(tool.execute(value, {}), { code: 'SCHEMA_INVALID' });
  }
});
