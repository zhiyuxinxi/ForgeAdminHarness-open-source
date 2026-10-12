import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'forge-prompt-admission-v1';
const BEFORE = '...summarize(session, agent?.status === "running"),';
const AFTER = `// ${MARKER}: accepted inbox work remains busy while native maintenance finishes.
\t\t\t\t...summarize(session, agent?.status === "running" || agent?.inbox?.hasPending === true),`;

/** Project accepted native inbox work through the existing session.list status. */
export function patchPromptAdmission(source) {
  if (source.includes(MARKER)) {
    if (source.split(MARKER).length !== 2 || source.split(AFTER).length !== 2 || source.includes(BEFORE)) {
      throw new Error('Incomplete prompt admission patch');
    }
    return source;
  }
  if (source.split(BEFORE).length !== 2) throw new Error('Unsupported upstream prompt admission projection');
  return source.replace(BEFORE, AFTER);
}

export function applyPatch(root) {
  const directory = resolve(root, '@deepseek-ai/dsh-host-apiproxy');
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh-host-apiproxy' || pkg.version !== '0.1.1-rc.2') {
    throw new Error('Unsupported Harness API proxy package');
  }
  const file = resolve(directory, 'lib/index.js');
  const before = readFileSync(file, 'utf8');
  const after = patchPromptAdmission(before);
  if (after !== before) writeFileSync(file, after);
  return { patch: MARKER, changed: after !== before };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node forge-prompt-admission-patch.mjs NODE_MODULES_ROOT');
  console.log(JSON.stringify(applyPatch(process.argv[2])));
}
