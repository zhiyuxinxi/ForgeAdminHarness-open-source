import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installVueTypecheckEntityCompatibility } from '../docker/harness/vue-typecheck-entity-compat.mjs';

// These API fixtures isolate the adapter's mappings. The same installed Vue
// parser and vue-tsc are exercised separately by the controlled Host consumer.
async function fixture(t, version = '3.3.11') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-vue-entity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': '{}',
    'node_modules/vue-tsc/package.json': JSON.stringify({ version, main: 'index.js' }),
    'node_modules/vue-tsc/index.js': '',
    'node_modules/@vue/language-core/package.json': JSON.stringify({ version, main: 'index.js' }),
    'node_modules/@vue/language-core/index.js': '',
    'node_modules/@vue/compiler-dom/index.js': String.raw`
exports.parse = function (text) {
  if (text.includes('parser-error')) throw new Error('original template parse error');
  const decode = text => text.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi, value => {
    const names = {'&quot;':'"', '&apos;':"'", '&amp;':'&', '&lt;':'<', '&gt;':'>'};
    return names[value] ?? String.fromCodePoint(parseInt(value.slice(value[2] === 'x' ? 3 : 2, -1), value[2] === 'x' ? 16 : 10));
  });
  const children = [];
  for (const element of text.matchAll(/<[a-z][\w-]*\s+([^>]*)>/gi)) {
    const props = [];
    for (const attr of element[1].matchAll(/(?:[:@][\w-]+|v-[\w-]+)="([^"]*)"/g)) {
      const source = attr[1];
      const start = element.index + element[0].indexOf(element[1]) + attr.index + attr[0].indexOf('"') + 1;
      props.push({ type: 7, exp: { type: 4, content: decode(source), loc: { source, start: { offset: start }, end: { offset: start + source.length } } } });
    }
    children.push({ type: 1, props, children: [] });
  }
  return { type: 0, children };
};`,
    'node_modules/@vue/language-core/lib/codegen/utils/boundary.js': String.raw`
exports.Boundary = class Boundary {
  static *start(source, start, end, data) {
    const features = { ...data, __combineToken: Symbol() };
    yield ['', source, start, features];
    return { end: () => ['', source, end, features] };
  }
};`,
    'node_modules/@vue/language-core/lib/codegen/template/interpolation.js': String.raw`
exports.generateInterpolation = function* (options, ctx, block, data, code, start, prefix = '', suffix = '') {
  if (code.includes('throwOriginal')) throw new Error('original generator error');
  yield prefix;
  const tail = code.lastIndexOf('missing');
  if (tail >= 0) {
    yield [code.slice(0, tail), block.name, start, data];
    ctx.accessVariable(block.name, 'missing', start + tail);
    const feature = { ...data, __combineToken: Symbol() };
    yield ['', block.name, start + tail, feature];
    yield '__VLS_ctx.';
    yield ['missing', block.name, start + tail, data];
    yield ['', block.name, start + tail + 7, feature];
    yield [code.slice(tail + 7), block.name, start + tail + 7, data];
  } else yield [code, block.name, start, data];
  yield suffix;
};`,
  };
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const projectRequire = createRequire(path.join(root, 'package.json'));
  const interpolationPath = path.join(root, 'node_modules/@vue/language-core/lib/codegen/template/interpolation.js');
  const interpolation = projectRequire(interpolationPath);
  return { root, files, projectRequire, interpolation, interpolationPath };
}

const textOf = chunks => chunks.map(chunk => typeof chunk === 'string' ? chunk : chunk[0]).join('');

test('Vue 3.3.11 entity adapter decodes only real attribute expressions and maps original positions', async t => {
  const f = await fixture(t);
  const before = await readFile(f.interpolationPath);
  const installed = installVueTypecheckEntityCompatibility(f.projectRequire);
  const raw = 'pick(&quot;A&amp;B&quot;, missing)';
  const template = `<Widget :value="${raw}" />`;
  const start = template.indexOf(raw);
  const accesses = [];
  const ctx = { accessVariable: (...args) => accesses.push(args) };
  const data = { verification: true };
  const block = { name: 'template', content: template };
  const invoke = (text, offset, current = block) => [...f.interpolation.generateInterpolation({}, ctx, current, data, text, offset, '(', ')')];
  const chunks = invoke(raw, start);
  assert.equal(textOf(chunks), '(pick("A&B", __VLS_ctx.missing))');
  assert.equal(installed.enabled, true);
  assert.equal(installed.languageCoreVersion, '3.3.11');
  assert.deepEqual(accesses, [['template', 'missing', template.indexOf('missing')]]);
  const missing = chunks.find(chunk => Array.isArray(chunk) && chunk[0] === 'missing');
  assert.equal(missing[2], template.indexOf('missing'));
  const quoteStart = template.indexOf('&quot;');
  const marker = chunks.find(chunk => Array.isArray(chunk) && chunk[0] === '' && chunk[2] === quoteStart);
  assert.ok(marker?.[3].__combineToken);
  assert.ok(chunks.some(chunk => Array.isArray(chunk) && chunk[2] === quoteStart + 6 && chunk[3].__combineToken === marker[3].__combineToken));
  assert.ok(chunks.filter(Array.isArray).every(chunk => chunk[3].verification === true));
  const wrapper = f.interpolation.generateInterpolation;
  assert.equal(installVueTypecheckEntityCompatibility(f.projectRequire).enabled, true);
  assert.equal(f.interpolation.generateInterpolation, wrapper);
  assert.deepEqual(await readFile(f.interpolationPath), before);

  // Literal entity spelling outside an HTML attribute must be left untouched.
  const interpolation = '{{ "&quot;" }}';
  assert.equal(textOf(invoke('"&quot;"', 3, { name: 'template', content: interpolation })), '("&quot;")');
  assert.equal(textOf(invoke(raw, start, { name: 'script', content: template })), `(${raw.slice(0, raw.indexOf('missing'))}__VLS_ctx.missing))`);
  assert.equal(textOf(invoke(raw, start + 1)), `(${raw.slice(0, raw.indexOf('missing'))}__VLS_ctx.missing))`);
  const literalRaw = "'&amp;quot;'";
  const literalBlock = { name: 'template', content: `<Widget :value="${literalRaw}" />` };
  assert.equal(textOf(invoke(literalRaw, literalBlock.content.indexOf(literalRaw), literalBlock)), "('&quot;')");
  const numericRaw = "'&#x1f600;'";
  const numericBlock = { name: 'template', content: `<Widget :value="${numericRaw}" />` };
  assert.equal(textOf(invoke(numericRaw, numericBlock.content.indexOf(numericRaw), numericBlock)), "('😀')");
  assert.throws(() => invoke('throwOriginal', 0), /original generator error/);
  const bad = { name: 'template', content: `<parser-error :value="${raw}" />` };
  assert.match(textOf(invoke(raw, bad.content.indexOf(raw), bad)), /&quot;/);
});

test('Vue entity adapter does not alter an unverified language-core version', async t => {
  const f = await fixture(t, '3.3.12');
  const original = f.interpolation.generateInterpolation;
  const result = installVueTypecheckEntityCompatibility(f.projectRequire);
  assert.equal(result.enabled, false);
  assert.equal(f.interpolation.generateInterpolation, original);
});
