import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createCipheriv, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { createServer } from 'node:http';
import { createForgeCandidateAuthenticatedSession } from '../docker/harness/forge-candidate-auth-client.mjs';

test('candidate auth follows the RSA and encrypted session protocol without leaking identities or bypassing challenges', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const accounts = new Map([
    ['platform-fixture-a', { password: 'fixture-password-a', userId: '101', tenantId: '201', roleKeys: ['FIXTURE_READER'] }],
    ['platform-fixture-b', { password: 'fixture-password-b', userId: '102', tenantId: '201', roleKeys: ['FIXTURE_READER'] }],
  ]);
  const sessions = new Map();
  const calls = [];
  const nonces = new Set();
  // Decode the PKCS#1 block directly: modern Node disables legacy privateDecrypt padding.
  const unwrapRsa = value => {
    const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(value, 'base64'));
    assert.equal(block[0], 0); assert.equal(block[1], 2);
    const separator = block.indexOf(0, 2); assert.ok(separator >= 10);
    return block.subarray(separator + 1).toString('utf8');
  };
  const cipher = (algorithm, key, bytes, decrypt = false) => {
    const instance = (decrypt ? createDecipheriv : createCipheriv)(algorithm === 'AES' ? 'aes-128-ecb' : 'sm4-ecb', key, null);
    return Buffer.concat([instance.update(bytes), instance.final()]);
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const makeFetch = (options = {}) => async (path, init) => {
    assert.equal(init.redirect, 'error');
    assert.ok(path.startsWith('/') && !path.startsWith('//'));
    calls.push({ path, init });
    const url = new URL(path, 'http://candidate.invalid');
    if (url.pathname === '/auth/loginConfig') {
      assert.equal(url.searchParams.get('tenantId'), '201');
      assert.equal(url.searchParams.get('userClient'), 'fixture-web');
      return json({ code: 200, data: { enableCaptcha: options.captcha ?? false, enablePasswordEncryption: options.passwordEncryption ?? true } });
    }
    if (path === '/crypto/config') return json({ code: 200, data: {
      enabled: true, enableApiCrypto: true, enableDynamicKey: true, algorithm: options.algorithm || 'SM4',
      enableReplayProtection: true, excludePaths: ['/fixture/plain'], replayExcludePaths: ['/fixture/plain'],
    } });
    if (path === '/crypto/public-key') return json({ code: 200, data: { publicKey: publicPem } });
    if (path === '/auth/login') {
      const body = JSON.parse(init.body);
      assert.equal(body.authType, 'password'); assert.equal(body.appId, 'fixture-app');
      assert.equal(body.tenantId, '201'); assert.equal(body.userClient, 'fixture-web');
      assert.ok(init.headers['X-Timestamp']); assert.ok(init.headers['X-Nonce']);
      if (options.rejectLogin) return json({ code: 401, message: body.password, data: { token: 'must-not-leak' } });
      const account = accounts.get(body.username);
      assert.ok(account);
      assert.notEqual(body.password, account.password);
      assert.equal(unwrapRsa(body.password), account.password);
      const token = `fixture-token-${account.userId}`;
      sessions.set(token, { ...account, username: body.username });
      return json({ code: 200, data: { accessToken: token, forcePasswordChange: Boolean(options.forceChange), userInfo: {
        userId: account.userId, username: body.username, tenantId: options.wrongTenant ? '999' : account.tenantId,
        roleKeys: account.roleKeys, orgIds: ['301'], password: account.password,
      } } });
    }
    const token = init.headers.Authorization?.replace(/^Bearer /, '');
    const session = sessions.get(token);
    assert.ok(session);
    if (path === '/crypto/exchange') {
      assert.equal(init.headers['X-Session-Id'], token);
      session.key = Buffer.from(unwrapRsa(JSON.parse(init.body).encryptedKey), 'base64');
      assert.equal(session.key.length, 16);
      return json({ code: 200 });
    }
    if (options.transportError) throw new Error(`upstream ${token} ${session.password}`);
    if (options.redirect) return json({}, 302);
    if (path === '/fixture/plain') {
      assert.equal(init.headers['X-Nonce'], undefined);
      return json({ code: 200, data: { token, nested: `echo ${session.password}` } });
    }
    assert.ok(!nonces.has(init.headers['X-Nonce'])); nonces.add(init.headers['X-Nonce']);
    assert.ok(Number(init.headers['X-Timestamp']) > 0);
    const algorithm = options.algorithm || 'SM4';
    if (init.body) {
      const envelope = JSON.parse(init.body);
      assert.equal(envelope.algorithm, algorithm);
      const plain = JSON.parse(cipher(algorithm, session.key, Buffer.from(envelope.data, 'base64'), true));
      assert.deepEqual(plain, { fixture: 'opaque-test-value' });
    }
    return json({ algorithm, data: cipher(algorithm, session.key, Buffer.from(JSON.stringify({
      code: 200, data: { actor: session.userId, allowed: true },
    }))).toString('base64') });
  };
  const open = (username, options = {}) => createForgeCandidateAuthenticatedSession({
    fetchCandidate: makeFetch(options), credential: { username, password: accounts.get(username).password },
    loginContext: { tenantId: '201', userClient: 'fixture-web', appId: 'fixture-app' },
  });
  const a = await open('platform-fixture-a');
  const b = await open('platform-fixture-b');
  assert.deepEqual(a.identity, { userId: '101', tenantId: '201', roleKeys: ['FIXTURE_READER'], orgIds: ['301'] });
  assert.equal(b.identity.userId, '102');
  assert.notDeepEqual(sessions.get('fixture-token-101').key, sessions.get('fixture-token-102').key);
  const aResult = await a.request({ method: 'POST', path: '/fixture/check', body: { fixture: 'opaque-test-value' } });
  const bResult = await b.request({ method: 'GET', path: '/fixture/check' });
  assert.equal(aResult.body.data.actor, '101'); assert.equal(bResult.body.data.actor, '102');
  assert.equal(aResult.httpStatus, 200);
  await assert.rejects(a.request({ method: 'POST', path: '/fixture/check', multipart: {
    fields: {}, file: { fieldName: 'file', fileName: 'fixture.bin', contentType: 'application/octet-stream', bytesBase64: 'AQ==' },
  } }), { code: 'CANDIDATE_AUTH_MULTIPART_CRYPTO_UNSUPPORTED' });
  assert.deepEqual((await a.request({ method: 'GET', path: '/fixture/plain' })).body.data, { token: '[REDACTED]', nested: 'echo [REDACTED]' });
  const beforeDenied = calls.length;
  for (const path of ['https://outside.invalid/x', '//outside.invalid/x', '/a/../auth/login', '/%2foutside', '/x#fragment']) {
    await assert.rejects(a.request({ method: 'GET', path }), { code: 'CANDIDATE_AUTH_PATH_INVALID' });
  }
  await assert.rejects(a.request({ method: 'GET', path: '/auth/login' }), { code: 'CANDIDATE_AUTH_PATH_RESERVED' });
  await assert.rejects(a.request({ method: 'GET', path: '/fixture/check', headers: { Authorization: 'caller-token' } }), { code: 'CANDIDATE_AUTH_REQUEST_INVALID' });
  assert.equal(calls.length, beforeDenied);
  for (const [options, code] of [
    [{ captcha: true }, 'CANDIDATE_AUTH_CHALLENGE_REQUIRED'],
    [{ forceChange: true }, 'CANDIDATE_AUTH_PASSWORD_CHANGE_REQUIRED'],
    [{ rejectLogin: true }, 'CANDIDATE_AUTH_LOGIN_REJECTED'],
    [{ wrongTenant: true }, 'CANDIDATE_AUTH_IDENTITY_MISMATCH'],
  ]) await assert.rejects(open('platform-fixture-a', options), { code, status: 'blocked' });
  const aes = await open('platform-fixture-b', { algorithm: 'AES' });
  assert.equal((await aes.request({ method: 'POST', path: '/fixture/check', body: { fixture: 'opaque-test-value' } })).body.data.actor, '102');
  const badTransport = await open('platform-fixture-a', { transportError: true });
  await assert.rejects(badTransport.request({ method: 'GET', path: '/fixture/check' }), error => {
    assert.equal(error.code, 'CANDIDATE_AUTH_TRANSPORT_FAILED');
    assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes('fixture-password'));
    assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes('fixture-token'));
    return true;
  });
  const redirect = await open('platform-fixture-a', { redirect: true });
  await assert.rejects(redirect.request({ method: 'GET', path: '/fixture/check' }), { code: 'CANDIDATE_AUTH_REDIRECT_DENIED' });
  assert.ok(!JSON.stringify(a).includes('fixture-token'));
  assert.ok(!JSON.stringify(a).includes('fixture-password'));
  a.close();
  await assert.rejects(a.request({ method: 'GET', path: '/fixture/check' }), { code: 'CANDIDATE_AUTH_SESSION_CLOSED' });
  b.close(); aes.close(); badTransport.close(); redirect.close();
});

async function fileSession(handler) {
  const token = 'fixture-file-token';
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
      let result;
      const json = body => Response.json(body);
      if (pathname === '/auth/loginConfig') result = json({ code: 200, data: { enableCaptcha: false, enablePasswordEncryption: false } });
      else if (pathname === '/crypto/config') result = json({ code: 200, data: { enabled: true, enableApiCrypto: false, enableReplay: true } });
      else if (pathname === '/auth/login') {
        const body = JSON.parse(bytes);
        assert.equal(body.username, 'file-fixture'); assert.equal(body.password, 'fixture-file-password');
        result = json({ code: 200, data: { accessToken: token, userInfo: {
          userId: '101', tenantId: '201', username: 'file-fixture', roleKeys: ['FIXTURE_READER'], orgIds: ['301'],
        } } });
      } else {
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        assert.ok(request.headers['x-nonce']); assert.ok(Number(request.headers['x-timestamp']) > 0);
        result = await handler({ request, bytes, pathname, token });
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      for await (const chunk of result.body ?? []) response.write(chunk);
      response.end();
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = await createForgeCandidateAuthenticatedSession({
    fetchCandidate: (path, init) => {
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
      const target = new URL(path, origin); assert.equal(target.origin, origin);
      return fetch(target, init);
    },
    credential: { username: 'file-fixture', password: 'fixture-file-password' },
    loginContext: { tenantId: '201', userClient: 'fixture-web', appId: 'fixture-app' },
  });
  return { session, close: async () => {
    session.close(); server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

test('candidate auth uploads bounded multipart bytes with the existing identity and preserves JSON requests', async () => {
  const fileBytes = Buffer.from([0, 1, 128, 255, 65, 10]);
  const fixture = await fileSession(async ({ request, bytes, pathname, token }) => {
    if (pathname === '/fixture/upload') {
      assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/u);
      const form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type'] } }).formData();
      assert.deepEqual([...form.keys()], ['businessType', 'businessId', 'storageType', 'isPrivate', 'file']);
      assert.equal(form.get('businessType'), 'fixture'); assert.equal(form.get('businessId'), '123');
      assert.equal(form.get('storageType'), 'local'); assert.equal(form.get('isPrivate'), 'true');
      const file = form.get('file'); assert.equal(file.name, 'fixture.bin');
      assert.equal(file.type, 'application/octet-stream');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), fileBytes);
      return Response.json({ code: 200, data: { fileId: 'opaque-fixture-id', token } });
    }
    assert.equal(pathname, '/fixture/json'); assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(bytes), { unchanged: true });
    return Response.json({ code: 200, data: { unchanged: true } });
  });
  try {
    const multipart = { fields: { businessType: 'fixture', businessId: '123', storageType: 'local', isPrivate: 'true' },
      file: { fieldName: 'file', fileName: 'fixture.bin', contentType: 'application/octet-stream', bytesBase64: fileBytes.toString('base64') } };
    const result = await fixture.session.request({ method: 'POST', path: '/fixture/upload', multipart });
    assert.equal(result.httpStatus, 200);
    assert.deepEqual(result.body.data, { fileId: 'opaque-fixture-id', token: '[REDACTED]' });
    assert.deepEqual((await fixture.session.request({ method: 'POST', path: '/fixture/json', body: { unchanged: true } })).body,
      { code: 200, data: { unchanged: true } });
    for (const input of [
      { method: 'GET', multipart }, { method: 'POST', body: {}, multipart },
      { method: 'POST', multipart: { ...multipart, file: { ...multipart.file, fileName: '../fixture.bin' } } },
      { method: 'POST', multipart: { ...multipart, file: { ...multipart.file, bytesBase64: 'AA' } } },
      { method: 'POST', multipart: { ...multipart, file: { ...multipart.file, hostPath: '/etc/passwd' } } },
    ]) await assert.rejects(fixture.session.request({ path: '/fixture/upload', ...input }), { code: 'CANDIDATE_AUTH_REQUEST_INVALID' });
    await assert.rejects(fixture.session.request({ method: 'POST', path: '/fixture/upload', multipart: {
      ...multipart, file: { ...multipart.file, bytesBase64: Buffer.alloc(16385).toString('base64') },
    } }), { code: 'CANDIDATE_AUTH_REQUEST_TOO_LARGE' });
    assert.ok(!JSON.stringify(result).includes('fixture-file-token'));
    assert.ok(!JSON.stringify(fixture.session).includes('fixture-file-password'));
  } finally { await fixture.close(); }
});

test('candidate auth returns bounded binary responses without JSON coercion or credential headers', async () => {
  const bytes = Buffer.from([0, 255, 128, 80, 75, 3, 4]);
  const fixture = await fileSession(async ({ pathname, token }) => {
    if (pathname === '/fixture/too-large') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(512 * 1024)); controller.enqueue(new Uint8Array(512 * 1024));
      controller.enqueue(new Uint8Array(1)); controller.close();
    } }), { headers: { 'content-type': 'application/octet-stream' } });
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${token}.bin"`, 'set-cookie': `credential=${token}`, authorization: token } });
  });
  try {
    const result = await fixture.session.request({ method: 'POST', path: '/fixture/download', body: {}, responseType: 'binary' });
    assert.equal(result.httpStatus, 200); assert.deepEqual(result.bodyBytes, bytes);
    assert.equal(result.contentType, 'application/octet-stream');
    assert.equal(result.contentDisposition, 'attachment; filename="[REDACTED].bin"');
    assert.deepEqual(Object.keys(result).sort(), ['bodyBytes', 'contentDisposition', 'contentType', 'httpStatus']);
    assert.ok(!JSON.stringify(result).includes('fixture-file-token'));
    await assert.rejects(fixture.session.request({ method: 'GET', path: '/fixture/download' }), { code: 'CANDIDATE_AUTH_RESPONSE_INVALID' });
    await assert.rejects(fixture.session.request({ method: 'GET', path: '/fixture/too-large', responseType: 'binary' }), { code: 'CANDIDATE_AUTH_RESPONSE_TOO_LARGE' });
  } finally { await fixture.close(); }
});
