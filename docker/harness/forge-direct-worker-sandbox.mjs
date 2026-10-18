import { existsSync, lstatSync, readdirSync, realpathSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { tmpdir } from 'node:os';

const HIDDEN = /^(?:\.git|\.ssh|\.gnupg|\.aws|\.azure|\.kube|ops|governance|\.env(?:\..*)?|\.npmrc|\.netrc|\.gitconfig|credentials(?:\..*)?|id_rsa|id_ed25519)$/iu;
const READ_ONLY = new Set(['AGENTS.md', 'PROJECT_CONTEXT.md', 'project.manifest.json', '.agents', '.forge-delivery', '.forge-platform']);
let gitEmptyConfig;
function emptyGitConfiguration() {
  if (!gitEmptyConfig) {
    // A regular empty file works under nodev workspace mounts; a bound /dev/null
    // remains a device and can return EACCES. The private outer /tmp is hidden in
    // every command sandbox. Keep one file per worker, never use caller content.
    const directory = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'forge-direct-git-'));
    gitEmptyConfig = join(directory, 'empty-config');
    writeFileSync(gitEmptyConfig, '', { flag: 'wx', mode: 0o400 });
  }
  return gitEmptyConfig;
}

export function directWorkerConfinement(argv, policy, { workspaceRoot = '/workspace', filesystem = { lstatSync, readdirSync, realpathSync }, systemPathExists = existsSync } = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(value => typeof value !== 'string')
    || !['read-only', 'workspace-write'].includes(policy?.mode) || policy.workspaceRoot !== workspaceRoot
    || filesystem.realpathSync(workspaceRoot) !== workspaceRoot) {
    throw Object.assign(new Error('Direct commands require the isolated canonical writable TaskSpace.'), { code: 'SANDBOX_UNAVAILABLE' });
  }
  // No Landlock fallback: a whole-workspace write grant cannot exclude Git and
  // platform state. Bubblewrap also hides the worker socket and parent processes.
  // Ordinary commands only see static machine statistics. The fixed trusted
  // browser worker requires /proc/self; mount proc only inside its NEW PID
  // namespace. This is never a model-selected policy option or shell profile.
  // Enforce effects with mounts, not a shell/Git syntax allowlist. Scripts,
  // pipes, Unicode paths and ordinary Git history commands share these bounds.
  const browserWorker = argv.length === 2 && argv[0] === '/usr/local/bin/node'
    && argv[1] === '/usr/local/lib/forge-browser-worker.mjs';
  const wrapped = ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', browserWorker ? '--proc' : '--tmpfs', '/proc',
    '--die-with-parent', '--tmpfs', '/tmp', '--tmpfs', '/run', policy.mode === 'read-only' ? '--ro-bind' : '--bind', workspaceRoot, workspaceRoot];
  for (const entry of browserWorker ? [] : ['cpuinfo', 'meminfo', 'stat', 'uptime', 'loadavg', 'version']) {
    wrapped.push('--ro-bind-try', `/proc/${entry}`, `/proc/${entry}`);
  }
  // Docker's locked proc child mounts prevent an unprivileged PID namespace
  // from mounting its own proc on Linux 6.8. The direct-worker composition keeps
  // the outer container's private PID proc visible to this trusted launcher.
  // Restore Docker's sensitive paths inside every sandbox before executing code.
  // Ordinary commands retain the stricter static proc view above (no processes).
  if (browserWorker) {
    for (const entry of ['bus', 'fs', 'irq', 'sys', 'sysrq-trigger']) {
      const target = `/proc/${entry}`;
      if (systemPathExists(target)) wrapped.push('--ro-bind', target, target);
    }
    for (const entry of ['interrupts', 'kcore', 'keys', 'latency_stats', 'sched_debug', 'timer_list', 'timer_stats']) {
      const target = `/proc/${entry}`;
      if (systemPathExists(target)) wrapped.push('--ro-bind', '/dev/null', target);
    }
  }
  for (const target of [...(browserWorker ? ['/proc/acpi', '/proc/asound', '/proc/scsi'] : []), '/sys/firmware', '/sys/devices/virtual/powercap']) {
    if (systemPathExists(target)) wrapped.push('--tmpfs', target, '--remount-ro', target);
  }
  for (const entry of filesystem.readdirSync(workspaceRoot)) {
    const filename = posix.join(workspaceRoot, entry);
    const metadata = filesystem.lstatSync(filename);
    if (HIDDEN.test(entry) || /\.(?:pem|key|p12|pfx)$/iu.test(entry)) {
      if (metadata.isSymbolicLink()) throw Object.assign(new Error('Protected workspace paths must not be symlinks.'), { code: 'SANDBOX_UNAVAILABLE' });
      if (entry === '.git') {
        if (!metadata.isDirectory() || filesystem.realpathSync(filename) !== filename) {
          throw Object.assign(new Error('Read-only Git requires the current isolated clone metadata directory.'), { code: 'SANDBOX_UNAVAILABLE' });
        }
        // History is readable for every command, metadata is never writable.
        // Credentials/config/hooks remain hidden even from nested scripts.
        wrapped.push('--ro-bind', filename, filename);
        for (const child of filesystem.readdirSync(filename)) {
          if (!['config', 'config.worktree', 'hooks', 'commondir'].includes(child)) continue;
          const target = posix.join(filename, child), stat = filesystem.lstatSync(target);
          if (stat.isSymbolicLink()) throw Object.assign(new Error('Git reader configuration paths must not be symlinks.'), { code: 'SANDBOX_UNAVAILABLE' });
          wrapped.push(...(stat.isDirectory() ? ['--tmpfs', target] : ['--ro-bind', emptyGitConfiguration(), target]));
        }
        continue;
      }
      wrapped.push(...(metadata.isDirectory() ? ['--tmpfs', filename] : ['--ro-bind', '/dev/null', filename]));
    } else if (READ_ONLY.has(entry)) {
      if (metadata.isSymbolicLink()) throw Object.assign(new Error('Protected workspace paths must not be symlinks.'), { code: 'SANDBOX_UNAVAILABLE' });
      wrapped.push('--ro-bind', filename, filename);
    }
  }
  {
    for (const [key, value] of Object.entries({ GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })) wrapped.push('--setenv', key, value);
  }
  wrapped.push('--', ...argv);
  return { argv: wrapped, enforcement: 'full', denialSignatures: ['read-only file system', 'permission denied'],
    runnerFailureRules: [{ fatalSignatures: ['bwrap: '] }] };
}

export function directWorkerSpawnSpec(spec) {
  // A caller cannot choose danger-full-access or bypass confinement via the
  // subprocess bridge. Only the worker-produced wrapper reaches spawn.
  if (!Array.isArray(spec?.argv) || spec.argv[0] !== '/usr/bin/bwrap'
    || !spec.argv.includes('--unshare-pid') || !spec.argv.includes('/run')) {
    throw Object.assign(new Error('Direct worker processes require the protected sandbox wrapper.'), { code: 'SANDBOX_UNAVAILABLE' });
  }
  // /tmp is replaced by a fresh private tmpfs above, so starting there cannot
  // expose the outer worker's temporary files. Other host paths stay excluded.
  if (typeof spec.cwd !== 'string' || (spec.cwd !== '/tmp' && spec.cwd !== '/workspace' && !spec.cwd.startsWith('/workspace/'))
    || spec.cwd.split('/').includes('..')) throw Object.assign(new Error('Command cwd must be its TaskSpace or the sandbox private /tmp.'), { code: 'SANDBOX_UNAVAILABLE' });
  // These variables affect the outer trusted launcher before the inner command.
  const env = Object.fromEntries(Object.entries(spec.env ?? {}).filter(([key]) => !/^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|GIT_|FORGE_|OPENAI_|DEEPSEEK_|ANTHROPIC_|AZURE_OPENAI_)/iu.test(key)));
  return { ...spec, env };
}
