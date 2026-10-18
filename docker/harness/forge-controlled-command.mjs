import { validateVerifyAction, defaultBackgroundVerification } from './verify-policy.mjs';
import {
  isHostCapabilityReceipt,
  isHostExecutionAdmissionReceipt,
  isHostRunReceipt,
  validateHostCapabilityReceipt,
  validateHostExecutionAdmissionReceipt,
  validateHostRunReceipt,
} from './forge-host-verification-receipt.mjs';

const SHELL_CONTROL = /[\r\n;&|`<>]|\$\(|\$\{|\\\r?\n/u;
const SAFE_TOKEN = /^[A-Za-z0-9_./:@=,+#-]{1,512}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const PROFILE = /^[a-z][a-z0-9-]{1,63}$/u;
const MODULE = /^forge-server\/[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;
const TEST = /^[A-Za-z_$][A-Za-z0-9_$.]{0,199}(?:#[A-Za-z_$][A-Za-z0-9_$]{0,99})?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27,55}$/u;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const RELEASE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const RELEASE_APPROVAL_REF = /^[A-Za-z0-9][A-Za-z0-9_./:@=,+#-]{0,159}$/u;
const REPOSITORY_PATH = /^[A-Za-z0-9_./@=,+#-]{1,512}$/u;
const CHECKPOINT_PATH = /^[A-Za-z0-9_./@=,+#\[\]-]{1,512}$/u;
const BASE64URL = /^[A-Za-z0-9_-]{2,667}$/u;
const PREPARATION_PLAN_BASE64URL = /^[A-Za-z0-9_-]{2,43691}$/u;
const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CHECKPOINT_IGNORED_PATH_PARTS = new Set([
  '.git', '.forge-cache', 'node_modules', 'target', 'dist', 'build', 'coverage', '.pnpm-store',
]);
const RELEASE_SERVICES = new Set(['forge-admin', 'forge-app', 'forge-flow', 'forge-ui']);
const VERIFY_RUN_STATUSES = new Set(['passed', 'failed', 'timed-out', 'failed-zero-tests']);
const VERIFY_ADMISSION_OUTCOMES = new Set(['ready', 'cache_miss', 'cache_invalid', 'executor_unavailable']);
const RELEASE_INSPECTION_ACTIONS = new Set(['contract', 'capability', 'preflight', 'plan', 'status', 'diagnose', 'logs', '--help']);
// Complete module paths can exceed 8 KiB. Match the existing Broker request
// envelope for typed release mutations; other commands keep their old limit.
export const CONTROLLED_RELEASE_COMMAND_MAX_LENGTH = 64 * 1024;

function tokenize(command, maxLength = 8192, quotedCheckpointPaths = false, inlinePreparationPlan = false) {
  if (typeof command !== 'string' || command.length === 0 || command.length > maxLength
    || SHELL_CONTROL.test(command)) return null;
  const tokens = command.trim().split(/\s+/u);
  if (tokens.length === 0) return null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (SAFE_TOKEN.test(token)) continue;
    if (inlinePreparationPlan && tokens[index - 1] === '--plan-base64'
      && PREPARATION_PLAN_BASE64URL.test(token)) continue;
    // Bracketed route names must be one quoted literal, never a shell glob.
    if (!quotedCheckpointPaths || tokens[index - 1] !== '--path'
      || !["'", '"'].includes(token[0]) || token.at(-1) !== token[0]
      || !CHECKPOINT_PATH.test(token.slice(1, -1))) return null;
    tokens[index] = token.slice(1, -1);
  }
  return tokens;
}

function consumeOptions(tokens, schema, invalid = () => null) {
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];
    const rule = schema[option];
    if (!rule) return invalid(`unsupported option ${option}`);
    if (value === undefined) return invalid(`missing value for ${option}`);
    if (!rule.pattern.test(value)) return invalid(`invalid value for ${option}`);
    if (rule.multiple) (values[option] ??= []).push(value);
    else if (values[option] !== undefined) return invalid(`duplicate option ${option}`);
    else values[option] = value;
  }
  return values;
}

function validCheckpointPath(value) {
  if (!CHECKPOINT_PATH.test(value) || value.startsWith('/')) return false;
  const segments = value.split('/');
  const testSourcePrefix = /^forge-server\/(?:[^/]+\/)*src\/test\/(?:java|resources)\//u.exec(value);
  const testSourceDepth = testSourcePrefix ? testSourcePrefix[0].split('/').length - 1 : Infinity;
  return segments.every((segment, index) => segment !== ''
    && segment !== '.'
    && segment !== '..'
    && (!CHECKPOINT_IGNORED_PATH_PARTS.has(segment)
      || (segment === 'coverage' && index >= testSourceDepth && index < segments.length - 1)));
}

function validCheckpointMessageBase64(value) {
  if (!BASE64URL.test(value)) return false;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length < 1 || bytes.length > 500 || bytes.toString('base64url') !== value) return false;
    const message = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return Buffer.from(message, 'utf8').equals(bytes) && !/[\p{Cc}]/u.test(message);
  } catch {
    return false;
  }
}

function parseEvidenceCommand(command, onInvalid) {
  const invalid = (reason) => { onInvalid?.(reason); return null; };
  const tokens = tokenize(command);
  if (!tokens) return null;
  const executable = tokens.shift();
  if (executable === 'forge-governance' || executable === '/usr/local/bin/forge-governance') {
    if (tokens.shift() !== 'audit') return null;
    const options = consumeOptions(tokens, {
      '--root': { pattern: /^(?:\.|\/workspace)$/u },
      '--base': { pattern: SHA },
      '--format': { pattern: /^json$/u },
    });
    if (!options || options['--base'] === undefined) return null;
    return { family: 'governance', executable: 'forge-governance', options };
  }
  if (executable !== 'forge-verify' && executable !== '/usr/local/bin/forge-verify') return null;
  const action = tokens.shift();
  const schemas = {
    admit: { '--profile': { pattern: PROFILE, multiple: true } },
    capability: { '--profile': { pattern: PROFILE } },
    run: {
      '--profile': { pattern: PROFILE },
      '--module': { pattern: MODULE, multiple: true },
      '--test': { pattern: TEST, multiple: true },
      '--file': { pattern: SAFE_TOKEN, multiple: true },
      '--test-file': { pattern: SAFE_TOKEN, multiple: true },
      '--idempotency-key': { pattern: IDEMPOTENCY },
      '--admission-id': { pattern: UUID },
      '--reuse-receipt': { pattern: UUID },
      '--execution-mode': { pattern: /^background$/u },
    },
    status: { '--job-id': { pattern: UUID }, '--wait-seconds': { pattern: /^(?:[1-9]|[1-5][0-9]|60)$/u } },
    watch: { '--job-id': { pattern: UUID } },
    receipt: { '--receipt-id': { pattern: UUID } },
    review: { '--contract-id': { pattern: /^[0-9a-f]{64}$/u } },
  };
  if (!Object.hasOwn(schemas, action)) return invalid('unsupported forge-verify action; discover profiles with forge-verify profiles --format json or use forge-verify --help; execution actions are admit, capability, run, status, watch, receipt and review');
  const options = consumeOptions(tokens, schemas[action], invalid);
  if (!options) return null;
  if (action === 'admit' && !Array.isArray(options['--profile'])) return invalid('missing required --profile');
  if (['capability', 'run'].includes(action) && options['--profile'] === undefined) return invalid('missing required --profile; discover available profiles with forge-verify profiles --format json');
  if (action === 'run' && options['--admission-id'] === undefined) return invalid('missing required --admission-id; use the current runtime-injected admission ID');
  if (action === 'run' && options['--idempotency-key'] === undefined) return invalid('missing required --idempotency-key');
  if (['status', 'watch'].includes(action) && options['--job-id'] === undefined) return invalid('missing required --job-id');
  if (action === 'receipt' && options['--receipt-id'] === undefined) return invalid('missing required --receipt-id');
  if (action === 'review' && options['--contract-id'] === undefined) return invalid('missing required --contract-id');
  if (action === 'run' && options['--execution-mode'] === undefined && options['--reuse-receipt'] === undefined
    && defaultBackgroundVerification(options['--profile'], { testFiles: options['--test-file'] })) {
    options['--execution-mode'] = 'background';
  }
  try {
    const validated = validateVerifyAction(action === 'admit'
      ? { action, profiles: options['--profile'] }
      : action === 'review'
      ? { action, acceptanceContractId: options['--contract-id'] }
      : action === 'capability'
      ? { action, profile: options['--profile'] }
      : action === 'run'
        ? {
            action,
            profile: options['--profile'],
            selectors: {
              ...(options['--module'] === undefined ? {} : { modules: options['--module'] }),
              ...(options['--test'] === undefined ? {} : { tests: options['--test'] }),
              ...(options['--file'] === undefined ? {} : { files: options['--file'] }),
              ...(options['--test-file'] === undefined ? {} : { testFiles: options['--test-file'] }),
            },
            idempotencyKey: options['--idempotency-key'],
            admissionId: options['--admission-id'],
            ...(options['--execution-mode'] === undefined ? {} : { executionMode: options['--execution-mode'] }),
            ...(options['--reuse-receipt'] === undefined ? {} : { receiptId: options['--reuse-receipt'] }),
          }
        : ['status', 'watch'].includes(action)
          ? { action: 'status', jobId: options['--job-id'], ...(options['--wait-seconds'] === undefined ? {} : { waitSeconds: Number(options['--wait-seconds']) }) }
          : { action, receiptId: options['--receipt-id'] });
    if (action === 'admit') options['--profile'] = validated.profiles;
  } catch (error) {
    // Surface the same validator that authorizes execution, without accepting
    // a repaired diagnostic copy or disclosing option values.
    const reason = error.message
      .replace(/verify modules/gu, '--module')
      .replace(/verify tests/gu, '--test')
      .replace(/verify testFiles/gu, '--test-file')
      .replace(/verify files/gu, '--file')
      .replace(/verify idempotencyKey/gu, '--idempotency-key')
      .replace(/verify admissionId/gu, '--admission-id');
    const focused = ['backend-test-class', 'backend-red-test'].includes(options['--profile'])
      ? ' This profile requires both --module <repository-relative forge-server/module> and --test <Class[#method]>.' : '';
    return invalid(reason + focused);
  }
  return {
    family: action === 'admit'
      ? 'forge-verify-admission'
      : `forge-verify-${options['--profile'] ?? action}`,
    executable: 'forge-verify', action, options,
  };
}

export function parseControlledEvidenceCommand(command) {
  return parseEvidenceCommand(command);
}

export function parseControlledVerificationInspectionCommand(command) {
  const tokens = tokenize(command);
  if (!tokens || !['forge-verify', '/usr/local/bin/forge-verify'].includes(tokens[0])) return null;
  const localHelp = (tokens.length === 2 && ['--help', '-h'].includes(tokens[1]))
    || (tokens.length === 3 && ['admit', 'capability', 'run', 'status', 'watch', 'receipt', 'review', 'profiles'].includes(tokens[1])
      && ['--help', '-h'].includes(tokens[2]));
  if (localHelp) {
    return { family: 'forge-verify-inspection', executable: 'forge-verify', action: 'help', options: {} };
  }
  if (tokens.length !== 4 || tokens[1] !== 'profiles' || tokens[2] !== '--format' || tokens[3] !== 'json') return null;
  // This is the CLI's local catalog, not admission, execution or a receipt.
  return { family: 'forge-verify-inspection', executable: 'forge-verify', action: 'profiles', options: { '--format': 'json' } };
}

export function parseControlledGovernanceInspectionCommand(command) {
  const tokens = tokenize(command);
  if (!tokens) return null;
  const executable = tokens.shift();
  if (executable !== 'forge-governance' && executable !== '/usr/local/bin/forge-governance') return null;
  const action = tokens.shift();
  if (action === 'audit') {
    const options = consumeOptions(tokens, {
      '--root': { pattern: /^(?:\.|\/workspace)$/u },
      '--base': { pattern: SHA },
      '--format': { pattern: /^(?:text|json)$/u },
      '--path': { pattern: REPOSITORY_PATH, multiple: true },
    });
    if (!options || options['--base'] === undefined || !options['--path']?.length
      || options['--path'].some(value => value.startsWith('-') || !validCheckpointPath(value))) return null;
    // The CLI marks explicit paths as diagnostic, never complete-change evidence.
    return { family: 'governance-inspection', executable: 'forge-governance', action, options };
  }
  if (action !== 'explain') return null;
  const options = consumeOptions(tokens, {
    '--rule': { pattern: /^[A-Z][A-Z0-9-]{0,127}$/u },
    '--format': { pattern: /^(?:text|json)$/u },
  });
  if (!options || options['--rule'] === undefined) return null;
  // A rule explanation is diagnostic output, never an audit receipt.
  return { family: 'governance-inspection', executable: 'forge-governance', action: 'explain', options };
}

// Delivery objectives can contain spaces and non-ASCII text. Accept only whole
// literal tokens: no shell expansion, escaped quotes, concatenation or operators.
export function parseControlledDeliveryCommand(command, onInvalid) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 8192
    || /[\p{Cc}$`\\;&|<>]/u.test(command)) return null;
  const input = command.trim();
  const pattern = /(?:'([^']*)'|"([^"]*)"|([\p{L}\p{N}_./:@=,+#-]+))(?: +|$)/uy;
  const tokens = [];
  while (pattern.lastIndex < input.length) {
    const match = pattern.exec(input);
    if (!match) return null;
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  const executable = tokens.shift();
  if (!['forge-delivery', '/usr/local/bin/forge-delivery'].includes(executable)) return null;
  if (tokens.length === 1 && ['--help', '-h'].includes(tokens[0])) {
    return { family: 'forge-delivery', executable: 'forge-delivery', action: 'help', mutation: false, options: {} };
  }
  const action = `${tokens.shift()}.${tokens.shift()}`;
  const invalid = reason => { onInvalid?.(reason); return null; };
  const identifier = { pattern: /^[a-z0-9][a-z0-9_-]{0,63}$/u };
  const schemas = {
    'change.status': { '--change': identifier },
    'change.init': {
      '--change': identifier,
      '--objective': { pattern: /^(?=.{1,4096}$).*\S.*$/u },
      '--idempotency-key': { pattern: IDEMPOTENCY },
    },
    'change.transition': {
      '--change': identifier,
      '--to': { pattern: /^(?:scoped|designed|implementing|implemented|verifying|evidence-recorded)$/u },
      '--expected-version': { pattern: /^[1-9][0-9]{0,15}$/u },
      '--idempotency-key': { pattern: IDEMPOTENCY },
      '--verification': { ...identifier, multiple: true },
    },
    'handoff.create': {
      '--handoff': identifier, '--change': identifier,
      '--source': { pattern: REPOSITORY_PATH, multiple: true },
    },
    'handoff.verify': { '--handoff': identifier },
    'contract.inspect': { '--source': { pattern: REPOSITORY_PATH, multiple: true } },
    'contract.bind': {
      '--source': { pattern: REPOSITORY_PATH, multiple: true }, '--binding': identifier,
      '--purpose': { pattern: /^(?:implementation|review|verification)$/u },
    },
    'contract.verify': { '--source': { pattern: REPOSITORY_PATH, multiple: true }, '--binding': identifier },
    'worktree.inspect': {},
  };
  if (!Object.hasOwn(schemas, action)) return null;
  const options = consumeOptions(tokens, schemas[action], invalid);
  if (!options) return null;
  const missing = Object.keys(schemas[action]).filter(key => key !== '--verification' && options[key] === undefined);
  if (missing.length > 0) return invalid(`${action.replace('.', ' ')} is missing required ${missing.join(', ')}`);
  if (options['--expected-version'] !== undefined
    && !Number.isSafeInteger(Number(options['--expected-version']))) return null;
  if (options['--source']?.some((value) => !validCheckpointPath(value)
    || value.split('/').includes('.forge-delivery'))) return invalid('--source must use ordinary repository-relative files outside generated .forge-delivery state');
  if (action.startsWith('contract.') && options['--source'].length !== 1) return invalid('contract commands require exactly one --source');
  // Self-reported verify record is deliberately not a model-facing operation.
  return { family: 'forge-delivery', executable: 'forge-delivery', action,
    mutation: ['change.init', 'change.transition', 'handoff.create', 'contract.bind'].includes(action), options };
}

export function parseControlledReleaseInspectionCommand(command) {
  const tokens = tokenize(command);
  if (!tokens) return null;
  const executable = tokens.shift();
  if (executable !== 'forge-release' && executable !== '/usr/local/bin/forge-release') return null;
  const action = tokens.shift();
  if (!RELEASE_INSPECTION_ACTIONS.has(action)) return null;
  let options = {};
  if (action === 'status' && tokens.length > 0) {
    options = consumeOptions(tokens, { '--operation-id': { pattern: STRICT_UUID } }, () => null);
    if (!options || !options['--operation-id']) return null;
  } else if (action === 'logs') {
    options = consumeOptions(tokens, {
      '--services': { pattern: /^[a-z-]+(?:,[a-z-]+)*$/u },
      '--tail': { pattern: /^[1-9][0-9]{0,3}$/u },
      '--since': { pattern: /^[1-9][0-9]{0,4}[smh]$/u },
    }, () => null);
    if (!options) return null;
    const services = options['--services']?.split(',');
    if (services && (new Set(services).size !== services.length
      || services.some(service => !RELEASE_SERVICES.has(service)))) return null;
    if (options['--tail'] && Number(options['--tail']) > 1000) return null;
    if (options['--since']) {
      const since = options['--since'];
      const seconds = Number(since.slice(0, -1)) * { s: 1, m: 60, h: 3600 }[since.at(-1)];
      if (seconds > 86400) return null;
    }
  } else if (tokens.length !== 0) return null;
  return {
    family: 'forge-release-inspection',
    executable: 'forge-release',
    action,
    options,
  };
}

export function controlledEvidenceCommandHint(command) {
  if (typeof command === 'string' && /^(?:forge-release|\/usr\/local\/bin\/forge-release)\s+prepare(?:\s|$)/u.test(command.trim())) {
    let reason;
    parseControlledReleasePreparationCommand(command, value => { reason = value; });
    if (!reason) return '';
    return ` Command not executed: ${reason}. Load or reload forge-controlled-release. Exact prepare argv: forge-release prepare --expected-head <current-40-lowercase-hex-HEAD> --expected-fingerprint <current-64-lowercase-hex-fingerprint> --plan-base64 <canonical-unpadded-base64url-UTF8-JSON-object>; alternatively replace only --plan-base64 and its value with --plan-json '<single-line-JSON-object>'. Supply exactly one plan format, at most 32 KiB, using the current protected preparation source and scope. Correct these arguments and continue in this turn within the existing authorization; do not request new user confirmation merely for this syntax error or repeat the unchanged command. Existing preparation authority, source, and plan checks still apply.`;
  }
  const contractCommand = typeof command === 'string'
    ? /^(?:forge-delivery|\/usr\/local\/bin\/forge-delivery)\s+contract\s+(inspect|bind|verify)(?:\s|$)/u.exec(command.trim()) : null;
  if (contractCommand) {
    let reason;
    parseControlledDeliveryCommand(command, value => { reason = value; });
    if (!reason) return '';
    const action = contractCommand[1];
    const options = action === 'inspect' ? '' : action === 'verify'
      ? ' --binding <current-binding-id>' : ' --binding <binding-id> --purpose <implementation|review|verification>';
    return ` Command not executed: ${reason}. Load or reload forge-task-contract. Exact contract argv: forge-delivery contract ${action} --source <one-repository-relative-contract-file>${options}. Use the actual contract file and binding in the current task scope; contract files do not grant permission or prove acceptance by themselves. Correct these arguments and continue in this turn within the existing authorization; do not request new user confirmation merely for this syntax error or repeat the unchanged command. Existing contract, source, and permission checks still apply.`;
  }
  const checkpointTokens = tokenize(command, CONTROLLED_RELEASE_COMMAND_MAX_LENGTH, true);
  if (checkpointTokens && ['forge-release', '/usr/local/bin/forge-release'].includes(checkpointTokens[0])
    && checkpointTokens[1] === 'release') {
    let reason;
    parseControlledReleaseMutationCommand(command, value => { reason = value; });
    if (!reason) return '';
    return ` Command not executed: ${reason}. Load or reload forge-controlled-release. Exact release argv: forge-release release --services <comma-separated-authorized-services> [--version <version>] [--approval-ref <existing-approval-ref>]. Supported service names are forge-admin, forge-app, forge-flow, forge-ui; select only the already authorized services, without duplicates or expanding the release. Optional version and approval reference must retain their current bindings; do not invent an approval. Correct these arguments and continue in this turn within the existing authorization; do not request new user confirmation merely for this syntax error or repeat the unchanged command. Existing release authority, candidate, and acceptance checks still apply.`;
  }
  if (checkpointTokens && ['forge-release', '/usr/local/bin/forge-release'].includes(checkpointTokens[0])
    && checkpointTokens[1] === 'checkpoint') {
    let reason;
    parseControlledReleaseMutationCommand(command, value => { reason = value; });
    if (!reason) return '';
    const help = checkpointTokens.length === 3 && checkpointTokens[2] === '--help'
      ? ' checkpoint --help is not supported; use forge-release --help.' : '';
    return ` Command not executed: ${reason}.${help} Load or reload forge-git-checkpoint. Exact checkpoint argv: forge-release checkpoint --path <repo-relative-path> [--path <another-path> ...] --message-base64 <unpadded-base64url-UTF8-commit-message> --expected-head <current-40-lowercase-hex-HEAD> --expected-fingerprint <current-64-lowercase-hex-fingerprint>. Use current forge-release preflight source bindings and only the authorized changed paths. Correct the arguments within the existing authorized scope; do not request new user confirmation merely for this syntax error or repeat the unchanged command. Existing permission, source, and checkpoint checks still apply.`;
  }
  const tokens = tokenize(command);
  if (!tokens || !['forge-verify', '/usr/local/bin/forge-verify'].includes(tokens[0])) return '';
  let reason;
  parseEvidenceCommand(command, (value) => { reason = value; });
  if (!reason) return '';
  return ` Command not executed: ${reason}.${backendModuleCommandHint(command)} Correct the reported arguments using the current task scope and runtime-injected admission ID, then retry the corrected command in this turn. Changing bash run_in_background does not fix argv validation. Do not repeat the unchanged command, request new user authorization for this syntax error, or treat this rejection as a verification result.`;
}

function backendModuleCommandHint(command) {
  const tokens = tokenize(command);
  if (!tokens || !['forge-verify', '/usr/local/bin/forge-verify'].includes(tokens[0])
    || tokens[1] !== 'run') return '';
  const index = tokens.indexOf('--profile');
  if (index < 2 || !['backend-module-test', 'backend-module-compile'].includes(tokens[index + 1])) return '';
  const profile = tokens[index + 1];
  const missingModule = !tokens.includes('--module');
  const unsupportedTest = tokens.includes('--test');
  if (!missingModule && !unsupportedTest) return '';
  // Validate only a diagnostic copy; the original command remains rejected.
  if (missingModule) tokens.push('--module', 'forge-server/example');
  if (unsupportedTest) tokens[index + 1] = 'backend-test-class';
  if (!parseControlledEvidenceCommand(tokens.join(' '))) return '';
  const hints = [];
  if (missingModule) {
    hints.push(`Missing required --module for ${profile}. Use forge-verify run --profile ${profile} --module <module> --admission-id <current-admission-id> --idempotency-key <key> without --test.`);
  }
  if (unsupportedTest) {
    hints.push(`Use backend-test-class --module <module> --test <Class[#method]> for a focused backend check; ${profile} does not accept --test. A focused check does not satisfy the required module test.`);
  }
  return ` ${hints.join(' ')}`;
}

export function parseControlledReleasePreparationArguments(argv, onInvalid) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')
    || argv.reduce((length, value) => length + value.length + 1, 0) > 48 * 1024) return null;
  const tokens = [...argv];
  if (!['forge-release', '/usr/local/bin/forge-release'].includes(tokens.shift())
    || tokens.shift() !== 'prepare') return null;
  const invalid = reason => { onInvalid?.(reason); return null; };
  const options = consumeOptions(tokens, {
    '--expected-head': { pattern: SHA },
    '--expected-fingerprint': { pattern: DIGEST },
    '--plan-base64': { pattern: PREPARATION_PLAN_BASE64URL },
    '--plan-json': { pattern: /^[^\r\n]{1,32768}$/u },
  }, invalid);
  if (!options) return null;
  const missing = ['--expected-head', '--expected-fingerprint'].filter(key => !options[key]);
  if (!options['--plan-base64'] && !options['--plan-json']) missing.push('exactly one of --plan-base64 or --plan-json');
  if (missing.length > 0) return invalid(`prepare is missing required ${missing.join(', ')}`);
  if (options['--plan-base64'] && options['--plan-json']) return invalid('prepare accepts exactly one of --plan-base64 or --plan-json, not both');
  try {
    const inline = options['--plan-json'];
    const bytes = inline === undefined
      ? Buffer.from(options['--plan-base64'], 'base64url') : Buffer.from(inline, 'utf8');
    if (bytes.length > 32 * 1024) return invalid('prepare plan must not exceed 32 KiB of UTF-8 JSON');
    if (inline === undefined ? bytes.toString('base64url') !== options['--plan-base64'] : bytes.toString('utf8') !== inline) {
      return invalid('prepare plan encoding must be canonical unpadded base64url or exact UTF-8 JSON');
    }
    const probePlan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!probePlan || typeof probePlan !== 'object' || Array.isArray(probePlan)) return invalid('prepare plan must be a JSON object, not null or an array');
    return { family: 'forge-release-preparation', executable: 'forge-release', action: 'prepare', options, probePlan };
  } catch { return invalid('prepare plan must contain valid UTF-8 JSON'); }
}

export function parseControlledReleasePreparationCommand(command, onInvalid) {
  if (typeof command !== 'string' || command.length > 48 * 1024 || /[\r\n]/u.test(command)) return null;
  // Only prepare has this one shell-literal argument. Mask its data before
  // applying the unchanged tokenizer to every byte outside the single quotes.
  const literal = /(^|\s)--plan-json\s+'([^'\r\n]*)'(?=\s|$)/u.exec(command);
  if (literal) {
    const masked = command.slice(0, literal.index) + `${literal[1]}--plan-json PREPARATION_JSON_LITERAL`
      + command.slice(literal.index + literal[0].length);
    const tokens = tokenize(masked, 48 * 1024, false, true);
    const index = tokens?.indexOf('--plan-json') ?? -1;
    if (index < 0 || tokens[index + 1] !== 'PREPARATION_JSON_LITERAL') return null;
    tokens[index + 1] = literal[2];
    return parseControlledReleasePreparationArguments(tokens, onInvalid);
  }
  const tokens = tokenize(command, 48 * 1024, false, true);
  if (!tokens) return null;
  if (tokens.includes('--plan-json')) {
    onInvalid?.('--plan-json requires one single-quoted, single-line JSON object');
    return null;
  }
  return parseControlledReleasePreparationArguments(tokens, onInvalid);
}

export function parseControlledReleaseMutationCommand(command, onInvalid) {
  const tokens = tokenize(command, CONTROLLED_RELEASE_COMMAND_MAX_LENGTH, true);
  if (!tokens) return null;
  const executable = tokens.shift();
  if (executable !== 'forge-release' && executable !== '/usr/local/bin/forge-release') return null;
  const action = tokens.shift();
  if (action === 'release') {
    const invalid = reason => { onInvalid?.(reason); return null; };
    const options = consumeOptions(tokens, {
      '--services': { pattern: SAFE_TOKEN },
      '--version': { pattern: RELEASE_VERSION },
      '--approval-ref': { pattern: RELEASE_APPROVAL_REF },
    }, invalid);
    if (!options) return null;
    if (options['--services'] === undefined) return invalid('release is missing required --services');
    const services = options['--services'].split(',');
    if (services.length < 1 || services.some(service => !RELEASE_SERVICES.has(service))) {
      return invalid('--services must contain only supported service names separated by commas');
    }
    if (new Set(services).size !== services.length) return invalid('--services must not contain duplicates');
    return {
      family: 'forge-release-mutation',
      executable: 'forge-release',
      action,
      options,
    };
  }
  if (action === 'integrate') {
    const options = consumeOptions(tokens, {
      '--mode': { pattern: /^(?:start|continue)$/u },
      '--expected-head': { pattern: SHA },
      '--expected-fingerprint': { pattern: DIGEST },
      '--canonical-head': { pattern: SHA },
      '--path': { pattern: CHECKPOINT_PATH, multiple: true },
      '--operation-id': { pattern: STRICT_UUID },
    });
    if (!options
      || options['--mode'] === undefined
      || options['--expected-head'] === undefined
      || options['--expected-fingerprint'] === undefined
      || options['--canonical-head'] === undefined) return null;
    const paths = options['--path'] ?? [];
    if (new Set(paths).size !== paths.length
      || paths.some((integratePath) => !validCheckpointPath(integratePath))) return null;
    const operationId = options['--operation-id'];
    if ((options['--mode'] === 'start' && operationId !== undefined)
      || (options['--mode'] === 'continue' && operationId === undefined)) return null;
    return {
      family: 'forge-release-mutation',
      executable: 'forge-release',
      action,
      options,
    };
  }
  if (action !== 'checkpoint') return null;
  const invalid = reason => { onInvalid?.(reason); return null; };
  const options = consumeOptions(tokens, {
    '--path': { pattern: CHECKPOINT_PATH, multiple: true },
    '--message-base64': { pattern: BASE64URL },
    '--expected-head': { pattern: SHA },
    '--expected-fingerprint': { pattern: DIGEST },
  }, invalid);
  if (!options) return null;
  const missing = ['--path', '--message-base64', '--expected-head', '--expected-fingerprint']
    .filter(option => options[option] === undefined);
  if (missing.length > 0) return invalid(`checkpoint is missing required ${missing.join(', ')}`);
  const paths = options?.['--path'];
  if (!Array.isArray(paths) || paths.length < 1) return invalid('checkpoint requires at least one --path');
  if (new Set(paths).size !== paths.length) return invalid('checkpoint --path values must be unique');
  if (paths.some(checkpointPath => !validCheckpointPath(checkpointPath))) return invalid('invalid checkpoint --path');
  if (!validCheckpointMessageBase64(options['--message-base64'])) {
    return invalid('checkpoint --message-base64 must be canonical unpadded base64url of 1 to 500 UTF-8 bytes without control characters');
  }
  return {
    family: 'forge-release-mutation',
    executable: 'forge-release',
    action,
    options,
  };
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function selectorsFromOptions(options) {
  return {
    ...(options['--module'] === undefined ? {} : { modules: options['--module'] }),
    ...(options['--test'] === undefined ? {} : { tests: options['--test'] }),
    ...(options['--file'] === undefined ? {} : { files: options['--file'] }),
    ...(options['--test-file'] === undefined ? {} : { testFiles: options['--test-file'] }),
  };
}

function sameSelectors(left, right) {
  if (!left || typeof left !== 'object' || Array.isArray(left)
      || !right || typeof right !== 'object' || Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && sameArray(left[key], right[key]));
}

function canonicalDate(value) {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validAdmissionReceipt(receipt, profiles) {
  if (isHostExecutionAdmissionReceipt(receipt)) {
    try {
      validateHostExecutionAdmissionReceipt(receipt, { profiles });
      return true;
    } catch {
      return false;
    }
  }
  if (receipt?.receiptType !== 'forge-verify/execution-admission'
      || receipt.schemaVersion !== 1
      || !sameArray(receipt.profiles, profiles)
      || typeof receipt.projectSlug !== 'string'
      || typeof receipt.taskId !== 'string'
      || typeof receipt.runner?.bootId !== 'string'
      || !UUID.test(receipt.runner.bootId)
      || typeof receipt.runner?.revision !== 'string'
      || typeof receipt.source?.workspaceFingerprint !== 'string'
      || !/^[0-9a-f]{64}$/u.test(receipt.source.workspaceFingerprint)
      || typeof receipt.source?.dependencyManifestFingerprint !== 'string'
      || !/^[0-9a-f]{64}$/u.test(receipt.source.dependencyManifestFingerprint)
      || typeof receipt.cache?.compatible !== 'boolean'
      || typeof receipt.executor?.proven !== 'boolean'
      || !VERIFY_ADMISSION_OUTCOMES.has(receipt.outcome)
      || receipt.truth?.executionProven !== false
      || receipt.truth?.verificationProven !== false
      || receipt.truth?.semanticCorrectnessProven !== false
      || receipt.truth?.databaseIntegrationProven !== false
      || receipt.truth?.releaseProven !== false) return false;
  if (receipt.outcome !== 'ready') {
    return receipt.admissionId === null
      && receipt.issuedAt === null
      && receipt.expiresAt === null
      && typeof receipt.reasonCode === 'string';
  }
  const leaseDurationMs = Date.parse(receipt.expiresAt) - Date.parse(receipt.issuedAt);
  return typeof receipt.admissionId === 'string'
    && UUID.test(receipt.admissionId)
    && receipt.reasonCode === null
    && receipt.cache.compatible === true
    && typeof receipt.cache.packDigest === 'string'
    && /^sha256:[0-9a-f]{64}$/u.test(receipt.cache.packDigest)
    && receipt.executor.proven === true
    && receipt.executor.dockerApiProven === true
    && receipt.executor.toolchainImageProven === true
    && receipt.executor.samePathBindProven === true
    && receipt.executor.stateWriteProven === true
    && receipt.executor.cleanupProven === true
    && canonicalDate(receipt.issuedAt)
    && canonicalDate(receipt.expiresAt)
    && leaseDurationMs >= 30_000
    && leaseDurationMs <= 15 * 60_000;
}

function extractJsonDocument(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 4 * 1024 * 1024) return null;
  const normalized = text
    .replace(/\r\n/gu, '\n')
    .replace(/\n?\[exit code:\s*0\]\s*$/iu, '')
    .trim();
  if (!normalized.startsWith('{') || !normalized.endsWith('}')) return null;
  try {
    const value = JSON.parse(normalized);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function controlledEvidenceReceipt(command, output) {
  const parsed = parseControlledEvidenceCommand(command);
  if (!parsed) return null;
  // Review stdout is a projection; only the protected issuer's signed state
  // can establish independent review evidence.
  if (parsed.action === 'review') return null;
  let receipt = extractJsonDocument(output);
  if (!receipt) return null;
  if (parsed.family === 'governance') {
    if (typeof receipt.ok !== 'boolean'
      || typeof receipt.receiptDigest !== 'string'
      || !receipt.receiptDigest.match(/^sha256:[0-9a-f]{64}$/u)
      || !Array.isArray(receipt.obligations)) return null;
  } else if (parsed.action === 'admit') {
    if (!validAdmissionReceipt(receipt, parsed.options['--profile'])) return null;
  } else if (parsed.action === 'run' || parsed.action === 'receipt') {
    if (parsed.action === 'run' && parsed.options['--execution-mode'] === 'background'
      && receipt.receiptType === 'forge-verify/host-job') {
      if (receipt.schemaVersion !== 1 || receipt.receiptType !== 'forge-verify/host-job'
        || !STRICT_UUID.test(receipt.jobId ?? '') || !STRICT_UUID.test(receipt.receiptId ?? '')
        || !['accepted', 'passed', 'failed', 'timed-out', 'failed-zero-tests', 'cancelled', 'interrupted'].includes(receipt.status)
        || receipt.request?.profile !== parsed.options['--profile']
        || receipt.request?.admissionId !== parsed.options['--admission-id']
        || receipt.request?.idempotencyKey !== parsed.options['--idempotency-key']
        || !sameSelectors(receipt.request?.selectors, selectorsFromOptions(parsed.options))
        || receipt.truth?.executionProven !== false || receipt.truth?.verificationProven !== false
        || receipt.truth?.releaseProven !== false) return null;
      return { command: parsed, receipt };
    }
    const expectedSelectors = parsed.action === 'run' ? selectorsFromOptions(parsed.options) : undefined;
    if (isHostRunReceipt(receipt)) {
      // The Host may project bounded diagnostic text for newer clients. It is
      // visible to the model, but is never part of the accepted machine evidence.
      if (receipt.logs && Object.hasOwn(receipt.logs, 'excerpt')) {
        const { excerpt, ...canonicalLogs } = receipt.logs;
        if (typeof excerpt !== 'string' || Buffer.byteLength(excerpt, 'utf8') > 16 * 1024
            || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(excerpt)) return null;
        receipt = { ...receipt, logs: canonicalLogs };
      }
      try {
        validateHostRunReceipt(receipt, parsed.action === 'run' ? {
          profile: parsed.options['--profile'],
          admissionId: parsed.options['--admission-id'],
          reuseReceiptId: parsed.options['--reuse-receipt'],
          allowRevalidation: parsed.options['--reuse-receipt'] !== undefined,
        } : {
          receiptId: parsed.options['--receipt-id'],
          requireCurrent: true,
        });
      } catch {
        return null;
      }
      if (expectedSelectors !== undefined && !sameSelectors(receipt.request.selectors, expectedSelectors)) return null;
      return { command: parsed, receipt };
    }
    if (parsed.options['--reuse-receipt'] !== undefined || receipt.receiptType !== 'forge-verify/run'
      || typeof receipt.receiptId !== 'string'
      || !UUID.test(receipt.receiptId)
      || !VERIFY_RUN_STATUSES.has(receipt.status)
      || typeof receipt.source?.workspaceFingerprint !== 'string'
      || !/^[0-9a-f]{64}$/u.test(receipt.source.workspaceFingerprint)
      || typeof receipt.request?.profile !== 'string'
      || !PROFILE.test(receipt.request.profile)
      || typeof receipt.request?.admissionId !== 'string'
      || !UUID.test(receipt.request.admissionId)
      || typeof receipt.truth?.verificationProven !== 'boolean'
      || (receipt.status === 'passed') !== receipt.truth.verificationProven
      || (parsed.action === 'run'
        && (receipt.request.profile !== parsed.options['--profile']
          || receipt.request.admissionId !== parsed.options['--admission-id']
          || !sameSelectors(receipt.request.selectors, expectedSelectors)))
      || (parsed.action === 'receipt' && receipt.receiptId !== parsed.options['--receipt-id'])
      || (parsed.action === 'receipt' && receipt.freshness !== 'current')) return null;
    try {
      validateVerifyAction({ action: 'capability', profile: receipt.request.profile });
    } catch {
      return null;
    }
  } else if (parsed.action === 'capability') {
    if (isHostCapabilityReceipt(receipt)) {
      try {
        validateHostCapabilityReceipt(receipt, { profile: parsed.options['--profile'] });
      } catch {
        return null;
      }
      return { command: parsed, receipt };
    }
    if (receipt.receiptType !== 'forge-verify/capability'
      || typeof receipt.receiptId !== 'string'
      || !UUID.test(receipt.receiptId)
      || receipt.profile !== parsed.options['--profile']
      || typeof receipt.outcome !== 'string') return null;
  } else if (parsed.action === 'status') {
    if (typeof receipt.active !== 'boolean'
      || receipt.jobId !== parsed.options['--job-id']) return null;
  }
  return { command: parsed, receipt };
}

export function isControlledEvidenceCommand(command) {
  return parseControlledEvidenceCommand(command) !== null;
}
