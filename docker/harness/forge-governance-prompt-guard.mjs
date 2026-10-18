import { DIRECT_DEVELOPMENT_PROMPT, usesDirectDevelopmentPrompt } from './forge-direct-development-prompt.mjs';

const REQUIRED_MARKERS = Object.freeze([
  'FORGE_HARNESS_GOVERNANCE_V1',
  'Invoke forge-task-contract, forge-task-router',
  'invoke forge-evidence-truth',
  'forbids claiming completed',
]);

const name = 'forge-governance-prompt-guard';
const inject = Object.freeze(['systemPrompt']);

function promptText(assembly) {
  return assembly.sections.map((section) => section.text).join('\n\n');
}

function assertGovernedAssembly(assembly, env = process.env) {
  if (usesDirectDevelopmentPrompt(env)) {
    const sections = assembly.sections.map((section) =>
      section.text.includes('FORGE_HARNESS_GOVERNANCE_V1')
        ? { ...section, text: DIRECT_DEVELOPMENT_PROMPT }
        : section);
    const resolved = { ...assembly, sections };
    const text = promptText(resolved);
    for (const marker of ['FORGE_DIRECT_DEVELOPMENT_V1', 'FORGE_EVIDENCE_TRUTH_V1']) {
      if (!text.includes(marker)) throw new Error(`forge-governance-prompt-guard: assembled prompt is missing ${marker}`);
    }
    return resolved;
  }
  const text = promptText(assembly);
  for (const marker of REQUIRED_MARKERS) {
    if (!text.includes(marker)) {
      throw new Error(`forge-governance-prompt-guard: assembled prompt is missing ${marker}`);
    }
  }
  return assembly;
}

function apply(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const resolved = await next();
    return assertGovernedAssembly(resolved);
  });
}

export { REQUIRED_MARKERS, apply, assertGovernedAssembly, inject, name };
