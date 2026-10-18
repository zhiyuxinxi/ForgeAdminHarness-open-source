import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'forge-direct-glob-v1';
const replacements = [
  ['function buildGlobCommand(input) {', `// ${MARKER}: direct workers intentionally do not expose /proc/self/exe.
function forgeGlobSortOrder() {
\treturn process.env.FORGE_DEVELOPMENT_MODE === "direct" ? "path" : "modification-time";
}
function buildGlobCommand(input) {`],
  ['\t\t"--sort=modified",', '\t\tprocess.env.FORGE_DEVELOPMENT_MODE === "direct" ? "--sort=path" : "--sort=modified",'],
  ['instead of taken in modification-time order.', 'instead of taken in ${forgeGlobSortOrder()} order.'],
  ['"while a larger one keeps the modification-time-ordered head."', '`while a larger one keeps the ${forgeGlobSortOrder()}-ordered head.`'],
  ['comes back in modification-time order,', 'comes back in ${forgeGlobSortOrder()} order,'],
  ['paths in modification-time order`', 'paths in ${forgeGlobSortOrder()} order`'],
  ['paths come back in modification-time order;', 'paths come back in ${forgeGlobSortOrder()} order;'],
];

export function patchDirectGlob(source) {
  if (source.includes(MARKER)) {
    if (source.split(MARKER).length !== 2 || replacements.some(([, after]) => source.split(after).length !== 2)) {
      throw new Error('Incomplete direct glob patch');
    }
    return source;
  }
  if (replacements.some(([before]) => source.split(before).length !== 2)) throw new Error('Unsupported fs-search glob source');
  for (const [before, after] of replacements) source = source.replace(before, after);
  return source;
}

export function applyPatch(root) {
  const directory = resolve(root, '@deepseek-ai/dsh-tool-fs-search');
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh-tool-fs-search' || pkg.version !== '0.1.1-rc.2') {
    throw new Error('Unsupported fs-search package');
  }
  const file = resolve(directory, 'lib/index.js');
  const before = readFileSync(file, 'utf8');
  const after = patchDirectGlob(before);
  if (after !== before) writeFileSync(file, after);
  return { patch: MARKER, changed: after !== before };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node forge-direct-glob-patch.mjs NODE_MODULES_ROOT');
  console.log(JSON.stringify(applyPatch(process.argv[2])));
}
