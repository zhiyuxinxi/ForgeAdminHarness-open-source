import { posix } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isForgeDirectDevelopmentContract } from './forge-task-execution-contract.mjs';

// The authenticated tool invocation owns the policy. Model arguments cannot
// promote a read-only task; parallel calls retain their own execution context.
const toolPolicy = new AsyncLocalStorage();
export const withDirectToolPolicy = (policy, execute) => toolPolicy.run(Object.freeze({ ...policy }), execute);
export const currentDirectToolPolicy = () => toolPolicy.getStore() ?? { mode: 'read-only', workspaceRoot: '/workspace' };

// A deployment choice plus a signed server contract, never a model argument.
export function directDevelopmentEnabled(contract, env = process.env) {
  return env.FORGE_DEVELOPMENT_MODE === 'direct' && isForgeDirectDevelopmentContract(contract);
}

export function directDevelopmentPath(value, workspaceRoot = '/workspace') {
  if (typeof value !== 'string' || value !== value.normalize('NFC') || /[\\:\u0000-\u001f\u007f]/u.test(value)) return null;
  let relative = value;
  if (relative.startsWith(`${workspaceRoot}/`)) relative = relative.slice(workspaceRoot.length + 1);
  else if (relative.startsWith('./')) relative = relative.slice(2);
  if (!relative || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) return null;
  const segments = relative.split('/');
  if (segments.some(part => /^(?:\.git|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.forge-delivery|\.forge-platform)$/iu.test(part))
    || /^(?:AGENTS\.md|PROJECT_CONTEXT\.md|project\.manifest\.json)$/iu.test(relative)
    || /^(?:ops|governance|\.agents)(?:\/|$)/iu.test(relative)
    || /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.gitconfig|credentials(?:\..*)?|id_rsa|id_ed25519)$/iu.test(posix.basename(relative))
    || /\.(?:pem|key|p12|pfx)$/iu.test(relative)) return null;
  return relative;
}

export function directDevelopmentContextCurrent(context, now = Date.now()) {
  return directDevelopmentEnabled(context?.contract)
    && context.authorityClass === 'production-task-writer' && context.testOnly === false
    && ['workspace-write', 'git-checkpoint', 'release'].includes(context.actionCeiling)
    && context.actionCeiling === context.contract.actionCeiling
    && typeof context.expiresAt === 'string' && Date.parse(context.expiresAt) > now;
}
