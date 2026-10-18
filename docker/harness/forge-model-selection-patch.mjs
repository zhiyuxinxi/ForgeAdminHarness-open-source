import { readFileSync, writeFileSync, openSync, closeSync, fstatSync, lstatSync, mkdirSync, renameSync, unlinkSync, fsyncSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'forge-model-selection-rejection-v1';
const SESSION_MARKER = 'forge-session-model-selection-v1';

function selectionPath(home, sessionId) {
  if (typeof home !== 'string' || resolve(home) !== home || typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/u.test(sessionId)) {
    throw new Error('Invalid session model selection location');
  }
  return resolve(home, 'model-selections', sessionId + '.json');
}

function checkedSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['provider','model','reasoningEffort'].includes(key))
    || !['provider','model'].every(key => typeof value[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,160}$/u.test(value[key]))
    || (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(value.reasoningEffort)))) {
    throw new Error('Invalid saved session model selection');
  }
  return {...value};
}

/** A private per-session preference; it never fabricates a model request/history event. */
export function readSessionModelSelection(sessionId, home = process.env.DSH_HOME) {
  const file = selectionPath(home, sessionId);
  let fd;
  try {
    const directory = lstatSync(resolve(file, '..'));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe session model selection directory');
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096
      || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
      throw new Error('Unsafe session model selection file');
    }
    return checkedSelection(JSON.parse(readFileSync(fd, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function saveSessionModelSelection(sessionId, selection, home = process.env.DSH_HOME) {
  const file = selectionPath(home, sessionId), directory = resolve(file, '..');
  const data = JSON.stringify(checkedSelection(selection)) + '\n';
  mkdirSync(directory, {recursive:true, mode:0o700});
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
    throw new Error('Unsafe session model selection directory');
  }
  const temporary = resolve(directory, '.' + randomUUID() + '.tmp');
  let fd;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

const PICKED = '\t\tlet picked;\n\t\tconst selection = {';
const SAVED_PICKED = `\t\tlet picked = readSessionModelSelection(agent.session.id); // ${SESSION_MARKER}\n\t\tconst selection = {`;
const SELECTED = '\t\t\t\t\t\tselectionFor(found.agent).current = selected;';
const SAVED_SELECTED = '\t\t\t\t\t\tsaveSessionModelSelection(found.agent.session.id, selected);\n' + SELECTED;
const SESSION_IMPORT = 'import { readSessionModelSelection, saveSessionModelSelection } from "/usr/local/lib/forge-model-selection-patch.mjs";\n';

export function patchSessionModelPersistence(source) {
  if (source.includes(SESSION_MARKER)) {
    if (source.split(SESSION_MARKER).length !== 2 || source.split(SESSION_IMPORT).length !== 2
      || source.split(SAVED_PICKED).length !== 2 || source.split(SAVED_SELECTED).length !== 2) throw new Error('Incomplete session model persistence patch');
    return source;
  }
  if (source.split(PICKED).length !== 2 || source.split(SELECTED).length !== 2) throw new Error('Unsupported upstream session model persistence');
  return SESSION_IMPORT + source.replace(PICKED, SAVED_PICKED).replace(SELECTED, SAVED_SELECTED);
}

export function applySessionPersistencePatch(root) {
  const directory = resolve(root, '@deepseek-ai/dsh-host-apiproxy');
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh-host-apiproxy' || pkg.version !== '0.1.1-rc.2') throw new Error('Unsupported Harness session model package');
  const file = resolve(directory, 'lib/index.js'), before = readFileSync(file, 'utf8');
  const after = patchSessionModelPersistence(before);
  if (after !== before) writeFileSync(file, after);
  return {patch:SESSION_MARKER, changed:after !== before};
}

// Exact ModelDirectory.select from @deepseek-ai/dsh-client-ui-model-selection 0.1.1-rc.2.
const SELECT = `			async select(selection) {
				this.assertAvailable();
				const generation = ++this.generation;
				this.store.update((s) => {
					s.status = "selecting";
					s.error = null;
				});
				const { result } = await this.sessions.selectModel({
					sessionId: this.sessionId,
					provider: selection.provider,
					model: selection.model,
					...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
				});
				if (this.disposed || generation !== this.generation) {
					if (!result.ok) throw new Error(\`\${result.error.code}: \${result.error.message}\`);
					return;
				}
				if (!result.ok) {
					this.store.update((s) => {
						s.status = "error";
						s.error = \`\${result.error.code}: \${result.error.message}\`;
					});
					throw new Error(\`session.selectModel failed: \${result.error.code}: \${result.error.message}\`);
				}
				this.store.update((s) => {
					s.current = result.value.selected;
					s.routable = true;
					s.status = "ready";
					s.error = null;
				});
			}`;

const REQUEST = `				const { result } = await this.sessions.selectModel({
					sessionId: this.sessionId,
					provider: selection.provider,
					model: selection.model,
					...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
				});`;

const RECOVERED_REQUEST = `				// ${MARKER}: rejected transport requests must release the shared selecting state.
				let response;
				try {
					response = await this.sessions.selectModel({
						sessionId: this.sessionId,
						provider: selection.provider,
						model: selection.model,
						...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
					});
				} catch (error) {
					if (!this.disposed && generation === this.generation) {
						this.store.update((s) => {
							s.status = "error";
							s.error = typeof error?.message === "string" ? error.message : String(error);
						});
					}
					throw error;
				}
				const { result } = response;`;

const PATCHED_SELECT = SELECT.replace(REQUEST, RECOVERED_REQUEST);

/** Recover only the latest live selection; retain native result and retry semantics. */
export function patchModelSelectionClient(source) {
  if (source.includes(MARKER)) {
    if (source.split(MARKER).length !== 2 || source.split(PATCHED_SELECT).length !== 2 || source.includes(SELECT)) {
      throw new Error('Incomplete model selection rejection patch');
    }
    return source;
  }
  if (source.split(SELECT).length !== 2) throw new Error('Unsupported upstream model selection client');
  return source.replace(SELECT, PATCHED_SELECT);
}

export function applyPatch(root) {
  const directory = resolve(root, '@deepseek-ai/dsh-client-ui-model-selection');
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh-client-ui-model-selection' || pkg.version !== '0.1.1-rc.2') {
    throw new Error('Unsupported Harness model selection package');
  }
  const file = resolve(directory, 'lib/client.js');
  const before = readFileSync(file, 'utf8');
  const after = patchModelSelectionClient(before);
  if (after !== before) writeFileSync(file, after);
  return { patch: MARKER, changed: after !== before };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node forge-model-selection-patch.mjs NODE_MODULES_ROOT');
  console.log(JSON.stringify(applyPatch(process.argv[2])));
  console.log(JSON.stringify(applySessionPersistencePatch(process.argv[2])));
}
