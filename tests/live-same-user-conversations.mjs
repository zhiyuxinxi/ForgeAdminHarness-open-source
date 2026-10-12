import assert from 'node:assert/strict';
import http from 'node:http';

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

const origin = new URL(required('FORGE_GATEWAY_ORIGIN'));
const account = {
  username: required('FORGE_GATEWAY_USER'),
  temporaryPassword: required('FORGE_GATEWAY_PASSWORD'),
  newPassword: required('FORGE_GATEWAY_NEW_PASSWORD'),
};
const keepConversations = process.env.FORGE_GATEWAY_KEEP_CONVERSATIONS === 'true';

function cookies(setCookie) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

function request(target, method, pathname, {
  cookie,
  csrf,
  body,
  idempotencyKey,
  accept = 'application/json',
} = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = { accept };
    if (method !== 'GET' && method !== 'HEAD') headers.origin = origin.origin;
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-forge-csrf-token'] = csrf;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    const operation = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method,
      path: pathname,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const value = raw.length > 0 && String(response.headers['content-type'] ?? '').includes('application/json')
          ? JSON.parse(raw)
          : raw;
        resolve({ status: response.statusCode, headers: response.headers, value });
      });
    });
    operation.on('error', reject);
    operation.end(payload);
  });
}

async function signInAndChangePassword() {
  const context = await request(origin, 'GET', '/forge-gateway/api/auth-context');
  assert.equal(context.status, 200, JSON.stringify(context.value));
  const login = await request(origin, 'POST', '/forge-gateway/api/login', {
    cookie: cookies(context.headers['set-cookie']),
    csrf: context.value.csrfToken,
    body: { username: account.username, password: account.temporaryPassword },
  });
  assert.equal(login.status, 200, JSON.stringify(login.value));
  const firstCookie = cookies(login.headers['set-cookie']);
  const firstSession = await request(origin, 'GET', '/forge-gateway/api/session', { cookie: firstCookie });
  assert.equal(firstSession.status, 200, JSON.stringify(firstSession.value));
  assert.equal(firstSession.value.user.mustChangePassword, true);
  const changed = await request(origin, 'POST', '/forge-gateway/api/change-password', {
    cookie: firstCookie,
    csrf: firstSession.value.csrfToken,
    body: {
      currentPassword: account.temporaryPassword,
      newPassword: account.newPassword,
      confirmPassword: account.newPassword,
    },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.value));
  const cookie = cookies(changed.headers['set-cookie']);
  const session = await request(origin, 'GET', '/forge-gateway/api/session', { cookie });
  assert.equal(session.status, 200, JSON.stringify(session.value));
  assert.equal(session.value.user.mustChangePassword, false);
  return { cookie, csrf: session.value.csrfToken, user: session.value.user };
}

async function createConversation(auth, suffix) {
  const key = `same-user-${suffix}-${Date.now()}`;
  const response = await request(origin, 'POST', '/forge-gateway/api/conversations', {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotencyKey: key,
    body: { title: `同一账号独立对话 ${suffix}` },
  });
  assert.equal(response.status, 201, JSON.stringify(response.value));
  const replay = await request(origin, 'POST', '/forge-gateway/api/conversations', {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotencyKey: key,
    body: { title: `同一账号独立对话 ${suffix}` },
  });
  assert.equal(replay.status, 201, JSON.stringify(replay.value));
  assert.equal(replay.value.conversation.id, response.value.conversation.id);
  return response.value.conversation;
}

async function stop(auth, conversation) {
  const response = await request(
    origin,
    'POST',
    `/forge-gateway/api/conversations/${conversation.id}/stop`,
    { cookie: auth.cookie, csrf: auth.csrf, body: {} },
  );
  assert.equal(response.status, 200, JSON.stringify(response.value));
}

let auth;
let conversations = [];
let result;
try {
  auth = await signInAndChangePassword();
  conversations = await Promise.all([
    createConversation(auth, 'A'),
    createConversation(auth, 'B'),
  ]);
  assert.notEqual(conversations[0].id, conversations[1].id);
  assert.notEqual(conversations[0].taskId, conversations[1].taskId);

  const listed = await request(origin, 'GET', '/forge-gateway/api/conversations', { cookie: auth.cookie });
  assert.equal(listed.status, 200, JSON.stringify(listed.value));
  assert.deepEqual(
    new Set(listed.value.items.map((entry) => entry.id)),
    new Set(conversations.map((entry) => entry.id)),
  );

  const opened = await Promise.all(conversations.map((conversation) => request(
    origin,
    'POST',
    `/forge-gateway/api/conversations/${conversation.id}/open`,
    { cookie: auth.cookie, csrf: auth.csrf, body: {} },
  )));
  assert.ok(opened.every((entry) => entry.status === 200), JSON.stringify(opened.map((entry) => entry.value)));
  const taskOrigins = opened.map((entry) => new URL(entry.value.url));
  assert.notEqual(taskOrigins[0].port, taskOrigins[1].port);
  const ownerAccess = await Promise.all(taskOrigins.map((target) => request(
    target,
    'GET',
    '/',
    { cookie: auth.cookie, accept: 'text/html' },
  )));
  assert.ok(ownerAccess.every((entry) => entry.status === 200));
  const anonymous = await Promise.all(taskOrigins.map((target) => request(target, 'GET', '/')));
  assert.ok(anonymous.every((entry) => entry.status === 401));

  result = {
    ok: true,
    checks: {
      oneAccountOwnsTwoConversations: true,
      idempotentCreatePerConversation: true,
      distinctConversationIds: true,
      distinctTaskspaceIds: true,
      distinctPorts: true,
      ownerCanOpenBoth: true,
      anonymousCannotOpenEither: true,
    },
    user: auth.user.username,
    taskspaces: conversations.map((conversation, index) => ({
      conversationId: conversation.id,
      taskId: conversation.taskId,
      port: taskOrigins[index].port,
    })),
    keptActive: keepConversations,
  };
} finally {
  if (!keepConversations && auth) {
    await Promise.allSettled(conversations.map((conversation) => stop(auth, conversation)));
  }
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
