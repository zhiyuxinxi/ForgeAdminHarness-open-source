// The host supplies only an access token and numbered, separately mounted stores.
import { lstat, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const REF = 'FORGE_CODEX_CLI_ACCESS_TOKEN';
const MAX_INPUT = 1024 * 1024;

export function validateRequest(input, now = Math.floor(Date.now() / 1000)) {
  if (!input || !['set', 'unset'].includes(input.action) || !Array.isArray(input.targets)
      || input.targets.length < 1 || input.targets.length > 1024
      || (input.configureProviders !== undefined && typeof input.configureProviders !== 'boolean')) throw new Error('invalid-request');
  if (input.action === 'set') {
    if (typeof input.token !== 'string' || input.token.length > 32768
        || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(input.token)) throw new Error('invalid-token');
    const claims = JSON.parse(Buffer.from(input.token.split('.')[1], 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(claims.exp) || claims.exp <= now + 60
        || typeof claims['https://api.openai.com/auth']?.chatgpt_account_id !== 'string'
        || !claims['https://api.openai.com/auth'].chatgpt_account_id.trim()) throw new Error('invalid-token');
  } else if (input.token !== undefined) throw new Error('invalid-request');
  input.targets.forEach((target, index) => {
    if (target.path !== `/targets/${index}` || !['home', 'seed'].includes(target.kind)) {
      throw new Error('invalid-target');
    }
  });
  return input;
}

async function assertPrivateFile(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid()))) {
      throw new Error('unsafe-credentials');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function syncStore(target, input, native) {
    const { Context, LocalCredentialProvider, credentialRef, parseCredentialsDocument } = native;
    let changed = 0;
    const filename = `${target.path}/${target.kind === 'seed' ? 'credentials.yaml' : '.credentials.yaml'}`;
    await assertPrivateFile(filename);
    if (target.kind === 'seed') {
      let text;
      try { text = await readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (text !== undefined) {
        const doc = parseCredentialsDocument(text, filename);
        if (doc.records.size || [...doc.refs.keys()].some((key) => key !== REF)) throw new Error('seed-not-exclusive');
      }
    }
    const ctx = new Context();
    try {
      if (input.configureProviders && target.kind === 'home') {
        const path = `${target.path}/settings.yaml`;
        // Settings are not secrets by contract and may start with mode 0644.
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('unsafe-settings');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await ctx.plugin(native.FileSettingsProvider, { path, watch: false });
        const ns = native.settingsNamespace('llm-pi-ai');
        ctx.settings.register(ns, native.Config);
        const descriptor = ctx.settings.describe().find((item) => item.ns === ns);
        const profile = descriptor.user?.providers?.['openai-codex'] ?? {};
        if ((profile.baseURL !== undefined && profile.baseURL !== 'https://chatgpt.com/backend-api')
            || profile.api !== undefined || profile.apiKey !== undefined
            || (profile.apiKeyEnv !== undefined && profile.apiKeyEnv !== REF)
            || Object.keys(profile.headers ?? {}).some((name) => /authorization|api[-_]key/i.test(name))) {
          throw new Error('codex-provider-conflict');
        }
        const ops = [
          { op: 'set', path: ['providers', 'openai-codex', 'apiKeyEnv'], value: REF },
          { op: 'set', path: ['providers', 'openai-codex', 'transport'], value: 'sse' },
        ].filter((op) => profile[op.path[2]] !== op.value);
        if (ops.length) {
          await ctx.settings.mutate(ns, ops, descriptor.revision);
          changed++;
        }
      }
      await ctx.plugin(LocalCredentialProvider, { path: filename, watch: false });
      const ref = credentialRef(REF);
      const previous = await ctx.credentials.resolve(ref);
      if (input.action === 'set' && previous?.value !== input.token) {
        await ctx.credentials.set(ref, input.token);
        changed++;
      } else if (input.action === 'unset' && previous !== undefined) {
        await ctx.credentials.unset(ref);
        changed++;
      }
    } finally {
      await ctx.fiber.dispose();
    }
    return changed;
}

export async function syncCredentials(input, native) {
  validateRequest(input);
  if (process.env[REF]) throw new Error('environment-shadows-reference');
  let changed = 0;
  for (const target of input.targets) {
    changed += await syncStore(target, input, native);
  }
  return { state: 'synced', changed, targets: input.targets.length };
}

async function main() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > MAX_INPUT) throw new Error('input-too-large');
  }
  // Resolve shipped native modules from the existing image, not the bind mount.
  const require = createRequire('/opt/forge-harness-runtime/package.json');
  const input = JSON.parse(text);
  validateRequest(input);
  const [cordis, credentials, local] = await Promise.all([
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-credentials-local',
  ].map((name) => import(pathToFileURL(require.resolve(name)).href)));
  const native = { ...cordis, ...credentials, ...local };
  if (input.configureProviders) {
    for (const name of ['@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-settings-file', '@deepseek-ai/dsh-llm-pi-ai']) {
      Object.assign(native, await import(pathToFileURL(require.resolve(name)).href));
    }
  }
  const result = await syncCredentials(input, native);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const states = new Set(['codex-provider-conflict', 'seed-not-exclusive', 'environment-shadows-reference']);
    const state = states.has(error.message) ? error.message : 'credential-sync-failed';
    process.stdout.write(`${JSON.stringify({ state })}\n`);
    process.exitCode = 2;
  });
}
