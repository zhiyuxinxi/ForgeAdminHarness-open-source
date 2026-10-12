import { createHash } from 'node:crypto';
import path from 'node:path';

// This index reads text only. It never imports, evaluates, or runs customer code.
const posix = path.posix;
const hash = value => createHash('sha256').update(value).digest('hex');
const unique = values => [...new Set(values)];
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const technicalNames = new Set(['id', 'createBy', 'createTime', 'createDept', 'updateBy', 'updateTime', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt', 'tenantId', 'delFlag', 'deleted', 'version']);

function masked(source) {
  // Preserve offsets while removing comments and quoted content from structural scans.
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, match => match.replace(/[^\r\n]/g, ' '));
}
function javaReferences(source) {
  // Import declarations resolve names; they are not evidence that a type is used.
  return masked(source).replace(/\b(?:package|import)\s+[^;]+;/g, match => match.replace(/[^\r\n]/g, ' '));
}
function block(source, start, open = '{', close = '}', plain = masked(source)) {
  if (source[start] !== open) return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (plain[index] === open) depth += 1;
    if (plain[index] === close && --depth === 0) return { content: source.slice(start + 1, index), start, end: index + 1 };
  }
  return null;
}
function split(source, delimiter = ',') {
  const plain = masked(source); const parts = []; let start = 0; let depth = 0;
  for (let index = 0; index < plain.length; index += 1) {
    if ('([{'.includes(plain[index])) depth += 1;
    if (')]}'.includes(plain[index])) depth -= 1;
    if (plain[index] === delimiter && depth === 0) { parts.push(source.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(source.slice(start).trim()); return parts.filter(Boolean);
}
function properties(source) {
  const result = {};
  for (const entry of split(source)) {
    const match = /^\s*(?:'([^']+)'|"([^"]+)"|([\w$-]+))\s*:\s*([\s\S]*)$/.exec(entry);
    if (match) result[match[1] || match[2] || match[3]] = match[4].trim();
  }
  return result;
}
function literal(expression, bindings = {}, { parameters = false } = {}) {
  if (!expression) return undefined; const value = expression.trim();
  if (Object.hasOwn(bindings, value)) return bindings[value];
  if (value === 'true') return true; if (value === 'false') return false; if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")$/.test(value)) return value.slice(1, -1).replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
  if (value.startsWith('`') && value.endsWith('`')) {
    let resolved = true;
    const output = value.slice(1, -1).replace(/\$\{([^{}]+)\}/g, (_, key) => {
      const result = literal(key, bindings); if (result !== undefined && result !== null) return String(result);
      if (parameters && /^[\w$.]+$/.test(key)) return `{${key}}`;
      resolved = false; return '';
    });
    return resolved ? output : undefined;
  }
  const conditional = /^([\w$.]+)\s*(===|==|!==|!=)\s*(['"][^'"]*['"])\s*\?\s*([^?]+?)\s*:\s*(.+)$/.exec(value);
  if (conditional) {
    const left = literal(conditional[1], bindings); const right = literal(conditional[3], bindings);
    if (left === undefined || right === undefined) return undefined;
    const yes = conditional[2].startsWith('!') ? left !== right : left === right;
    return literal(yes ? conditional[4] : conditional[5], bindings, { parameters });
  }
  const sum = split(value, '+');
  if (sum.length > 1) { const parts = sum.map(part => literal(part, bindings, { parameters })); return parts.every(part => typeof part === 'string' || typeof part === 'number') ? parts.join('') : undefined; }
  const localized = /^(?:L|t)\(\s*((?:'[^']*'|"[^"]*"))\s*\)$/.exec(value);
  return localized ? literal(localized[1], bindings) : undefined;
}
function functions(source) {
  const result = new Map(); const plain = masked(source);
  for (const match of source.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::[^\n{]+)?\s*\{/g)) {
    const value = block(source, match.index + match[0].lastIndexOf('{'), '{', '}', plain);
    if (value) result.set(match[1], { name: match[1], parameters: split(match[2]).map(value => value.split(':')[0].trim()), ...value });
  }
  return result;
}
function localBindings(source, initial = {}) {
  const result = { ...initial };
  for (const match of source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*([^;\r\n]+)/g)) {
    const value = literal(match[2], result); if (value !== undefined) result[match[1]] = value;
  }
  return result;
}
function imports(source) {
  const result = [];
  for (const match of source.matchAll(/\bimport\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g)) {
    const clause = match[1].trim(); const names = [];
    const named = /\{([^}]+)\}/.exec(clause);
    if (named) for (const item of named[1].split(',')) { const [imported, local] = item.trim().split(/\s+as\s+/); if (imported) names.push({ imported, local: local || imported }); }
    const defaultName = /^([\w$]+)(?:\s*,|$)/.exec(clause)?.[1]; if (defaultName) names.push({ imported: 'default', local: defaultName });
    const namespace = /\*\s+as\s+(\w+)/.exec(clause)?.[1]; if (namespace) names.push({ imported: '*', local: namespace });
    result.push({ request: match[2], names, start: match.index });
  }
  return result;
}
function resolveImport(filename, request, byPath) {
  let target;
  if (request.startsWith('.')) target = posix.normalize(posix.join(posix.dirname(filename), request));
  else if (request.startsWith('@/') && filename.includes('/src/')) target = `${filename.split('/src/')[0]}/src/${request.slice(2)}`;
  else return null;
  for (const candidate of [target, ...['.vue', '.js', '.ts', '/index.vue', '/index.js', '/index.ts'].map(extension => target + extension)]) if (byPath.has(candidate)) return byPath.get(candidate);
  return null;
}
function line(source, offset) { return source.slice(0, offset).split('\n').length; }
function commentBefore(source, offset) {
  const prefix = source.slice(Math.max(0, offset - 2000), offset);
  const match = /\/\*\*([\s\S]*?)\*\/\s*(?:@[\s\S]*?)?$/.exec(prefix);
  return match ? match[1].split('\n').map(value => value.replace(/^\s*\*\s?/, '').trim()).filter(value => value && !value.startsWith('@')).join(' ').slice(0, 600) : '';
}
function fieldsFromObjects(source, proof) {
  const result = []; const plain = masked(source);
  for (let index = 0; index < plain.length; index += 1) if (plain[index] === '{') {
    const value = block(source, index, '{', '}', plain); if (!value) continue;
    const props = properties(value.content); const name = literal(props.field || props.prop || props.key || props.name);
    const label = literal(props.label || props.title);
    if (typeof name !== 'string' || (label === undefined && !props.type && !props.required && !props.rules)) continue;
    const nestedRules = props.rules || props.validation || '';
    const required = literal(props.required) ?? (/\brequired\s*:\s*true\b/.test(nestedRules) ? true : undefined);
    result.push({ name, label, dataType: literal(props.type), required, validation: nestedRules || undefined, options: props.options, source: proof(line(source, index)) });
    index = value.end - 1;
  }
  return result;
}
function schemaFragments(source, proof) {
  const result = { formFields: [], queryFields: [], listColumns: [] }; const plain = masked(source);
  const functionMap = functions(source);
  for (const item of functionMap.values()) {
    const destination = /(?:Search|Query|Filter)/i.test(item.name) ? 'queryFields' : /Columns/i.test(item.name) ? 'listColumns' : /(?:Edit|Form|Fields)/i.test(item.name) ? 'formFields' : null;
    if (destination) result[destination].push(...fieldsFromObjects(item.content, at => proof(line(source, item.start) + at - 1)));
  }
  for (const match of source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*([^\n]*)/g)) {
    const destination = /(?:search|query|filter).*?(?:schema|fields)|^(?:searchSchema|queryFields|filters)$/i.test(match[1]) ? 'queryFields' : /columns/i.test(match[1]) ? 'listColumns' : /(?:edit|form).*(?:schema|fields)/i.test(match[1]) ? 'formFields' : null;
    if (!destination) continue;
    const arrayStart = source.indexOf('[', match.index + match[0].indexOf('='));
    if (arrayStart < 0 || arrayStart > match.index + 160) continue;
    const value = block(source, arrayStart, '[', ']', plain); if (value) result[destination].push(...fieldsFromObjects(value.content, at => proof(line(source, arrayStart) + at - 1)));
  }
  return result;
}
function templateFacts(source, proof) {
  const template = /<template\b[^>]*>([\s\S]*?)<\/template>\s*(?:<script|<style|$)/.exec(source)?.[1] || '';
  const result = { formFields: [], queryFields: [], listColumns: [], actions: [], blocks: [], navigation: [] };
  for (const match of template.matchAll(/<(?:n-form-item(?:-gi)?|el-form-item)\b([^>]*)>([\s\S]*?)<\/(?:n-form-item(?:-gi)?|el-form-item)>/g)) {
    const model = /v-model(?::[\w-]+)?\s*=\s*['"]([^'"]+)['"]/.exec(match[2])?.[1]; if (!model) continue;
    const labelExpr = /(?::label|label)=(["'])([\s\S]*?)\1/.exec(match[1]);
    const label = labelExpr ? literal(labelExpr[2]) ?? literal(labelExpr[1] + labelExpr[2] + labelExpr[1]) : undefined;
    const type = /<([\w-]+)\b/.exec(match[2])?.[1];
    const field = { name: model.split('.').at(-1), label, dataType: type, model, required: /(?:\srequired(?:\s|$)|:required=["']true)/.test(match[1]) ? true : undefined, source: proof(line(source, source.indexOf(match[0]))) };
    (/^(?:filters|query|queryParams|search)/.test(model) ? result.queryFields : result.formFields).push(field);
  }
  for (const match of template.matchAll(/<(?:n-button|el-button|button)\b([^>]*)>([\s\S]*?)<\/(?:n-button|el-button|button)>/g)) {
    const label = match[2].trim().replace(/^\{\{\s*(?:L|t)\(['"]([^'"]+)['"]\)\s*\}\}$/, '$1').replace(/<[^>]*>/g, '').trim();
    if (label) result.actions.push({ name: label, handler: /@click(?:\.\w+)*=["']([^"']+)["']/.exec(match[1])?.[1], condition: /v-if=["']([^"']+)["']/.exec(match[1])?.[1], source: proof(line(source, source.indexOf(match[0]))) });
  }
  for (const match of template.matchAll(/<(header|footer|aside|n-card|n-data-table|el-table|n-form|n-tabs|n-modal|n-drawer|AiCrudPage)\b([^>]*)/g)) result.blocks.push({ name: match[1], type: match[1], description: match[2].trim().slice(0, 400), source: proof(line(source, source.indexOf(match[0]))) });
  for (const match of source.matchAll(/\brouter\.(push|replace)\(\s*([^\n;]+)/g)) result.navigation.push({ action: match[1], target: match[2].slice(0, 300), source: proof(line(source, match.index)) });
  return result;
}
function routeKey(method, route) { return `${method.toUpperCase()} ${route.replace(/\/$/, '').replace(/\{[^}]+\}|:[A-Za-z_]\w*/g, '{param}')}`; }
function endpoints(source, bindings = {}) {
  const found = []; const context = localBindings(source, bindings);
  const push = (method, expression, offset, functionName) => {
    const endpoint = literal(expression, context, { parameters: true });
    if (typeof endpoint === 'string' && endpoint.startsWith('/') && !/\{(?:base|prefix|url|path)\}/i.test(endpoint)) found.push({ method: method.toUpperCase(), path: endpoint, line: line(source, offset), functionName });
  };
  for (const match of source.matchAll(/\b(?:request|http|defHttp|axios)\.(get|post|put|delete|patch)\s*(?:<[^;\n]+?>)?\s*\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)(?=\s*[,\)])/g)) push(match[1], match[2], match.index);
  for (const match of source.matchAll(/\b(getEncrypt|postEncrypt|putEncrypt|deleteEncrypt|patchEncrypt)\s*\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)(?=\s*[,\)])/g)) push(match[1].replace('Encrypt', ''), match[2], match.index);
  for (const match of source.matchAll(/\b(\w+)\s*:\s*(['"`])((?:get|post|put|delete|patch)@[\s\S]*?)\2/g)) {
    const endpoint = literal(match[2] + match[3] + match[2], context, { parameters: true });
    if (typeof endpoint === 'string') { const separator = endpoint.indexOf('@'); const route = endpoint.slice(separator + 1); if (route.startsWith('/')) found.push({ method: endpoint.slice(0, separator).toUpperCase(), path: route, line: line(source, match.index), functionName: match[1] }); }
  }
  return found;
}
function javaInfo(file) {
  const source = file.content; const packageName = /\bpackage\s+([\w.]+)\s*;/.exec(source)?.[1]; const declaration = /\b(class|interface|record)\s+(\w+)\s*([^\{]*)\{/.exec(masked(source));
  if (!declaration || !packageName) return null;
  const imports = [...source.matchAll(/\bimport\s+([\w.]+)\s*;/g)].map(match => match[1]);
  return { file, name: declaration[2], fqn: `${packageName}.${declaration[2]}`, packageName, declaration: declaration[3], imports, classStart: declaration.index };
}
function javaFields(info, proof) {
  const result = [];
  for (const match of info.file.content.matchAll(/\b(?:private|protected|public)\s+(?!static\b)([\w.<>?,\s\[\]]+?)\s+(\w+)\s*(?:=[^;]*)?;/g)) {
    const prefix = info.file.content.slice(Math.max(0, match.index - 900), match.index); const nearest = prefix.slice(Math.max(prefix.lastIndexOf(';') + 1, prefix.lastIndexOf('}') + 1));
    const transient = /@TableField\s*\(\s*exist\s*=\s*false/.test(nearest);
    const column = /@(?:TableField|TableId)\s*\(\s*(?:value\s*=\s*)?"([^"]+)"/.exec(nearest)?.[1];
    const description = commentBefore(info.file.content, match.index);
    result.push({ name: match[2], description, dataType: match[1].trim(), field: column, persistent: !transient, isTechnical: technicalNames.has(match[2]), primaryKey: /@TableId\b/.test(nearest), source: proof(line(info.file.content, match.index)) });
  }
  return result;
}
function mappingPath(argumentsText) {
  if (argumentsText === undefined || !argumentsText.trim()) return '';
  const parts = split(argumentsText); const explicit = parts.find(value => /^(?:value|path)\s*=/.test(value));
  const expression = explicit ? explicit.replace(/^(?:value|path)\s*=\s*/, '') : parts[0];
  return literal(expression);
}

export function buildDeliveryCodeAssets({ projectSlug, sourceCommit, files, menus, recordedAt }) {
  if (typeof projectSlug !== 'string' || !/^[a-z][a-z0-9-]+$/.test(projectSlug) || typeof sourceCommit !== 'string' || !/^[a-f0-9]{40,64}$/i.test(sourceCommit) || !Array.isArray(files) || !Array.isArray(menus)) throw new TypeError('A project, exact commit, file corpus, and menu array are required.');
  const byPath = new Map(files.filter(file => typeof file.path === 'string' && typeof file.content === 'string' && !file.path.includes('..')).map(file => [file.path.replaceAll('\\', '/'), { ...file, path: file.path.replaceAll('\\', '/') }]));
  const assets = new Map(); const java = new Map(); const routeIndex = new Map(); const menuIndex = new Map(menus.map(menu => [String(menu.id), menu]));
  const functionCache = new Map(); const importCache = new Map(); const completedPages = new Set(); const implementationCache = new Map();
  const fileFunctions = file => { if (!functionCache.has(file.path)) functionCache.set(file.path, functions(file.content)); return functionCache.get(file.path); };
  const fileImports = file => { if (!importCache.has(file.path)) importCache.set(file.path, imports(file.content)); return importCache.get(file.path); };
  const proof = (file, at) => ({ type: 'code-snapshot', path: file.path, sha256: file.sha256 || hash(file.content), digest: file.sha256 || hash(file.content), commit: sourceCommit, sourceCommit, line: at, label: '当前提交的源码定义' });
  const menuPath = id => { const result = []; const seen = new Set(); let current = menuIndex.get(String(id)); while (current && !seen.has(String(current.id))) { seen.add(String(current.id)); result.unshift(current.name); current = menuIndex.get(String(current.parentId)); } return result.filter(Boolean); };
  const make = (kind, identity, name, file, details = {}, at) => {
    const assetId = kind === 'table' ? `${projectSlug}:table:${identity}` : kind === 'entity' ? `${projectSlug}:entity:${identity}` : `code-${kind}-${hash(`${projectSlug}|${kind}|${identity}`).slice(0, 24)}`;
    if (!assets.has(assetId)) assets.set(assetId, { assetId, id: assetId, kind, name, description: '从该代码快照中的明确声明收录；不作为原始需求、验收通过或生产上线证明。', menuIds: [], menuPaths: [], batchIds: [], sourceRevision: sourceCommit, recordedAt, status: 'implementation-observed', certainty: 'implementation-derived', sources: [proof(file, at)], details, relations: [], commits: [sourceCommit], releaseIds: [], diagram: null });
    return assets.get(assetId);
  };
  const bind = (asset, menu) => { const id = String(menu.id); if (!asset.menuIds.includes(id)) { asset.menuIds.push(id); asset.menuPaths.push(menuPath(id)); } };
  const addSource = (asset, source) => { if (!asset.sources.some(item => item.path === source.path && item.line === source.line)) asset.sources.push(source); };
  for (const file of byPath.values()) if (file.path.endsWith('.java')) { const info = javaInfo(file); if (info) java.set(info.fqn, info); }
  const resolveType = (info, name) => java.get(info.imports.find(value => value.endsWith(`.${name}`))) || java.get(`${info.packageName}.${name}`);
  const entities = new Map(); const entityTables = new Map();
  for (const info of java.values()) {
    const tableName = /@TableName\s*\(\s*(?:value\s*=\s*)?"([^"]+)"/.exec(info.file.content)?.[1]; if (!tableName) continue;
    const attributes = javaFields(info, at => proof(info.file, at)); const inherited = []; const seen = new Set([info.fqn]); let current = info;
    while (current) {
      const baseName = /\bextends\s+(\w+)/.exec(current.declaration)?.[1]; const base = baseName && resolveType(current, baseName); if (!base || seen.has(base.fqn)) break;
      seen.add(base.fqn); inherited.push(...javaFields(base, at => proof(base.file, at)).map(field => ({ ...field, inheritedFrom: base.fqn }))); current = base;
    }
    const all = [...attributes, ...inherited.filter(field => !attributes.some(item => item.name === field.name))];
    const asset = make('entity', info.fqn, commentBefore(info.file.content, info.classStart) || info.name, info.file, { className: info.fqn, attributes: all.filter(field => !field.isTechnical), technicalFields: all.filter(field => field.isTechnical), tables: [{ name: tableName, mapping: '@TableName', source: proof(info.file) }], fieldMappings: all.filter(field => field.persistent && field.field).map(field => ({ businessAttribute: field.name, field: field.field, source: field.source })), logicalRelations: [] });
    entities.set(info.fqn, asset);
    const table = make('table', tableName, tableName, info.file, { entityMappings: [{ entityId: asset.assetId, entity: info.fqn, table: tableName, mapping: '@TableName', source: proof(info.file) }], fieldMappings: asset.details.fieldMappings, technicalFields: asset.details.technicalFields, schemaStatus: '数据库实际字段由数据库元数据补充，未按Java属性推测列类型或列名。' });
    if (!table.details.entityMappings.some(mapping => mapping.entityId === asset.assetId)) table.details.entityMappings.push({ entityId: asset.assetId, entity: info.fqn, table: tableName, mapping: '@TableName', source: proof(info.file) });
    asset.relations.push({ type: 'maps-to-table', targetId: table.assetId, targetKind: 'table', label: tableName, source: proof(info.file) });
    entityTables.set(info.fqn, table);
    for (const field of inherited) addSource(asset, field.source);
  }
  for (const info of java.values()) {
    if (!/@(?:RestController|Controller)\b/.test(info.file.content)) continue;
    const classPrefix = info.file.content.slice(0, info.classStart); const classMapping = /@RequestMapping\b(?:\s*\(([^)]*)\))?/.exec(classPrefix); const base = classMapping ? mappingPath(classMapping[1]) : '';
    if (base === undefined) continue;
    for (const match of info.file.content.matchAll(/@(Get|Post|Put|Delete|Patch)Mapping\b(?:\s*\(([^)]*)\))?/g)) {
      const mapped = mappingPath(match[2]); if (mapped === undefined) continue;
      const route = `${base}/${mapped}`.replace(/\/{2,}/g, '/');
      const tail = info.file.content.slice(match.index + match[0].length); const signature = /\bpublic\s+([\s\S]*?)\s+(\w+)\s*\(([\s\S]*?)\)\s*\{/.exec(tail);
      if (!signature || signature.index > 1800) continue;
      const referenceStart = match.index + match[0].length + signature.index;
      const start = referenceStart + signature[0].lastIndexOf('{'); const methodBlock = block(info.file.content, start); const methodBody = methodBlock?.content || '';
      const asset = make('api', `${info.fqn}|${match[1]}|${route}|${signature[2]}`, commentBefore(info.file.content, match.index) || signature[2], info.file, { method: match[1].toUpperCase(), path: route, owner: info.fqn, controllerMethod: signature[2], request: { signature: signature[3].trim() }, response: { dataType: signature[1].trim() }, internalCalls: [], externalCalls: [] }, line(info.file.content, match.index));
      asset.description = commentBefore(info.file.content, match.index) || `源码中声明的 ${match[1].toUpperCase()} ${route}`;
      const key = routeKey(match[1], route); if (!routeIndex.has(key)) routeIndex.set(key, []); routeIndex.get(key).push({ asset, info, methodBody, signature: signature[0], referenceStart, referenceEnd: methodBlock?.end ?? start });
    }
  }
  const referenceEntities = (endpoint, menu) => {
    if (!endpoint.entityReferences) {
      endpoint.entityReferences = [];
      const queue = [{ info: endpoint.info, via: [] }]; const seen = new Set();
      while (queue.length) {
        const { info: current, via } = queue.shift(); if (seen.has(current.fqn)) continue; seen.add(current.fqn);
        if (entities.has(current.fqn)) { endpoint.entityReferences.push({ fqn: current.fqn, via }); continue; }
        if (seen.size > 80) break;
        const plain = javaReferences(current.file.content);
        const offset = current === endpoint.info ? endpoint.referenceStart : 0;
        const relevant = current === endpoint.info ? plain.slice(offset, endpoint.referenceEnd) : plain;
        for (const imported of current.imports) {
          const dependency = java.get(imported); if (!dependency) continue; const name = dependency.name;
          const field = new RegExp(`\\b${escape(name)}\\s+(\\w+)\\s*;`).exec(plain);
          const reference = new RegExp(`\\b${escape(name)}\\b`).exec(relevant)
            || (field && new RegExp(`\\b${escape(field[1])}\\s*\\.`).exec(relevant));
          if (reference && (entities.has(imported) || /\/(?:service|mapper|dto)\//.test(dependency.file.path))) {
            queue.push({ info: dependency, via: [...via, { ...proof(current.file, line(current.file.content, offset + reference.index)), fromType: current.fqn, toType: imported }] });
          }
        }
        if (/\binterface\s/.test(plain)) {
          if (!implementationCache.has(current.fqn)) implementationCache.set(current.fqn, [...java.values()].filter(candidate => new RegExp(`\\bimplements\\s+[^\\{]*\\b${escape(current.name)}\\b`).test(candidate.declaration) && (candidate.imports.includes(current.fqn) || candidate.packageName === current.packageName)));
          const implementations = implementationCache.get(current.fqn);
          if (implementations.length === 1) { const implementation = implementations[0]; queue.push({ info: implementation,
            via: [...via, { ...proof(implementation.file, line(implementation.file.content, implementation.classStart)), fromType: current.fqn, toType: implementation.fqn, referenceKind: 'unique-interface-implementation' }] }); }
        }
      }
    }
    for (const { fqn, via } of endpoint.entityReferences) {
      const entity = entities.get(fqn), table = entityTables.get(fqn);
      const source = { ...via.at(-1), menuId: String(menu.id), endpointId: endpoint.asset.assetId,
        referenceKind: via.length === 1 ? 'direct-source-reference' : 'indirect-source-dependency', dependencyDepth: via.length, via,
        limitation: '静态源码类型依赖，不证明运行调用、数据库读写、菜单直接维护或业务采用。' };
      for (const asset of [entity, table]) {
        bind(asset, menu);
        if (!asset.sources.some(item => item.menuId === source.menuId && item.endpointId === source.endpointId)) asset.sources.push(source);
      }
      if (!endpoint.asset.relations.some(item => item.targetId === entity.assetId)) endpoint.asset.relations.push({ type: 'references-entity', targetId: entity.assetId, targetKind: 'entity', label: entity.name, source });
    }
  };
  for (const menu of menus) {
    if (Number(menu.resourceType ?? menu.type ?? 2) !== 2 || !menu.component || menu.deleted === 1) continue;
    const component = String(menu.component).replace(/^\/+/, '').replace(/^views\//, '').replace(/\.vue$/, '');
    const roots = [...byPath.values()].filter(file => file.path.endsWith(`/src/views/${component}.vue`) || file.path.endsWith(`/src/views/${component}/index.vue`));
    if (roots.length !== 1) continue;
    const root = roots[0]; const page = make('page', root.path, menu.name || component, root, { formFields: [], queryFields: [], listColumns: [], actions: [], blocks: [], navigation: [], apiBindings: [], relatedComponents: [], unresolvedReferences: [], route: menu.path, component: menu.component }); bind(page, menu);
    if (completedPages.has(root.path)) {
      for (const endpoint of page.details.apiBindings) {
        bind(assets.get(endpoint.assetId), menu);
        const matched = (routeIndex.get(routeKey(endpoint.method, endpoint.path)) || []).find(item => item.asset.assetId === endpoint.assetId);
        if (matched) referenceEntities(matched, menu);
      }
      continue;
    }
    const visited = new Set();
    const attachEndpoint = (definition, file) => {
      const matches = routeIndex.get(routeKey(definition.method, definition.path)) || [];
      const api = matches.length === 1 ? matches[0].asset : make('api', `frontend|${routeKey(definition.method, definition.path)}`, definition.functionName || `${definition.method} ${definition.path}`, file, { method: definition.method, path: definition.path, owner: '前端调用声明', controllerBinding: matches.length ? '多个精确路由匹配，未选择实现' : '尚无精确匹配的 Controller' }, definition.line);
      bind(api, menu); addSource(api, proof(file, definition.line));
      if (!page.relations.some(value => value.targetId === api.assetId)) { page.relations.push({ type: 'calls-api', targetId: api.assetId, targetKind: 'api', label: api.name, source: proof(file, definition.line) }); page.details.apiBindings.push({ assetId: api.assetId, method: definition.method, path: definition.path, source: proof(file, definition.line) }); }
      if (matches.length === 1) referenceEntities(matches[0], menu);
    };
    const inspect = (file, bindings = {}, depth = 0, onlyFunction) => {
      if (depth > 5) return; const key = `${file.path}|${onlyFunction || ''}|${JSON.stringify(bindings)}`; if (visited.has(key)) return; visited.add(key);
      addSource(page, proof(file)); if (file.path !== root.path && file.path.endsWith('.vue') && !page.details.relatedComponents.includes(file.path)) page.details.relatedComponents.push(file.path);
      const allFunctions = fileFunctions(file); const selected = onlyFunction && allFunctions.get(onlyFunction); const source = selected ? selected.content : file.content;
      const factSource = at => proof(file, selected ? line(file.content, selected.start) + at - 1 : at);
      const facts = file.path.endsWith('.vue') && !onlyFunction ? templateFacts(source, factSource) : { formFields: [], queryFields: [], listColumns: [], actions: [], blocks: [], navigation: [] };
      const schema = selected ? { [/search|query|filter/i.test(onlyFunction) ? 'queryFields' : /columns/i.test(onlyFunction) ? 'listColumns' : 'formFields']: fieldsFromObjects(source, factSource) } : schemaFragments(source, factSource);
      for (const field of ['formFields', 'queryFields', 'listColumns', 'actions', 'blocks', 'navigation']) page.details[field].push(...(facts[field] || []), ...(schema[field] || []));
      for (const endpoint of endpoints(source, bindings)) attachEndpoint({ ...endpoint, line: selected ? line(file.content, selected.start) + endpoint.line - 1 : endpoint.line }, file);
      const local = localBindings(source, bindings);
      // A complete file is already inspected above. Recursing over its declarations
      // would mistake every function definition for a call and multiply local scopes.
      const ownCalls = selected ? [...source.matchAll(/\b(\w+)\s*\(([^()\n]*)\)/g)] : [];
      for (const call of ownCalls) {
        if (call[1] === onlyFunction || !allFunctions.has(call[1])) continue;
        const callee = allFunctions.get(call[1]); const args = split(call[2]); const bound = {};
        callee.parameters.forEach((parameter, index) => { const value = literal(args[index], local); if (value !== undefined) bound[parameter] = value; });
        inspect(file, bound, depth + 1, call[1]);
      }
      for (const dependency of fileImports(file)) {
        const target = resolveImport(file.path, dependency.request, byPath); if (!target) continue;
        for (const binding of dependency.names) {
          if (target.path.endsWith('.vue')) {
            const tag = new RegExp(`<${escape(binding.local)}\\b([^>]*)>`, 'g');
            for (const use of source.matchAll(tag)) {
              const props = {};
              for (const attr of use[1].matchAll(/(?:^|\s)([\w-]+)=(['"])([^'"]*)\2/g)) props[`props.${attr[1].replace(/-([a-z])/g, (_, value) => value.toUpperCase())}`] = attr[3];
              inspect(target, props, depth + 1);
            }
          } else {
            const targetFunctions = fileFunctions(target); const functionName = binding.imported === 'default' ? null : binding.imported;
            const callPattern = new RegExp(`\\b${escape(binding.local)}\\s*\\(([^()\\n]*)\\)`, 'g');
            for (const call of source.matchAll(callPattern)) {
              const callee = targetFunctions.get(functionName); if (!callee) continue; const args = split(call[1]); const bound = {};
              callee.parameters.forEach((parameter, index) => { const value = literal(args[index], local); if (value !== undefined) bound[parameter] = value; });
              inspect(target, bound, depth + 1, functionName);
            }
          }
        }
      }
    };
    inspect(root);
    completedPages.add(root.path);
    for (const field of ['formFields', 'queryFields', 'listColumns', 'actions', 'blocks', 'navigation', 'apiBindings']) page.details[field] = [...new Map(page.details[field].map(value => [JSON.stringify(value), value])).values()];
    page.details.layout = page.details.blocks.length ? '以下为源码明确声明的页面区块；排列位置未根据视觉推断。' : '尚未提取可确认的页面结构';
  }
  return [...assets.values()].map(asset => ({ ...asset, usedByMenus: asset.menuIds.map(id => ({ id, name: menuIndex.get(id)?.name, path: menuPath(id) })) }));
}
