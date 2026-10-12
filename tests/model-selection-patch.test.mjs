import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyPatch, patchModelSelectionClient } from '../docker/harness/forge-model-selection-patch.mjs';

// Exact class extracted between 'var ModelDirectory = class {' and the next //#endregion.
// @deepseek-ai/dsh-client-ui-model-selection 0.1.1-rc.2, runtime-model-ui-0.js
// Captured source SHA256: 575beb918f80b39b5492cbda650b442aa40c13ffc83d241c1136eea5485f79ef
const source = `		var ModelDirectory = class {
			sessions;
			sessionId;
			available;
			/** The shared snapshot both entries render from (uSES-safe store). */
			store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)({
				current: null,
				routable: null,
				groups: [],
				failures: [],
				status: "idle",
				error: null
			});
			/** Latest operation wins; an older response never overwrites a newer one. */
			generation = 0;
			disposed = false;
			/**
			* @param sessions - the session wire face (captured from the plugin's root connection).
			* @param sessionId - the owning session.
			* @param available - whether this session may use Agent-bound model RPCs.
			*/
			constructor(sessions, sessionId, available) {
				this.sessions = sessions;
				this.sessionId = sessionId;
				this.available = available;
			}
			/**
			* Refresh the advisory directory (both entries call this on open).
			* Failure preserves the last good groups and current selection.
			* @returns the fresh directory value.
			*/
			async load() {
				this.assertAvailable();
				const generation = ++this.generation;
				this.store.update((s) => {
					s.status = "loading";
					s.error = null;
				});
				const { result } = await this.sessions.models({ sessionId: this.sessionId });
				if (this.disposed || generation !== this.generation) {
					if (!result.ok) throw new Error(\`\${result.error.code}: \${result.error.message}\`);
					return result.value;
				}
				if (!result.ok) {
					this.store.update((s) => {
						s.status = "error";
						s.error = \`\${result.error.code}: \${result.error.message}\`;
					});
					throw new Error(\`session.models failed: \${result.error.code}: \${result.error.message}\`);
				}
				const { current, routable, groups, failures } = result.value;
				this.store.update((s) => {
					s.current = current;
					s.routable = routable;
					s.groups = groups;
					s.failures = failures;
					s.status = "ready";
					s.error = null;
				});
				return result.value;
			}
			/**
			* Select the complete provider/model/reasoning selection (both entries submit through here). Success
			* updates the shared current; failure surfaces on the store and throws so
			* each entry's own retry surface engages.
			* @param selection - provider, provider-owned model id, and optional adapter-owned effort.
			*/
			async select(selection) {
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
			}
			/**
			* Drop the previous Host generation's projection and repull it. Clearing
			* first prevents an unconsumed process-local selection from being displayed
			* while the restarted Host has restored the last logged model selection.
			*/
			resetConnected() {
				if (this.disposed) return;
				++this.generation;
				this.store.update((s) => {
					s.current = null;
					s.routable = null;
					s.groups = [];
					s.failures = [];
					s.status = "idle";
					s.error = null;
				});
				if (!this.available()) return;
				this.load().catch(() => {});
			}
			/** Scope teardown: late settlements lose write access to the store. */
			dispose() {
				this.disposed = true;
			}
			assertAvailable() {
				if (!this.available()) throw new Error("model selection is unavailable for addressed subagent sessions");
			}
		};`;

// In image consumers, behavior must come from the installed, already-patched package.
// Never repair a missing image patch in memory and report that as an installed success.
const runtimeRoot = process.env.FORGE_TEST_NATIVE_RUNTIME;
let installedDirectory;
if (runtimeRoot) {
  const packageRoot = resolve(runtimeRoot, 'node_modules/@deepseek-ai/dsh-client-ui-model-selection');
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@deepseek-ai/dsh-client-ui-model-selection');
  assert.equal(pkg.version, '0.1.1-rc.2');
  const installed = readFileSync(join(packageRoot, 'lib/client.js'), 'utf8');
  assert.ok(installed.includes('forge-model-selection-rejection-v1'), 'installed model selection patch is required');
  assert.equal(patchModelSelectionClient(installed), installed, 'installed patch must already be complete');
  const start = installed.indexOf('\t\tvar ModelDirectory = class {');
  const end = installed.indexOf('\n\t\t//#endregion', start);
  assert.ok(start >= 0 && end > start, 'installed ModelDirectory class must be extractable');
  installedDirectory = installed.slice(start, end);
  console.log('Native model selection consumer: ' + JSON.stringify({
    packageRoot, version: pkg.version,
    clientSha256: createHash('sha256').update(installed).digest('hex'),
    directorySha256: createHash('sha256').update(installedDirectory).digest('hex'),
  }));
}

function directory(selectModel, available = () => true, client = installedDirectory ?? patchModelSelectionClient(source)) {
  const context = vm.createContext({
    _deepseek_ai_dsh_client_runtime_client: {
      createSnapshotStore(initial) {
        let snapshot = initial;
        return {
          getSnapshot: () => snapshot,
          update(change) {
            const next = { ...snapshot };
            change(next);
            snapshot = next;
          },
        };
      },
    },
  });
  vm.runInContext(client, context);
  const instance = new context.ModelDirectory({ selectModel }, 'session-model-test', available);
  instance.store.update(s => {
    s.current = { provider: 'openai-codex', model: 'previous' };
    s.routable = true;
    s.groups = [{ provider: 'openai-codex', models: ['previous', 'next'] }];
    s.failures = [{ provider: 'unavailable-adapter', message: 'unchanged' }];
    s.status = 'ready';
  });
  return instance;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const requested = { provider: 'openai-codex', model: 'next', reasoningEffort: 'high' };
const success = selected => ({ result: { ok: true, value: { selected } } });

test('transport rejection releases selecting, preserves the last selection, and allows a normal retry', async () => {
  const failure = new Error('Connection closed');
  const unpatched = directory(() => Promise.reject(failure), undefined, source);
  await assert.rejects(unpatched.select(requested), error => error === failure);
  assert.equal(unpatched.store.getSnapshot().status, 'selecting', 'frozen upstream reproduces the stuck state');

  const calls = [];
  const first = deferred();
  const instance = directory(params => {
    calls.push(params);
    return calls.length === 1 ? first.promise : Promise.resolve(success(requested));
  });
  const previous = instance.store.getSnapshot();
  const pending = instance.select(requested);
  assert.equal(instance.store.getSnapshot().status, 'selecting');
  const rejected = assert.rejects(pending, error => error === failure);
  first.reject(failure);
  await rejected;
  const failed = instance.store.getSnapshot();
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, failure.message);
  for (const key of ['current', 'routable', 'groups', 'failures']) assert.equal(failed[key], previous[key]);
  await instance.select(requested);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [0, 1].map(() => ({ sessionId: 'session-model-test', ...requested })));
  assert.equal(instance.store.getSnapshot().current, requested);
  assert.equal(instance.store.getSnapshot().status, 'ready');
  assert.equal(instance.store.getSnapshot().error, null);
});

test('an older rejected selection cannot overwrite a newer pending or completed selection', async () => {
  for (const latestCompletesFirst of [false, true]) {
    const old = deferred();
    const latest = deferred();
    let calls = 0;
    const instance = directory(() => ++calls === 1 ? old.promise : latest.promise);
    const oldRequest = instance.select({ provider: 'openai-codex', model: 'old-request' });
    const failure = new Error('stale connection failure');
    const oldRejected = assert.rejects(oldRequest, error => error === failure);
    const latestRequest = instance.select(requested);
    if (latestCompletesFirst) {
      latest.resolve(success(requested));
      await latestRequest;
    }
    const beforeOldRejection = instance.store.getSnapshot();
    old.reject(failure);
    await oldRejected;
    assert.equal(instance.store.getSnapshot(), beforeOldRejection, 'stale rejection must not write the store');
    if (!latestCompletesFirst) {
      latest.resolve(success(requested));
      await latestRequest;
    }
    assert.equal(instance.store.getSnapshot().current, requested);
    assert.equal(instance.store.getSnapshot().status, 'ready');
    assert.equal(instance.store.getSnapshot().error, null);
  }
});

test('a disposed directory cannot be updated by a late transport rejection', async () => {
  const response = deferred();
  const instance = directory(() => response.promise);
  const failure = new Error('late disconnect');
  const rejected = assert.rejects(instance.select(requested), error => error === failure);
  instance.dispose();
  const disposedSnapshot = instance.store.getSnapshot();
  response.reject(failure);
  await rejected;
  assert.equal(instance.store.getSnapshot(), disposedSnapshot);
});

test('native RPC rejection and unavailable-session restrictions are preserved', async () => {
  const instance = directory(async () => ({ result: { ok: false, error: { code: 'agent-busy', message: 'try again' } } }));
  const previous = instance.store.getSnapshot().current;
  await assert.rejects(instance.select(requested), /session.selectModel failed: agent-busy: try again/);
  assert.equal(instance.store.getSnapshot().status, 'error');
  assert.equal(instance.store.getSnapshot().error, 'agent-busy: try again');
  assert.equal(instance.store.getSnapshot().current, previous);

  let calls = 0;
  const unavailable = directory(() => { ++calls; }, () => false);
  const original = unavailable.store.getSnapshot();
  await assert.rejects(unavailable.select(requested), /unavailable for addressed subagent sessions/);
  assert.equal(calls, 0);
  assert.equal(unavailable.store.getSnapshot(), original);
});

test('the pinned patch is idempotent and rejects upstream, duplicate, and partial drift', () => {
  const patched = patchModelSelectionClient(source);
  assert.equal(patchModelSelectionClient(patched), patched);
  assert.throws(() => patchModelSelectionClient(source.replace('async select(selection)', 'async selectModel(selection)')), /Unsupported upstream/);
  assert.throws(() => patchModelSelectionClient(source.replace('generation !== this.generation', 'generation < this.generation').replace('generation !== this.generation', 'generation < this.generation')), /Unsupported upstream/);
  assert.throws(() => patchModelSelectionClient(source + source), /Unsupported upstream/);
  assert.throws(() => patchModelSelectionClient(patched.replace('!this.disposed && generation === this.generation', 'true')), /Incomplete model selection/);
  assert.throws(() => patchModelSelectionClient(patched + source), /Incomplete model selection/);
});

test('the image entrypoint patches only the supported installed package and reports repeat application', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-model-selection-'));
  try {
    const packageRoot = join(root, '@deepseek-ai/dsh-client-ui-model-selection');
    mkdirSync(join(packageRoot, 'lib'), { recursive: true });
    const packageFile = join(packageRoot, 'package.json');
    const clientFile = join(packageRoot, 'lib/client.js');
    const pkg = { name: '@deepseek-ai/dsh-client-ui-model-selection', version: '0.1.1-rc.2' };
    writeFileSync(packageFile, JSON.stringify(pkg));
    writeFileSync(clientFile, source);
    assert.equal(applyPatch(root).changed, true);
    const patched = readFileSync(clientFile, 'utf8');
    assert.equal(patched, patchModelSelectionClient(source));
    assert.equal(applyPatch(root).changed, false);
    writeFileSync(packageFile, JSON.stringify({ ...pkg, version: '0.1.1-rc.3' }));
    assert.throws(() => applyPatch(root), /Unsupported Harness model selection package/);
    assert.equal(readFileSync(clientFile, 'utf8'), patched);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
