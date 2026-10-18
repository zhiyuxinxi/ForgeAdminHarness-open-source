import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyPinnedDshPromptBody, MAX_CLAIMABLE_PROMPT_BYTES, MAX_CLAIMABLE_PROMPT_TEXT_BYTES } from '../docker/harness/forge-execution-context.mjs';
import { createHarnessProxy } from '../docker/harness/tcp-proxy.mjs';
import { createInitialPhaseState, toolDenialReason, reminderForState } from '../docker/harness/forge-phase-budget-guard.mjs';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';

const sizes = [106592, 129297, 122106, 126381, 113585, 104990, 75637, 81500];
const prompt = '装置库存管理中，删除按钮文案改为批量删除，用品名称支持点击查看只读详情；领用申请和批量删除按钮靠左，完成后保存 Git。';
const content = [...sizes.map(bytes => ({ type: 'image', mediaType: 'image/png', data: Buffer.alloc(bytes).toString('base64'), name: 'image.png' })), { type: 'text', text: prompt }];
const bodyFor = parts => Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'image-request-8129', method: 'session.prompt', payload: { sessionId: 'session-image-8129', mode: 'queue', content: parts, clientTimeZone: 'Asia/Shanghai' } }));

test('eight screenshot request above former 1 MiB retains complete text and body authority binding', () => {
  const body = bodyFor(content);
  assert.ok(body.length > 1024 * 1024 && body.length < 2 * 1024 * 1024);
  const classified = classifyPinnedDshPromptBody(body, 'session.prompt');
  assert.equal(classified.classification, 'claimable-text');
  assert.equal(classified.imageCount, 8);
  assert.equal(classified.promptText, prompt);
  assert.equal(classified.rpcId, 'image-request-8129');
  const other = structuredClone(content); other[0].data = Buffer.alloc(sizes[0], 1).toString('base64');
  const changed = classifyPinnedDshPromptBody(bodyFor(other), 'session.prompt');
  assert.equal(changed.textDigest, classified.textDigest);
  assert.notEqual(changed.bodyDigest, classified.bodyDigest);
});

test('larger image transport does not enlarge text authority or authorize images alone', () => {
  assert.equal(classifyPinnedDshPromptBody(bodyFor(content.slice(0, -1)), 'session.prompt').classification, 'read-only-image');
  assert.equal(classifyPinnedDshPromptBody(bodyFor([{ type: 'text', text: 'x'.repeat(MAX_CLAIMABLE_PROMPT_TEXT_BYTES + 1) }]), 'session.prompt').reason, 'PROMPT_TEXT_EXCEEDS_CLAIM_LIMIT');
  assert.equal(classifyPinnedDshPromptBody(bodyFor([{ type: 'image', attachmentId: 'untrusted' }, content.at(-1)]), 'session.prompt').classification, 'read-only-unknown');
});

test('unavailable direct context does not claim prior authorization or imply expiry', t => {
  const prior = process.env.FORGE_DEVELOPMENT_MODE; process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  t.after(() => prior === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = prior);
  const contract = compileForgeTaskExecutionContract({ prompt, actionCeiling: 'git-checkpoint', ownedPaths: ['.'], taskProfiles: ['project-files'] }, { developmentMode: 'direct' });
  const state = Object.assign(createInitialPhaseState(), { taskContract: contract, actionCeiling: 'git-checkpoint', executionContextStatus: 'unavailable', executionContextFailureCode: 'EXECUTION_CONTEXT_MISMATCH' });
  assert.match(toolDenialReason(state, { name: 'grep', arguments: { pattern: '库存' } }), /EXECUTION_CONTEXT_MISMATCH.*not evidence of lease expiry/);
  assert.match(reminderForState(state), /Prior-turn authority does not authorize this turn/);
});

test('proxy prepares a large screenshot request before forwarding exact bytes and rejects over-limit dispatch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-image-context-'));
  const fence = path.join(root, 'proxy-fence.json');
  await writeFile(fence, JSON.stringify({ schemaVersion: 1, state: 'committed', epoch: 'test-image-context' }));
  t.after(() => rm(root, { recursive: true, force: true }));
  let forwarded = 0, preparation;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    forwarded++; assert.deepEqual(Buffer.concat(chunks), bodyFor(content));
    assert.equal(preparation.classification, 'claimable-text');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: 'image-request-8129', result: { ok: true, value: { accepted: true } } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const proxy = createHarnessProxy({ targetHost: '127.0.0.1', targetPort: upstream.address().port,
    trustedAuthority: '127.0.0.1:20161', privilegedApiMode: 'trusted-host', maintenanceFencePath: fence,
    accessAuthorizer: { url: 'http://localhost/internal/taskspace-authorize', projectSlug: 'forge-base', taskspaceId: 'c-test',
      fetchImpl: async (url, options) => {
        if (!String(url).endsWith('execution-prepare')) return new Response(null, { status: 204 });
        preparation = JSON.parse(options.body);
        return Response.json({ ok: true, execution: { ...preparation, generation: 1 } });
      } } });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const address = `http://127.0.0.1:${proxy.address().port}/api/session.prompt`;
  const headers = { host: '127.0.0.1:20161', origin: 'http://127.0.0.1:20161', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  // Use the existing proxy tests' native HTTP client semantics; fetch replaces
  // the explicit Host with its URL authority on this Node runtime.
  const result = await new Promise((resolve, reject) => {
    const body = bodyFor(content);
    const request = http.request(address, { method: 'POST', headers: { ...headers, 'content-length': body.length } }, response => {
      response.resume(); response.on('end', () => resolve({ status: response.statusCode }));
    }); request.on('error', reject); request.end(body);
  });
  assert.equal(result.status, 200);
  assert.equal(preparation.promptBody, bodyFor(content).toString());
  assert.equal(forwarded, 1);
  const rejected = await new Promise((resolve, reject) => {
    const request = http.request(address, { method: 'POST', headers: { ...headers, 'content-length': MAX_CLAIMABLE_PROMPT_BYTES + 1 } }, response => {
      const chunks = []; response.on('data', x => chunks.push(x)); response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
    }); request.on('error', reject); request.end();
  });
  assert.equal(rejected.status, 413);
  assert.match(rejected.text, /不是授权过期/);
  assert.equal(forwarded, 1);
});
