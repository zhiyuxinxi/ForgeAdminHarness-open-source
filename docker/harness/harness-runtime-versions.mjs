import crypto from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_CHANNELS = Object.freeze({
  stable: { label: '稳定版', sourceBranch: '32.12' },
  enhanced: { label: '增强试验版', sourceBranch: 'main' },
});
export const RUNTIME_ENVIRONMENT_KEYS = Object.freeze([
  'FORGE_DEVELOPMENT_MODE', 'FORGE_SEMANTIC_INTENT_ENABLED',
  'FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED', 'FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED',
  'FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED', 'FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED',
  'FORGE_CHANGED_VERIFICATION_SUPPORTED', 'FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED',
  'FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED',
]);
export class RuntimeVersionError extends Error {
  constructor(code, message, status = 503) { super(message); this.code = code; this.status = status; }
}
const fail = (message) => { throw new RuntimeVersionError('RUNTIME_CATALOG_INVALID', message); };
export function validateRuntimeChannel(channel) {
  if (!Object.hasOwn(RUNTIME_CHANNELS, channel ?? '')) {
    throw new RuntimeVersionError('INVALID_RUNTIME_CHANNEL', '请选择稳定版或增强试验版。', 400);
  }
  return channel;
}
function protectedPath(value, root, description) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0$`]/u.test(value)) fail(`${description}无效。`);
  const relative = path.relative(root, value);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(`${description}必须位于本项目运行版本目录。`);
  return path.resolve(value);
}
export function normalizeRuntimeVersion(input, projectRoot) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('运行版本配置无效。');
  const channel = validateRuntimeChannel(input.channel);
  const definition = RUNTIME_CHANNELS[channel];
  const legacyStableBranch = channel === 'stable' && input.sourceBranch === 'codex/env-3212-ai';
  if ((!legacyStableBranch && input.sourceBranch !== definition.sourceBranch) || !/^[a-f0-9]{40}$/u.test(input.sourceCommit ?? '')) fail('运行版本源码分支或提交无效。');
  if (!/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64})$/u.test(input.harnessImage ?? '')) fail('Harness 镜像必须绑定不可变摘要。');
  const root = path.join(projectRoot, 'runtime-versions', channel);
  const skillBundleRoot = protectedPath(input.skillBundleRoot, root, 'Skills 路径');
  const managerSocket = protectedPath(input.managerSocket, root, '版本管理服务路径');
  if (input.brokerUrl !== `http://taskspace-broker-${channel}:3100`) fail('运行版本 Broker 必须属于当前项目及所选版本。');
  if (!/^[a-f0-9]{64}$/u.test(input.skillBundleSha256 ?? '')) fail('Skills 版本摘要无效。');
  if (!input.environment || typeof input.environment !== 'object' || Array.isArray(input.environment)) fail('运行版本配置缺少功能开关。');
  const environment = {};
  for (const key of Object.keys(input.environment).sort()) {
    const value = input.environment[key];
    if (!RUNTIME_ENVIRONMENT_KEYS.includes(key)) fail('运行版本包含不支持的环境配置。');
    const allowed = key === 'FORGE_DEVELOPMENT_MODE' ? ['direct', 'controlled'] : ['true', 'false'];
    if (!allowed.includes(value)) fail('运行版本功能开关无效。');
    environment[key] = value;
  }
  if (RUNTIME_ENVIRONMENT_KEYS.some(key => !Object.hasOwn(environment, key))) fail('运行版本功能开关不完整。');
  // Keep the spelling in frozen snapshots so existing version identities remain valid.
  const version = { channel, label: definition.label, sourceBranch: input.sourceBranch,
    sourceCommit: input.sourceCommit, harnessImage: input.harnessImage, skillBundleRoot,
    skillBundleSha256: input.skillBundleSha256, brokerUrl: input.brokerUrl, managerSocket, environment };
  const versionId = crypto.createHash('sha256').update(JSON.stringify(version)).digest('hex');
  if (input.versionId !== undefined && input.versionId !== versionId) fail('运行版本摘要不匹配。');
  return { ...version, versionId };
}
export function publicRuntimeVersion(version) {
  if (!version) return undefined;
  const { channel, label, sourceBranch, sourceCommit, harnessImage, versionId, skillBundleSha256 } = version;
  return { channel, label, sourceBranch, sourceCommit, harnessImage, versionId, skillBundleSha256, available: true };
}
export async function loadRuntimeVersions(catalogPath) {
  let info;
  try { info = await lstat(catalogPath); } catch (error) {
    if (error.code === 'ENOENT') return { defaultChannel: null, versions: [] };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) fail('运行版本目录文件无效。');
  let catalog;
  try { catalog = JSON.parse(await readFile(catalogPath, 'utf8')); } catch { fail('运行版本目录不可读取。'); }
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.versions) || catalog.versions.length > 2) fail('运行版本目录格式无效。');
  const projectRoot = path.dirname(path.dirname(path.resolve(catalogPath)));
  const versions = catalog.versions.map(value => normalizeRuntimeVersion(value, projectRoot));
  if (new Set(versions.map(value => value.channel)).size !== versions.length) fail('运行版本重复。');
  if (!versions.some(value => value.channel === catalog.defaultChannel)) fail('默认运行版本尚未安装。');
  return { defaultChannel: catalog.defaultChannel, versions };
}
export async function resolveRuntimeVersion(catalogPath, channel, expectedVersionId) {
  validateRuntimeChannel(channel);
  const { versions } = await loadRuntimeVersions(catalogPath);
  const version = versions.find(item => item.channel === channel);
  if (!version) throw new RuntimeVersionError('RUNTIME_VERSION_UNAVAILABLE', '所选版本尚未准备好，请联系平台管理员。');
  if (expectedVersionId !== undefined && expectedVersionId !== version.versionId) {
    throw new RuntimeVersionError('RUNTIME_VERSION_CHANGED', '所选运行版本已更新，请重新新建对话；原工作舱保留。', 409);
  }
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--catalog', '--channel', '--version-id'].includes(args[i]) || !args[i + 1] || options[args[i]]) fail('运行版本命令参数无效。');
      options[args[i]] = args[i + 1];
    }
    if (command !== 'resolve' || !options['--catalog']) fail('仅支持 resolve --catalog --channel。');
    const version = await resolveRuntimeVersion(options['--catalog'], options['--channel'], options['--version-id']);
    process.stdout.write(`${JSON.stringify(version)}\n`);
  } catch (error) { process.stderr.write(`${error.code ?? 'RUNTIME_VERSION_ERROR'}: ${error.message}\n`); process.exitCode = 1; }
}
