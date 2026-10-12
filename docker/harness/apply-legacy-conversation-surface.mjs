import crypto from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE_SOURCE_HASHES = Object.freeze({
  'conversation-gateway.mjs': '3ed9f991f00605ce08fa37dece2859ba3b76dd8e4155c7d22ce7af7e677dcf4c',
  'harness-tcp-proxy.mjs': '01a5c7cc1b51eb35c58e74ae51bb4fc705b9ba8f0079b744266f12342b906321',
});

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Pinned legacy overlay anchor is missing or ambiguous: ${label}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

export function patchConversationGateway(source) {
  let value = source;
  value = replaceOnce(value,
    `  tokenHash,\n  validateIdempotencyKey,`,
    `  tokenHash,\n  validateConversationId,\n  validateIdempotencyKey,`,
    'gateway import');

  value = replaceOnce(value, `  const openConversation = async (context, conversationId, requestId) => {
    const conversation = await ownedConversation(context.user, conversationId, 'conversation:open-own');
    const scopedManager = await resolveManager(conversation.projectSlug);
    let managed;
    try {
      if (conversation.status === 'provisioning' || conversation.status === 'failed') {
        managed = await scopedManager.create({
          taskId: conversation.taskId,
          actorId: context.user.username,
          conversationId: conversation.id,
          accessMode: 'conversation',
        });
      } else {
        managed = await scopedManager.start(conversation.taskId);
      }
    } catch (error) {
      const known = managerError(error);
      await audit({ projectSlug: conversation.projectSlug, actor: context.user.username, action: 'conversation.open', targetType: 'conversation', targetId: conversation.id, result: 'failed', code: known.code, requestId });
      throw known;
    }
    const updated = await store.mutate((state) => {
      const entry = state.conversations.find((item) => item.id === conversation.id);
      entry.status = 'active';
      entry.port = managed.taskspace.harnessPort;
      entry.updatedAt = isoNow(clock);
      entry.lastOpenedAt = entry.updatedAt;
      entry.lastError = null;
      return clone(entry);
    });
    await audit({ projectSlug: conversation.projectSlug, actor: context.user.username, action: 'conversation.open', targetType: 'conversation', targetId: conversation.id, result: 'success', requestId });
    return { conversation: updated, url: \`${'${parsedOrigin.protocol}'}//${'${bindAddress}'}:${'${updated.port}'}/\` };
  };

  const stopConversation = async (context, conversationId, requestId) => {
    const conversation = await ownedConversation(context.user, conversationId, 'conversation:stop-own');
    const scopedManager = await resolveManager(conversation.projectSlug);
    try {
      await scopedManager.stop(conversation.taskId);
    } catch (error) {
      throw managerError(error);
    }
    const updated = await store.mutate((state) => {
      const entry = state.conversations.find((item) => item.id === conversation.id);
      entry.status = 'stopped';
      entry.updatedAt = isoNow(clock);
      entry.lastError = null;
      return clone(entry);
    });
    await audit({ projectSlug: conversation.projectSlug, actor: context.user.username, action: 'conversation.stop', targetType: 'conversation', targetId: conversation.id, result: 'success', requestId });
    return updated;
  };`, `  const openConversation = async (context, conversationId, requestId) => {
    const conversation = await ownedConversation(context.user, conversationId, 'conversation:open-own');
    const scopedManager = await resolveManager(conversation.projectSlug);
    let managed;
    try {
      if (conversation.status === 'provisioning' || conversation.status === 'failed') {
        managed = await scopedManager.create({
          taskId: conversation.taskId,
          actorId: context.user.username,
          conversationId: conversation.id,
          accessMode: 'conversation',
        });
      } else {
        managed = await scopedManager.start(conversation.taskId);
      }
    } catch (error) {
      const known = managerError(error);
      await audit({ projectSlug: conversation.projectSlug, actor: context.user.username, action: 'conversation.open', targetType: 'conversation', targetId: conversation.id, result: 'failed', code: known.code, requestId });
      throw known;
    }
    const updated = await store.mutate((state) => {
      const entry = state.conversations.find((item) => item.id === conversation.id);
      for (const item of state.conversations) {
        if (item.taskId !== conversation.taskId
          || item.projectSlug !== conversation.projectSlug
          || item.ownerUserId !== conversation.ownerUserId) continue;
        item.status = 'active';
        item.port = managed.taskspace.harnessPort;
        item.lastError = null;
      }
      entry.updatedAt = isoNow(clock);
      entry.lastOpenedAt = entry.updatedAt;
      return clone(entry);
    });
    await audit({ projectSlug: conversation.projectSlug, actor: context.user.username, action: 'conversation.open', targetType: 'conversation', targetId: conversation.id, result: 'success', requestId });
    const parameters = new URLSearchParams();
    if (conversation.conversationKind === 'legacy-session') {
      validateInput(validateConversationId, conversation.legacySessionId, 'INVALID_LEGACY_SESSION_ID');
      parameters.set('forgeSession', conversation.legacySessionId);
    }
    const query = parameters.size === 0 ? '' : \`?${'${parameters}'}\`;
    return { conversation: updated, url: \`${'${parsedOrigin.protocol}'}//${'${bindAddress}'}:${'${updated.port}'}/${'${query}'}\` };
  };

  const stopConversation = async (context, conversationId, requestId) => {
    const conversation = await ownedConversation(context.user, conversationId, 'conversation:stop-own');
    const scopedManager = await resolveManager(conversation.projectSlug);
    try {
      await scopedManager.stop(conversation.taskId);
    } catch (error) {
      throw managerError(error);
    }
    const updated = await store.mutate((state) => {
      const entry = state.conversations.find((item) => item.id === conversation.id);
      entry.updatedAt = isoNow(clock);
      const related = [];
      for (const item of state.conversations) {
        if (item.taskId !== conversation.taskId
          || item.projectSlug !== conversation.projectSlug
          || item.ownerUserId !== conversation.ownerUserId) continue;
        item.status = 'stopped';
        item.lastError = null;
        if (item.hiddenFromList !== true) related.push(clone(item));
      }
      return { conversation: clone(entry), related };
    });
    await audit({ projectSlug: conversation.projectSlug, actor: context.user.username, action: 'conversation.stop', targetType: 'conversation', targetId: conversation.id, result: 'success', requestId });
    return updated;
  };`, 'gateway lifecycle group');

  value = replaceOnce(value,
    `              entry.projectSlug === project.slug && entry.ownerUserId === context.user.id\n            )`,
    `              entry.projectSlug === project.slug\n              && entry.ownerUserId === context.user.id\n              && entry.hiddenFromList !== true\n            )`,
    'gateway project count');
  value = replaceOnce(value,
    `          .filter((entry) => entry.ownerUserId === context.user.id && entry.projectSlug === scopedProjectSlug)`,
    `          .filter((entry) => (\n            entry.ownerUserId === context.user.id\n            && entry.projectSlug === scopedProjectSlug\n            && entry.hiddenFromList !== true\n          ))`,
    'gateway visible list');

  value = replaceOnce(value, `      const conversationMatch = /^\\/forge-gateway\\/api\\/conversations\\/([0-9a-f-]+)\\/(open|stop|rename)$/.exec(parsed.pathname);
      if (conversationMatch !== null && request.method === 'POST') {
        const context = await requireAuthentication(request);
        requireCsrf(request, context);
        const [, conversationId, action] = conversationMatch;`, `      const conversationMatch = /^\\/forge-gateway\\/api\\/conversations\\/([^/]+)\\/(open|stop|rename)$/.exec(parsed.pathname);
      if (conversationMatch !== null && request.method === 'POST') {
        const context = await requireAuthentication(request);
        requireCsrf(request, context);
        let decodedConversationId;
        try {
          decodedConversationId = decodeURIComponent(conversationMatch[1]);
        } catch {
          throw new GatewayError('INVALID_CONVERSATION_ID', '对话标识不合法。', 400);
        }
        const conversationId = validateInput(validateConversationId, decodedConversationId, 'INVALID_CONVERSATION_ID');
        const action = conversationMatch[2];`, 'gateway readable conversation route');
  value = replaceOnce(value, `        if (action === 'stop') {
          const conversation = await stopConversation(context, conversationId, requestId);
          json(response, 200, { conversation: publicConversation(conversation) });
          return;
        }`, `        if (action === 'stop') {
          const result = await stopConversation(context, conversationId, requestId);
          json(response, 200, {
            conversation: publicConversation(result.conversation),
            relatedConversations: result.related.map(publicConversation),
          });
          return;
        }`, 'gateway stop response');

  value = replaceOnce(value, `      const conversation = await store.read((state) => state.conversations.find((entry) => (
        entry.taskId === taskId && entry.projectSlug === requestedProjectSlug
      )));
      if (conversation === undefined || conversation.status !== 'active' || !Number.isInteger(conversation.port)) {
        throw new GatewayError('CONVERSATION_UNAVAILABLE', '对话未运行。', 409);
      }
      const expectedAuthority = \`${'${bindAddress}'}:${'${conversation.port}'}\`;`, `      const conversations = await store.read((state) => state.conversations.filter((entry) => (
        entry.taskId === taskId && entry.projectSlug === requestedProjectSlug
      )));
      const activeConversation = conversations.find((entry) => (
        entry.status === 'active' && Number.isInteger(entry.port)
      ));
      if (activeConversation === undefined) {
        throw new GatewayError('CONVERSATION_UNAVAILABLE', '对话未运行。', 409);
      }
      const expectedAuthority = \`${'${bindAddress}'}:${'${activeConversation.port}'}\`;`, 'gateway grouped authorization lookup');
  value = replaceOnce(value, `      const projectAllowed = await store.read((state) => canEnterProject(state, context.user, requestedProjectSlug));
      if (!can(context.user.role, 'conversation:open-own')
        || !projectAllowed
        || conversation.ownerUserId !== context.user.id) {`, `      const projectAllowed = await store.read((state) => canEnterProject(state, context.user, requestedProjectSlug));
      const ownedActiveConversation = conversations.find((entry) => (
        entry.ownerUserId === context.user.id
        && entry.status === 'active'
        && entry.port === activeConversation.port
      ));
      if (!can(context.user.role, 'conversation:open-own')
        || !projectAllowed
        || ownedActiveConversation === undefined) {`, 'gateway grouped authorization owner');
  return value;
}

export function patchHarnessProxy(source) {
  let value = source;
  const startupRetryHelper = `const UPSTREAM_STARTUP_RETRY_MS = 30_000;
const UPSTREAM_STARTUP_RETRY_DELAY_MS = 250;

function proxyHarnessRequestWithStartupRetry(request, response, options, body) {
  const retryable = body === undefined
    && (request.method === 'GET' || request.method === 'HEAD')
    && request.headers['content-length'] === undefined
    && request.headers['transfer-encoding'] === undefined;
  const startedAt = Date.now();
  let activeRequest;
  let retryTimer;
  let cancelled = false;

  const cancel = () => {
    cancelled = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    activeRequest?.destroy();
  };
  request.once('aborted', cancel);
  response.once('close', () => {
    if (!response.writableEnded) cancel();
  });

  const attempt = () => {
    retryTimer = undefined;
    if (cancelled || response.writableEnded || response.destroyed) return;
    activeRequest = http.request(
      options,
      (upstreamResponse) => {
        activeRequest = undefined;
        pipeUpstreamResponse(request, response, upstreamResponse);
      },
    );
    activeRequest.once('error', (error) => {
      activeRequest = undefined;
      if (retryable
        && error.code === 'ECONNREFUSED'
        && Date.now() - startedAt < UPSTREAM_STARTUP_RETRY_MS
        && !cancelled
        && !response.headersSent) {
        retryTimer = setTimeout(attempt, UPSTREAM_STARTUP_RETRY_DELAY_MS);
        return;
      }
      writeProxyError(response, error);
    });
    if (retryable) activeRequest.end();
    else if (body === undefined) request.pipe(activeRequest);
    else activeRequest.end(body);
  };

  attempt();
}

`;
  value = replaceOnce(value,
    'function acceptsGzip(request) {',
    `${startupRetryHelper}function acceptsGzip(request) {`,
    'proxy startup retry constants and helper');
  value = replaceOnce(value,
    `      const upstreamRequest = http.request(
        {
          host: targetHost,
          port: targetPort,
          method: request.method,
          path: request.url,
          headers,
        },
        (upstreamResponse) => pipeUpstreamResponse(request, response, upstreamResponse),
      );
      upstreamRequest.on('error', (error) => writeProxyError(response, error));
      request.on('aborted', () => upstreamRequest.destroy());
      if (body === undefined) request.pipe(upstreamRequest);
      else upstreamRequest.end(body);`,
    `      proxyHarnessRequestWithStartupRetry(request, response, {
        host: targetHost,
        port: targetPort,
        method: request.method,
        path: request.url,
        headers,
      }, body);`,
    'proxy startup retry forwarding');
  const selectionScript = `// Recovered legacy sessions share one immutable archive TaskSpace. The Gateway
// supplies an authenticated, validated session id in the TaskSpace URL; persist
// it before the pinned Harness bundle restores its current-session snapshot.
const legacySessionSelectionCompatibilityScript = \`<script data-forge-harness-compat="legacy-session-selection">
(() => {
  const parameters = new URLSearchParams(globalThis.location.search);
  const sessionId = parameters.get('forgeSession');
  if (sessionId === null || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) return;
  try {
    globalThis.localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }));
    parameters.delete('forgeSession');
    const query = parameters.toString();
    const nextUrl = globalThis.location.pathname
      + (query.length === 0 ? '' : '?' + query)
      + globalThis.location.hash;
    globalThis.history.replaceState(globalThis.history.state, '', nextUrl);
  } catch {}
})();
</script>\`;

`;
  value = replaceOnce(value,
    `const projectFileUploadCompatibilityScript = \`<script defer data-forge-harness-compat="project-file-upload" src="${'${PROJECT_FILE_UPLOAD_ASSET_PATH}'}"></script>\`;\n`,
    `${selectionScript}const projectFileUploadCompatibilityScript = \`<script defer data-forge-harness-compat="project-file-upload" src="${'${PROJECT_FILE_UPLOAD_ASSET_PATH}'}"></script>\`;\n`,
    'proxy legacy session script');
  value = replaceOnce(value,
    '      const compatibilityScripts = `${insecureHttpCompatibilityScript}${historyAutoLoadCompatibilityScript}${projectFileUploadCompatibilityScript}`;',
    '      const compatibilityScripts = `${legacySessionSelectionCompatibilityScript}${insecureHttpCompatibilityScript}${historyAutoLoadCompatibilityScript}${projectFileUploadCompatibilityScript}`;',
    'proxy compatibility order');
  return value;
}

async function patchFile(root, filename, transformer) {
  const target = path.join(root, filename);
  const information = await lstat(target);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error(`Pinned legacy overlay target is unsafe: ${filename}`);
  }
  const source = await readFile(target, 'utf8');
  if (digest(source) !== BASE_SOURCE_HASHES[filename]) {
    throw new Error(`Pinned legacy overlay source hash changed: ${filename}`);
  }
  const updated = transformer(source);
  const temporary = `${target}.legacy-surface-${process.pid}`;
  await writeFile(temporary, updated, { encoding: 'utf8', mode: information.mode & 0o777 });
  await rename(temporary, target);
}

async function main() {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error('Usage: apply-legacy-conversation-surface.mjs --root <absolute-lib-root>');
  }
  await patchFile(root, 'conversation-gateway.mjs', patchConversationGateway);
  await patchFile(root, 'harness-tcp-proxy.mjs', patchHarnessProxy);
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
