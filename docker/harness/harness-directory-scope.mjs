import { readFile } from 'node:fs/promises';
import http from 'node:http';

// Only user-facing mounts belong in this view. Never enumerate the container's
// credential, Docker, DSH state, cache, system or governance mounts.
const PROJECT_MOUNTS = Object.freeze([
  { path: '/workspace', name: '当前 Forge 代码', kind: 'code', default: true },
  { path: '/integration', name: '项目已集成代码', kind: 'integration' },
  { path: '/project-inputs', name: '本对话上传文件', kind: 'uploads' },
  { path: '/project-intake', name: '项目上传文件', kind: 'uploads' },
  { path: '/project-ftp-inputs', name: 'FTP 项目文件', kind: 'ftp' },
  { path: '/project-shared-inputs', name: '项目共享文件', kind: 'shared' },
]);

function unescapeMountPath(value) {
  return value.replace(/\\(040|011|012|134)/gu, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export function parseDirectoryMounts(source) {
  const mounts = new Map();
  for (const line of source.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const fields = left.split(' ');
    const filesystem = right.split(' ');
    if (fields.length < 6 || filesystem.length < 3) continue;
    const mountPath = unescapeMountPath(fields[4]);
    const options = fields[5].split(',');
    // A per-bind ro flag prevails even when its source filesystem is rw.
    mounts.set(mountPath, {
      path: mountPath,
      sourcePath: unescapeMountPath(fields[3]),
      writable: options.includes('rw') && !options.includes('ro') && !filesystem[2].split(',').includes('ro'),
    });
  }
  return mounts;
}

export function projectDirectoryScope(source) {
  const mounts = parseDirectoryMounts(source);
  const directories = PROJECT_MOUNTS.flatMap((entry) => {
    const mounted = mounts.get(entry.path);
    if (!mounted) return [];
    const canWrite = entry.default === true && mounted.writable;
    return [{
      ...entry,
      sourcePath: mounted.sourcePath,
      access: canWrite ? 'read-write' : 'read-only',
      writeRequiresTaskAuthorization: canWrite,
      scope: entry.default ? 'current-project' : 'project-files',
      exclusions: entry.default ? ['.git', '.forge-*', '平台保护文件及只读挂载'] : [],
      ...(entry.kind === 'ftp' ? { association: '本项目 FTP 目录，按实际挂载只读访问' } : {}),
    }];
  });
  return {
    ok: true,
    schemaVersion: 1,
    editable: false,
    defaultDirectory: directories.find((entry) => entry.default)?.path ?? null,
    directories,
    notice: '默认操作当前 Forge 代码。写入仍按本次任务授权执行；其他目录需要明确指定并已配置授权。目录权限由管理员维护，此处仅供查看。',
  };
}

export async function readManagedFileTargets({
  brokerUrl = process.env.FORGE_TASKSPACE_BROKER_URL,
  tokenFile = process.env.FORGE_TASKSPACE_TOKEN_FILE,
} = {}) {
  if (!brokerUrl || !tokenFile) return { status: 'not-configured', targets: [] };
  const target = new URL('/v1/actions', brokerUrl);
  if (target.protocol !== 'http:' || target.username || target.password) throw new Error('invalid broker');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!token || token.length > 4096 || /[\r\n]/u.test(token)) throw new Error('invalid broker token');
  const body = JSON.stringify({ action: 'managed-files', operation: 'targets' });
  const payload = await new Promise((resolve, reject) => {
    const request = http.request(target, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-forge-taskspace-token': token,
    } }, (response) => {
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 65536) { response.destroy(new Error('directory response too large')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('directory broker unavailable');
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) { reject(error); }
      });
    });
    // Total deadline, including a peer that keeps sending partial responses.
    const timeout = setTimeout(() => request.destroy(new Error('directory broker timed out')), 3000);
    request.on('close', () => clearTimeout(timeout));
    request.on('error', reject);
    request.end(body);
  });
  if (payload?.ok !== true || payload.result?.ok !== true || !Array.isArray(payload.result.targets)
    || payload.result.targets.length > 100) throw new Error('invalid directory response');
  return { status: 'available', targets: payload.result.targets };
}

export async function readHarnessDirectoryScope({ mountInfoPath = '/proc/self/mountinfo', managedTargetReader = readManagedFileTargets } = {}) {
  const result = projectDirectoryScope(await readFile(mountInfoPath, 'utf8'));
  try {
    const managed = await managedTargetReader();
    result.managedDirectoryStatus = managed.status;
    for (const target of managed.targets) {
      // Explicit projection: never echo a tool/config object wholesale into UI.
      if (target.transport !== 'local' || target.read !== true || typeof target.toolPath !== 'string'
        || typeof target.serverDirectory !== 'string' || typeof target.name !== 'string') continue;
      result.directories.push({ name: target.name, path: target.toolPath, sourcePath: target.serverDirectory,
        kind: 'managed-files', access: target.write === true ? 'read-write' : 'read-only',
        scope: 'explicit-task', writeRequiresTaskAuthorization: target.write === true,
        association: '当前服务器的受控文件目录；本次明确指定后方可操作，不改变默认 Forge 目录',
      });
    }
  } catch { result.managedDirectoryStatus = 'unavailable'; }
  return result;
}
