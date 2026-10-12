import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'forge-job-completion-wakeup-v1';

/** Keep explicit wake limits while allowing an ordinary task's completed jobs to continue. */
export function patchJobCompletionWakeup(source) {
  const edits = [
    ['maxConsecutiveWakes: z.number().min(1).default(3)',
      'maxConsecutiveWakes: z.number().min(1)'],
    ['const wakeBudget = config.maxConsecutiveWakes ?? 3;',
      `// ${MARKER}: an omitted heuristic limit must not strand a completed job.
\tconst wakeBudget = config.maxConsecutiveWakes ?? Infinity;`],
    ['if (!Number.isSafeInteger(wakeBudget)) throw new Error(',
      'if (config.maxConsecutiveWakes != null && !Number.isSafeInteger(wakeBudget)) throw new Error('],
  ];
  if (source.includes(MARKER)) {
    if (!edits.every(([, after]) => source.split(after).length === 2)
      || edits.some(([before]) => source.includes(before))) {
      throw new Error('Incomplete job completion wakeup patch');
    }
    return source;
  }
  for (const [before] of edits) {
    if (source.split(before).length !== 2) throw new Error('Unsupported upstream job completion controller');
  }
  for (const [before, after] of edits) source = source.replace(before, after);
  return source;
}

export function applyPatch(root) {
  const directory = resolve(root, '@deepseek-ai/dsh-tool-jobs');
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh-tool-jobs' || pkg.version !== '0.1.1-rc.2') {
    throw new Error('Unsupported Harness job controller package');
  }
  const file = resolve(directory, 'lib/index.js');
  const before = readFileSync(file, 'utf8');
  const after = patchJobCompletionWakeup(before);
  if (after !== before) writeFileSync(file, after);
  return { patch: MARKER, changed: after !== before };
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node forge-job-completion-wakeup-patch.mjs NODE_MODULES_ROOT');
  console.log(JSON.stringify(applyPatch(process.argv[2])));
}
