import http from 'node:http';
import path from 'node:path';
import { normalizeRuntimeVersion, resolveRuntimeVersion, RuntimeVersionError } from './harness-runtime-versions.mjs';

// Only the authenticated project Manager dispatches to operator-installed sockets.
// A bound task keeps its original socket even when the new-task catalog advances.
export async function routeRuntimeManagerRequest({ request, response, projectRoot, runtimeChannel,
  runtimeVersionId, readBody, readMetadata, managerToken, timeoutMs = 300_000 }) {
  const parsed = new URL(request.url, 'http://manager.invalid');
  const taskMatch = /^\/v1\/taskspaces\/([a-z0-9-]+)(?:\/|$)/u.exec(parsed.pathname);
  const creating = request.method === 'POST' && parsed.pathname === '/v1/taskspaces';
  const renewal = request.method === 'POST' && parsed.pathname === '/v1/execution-renewal-authority';
  if (!taskMatch && !creating && !renewal) return false;
  let body;
  if (creating || renewal) body = await readBody(request);
  const taskId = taskMatch?.[1] ?? body?.taskId;
  let metadata;
  if (typeof taskId === 'string' && /^[a-z0-9][a-z0-9-]{1,47}$/u.test(taskId)) {
    try { metadata = await readMetadata(taskId); } catch (error) {
      if (!creating || !['ENOENT', 'TASKSPACE_NOT_FOUND'].includes(error.code)) throw error;
    }
  }
  let version = metadata?.runtimeVersion;
  if (version) {
    version = normalizeRuntimeVersion(version, projectRoot);
    if (creating && (body.runtimeChannel !== version.channel || body.runtimeVersionId !== version.versionId)) {
      throw new RuntimeVersionError('RUNTIME_VERSION_CHANGED', '工作舱已绑定其他运行版本。', 409);
    }
  } else if (creating && body?.runtimeChannel !== undefined) {
    version = await resolveRuntimeVersion(path.join(projectRoot, 'ops', 'harness-runtime-versions.json'),
      body.runtimeChannel, body.runtimeVersionId);
  }
  if (!version) {
    if (runtimeChannel) throw new RuntimeVersionError('RUNTIME_VERSION_MISMATCH', '此服务仅接受对应版本的工作舱。', 409);
    return false;
  }
  if (runtimeChannel) {
    if (version.channel !== runtimeChannel || (runtimeVersionId && version.versionId !== runtimeVersionId)) {
      throw new RuntimeVersionError('RUNTIME_VERSION_MISMATCH', '工作舱与执行服务版本不一致。', 409);
    }
    request.runtimeResolvedVersion = version;
    return false;
  }
  const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
  await new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${managerToken}` };
    if (request.headers['x-request-id']) headers['x-request-id'] = request.headers['x-request-id'];
    if (request.headers['content-type']) headers['content-type'] = request.headers['content-type'];
    if (payload) headers['content-length'] = payload.length;
    else if (request.headers['content-length']) headers['content-length'] = request.headers['content-length'];
    const upstream = http.request({ socketPath: version.managerSocket, method: request.method,
      path: request.url, headers, timeout: timeoutMs }, incoming => {
      response.writeHead(incoming.statusCode, Object.fromEntries(Object.entries(incoming.headers)
        .filter(([key]) => ['content-type', 'content-length', 'cache-control'].includes(key))));
      incoming.on('error', reject);
      incoming.pipe(response);
      incoming.on('end', resolve);
    });
    // Preserve prepare cancellation across the extra Manager hop. Otherwise a
    // browser-disconnected request could still admit a new execution upstream.
    const cancel = () => { if (!response.writableEnded) upstream.destroy(); };
    const cleanup = () => {
      request.off('aborted', cancel);
      response.off('close', cancel);
    };
    request.once('aborted', cancel);
    response.once('close', cancel);
    upstream.once('close', cleanup);
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => reject(new RuntimeVersionError('RUNTIME_MANAGER_UNAVAILABLE', '所选版本的工作舱服务暂不可用。')));
    if (request.aborted || response.destroyed) upstream.destroy();
    else if (payload) upstream.end(payload);
    else request.pipe(upstream);
  });
  return true;
}
