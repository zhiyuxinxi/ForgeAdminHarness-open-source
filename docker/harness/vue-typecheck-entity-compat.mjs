import { createRequire } from 'node:module';

const installed = new WeakMap();
const entityPattern = /&(?:#[xX][\da-fA-F]+;?|#\d+;?|[a-zA-Z][a-zA-Z\d]*;?)/gu;

// Only source ranges belonging to actual directive attributes are eligible.
// In particular, JavaScript strings and {{ }} interpolation are not HTML attrs.
function attributeExpressions(compiler, content) {
  const result = new Map();
  try {
    const visit = node => {
      if (node.type === 1) {
        for (const prop of node.props ?? []) {
          const exp = prop.type === 7 ? prop.exp : undefined;
          if (exp?.type === 4 && exp.loc.source.includes('&') && exp.content !== exp.loc.source) {
            const start = exp.loc.start.offset;
            if (content.slice(start, exp.loc.end.offset) === exp.loc.source) result.set(start, exp);
          }
        }
      }
      for (const child of node.children ?? []) if (typeof child === 'object') visit(child);
    };
    visit(compiler.parse(content));
  } catch {
    // The original compiler owns malformed-template diagnostics.
  }
  return result;
}

function decodedSegments(compiler, raw, expected) {
  const pieces = [];
  let previous = 0;
  let decodedOffset = 0;
  const add = (text, rawStart, rawEnd, entity = false) => {
    pieces.push({ text, rawStart, rawEnd, start: decodedOffset, end: decodedOffset + text.length, entity });
    decodedOffset += text.length;
  };
  for (const match of raw.matchAll(entityPattern)) {
    if (previous < match.index) add(raw.slice(previous, match.index), previous, match.index);
    const text = match[0];
    // Decode once with the exact installed Vue parser, not an independent HTML
    // entity table. The full expression equality below preserves parser context.
    const node = compiler.parse(`<i :p="${text}" />`).children[0]?.props?.[0]?.exp;
    const value = node?.content ?? text;
    add(value, match.index, match.index + text.length, value !== text);
    previous = match.index + text.length;
  }
  if (previous < raw.length) add(raw.slice(previous), previous, raw.length);
  if (pieces.map(piece => piece.text).join('') !== expected) return null;
  return pieces;
}

function originalOffset(pieces, offset, decodedLength, rawLength) {
  if (offset === decodedLength) return rawLength;
  const piece = pieces.find(value => offset >= value.start && offset < value.end);
  if (!piece) return offset;
  return piece.entity ? piece.rawStart : piece.rawStart + offset - piece.start;
}

function* remapSegment(segment, pieces, start, blockName, decoded, raw, Boundary) {
  if (typeof segment === 'string' || segment[1] !== blockName) {
    yield segment;
    return;
  }
  const [text, source, sourceOffset, features] = segment;
  const offset = sourceOffset - start;
  if (offset < 0 || offset > decoded.length) {
    yield segment;
    return;
  }
  if (!text) {
    yield ['', source, start + originalOffset(pieces, offset, decoded.length, raw.length), features];
    return;
  }
  if (text !== decoded.slice(offset, offset + text.length)) {
    throw new Error('Vue entity compatibility encountered an unsupported generated source segment');
  }
  for (const piece of pieces) {
    const from = Math.max(offset, piece.start);
    const to = Math.min(offset + text.length, piece.end);
    if (from >= to) continue;
    const value = decoded.slice(from, to);
    if (piece.entity) {
      // Boundary supplies both raw/generated endpoints; no padding can safely
      // preserve the value of entity characters inside string literals.
      const boundary = yield* Boundary.start(source, start + piece.rawStart, start + piece.rawEnd, features);
      yield value;
      yield boundary.end();
    } else {
      yield [value, source, start + piece.rawStart + from - piece.start, features];
    }
  }
}

export function installVueTypecheckEntityCompatibility(projectRequire) {
  const tscRequire = createRequire(projectRequire.resolve('vue-tsc/package.json'));
  const vueTscVersion = projectRequire('vue-tsc/package.json').version;
  const corePackage = tscRequire.resolve('@vue/language-core/package.json');
  const coreRequire = createRequire(corePackage);
  const languageCoreVersion = coreRequire(corePackage).version;
  const info = { vueTscVersion, languageCoreVersion };
  if (languageCoreVersion !== '3.3.11') {
    return { ...info, enabled: false, status: 'unsupported-version' };
  }
  const interpolation = coreRequire('./lib/codegen/template/interpolation.js');
  if (installed.has(interpolation)) return installed.get(interpolation);
  const compiler = coreRequire('@vue/compiler-dom');
  const { Boundary } = coreRequire('./lib/codegen/utils/boundary.js');
  const original = interpolation.generateInterpolation;
  if (typeof original !== 'function' || typeof compiler.parse !== 'function' || typeof Boundary?.start !== 'function') {
    throw new Error('Vue 3.3.11 entity compatibility cannot bind its installed generator APIs');
  }
  const blocks = new WeakMap();
  interpolation.generateInterpolation = function* (options, ctx, block, data, code, start, ...rest) {
    if (block?.name !== 'template' || !code.includes('&') || typeof block.content !== 'string') {
      yield* original(options, ctx, block, data, code, start, ...rest);
      return;
    }
    let cached = blocks.get(block);
    if (!cached || cached.content !== block.content) {
      cached = { content: block.content, expressions: attributeExpressions(compiler, block.content) };
      blocks.set(block, cached);
    }
    const expression = cached.expressions.get(start);
    let pieces;
    if (expression?.loc.source === code) {
      try { pieces = decodedSegments(compiler, code, expression.content); } catch { /* keep original diagnostics */ }
    }
    if (!pieces) {
      yield* original(options, ctx, block, data, code, start, ...rest);
      return;
    }
    const decoded = expression.content;
    const mappedContext = new Proxy(ctx, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === 'accessVariable' && typeof value === 'function') {
          return (source, name, offset) => value.call(target, source, name,
            source === block.name && offset >= start && offset <= start + decoded.length
              ? start + originalOffset(pieces, offset - start, decoded.length, code.length)
              : offset);
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    for (const segment of original(options, mappedContext, block, data, decoded, start, ...rest)) {
      yield* remapSegment(segment, pieces, start, block.name, decoded, code, Boundary);
    }
  };
  const result = Object.freeze({ ...info, enabled: true, status: 'installed' });
  installed.set(interpolation, result);
  return result;
}
