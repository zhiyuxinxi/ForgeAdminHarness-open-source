import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describeGovernedTool } from './forge-phase-budget-guard.mjs';
import { generateCapabilityInventory, verifyCapabilityInventoryFixtures } from './forge-capability-inventory.mjs';

const RECEIPT_SCHEMA = 'forge-agent-preset-prompt-contract/v1';
const EXPECTED_PRESETS = Object.freeze(['standard']);
const REQUIRED_MARKERS = Object.freeze([
  'FORGE_HARNESS_GOVERNANCE_V1',
  'Invoke forge-task-contract, forge-task-router',
  'Arbitrary shell and direct Git commands fail closed',
  'invoke forge-evidence-truth',
  'forbids claiming completed',
]);

const name = 'forge-agent-preset-prompt-probe';
const inject = Object.freeze(['agentPresets', 'systemPrompt', 'tools']);

function fail(message) {
  throw new Error(`forge-agent-preset-prompt-probe: ${message}`);
}

function sameList(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function inspectPreset(ctx, preset, includeInventory = false) {
  const scope = await ctx.agentPresets.standingKeyFor(preset);
  const assembly = await ctx.systemPrompt.assemble({ scope });
  const prompt = assembly.sections.map((section) => section.text).join('\n\n');
  const missingMarkers = REQUIRED_MARKERS.filter((marker) => !prompt.includes(marker));
  const completeSections = assembly.sections.filter((section) => section.complete === true);
  const modelFacingTools = assembly.tools.map((tool) => tool.name);
  const skillAccessMode = modelFacingTools.includes('skill') ? 'native-skill-tool' : null;
  if (missingMarkers.length > 0) fail(`${preset} final assembly is missing ${missingMarkers.join(', ')}`);
  if (completeSections.length > 0) fail(`${preset} final assembly unexpectedly contains a complete section`);
  if (!skillAccessMode) {
    fail(`${preset} final assembly does not expose governed Skill access; tools=${modelFacingTools.join(',')}`);
  }
  if (preset === 'standard') {
    const requiredTools = ['bash', 'edit', 'glob', 'grep', 'read', 'skill', 'write'];
    const missingTools = requiredTools.filter((tool) => !modelFacingTools.includes(tool));
    if (missingTools.length > 0) fail(`standard final assembly is missing typed protocol tools: ${missingTools.join(',')}`);
  }
  return {
    id: preset,
    sectionNames: assembly.sections.map((section) => section.name),
    governanceMarkersPresent: true,
    skillAccessMode,
    modelFacingTools,
    ...(includeInventory ? { registeredTools: modelFacingTools.map((name) => {
      const definition = ctx.tools.get(name, scope);
      if (!definition?.output?.schema) fail(`${preset} tool ${name} has no actual output schema`);
      return { name, parameters: definition.parameters, outputSchema: definition.output.schema,
        policy: describeGovernedTool(name) };
    }) } : {}),
  };
}

async function writeCapabilityInventory(registeredTools, destination) {
  const catalogPath = process.env.FORGE_CAPABILITY_CATALOG_PATH ?? '/run/forge-image-build/skills.catalog.json';
  const runtimeRoot = '/opt/forge-harness-runtime/node_modules/@deepseek-ai';
  const sourcePaths = [
    ['/usr/local/lib/forge-capability-inventory.mjs', 'forge-capability-inventory.mjs'],
    ['/usr/local/lib/validate-skill-bundle.mjs', 'validate-skill-bundle.mjs'],
    ['/usr/local/lib/forge-phase-budget-guard.mjs', 'forge-phase-budget-guard.mjs'],
    ['/usr/local/lib/forge-prepare-task.mjs', 'forge-prepare-task.mjs'],
    ['/usr/local/lib/forge-typed-file-removal.mjs', 'forge-typed-file-removal.mjs'],
    [catalogPath, 'skills.catalog.json'],
    [`${runtimeRoot}/dsh/config/agent-presets/standard/agent.cordis.yml`, 'runtime/standard/agent.cordis.yml'],
    [`${runtimeRoot}/dsh-tools/lib/index.js`, 'runtime/dsh-tools/lib/index.js'],
  ];
  for (const name of (await readdir(runtimeRoot)).filter(name => name.startsWith('dsh-tool-')).sort()) {
    sourcePaths.push([`${runtimeRoot}/${name}/lib/index.js`, `runtime/${name}/lib/index.js`]);
  }
  const sources = [];
  for (const [file, relative] of sourcePaths) sources.push({ path: relative,
    sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const input = { registeredTools, catalog, sources };
  const inventory = generateCapabilityInventory(input);
  const fixtures = verifyCapabilityInventoryFixtures({ ...input, inventory });
  await writeFile(destination, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return { inventorySha256: inventory.inventorySha256, tools: inventory.tools.length,
    admittedTools: inventory.tools.filter(tool => tool.policy.admitted).length,
    skills: inventory.skills.length, sources: sources.length, fixtures };
}

async function apply(ctx) {
  const receiptPath = process.env.FORGE_AGENT_PRESET_PROMPT_RECEIPT;
  if (!receiptPath) fail('FORGE_AGENT_PRESET_PROMPT_RECEIPT is required');
  const discovered = (await ctx.agentPresets.list())
    .map((preset) => preset.id)
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (!sameList(discovered, EXPECTED_PRESETS)) {
    fail(`runtime roster must be exactly ${EXPECTED_PRESETS.join(', ')}, found ${discovered.join(', ')}`);
  }
  if (ctx.agentPresets.defaultId !== 'standard') {
    fail(`runtime default must be standard, found ${ctx.agentPresets.defaultId}`);
  }
  if (ctx.agentPresets.authorable) fail('runtime unexpectedly exposes an authorable preset root');
  const receipt = {
    ok: true,
    schemaVersion: RECEIPT_SCHEMA,
    defaultPreset: ctx.agentPresets.defaultId,
    authorablePresetRoot: false,
    presets: [],
  };
  const inventoryPath = process.env.FORGE_CAPABILITY_INVENTORY_RECEIPT;
  for (const preset of EXPECTED_PRESETS) receipt.presets.push(await inspectPreset(ctx, preset, Boolean(inventoryPath)));
  if (inventoryPath) {
    receipt.capabilityInventory = await writeCapabilityInventory(receipt.presets[0].registeredTools, inventoryPath);
    delete receipt.presets[0].registeredTools;
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  process.exit(0);
}

export { EXPECTED_PRESETS, REQUIRED_MARKERS, apply, inspectPreset, name, inject };
