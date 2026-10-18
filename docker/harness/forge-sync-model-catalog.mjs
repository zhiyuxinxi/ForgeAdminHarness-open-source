// Refresh the shipped Codex catalog without changing saved model selections.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function mergeCodexModels(previous, shipped) {
  const updates = new Map(shipped.filter((m) => m.id.startsWith('gpt-6-')).map((m) => [m.id, m]));
  const result = (previous?.length ? previous : shipped).map((model) => {
    const next = updates.get(model.id) ?? model;
    updates.delete(model.id);
    return next;
  });
  return [...result, ...updates.values()];
}

export async function syncModelCatalog(home, template = '/usr/local/share/forge-harness-settings.yaml') {
  const require = createRequire('/opt/forge-harness-runtime/package.json');
  const load = (name) => import(pathToFileURL(require.resolve(name)).href);
  const [{ Context }, { settingsNamespace }, { FileSettingsProvider }, { Config }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-settings'),
    load('@deepseek-ai/dsh-settings-file'), load('@deepseek-ai/dsh-llm-pi-ai'),
  ]);
  const shipped = require('yaml').parse(await readFile(template, 'utf8'))['llm-pi-ai'].providers['openai-codex'].models;
  const ctx = new Context();
  try {
    await ctx.plugin(FileSettingsProvider, { path: resolve(home, 'settings.yaml'), watch: false });
    const ns = settingsNamespace('llm-pi-ai');
    ctx.settings.register(ns, Config);
    const state = ctx.settings.describe().find((entry) => entry.ns === ns);
    const previous = state.user?.providers?.['openai-codex']?.models;
    const next = mergeCodexModels(previous, shipped);
    if (JSON.stringify(previous) === JSON.stringify(next)) return { changed: false };
    await ctx.settings.mutate(ns, [{ op: 'set', path: ['providers', 'openai-codex', 'models'], value: next }], state.revision);
    return { changed: true };
  } finally {
    await ctx.fiber.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await syncModelCatalog(process.argv[2] ?? process.env.DSH_HOME ?? '/home/node/.dsh', process.argv[3]);
}
