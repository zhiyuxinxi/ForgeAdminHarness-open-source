import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'forge-model-selection-rejection-v1';

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
}
