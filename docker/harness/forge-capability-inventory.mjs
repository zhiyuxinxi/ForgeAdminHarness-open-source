import { createHash } from 'node:crypto';

const VERSION = 'forge-capability-inventory/v1';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const CHECKERS = Object.freeze([
  { id: 'inventory-declared-tool', negativeFixture: 'unknown-or-denied-tool' },
  { id: 'inventory-skill-effect', negativeFixture: 'changed-skill-side-effect' },
  { id: 'inventory-tool-schema', negativeFixture: 'changed-native-parameter-schema' },
  { id: 'inventory-source-binding', negativeFixture: 'changed-source-digest' },
]);

function projectTools(tools) {
  return tools.map(tool => ({ name: tool.name, parameters: tool.parameters, outputSchema: tool.outputSchema,
    policy: tool.policy })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function collectCapabilityInventoryIssues({ inventory, catalog, registeredTools, sources } = {}) {
  const issues = [];
  const add = (code, location, message) => issues.push({ code, location, message });
  if (!inventory || inventory.schemaVersion !== 1 || inventory.generatorVersion !== VERSION
    || !Array.isArray(inventory.tools) || !Array.isArray(inventory.skills) || !Array.isArray(inventory.sources)) {
    return [{ code: 'inventory-format', location: 'capabilityInventory', message: 'A generated capability inventory is required.' }];
  }
  const { inventorySha256, ...core } = inventory;
  if (digest(core) !== inventorySha256) add('inventory-integrity', 'capabilityInventory', 'Generated inventory digest differs.');
  const tools = new Map(inventory.tools.map(tool => [tool.name, tool]));
  const skills = new Map(inventory.skills.map(skill => [skill.name, skill]));
  if (tools.size !== inventory.tools.length || skills.size !== inventory.skills.length) add('inventory-format', 'capabilityInventory', 'Duplicate tool or Skill identity.');
  for (const entry of catalog?.skills ?? []) {
    const recorded = skills.get(entry.name);
    if (!recorded || recorded.sideEffectClass !== entry.sideEffectClass) add('inventory-skill-effect', entry.name, 'Skill sideEffectClass differs from the generated source-bound inventory.');
    const declared = entry.requiredTools ?? [];
    if (!Array.isArray(declared) || !same(declared, recorded?.requiredTools)
      || declared.some(name => typeof name !== 'string' || !name || !tools.get(name)?.policy?.admitted)) {
      add('inventory-declared-tool', entry.name, 'requiredTools names a missing or policy-denied tool, or is not a string array.');
    }
  }
  if ((catalog?.skills?.length ?? 0) !== skills.size) add('inventory-skill-effect', 'catalog', 'Catalog Skill roster differs from generated inventory.');
  if (registeredTools && !same(projectTools(registeredTools), inventory.tools)) add('inventory-tool-schema', 'tools', 'Actual registered input/output schema or guarded effect policy differs.');
  if (sources && !same(sources, inventory.sources)) add('inventory-source-binding', 'sources', 'Actual generator, checker or runtime source digest differs.');
  if (!same(inventory.checkers?.map(({ id, version, positiveFixture, negativeFixture }) => ({ id, version, positiveFixture, negativeFixture })),
    CHECKERS.map(checker => ({ ...checker, version: VERSION, positiveFixture: 'current-generated-input' })))) {
    add('inventory-checker-fixture', 'checkers', 'Every inventory checker must retain its positive and negative fixture binding.');
  }
  const checkerSource = inventory.sources.find(row => row.path === 'forge-capability-inventory.mjs');
  if (!checkerSource || inventory.checkers?.some(checker => checker.sourceSha256 !== checkerSource.sha256)) {
    add('inventory-checker-fixture', 'checkers', 'Checker source version must match the generated source digest.');
  }
  return issues;
}

export function generateCapabilityInventory({ registeredTools, catalog, sources }) {
  if (!Array.isArray(registeredTools) || !registeredTools.length || !Array.isArray(catalog?.skills) || !catalog.skills.length
    || !Array.isArray(sources) || !sources.length || sources.some(row => !row.path || !/^[a-f0-9]{64}$/u.test(row.sha256))) {
    throw new Error('Inventory requires actual registered tools, catalog and source digests.');
  }
  const tools = projectTools(registeredTools);
  if (tools.some(tool => !tool.name || !tool.parameters || !tool.outputSchema || typeof tool.policy?.admitted !== 'boolean')) {
    throw new Error('Inventory requires actual input/output schemas and explicit guarded effect policy.');
  }
  const core = { schemaVersion: 1, generatorVersion: VERSION, tools,
    skills: catalog.skills.map(entry => ({ name: entry.name, sideEffectClass: entry.sideEffectClass,
      requiredTools: entry.requiredTools ?? [] })).sort((a, b) => a.name.localeCompare(b.name, 'en')),
    sources, checkers: CHECKERS.map(checker => ({ ...checker, version: VERSION,
      sourceSha256: sources.find(row => row.path === 'forge-capability-inventory.mjs')?.sha256,
      positiveFixture: 'current-generated-input' })) };
  const inventory = { ...structuredClone(core), inventorySha256: digest(core) };
  const issues = collectCapabilityInventoryIssues({ inventory, catalog, registeredTools, sources });
  if (issues.length) throw new Error(JSON.stringify(issues));
  return inventory;
}

// These fixtures run against the actual generated image input, not a manually
// authored all-green tool list. They are metadata-only and execute no tool body.
export function verifyCapabilityInventoryFixtures({ inventory, catalog, registeredTools, sources }) {
  const input = { inventory, catalog, registeredTools, sources };
  const positive = collectCapabilityInventoryIssues(input);
  if (positive.length) throw new Error(`Inventory positive fixture failed: ${JSON.stringify(positive)}`);
  const mutations = {
    'inventory-declared-tool': v => { v.catalog.skills[0].requiredTools = ['forge-inventory-nonexistent-tool']; },
    'inventory-skill-effect': v => { v.catalog.skills[0].sideEffectClass = v.catalog.skills[0].sideEffectClass === 'read-only' ? 'workspace-write' : 'read-only'; },
    'inventory-tool-schema': v => { v.registeredTools[0].parameters.inventoryUnexpectedParameter = { type: 'string' }; },
    'inventory-source-binding': v => { v.sources[0].sha256 = '0'.repeat(64); },
  };
  return CHECKERS.map(checker => {
    const changed = structuredClone(input); mutations[checker.id](changed);
    const issues = collectCapabilityInventoryIssues(changed);
    if (!issues.some(issue => issue.code === checker.id)) throw new Error(`Inventory negative fixture failed: ${checker.id}`);
    return { checkerId: checker.id, version: VERSION, positiveFixture: 'current-generated-input', positivePassed: true,
      negativeFixture: checker.negativeFixture, negativeRejected: true };
  });
}

export { VERSION as CAPABILITY_INVENTORY_VERSION };
