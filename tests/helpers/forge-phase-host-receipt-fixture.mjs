import crypto from 'node:crypto';

export function createForgePhaseHostReceipt({
  profile = 'governance', receiptId = '123e4567-e89b-12d3-a456-426614174000',
  projectSlug = 'forge-project', taskId = 'task-one', sourceFingerprint = 'b'.repeat(64),
  sourceCommit = 'a'.repeat(40), selectors = {},
} = {}) {
  const executables = {};
  for (const name of ['java', 'maven', 'node', 'pnpm', 'git', 'forgeGovernance']) {
    executables[name] = { configuredPath: `/opt/forge-tools/${name}`, resolvedPath: `/opt/forge-tools/${name}`,
      bytes: 100, modifiedMs: 1, version: `${name} 1.0.0` };
  }
  return {
    schemaVersion: 2, receiptType: 'forge-verify/host-run', receiptId,
    jobId: '123e4567-e89b-12d3-a456-426614174001', projectSlug, taskId, status: 'passed',
    source: { head: sourceCommit, workspaceFingerprint: sourceFingerprint,
      dependencyManifestFingerprint: 'c'.repeat(64), snapshotSha256: sourceFingerprint, fileCount: 10, bytes: 1000 },
    request: { profile, selectors,
      selectorsSha256: crypto.createHash('sha256').update(JSON.stringify(selectors)).digest('hex'),
      idempotencyDigest: '5'.repeat(64), admissionId: '123e4567-e89b-12d3-a456-426614174099' },
    policy: { profileCatalogVersion: '2026.09.03.22', profilePolicyDigest: '7'.repeat(64) },
    toolchain: { javaHome: '/opt/forge-tools/java-home', executables, digest: '8'.repeat(64) },
    isolation: { mode: 'host-toolchain-isolated-taskspace', taskStateRoot: '/srv/forge/state/task-one',
      cacheRoot: '/srv/forge/state/task-one/cache', globalUserConfigRead: false, arbitraryShell: false,
      requestControlledEnvironment: false, cleanupProven: true },
    execution: {
      steps: [{ executable: '/opt/forge-tools/forgeGovernance', argv: ['audit'], cwd: '/srv/forge/job',
        exitCode: 0, signal: null, timedOut: false, processEnded: true,
        transportUncertain: false, cleanup: { proven: true } }],
      exitCode: 0, signal: null, startedAt: '2026-09-03T12:00:01.000Z', finishedAt: '2026-09-03T12:00:02.000Z',
    },
    results: { executed: 1, passed: 1, failed: 0, skipped: 0, reportFiles: 1, zeroTestsRejected: false },
    logs: { path: '/srv/forge/logs/run.log', sha256: '6'.repeat(64), bytes: 10, truncated: false, redacted: true },
    truth: { executionProven: true, verificationProven: true, semanticCorrectnessProven: false,
      databaseIntegrationProven: false, releaseProven: false },
    freshness: 'current',
  };
}
