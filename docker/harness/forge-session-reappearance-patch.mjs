import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'forge-session-reappearance-v1';
const edits = [
  [
    '\t\t\thandleRemoved() {\n\t\t\t\tthis.removed = true;\n\t\t\t\tthis.notifier.markDirty();\n\t\t\t}',
    `\t\t\thandleRemoved() {
\t\t\t\tthis.removed = true;
\t\t\t\tthis.notifier.markDirty();
\t\t\t}
\t\t\t// ${MARKER}: a restored native identity releases its old removal state.
\t\t\thandlePresent() {
\t\t\t\tif (!this.removed) return;
\t\t\t\tthis.removed = false;
\t\t\t\tthis.notifier.markDirty();
\t\t\t}`,
  ],
  [
    '\t\t\t\t\t\t\tfor (const s of this.summaries) {\n\t\t\t\t\t\t\t\tconst session = this.sessions.get(s.sessionId);\n\t\t\t\t\t\t\t\tif (session === void 0) continue;\n\t\t\t\t\t\t\t\tsession.handleBlank(s.blank);',
    `\t\t\t\t\t\t\t// Only this fresh baseline can prove presence; later removals already won above.
\t\t\t\t\t\t\tconst presentIds = new Set(result.value.items.map((summary) => summary.sessionId));
\t\t\t\t\t\t\tfor (const s of this.summaries) {
\t\t\t\t\t\t\t\tconst session = this.sessions.get(s.sessionId);
\t\t\t\t\t\t\t\tif (session === void 0) continue;
\t\t\t\t\t\t\t\tif (presentIds.has(s.sessionId)) session.handlePresent();
\t\t\t\t\t\t\t\tsession.handleBlank(s.blank);`,
  ],
  [
    '\t\t\t\t\t\tthis.sessions.get(frame.sessionId)?.handleBlank(frame.blank);',
    '\t\t\t\t\t\tthis.sessions.get(frame.sessionId)?.handlePresent();\n\t\t\t\t\t\tthis.sessions.get(frame.sessionId)?.handleBlank(frame.blank);',
  ],
];

/** Restore the resident client Session only when native existence is confirmed. */
export function patchSessionReappearance(source) {
  if (source.includes(MARKER)) {
    if (source.split(MARKER).length !== 2
      || !edits.every(([, after]) => source.split(after).length === 2)) {
      throw new Error('Incomplete session reappearance patch');
    }
    return source;
  }
  for (const [before] of edits) {
    if (source.split(before).length !== 2) throw new Error('Unsupported upstream session reappearance anchors');
  }
  for (const [before, after] of edits) source = source.replace(before, after);
  return source;
}

export function applyPatch(root) {
  const directory = resolve(root, '@deepseek-ai/dsh-client-runtime');
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh-client-runtime' || pkg.version !== '0.1.1-rc.2') {
    throw new Error('Unsupported Harness client runtime package');
  }
  const file = resolve(directory, 'lib/client.js');
  const before = readFileSync(file, 'utf8');
  const after = patchSessionReappearance(before);
  if (after !== before) writeFileSync(file, after);
  return { patch: MARKER, changed: after !== before };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node forge-session-reappearance-patch.mjs NODE_MODULES_ROOT');
  console.log(JSON.stringify(applyPatch(process.argv[2])));
}
