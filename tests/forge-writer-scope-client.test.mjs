import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createBrokerWriterScopeLeaseClient, installForgeWriterScopeLease } from '../docker/harness/forge-writer-scope-client.mjs';

const PERMIT_ID = 'b8d759fa-76ee-4a05-9d66-02bb38243e43';
const context = () => ({ projectSlug: 'demo-project', taskId: 'task-a', actorUserId: '2ff962d2-92f4-4a94-a25c-6ff1e11496e2',
  conversationId: 'conversation-a', dshSessionId: 'session-a', rpcId: 'rpc-a', textDigest: 'a'.repeat(64),
  executionId: 'execution-a', generation: 2, contractId: 'b'.repeat(64),
  contract: { contractId: 'b'.repeat(64), ownedPaths: ['forge-admin-ui/src/views'] } });
const execution = (overrides = {}) => ({ name: 'write', callId: 'call-a', arguments: { file_path: '/workspace/forge-admin-ui/src/views/a.vue', content: 'body' },
  agent: { session: { id: 'session-a' } }, signal: new AbortController().signal, ...overrides });
const acquired = ({ context: value, exec, filePath, permit }) => ({ schemaVersion: 1, status: 'acquired', permitId: permit?.permitId ?? PERMIT_ID,
  executionId: value.executionId, generation: value.generation, contractId: value.contract.contractId,
  callId: exec.callId, toolName: exec.name, filePath, ownedPaths: [...value.contract.ownedPaths], expiresAt: new Date(Date.now() + 60_000).toISOString() });
const settled = ({ permit, exec }) => ({ schemaVersion: 1, status: 'settled', permitId: permit.permitId, callId: exec.callId });
function hook(options) {
  let callback;
  const dispose = installForgeWriterScopeLease({ on(name, handler) { assert.equal(name, 'tools/execute'); callback = handler; return () => { callback = undefined; }; } }, options);
  return { execute: (...args) => callback(...args), dispose };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('HTTP acquisition timeout cancels only its pinned capability before the body', async t => {
  for (const scenario of ['persisted-response-lost', 'late-acquire', 'cancel-unconfirmed']) {
    await t.test(scenario, async t => {
      const requests = []; const cancelled = new Set(); const active = new Set();
      let late, bodyCalls = 0;
      const server = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks)); requests.push(payload);
        if (payload.operation === 'acquire') {
          if (scenario === 'late-acquire') late = payload;
          else active.add(payload.permitId);
          return; // persisted request without a response reproduces B05 timeout
        }
        assert.equal(payload.operation, 'cancel-acquire');
        assert.deepEqual(payload, { ...requests[0], operation: 'cancel-acquire' });
        res.setHeader('content-type', 'application/json');
        if (scenario === 'cancel-unconfirmed') {
          res.statusCode = 409;
          return res.end(JSON.stringify({ ok: false, error: { code: 'WRITER_SCOPE_PERMIT_MISMATCH', message: 'denied' } }));
        }
        cancelled.add(payload.permitId); active.delete(payload.permitId);
        if (late && !cancelled.has(late.permitId)) active.add(late.permitId);
        res.end(JSON.stringify({ ok: true, result: { schemaVersion: 1, status: 'acquisition-cancelled',
          permitId: payload.permitId, callId: payload.callId } }));
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
      const client = createBrokerWriterScopeLeaseClient({ brokerUrl: `http://127.0.0.1:${server.address().port}`,
        tokenFile: '/run/forge-taskspace/token', timeoutMs: 1000, readTokenFile: async () => 't'.repeat(48) });
      const around = hook({ resolveContext: () => context(), client });
      await assert.rejects(around.execute(execution(), () => { bodyCalls++; }), error => {
        assert.equal(error.bodyStarted, false);
        assert.equal(error.code, scenario === 'cancel-unconfirmed' ? 'WRITER_SCOPE_ACQUIRE_UNCONFIRMED' : 'WRITER_SCOPE_TIMEOUT');
        assert.equal(error.permitId, requests[0].permitId); return true;
      });
      assert.equal(bodyCalls, 0); assert.equal(requests.length, 2);
      assert.equal(active.size, scenario === 'cancel-unconfirmed' ? 1 : 0);
      assert.equal(requests.filter(x => x.operation === 'acquire').length, 1, 'the mutation acquisition is never replayed');
    });
  }
});

test('HTTP successful acquisition cannot cancel an unfinished body and body failure settles normally', async t => {
  const requests = []; const entered = deferred(); const finish = deferred();
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks)); requests.push(payload);
    const args = { context: context(), exec: execution(), filePath: payload.filePath, permit: { permitId: payload.permitId } };
    assert.ok(['acquire', 'settle'].includes(payload.operation));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: payload.operation === 'acquire' ? acquired(args) : settled(args) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = createBrokerWriterScopeLeaseClient({ brokerUrl: `http://127.0.0.1:${server.address().port}`,
    tokenFile: '/run/forge-taskspace/token', timeoutMs: 1000, readTokenFile: async () => 't'.repeat(48) });
  const around = hook({ resolveContext: () => context(), client });
  const failure = new Error('real body failed');
  const action = around.execute(execution(), async () => { entered.resolve(); await finish.promise; throw failure; });
  const rejected = assert.rejects(action, error => error === failure);
  await entered.promise; await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(requests.map(x => x.operation), ['acquire']);
  finish.resolve(); await rejected;
  assert.deepEqual(requests.map(x => x.operation), ['acquire', 'settle']);
});

test('around hook holds scope through the actual async body; overlapping call conflicts without entering its body', async () => {
  const events = [];
  const entered = deferred();
  const finish = deferred();
  let active = false;
  const client = async (operation, args) => {
    if (operation === 'acquire') {
      if (active) throw Object.assign(new Error('overlap'), { code: 'PATH_RESOURCE_CONFLICT' });
      active = true; events.push(`acquire:${args.exec.callId}`); return acquired(args);
    }
    assert.equal(active, true); active = false; events.push(`settle:${args.exec.callId}`); return settled(args);
  };
  const around = hook({ resolveContext: async () => context(), client });
  const exec = execution();
  const originalArgs = exec.arguments;
  const first = around.execute(exec, async () => { events.push('body:start'); entered.resolve(); await finish.promise; events.push('body:end'); return 'written'; });
  await entered.promise;
  await assert.rejects(around.execute(execution({ callId: 'call-b' }), () => assert.fail('conflicting body entered')), { code: 'PATH_RESOURCE_CONFLICT' });
  assert.deepEqual(events, ['acquire:call-a', 'body:start']);
  finish.resolve();
  assert.equal(await first, 'written');
  assert.deepEqual(events, ['acquire:call-a', 'body:start', 'body:end', 'settle:call-a']);
  assert.equal(exec.arguments, originalArgs);
  assert.equal(exec.arguments.file_path, '/workspace/forge-admin-ui/src/views/a.vue');
  assert.equal(await around.execute(execution({ callId: 'call-c' }), async () => 'later'), 'later');
  around.dispose();
});

test('body failure is preserved after successful settlement', async () => {
  const expected = new Error('disk write failed');
  const events = [];
  const around = hook({ resolveContext: () => context(), client: async (operation, args) => { events.push(operation); return operation === 'acquire' ? acquired(args) : settled(args); } });
  await assert.rejects(around.execute(execution(), async () => { throw expected; }), error => error === expected);
  assert.deepEqual(events, ['acquire', 'settle']);
});

test('cancellation waits for delegated body quiescence and cannot cancel cleanup', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const finish = deferred();
  const events = [];
  const around = hook({ resolveContext: () => context(), client: async (operation, args) => {
    events.push(operation); assert.equal(args.exec.signal, undefined);
    return operation === 'acquire' ? acquired(args) : settled(args);
  } });
  const running = around.execute(execution({ signal: controller.signal }), async () => {
    entered.resolve(); await finish.promise; controller.signal.throwIfAborted();
  });
  const rejection = assert.rejects(running, error => error.name === 'AbortError');
  await entered.promise; controller.abort(); await Promise.resolve();
  assert.deepEqual(events, ['acquire']);
  finish.resolve(); await rejection;
  assert.deepEqual(events, ['acquire', 'settle']);
});

test('cancellation racing with acquire still settles the returned permit without entering next', async () => {
  const controller = new AbortController();
  const events = [];
  const around = hook({ resolveContext: () => context(), client: async (operation, args) => {
    events.push(operation);
    if (operation === 'acquire') { controller.abort(); return acquired(args); }
    return settled(args);
  } });
  await assert.rejects(around.execute(execution({ signal: controller.signal }), () => assert.fail('aborted body entered')), error => error.name === 'AbortError');
  assert.deepEqual(events, ['acquire', 'settle']);
});

test('missing authority, wrong-session and invalid target fail closed; reads bypass lease dependencies', async () => {
  const unavailable = hook();
  assert.equal(await unavailable.execute({ name: 'read' }, async () => 'read-result'), 'read-result');
  await assert.rejects(unavailable.execute(execution(), () => assert.fail()), { code: 'WRITER_SCOPE_UNAVAILABLE' });
  const withoutContext = hook({ client: () => assert.fail(), resolveContext: () => undefined });
  await assert.rejects(withoutContext.execute(execution(), () => assert.fail()), { code: 'WRITER_SCOPE_CONTEXT_REQUIRED' });
  const around = hook({ resolveContext: () => context(), client: () => assert.fail('invalid request reached Broker') });
  await assert.rejects(around.execute(execution({ agent: { session: { id: 'session-other' } } }), () => assert.fail()), { code: 'WRITER_SCOPE_EXECUTION_INVALID' });
  for (const file_path of ['../a', '/elsewhere/a', 'forge-admin-ui/src/../a', 'forge-admin-ui\\src\\a', 'forge-admin-ui//src/a']) {
    await assert.rejects(around.execute(execution({ arguments: { file_path } }), () => assert.fail()), { code: 'WRITER_SCOPE_PATH_INVALID' });
  }
  await assert.rejects(around.execute(execution({ arguments: { file_path: 'forge-admin-ui/src/views-other/a.vue' } }), () => assert.fail()), { code: 'WRITER_SCOPE_OUTSIDE_CONTRACT' });
});

test('mismatched acquisition and settlement identities cannot authorize or report a successful mutation', async () => {
  let nextCalls = 0;
  const badAcquire = hook({ resolveContext: () => context(), client: async (_op, args) => ({ ...acquired(args), callId: 'another-call' }) });
  await assert.rejects(badAcquire.execute(execution(), () => { nextCalls++; }), { code: 'WRITER_SCOPE_RESPONSE_INVALID' });
  assert.equal(nextCalls, 0);
  let requests = 0;
  const badSettle = hook({ resolveContext: () => context(), client: async (operation, args) => {
    requests++; return operation === 'acquire' ? acquired(args) : { ...settled(args), permitId: 'e3c31c1d-891f-4df3-8d22-c1805ec03918' };
  } });
  await assert.rejects(badSettle.execute(execution(), async () => { nextCalls++; return 'written'; }), error => error.code === 'WRITER_SCOPE_SETTLE_UNCONFIRMED' && error.bodyStarted && /Do not automatically replay/u.test(error.message));
  assert.equal(nextCalls, 1); assert.equal(requests, 2);
});

test('dual body and settlement failures retain both causes and never replay', async () => {
  const body = new Error('body failed'); const cleanup = new Error('Broker unavailable');
  const around = hook({ resolveContext: () => context(), client: async (operation, args) => {
    if (operation === 'acquire') return acquired(args); throw cleanup;
  } });
  await assert.rejects(around.execute(execution(), async () => { throw body; }), error => {
    assert.equal(error.code, 'WRITER_SCOPE_SETTLE_UNCONFIRMED'); assert.deepEqual(error.cause.errors, [body, cleanup]); return true;
  });
});

test('HTTP client sends only fixed trusted fields and strictly checks acquired and settled receipts', async t => {
  const requests = [];
  let corrupt = false;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks)); requests.push(payload);
    assert.equal(req.url, '/v1/actions'); assert.equal(req.method, 'POST');
    assert.equal(req.headers['x-forge-taskspace-token'], 't'.repeat(48));
    const args = { context: context(), exec: execution({ name: payload.toolName, callId: payload.callId }), filePath: payload.filePath,
      permit: { permitId: payload.permitId } };
    const result = payload.operation === 'acquire' ? acquired(args)
      : payload.operation === 'cancel-acquire' ? { ...settled(args), status: 'acquisition-cancelled' } : settled(args);
    if (corrupt && payload.operation === 'acquire') result.generation = 99;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createBrokerWriterScopeLeaseClient({ brokerUrl: `http://127.0.0.1:${server.address().port}`,
    tokenFile: '/run/forge-taskspace/token', readTokenFile: async file => { assert.equal(file, '/run/forge-taskspace/token'); return 't'.repeat(48); } });
  const input = { context: { ...context(), arbitraryAuthority: true }, exec: execution(), filePath: 'forge-admin-ui/src/views/a.vue', injected: 'ignored' };
  const permit = await client('acquire', input);
  assert.equal((await client('settle', { ...input, permit })).status, 'settled');
  assert.deepEqual(Object.keys(requests[0]).sort(), ['action', 'operation', 'projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest', 'executionId', 'generation', 'contractId', 'callId', 'toolName', 'filePath', 'permitId'].sort());
  assert.equal(requests[0].action, 'writer-scope-lease');
  assert.equal(Object.hasOwn(requests[0], 'content'), false);
  assert.equal(requests[1].permitId, permit.permitId);
  corrupt = true;
  await assert.rejects(client('acquire', input), { code: 'WRITER_SCOPE_RESPONSE_INVALID' });
  assert.equal(requests.length, 4);
  assert.equal(requests[3].operation, 'cancel-acquire');
  assert.equal(requests[3].permitId, requests[2].permitId);
});

test('client rejects unsafe Broker configuration and unsupported operation', async () => {
  for (const brokerUrl of ['https://taskspace-broker', 'http://external.example', 'http://user:pass@taskspace-broker', 'http://taskspace-broker/other', 'http://taskspace-broker/?path=other']) {
    assert.throws(() => createBrokerWriterScopeLeaseClient({ brokerUrl, tokenFile: '/run/forge-taskspace/token' }), { code: 'WRITER_SCOPE_CLIENT_CONFIG_INVALID' });
  }
  assert.throws(() => createBrokerWriterScopeLeaseClient({ brokerUrl: 'http://taskspace-broker', tokenFile: '/run/forge-taskspace/../secret' }), { code: 'WRITER_SCOPE_CLIENT_CONFIG_INVALID' });
  const client = createBrokerWriterScopeLeaseClient({ brokerUrl: 'http://taskspace-broker', tokenFile: '/run/forge-taskspace/token', readTokenFile: () => assert.fail() });
  await assert.rejects(client('force-release'), { code: 'WRITER_SCOPE_OPERATION_INVALID' });
});

test('permit expiring in transit is settled without entering the mutation body', async t => {
  const operations = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks)); operations.push(payload.operation);
    const args = { context: context(), exec: execution(), filePath: payload.filePath, permit: { permitId: payload.permitId } };
    // The server already persisted this permit; the response reaches the
    // client after its deadline. No timing-sensitive sleep is needed.
    const result = payload.operation === 'acquire'
      ? { ...acquired(args), expiresAt: new Date(Date.now() - 1000).toISOString() }
      : settled(args);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createBrokerWriterScopeLeaseClient({ brokerUrl: `http://127.0.0.1:${server.address().port}`,
    tokenFile: '/run/forge-taskspace/token', readTokenFile: async () => 't'.repeat(48) });
  const around = hook({ resolveContext: () => context(), client });
  const exec = execution({ arguments: { file_path: '/workspace/forge-admin-ui/src/views/@运维/供应商 备注.vue', content: 'unchanged' } });
  await assert.rejects(around.execute(exec, () => assert.fail('expired permit entered body')), { code: 'WRITER_SCOPE_PERMIT_EXPIRED' });
  assert.deepEqual(operations, ['acquire', 'settle']);
});

test('settlement retry is bounded to the exact busy permit within one operation deadline', async t => {
  for (const scenario of ['busy-then-settled', 'busy-exhausted', 'nonbusy', 'unknown', 'mismatched-receipt', 'acquire-busy', 'deadline']) {
    await t.test(scenario, async t => {
      const requests = [], timers = [];
      let active = false, bodyCalls = 0, settlementCalls = 0, tokenReads = 0;
      const sensitive = '/private/path token=do-not-expose';
      const server = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8'), payload = JSON.parse(raw);
        requests.push({ raw, payload });
        const args = { context: context(), exec: execution(), filePath: payload.filePath, permit: { permitId: payload.permitId } };
        const send = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
        const reject = code => { res.statusCode = 422; send({ ok: false, error: { code, message: sensitive } }); };
        if (payload.operation === 'acquire') {
          if (scenario === 'acquire-busy') return reject('EXECUTION_STATE_BUSY');
          active = true; return send({ ok: true, result: acquired(args) });
        }
        settlementCalls++;
        assert.equal(payload.permitId, requests[0].payload.permitId);
        if (scenario === 'deadline') {
          timers.push(setTimeout(() => reject('EXECUTION_STATE_BUSY'), settlementCalls === 1 ? 650 : 750));
          return;
        }
        if (scenario === 'busy-exhausted' || (scenario === 'busy-then-settled' && settlementCalls < 3)) return reject('EXECUTION_STATE_BUSY');
        if (scenario === 'nonbusy') return reject('WRITER_SCOPE_PERMIT_MISMATCH');
        if (scenario === 'unknown') return reject('unexpected-code-with-private-text');
        if (scenario === 'mismatched-receipt') return send({ ok: true, result: { ...settled(args), callId: 'another-call' } });
        active = false; send({ ok: true, result: settled(args) });
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      t.after(async () => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
      const client = createBrokerWriterScopeLeaseClient({ brokerUrl: `http://127.0.0.1:${server.address().port}`,
        tokenFile: '/run/forge-taskspace/token', timeoutMs: scenario === 'deadline' ? 1000 : 5000,
        readTokenFile: async () => { tokenReads++; return 't'.repeat(48); } });
      const around = hook({ resolveContext: () => context(), client });
      const started = performance.now();
      const action = around.execute(execution(), () => { bodyCalls++; return 'written-once'; });
      if (scenario === 'busy-then-settled') {
        assert.equal(await action, 'written-once'); assert.equal(active, false); assert.equal(settlementCalls, 3);
      } else if (scenario === 'acquire-busy') {
        await assert.rejects(action, { code: 'EXECUTION_STATE_BUSY' });
        assert.equal(active, false); assert.equal(bodyCalls, 0); assert.equal(settlementCalls, 0); assert.equal(requests.length, 1);
      } else {
        const causeCode = { 'busy-exhausted': 'EXECUTION_STATE_BUSY', nonbusy: 'WRITER_SCOPE_PERMIT_MISMATCH',
          unknown: 'UNKNOWN', 'mismatched-receipt': 'WRITER_SCOPE_RESPONSE_INVALID', deadline: 'WRITER_SCOPE_TIMEOUT' }[scenario];
        await assert.rejects(action, error => {
          assert.equal(error.code, 'WRITER_SCOPE_SETTLE_UNCONFIRMED'); assert.equal(error.settlementCauseCode, causeCode);
          assert.equal(error.bodyStarted, true); assert.equal(error.permitId, requests[0].payload.permitId); assert.equal(error.callId, 'call-a');
          assert.match(error.message, new RegExp(`cause=${causeCode}`)); assert.match(error.message, /Do not automatically replay/u);
          assert.equal(error.message.includes(sensitive), false); assert.equal(error.message.includes('unexpected-code-with-private-text'), false);
          return true;
        });
        assert.equal(active, true, 'Unconfirmed settlement must not fabricate removal of the active permit.');
        assert.equal(settlementCalls, scenario === 'busy-exhausted' ? 3 : scenario === 'deadline' ? 2 : 1);
      }
      if (scenario !== 'acquire-busy') {
        assert.equal(bodyCalls, 1); assert.equal(tokenReads, 2);
        const settlements = requests.filter(item => item.payload.operation === 'settle');
        assert.equal(new Set(settlements.map(item => item.raw)).size, 1, 'Every settlement uses identical frozen identity and permit bytes.');
        assert.deepEqual(settlements[0].payload, { ...requests[0].payload, operation: 'settle', permitId: requests[0].payload.permitId });
      }
      if (scenario === 'deadline') {
        const elapsed = performance.now() - started;
        assert.ok(elapsed >= 900 && elapsed < 1250, `All requests and backoff must share 1000 ms, observed ${elapsed} ms.`);
      }
    });
  }
});
