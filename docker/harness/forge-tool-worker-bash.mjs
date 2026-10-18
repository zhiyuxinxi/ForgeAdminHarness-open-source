import {
  parseControlledEvidenceCommand,
  parseControlledVerificationInspectionCommand,
  parseControlledReleaseInspectionCommand,
  parseControlledReleasePreparationCommand,
  parseControlledReleaseMutationCommand,
} from './forge-controlled-command.mjs';
import { currentDirectToolPolicy } from './forge-direct-development.mjs';

// Only these two installed clients require the private Broker token. They read
// that fixed token locally and send typed Broker requests; caller paths are
// request selectors, not arbitrary files opened by the client. Delivery and
// governance commands need no private token and stay in the tool worker.
export function trustedToolArgv(command) {
  const parsed = parseControlledReleasePreparationCommand(command)
    ?? parseControlledReleaseMutationCommand(command)
    ?? parseControlledReleaseInspectionCommand(command)
    ?? parseControlledVerificationInspectionCommand(command)
    ?? parseControlledEvidenceCommand(command);
  if (!parsed || !['forge-verify', 'forge-release'].includes(parsed.executable)) return null;
  const argv = [`/usr/local/bin/${parsed.executable}`, parsed.action === 'help' ? '--help' : parsed.action];
  for (const [key, value] of Object.entries(parsed.options)) {
    for (const item of Array.isArray(value) ? value : [value]) argv.push(key, item);
  }
  return argv;
}

export function createToolWorkerBashExecutor(ExistingSandboxBashExecutor, trustedExecutor) {
  if (typeof trustedExecutor?.runArgv !== 'function' || typeof trustedExecutor?.startArgv !== 'function') {
    throw new Error('TOOL_WORKER_TRUSTED_EXECUTOR_REQUIRED');
  }
  return class ToolWorkerBashExecutor extends ExistingSandboxBashExecutor {
    trustedSpec(spec) {
      // Model-provided NODE_OPTIONS/LD_PRELOAD/BASH_ENV, alternate cwd and stdin
      // must never turn a typed client into privileged arbitrary execution.
      // Real Broker authorization and the existing pre-execute guard still run.
      const { env: _env, dshEnv: _dshEnv, stdin: _stdin, ...safe } = spec;
      return { ...safe, workdir: '/workspace' };
    }
    run(spec) {
      const argv = trustedToolArgv(spec.command);
      return argv ? trustedExecutor.runArgv(this.trustedSpec(spec), argv) : super.run(this.developmentSpec(spec));
    }
    start(spec) {
      const argv = trustedToolArgv(spec.command);
      return argv ? trustedExecutor.startArgv(this.trustedSpec(spec), argv) : super.start(this.developmentSpec(spec));
    }
    developmentSpec(spec) {
      if (process.env.FORGE_DEVELOPMENT_MODE !== 'direct') return spec;
      return { ...spec, sandboxPolicy: currentDirectToolPolicy() };
    }
  };
}
