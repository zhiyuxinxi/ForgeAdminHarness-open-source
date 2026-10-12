import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'forge-codex-sse-v1';
const BEFORE_HEAD = `            let idx = buffer.indexOf("\\n\\n");
            while (idx !== -1) {
                const chunk = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);`;
const AFTER_HEAD = `            // ${MARKER}: retain split CRLF bytes until the complete SSE boundary arrives.
            let boundary = /\\r?\\n\\r?\\n/.exec(buffer);
            while (boundary !== null) {
                const chunk = buffer.slice(0, boundary.index);
                buffer = buffer.slice(boundary.index + boundary[0].length);`;
const BEFORE_TAIL = '                idx = buffer.indexOf("\\n\\n");';
const AFTER_TAIL = '                boundary = /\\r?\\n\\r?\\n/.exec(buffer);';

/** Preserve the pinned provider's decoder, abort handling and terminal-response validation. */
export function patchCodexSse(source) {
  if (source.includes(MARKER)) {
    if (source.split(MARKER).length !== 2 || source.split(AFTER_HEAD).length !== 2
        || source.split(AFTER_TAIL).length !== 2 || source.includes(BEFORE_HEAD) || source.includes(BEFORE_TAIL)) {
      throw new Error('Incomplete Codex SSE patch');
    }
    return source;
  }
  if (source.split(BEFORE_HEAD).length !== 2 || source.split(BEFORE_TAIL).length !== 2) {
    throw new Error('Unsupported upstream Codex SSE parser');
  }
  return source.replace(BEFORE_HEAD, AFTER_HEAD).replace(BEFORE_TAIL, AFTER_TAIL);
}

export function applyPatch(root) {
  const directory = resolve(root, '@earendil-works/pi-ai');
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@earendil-works/pi-ai' || pkg.version !== '0.82.1') {
    throw new Error('Unsupported Codex provider package');
  }
  const file = resolve(directory, 'dist/api/openai-codex-responses.js');
  const before = readFileSync(file, 'utf8');
  const after = patchCodexSse(before);
  if (after !== before) writeFileSync(file, after);
  return { patch: MARKER, changed: after !== before };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node forge-codex-sse-patch.mjs NODE_MODULES_ROOT');
  console.log(JSON.stringify(applyPatch(process.argv[2])));
}
