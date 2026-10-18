import crypto from 'node:crypto';
import path from 'node:path';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { code: 'RELEASE_INPUTS_UNRESOLVED' }); };
const scoped = value => typeof value === 'string' && value.length > 0 && value.length < 512
  && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/')
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const under = (file, root) => file === root || file.startsWith(`${root}/`);

// The comparison base belongs to impact authorization. It does not alter the
// immutable candidate or invalidate an already verified image of that commit.
export function sameReleaseCandidate(left, right) {
  if (!left || !right) return left === right;
  return ['source', 'taskId', 'actorId', 'conversationId', 'candidateCommit'].every(key => left[key] === right[key]);
}

export function publicReleasePlan(plan) {
  if (!plan) return null;
  return { schemaVersion: plan.schemaVersion, commit: plan.commit, modelDigest: plan.modelDigest,
    selectedServices: plan.selectedServices, retainedServices: plan.retainedServices, checks: plan.checks,
    reasons: Object.fromEntries(Object.entries(plan.reasons).map(([service, reason]) => [service,
      { ...reason, ...(reason.paths ? { paths: reason.paths.slice(0, 80), pathCount: reason.paths.length } : {}) }])),
    inputs: Object.fromEntries(Object.entries(plan.inputs).map(([service, input]) => [service,
      { digest: input.digest, fileCount: input.files.length, modules: input.modules }])) };
}

// Definitions belong to the protected project contract, never a model request.
// Service names and business directories carry no semantics in this resolver.
export function validateReleaseInputs(model, services) {
  if (!model || model.schemaVersion !== 1 || !model.services || Array.isArray(model.services)
    || Object.keys(model).some(key => !['schemaVersion', 'services'].includes(key))
    || JSON.stringify(Object.keys(model.services).sort()) !== JSON.stringify([...services].sort())) fail('Input definitions must cover the registered services exactly.');
  for (const [name, unit] of Object.entries(model.services)) {
    if (!unit || !['tree', 'maven'].includes(unit.kind)
      || Object.keys(unit).some(key => !['kind', 'roots', 'inputs', 'optionalInputs', 'migrations', 'mavenRoot', 'module', 'imageVariable', 'dockerfile', 'checks'].includes(key))
      || !/^[A-Z][A-Z0-9_]*_IMAGE$/.test(unit.imageVariable ?? '')) fail(`Invalid input definition for ${name}.`);
    for (const key of ['roots', 'inputs', 'migrations']) {
      if (!Array.isArray(unit[key]) || unit[key].length > 256 || unit[key].some(item => !scoped(item))
        || new Set(unit[key]).size !== unit[key].length) fail(`Invalid ${key} for ${name}.`);
    }
    if (unit.kind === 'tree' && !unit.roots.length) fail(`Missing source roots for ${name}.`);
    if (unit.optionalInputs !== undefined && (!Array.isArray(unit.optionalInputs) || unit.optionalInputs.some(item => !scoped(item)))) fail('Invalid optional build inputs.');
    if (unit.kind === 'maven' && (!scoped(unit.mavenRoot) || !scoped(unit.module))) fail(`Missing Maven entry for ${name}.`);
    if (unit.dockerfile !== undefined && (!scoped(unit.dockerfile) || !unit.inputs.includes(unit.dockerfile))) fail('Build recipe must be a declared protected input.');
    if (!Array.isArray(unit.checks) || unit.checks.some(check => !check || typeof check.profile !== 'string'
      || !check.selectors || Array.isArray(check.selectors) || Object.keys(check).some(k => !['profile', 'selectors', 'inputRoots'].includes(k))
      || check.inputRoots !== undefined && (!Array.isArray(check.inputRoots) || !check.inputRoots.length || check.inputRoots.some(root => !scoped(root))))) fail('Invalid verification definition.');
  }
  if (new Set(Object.values(model.services).map(unit => unit.imageVariable)).size !== services.length) fail('Services must have independent image variables.');
  return model;
}

// Narrow a protected Maven recipe's standard project selector. Preserve every
// other instruction, image, profile, cache mount and runtime setting. This is
// command syntax, never business-directory or natural-language matching.
export function serviceMavenDockerfile(dockerfile, module) {
  if (!scoped(module) || !/^[A-Za-z0-9_./-]+$/.test(module)) fail('Invalid Maven build target.');
  let matches = 0;
  const result = dockerfile.replace(/^RUN\s+(?:[^\n]*\\\r?\n)*[^\n]*/gmi, instruction => {
    const logical = instruction.replace(/\\\r?\n/g, ' ');
    if (!/(?:^|\s)mvn(?:\s|$)/.test(logical)) return instruction;
    // A compound shell or exec-form recipe requires an explicit project
    // template update; never guess at a partial command and claim it is scoped.
    if (/[;&|<>`$\[\]]/.test(logical) || !/\s-am(?:\s|$)|\s--also-make(?:\s|$)/.test(logical)) fail('Maven recipe requires a simple reactor command with --also-make.');
    const projectOptions = [...logical.matchAll(/(?:\s)(?:-pl|--projects)(?:\s+|=)([A-Za-z0-9_./,-]+)/g)];
    if (projectOptions.length !== 1 || !/\s(?:package|install|verify)(?:\s|$)/.test(logical)) fail('Maven recipe must have exactly one explicit project selector and a package lifecycle.');
    const option = projectOptions[0];
    if (logical.slice(option.index + option[0].length).match(/^\S/)) fail('Unsupported Maven project selector.');
    matches++;
    return logical.slice(0, option.index) + option[0].replace(option[1], module) + logical.slice(option.index + option[0].length);
  });
  if (matches !== 1) fail('Build recipe must contain exactly one Maven reactor build.');
  return result;
}

// A small data-only XML reader. No entity expansion, DTD, XInclude or execution.
// It reads POM structure rather than matching service/filename special cases.
export function readPomXml(text) {
  if (text.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text)) fail('Unsupported POM entity declaration.');
  const doc = { name: '#document', children: [], text: '' }, stack = [doc];
  const tokens = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').match(/<[^>]*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('</')) {
      if (stack.length < 2 || stack.pop().name !== token.slice(2, -1).trim().split(':').at(-1)) fail('Malformed POM XML.');
    } else if (token.startsWith('<')) {
      if (token.startsWith('<!')) fail('Unsupported POM XML section.');
      const name = /^<([\w:.-]+)/.exec(token)?.[1]?.split(':').at(-1);
      if (!name) fail('Malformed POM element.');
      const node = { name, children: [], text: '' }; stack.at(-1).children.push(node);
      if (!token.endsWith('/>')) stack.push(node);
    } else stack.at(-1).text += token;
  }
  if (stack.length !== 1 || doc.children.length !== 1 || doc.children[0].name !== 'project') fail('Malformed POM document.');
  return doc.children[0];
}
const children = (node, name) => node?.children.filter(item => item.name === name) ?? [];
const child = (node, name) => children(node, name)[0];
const textOf = (node, name) => child(node, name)?.text.trim() ?? '';

export async function mavenInputClosure(root, module, files, read, { tests = false } = {}) {
  const poms = new Map();
  for (const file of files.keys()) if (under(file, root) && file.endsWith('/pom.xml')) {
    poms.set(path.posix.dirname(file), { file, xml: readPomXml(await read(file)) });
  }
  const entry = `${root}/${module}`;
  if (!poms.has(entry)) fail(`Missing Maven entry POM ${entry}/pom.xml.`);
  const effective = new Map();
  function resolve(dir, chain = new Set()) {
    if (effective.has(dir)) return effective.get(dir);
    if (chain.has(dir)) fail('Maven parent cycle.');
    chain = new Set([...chain, dir]);
    const pom = poms.get(dir); if (!pom) fail(`Missing POM ${dir}.`);
    const parentNode = child(pom.xml, 'parent');
    const relative = child(parentNode, 'relativePath');
    const parentPath = parentNode && (relative === undefined || relative.text.trim())
      ? path.posix.normalize(path.posix.join(dir, relative?.text.trim() ?? '../pom.xml')) : null;
    const parentDir = parentPath && under(parentPath, root) && (poms.has(parentPath) ? parentPath : path.posix.dirname(parentPath));
    const parent = parentDir && poms.has(parentDir) ? resolve(parentDir, chain) : null;
    const properties = { ...parent?.properties };
    for (const item of child(pom.xml, 'properties')?.children ?? []) properties[item.name] = item.text.trim();
    const expand = value => {
      for (let count = 0; count < 16 && /\$\{[^}]+\}/.test(value); count++) {
        const next = value.replace(/\$\{([^}]+)\}/g, (all, key) => properties[key] ?? all);
        if (next === value) break; value = next;
      }
      if (/\$\{|&/.test(value)) fail(`Unresolved Maven coordinate in ${pom.file}.`);
      return value;
    };
    const group = expand(textOf(pom.xml, 'groupId') || parent?.group || textOf(parentNode, 'groupId'));
    const artifact = expand(textOf(pom.xml, 'artifactId'));
    Object.assign(properties, { 'project.groupId': group, 'pom.groupId': group, 'project.artifactId': artifact,
      'project.version': textOf(pom.xml, 'version') || parent?.version || textOf(parentNode, 'version') });
    const dependencies = [...(parent?.dependencies ?? [])];
    const containers = [pom.xml, ...(child(pom.xml, 'profiles')?.children ?? [])];
    for (const container of containers) for (const dependency of children(child(container, 'dependencies'), 'dependency')) {
      if (!tests && textOf(dependency, 'scope') === 'test') continue;
      dependencies.push(`${expand(textOf(dependency, 'groupId'))}:${expand(textOf(dependency, 'artifactId'))}`);
    }
    const value = { group, artifact, version: properties['project.version'], properties, dependencies, parentDir: parent ? parentDir : null };
    effective.set(dir, value); return value;
  }
  const coordinates = new Map();
  for (const dir of poms.keys()) {
    const value = resolve(dir), key = `${value.group}:${value.artifact}`;
    if (coordinates.has(key)) fail(`Ambiguous reactor coordinate ${key}.`); coordinates.set(key, dir);
  }
  const modules = new Set(), inputs = new Set(), active = new Set();
  function visit(dir) {
    if (active.has(dir)) fail('Maven dependency cycle.');
    if (modules.has(dir)) return;
    modules.add(dir); active.add(dir);
    let parent = dir;
    while (parent) { inputs.add(`${parent}/pom.xml`); parent = resolve(parent).parentDir; }
    for (const key of resolve(dir).dependencies) if (coordinates.has(key)) visit(coordinates.get(key));
    active.delete(dir);
  }
  visit(entry);
  if (files.has(`${root}/pom.xml`)) inputs.add(`${root}/pom.xml`);
  for (const file of files.keys()) {
    if (under(file, `${root}/.mvn`) || file === `${root}/settings.xml`) inputs.add(file);
    for (const dir of modules) if (under(file, `${dir}/src/main`) || tests && under(file, `${dir}/src/test`)) inputs.add(file);
  }
  return { files: [...inputs].sort(), modules: [...modules].sort() };
}

export async function collectReleaseInputs(model, snapshot, read) {
  const result = {};
  for (const [service, unit] of Object.entries(model.services)) {
    const selected = new Set(), migration = new Set();
    let modules = [];
    if (unit.kind === 'maven') {
      const closure = await mavenInputClosure(unit.mavenRoot, unit.module, snapshot, read);
      closure.files.forEach(file => selected.add(file)); modules = closure.modules;
    }
    for (const [file, identity] of snapshot) {
      if ([...unit.roots, ...unit.inputs, ...(unit.optionalInputs ?? [])].some(root => under(file, root))) selected.add(file);
      if (unit.migrations.some(root => under(file, root))) { selected.add(file); migration.add(file); }
      if ((selected.has(file) || migration.has(file)) && identity.mode !== '100644' && identity.mode !== '100755') fail(`Unsupported release input type: ${file}.`);
    }
    for (const input of unit.inputs) if (![...snapshot.keys()].some(file => under(file, input))) fail(`Missing declared build input ${input}.`);
    const entries = [...selected].sort().map(file => [file, snapshot.get(file)]);
    result[service] = { digest: digest({ definition: unit, entries }), migrationDigest: digest([...migration].sort().map(file => [file, snapshot.get(file)])),
      files: entries.map(([file]) => file), modules, checks: unit.checks };
  }
  return result;
}

export function selectReleaseImpact({ requestedServices, inputs, baselines, changes, allowedChanges, unreleasedBaseChanges = {}, approvedProtectedChanges = new Set() }) {
  const selected = [], retained = [], reasons = {};
  // A narrow request is an authorization ceiling, not permission to omit a
  // consumer of a changed shared dependency. Report the affected consumers.
  const omitted = Object.keys(inputs).filter(service => !requestedServices.includes(service)
    && baselines[service]?.inputDigest !== inputs[service].digest
    && allowedChanges && [...allowedChanges, ...approvedProtectedChanges].some(file => inputs[service].files.includes(file)
      || baselines[service]?.inputFiles?.includes(file)));
  if (omitted.length) throw Object.assign(new Error('Changed inputs also affect services outside this release request.'),
    { code: 'RELEASE_AFFECTED_SERVICE_OMITTED', details: { services: omitted } });
  for (const service of requestedServices) {
    const input = inputs[service]; if (!input) fail(`No input definition for ${service}.`);
    const previous = baselines[service];
    if (previous?.inputDigest === input.digest) { retained.push(service); reasons[service] = { kind: 'unchanged-inputs', commit: previous.commit }; continue; }
    const affected = (changes[service] ?? []).filter(file => input.files.includes(file) || previous?.inputFiles?.includes(file));
    const outside = affected.filter(file => !approvedProtectedChanges.has(file)
      && (allowedChanges && !allowedChanges.has(file) || unreleasedBaseChanges[service]?.has(file)));
    if (previous && outside.length) {
      throw Object.assign(new Error(`The ${service} artifact also contains changes outside this task; reconcile the candidate before release.`),
        { code: 'RELEASE_CANDIDATE_SCOPE_MISMATCH', details: { service, paths: outside } });
    }
    selected.push(service); reasons[service] = { kind: previous ? 'changed-inputs' : 'initial-baseline', paths: affected };
  }
  return { schemaVersion: 1, selectedServices: selected, retainedServices: retained, reasons,
    checks: [...new Map(selected.flatMap(service => inputs[service].checks
      .filter(check => !baselines[service] || !check.inputRoots || reasons[service].paths.some(file => check.inputRoots.some(root => under(file, root))))
      .map(({ profile, selectors }) => ({ profile, selectors }))).map(check => [JSON.stringify(check), check])).values()],
    inputs: Object.fromEntries(requestedServices.map(service => [service, inputs[service]])) };
}

export function successfulServiceBaselines(records, model, environment) {
  const baselines = {};
  const failed = new Set(records.filter(record => record.type === 'controlled-release' && record.status === 'failed').map(record => record.jobId));
  for (const record of records) {
    if (record.type !== 'controlled-release' || record.status !== 'success' || failed.has(record.jobId)) continue;
    for (const service of record.services ?? []) {
      const input = record.inputPlan?.inputs?.[service], image = record.images?.[service]?.id;
      if (!model.services[service] || !/^[a-f0-9]{40}$/.test(record.commit ?? '') || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')) continue;
      baselines[service] = { commit: record.commit, image, inputDigest: input?.digest, migrationDigest: input?.migrationDigest,
        inputFiles: input?.files, jobId: record.jobId, completedAt: record.completedAt };
    }
  }
  for (const [service, baseline] of Object.entries(baselines)) {
    if (environment[model.services[service].imageVariable] !== baseline.image) delete baselines[service];
  }
  return baselines;
}
