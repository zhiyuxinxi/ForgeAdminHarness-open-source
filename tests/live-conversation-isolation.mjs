import assert from 'node:assert/strict';
import http from 'node:http';

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

const gatewayOrigin = new URL(required('FORGE_GATEWAY_ORIGIN'));
const accounts = [
  {
    username: required('FORGE_GATEWAY_USER_A'),
    temporaryPassword: required('FORGE_GATEWAY_PASSWORD_A'),
    newPassword: required('FORGE_GATEWAY_NEW_PASSWORD_A'),
    title: '隔离验收 A',
    key: `live-a-${Date.now()}`,
  },
  {
    username: required('FORGE_GATEWAY_USER_B'),
    temporaryPassword: required('FORGE_GATEWAY_PASSWORD_B'),
    newPassword: required('FORGE_GATEWAY_NEW_PASSWORD_B'),
    title: '隔离验收 B',
    key: `live-b-${Date.now()}`,
  },
];

function cookieHeader(setCookie) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

function request(origin, method, pathname, {
  cookie = undefined,
  csrf = undefined,
  body = undefined,
  idempotencyKey = undefined,
  accept = 'application/json',
} = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = { accept };
    if (method !== 'GET' && method !== 'HEAD') headers.origin = origin.origin;
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-forge-csrf-token'] = csrf;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    if (encoded) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = encoded.length;
    }
    const req = http.request({
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port,
      method,
      path: pathname,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let value = raw;
        if (String(response.headers['content-type'] ?? '').includes('application/json') && raw.length > 0) {
          value = JSON.parse(raw);
        }
        resolve({ status: response.statusCode, headers: response.headers, value });
      });
    });
    req.on('error', reject);
    req.end(encoded);
  });
}

async function signIn(account) {
  const context = await request(gatewayOrigin, 'GET', '/forge-gateway/api/auth-context');
  assert.equal(context.status, 200, JSON.stringify(context.value));
  const preauthCookie = cookieHeader(context.headers['set-cookie']);
  assert.ok(preauthCookie);
  const login = await request(gatewayOrigin, 'POST', '/forge-gateway/api/login', {
    cookie: preauthCookie,
    csrf: context.value.csrfToken,
    body: { username: account.username, password: account.temporaryPassword },
  });
  assert.equal(login.status, 200, JSON.stringify(login.value));
  const firstCookie = cookieHeader(login.headers['set-cookie']);
  const firstSession = await request(gatewayOrigin, 'GET', '/forge-gateway/api/session', { cookie: firstCookie });
  assert.equal(firstSession.status, 200, JSON.stringify(firstSession.value));
  assert.equal(firstSession.value.user.mustChangePassword, true);

  const changed = await request(gatewayOrigin, 'POST', '/forge-gateway/api/change-password', {
    cookie: firstCookie,
    csrf: firstSession.value.csrfToken,
    body: {
      currentPassword: account.temporaryPassword,
      newPassword: account.newPassword,
      confirmPassword: account.newPassword,
    },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.value));
  const cookie = cookieHeader(changed.headers['set-cookie']);
  const session = await request(gatewayOrigin, 'GET', '/forge-gateway/api/session', { cookie });
  assert.equal(session.status, 200, JSON.stringify(session.value));
  assert.equal(session.value.user.mustChangePassword, false);
  return { cookie, csrf: session.value.csrfToken, user: session.value.user };
}

async function createConversation(account, auth) {
  const created = await request(gatewayOrigin, 'POST', '/forge-gateway/api/conversations', {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotencyKey: account.key,
    body: { title: account.title },
  });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  const replay = await request(gatewayOrigin, 'POST', '/forge-gateway/api/conversations', {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotencyKey: account.key,
    body: { title: account.title },
  });
  assert.equal(replay.status, 201, JSON.stringify(replay.value));
  assert.equal(replay.value.conversation.id, created.value.conversation.id);
  return created.value.conversation;
}

async function stopConversation(auth, conversation) {
  if (conversation === undefined) return;
  const stopped = await request(
    gatewayOrigin,
    'POST',
    `/forge-gateway/api/conversations/${conversation.id}/stop`,
    { cookie: auth.cookie, csrf: auth.csrf, body: {} },
  );
  assert.equal(stopped.status, 200, JSON.stringify(stopped.value));
}

const auth = [];
const conversations = [];
let result;
try {
  auth.push(await signIn(accounts[0]), await signIn(accounts[1]));
  conversations.push(
    await createConversation(accounts[0], auth[0]),
    await createConversation(accounts[1], auth[1]),
  );

  const lists = await Promise.all(auth.map((entry) => request(
    gatewayOrigin,
    'GET',
    '/forge-gateway/api/conversations',
    { cookie: entry.cookie },
  )));
  assert.deepEqual(lists[0].value.items.map((entry) => entry.id), [conversations[0].id]);
  assert.deepEqual(lists[1].value.items.map((entry) => entry.id), [conversations[1].id]);

  const crossOpen = await request(
    gatewayOrigin,
    'POST',
    `/forge-gateway/api/conversations/${conversations[1].id}/open`,
    { cookie: auth[0].cookie, csrf: auth[0].csrf, body: {} },
  );
  assert.equal(crossOpen.status, 403, JSON.stringify(crossOpen.value));

  const opened = await Promise.all(conversations.map((conversation, index) => request(
    gatewayOrigin,
    'POST',
    `/forge-gateway/api/conversations/${conversation.id}/open`,
    { cookie: auth[index].cookie, csrf: auth[index].csrf, body: {} },
  )));
  assert.equal(opened[0].status, 200, JSON.stringify(opened[0].value));
  assert.equal(opened[1].status, 200, JSON.stringify(opened[1].value));

  const taskOrigins = opened.map((entry) => new URL(entry.value.url));
  const ownerAccess = await Promise.all(taskOrigins.map((origin, index) => request(
    origin,
    'GET',
    '/',
    { cookie: auth[index].cookie, accept: 'text/html' },
  )));
  assert.ok(ownerAccess.every((entry) => entry.status === 200), JSON.stringify(ownerAccess.map((entry) => entry.status)));

  const noSession = await request(taskOrigins[0], 'GET', '/', { accept: 'application/json' });
  const otherUser = await request(taskOrigins[0], 'GET', '/', {
    cookie: auth[1].cookie,
    accept: 'application/json',
  });
  assert.equal(noSession.status, 401);
  assert.equal(otherUser.status, 403);

  result = {
    ok: true,
    checks: {
      independentLoginSessions: true,
      forcedPasswordChange: true,
      idempotentConversationCreate: true,
      ownerScopedLists: true,
      crossConversationOpenDenied: true,
      directTaskspaceWithoutSessionDenied: true,
      directTaskspaceOtherOwnerDenied: true,
      ownerTaskspaceAccessAllowed: true,
    },
    taskspaces: conversations.map((conversation, index) => ({
      user: auth[index].user.username,
      conversationId: conversation.id,
      taskId: conversation.taskId,
      port: taskOrigins[index].port,
    })),
  };
} finally {
  await Promise.allSettled(conversations.map((conversation, index) => stopConversation(auth[index], conversation)));
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
