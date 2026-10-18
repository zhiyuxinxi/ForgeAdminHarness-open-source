import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'forge-codex-overload-v1';
const BEFORE = '\tif (/\\b5\\d\\d\\b/.test(message)) return "SERVER";';
const AFTER = `\t// ${MARKER}: the observed Codex stream error omits an HTTP status.
\tif (message === "Codex error: Our servers are currently overloaded. Please try again later.") return "SERVER";
${BEFORE}`;

/** Reuse the existing finite SERVER retry policy for this exact transient error. */
export function patchCodexOverload(source) {
  if (source.includes(MARKER)) {
    if (source.split(MARKER).length !== 2 || source.split(AFTER).length !== 2
      || source.split(BEFORE).length !== 2) throw new Error('Incomplete Codex overload patch');
    return source;
  }
  if (source.split('function classifyPiAiError(message) {').length !== 2
    || source.split(BEFORE).length !== 2) throw new Error('Unsupported pi-ai error classifier');
  return source.replace(BEFORE, AFTER);
}

export function applyPatch(root) {
  const directory = resolve(root, '@deepseek-ai/dsh-llm-pi-ai');
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh-llm-pi-ai' || pkg.version !== '0.1.1-rc.2') {
    throw new Error('Unsupported pi-ai adapter package');
  }
  const file = resolve(directory, 'lib/index.js');
  const before = readFileSync(file, 'utf8');
  const after = patchCodexOverload(before);
  if (after !== before) writeFileSync(file, after);
  return { patch: MARKER, changed: after !== before };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node forge-codex-overload-patch.mjs NODE_MODULES_ROOT');
  console.log(JSON.stringify(applyPatch(process.argv[2])));
}
