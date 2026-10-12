import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../docker/harness/conversation-gateway/gateway.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../docker/harness/conversation-gateway/index.html', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const walk = (node) => [node, ...node.children.flatMap(walk)];

function fixture(t) {
  class Element extends EventTarget {
    constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.ownText = ''; this.hidden = false; }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
    set innerHTML(_value) { throw new Error('unsafe HTML injection'); }
    append(...nodes) { this.children.push(...nodes); }
    prepend(...nodes) { this.children.unshift(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; this.ownText = ''; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    focus() { document.activeElement = this; }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  }
  const nodes = new Map([...markup.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(([html, tag, id]) => {
    const node = new Element(tag); node.id = id; node.hidden = /\bhidden\b/.test(html); return [`#${id}`, node];
  }));
  const document = { querySelector: (selector) => nodes.get(selector), createElement: (tag) => new Element(tag) };
  const requests = [];
  const context = vm.createContext({ document, URL, URLSearchParams, AbortController, Blob, Intl, setTimeout, clearTimeout,
    window: { location: { assign: () => assert.fail('unexpected navigation') }, history: { replaceState() {} } },
    fetch: (url, options = {}) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve });
      options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  vm.runInContext(source.slice(0, source.indexOf('for (const closeButton of')), context);
  const run = (script) => vm.runInContext(script, context);
  run("state.session={user:{id:'member',role:'member'}}; state.selectedProjectSlug='demo';");
  t.after(() => run('closeConversationOutputs(); stopReleaseStatus(); clearTimeout(state.provisioningTimer)'));
  return { nodes, requests, run, get: (id) => nodes.get(`#${id}`),
    async reply(index, value, status = 200) {
      requests[index].resolve(new Response(typeof value === 'string' ? value : JSON.stringify(value), { status,
        headers: { 'content-type': typeof value === 'string' ? 'text/plain' : 'application/json' } }));
      await tick();
    },
    show: () => run("showConversationOutputs({id:'conversation-one',title:'订单模块'})"),
  };
}

const file = { name: '01-result.md', displayName: '阶段结果.md', downloadName: '03-数据实现_阶段结果.md',
  usageLabel: '阶段结果 · 先看这份', usageHint: '阅读本阶段结果与待解决问题。', primary: true, bytes: 42, mediaType: 'text/markdown' };
const packageItem = { packageId: 'b'.repeat(64), phaseId: 'database', phaseIndex: 3, phaseLabel: '第03阶段 · 数据实现',
  decision: 'accepted', createdAt: '2026-09-15T01:00:00Z', versionLabel: '09月15日 09:00 · 版本 bbbbbbbb', files: [file] };
const snapshot = { sessionId: 'native-one', snapshotId: 'a'.repeat(64), status: 'completed', createdAt: '2026-09-15T01:00:00Z',
  files: [{ name: 'conversation.md', displayName: '完整聊天记录.md', downloadName: '聊天记录.md', bytes: 42, mediaType: 'text/markdown' }] };

test('closed TaskSpace UI retains archives without offering open or stop', async (t) => {
  const f = fixture(t);
  f.run("state.conversations=[{id:'closed-one',ownerUserId:'member',title:'历史任务',projectSlug:'demo',taskId:'closed-task',status:'closed',updatedAt:'2026-10-04T00:00:00Z'}];renderConversations();");
  const list = f.get('conversation-list');
  assert.match(list.textContent, /已关闭/);
  const buttons = walk(list).filter((node) => node.tagName === 'BUTTON');
  assert.ok(buttons.some((node) => node.textContent === '查看文件'));
  assert.ok(buttons.every((node) => !/打开|恢复|停止/.test(node.textContent)));
  buttons.find((node) => node.textContent === '查看文件').click();
  await f.reply(0, { items: [] });
  await f.reply(1, { items: [snapshot], hasMore: false });
  assert.match(f.get('output-list').textContent, /完整聊天记录.md/);
  assert.ok(f.requests.every((entry) => !/\/(open|stop)$/.test(entry.url)));
  for (const [status, label] of [['active', '打开 Harness'], ['stopped', '恢复并打开']]) {
    f.run(`state.conversations[0].status=${JSON.stringify(status)};renderConversations();`);
    assert.match(f.get('conversation-list').textContent, new RegExp(label));
  }
});

test('pending creation reads status without opening or recreating a TaskSpace, then displays the real result', async (t) => {
  const f = fixture(t);
  f.run("state.conversations=[{id:'pending-one',title:'待创建',projectSlug:'demo',taskId:'task-one',status:'failed',lastError:'MANAGER_TIMEOUT',updatedAt:'2026-09-21T00:00:00Z'}];renderConversations();");
  assert.match(f.get('conversation-list').textContent, /创建中.*请勿重复新建/);
  assert.doesNotMatch(f.get('conversation-list').textContent, /重试创建|创建失败/);
  const checking = f.run('openConversation(state.conversations[0])');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/forge-gateway/api/conversations/pending-one/status');
  assert.equal(f.requests[0].options.method, undefined);
  await f.reply(0, { conversation: { id: 'pending-one', title: '待创建', projectSlug: 'demo', taskId: 'task-one',
    status: 'active', lastError: null, updatedAt: '2026-09-21T00:01:00Z' } });
  await checking;
  assert.match(f.get('conversation-list').textContent, /运行中.*打开 Harness/);
  assert.equal(f.run('state.provisioningTimer'), null);
});

test('phase groups lead the file panel and use real decisions, Chinese names and canonical routes', async (t) => {
  const f = fixture(t); const pending = f.show();
  assert.match(f.requests[0].url, /\/phase-outputs$/);
  assert.match(f.requests[1].url, /\/outputs\?offset=0&limit=20$/);
  await f.reply(0, { items: [packageItem, { ...packageItem, packageId: 'c'.repeat(64), decision: 'blocked', versionLabel: '较早版本' }] });
  await f.reply(1, { items: [snapshot], hasMore: false }); await pending;
  const phase = f.get('phase-output-list');
  assert.equal(phase.children.length, 1);
  assert.match(phase.textContent, /第03阶段 · 数据实现.*阶段已通过.*阶段结果.md.*阶段未通过/);
  const link = walk(phase).find((node) => node.tagName === 'A');
  assert.equal(link.getAttribute('download'), '03-数据实现_阶段结果.md');
  assert.equal(link.href, `/forge-gateway/api/conversations/conversation-one/phase-outputs/${'b'.repeat(64)}/01-result.md?download=1`);
  assert.equal(link.getAttribute('aria-label'), '下载 阶段结果.md');
  assert.match(f.get('output-list').textContent, /完整聊天记录.md/);
  assert.ok(markup.indexOf('id="phase-output-heading"') < markup.indexOf('id="output-list"'));
});

test('a phase endpoint failure leaves readable chat archives and its error separate', async (t) => {
  const f = fixture(t); const pending = f.show();
  await f.reply(1, { items: [snapshot], hasMore: false });
  await f.reply(0, { message: '阶段成果暂不可用' }, 503); await pending;
  assert.match(f.get('phase-output-error').textContent, /阶段成果暂不可用/);
  assert.equal(f.get('output-error').hidden, true);
  assert.match(f.get('output-list').textContent, /完整聊天记录.md/);
  assert.equal(f.get('phase-output-empty').hidden, true);
  const retry = f.run('loadPhaseOutputs()');
  await f.reply(2, { items: [], unavailable: { code: 'PHASE_SOURCE_UNAVAILABLE', message: '阶段来源暂不可用' } });
  await retry;
  assert.match(f.get('phase-output-error').textContent, /阶段来源暂不可用/);
  assert.equal(f.get('phase-output-empty').hidden, true);
  assert.match(f.get('output-list').textContent, /完整聊天记录.md/);
});

test('reopening the same conversation rejects stale phase results and closes outstanding requests', async (t) => {
  const f = fixture(t); const old = f.show(); const current = f.show();
  assert.equal(f.requests[0].options.signal.aborted, true);
  await f.reply(0, { items: [packageItem] }); await f.reply(1, { items: [snapshot], hasMore: false });
  await f.reply(2, { items: [] }); await f.reply(3, { items: [], hasMore: false });
  await Promise.all([old, current]);
  assert.equal(f.get('phase-output-list').children.length, 0);
  assert.equal(f.get('phase-output-empty').hidden, false);
  assert.equal(f.get('output-list').children.length, 0);
});

test('preview uses plain text, supersedes old previews and refuses files above 2 MB', async (t) => {
  const f = fixture(t); const opening = f.show();
  await f.reply(0, { items: [] }); await f.reply(1, { items: [snapshot], hasMore: false }); await opening;
  f.run(`globalThis.snapshot=${JSON.stringify(snapshot)}; globalThis.file=${JSON.stringify(snapshot.files[0])};`);
  await f.run('previewOutputFile(state.outputConversation,snapshot,{...file,bytes:2097153})');
  assert.equal(f.requests.length, 2);
  assert.match(f.get('output-preview').textContent, /超过 2 MB/);
  const first = f.run('previewOutputFile(state.outputConversation,snapshot,file)');
  const second = f.run("previewOutputFile(state.outputConversation,snapshot,{...file,name:'conversation.json',displayName:'结构化聊天记录.json'})");
  assert.equal(f.requests[2].options.signal.aborted, true);
  await f.reply(3, '<script>unsafe()</script>'); await Promise.all([first, second]);
  assert.equal(f.get('output-preview').textContent, '<script>unsafe()</script>');
  assert.equal(f.get('output-preview-title').textContent, '结构化聊天记录.json');
});

test('phase deep link finds only readable list entries without starting a conversation', async (t) => {
  const f = fixture(t);
  f.run("state.conversations=[{id:'first',title:'其他对话'}];state.nextOffset=3;");
  const pending = f.run("openRequestedPhaseFiles('conversation-one')");
  assert.match(f.requests[0].url, /conversations\?project=demo&offset=3$/);
  await f.reply(0, { items: [{ id: 'conversation-one', title: '订单模块', owner: { id: 'someone', displayName: '成员', username: 'other' } }], nextOffset: null });
  await f.reply(1, { items: [] }, 200); await f.reply(2, { items: [], hasMore: false }); await pending;
  assert.ok(f.requests.every((request) => !request.options.method));
  assert.ok(!f.requests.some((request) => /\/(?:start|open|stop)$/.test(request.url)));
  assert.equal(f.get('conversation-output-panel').hidden, false);
  f.run('closeConversationOutputs()');
  await f.run("openRequestedPhaseFiles('missing')");
  assert.match(f.get('system-warning').textContent, /没有可查看的对应对话/);
  assert.equal(f.get('conversation-output-panel').hidden, true);
});

const release = { availability: 'ready', occupied: true, observedAt: '2026-09-20T01:05:00Z', operation: {
  action: 'release', status: 'running', stage: 'candidate-build', taskId: 'c-alice', version: 'release-test', services: ['forge-admin'],
  startedAt: '2026-09-20T01:00:00Z', updatedAt: '2026-09-20T01:04:00Z', owner: { username: 'alice', displayName: '<img src=x onerror=alert(1)>', isSelf: false },
} };

test('project release panel shows real stages and another member without HTML or invented queue positions', async (t) => {
  const f = fixture(t); const pending = f.run('refreshReleaseStatus()');
  assert.match(f.requests[0].url, /project-release-status\?project=demo$/);
  await f.reply(0, release); await pending;
  assert.equal(f.get('release-status-heading').textContent, '正在发布');
  assert.match(f.get('release-status-details').textContent, /构建候选/);
  assert.match(f.get('release-status-details').textContent, /5 分 0 秒/);
  assert.match(f.get('release-status-details').textContent, /<img/);
  assert.match(f.get('release-status-note').textContent, /没有自动排队/);
  assert.equal(walk(f.get('release-status-details')).some((node) => node.tagName === 'IMG'), false);
});

test('release query failure clears misleading running state and a later refresh shows the final result', async (t) => {
  const f = fixture(t);
  f.run(`renderReleaseStatus(${JSON.stringify(release)})`);
  const failed = f.run('refreshReleaseStatus()');
  await f.reply(0, { message: 'unavailable' }, 503); await failed;
  assert.equal(f.get('release-status-heading').textContent, '发布状态暂不可确认');
  assert.equal(f.get('release-status-details').textContent, '');
  const resumed = f.run('refreshReleaseStatus()');
  await f.reply(1, { ...release, occupied: false, operation: { ...release.operation, status: 'success', stage: 'complete', completedAt: release.observedAt } });
  await resumed;
  assert.equal(f.get('release-status-heading').textContent, '最近一次发布成功');
  assert.match(f.get('release-status-note').textContent, /当前没有发布占用/);
});

test('project switches abort old queries and do not let late old results overwrite the new project', async (t) => {
  const f = fixture(t); const old = f.run('refreshReleaseStatus()');
  f.run("stopReleaseStatus(); state.selectedProjectSlug='second-project'; renderReleaseStatus(null)");
  const current = f.run('refreshReleaseStatus()');
  await f.reply(1, { availability: 'ready', occupied: false, observedAt: release.observedAt, operation: null });
  await current; await old;
  await f.reply(0, release);
  assert.equal(f.get('release-status-heading').textContent, '当前没有发布任务');
  assert.equal(f.requests[0].options.signal.aborted, true);
});

test('draft saving and prepared candidates are never labelled as deployed', (t) => {
  const f = fixture(t);
  f.run(`renderReleaseStatus(${JSON.stringify({ ...release, operation: { ...release.operation, action: 'checkpoint' } })})`);
  assert.match(f.get('release-status-heading').textContent, /保存草稿，尚未发布/);
  f.run(`renderReleaseStatus(${JSON.stringify({ ...release, operation: { ...release.operation, status: 'prepared' } })})`);
  assert.match(f.get('release-status-heading').textContent, /候选已验证，尚未发布/);
});
