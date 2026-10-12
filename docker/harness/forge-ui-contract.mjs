#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CONTRACT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'forge-ui-contract.json');
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const REQUIRED_OWNERS = [
  'AiCrudPage', 'AiForm', 'DictSelect/DictTag', 'AuthImage', 'request', 'v-hasPermi',
  'dangerousConfirmation', 'token', 'loading-empty-error-busy', 'upload',
];
const REQUIRED_RULES = [
  'UI-DESIGN-001', 'UI-HTTP-001', 'UI-DIALOG-001', 'UI-A11Y-001', 'UI-PERMI-001',
  'UI-DANGER-001', 'UI-IMAGE-001', 'UI-PAGE-001', 'UI-TOKEN-001', 'UI-UPLOAD-001',
  'UI-FORM-001', 'UI-DICT-001', 'UI-STATE-001',
];

export class ForgeUiContractError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function normalizeRelative(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) {
    throw new ForgeUiContractError('INVALID_PATH', 'File paths must be non-empty POSIX repository-relative paths.');
  }
  const normalized = path.posix.normalize(value.replace(/^\.\//u, ''));
  if (normalized !== value.replace(/^\.\//u, '') || normalized === '..' || normalized.startsWith('../')
      || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized)) {
    throw new ForgeUiContractError('INVALID_PATH', `File path escapes the repository: ${value}`);
  }
  return normalized;
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function maskComments(source) {
  return source
    .replace(/<!--([\s\S]*?)-->/gu, (match) => match.replace(/[^\r\n]/gu, ' '))
    .replace(/\/\*([\s\S]*?)\*\//gu, (match) => match.replace(/[^\r\n]/gu, ' '))
    .replace(/(^|[^:])\/\/[^\r\n]*/gu, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length));
}

function issue(ruleId, file, line, message, extra = {}) {
  return { ruleId, path: file, line, message, ...extra };
}

function ruleMap(contract) {
  return new Map(contract.contracts.map((item) => [item.id, item]));
}

function addConfiguredIssue(target, contractRules, ruleId, file, line, message, extra = {}) {
  const rule = contractRules.get(ruleId);
  const record = issue(ruleId, file, line, message, {
    enforcement: rule?.enforcement ?? 'block',
    owner: rule?.owner,
    ...extra,
  });
  if (record.enforcement === 'block') target.findings.push(record);
  else target.obligations.push(record);
}

export function validateForgeUiContract(contract) {
  if (!contract || contract.schemaVersion !== 1 || typeof contract.contractVersion !== 'string'
      || !/^\d{4}\.\d{2}\.\d{2}\.\d+$/u.test(contract.contractVersion)
      || contract.profile !== 'forge-admin-canonical-ui' || !contract.scope?.newFilesOnly
      || !Array.isArray(contract.contracts) || !Array.isArray(contract.scope?.sourceExtensions)) {
    throw new ForgeUiContractError('INVALID_CONTRACT', 'Forge UI contract schema or version is invalid.');
  }
  for (const owner of REQUIRED_OWNERS) {
    const value = contract.canonicalOwners?.[owner];
    if (!value || typeof value.owner !== 'string' || !Array.isArray(value.allowedVariants)
        || value.allowedVariants.length === 0) {
      throw new ForgeUiContractError('INVALID_CONTRACT', `Canonical owner is missing or invalid: ${owner}`);
    }
  }
  const ids = new Set();
  for (const rule of contract.contracts) {
    if (!rule || !/^UI-[A-Z0-9]+-[0-9]{3}$/u.test(rule.id ?? '') || ids.has(rule.id)
        || !['block', 'obligation'].includes(rule.enforcement)
        || !REQUIRED_OWNERS.includes(rule.owner) || typeof rule.summary !== 'string') {
      throw new ForgeUiContractError('INVALID_CONTRACT', 'Forge UI contract contains an invalid or duplicate rule.');
    }
    ids.add(rule.id);
  }
  for (const id of REQUIRED_RULES) {
    if (!ids.has(id)) throw new ForgeUiContractError('INVALID_CONTRACT', `Required UI rule is missing: ${id}`);
  }
  for (const key of ['apiAdapter', 'sharedComponent']) {
    const requirement = contract.reuseRequirements?.[key];
    if (!requirement || !/^UI-[A-Z]+-[A-Z]+-[0-9]{3}$/u.test(requirement.id ?? '')
        || !Number.isInteger(requirement.minimumConsumers) || requirement.minimumConsumers < 1
        || !['block', 'obligation'].includes(requirement.enforcement)) {
      throw new ForgeUiContractError('INVALID_CONTRACT', `Reuse requirement is invalid: ${key}`);
    }
  }
  return contract;
}

export async function loadForgeUiContract(contractPath = CONTRACT_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(contractPath, 'utf8'));
  } catch (error) {
    throw new ForgeUiContractError('CONTRACT_UNAVAILABLE', `Cannot read Forge UI contract: ${error.message}`);
  }
  return validateForgeUiContract(parsed);
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) throw new ForgeUiContractError('INVALID_INPUT', 'files must be an array.');
  const seen = new Set();
  return files.map((file) => {
    const relative = normalizeRelative(file?.path);
    if (seen.has(relative)) throw new ForgeUiContractError('INVALID_INPUT', `Duplicate input path: ${relative}`);
    seen.add(relative);
    if (typeof file.content !== 'string') throw new ForgeUiContractError('INVALID_INPUT', `Missing source content: ${relative}`);
    if (!['A', 'added', 'M', 'modified', 'context'].includes(file.status ?? 'context')) {
      throw new ForgeUiContractError('INVALID_INPUT', `Unsupported file status: ${file.status}`);
    }
    return { path: relative, content: file.content, status: file.status ?? 'context' };
  });
}

function isAdded(file) {
  return file.status === 'A' || file.status === 'added';
}

function hasExtension(file, contract) {
  return contract.scope.sourceExtensions.some((extension) => file.endsWith(extension));
}

function isBusinessView(file, contract) {
  return file.startsWith(contract.scope.businessViewPrefix) && file.endsWith('.vue');
}

function isBusinessApi(file, contract) {
  return file.startsWith(contract.scope.businessApiPrefix) && /\.[cm]?[jt]sx?$/u.test(file);
}

function isSharedComponent(file, contract) {
  return file.endsWith('.vue') && contract.scope.sharedComponentPrefixes.some((prefix) => file.startsWith(prefix))
    && !Object.values(contract.canonicalOwners).some((owner) => owner.owner === file || owner.owner.endsWith('/') && file.startsWith(owner.owner));
}

function importSpecifiers(content) {
  const specifiers = [];
  const source = maskComments(content);
  for (const match of source.matchAll(/\b(?:import|export)\b[\s\S]{0,300}?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
    specifiers.push(match[1] ?? match[2] ?? match[3]);
  }
  return specifiers;
}

function importCandidate(importer, specifier) {
  if (specifier.startsWith('@/')) return `forge-admin-ui/src/${specifier.slice(2)}`;
  if (specifier.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  return null;
}

function moduleKeys(file) {
  const withoutExtension = file.replace(/\.(?:vue|[cm]?[jt]sx?)$/u, '');
  const withoutIndex = withoutExtension.replace(/\/index$/u, '');
  return new Set([file, withoutExtension, withoutIndex]);
}

function importsFile(importer, target) {
  const keys = moduleKeys(target);
  return importSpecifiers(importer.content).some((specifier) => {
    const candidate = importCandidate(importer.path, specifier);
    return candidate !== null && moduleKeys(candidate).values().some((key) => keys.has(key));
  });
}

function hasCanonicalDangerConfirmation(source, contract) {
  return contract.canonicalOwners.dangerousConfirmation.allowedVariants.some((variant) => source.includes(variant));
}

function scanBusinessView(file, contract, target, contractRules) {
  const source = maskComments(file.content);
  for (const match of source.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\([^)]*\)/giu)) {
    addConfiguredIssue(target, contractRules, 'UI-DESIGN-001', file.path, lineAt(file.content, match.index),
      'Raw color literals are forbidden in new business UI; use a Forge semantic token.');
  }
  for (const match of source.matchAll(/\bfrom\s*['"]element-plus['"]|<el-[a-z][a-z0-9-]*\b/giu)) {
    addConfiguredIssue(target, contractRules, 'UI-DESIGN-001', file.path, lineAt(file.content, match.index),
      'Element Plus is a parallel UI owner; use the canonical Forge/Naive UI component.');
  }
  for (const match of source.matchAll(/\bwindow\.(?:alert|confirm|prompt)\s*\(/gu)) {
    addConfiguredIssue(target, contractRules, 'UI-DIALOG-001', file.path, lineAt(file.content, match.index),
      'Browser modal dialogs are forbidden; use the canonical feedback or dangerous-confirmation owner.');
  }
  for (const match of source.matchAll(/<(div|span)\b([^>]*)>/giu)) {
    const attributes = match[2];
    if (!/(?:@click|v-on:click)\s*=/u.test(attributes)) continue;
    const hasRole = /\brole\s*=\s*['"]button['"]/iu.test(attributes);
    const hasTabIndex = /\btabindex\s*=\s*['"]?0['"]?/iu.test(attributes);
    const hasKeyboard = /(?:@|v-on:)(?:keydown|keyup)\.(?:enter|space)(?:\.prevent)?\s*=/iu.test(attributes);
    if (!hasRole || !hasTabIndex || !hasKeyboard) {
      addConfiguredIssue(target, contractRules, 'UI-A11Y-001', file.path, lineAt(file.content, match.index),
        'Clickable div/span requires role="button", tabindex="0", and Enter/Space keyboard activation.');
    }
  }
  const mutationPattern = /\b(?:add|create|edit|update|delete|remove|save|submit|enable|disable|import|export|handleAdd|handleEdit|handleDelete|handleRemove)\b|新增|创建|编辑|修改|删除|移除|保存|提交|启用|禁用|导入|导出/iu;
  const destructivePattern = /\b(?:delete|remove|destroy|disable|handleDelete|handleRemove)\b|删除|移除|禁用/iu;
  for (const match of source.matchAll(/<(?:n-button|NButton|button)\b([^>]*)>([\s\S]{0,160}?)<\/(?:n-button|NButton|button)>/gu)) {
    const signature = `${match[1]} ${match[2].replace(/<[^>]+>/gu, ' ')}`;
    if (!mutationPattern.test(signature)) continue;
    if (!/\bv-hasPermi\s*=|\bv-hasPermi\b/u.test(match[1])) {
      addConfiguredIssue(target, contractRules, 'UI-PERMI-001', file.path, lineAt(file.content, match.index),
        'Obvious mutation button is missing v-hasPermi.');
    }
    if (destructivePattern.test(signature) && !hasCanonicalDangerConfirmation(source, contract)) {
      addConfiguredIssue(target, contractRules, 'UI-DANGER-001', file.path, lineAt(file.content, match.index),
        'Obvious destructive action is missing the canonical dangerous confirmation owner.');
    }
  }
  for (const match of source.matchAll(/<(?:img|n-image|NImage|n-avatar|NAvatar)\b([^>]*)>/gu)) {
    const attributes = match[1];
    if (/:src\s*=\s*['"][^'"]*(?:avatar|image|photo|logo|file|attachment|\/api\/)[^'"]*['"]/iu.test(attributes)) {
      addConfiguredIssue(target, contractRules, 'UI-IMAGE-001', file.path, lineAt(file.content, match.index),
        'Protected image source must use AuthImage or the authenticated file adapter.');
    }
  }
  for (const match of source.matchAll(/<(?:n-pagination|NPagination|el-pagination)\b|\busePagination\s*\(/gu)) {
    if (!/\bAiCrudPage\b/u.test(source)) {
      addConfiguredIssue(target, contractRules, 'UI-PAGE-001', file.path, lineAt(file.content, match.index),
        'Business view hand-rolls pagination instead of using AiCrudPage.');
    }
  }
  const ordinaryCrud = /\b(?:apiConfig|tableColumns|searchSchema)\b|\/(?:page|add|edit|remove)\b/u.test(source);
  if (ordinaryCrud && !/\bAiCrudPage\b/u.test(source)) {
    addConfiguredIssue(target, contractRules, 'UI-PAGE-001', file.path, 1,
      'Ordinary business CRUD view must use the canonical AiCrudPage owner.');
  }
  if (/<(?:n-form|NForm)\b/u.test(source) && !/\bAiForm\b/u.test(source)) {
    addConfiguredIssue(target, contractRules, 'UI-FORM-001', file.path, 1,
      'Ordinary business form must use the canonical AiForm owner.');
  }
  for (const match of source.matchAll(/\b(?:status|type|category|level)\w*Options\s*=\s*(?:ref|reactive)?\s*\(?\s*\[[\s\S]{0,500}?\{\s*(?:label|value)\s*:/giu)) {
    if (!/\b(?:useDict|DictSelect|DictTag)\b/u.test(source)) {
      addConfiguredIssue(target, contractRules, 'UI-DICT-001', file.path, lineAt(file.content, match.index),
        'Page-local business option maps must use the canonical dictionary owner.');
    }
  }
  for (const match of source.matchAll(/\b(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\s*\(\s*['"][^'"]*(?:token|authorization)[^'"]*['"]/giu)) {
    addConfiguredIssue(target, contractRules, 'UI-TOKEN-001', file.path, lineAt(file.content, match.index),
      'Authentication token storage is owned by the canonical auth adapter.');
  }
  for (const match of source.matchAll(/<(?:n-upload|NUpload)\b([^>]*)>/gu)) {
    if (/(?:^|\s):?action\s*=/u.test(match[1]) && !/(?:custom-request|:custom-request)\s*=/u.test(match[1])) {
      addConfiguredIssue(target, contractRules, 'UI-UPLOAD-001', file.path, lineAt(file.content, match.index),
        'Direct upload action bypasses the canonical authenticated upload owner.');
    }
  }
  if (!/\bAiCrudPage\b/u.test(source)) {
    const missingStates = ['loading', 'empty', 'error', 'busy'].filter((state) => !new RegExp(`\\b${state}\\b`, 'iu').test(source));
    if (missingStates.length > 0) {
      addConfiguredIssue(target, contractRules, 'UI-STATE-001', file.path, 1,
        `Custom business view must establish async-state ownership; missing markers: ${missingStates.join(', ')}.`,
        { missingStates });
    }
  }
}

function scanHttp(file, contract, target, contractRules) {
  const source = maskComments(file.content);
  for (const match of source.matchAll(/\bfrom\s*['"]axios['"]|\baxios\s*\.|\bfetch\s*\(/gu)) {
    addConfiguredIssue(target, contractRules, 'UI-HTTP-001', file.path, lineAt(file.content, match.index),
      'Use the canonical request adapter instead of axios or fetch.');
  }
  if (isBusinessView(file.path, contract) && importsFile(file, contract.canonicalOwners.request.owner)) {
    addConfiguredIssue(target, contractRules, 'UI-HTTP-001', file.path, 1,
      'Business views must call a src/api adapter and cannot import the canonical request owner directly.');
  }
  const probableApiAdapter = isBusinessApi(file.path, contract)
    && /\bexport\b/u.test(source)
    && /['"]\/(?:api\/)?[a-z0-9_-]+(?:\/[a-z0-9_:/?&=.-]+)+['"]/iu.test(source);
  if (probableApiAdapter && !contract.canonicalOwners.request.allowedVariants.some((variant) => source.includes(variant))) {
    addConfiguredIssue(target, contractRules, 'UI-HTTP-001', file.path, 1,
      'Business API adapter does not import the canonical request owner.');
  }
}

function addReuseIssue(target, requirement, file, consumers, kind) {
  const record = issue(requirement.id, file.path, 1,
    `${kind} has ${consumers.length} consumer(s); at least ${requirement.minimumConsumers} are required.`, {
      enforcement: requirement.enforcement,
      consumers: consumers.map((item) => item.path),
      actualConsumers: consumers.length,
      requiredConsumers: requirement.minimumConsumers,
    });
  if (requirement.enforcement === 'block') target.findings.push(record);
  else target.obligations.push(record);
}

export function auditForgeUiContract({ files, contract }) {
  validateForgeUiContract(contract);
  const normalized = normalizeFiles(files);
  const rules = ruleMap(contract);
  const target = { findings: [], obligations: [] };
  const added = normalized.filter((file) => isAdded(file) && hasExtension(file.path, contract));
  const addedBusiness = added.filter((file) => isBusinessView(file.path, contract) || isBusinessApi(file.path, contract));
  for (const file of addedBusiness) {
    scanHttp(file, contract, target, rules);
    if (isBusinessView(file.path, contract)) scanBusinessView(file, contract, target, rules);
  }
  for (const file of added.filter((candidate) => isBusinessApi(candidate.path, contract))) {
    const consumers = normalized.filter((candidate) => candidate.path !== file.path && importsFile(candidate, file.path));
    if (consumers.length < contract.reuseRequirements.apiAdapter.minimumConsumers) {
      addReuseIssue(target, contract.reuseRequirements.apiAdapter, file, consumers, 'Business API adapter');
    }
  }
  for (const file of added.filter((candidate) => isSharedComponent(candidate.path, contract))) {
    const consumers = normalized.filter((candidate) => candidate.path !== file.path && importsFile(candidate, file.path));
    if (consumers.length < contract.reuseRequirements.sharedComponent.minimumConsumers) {
      addReuseIssue(target, contract.reuseRequirements.sharedComponent, file, consumers, 'Shared component');
    }
  }
  target.findings.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.ruleId.localeCompare(right.ruleId));
  target.obligations.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.ruleId.localeCompare(right.ruleId));
  return {
    schemaVersion: 1,
    contractVersion: contract.contractVersion,
    profile: contract.profile,
    ok: target.findings.length === 0,
    findings: target.findings,
    obligations: target.obligations,
    summary: {
      inputFiles: normalized.length,
      addedSourceFiles: added.length,
      addedBusinessFiles: addedBusiness.length,
      blockers: target.findings.length,
      obligations: target.obligations.length,
    },
  };
}

function parseArgs(argv) {
  const options = { command: argv[0], format: 'json', contract: CONTRACT_PATH };
  if (!['audit', 'help', '--help', '-h'].includes(options.command ?? '')) {
    throw new ForgeUiContractError('INVALID_COMMAND', 'Usage: forge-ui-contract.mjs audit --input FILE [--contract FILE] [--format json|text]');
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--input') options.input = argv[++index];
    else if (argument === '--contract') options.contract = argv[++index];
    else if (argument === '--format') options.format = argv[++index];
    else throw new ForgeUiContractError('INVALID_ARGUMENT', `Unknown argument: ${argument}`);
  }
  if (options.command === 'audit' && !options.input) throw new ForgeUiContractError('INVALID_ARGUMENT', '--input is required.');
  if (!['json', 'text'].includes(options.format)) throw new ForgeUiContractError('INVALID_ARGUMENT', '--format must be json or text.');
  return options;
}

function help() {
  return [
    'forge-ui-contract.mjs audit --input FILE [--contract FILE] [--format json|text]',
    '',
    'Input JSON: {"files":[{"path":"repo/relative.vue","status":"added|context","content":"..."}]}',
    'Only added business sources are scanned. Context files are used only for consumer counting.',
  ].join('\n');
}

function renderText(receipt) {
  const lines = [
    `Forge UI contract ${receipt.contractVersion}: ${receipt.ok ? 'PASS' : 'BLOCKED'}`,
    `blockers=${receipt.findings.length} obligations=${receipt.obligations.length}`,
  ];
  for (const item of receipt.findings) lines.push(`BLOCK ${item.ruleId} ${item.path}:${item.line} ${item.message}`);
  for (const item of receipt.obligations) lines.push(`OBLIGATION ${item.ruleId} ${item.path}:${item.line} ${item.message}`);
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (['help', '--help', '-h'].includes(options.command)) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  const inputStat = await import('node:fs/promises').then(({ stat }) => stat(options.input));
  if (!inputStat.isFile() || inputStat.size > MAX_INPUT_BYTES) {
    throw new ForgeUiContractError('INVALID_INPUT', 'Input must be a regular JSON file no larger than 16 MiB.');
  }
  const input = JSON.parse(await readFile(options.input, 'utf8'));
  const contract = await loadForgeUiContract(options.contract);
  const receipt = auditForgeUiContract({ files: input.files, contract });
  process.stdout.write(`${options.format === 'json' ? JSON.stringify(receipt, null, 2) : renderText(receipt)}\n`);
  if (!receipt.ok) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof ForgeUiContractError ? error.code : 'UI_CONTRACT_FAILED';
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
