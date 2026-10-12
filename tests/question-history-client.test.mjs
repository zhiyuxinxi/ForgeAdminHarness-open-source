import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../docker/harness/forge-question-history-client.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const children = node => [node?.props?.children].flat(Infinity).filter(value => value !== false && value != null);
const walk = node => typeof node === 'object' && node !== null ? [node, ...children(node).flatMap(walk)] : [];
const text = node => typeof node === 'object' && node !== null ? children(node).map(text).join('') : String(node ?? '');
const page = (items, total = items.length, nextCursor = null) => ({ forgeQuestions: { items, total, nextCursor } });

// Model only this component's hooks, JSX nodes and document events. These are
// component behavior checks, not browser layout or live Harness acceptance.
function fixture(t) {
  let index = 0, dirty = true, mounted = true, tree, writesAfterUnmount = 0;
  const slots = [], effects = [], requests = [], jumps = [], listeners = new Map();
  const document = {
    activeElement: null,
    querySelector: () => ({}), // Skip the stylesheet's independent installation.
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type, callback) => { if (listeners.get(type) === callback) listeners.delete(type); },
  };
  const react = {
    useState(initial) {
      const position = index++;
      if (!(position in slots)) slots[position] = initial;
      return [slots[position], value => {
        if (!mounted) { writesAfterUnmount++; return; }
        slots[position] = typeof value === 'function' ? value(slots[position]) : value;
        dirty = true;
      }];
    },
    useRef(initial) {
      const position = index++;
      return slots[position] ??= { current: initial };
    },
    useEffect(callback, dependencies) {
      const position = index++;
      const previous = slots[position];
      if (!previous || dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]))) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[position] = { dependencies, cleanup: callback() };
        });
      }
    },
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const context = vm.createContext({ react, react_jsx_runtime: { jsx, jsxs: jsx }, document });
  vm.runInContext(source, context);
  let props = {
    sessionId: 'session-one', historyRevision: 0,
    loadQuestionHistory: options => new Promise((resolve, reject) => {
      requests.push({ options: { ...options }, sessionId: props.sessionId, resolve, reject });
    }),
    jump: seq => new Promise((resolve, reject) => jumps.push({ seq, resolve, reject })),
  };
  const flush = () => {
    let renders = 0;
    while (mounted && dirty) {
      assert.ok(++renders < 20, 'component should settle without a render loop');
      dirty = false;
      index = 0;
      tree = context.ForgeQuestionHistory(props);
      for (const node of walk(tree)) {
        node.focus = () => { document.activeElement = node; };
        node.contains = target => walk(node).includes(target);
        if (node.props.ref) node.props.ref.current = node;
      }
      for (const effect of effects.splice(0)) effect();
    }
  };
  const byClass = name => walk(tree).find(node => node.props.className === name);
  const button = label => walk(tree).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
  const click = node => { assert.ok(node, 'requested button exists'); if (!node.props.disabled) node.props.onClick(); flush(); };
  const unmount = () => {
    if (!mounted) return;
    for (const slot of slots) slot?.cleanup?.();
    mounted = false;
  };
  t.after(unmount);
  flush();
  return {
    requests, jumps, document, button, click, byClass, unmount,
    open: () => click(byClass('forge-question-history-trigger')),
    update: values => { props = { ...props, ...values }; dirty = true; flush(); },
    settle: async (request, value, failure = false) => { request[failure ? 'reject' : 'resolve'](value); await tick(); flush(); },
    outside: target => { listeners.get('pointerdown')?.({ target }); flush(); },
    escape: () => {
      const event = { key: 'Escape', preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      tree.props.onKeyDown(event); flush(); return event;
    },
    get items() { return walk(tree).filter(node => node.props.className === 'forge-question-history-item'); },
    get content() { return text(tree); },
    get expanded() { return byClass('forge-question-history-trigger').props['aria-expanded']; },
    get lateWrites() { return writesAfterUnmount; },
    get listenerCount() { return listeners.size; },
  };
}

test('opens the current question list and jumps to the selected sequence before closing', async t => {
  const f = fixture(t);
  assert.equal(f.requests.length, 0);
  assert.equal(f.expanded, false);
  f.open();
  assert.equal(f.expanded, true);
  assert.deepEqual(f.requests[0].options, { forgeView: 'questions' });
  assert.match(f.content, /正在加载/);
  await f.settle(f.requests[0], page([{ seq: 90, text: '最新提问' }, { seq: 12, text: '' }]));
  assert.match(f.content, /历史提问（2）/);
  assert.deepEqual(f.items.map(node => node.props['data-forge-history-seq']), [90, 12]);
  assert.match(text(f.items[1]), /图片或附件消息/);
  f.click(f.items[1]);
  assert.equal(f.jumps[0].seq, 12);
  assert.equal(f.expanded, true);
  assert.ok(f.items.every(node => node.props.disabled));
  await f.settle(f.jumps[0]);
  assert.equal(f.expanded, false);
  assert.equal(f.byClass('forge-question-history-panel'), undefined);
  assert.equal(f.listenerCount, 0);
});

test('loads earlier questions by cursor, deduplicates overlap and retries the failed page', async t => {
  const f = fixture(t);
  f.open();
  await f.settle(f.requests[0], page([{ seq: 90, text: '九十' }, { seq: 70, text: '七十' }], 3, 70));
  f.click(f.button('加载更早提问'));
  assert.deepEqual(f.requests[1].options, { forgeView: 'questions', beforeSeq: 70 });
  await f.settle(f.requests[1], new Error('offline'), true);
  assert.match(f.content, /历史提问加载失败，请重试/);
  assert.equal(f.items.length, 2);
  f.click(f.button('重试'));
  assert.deepEqual(f.requests[2].options, { forgeView: 'questions', beforeSeq: 70 });
  await f.settle(f.requests[2], page([{ seq: 70, text: '七十' }, { seq: 10, text: '最早提问' }], 3));
  assert.deepEqual(f.items.map(node => node.props['data-forge-history-seq']), [90, 70, 10]);
  assert.match(f.content, /已显示 3 \/ 3 条/);
  assert.equal(f.button('加载更早提问'), undefined);
});

test('retries an initial load and keeps a failed jump available for another click', async t => {
  const f = fixture(t);
  f.open();
  await f.settle(f.requests[0], new Error('offline'), true);
  f.click(f.button('重试'));
  assert.deepEqual(f.requests[1].options, { forgeView: 'questions' });
  await f.settle(f.requests[1], page([{ seq: 42, text: '需要定位' }]));
  f.click(f.items[0]);
  await f.settle(f.jumps[0], new Error('location unavailable'), true);
  assert.equal(f.expanded, true);
  assert.match(f.content, /定位失败，请再次点击该提问/);
  assert.equal(f.items[0].props.disabled, false);
  f.click(f.items[0]);
  assert.equal(f.jumps[1].seq, 42);
  await f.settle(f.jumps[1]);
  assert.equal(f.expanded, false);
});

test('closing and reopening rejects an older response and supports outside click and Escape', async t => {
  const f = fixture(t);
  f.open();
  f.outside(f.button('关闭历史提问'));
  assert.equal(f.expanded, true, 'a click inside the panel must keep it open');
  f.outside({});
  assert.equal(f.expanded, false);
  f.open();
  await f.settle(f.requests[1], page([{ seq: 44, text: '当前加载' }]));
  await f.settle(f.requests[0], page([{ seq: 10, text: '已失效加载' }]));
  assert.equal(f.items[0].props['data-forge-history-seq'], 44);
  const event = f.escape();
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(f.expanded, false);
  assert.equal(f.document.activeElement.props.className, 'forge-question-history-trigger');
});

test('a late load or failed jump cannot update an unmounted component', async t => {
  const loading = fixture(t);
  loading.open();
  loading.unmount();
  assert.equal(loading.listenerCount, 0);
  await loading.settle(loading.requests[0], page([{ seq: 1, text: '已卸载' }]));
  assert.equal(loading.lateWrites, 0);
  const jumping = fixture(t);
  jumping.open();
  await jumping.settle(jumping.requests[0], page([{ seq: 1, text: '待定位' }]));
  jumping.click(jumping.items[0]);
  jumping.unmount();
  await jumping.settle(jumping.jumps[0], new Error('late jump failure'), true);
  assert.equal(jumping.lateWrites, 0);
});

test('changing session ignores the old response and renders only the new session questions', async t => {
  const f = fixture(t);
  f.open();
  f.update({ sessionId: 'session-two' });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].sessionId, 'session-two');
  assert.equal(f.byClass('forge-question-history-panel').props.id, 'forge-question-history-session-two');
  await f.settle(f.requests[1], page([{ seq: 2, text: '第二个会话' }]));
  await f.settle(f.requests[0], page([{ seq: 1, text: '第一个会话' }]));
  assert.match(f.content, /第二个会话/);
  assert.doesNotMatch(f.content, /第一个会话/);
});

test('history revision refreshes an open list, discards stale pages and defers loading while closed', async t => {
  const f = fixture(t);
  f.open();
  await f.settle(f.requests[0], page([{ seq: 10, text: '原提问' }], 2, 10));
  f.click(f.button('加载更早提问'));
  f.update({ historyRevision: 1 });
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests[2].options, { forgeView: 'questions' });
  assert.equal(f.items.length, 0);
  await f.settle(f.requests[2], page([{ seq: 20, text: '新增提问' }, { seq: 10, text: '原提问' }], 3, 10));
  await f.settle(f.requests[1], page([{ seq: 1, text: '旧分页' }], 2));
  assert.deepEqual(f.items.map(node => node.props['data-forge-history-seq']), [20, 10]);
  f.click(f.button('关闭历史提问'));
  f.update({ historyRevision: 2 });
  assert.equal(f.requests.length, 3);
  f.open();
  assert.equal(f.requests.length, 4);
  await f.settle(f.requests[3], page([]));
  assert.match(f.content, /当前对话还没有提问/);
});

test('closing during a pending jump prevents its late completion from closing the reopened list', async t => {
  const f = fixture(t);
  f.open();
  await f.settle(f.requests[0], page([{ seq: 4, text: '待定位' }]));
  f.click(f.items[0]);
  f.click(f.button('关闭历史提问'));
  f.open();
  await f.settle(f.requests[1], page([{ seq: 5, text: '重新打开' }]));
  await f.settle(f.jumps[0]);
  assert.equal(f.expanded, true);
  assert.equal(f.items[0].props['data-forge-history-seq'], 5);
});
