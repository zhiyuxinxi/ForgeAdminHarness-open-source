import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../docker/harness/conversation-gateway/platform-value.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../docker/harness/conversation-gateway/platform-value.html', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const walk = (node) => [node, ...node.children.flatMap(walk)];

// Reuses the repository's delivery-center-ui fixture approach; only the DOM
// primitives needed by this page are modeled. This is not browser visual QA.
function fixture({ hash = '#overview', mobile = false } = {}) {
  const document = new EventTarget();
  class Element extends EventTarget {
    constructor(tag, nodeType = 1) {
      super(); this.tagName = tag.toUpperCase(); this.nodeType = nodeType;
      this.children = []; this.attributes = {}; this.ownText = ''; this.hidden = false;
      this.value = ''; this.dataset = {}; this.open = false; this.parentElement = null;
    }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
    set innerHTML(_value) { throw new Error('unsafe HTML insertion'); }
    set href(value) { this.attributes.href = value; }
    get href() { return this.attributes.href; }
    get options() { return this.children.filter((child) => child.tagName === 'OPTION'); }
    append(...nodes) {
      nodes.forEach((node) => {
        if (node.nodeType === 11) { this.append(...node.children); return; }
        node.parentElement = this; this.children.push(node);
      });
    }
    replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    focus() { document.activeElement = this; }
    closest(selector) {
      for (let current = this; current; current = current.parentElement) {
        if (selector === 'a[href^="#"]' && current.tagName === 'A' && current.href?.startsWith('#')) return current;
        if (selector === '#pv-tree' && current.id === 'pv-tree') return current;
      }
      return null;
    }
    click() {
      if (this.disabled) return;
      this.dispatchEvent(new Event('click'));
      const event = new Event('click', { cancelable: true });
      Object.defineProperty(event, 'target', { value: this });
      document.dispatchEvent(event);
    }
  }
  const nodes = new Map([...markup.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(([html, tag, id]) => {
    const node = new Element(tag); node.id = id; node.hidden = /\bhidden\b/.test(html); return [id, node];
  }));
  ['pv-status-filter', 'pv-update-type', 'pv-update-date'].forEach((id) => { nodes.get(id).value = 'all'; });
  document.getElementById = (id) => nodes.get(id);
  document.createElement = (tag) => new Element(tag);
  document.createDocumentFragment = () => new Element('#fragment', 11);
  document.createTextNode = (text) => { const node = new Element('#text', 3); node.textContent = text; return node; };
  const window = new EventTarget();
  const location = { get hash() { return hash; }, set hash(next) { hash = next; window.dispatchEvent(new Event('hashchange')); } };
  window.matchMedia = () => ({ matches: mobile });
  window.location = location;
  const requests = [];
  const context = vm.createContext({ document, window, location, Intl, Date, console,
    fetch: (url, options) => new Promise((resolve) => requests.push({ url, options, resolve }))
  });
  vm.runInContext(source, context);
  return { document, window, location, requests, get: (id) => nodes.get(id),
    async reply(index, value, status = 200) {
      requests[index].resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }));
      await tick();
    },
    async loaded() { await this.reply(0, catalog); await this.reply(1, updates); return this; },
    input(id, value, event = 'input') { const node = nodes.get(id); node.value = value; node.dispatchEvent(new Event(event)); }
  };
}

const features = [
  { id: 'project-space', title: '项目隔离', summary: '减少项目互相影响', before: '自己分开目录和环境', after: '平台准备独立空间', benefits: ['减少环境冲突'], limitations: ['首次准备需要等待'], status: 'available', since: '2026 年 9 月', roles: ['developer'] },
  { id: 'checks', title: '检查与验收', summary: '结果有依据', before: '手工整理检查结果', after: '按范围收集检查结果', benefits: ['减少遗漏'], limitations: ['仍需业务确认'], status: 'partial', since: '2026 年 10 月', roles: ['owner'] },
  { id: 'style', title: '<img src=x onerror=alert(1)>页面一致性', summary: '正在完善规范', before: '多次生成不同风格', after: '统一生成参考', benefits: ['减少返工'], limitations: ['正在建设'], status: 'in-progress', since: '尚未全面上线', roles: ['developer'] }
];
const catalog = { schemaVersion: 1, asOf: '2026-10-10', categories: [
  { id: 'collaboration', title: '团队开展工作', summary: '减少重复准备和反复沟通', groups: [
    { id: 'isolation', title: '空间与协作', features: [features[0]] },
    { id: 'quality', title: '质量与一致性', features: features.slice(1) }
  ] }
], roles: [
  { id: 'developer', title: '研发人员', need: '准备环境', value: '复用环境', responsibility: '技术判断' },
  { id: 'owner', title: '产品负责人', need: '核对需求', value: '跟踪成果', responsibility: '业务验收' }
], phases: [{ id: 'requirements', title: '需求澄清', userProvides: '业务目标', platformDoes: '整理需求', userGets: '需求说明', boundary: '需要人工确认' }],
tools: [{ id: 'tool-one', name: '打包工具', kind: 'tool', purpose: '准备发布成果', status: 'available', categoryId: 'collaboration' }],
milestones: [{ period: '2026 年 9 月', title: '项目分开开展', description: '逐步建立隔离能力' }],
journey: [{ id: 'separate-projects', title: '两个项目分开做', period: '2026 年 9 月', problem: '自己辨认项目文件', result: '减少把修改带错项目', example: '甲乙项目同时开展', changes: ['准备独立项目空间'], featureIds: ['project-space'] }] };
const updates = { schemaVersion: 1, asOf: '2026-10-10', updates: [
  { id: 'isolation-launch', date: '2026-10-09', type: 'new', title: '项目可以分别开展', before: '不同项目容易混入', after: '建立项目空间', benefit: '减少相互影响', scope: '已升级的试点项目', status: 'released', featureIds: ['project-space'], roles: ['developer'] },
  { id: 'checks-fix', date: '2026-10-08', type: 'fixed', title: '修复检查结果展示', before: '已完成结果未显示', after: '准确读取结果', benefit: '减少重复等待', scope: '当前版本工作台', status: 'partial', featureIds: ['checks'], roles: ['owner'] }
] };

test('overview uses loaded counts, role value and stage evidence; content stays text under strict CSP', async () => {
  const f = await fixture().loaded();
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(({ options }) => options.cache === 'no-store' && options.credentials === 'same-origin'));
  const body = f.get('pv-catalog-content');
  assert.match(body.textContent, /两个项目分开做.*自己辨认项目文件.*减少把修改带错项目.*甲乙项目同时开展/);
  assert.ok(body.textContent.indexOf('两个项目分开做') < body.textContent.indexOf('已登记的能力'), 'explain the work before presenting counts');
  assert.ok(walk(body).some((node) => node.href === '#feature/project-space'), 'the explanation leads to its detailed capability');
  assert.match(body.textContent, /研发人员.*复用环境.*技术判断/);
  assert.match(body.textContent, /业务目标.*整理需求.*需求说明/);
  const stats = walk(body).find((node) => node.className === 'pv-stats');
  assert.deepEqual(stats.children.map((node) => node.textContent), ['3已登记的能力', '1可用', '1部分可用', '1建设中']);
  assert.match(body.textContent, /节省工时要扣除新增检查和维护的人工投入/);
  assert.match(body.textContent, /不能因为平台提供了更多能力/);
  f.location.hash = '#feature/style';
  assert.match(body.textContent, /<img src=x onerror=alert\(1\)>页面一致性/);
  assert.equal(walk(body).some((node) => node.tagName === 'IMG'), false);
  assert.doesNotMatch(markup, /\son\w+=|<script[^>]*>\s*[^<\s]/i);
});

test('search matches user language and role names; status filtering and empty recovery remain local', async () => {
  const f = await fixture().loaded();
  f.input('pv-search', '项目隔离');
  assert.match(f.get('pv-search-status').textContent, /找到 1 项/);
  assert.equal(walk(f.get('pv-catalog-content')).filter((node) => node.dataset.featureId).length, 1);
  f.input('pv-search', '研发人员');
  assert.match(f.get('pv-search-status').textContent, /找到 2 项/);
  f.input('pv-search', '');
  f.input('pv-status-filter', 'partial', 'change');
  assert.match(f.get('pv-catalog-content').textContent, /检查与验收/);
  assert.doesNotMatch(f.get('pv-catalog-content').textContent, /项目隔离/);
  f.input('pv-search', '不存在的能力');
  const clear = walk(f.get('pv-catalog-content')).find((node) => node.tagName === 'BUTTON');
  assert.match(f.get('pv-catalog-content').textContent, /没有找到符合条件/);
  clear.click();
  assert.equal(f.get('pv-status-filter').value, 'all');
  assert.match(f.get('pv-catalog-content').textContent, /团队里的每个角色/);
  assert.equal(f.requests.length, 2);
});

test('three-level links, update filters and related ability navigation preserve real release scope', async () => {
  const f = await fixture({ mobile: true }).loaded();
  const projectLink = walk(f.get('pv-tree')).find((node) => node.href === '#feature/project-space');
  projectLink.click();
  assert.equal(f.location.hash, '#feature/project-space');
  assert.equal(f.get('pv-navigation').open, false);
  assert.equal(f.document.activeElement, f.get('pv-catalog-content'));
  assert.match(f.get('pv-catalog-content').textContent, /约略上线：2026 年 9 月/);
  f.location.hash = '#category/collaboration';
  assert.equal(walk(f.get('pv-catalog-content')).filter((node) => node.dataset.featureId).length, 3);
  f.get('pv-updates-tab').click();
  assert.equal(f.get('pv-catalog-panel').hidden, true);
  assert.equal(f.get('pv-updates-tab').getAttribute('aria-selected'), 'true');
  assert.match(f.get('pv-updates-content').textContent, /已在注明范围上线.*适用范围：已升级的试点项目/);
  f.input('pv-update-type', 'fixed', 'change');
  assert.match(f.get('pv-updates-content').textContent, /修复检查结果展示/);
  assert.doesNotMatch(f.get('pv-updates-content').textContent, /项目可以分别开展/);
  f.input('pv-update-date', '2026-10-09', 'change');
  assert.match(f.get('pv-updates-content').textContent, /当前条件下没有更新记录/);
  f.get('pv-updates-reset').click();
  walk(f.get('pv-updates-content')).find((node) => node.href === '#feature/checks').click();
  assert.equal(f.get('pv-updates-panel').hidden, true);
  assert.match(f.get('pv-catalog-content').textContent, /检查与验收.*仍需业务确认/);
  assert.equal(f.requests.length, 2);
});

test('an independent content failure keeps available updates readable and retry reloads only the failed file', async () => {
  const f = fixture({ hash: '#updates' });
  await f.reply(0, { error: 'unavailable' }, 503);
  await f.reply(1, updates);
  assert.equal(f.get('pv-error').hidden, false);
  assert.match(f.get('pv-error-message').textContent, /功能清单/);
  assert.match(f.get('pv-updates-content').textContent, /项目可以分别开展/);
  f.get('pv-retry').click();
  assert.equal(f.requests.length, 3);
  assert.match(f.requests[2].url, /platform-catalog.json$/);
  await f.reply(2, catalog);
  assert.equal(f.get('pv-error').hidden, true);
  assert.equal(f.get('pv-updates-panel').getAttribute('aria-busy'), 'false');
  const key = new Event('keydown', { cancelable: true });
  Object.defineProperty(key, 'key', { value: 'Home' });
  f.get('pv-updates-tab').dispatchEvent(key);
  assert.equal(f.get('pv-catalog-tab').getAttribute('aria-selected'), 'true');
  assert.equal(f.document.activeElement, f.get('pv-catalog-tab'));
  assert.equal(f.requests.length, 3);
});
