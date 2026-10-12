import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deliveryQuery, deliveryResponse } from './delivery-center-http.mjs';
import { createDeliveryCenterPool, DeliveryCenterStore } from './delivery-center-store.mjs';
import { readDeliveryDatabaseConfig } from './delivery-center-config.mjs';

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const READ_ERROR_MESSAGES = Object.freeze({
  DELIVERY_SCOPE_CHANGED: '资料已更新，请刷新列表后再导出。',
  DELIVERY_REVISION_REQUIRED: '该迭代有多个已记录修订，请选择具体版本。',
  DELIVERY_RESULT_LIMIT: '资料超过本次查询上限，请选择具体菜单或缩小范围。',
});

export async function prepareDeliverySocket(socketPath, { timeoutMs = 1000 } = {}) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)
    || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('DELIVERY_SOCKET_INVALID');
  const parentPath = path.dirname(socketPath);
  const privateParent = (info) => info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077n) === 0n
    && (typeof process.getuid !== 'function' || info.uid === BigInt(process.getuid()));
  const parent = await lstat(parentPath, { bigint: true });
  if (!privateParent(parent)) throw new Error('DELIVERY_SOCKET_PARENT_INVALID');
  let previous;
  try { previous = await lstat(socketPath, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!previous.isSocket() || previous.isSymbolicLink()) throw new Error('DELIVERY_SOCKET_INVALID');

  // Only an explicit refusal proves this private node has no listening service.
  await new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); probe.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('DELIVERY_SOCKET_PROBE_TIMEOUT')), timeoutMs);
    probe.once('connect', () => finish(new Error('DELIVERY_SOCKET_ACTIVE')));
    probe.once('error', (error) => finish(error.code === 'ECONNREFUSED' ? null : error));
  });
  const currentParent = await lstat(parentPath, { bigint: true });
  const current = await lstat(socketPath, { bigint: true });
  if (!privateParent(currentParent) || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino
    || !current.isSocket() || current.isSymbolicLink() || current.dev !== previous.dev || current.ino !== previous.ino) {
    throw new Error('DELIVERY_SOCKET_CHANGED');
  }
  await unlink(socketPath);
}

/** Narrow read client: Gateway holds a private socket, never database credentials. */
export function createDeliveryCenterClient({ socketPath, timeoutMs = 20000 }) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) throw new Error('DELIVERY_SOCKET_INVALID');
  async function read(route, project, filters = {}) {
    const query = new URLSearchParams();
    if (project) query.set('project', project);
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath, method: 'GET', path: `/v1/${route}${query.size ? `?${query}` : ''}` }, (response) => {
        const chunks = []; let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) { request.destroy(Object.assign(new Error('Delivery response too large.'), { code: 'DELIVERY_RESULT_LIMIT' })); return; }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (response.statusCode !== 200) { reject(Object.assign(new Error(READ_ERROR_MESSAGES[result.code] ?? 'Delivery service rejected the request.'), { code: result.code, status: response.statusCode })); return; }
            resolve(result);
          } catch { reject(new Error('DELIVERY_RESPONSE_INVALID')); }
        });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error('DELIVERY_TIMEOUT')));
      request.on('error', reject); request.end();
    });
  }
  return {
    listProjects: async () => (await read('projects')).items,
    overview: (project, filters) => read('overview', project, filters),
    listView: (project, filters) => read('views', project, filters),
    exportView: (project, filters) => read('export-view-rows', project, filters),
    listMenus: async (project, filters) => (await read('menus', project, filters)).items,
    ...Object.fromEntries(['Requirements', 'Batches', 'Stages', 'Releases', 'Artifacts', 'Assets'].map((name) => [
      `list${name}`, (project, filters) => read(name.toLowerCase(), project, filters),
    ])),
    getRequirement: async (project, id, filters) => (await read(`requirements/${encodeURIComponent(id)}`, project, filters)).item,
    getAsset: async (project, id, filters) => (await read(`assets/${encodeURIComponent(id)}`, project, filters)).item,
    getStage: async (project, id, filters) => (await read(`stages/${encodeURIComponent(id)}`, project, filters)).item,
    getRelease: async (project, id) => (await read(`releases/${encodeURIComponent(id)}`, project)).item,
    exportRequirements: async (project, filters) => (await read('export-rows', project, filters)).items,
  };
}

export function createDeliveryReadServer({ store, projectSlug = null }) {
  if (projectSlug !== null && !/^[a-z][a-z0-9-]{2,31}$/.test(projectSlug)) throw new Error('DELIVERY_PROJECT_SCOPE_INVALID');
  return http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    try {
      if (request.method !== 'GET') { response.writeHead(405); response.end(JSON.stringify({ code: 'DELIVERY_READ_ONLY' })); return; }
      const url = new URL(request.url, 'http://local');
      if (!url.pathname.startsWith('/v1/')) { response.writeHead(404); response.end(JSON.stringify({ code: 'DELIVERY_NOT_FOUND' })); return; }
      if (projectSlug && url.pathname !== '/v1/projects' && url.searchParams.get('project') !== projectSlug) {
        response.writeHead(404); response.end(JSON.stringify({ code: 'DELIVERY_NOT_FOUND' })); return;
      }
      let body;
      if (url.pathname === '/v1/export-view-rows') {
        const { project, filters } = deliveryQuery(url.searchParams);
        body = await store.exportView(project, filters);
      } else if (url.pathname === '/v1/export-rows') {
        const { project, filters } = deliveryQuery(url.searchParams);
        body = { items: await store.exportRequirements(project, filters) };
      } else {
        url.pathname = url.pathname.replace('/v1/', '/forge-gateway/api/delivery/');
        if (url.pathname.endsWith('/export')) { response.writeHead(404); response.end(JSON.stringify({ code: 'DELIVERY_NOT_FOUND' })); return; }
        ({ body } = await deliveryResponse({ method: 'GET', url, store }));
        if (projectSlug && url.pathname === '/forge-gateway/api/delivery/projects') body = { items: body.items.filter((item) => item.slug === projectSlug) };
      }
      const bytes = Buffer.from(JSON.stringify(body));
      if (bytes.length > MAX_RESPONSE_BYTES) { response.writeHead(413); response.end(JSON.stringify({ code: 'DELIVERY_RESULT_LIMIT' })); return; }
      response.writeHead(200, { 'content-length': bytes.length }); response.end(bytes);
    } catch (error) {
      // Never forward driver errors, SQL, paths or connection credentials.
      const known = typeof error.code === 'string' && error.code.startsWith('DELIVERY_');
      response.writeHead(known && Number.isInteger(error.status) ? error.status : 503);
      response.end(JSON.stringify({ code: known ? error.code : 'DELIVERY_UNAVAILABLE' }));
    }
  });
}

async function main() {
  const socketPath = process.env.DELIVERY_CENTER_SOCKET;
  if (!socketPath || !path.isAbsolute(socketPath)) throw new Error('DELIVERY_SOCKET_INVALID');
  const config = await readDeliveryDatabaseConfig(process.env.DELIVERY_CENTER_DATABASE_CONFIG_FILE);
  const store = new DeliveryCenterStore({ pool: createDeliveryCenterPool(config) });
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await prepareDeliverySocket(socketPath);
  const server = createDeliveryReadServer({ store, projectSlug: process.env.DELIVERY_CENTER_PROJECT || null });
  server.on('error', () => { process.stderr.write('DELIVERY_READ_SERVICE_FAILED\n'); process.exitCode = 1; void store.close(); });
  server.listen(socketPath, () => { void chmod(socketPath, 0o600); });
  const stop = () => { server.close(() => { void store.close().finally(() => process.exit(0)); }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('DELIVERY_READ_SERVICE_CONFIGURATION_INVALID\n'); process.exitCode = 1; });
}
