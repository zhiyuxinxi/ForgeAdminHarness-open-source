import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const outputSource = await readFile(new URL('../docker/harness/conversation-output.js', import.meta.url), 'utf8');
const uploadSource = await readFile(new URL('../docker/harness/project-file-upload.js', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const walk = (node) => [node, ...node.children.flatMap(walk)];

// Only the injected assets' DOM surface is modeled; no browser or live session is used.
function fixture(t, initialSession = 'session-one') {
  let document;
  class Element extends EventTarget {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.hidden = false;
      this.disabled = false;
      this.open = false;
      this.ownText = '';
    }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
    set innerHTML(_value) { throw new Error('HTML execution surface used'); }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
    get isConnected() { return walk(document).includes(this); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click', { cancelable: true })); }
    contains(node) { return walk(this).includes(node); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    querySelectorAll(selector) {
      if (selector.includes(' ')) {
        const [parent, ...child] = selector.split(' ');
        return this.querySelectorAll(parent).flatMap((node) => node.querySelectorAll(child.join(' ')));
      }
      const match = /^([^\[]*)\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
      return walk(this).slice(1).filter((node) => {
        if (!match) return selector.startsWith('.')
          ? node.className.split(' ').includes(selector.slice(1)) : node.tagName === selector.toUpperCase();
        const [, tag, attribute, expected] = match;
        if (tag && node.tagName !== tag.toUpperCase()) return false;
        const dataKey = attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        const actual = attribute.startsWith('data-') ? node.dataset[dataKey] : node.getAttribute(attribute);
        return expected === undefined ? actual !== undefined && actual !== null : actual === expected;
      });
    }
  }
  class Textarea extends Element {
    constructor() { super('textarea'); this.currentValue = ''; }
    get value() { return this.currentValue; }
    set value(value) { this.currentValue = value; }
  }
  class Custom extends Event {
    constructor(type, options = {}) { super(type, options); this.detail = options.detail; this.data = options.data; }
  }
  document = new Element('document');
  document.head = new Element('head');
  document.body = new Element('body');
  document.createElement = (tag) => tag === 'textarea' ? new Textarea() : new Element(tag);
  document.append(document.head, document.body);
  const card = new Element('div');
  card.dataset.composerCard = 'true';
  const slot = new Element('div');
  slot.dataset.slot = 'conversation.input.left';
  const textarea = new Textarea();
  textarea.setAttribute('placeholder', '发送消息');
  card.append(slot, textarea);
  document.body.append(card);
  const window = new EventTarget();
  const stored = new Map();
  const setSession = (id) => stored.set('dsh.sessions.current', JSON.stringify({ sessionId: id }));
  setSession(initialSession);
  const requests = [];
  const observers = [];
  const frames = [];
  const context = vm.createContext({
    document, window, HTMLElement: Element, HTMLTextAreaElement: Textarea,
    CustomEvent: Custom, InputEvent: Custom, URL, URLSearchParams, AbortController,
    TypeError, SyntaxError, setTimeout, clearTimeout, Intl,
    localStorage: { getItem: (key) => stored.get(key) ?? null },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(_root, options) { this.options = options; observers.push(this); }
    },
    requestAnimationFrame: (callback) => frames.push(callback),
    fetch: (url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve: (payload, status = 200) => resolve({
        ok: status >= 200 && status < 300, status,
        json: async () => payload, text: async () => payload,
      }) });
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  vm.runInContext(uploadSource, context);
  vm.runInContext(outputSource, context);
  const dialog = walk(document).find((node) => node.tagName === 'DIALOG');
  const find = (text) => walk(document).find((node) => node.tagName === 'BUTTON' && node.textContent === text);
  const feedback = () => walk(document).find((node) => node.className === 'forge-output-status');
  t.after(async () => { dialog.close(); await tick(); });
  return { document, dialog, textarea, requests, context, setSession, window, find, feedback,
    observers,
    flushDom: () => { for (const observer of observers) observer.callback([]); for (const callback of frames.splice(0)) callback(); },
    open: () => find('对话文件').click(),
    reply: async (index, payload, status) => { requests[index].resolve(payload, status); await tick(); },
  };
}

function archive(snapshotId = 'snapshot-1', status = 'completed', sessionId = 'session-one') {
  return { sessionId, snapshotId, status, createdAt: '2026-09-15T01:00:00.000Z', lastSeq: 12,
    files: [{ name: '对话记录.md', mediaType: 'text/markdown', sha256: 'a'.repeat(64), bytes: 34,
      modelPath: `/project-outputs/${sessionId}/${snapshotId}/对话记录.md` }],
  };
}
function page(items, offset = 0, hasMore = false) { return { ok: true, items, offset, limit: 20, hasMore }; }

test('Chinese presentation names label preview, download and reference without changing canonical paths', async (t) => {
  const f = fixture(t);
  f.open();
  const item = archive('a'.repeat(64));
  Object.assign(item.files[0], { name: 'conversation.md', displayName: '完整聊天记录.md', downloadName: '聊天记录_20260915.md',
    phaseLabel: '对话记录（未关联阶段）', usageLabel: '阅读与回顾', usageHint: '先阅读这份记录。', versionLabel: '09月15日 09:00 · 版本 aaaaaaaa', primary: true });
  await f.reply(0, page([item]));
  assert.match(f.dialog.textContent, /完整聊天记录.md.*先看这份/);
  assert.match(f.dialog.textContent, /对话记录（未关联阶段）.*阅读与回顾/);
  const link = walk(f.dialog).find((node) => node.tagName === 'A');
  assert.equal(link.download, '聊天记录_20260915.md');
  assert.match(link.href, /\/conversation.md\?download=1$/);
  assert.equal(f.find('预览').getAttribute('aria-label'), '预览 完整聊天记录.md');
  f.find('预览').click();
  await f.reply(1, '只读预览');
  assert.match(f.dialog.textContent, /文本预览 · 完整聊天记录.md/);
  assert.equal(f.find('引用').getAttribute('aria-label'), '引用 完整聊天记录.md，插入输入框但不发送');
});

test('phase entry requires an advertised HTTP gateway URL and disappears on session change', async (t) => {
  const f = fixture(t);
  f.open();
  await f.reply(0, { ...page([]), phaseFilesUrl: 'javascript:alert(1)' });
  assert.equal(walk(f.dialog).some((node) => node.tagName === 'A'), false);
  f.find('刷新').click();
  await f.reply(1, { ...page([]), phaseFilesUrl: 'https://gateway.example/forge-gateway/?project=demo&phaseFiles=conversation-one' });
  const link = walk(f.dialog).find((node) => node.tagName === 'A');
  assert.equal(link.textContent, '查看阶段成果');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.target, '_blank');
  f.setSession('session-two');
  f.window.dispatchEvent(new Event('focus'));
  assert.equal(walk(f.dialog).some((node) => node.tagName === 'A'), false);
  await f.reply(2, page([]));
});

test('dialog uses the existing composer entry and stays empty without a selected session', async (t) => {
  const f = fixture(t, '');
  f.open();
  assert.equal(f.dialog.open, true);
  assert.equal(f.dialog.getAttribute('aria-labelledby'), 'forge-conversation-output-title');
  assert.equal(f.document.activeElement.id, 'forge-conversation-output-title');
  assert.equal(f.find('保存当前记录').disabled, true);
  assert.equal(f.requests.length, 0);
  assert.match(f.dialog.textContent, /请先打开一个对话/);
  f.find('关闭').click();
  await tick();
  assert.equal(f.document.activeElement, f.find('对话文件'));
});

test('lists real statuses, preserves pending controls, and appends one requested page', async (t) => {
  const f = fixture(t);
  f.open();
  assert.equal(f.find('刷新').disabled, true);
  assert.match(f.feedback().textContent, /正在读取/);
  await f.reply(0, page(['completed', 'running', 'failed', 'stopped', 'empty'].map((status, index) => archive(`snapshot-${index}`, status)), 0, true));
  for (const label of ['已完成', '进行中', '失败', '已停止', '空']) assert.ok(f.dialog.textContent.includes(label));
  f.find('加载更多').click();
  f.find('加载更多').click();
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].url, /offset=5&limit=20$/);
  await f.reply(1, page([archive('snapshot-six')], 5));
  assert.match(f.feedback().textContent, /6 份记录/);
  assert.equal(f.find('加载更多').hidden, true);
});

test('save sends only the selected session once, then refreshes with honest archive status', async (t) => {
  const f = fixture(t);
  f.open();
  await f.reply(0, page([]));
  f.find('保存当前记录').click();
  f.find('保存当前记录').click();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].url, '/forge-output/snapshots');
  assert.equal(f.requests[1].options.method, 'POST');
  assert.equal(f.requests[1].options.body, '{"sessionId":"session-one"}');
  assert.match(f.feedback().textContent, /正在保存/);
  await f.reply(1, { ok: true, archive: archive('saved', 'failed') });
  await f.reply(2, page([archive('saved', 'failed')]));
  assert.match(f.feedback().textContent, /记录已保存 · 失败/);
  assert.equal(f.find('保存当前记录').disabled, false);
});

test('API errors remain actionable and do not echo private server error bodies', async (t) => {
  const f = fixture(t);
  f.open();
  await f.reply(0, { message: 'server-private-secret' }, 403);
  assert.match(f.feedback().textContent, /无权访问/);
  assert.ok(!f.dialog.textContent.includes('server-private-secret'));
  assert.equal(f.find('刷新').disabled, false);
  f.find('刷新').click();
  await f.reply(1, page([]));
  assert.match(f.feedback().textContent, /尚未保存/);
});

test('preview treats HTML as text and downloads only a constructed same-origin file URL', async (t) => {
  const f = fixture(t);
  f.open();
  const item = archive();
  item.files[0].name = '<script>&.html';
  item.files[0].mediaType = 'text/html';
  await f.reply(0, page([item]));
  const link = walk(f.dialog).find((node) => node.tagName === 'A');
  assert.equal(link.href, '/forge-output/files/session-one/snapshot-1/%3Cscript%3E%26.html?download=1');
  f.find('预览').click();
  await f.reply(1, '<script>globalThis.secret = true</script>');
  const text = walk(f.dialog).find((node) => node.tagName === 'PRE');
  assert.equal(text.textContent, '<script>globalThis.secret = true</script>');
  assert.equal(f.context.secret, undefined);
  f.find('收起预览').click();
  assert.equal(f.document.activeElement, f.find('预览'));
});

test('a switched session cancels old results and cannot reference the old conversation', async (t) => {
  const f = fixture(t);
  f.open();
  f.setSession('session-two');
  f.window.dispatchEvent(new Event('focus'));
  await f.reply(0, page([archive('old-private') ]));
  await f.reply(1, page([archive('new-record', 'running', 'session-two')]));
  assert.ok(!f.dialog.textContent.includes('old-private'));
  assert.match(f.dialog.textContent, /new-record/);
  const event = new f.context.CustomEvent('forge-conversation-output-reference', {
    cancelable: true, detail: { sessionId: 'session-one', modelPath: '/project-outputs/old.md' },
  });
  assert.equal(f.document.dispatchEvent(event), true);
  assert.equal(f.textarea.value, '');
});

test('reference reuses the actual upload composer setter, preserves draft, and never sends', async (t) => {
  const f = fixture(t);
  f.textarea.value = '已有草稿';
  let inputs = 0;
  let submits = 0;
  f.textarea.addEventListener('input', () => { inputs += 1; });
  f.document.addEventListener('submit', () => { submits += 1; });
  f.open();
  await f.reply(0, page([archive()]));
  f.find('引用').click();
  await tick();
  assert.match(f.textarea.value, /^已有草稿\n\n请读取以下对话文件/);
  assert.ok(f.textarea.value.includes('/project-outputs/session-one/snapshot-1/对话记录.md'));
  assert.equal(inputs, 1);
  assert.equal(submits, 0);
  assert.equal(f.dialog.open, false);
  assert.equal(f.document.activeElement, f.textarea);
  assert.equal(f.requests.length, 1);
});

test('a forged file path is rejected before creating download or reference controls', async (t) => {
  const f = fixture(t);
  f.open();
  const item = archive();
  item.files[0].name = '../private.env';
  await f.reply(0, page([item]));
  assert.match(f.feedback().textContent, /文件列表格式异常/);
  assert.equal(f.find('引用'), undefined);
  assert.equal(walk(f.dialog).some((node) => node.tagName === 'A'), false);
});

function codeMessage(f, kind, content) {
  const element = (tag, text) => {
    const node = f.document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // Pinned 0.1.1-rc.2 ChatView -> AssistantMarkdown -> CodeBlock structure.
  const row = element('div');
  row.dataset.chatFlowKind = kind;
  const explanation = element('p', '业务结果：接口尚未完成。阻塞：等待用户提供字段定义。');
  const block = element('div');
  block.className = 'md-code-block';
  const banner = element('div');
  const nativeCopy = element('button', '复制');
  banner.append(nativeCopy);
  const pre = element('pre');
  const code = element('code', content);
  pre.append(code);
  block.append(banner, pre);
  const stopped = element('span', '已停止');
  row.append(explanation, block, stopped);
  f.document.body.append(row);
  return { row, block, banner, pre, code, nativeCopy, explanation, stopped, element };
}

test('only long assistant code is bounded; business text, stopped state and copy source stay intact', (t) => {
  const f = fixture(t);
  const content = `{\n${Array.from({ length: 24 }, (_, index) => `  "field${index}": ${index}`).join(',\n')}\n}`;
  const message = codeMessage(f, 'assistant-step', content);
  const short = codeMessage(f, 'assistant-step', '{"small":true}');
  const user = codeMessage(f, 'user-message', content);
  f.flushDom();
  assert.equal(message.block.dataset.forgeCodeCollapsed, 'true');
  assert.equal(short.block.dataset.forgeCodeCollapsed, undefined);
  assert.equal(user.block.dataset.forgeCodeCollapsed, undefined);
  assert.deepEqual(message.block.children.slice(0, 2), [message.banner, message.pre]);
  assert.equal(message.pre.parent, message.block);
  assert.equal(message.pre.textContent, content, 'native CodeBlock copy reads this exact unchanged pre text');
  assert.equal(message.explanation.hidden, false);
  assert.match(message.explanation.textContent, /业务结果.*阻塞/);
  assert.equal(message.stopped.hidden, false);
  const toggle = f.find('展开完整代码');
  assert.equal(toggle.getAttribute('aria-controls'), message.pre.id);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(!message.row.textContent.includes('已归档'));
  assert.equal(f.requests.length, 0, 'presentation must not collect or save DOM content');
});

test('streaming and highlight replacement preserve expansion and bind the live full text', (t) => {
  const f = fixture(t);
  const message = codeMessage(f, 'assistant-step', '<html>\n' + '  <p>原文</p>\n'.repeat(20) + '</html>');
  f.flushDom();
  const toggle = f.find('展开完整代码');
  toggle.click();
  assert.equal(message.block.dataset.forgeCodeCollapsed, 'false');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const highlighted = message.element('div');
  const nextPre = message.element('pre');
  const nextCode = message.element('code', message.pre.textContent + '\n<!-- 后续流式输出 -->');
  nextPre.append(nextCode);
  highlighted.append(nextPre);
  message.block.replaceChildren(message.banner, highlighted);
  f.flushDom();
  assert.equal(f.find('收起长代码'), toggle);
  assert.equal(message.block.dataset.forgeCodeCollapsed, 'false');
  assert.equal(toggle.getAttribute('aria-controls'), nextPre.id);
  assert.match(nextPre.textContent, /后续流式输出/);
  toggle.click();
  assert.equal(message.block.dataset.forgeCodeCollapsed, 'true');
  nextCode.textContent = '<p>短内容</p>';
  f.flushDom();
  assert.equal(message.block.dataset.forgeCodeCollapsed, undefined);
  assert.equal(toggle.parent.hidden, true);
  assert.ok(f.observers.some((observer) => observer.options.characterData === true));
});

test('the long-code file entry opens the same archive dialog and reports real automatic-save failure', async (t) => {
  const f = fixture(t);
  const message = codeMessage(f, 'assistant-step', 'x'.repeat(2500));
  f.flushDom();
  const files = message.block.querySelectorAll('button').find((node) => node.textContent === '对话文件');
  files.click();
  assert.equal(f.dialog.open, true);
  assert.match(f.requests[0].url, /sessionId=session-one/);
  await f.reply(0, { ...page([]), automatic: { status: 'failed' } });
  assert.match(f.feedback().textContent, /自动归档失败/);
  assert.match(f.dialog.textContent, /管理员可查阅/);
  assert.ok(!f.feedback().textContent.includes('记录已保存'));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.method, undefined);
  f.find('关闭').click();
  await tick();
  assert.equal(f.document.activeElement, files);
});
