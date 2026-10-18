import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('../docker/harness/conversation-gateway/gateway.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../docker/harness/conversation-gateway/index.html', import.meta.url), 'utf8');
const walk = element => [element, ...element.children.flatMap(walk)];
function fixture() {
  class Element extends EventTarget {
    constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.ownText = ''; this.hidden = false; this.attributes = {}; }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    append(...elements) { this.children.push(...elements); }
    replaceChildren(...elements) { this.children = elements; this.ownText = ''; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    focus() {}
  }
  const nodes = new Map([...markup.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(([html, tag, id]) => {
    const element = new Element(tag); element.hidden = /\bhidden\b/.test(html); return [`#${id}`, element];
  }));
  const document = { querySelector: selector => nodes.get(selector), createElement: tag => new Element(tag), body: { classList: { add() {}, remove() {} } } };
  const context = vm.createContext({ document, URL, URLSearchParams, AbortController, Blob, Intl, setTimeout, clearTimeout, window: { location: { href: 'http://example/forge-gateway/' }, history: { pushState() {} } } });
  vm.runInContext(source.slice(0, source.indexOf('for (const closeButton of')), context);
  const run = script => vm.runInContext(script, context);
  run("refreshReleaseStatus=()=>{};loadConversations=async()=>{};state.session={user:{id:'member',role:'member'}};");
  return { run, get: id => nodes.get(`#${id}`) };
}
const projects = [
  { slug: 'forge-base', displayName: '示例客户', projectKind: 'foundation', managerReady: true, canEnter: false, ownConversationCount: 0, forgeUiUrl: '/business' },
  { slug: 'other-project', displayName: '其他项目', projectKind: 'delivery', managerReady: true, canEnter: true, ownConversationCount: 0, forgeUiUrl: '/other' },
];
test('project-card entry follows server projects without replacing business access control', () => {
  const f = fixture(); f.run(`state.projects=${JSON.stringify(projects)};renderProjects();`);
  const cards = f.get('project-list').children; assert.equal(cards.length, 2);
  const links = walk(cards[0]).filter(item => item.tagName === 'A' && item.textContent === '需求与交付中心');
  assert.equal(links.length, 1); assert.equal(links[0].href, '/forge-gateway/delivery-center?project=forge-base');
  assert.equal(walk(cards[0]).find(item => item.tagName === 'BUTTON' && item.textContent === '进入项目').disabled, true);
  assert.equal(walk(cards[1]).find(item => item.tagName === 'A' && item.textContent === '需求与交付中心').href, '/forge-gateway/delivery-center?project=other-project');
});
test('conversation toolbar keeps the delivery center scoped to the selected project and hides it in the directory', async () => {
  const f = fixture(); f.run(`state.projects=${JSON.stringify(projects.map(item => ({ ...item, canEnter: true })))};`);
  await f.run("selectProject('forge-base')"); assert.equal(f.get('project-delivery-link').hidden, false);
  await f.run("selectProject('other-project')"); assert.equal(f.get('project-delivery-link').hidden, false);
  assert.equal(f.get('project-delivery-link').href, '/forge-gateway/delivery-center?project=other-project');
  f.run("showProjectDirectory()"); assert.equal(f.get('project-delivery-link').hidden, true);
  const header = markup.slice(markup.indexOf('<header'), markup.indexOf('</header>')); assert.doesNotMatch(header, /delivery-center/);
  const toolbar = markup.slice(markup.indexOf('class="heading-actions"'), markup.indexOf('id="project-access-note"'));
  assert.match(toolbar, /new-conversation-button[\s\S]*project-delivery-link/);
  assert.doesNotMatch(markup, /production-delivery/);
});
test('project delivery links encode the selected slug as one query value', async () => {
  const f = fixture(); const slug = 'customer/a&b';
  f.run(`state.projects=[${JSON.stringify({ ...projects[1], slug })}];`);
  await f.run(`selectProject(${JSON.stringify(slug)})`);
  const links = [f.get('project-delivery-link'), ...walk(f.get('project-list')).filter(item => item.tagName === 'A' && item.textContent === '需求与交付中心')];
  for (const link of links) {
    const url = new URL(link.href, 'http://example');
    assert.equal(url.searchParams.get('project'), slug); assert.equal([...url.searchParams].length, 1);
  }
});
