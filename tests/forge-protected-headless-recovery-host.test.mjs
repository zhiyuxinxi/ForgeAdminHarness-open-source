import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildRecoveryContainerCreateArgs,
  buildRecoveryPreIngressCancellationContainerCreateArgs,
  canonicalJsonBytes,
  executeHostProtectedRecovery,
  probeHarnessMaintenanceHealth,
  prepareHostRecoveryInputs,
  recoveryContainerEnvironment,
  validateHarnessRecoveryBoundary,
  validateBrokerRecoveryBoundary,
  validateHostRecoveryDescriptor,
  validatePinnedBrokerDnsBoundary,
  validateRecoveryContainerBoundary,
  validateRecoveryHelperImageBoundary,
  validateRecoverySecretSourceMetadata,
  waitForStableMaintenanceDrain,
} from '../scripts/run-forge-protected-headless-recovery.mjs';
import { digestDirectUserTextContent } from '../docker/harness/forge-execution-context.mjs';
import {
  observeForgeDeliveryPhase,
  snapshotForgeDeliveryWorkspace,
  validateForgeDeliveryWorkspaceSnapshot,
} from '../docker/harness/forge-delivery-phase-workspace-observer.mjs';

const operationId = '11111111-1111-4111-8111-111111111111';
const harnessId = 'a'.repeat(64);
const helperId = 'b'.repeat(64);
const cancellationHelperId = '1'.repeat(64);
const brokerId = 'd'.repeat(64);
const imageId = `sha256:${'c'.repeat(64)}`;
const brokerImageId = `sha256:${'f'.repeat(64)}`;
const helperImageId = `sha256:${'e'.repeat(64)}`;
const startedAt = '2026-09-05T00:00:00.000000000Z';
const taskId = 'skills-canary-20260903';
const helperSourceSha256 = '8'.repeat(64);
const helperBuildInputDigest = `sha256:${'9'.repeat(64)}`;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('recovery prompt digest is the canonical DSH content digest, not the raw text hash', () => {
  const text = 'Forge canonical prompt vector';
  assert.equal(
    digestDirectUserTextContent([{ type: 'text', text }]),
    'b7af946387e60ce50fe194a5a1331c316fabab2ffffcd8e861cc4dbb082975ee',
  );
  assert.equal(sha256(Buffer.from(text)), 'a167cd2efaee0e9b4f2f31b58d1ea72bbf754f456da2044b86dd9b37c82c94eb');
  assert.notEqual(
    digestDirectUserTextContent([{ type: 'text', text }]),
    sha256(Buffer.from(text)),
  );
});

function descriptorSha(value) {
  const copy = structuredClone(value);
  copy.operation.descriptorSha256 = null;
  return sha256(canonicalJsonBytes(copy));
}

function phaseArtifact(kind, ordinal) {
  const value = {
    schemaVersion: 'forge-delivery-phase-artifact/v1',
    workflowId: 'crud-production',
    phaseId: `phase-${ordinal}`,
    artifactKind: kind,
    attemptId: `${String(ordinal).repeat(8)}-${String(ordinal).repeat(4)}-4${String(ordinal).repeat(3)}-8${String(ordinal).repeat(3)}-${String(ordinal).repeat(12)}`,
    sourceFingerprint: String(ordinal).repeat(64),
    upstreamArtifactDigests: {},
    unresolvedDecisions: [],
    changedPaths: [],
    patchDigest: null,
    payload: {},
    artifactDigest: '',
  };
  const canonical = canonicalJsonBytes(value);
  const withoutDigest = structuredClone(value);
  delete withoutDigest.artifactDigest;
  const bytes = canonicalJsonBytes(withoutDigest);
  value.artifactDigest = sha256(bytes.subarray(0, bytes.length - 1));
  return value;
}

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-recovery-'));
  const project = path.join(root, 'projects', 'forge-base');
  const taskspace = path.join(project, 'taskspaces', taskId);
  const canary = path.join(root, 'canary', 'forge-skills-20260903');
  const runRoot = path.join(canary, 'runs', 'supplier-admission-a9');
  const phase = path.join(runRoot, 'controller');
  const artifacts = path.join(phase, 'artifacts');
  const attempt = path.join(runRoot, 'phases', '05-backend-attempt2');
  const evidence = path.join(runRoot, 'recovery-evidence', operationId);
  const policyDirectory = path.join(canary, 'policies');
  const skillBundleRoot = path.join(canary, 'skill-bundles');
  const skillBundleVersionRoot = path.join(skillBundleRoot, 'versions', '2026.09.10.1');
  const skillBundle = path.join(skillBundleVersionRoot, 'skills');
  const maintenance = path.join(taskspace, 'maintenance');
  const workspace = path.join(taskspace, 'workspace');
  const executionStateDirectory = path.join(project, 'taskspaces', '.broker', 'executions');
  for (const directory of [taskspace, phase, artifacts, attempt, evidence, policyDirectory, skillBundle,
    maintenance, workspace, executionStateDirectory]) {
    await mkdir(directory, { recursive: true });
  }
  await symlink(skillBundleVersionRoot, path.join(skillBundleRoot, 'current'), 'junction');
  execFileSync('git', ['-C', workspace, 'init', '--quiet']);
  execFileSync('git', ['-C', workspace, 'config', 'user.name', 'Forge Test']);
  execFileSync('git', ['-C', workspace, 'config', 'user.email', 'forge-test@example.invalid']);
  await writeFile(path.join(workspace, 'README.md'), 'baseline\n');
  execFileSync('git', ['-C', workspace, 'add', 'README.md']);
  execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'baseline']);
  const sourceCommit = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(path.join(workspace, 'database.sql'), 'create table supplier_profile(id bigint);\n');
  const workspaceSnapshot = await snapshotForgeDeliveryWorkspace({ workspace, baseCommit: sourceCommit });
  const files = {
    promptFile: path.join(attempt, 'prompt.md'),
    executionPolicyFile: path.join(policyDirectory, 'execution-policy.test.json'),
    phaseCatalogFile: path.join(skillBundle, 'forge-task-router', 'references', 'phase-profiles.json'),
    phaseStateFile: path.join(phase, 'state.json'),
    executionStateFile: path.join(executionStateDirectory, `${taskId}.json`),
    taskspaceMetadataFile: path.join(taskspace, 'metadata.json'),
    prepareReceiptFile: path.join(attempt, 'prepare-receipt.json'),
    workspaceSnapshotFile: path.join(attempt, 'recovery-workspace-snapshot.json'),
    maintenanceFenceFile: path.join(maintenance, 'proxy-fence.json'),
  };
  const contents = {
    promptFile: Buffer.from('Implement the exact backend correction.\n'),
    executionPolicyFile: Buffer.from('{"policy":1}\n'),
    phaseCatalogFile: Buffer.from('{"catalog":1}\n'),
    phaseStateFile: null,
    executionStateFile: Buffer.from('{"generation":28}\n'),
    taskspaceMetadataFile: Buffer.from('{"task":"skills-canary-20260903"}\n'),
    prepareReceiptFile: Buffer.from('{"prepared":true}\n'),
    maintenanceFenceFile: Buffer.from('{"schemaVersion":1,"state":"committed","epoch":"lifecycle-original"}\n'),
    workspaceSnapshotFile: Buffer.from(`${JSON.stringify(workspaceSnapshot, null, 2)}\n`),
  };
  const artifactValues = [
    phaseArtifact('requirements-specification', 1),
    phaseArtifact('domain-contract', 2),
    phaseArtifact('database-schema', 3),
    phaseArtifact('ui-interaction-contract', 4),
  ];
  const acceptedArtifactDigests = Object.fromEntries(
    artifactValues.map((artifact) => [artifact.artifactKind, artifact.artifactDigest]),
  );
  for (const artifact of artifactValues) {
    await writeFile(path.join(artifacts, `${artifact.artifactKind}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
  }
  const promptTextDigest = digestDirectUserTextContent([
    { type: 'text', text: 'Implement the exact backend correction.' },
  ]);
  contents.phaseStateFile = Buffer.from(`${JSON.stringify({
    schemaVersion: 'forge-delivery-phase-state/v1',
    workflowId: 'crud-production',
    taskId,
    sessionId: '948840e7-2ba5-4f40-9c07-8028630665e8',
    sourceCommit,
    status: 'active',
    currentPhaseId: 'backend',
    acceptedArtifacts: acceptedArtifactDigests,
    activeAttempt: {
      attemptId: '78577957-286b-42d4-abf4-4203263481c9',
      phaseId: 'backend',
      rpcId: '556e0879-a0e0-4e3a-9f36-f8d8057fc760',
      executionGeneration: 28,
      sessionMode: 'resume',
      promptDigest: promptTextDigest,
    },
  })}\n`);
  for (const [key, file] of Object.entries(files)) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents[key]);
  }
  const descriptor = {
    schemaVersion: 'forge-protected-headless-host-recovery/v4',
    operation: {
      operationId,
      authorizationReference: 'owner-current-task-a9-backend-recovery',
      authorizationIssuedAt: new Date(Date.now() - 60_000).toISOString(),
      authorizationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      descriptorSha256: '0'.repeat(64),
    },
    target: {
      projectSlug: 'forge-base',
      taskId,
      canaryId: 'forge-skills-20260903',
      runId: 'supplier-admission-a9',
      attemptDirectoryName: '05-backend-attempt2',
      harnessContainerId: harnessId,
      harnessImageId: imageId,
      harnessStartedAt: startedAt,
      harnessUser: '1000:983',
      harnessRevision: 'vpn-forge-delivery-toolkit-75',
      harnessSkillBundleVersion: '2026.09.10.1',
      harnessRuntimeProfile: 'vpn-trusted-host',
      taskspaceAccessMode: 'conversation',
      brokerContainerId: brokerId,
      brokerImageId,
      brokerStartedAt: startedAt,
      brokerUser: '1000:983',
      brokerRevision: 'vpn-forge-delivery-toolkit-75',
      recoveryHelperImageId: helperImageId,
      recoveryHelperRevision: 'vpn-forge-delivery-toolkit-75',
      recoveryHelperBuildInputDigest: helperBuildInputDigest,
      recoveryHelperSourceSha256: helperSourceSha256,
      skillBundleVersion: '2026.09.10.1',
      harnessApplicationNetworkId: '8'.repeat(64),
      harnessTaskspacesNetworkId: '9'.repeat(64),
      harnessUploadsNetworkId: 'a'.repeat(64),
      brokerTopologyMode: 'project-default',
      brokerServiceNetworkName: 'forge-forge-base_taskspaces',
      brokerServiceNetworkId: '9'.repeat(64),
      brokerServiceNetworkAlias: 'taskspace-broker',
      brokerTaskspacesNetworkId: '9'.repeat(64),
      brokerGitRemoteNetworkId: 'b'.repeat(64),
      brokerGitRemoteRequired: 'true',
      brokerGitRemoteReady: 'true',
      brokerGitRemoteName: 'origin',
      brokerGitRemoteBranch: 'main',
      hostProxyPort: 23080,
      dshPort: 3080,
    },
    execution: {
      actorId: 'forge',
      actorUserId: '22222222-2222-4222-8222-222222222222',
      conversationId: 'forge-a9-backend',
      sessionId: '948840e7-2ba5-4f40-9c07-8028630665e8',
      sessionCwd: '/workspace',
      rpcId: '556e0879-a0e0-4e3a-9f36-f8d8057fc760',
      caseFamily: 'crud-complete',
      sourceCommit,
      workflowId: 'crud-production',
      phaseId: 'backend',
      phaseAttemptId: '78577957-286b-42d4-abf4-4203263481c9',
      executionId: 'ce4b031a-eb53-47d3-be0b-bd0948e094d8',
      claimId: '557fa1b3-4aa1-4c00-9627-c7f20b5442f9',
      generation: 28,
      contractId: 'd'.repeat(64),
      expectedBaselineSeq: 231872,
      acceptedArtifactDigests,
      workspaceSnapshotDigest: workspaceSnapshot.snapshotDigest,
      cumulativePatchDigest: workspaceSnapshot.cumulativePatchDigest,
    },
    paths: {
      projectControlRoot: project,
      canaryRoot: canary,
      runRoot,
      attemptDirectory: attempt,
      workspaceDirectory: workspace,
      skillBundleRoot,
      skillBundleDirectory: skillBundle,
      phaseControlDirectory: phase,
      artifactsDirectory: artifacts,
      phaseStateFile: files.phaseStateFile,
      maintenanceDirectory: maintenance,
      maintenanceFenceFile: files.maintenanceFenceFile,
      deepseekKeyFile: path.join(root, 'secrets', 'deepseek-api-key'),
      kimiKeyFile: path.join(root, 'secrets', 'kimi-api-key'),
      glmKeyFile: path.join(root, 'secrets', 'glm-api-key'),
      evidenceDirectory: evidence,
      promptFile: files.promptFile,
      executionPolicyFile: files.executionPolicyFile,
      phaseCatalogFile: files.phaseCatalogFile,
      prepareReceiptFile: files.prepareReceiptFile,
      workspaceSnapshotFile: files.workspaceSnapshotFile,
    },
    digests: {
      promptFileSha256: sha256(contents.promptFile),
      promptTextSha256: promptTextDigest,
      executionPolicySha256: sha256(contents.executionPolicyFile),
      phaseCatalogSha256: sha256(contents.phaseCatalogFile),
      phaseStateSha256: sha256(contents.phaseStateFile),
      executionStateSha256: sha256(contents.executionStateFile),
      taskspaceMetadataSha256: sha256(contents.taskspaceMetadataFile),
      prepareReceiptSha256: sha256(contents.prepareReceiptFile),
      workspaceSnapshotFileSha256: sha256(contents.workspaceSnapshotFile),
    },
  };
  descriptor.operation.descriptorSha256 = descriptorSha(descriptor);
  return { root, descriptor, files, evidence };
}

function dedicatedCanaryDescriptor(source) {
  const descriptor = structuredClone(source);
  descriptor.target.brokerTopologyMode = 'dedicated-canary';
  descriptor.target.brokerServiceNetworkName = `forge-${descriptor.target.projectSlug}-task-${descriptor.target.taskId}_uploads`;
  descriptor.target.brokerServiceNetworkId = descriptor.target.harnessUploadsNetworkId;
  descriptor.target.brokerServiceNetworkAlias = 'taskspace-broker';
  descriptor.target.brokerImageId = descriptor.target.recoveryHelperImageId;
  descriptor.target.brokerRevision = descriptor.target.recoveryHelperRevision;
  descriptor.target.brokerGitRemoteNetworkId = null;
  descriptor.target.brokerGitRemoteRequired = 'false';
  descriptor.target.brokerGitRemoteReady = 'false';
  descriptor.target.brokerGitRemoteName = null;
  descriptor.target.brokerGitRemoteBranch = null;
  descriptor.paths.glmKeyFile = path.join(
    descriptor.paths.canaryRoot, 'secrets', 'glm-api-key-unconfigured',
  );
  descriptor.operation.descriptorSha256 = descriptorSha(descriptor);
  return descriptor;
}

async function seedOwnedMaintenanceResume(fixture, journalState = 'fence-installed') {
  const originalFence = await readFile(fixture.files.maintenanceFenceFile);
  const originalMetadata = await lstat(fixture.files.maintenanceFenceFile);
  const originalFenceFile = `original-fence-${operationId}.json`;
  await writeFile(path.join(fixture.evidence, originalFenceFile), originalFence);
  await writeFile(path.join(fixture.evidence, 'host-recovery-journal.json'), `${JSON.stringify({
    schemaVersion: 'forge-protected-headless-host-recovery-journal/v1',
    operationId,
    descriptorSha256: fixture.descriptor.operation.descriptorSha256,
    harnessContainerId: fixture.descriptor.target.harnessContainerId,
    brokerContainerId: fixture.descriptor.target.brokerContainerId,
    recoveryHelperImageId: fixture.descriptor.target.recoveryHelperImageId,
    recoveryHelperBuildInputDigest: fixture.descriptor.target.recoveryHelperBuildInputDigest,
    originalFenceFile,
    originalFenceSha256: sha256(originalFence),
    originalFenceEpoch: 'lifecycle-original',
    originalFenceMode: originalMetadata.mode & 0o777,
    originalFenceUid: originalMetadata.uid,
    originalFenceGid: originalMetadata.gid,
    state: journalState,
    updatedAt: '2026-09-05T00:00:00.000Z',
  }, null, 2)}\n`);
  await writeFile(
    fixture.files.maintenanceFenceFile,
    `${JSON.stringify({ schemaVersion: 1, state: 'maintenance', epoch: `recovery-${operationId}` })}\n`,
  );
  return originalFence;
}

function harnessInspect(descriptor) {
  const taskRoot = path.join(descriptor.paths.projectControlRoot, 'taskspaces', descriptor.target.taskId);
  const projectRoot = descriptor.paths.projectControlRoot;
  const readOnlyProjectRoot = descriptor.target.brokerTopologyMode === 'dedicated-canary'
    ? path.join(descriptor.paths.canaryRoot, 'project-shadow')
    : projectRoot;
  const allowedRoot = path.dirname(path.dirname(projectRoot));
  const networkPrefix = `forge-${descriptor.target.projectSlug}`;
  return [{
    Id: descriptor.target.harnessContainerId,
    Image: descriptor.target.harnessImageId,
    State: {
      Running: true, Paused: false, Restarting: false, Dead: false,
      StartedAt: descriptor.target.harnessStartedAt, Pid: 1234,
    },
    RestartCount: 0,
    Config: {
      User: '1000:983',
      Entrypoint: [],
      Cmd: ['/usr/local/bin/start-harness'],
      WorkingDir: '/workspace',
      Labels: {
        'org.opencontainers.image.revision': descriptor.target.harnessRevision,
        'com.forge-delivery.harness-skill-bundle': descriptor.target.harnessSkillBundleVersion,
        'com.forge-delivery.harness-runtime-profile': descriptor.target.harnessRuntimeProfile,
      },
      Env: [
        'PATH=/opt/java/openjdk/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'NODE_PATH=/opt/forge-harness-runtime/node_modules',
        'HOME=/home/node',
        'DSH_HOME=/home/node/.dsh',
        'DSH_PERMISSION_MODE=workspace-write',
        'DSH_BUNDLED_SKILL_DIR=/opt/forge-skill-bundles/current/skills',
        'HARNESS_DEFAULT_WORKSPACE=/workspace',
        'HARNESS_BIND_ADDRESS=127.0.0.1',
        'HARNESS_INTERNAL_PORT=3080',
        'HARNESS_PORT=23080',
        'HARNESS_MAINTENANCE_FENCE_FILE=/run/forge-taskspace-maintenance/proxy-fence.json',
        `HARNESS_ACCESS_MODE=${descriptor.target.taskspaceAccessMode}`,
        'HARNESS_ACCESS_TOKEN_FILE=/run/forge-taskspace/browser-access-token',
        'HARNESS_ACCESS_AUTHZ_SOCKET=/run/forge-conversation-auth/authorize.sock',
        'FORGE_TASKSPACE_BROKER_URL=http://taskspace-broker:3100',
        'FORGE_TASKSPACE_TOKEN_FILE=/run/forge-taskspace/broker-token',
        `PROJECT_SLUG=${descriptor.target.projectSlug}`,
        `FORGE_TASKSPACE_ID=${descriptor.target.taskId}`,
        `FORGE_TASKSPACE_ACTOR_ID=${descriptor.execution.actorId}`,
        `FORGE_TASKSPACE_ACTOR_USER_ID=${descriptor.execution.actorUserId}`,
        `FORGE_TASKSPACE_CONVERSATION_ID=${descriptor.execution.conversationId}`,
      ],
    },
    HostConfig: {
      ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      Devices: [], DeviceRequests: [], IpcMode: 'private', PidMode: '', UTSMode: '',
      ExtraHosts: [], Links: [], Dns: [], DnsOptions: [], DnsSearch: [],
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '5' } },
      NetworkMode: `${networkPrefix}_application`,
    },
    Mounts: [
      { Source: path.join(taskRoot, 'workspace'), Destination: '/workspace', RW: true, Type: 'bind' },
      { Source: path.join(readOnlyProjectRoot, 'governance', 'PROJECT_CONTEXT.md'), Destination: '/workspace/PROJECT_CONTEXT.md', RW: false, Type: 'bind' },
      { Source: path.join(readOnlyProjectRoot, 'workspace'), Destination: '/integration', RW: false, Type: 'bind' },
      { Source: path.join(taskRoot, 'dsh-home'), Destination: '/home/node/.dsh', RW: true, Type: 'bind' },
      { Source: descriptor.paths.skillBundleRoot, Destination: '/opt/forge-skill-bundles', RW: false, Type: 'bind' },
      { Source: path.join(taskRoot, 'uploads'), Destination: '/project-inputs', RW: false, Type: 'bind' },
      { Source: path.join(allowedRoot, 'file-gateway', 'data', descriptor.target.projectSlug), Destination: '/project-ftp-inputs', RW: false, Type: 'bind' },
      { Source: path.join(projectRoot, 'shared-inputs', 'accepted'), Destination: '/project-shared-inputs', RW: false, Type: 'bind' },
      { Source: path.join(taskRoot, 'tokens', 'browser'), Destination: '/run/forge-taskspace/browser-access-token', RW: false, Type: 'bind' },
      { Source: path.join(taskRoot, 'tokens', 'broker'), Destination: '/run/forge-taskspace/broker-token', RW: false, Type: 'bind' },
      { Source: path.join(allowedRoot, 'conversation-control-plane', 'auth-ipc'), Destination: '/run/forge-conversation-auth', RW: false, Type: 'bind' },
      { Source: descriptor.paths.maintenanceDirectory, Destination: '/run/forge-taskspace-maintenance', RW: false, Type: 'bind' },
      { Source: path.join(taskRoot, 'cache', 'm2'), Destination: '/workspace/.forge-cache/m2', RW: true, Type: 'bind' },
      { Source: path.join(taskRoot, 'cache', 'npm'), Destination: '/workspace/.forge-cache/npm', RW: true, Type: 'bind' },
      { Source: path.join(taskRoot, 'cache', 'pnpm'), Destination: '/workspace/.forge-cache/pnpm', RW: true, Type: 'bind' },
      { Source: path.join(taskRoot, 'cache', 'general'), Destination: '/workspace/.forge-cache/general', RW: true, Type: 'bind' },
      { Source: descriptor.paths.deepseekKeyFile, Destination: '/run/secrets/deepseek-api-key', RW: false, Type: 'bind' },
      { Source: descriptor.paths.kimiKeyFile, Destination: '/run/secrets/kimi-api-key', RW: false, Type: 'bind' },
      { Source: descriptor.paths.glmKeyFile, Destination: '/run/secrets/glm-api-key', RW: false, Type: 'bind' },
    ],
    NetworkSettings: {
      Ports: { '23080/tcp': [{ HostIp: '127.0.0.1', HostPort: '23080' }] },
      Networks: {
        [`${networkPrefix}_application`]: { NetworkID: descriptor.target.harnessApplicationNetworkId },
        [`${networkPrefix}_taskspaces`]: { NetworkID: descriptor.target.harnessTaskspacesNetworkId },
        [`${networkPrefix}-task-${descriptor.target.taskId}_uploads`]: { NetworkID: descriptor.target.harnessUploadsNetworkId },
      },
    },
  }];
}

function brokerInspect(descriptor) {
  const project = descriptor.paths.projectControlRoot;
  const allowedRoot = path.dirname(path.dirname(project));
  const networkPrefix = `forge-${descriptor.target.projectSlug}`;
  const dedicatedCanary = descriptor.target.brokerTopologyMode === 'dedicated-canary';
  const environment = [
    'PATH=/opt/java/openjdk/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'NODE_PATH=/opt/forge-harness-runtime/node_modules',
    `TASKSPACE_PROJECT_ROOT=${project}`,
    `TASKSPACE_PROJECT_SLUG=${descriptor.target.projectSlug}`,
    'TASKSPACE_BROKER_ADDRESS=0.0.0.0',
    'TASKSPACE_BROKER_PORT=3100',
    'RELEASE_RUNNER_SOCKET=/run/forge-release/runner.sock',
    'VERIFICATION_RUNNER_SOCKET=/run/forge-verify/runner.sock',
    `TASKSPACE_GIT_REMOTE_REQUIRED=${descriptor.target.brokerGitRemoteRequired}`,
    `TASKSPACE_GIT_REMOTE_READY=${descriptor.target.brokerGitRemoteReady}`,
  ];
  if (!dedicatedCanary) environment.push(
    'PROTECTED_ACCEPTANCE_RESOLVER_SOCKET=/run/forge-acceptance-resolver/resolver.sock',
    `TASKSPACE_GIT_REMOTE_NAME=${descriptor.target.brokerGitRemoteName}`,
    `TASKSPACE_GIT_REMOTE_BRANCH=${descriptor.target.brokerGitRemoteBranch}`,
    'TASKSPACE_GIT_SSH_COMMAND=ssh -i /run/forge-git/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/run/forge-git/known_hosts',
  );
  const mounts = dedicatedCanary ? [
    { Source: path.join(project, 'workspace'), Destination: path.join(project, 'workspace'), RW: true, Type: 'bind' },
    { Source: path.join(project, 'taskspaces'), Destination: path.join(project, 'taskspaces'), RW: true, Type: 'bind' },
    { Source: path.join(project, 'ops', 'release-ipc'), Destination: '/run/forge-release', RW: false, Type: 'bind' },
    { Source: path.join(project, 'verification', 'canary-host', 'ipc'), Destination: '/run/forge-verify', RW: false, Type: 'bind' },
    { Source: path.join(descriptor.paths.canaryRoot, 'config', 'verification-admission', 'broker-healthcheck.mjs'), Destination: '/broker-healthcheck.mjs', RW: false, Type: 'bind' },
  ] : [
    { Source: path.join(project, 'workspace'), Destination: path.join(project, 'workspace'), RW: true, Type: 'bind' },
    { Source: path.join(project, 'taskspaces'), Destination: path.join(project, 'taskspaces'), RW: true, Type: 'bind' },
    { Source: path.join(project, 'ops', 'release-ipc'), Destination: '/run/forge-release', RW: false, Type: 'bind' },
    { Source: path.join(project, 'verification', 'ipc'), Destination: '/run/forge-verify', RW: false, Type: 'bind' },
    { Source: path.join(project, 'acceptance', 'ipc-resolver'), Destination: '/run/forge-acceptance-resolver', RW: false, Type: 'bind' },
    { Source: path.join(allowedRoot, 'git-remotes', descriptor.target.projectSlug), Destination: '/run/forge-git', RW: false, Type: 'bind' },
  ];
  const networks = dedicatedCanary ? {
    [descriptor.target.brokerServiceNetworkName]: {
      NetworkID: descriptor.target.brokerServiceNetworkId,
      IPAddress: '172.30.0.3',
      Aliases: [descriptor.target.brokerServiceNetworkAlias],
    },
    [`${networkPrefix}_taskspaces`]: {
      NetworkID: descriptor.target.brokerTaskspacesNetworkId,
      Aliases: ['skills-canary-broker'],
    },
  } : {
    [`${networkPrefix}_taskspaces`]: {
      NetworkID: descriptor.target.brokerTaskspacesNetworkId,
      IPAddress: '172.29.0.3',
      Aliases: [descriptor.target.brokerServiceNetworkAlias],
    },
    [`${networkPrefix}_git-remote`]: { NetworkID: descriptor.target.brokerGitRemoteNetworkId },
  };
  return [{
    Id: descriptor.target.brokerContainerId,
    Image: descriptor.target.brokerImageId,
    State: {
      Running: true, Paused: false, Restarting: false, Dead: false,
      StartedAt: descriptor.target.brokerStartedAt, Pid: 2345, Health: { Status: 'healthy' },
    },
    RestartCount: 0,
    Config: {
      User: descriptor.target.brokerUser,
      Entrypoint: dedicatedCanary ? ['/usr/local/bin/node'] : [],
      Cmd: dedicatedCanary
        ? ['/usr/local/lib/taskspace-broker.mjs']
        : ['/usr/local/bin/node', '/usr/local/lib/taskspace-broker.mjs'],
      WorkingDir: '/workspace',
      Labels: { 'org.opencontainers.image.revision': descriptor.target.brokerRevision },
      Env: environment,
    },
    HostConfig: {
      ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      Devices: [], DeviceRequests: [], IpcMode: 'private', PidMode: '', UTSMode: '',
      ExtraHosts: [], Links: [], Dns: [], DnsOptions: [], DnsSearch: [],
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '5' } },
      PidsLimit: 256,
      Memory: 768 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=512m' },
      NetworkMode: `${networkPrefix}_taskspaces`,
    },
    Mounts: mounts,
    NetworkSettings: {
      Ports: { '3080/tcp': null },
      Networks: networks,
    },
  }];
}

function helperInspect(descriptor, prepared, definition, {
  id = helperId,
  state = {
    Status: 'created', Running: false, Paused: false, Restarting: false, Dead: false,
    StartedAt: '0001-01-01T00:00:00Z',
  },
} = {}) {
  const mount = (source, destination, rw) => ({ Source: source, Destination: destination, RW: rw, Type: 'bind' });
  return [{
    Id: id,
    Image: descriptor.target.recoveryHelperImageId,
    State: { ...state },
    Config: {
      User: '1000:983',
      Entrypoint: ['/usr/local/bin/node'],
      Cmd: ['/usr/local/lib/forge-recover-headless-execution.mjs'],
      Labels: {
        'org.opencontainers.image.revision': descriptor.target.recoveryHelperRevision,
        'com.forge-delivery.harness-skill-bundle': descriptor.target.harnessSkillBundleVersion,
        'com.forge-delivery.harness-runtime-profile': descriptor.target.harnessRuntimeProfile,
        'com.forge.recovery.operation': descriptor.operation.operationId,
        'com.forge.recovery.descriptor-sha256': descriptor.operation.descriptorSha256,
      },
      Env: Object.entries(definition.expectedEnvironment).map(([key, value]) => `${key}=${value}`),
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      NetworkMode: `container:${descriptor.target.harnessContainerId}`,
      PidsLimit: 128,
      Memory: 512 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      RestartPolicy: { Name: 'no' },
      Devices: [],
      DeviceRequests: [],
      ExtraHosts: [],
      Links: [],
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      IpcMode: 'private',
      PidMode: '',
      UTSMode: '',
      LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '5' } },
    },
    Mounts: definition.expectedMounts.map((entry) => mount(
      entry.Source, entry.Destination, entry.RW,
    )),
    NetworkSettings: { Ports: {} },
  }];
}

function recoveryHelperImageInspect(descriptor) {
  return [{
    Id: descriptor.target.recoveryHelperImageId,
    Os: 'linux',
    Config: {
      User: '1000:1000',
      Entrypoint: null,
      Cmd: ['/usr/local/bin/start-harness'],
      WorkingDir: '/workspace',
      Env: [
        'PATH=/opt/java/openjdk/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'NODE_PATH=/opt/forge-harness-runtime/node_modules',
      ],
      Labels: {
        'org.opencontainers.image.revision': descriptor.target.recoveryHelperRevision,
        'com.forge-delivery.harness-skill-bundle': descriptor.target.harnessSkillBundleVersion,
        'com.forge-delivery.harness-runtime-profile': descriptor.target.harnessRuntimeProfile,
      },
    },
  }];
}

function recoveryHelperProbe(descriptor) {
  return {
    schemaVersion: 'forge-recovery-helper-image-probe/v1',
    buildInputDigest: descriptor.target.recoveryHelperBuildInputDigest,
    helperSha256: descriptor.target.recoveryHelperSourceSha256,
    executionContextSha256: '5'.repeat(64),
    phaseGuardSha256: '6'.repeat(64),
    brokerSha256: '7'.repeat(64),
  };
}

async function writeAcceptedHelperOutput(fixture, intentBytes = Buffer.from('{"intent":"durable"}\n')) {
  await writeFile(
    path.join(fixture.evidence, `submission-intent-${operationId}.json`),
    intentBytes,
  );
  const receiptBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 'forge-protected-headless-recovery/v1',
    status: 'accepted',
    operationId,
    taskId,
    sessionId: fixture.descriptor.execution.sessionId,
    rpcId: fixture.descriptor.execution.rpcId,
    promptDigest: fixture.descriptor.digests.promptTextSha256,
    phaseAttemptId: fixture.descriptor.execution.phaseAttemptId,
    phaseId: fixture.descriptor.execution.phaseId,
    executionId: fixture.descriptor.execution.executionId,
    claimId: fixture.descriptor.execution.claimId,
    generation: fixture.descriptor.execution.generation,
    contractId: fixture.descriptor.execution.contractId,
    sourceCommit: fixture.descriptor.execution.sourceCommit,
    maintenance: { epoch: `recovery-${operationId}`, drained: true },
    durableIntent: {
      file: `submission-intent-${operationId}.json`,
      sha256: sha256(intentBytes),
      writtenBeforeIngress: true,
      automaticResendForbidden: true,
    },
    ingress: { forwarded: true, idempotent: false },
    executionConsumption: {
      taskId,
      operationId,
      executionId: fixture.descriptor.execution.executionId,
      claimId: fixture.descriptor.execution.claimId,
      generation: fixture.descriptor.execution.generation,
      contractId: fixture.descriptor.execution.contractId,
      phaseAttemptId: fixture.descriptor.execution.phaseAttemptId,
      lifecycleStatus: 'consumed',
      recoveryStatus: 'consumed',
      consumed: true,
      consumedAt: '2026-09-05T00:00:01.000Z',
      exactIdentity: true,
    },
    proofScope: {
      brokerExecutionContextConsumed: true,
      phaseGuardBound: false,
      classification: 'broker-execution-context-consumed',
    },
  })}\n`);
  const receiptName = `recovery-${operationId}-${sha256(receiptBytes)}.json`;
  await writeFile(path.join(fixture.evidence, receiptName), receiptBytes);
  return {
    code: 0,
    stdout: `${JSON.stringify({
      schemaVersion: 'forge-protected-headless-recovery-cli/v1',
      status: 'accepted',
      receiptFile: receiptName,
      receiptSha256: sha256(receiptBytes),
      receiptBytes: receiptBytes.length,
    })}\n`,
    stderr: '',
  };
}

async function writeCancellationHelperOutput(fixture, preIngressState = 'submission-attempted') {
  const claimed = preIngressState === 'submission-attempted';
  const recoveryReadbackDigest = claimed ? 'b'.repeat(64) : null;
  const observedAt = '2026-09-05T00:00:02.000Z';
  const tombstone = {
    operationId,
    phaseAttemptId: fixture.descriptor.execution.phaseAttemptId,
    executionId: fixture.descriptor.execution.executionId,
    claimId: fixture.descriptor.execution.claimId,
    generation: fixture.descriptor.execution.generation,
    contractId: fixture.descriptor.execution.contractId,
    rpcId: fixture.descriptor.execution.rpcId,
    dshSessionId: fixture.descriptor.execution.sessionId,
    textDigest: fixture.descriptor.digests.promptTextSha256,
    abandonedAt: observedAt,
    reason: 'stable-idle-pre-ingress-cancelled-no-resend',
    requestObserved: false,
    observedSeq: fixture.descriptor.execution.expectedBaselineSeq,
    eventDigest: 'e'.repeat(64),
  };
  const receiptBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 'forge-protected-headless-pre-ingress-cancellation/v1',
    status: 'not-observed-no-resend',
    completedAt: observedAt,
    operationId,
    taskId,
    sessionId: fixture.descriptor.execution.sessionId,
    rpcId: fixture.descriptor.execution.rpcId,
    promptDigest: fixture.descriptor.digests.promptTextSha256,
    phaseAttemptId: fixture.descriptor.execution.phaseAttemptId,
    phaseId: fixture.descriptor.execution.phaseId,
    executionId: fixture.descriptor.execution.executionId,
    claimId: fixture.descriptor.execution.claimId,
    generation: fixture.descriptor.execution.generation,
    contractId: fixture.descriptor.execution.contractId,
    sourceCommit: fixture.descriptor.execution.sourceCommit,
    maintenance: { epoch: `recovery-${operationId}`, drained: true },
    durableIntent: null,
    preIngressState,
    readback: {
      historyComplete: true,
      requestObserved: false,
      observedSeq: fixture.descriptor.execution.expectedBaselineSeq,
      eventDigest: tombstone.eventDigest,
      baselineObservedSeq: claimed ? fixture.descriptor.execution.expectedBaselineSeq : null,
      baselineEventDigest: recoveryReadbackDigest,
      turnOpen: false,
      pages: 2,
      eventCount: 100,
      session: {
        sessionId: fixture.descriptor.execution.sessionId,
        running: false,
        cwd: fixture.descriptor.execution.sessionCwd,
      },
    },
    executionStatus: {
      taskId,
      operationId,
      executionId: fixture.descriptor.execution.executionId,
      claimId: fixture.descriptor.execution.claimId,
      generation: fixture.descriptor.execution.generation,
      contractId: fixture.descriptor.execution.contractId,
      phaseAttemptId: fixture.descriptor.execution.phaseAttemptId,
      consumed: false,
      lifecycleStatus: claimed ? 'submission-attempted' : 'prepared',
      recoveryStatus: claimed ? 'submission-attempted' : 'permitted',
      recoveryReadbackSeq: claimed ? fixture.descriptor.execution.expectedBaselineSeq : null,
      recoveryReadbackDigest,
      terminalTombstone: null,
      exactIdentity: true,
    },
    executionTerminalization: {
      lifecycleStatus: 'abandoned',
      recoveryStatus: 'abandoned',
      exactIdentity: true,
      idempotent: false,
      tombstone,
    },
    proofScope: {
      brokerExecutionContextConsumed: false,
      ingressForwarded: false,
      phaseGuardBound: false,
      classification: 'broker-execution-context-abandoned-before-ingress',
    },
    safeToRestoreUserIngress: true,
    safeToResend: false,
  })}\n`);
  const receiptName = `recovery-${operationId}-${sha256(receiptBytes)}.json`;
  await writeFile(path.join(fixture.evidence, receiptName), receiptBytes);
  return {
    code: 0,
    stdout: `${JSON.stringify({
      schemaVersion: 'forge-protected-headless-recovery-cli/v1',
      status: 'not-observed-no-resend',
      receiptFile: receiptName,
      receiptSha256: sha256(receiptBytes),
      receiptBytes: receiptBytes.length,
    })}\n`,
    stderr: '',
  };
}

function exactHostPermittedRecoveryStatus(fixture, overrides = {}) {
  return {
    revision: 17,
    taskId,
    operationId,
    executionId: fixture.descriptor.execution.executionId,
    claimId: fixture.descriptor.execution.claimId,
    generation: fixture.descriptor.execution.generation,
    contractId: fixture.descriptor.execution.contractId,
    phaseAttemptId: fixture.descriptor.execution.phaseAttemptId,
    lifecycleStatus: 'prepared',
    recoveryStatus: 'permitted',
    consumed: false,
    consumedAt: null,
    recoveryReadbackSeq: null,
    recoveryReadbackDigest: null,
    terminalTombstone: null,
    ...overrides,
  };
}

async function installDescriptorBoundUnpermittedExecutionState(fixture) {
  const { descriptor } = fixture;
  const state = {
    schemaVersion: 3,
    revision: descriptor.execution.generation,
    generation: descriptor.execution.generation,
    projectSlug: descriptor.target.projectSlug,
    taskId,
    actorUserId: descriptor.execution.actorUserId,
    actorUsername: descriptor.execution.actorId,
    conversationId: descriptor.execution.conversationId,
    lifecycle: { status: 'prepared', consumedAt: null },
    recovery: null,
    tombstones: [],
    current: {
      projectSlug: descriptor.target.projectSlug,
      taskId,
      actorUserId: descriptor.execution.actorUserId,
      actorUsername: descriptor.execution.actorId,
      conversationId: descriptor.execution.conversationId,
      executionId: descriptor.execution.executionId,
      claimId: descriptor.execution.claimId,
      generation: descriptor.execution.generation,
      contractId: descriptor.execution.contractId,
      rpcId: descriptor.execution.rpcId,
      dshSessionId: descriptor.execution.sessionId,
      textDigest: descriptor.digests.promptTextSha256,
      sourceCommit: descriptor.execution.sourceCommit,
      caseFamily: descriptor.execution.caseFamily,
      workflowId: descriptor.execution.workflowId,
      phaseId: descriptor.execution.phaseId,
      testOnly: true,
      authorityClass: 'test-shadow-writer',
    },
  };
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  await writeFile(fixture.files.executionStateFile, bytes);
  descriptor.digests.executionStateSha256 = sha256(bytes);
  descriptor.operation.descriptorSha256 = descriptorSha(descriptor);
  return Object.freeze({ bytes, sha256: sha256(bytes), revision: state.revision });
}

async function writePreIngressFailureHelperOutput(fixture, mutate = undefined) {
  const receipt = {
    schemaVersion: 'forge-protected-headless-pre-ingress-failure/v1',
    status: 'pre-ingress-failed',
    completedAt: '2026-09-05T00:00:02.000Z',
    operationId,
    descriptorSha256: fixture.descriptor.operation.descriptorSha256,
    taskId,
    sessionId: fixture.descriptor.execution.sessionId,
    rpcId: fixture.descriptor.execution.rpcId,
    promptDigest: fixture.descriptor.digests.promptTextSha256,
    phaseAttemptId: fixture.descriptor.execution.phaseAttemptId,
    phaseId: fixture.descriptor.execution.phaseId,
    executionId: fixture.descriptor.execution.executionId,
    claimId: fixture.descriptor.execution.claimId,
    generation: fixture.descriptor.execution.generation,
    contractId: fixture.descriptor.execution.contractId,
    sourceCommit: fixture.descriptor.execution.sourceCommit,
    maintenanceEpoch: `recovery-${operationId}`,
    failure: { code: 'RECOVERY_BASELINE_DRIFT', structured: true },
    durableIntent: null,
    preIngressState: 'permitted-unclaimed',
    executionStatus: {
      ...exactHostPermittedRecoveryStatus(fixture),
      exactIdentity: true,
      descriptorExecutionStateUnchanged: false,
      executionStateSha256: null,
    },
    proofScope: {
      brokerRecoveryPermitIssued: true,
      brokerExecutionContextClaimed: false,
      durableIntentWritten: false,
      ingressForwarded: false,
      modelRequestSubmitted: false,
      classification: 'exact-unclaimed-pre-ingress-helper-failure',
    },
    safeToRestoreUserIngress: true,
    automaticRetryAuthorized: false,
    cannotClaim: [
      'a durable submission intent was written',
      'the Broker recovery context was claimed',
      'ingress was forwarded',
      'a model request was submitted',
      'automatic retry is safe',
    ],
  };
  if (mutate !== undefined) mutate(receipt);
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const receiptName = `recovery-${operationId}-${sha256(receiptBytes)}.json`;
  await writeFile(path.join(fixture.evidence, receiptName), receiptBytes);
  return {
    code: 0,
    stdout: `${JSON.stringify({
      schemaVersion: 'forge-protected-headless-recovery-cli/v1',
      status: 'pre-ingress-failed',
      receiptFile: receiptName,
      receiptSha256: sha256(receiptBytes),
      receiptBytes: receiptBytes.length,
    })}\n`,
    stderr: '',
  };
}

test('host recovery descriptor is content-addressed and cannot inject extra capabilities', async (t) => {
  const fixture = await fixtureRoot();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const validated = validateHostRecoveryDescriptor(fixture.descriptor, { allowedRoot: fixture.root });
  assert.equal(validated.descriptor.operation.operationId, operationId);
  const injected = structuredClone(fixture.descriptor);
  injected.execution.argv = ['sh'];
  injected.operation.descriptorSha256 = descriptorSha(injected);
  assert.throws(
    () => validateHostRecoveryDescriptor(injected, { allowedRoot: fixture.root }),
    /invalid shape/u,
  );
  const escaped = structuredClone(fixture.descriptor);
  escaped.paths.promptFile = path.resolve(fixture.root, '..', 'outside.md');
  escaped.operation.descriptorSha256 = descriptorSha(escaped);
  assert.throws(
    () => validateHostRecoveryDescriptor(escaped, { allowedRoot: fixture.root }),
    /escaped/u,
  );
});

test('dedicated Canary Broker mode binds the helper image, isolated DNS endpoint, five mounts, and no Git remote', async (t) => {
  const fixture = await fixtureRoot();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const descriptor = dedicatedCanaryDescriptor(fixture.descriptor);
  assert.doesNotThrow(() => validateHostRecoveryDescriptor(descriptor, { allowedRoot: fixture.root }));
  const inspect = brokerInspect(descriptor);
  assert.equal(inspect[0].Image, descriptor.target.recoveryHelperImageId);
  assert.equal(inspect[0].Mounts.length, 5);
  assert.deepEqual(Object.keys(inspect[0].NetworkSettings.Networks).sort(), [
    `forge-${descriptor.target.projectSlug}-task-${descriptor.target.taskId}_uploads`,
    `forge-${descriptor.target.projectSlug}_taskspaces`,
  ].sort());
  assert.equal(inspect[0].Config.Env.includes('TASKSPACE_GIT_REMOTE_REQUIRED=false'), true);
  assert.equal(inspect[0].Config.Env.some((entry) => entry.startsWith('TASKSPACE_GIT_REMOTE_NAME=')), false);
  const harness = harnessInspect(descriptor);
  const glmMount = harness[0].Mounts.find((mount) => mount.Destination === '/run/secrets/glm-api-key');
  assert.equal(
    glmMount.Source,
    path.join(descriptor.paths.canaryRoot, 'secrets', 'glm-api-key-unconfigured'),
  );
  assert.equal(
    harness[0].Config.Labels['com.forge-delivery.harness-skill-bundle'],
    descriptor.target.harnessSkillBundleVersion,
  );
  assert.doesNotThrow(() => validateHarnessRecoveryBoundary(harness, descriptor, descriptor.paths));
  assert.doesNotThrow(() => validateBrokerRecoveryBoundary(inspect, descriptor, descriptor.paths));
  await assert.doesNotReject(() => validatePinnedBrokerDnsBoundary(
    async (_command, args) => {
      assert.deepEqual(args.slice(0, 3), ['exec', '--user', '1000:983']);
      return { code: 0, stdout: '{"addresses":["172.30.0.3"]}\n', stderr: '' };
    },
    descriptor,
    harness,
    inspect,
  ));
});

test('dedicated Canary Broker mode fails closed on topology, image, mount, DNS, or Git drift', async (t) => {
  const fixture = await fixtureRoot();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const descriptor = dedicatedCanaryDescriptor(fixture.descriptor);

  for (const mutate of [
    (candidate) => { candidate.target.brokerServiceNetworkName = 'forge-forge-base_taskspaces'; },
    (candidate) => { candidate.target.brokerServiceNetworkId = '7'.repeat(64); },
    (candidate) => { candidate.target.brokerServiceNetworkAlias = 'shared-broker'; },
    (candidate) => { candidate.target.brokerGitRemoteRequired = 'true'; },
    (candidate) => { candidate.target.brokerImageId = brokerImageId; },
  ]) {
    const invalidDescriptor = structuredClone(descriptor);
    mutate(invalidDescriptor);
    invalidDescriptor.operation.descriptorSha256 = descriptorSha(invalidDescriptor);
    assert.throws(
      () => validateHostRecoveryDescriptor(invalidDescriptor, { allowedRoot: fixture.root }),
      /Broker|broker/u,
    );
  }

  const globalGlmSecret = structuredClone(descriptor);
  globalGlmSecret.paths.glmKeyFile = path.join(fixture.root, 'secrets', 'glm-api-key');
  globalGlmSecret.operation.descriptorSha256 = descriptorSha(globalGlmSecret);
  assert.throws(
    () => validateHostRecoveryDescriptor(globalGlmSecret, { allowedRoot: fixture.root }),
    /canonical provider key files/u,
  );

  const aliasDrift = brokerInspect(descriptor);
  aliasDrift[0].NetworkSettings.Networks[descriptor.target.brokerServiceNetworkName].Aliases = ['other'];
  assert.throws(
    () => validateBrokerRecoveryBoundary(aliasDrift, descriptor, descriptor.paths),
    /security boundary drifted/u,
  );

  const imageDrift = brokerInspect(descriptor);
  imageDrift[0].Image = brokerImageId;
  assert.throws(
    () => validateBrokerRecoveryBoundary(imageDrift, descriptor, descriptor.paths),
    /security boundary drifted/u,
  );

  const sixthMount = brokerInspect(descriptor);
  sixthMount[0].Mounts.push({
    Source: path.join(fixture.root, 'unexpected'), Destination: '/unexpected', RW: false, Type: 'bind',
  });
  assert.throws(
    () => validateBrokerRecoveryBoundary(sixthMount, descriptor, descriptor.paths),
    /mount boundary drifted/u,
  );

  const verificationMountDrift = brokerInspect(descriptor);
  verificationMountDrift[0].Mounts.find((mount) => mount.Destination === '/run/forge-verify').Source = path.join(
    descriptor.paths.projectControlRoot, 'verification', 'ipc',
  );
  assert.throws(
    () => validateBrokerRecoveryBoundary(verificationMountDrift, descriptor, descriptor.paths),
    /mount boundary drifted/u,
  );

  const gitEnvironmentDrift = brokerInspect(descriptor);
  gitEnvironmentDrift[0].Config.Env.push('TASKSPACE_GIT_REMOTE_NAME=origin');
  assert.throws(
    () => validateBrokerRecoveryBoundary(gitEnvironmentDrift, descriptor, descriptor.paths),
    /mount boundary drifted/u,
  );

  for (const [field, value] of [
    ['PidsLimit', 0],
    ['Memory', 512 * 1024 * 1024],
    ['NanoCpus', 0],
    ['Tmpfs', { '/tmp': 'rw,exec,nosuid,size=512m' }],
  ]) {
    const resourceDrift = brokerInspect(descriptor);
    resourceDrift[0].HostConfig[field] = value;
    assert.throws(
      () => validateBrokerRecoveryBoundary(resourceDrift, descriptor, descriptor.paths),
      /security boundary drifted/u,
    );
  }

  const harnessSecretMountDrift = harnessInspect(descriptor);
  harnessSecretMountDrift[0].Mounts.find(
    (mount) => mount.Destination === '/run/secrets/glm-api-key',
  ).Source = path.join(fixture.root, 'secrets', 'glm-api-key');
  assert.throws(
    () => validateHarnessRecoveryBoundary(harnessSecretMountDrift, descriptor, descriptor.paths),
    /mounts drifted/u,
  );

  for (const [destination, source] of [
    ['/workspace/PROJECT_CONTEXT.md', path.join(descriptor.paths.projectControlRoot, 'governance', 'PROJECT_CONTEXT.md')],
    ['/integration', path.join(descriptor.paths.projectControlRoot, 'workspace')],
  ]) {
    const harnessProjectMountDrift = harnessInspect(descriptor);
    harnessProjectMountDrift[0].Mounts.find((mount) => mount.Destination === destination).Source = source;
    assert.throws(
      () => validateHarnessRecoveryBoundary(harnessProjectMountDrift, descriptor, descriptor.paths),
      /mounts drifted/u,
    );
  }

  const harnessLabelDrift = harnessInspect(descriptor);
  harnessLabelDrift[0].Config.Labels['com.forge-delivery.harness-skill-bundle'] = '2026.09.03.6';
  assert.throws(
    () => validateHarnessRecoveryBoundary(harnessLabelDrift, descriptor, descriptor.paths),
    /security boundary drifted/u,
  );

  await assert.rejects(
    () => validatePinnedBrokerDnsBoundary(
      async () => ({ code: 0, stdout: '{"addresses":["172.30.0.3","172.30.0.4"]}\n', stderr: '' }),
      descriptor,
      harnessInspect(descriptor),
      brokerInspect(descriptor),
    ),
    /does not resolve uniquely/u,
  );
});

test('fixed recovery container uses the separately verified helper image and has no shell, socket, secret, or published port', async (t) => {
  const fixture = await fixtureRoot();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const validated = validateHostRecoveryDescriptor(fixture.descriptor, { allowedRoot: fixture.root });
  const prepared = await prepareHostRecoveryInputs(validated);
  const definition = buildRecoveryContainerCreateArgs(fixture.descriptor, prepared);
  assert.equal(path.relative(fixture.evidence, prepared.inputDirectory).startsWith('..'), true);
  assert.equal(path.relative(prepared.inputDirectory, fixture.evidence).startsWith('..'), true);
  assert.equal(definition.args.includes('sh'), false);
  assert.equal(definition.args.some((value) => /docker\.sock|--publish|--volumes-from/u.test(value)), false);
  assert.equal(definition.args.at(-2), helperImageId);
  assert.equal(definition.args.at(-1), '/usr/local/lib/forge-recover-headless-execution.mjs');
  assert.equal(recoveryContainerEnvironment(fixture.descriptor).FORGE_EVAL_PROMPT_FILE, '/forge-recovery/input/prompt.md');
  assert.doesNotThrow(() => validateHarnessRecoveryBoundary(
    harnessInspect(fixture.descriptor), fixture.descriptor, fixture.descriptor.paths,
  ));
  assert.doesNotThrow(() => validateBrokerRecoveryBoundary(
    brokerInspect(fixture.descriptor), fixture.descriptor, fixture.descriptor.paths,
  ));
  assert.doesNotThrow(() => validateRecoveryHelperImageBoundary(
    recoveryHelperImageInspect(fixture.descriptor), recoveryHelperProbe(fixture.descriptor),
    fixture.descriptor,
  ));
  const unsafeHelperImage = recoveryHelperImageInspect(fixture.descriptor);
  unsafeHelperImage[0].Config.Env.push('LD_AUDIT=/workspace/audit.so');
  assert.throws(
    () => validateRecoveryHelperImageBoundary(
      unsafeHelperImage, recoveryHelperProbe(fixture.descriptor), fixture.descriptor,
    ),
    /runtime environment is unsafe/u,
  );
  assert.doesNotThrow(() => validateRecoveryContainerBoundary(
    helperInspect(fixture.descriptor, prepared, definition), fixture.descriptor, prepared, definition,
  ));
  const harnessLoaderInjection = harnessInspect(fixture.descriptor);
  harnessLoaderInjection[0].Config.Env.push('NODE_OPTIONS=--require=/workspace/evil.cjs');
  assert.throws(
    () => validateHarnessRecoveryBoundary(
      harnessLoaderInjection, fixture.descriptor, fixture.descriptor.paths,
    ),
    /drifted/u,
  );
  const harnessWrongPermissionMode = harnessInspect(fixture.descriptor);
  harnessWrongPermissionMode[0].Config.Env = harnessWrongPermissionMode[0].Config.Env.map((entry) => (
    entry.startsWith('DSH_PERMISSION_MODE=') ? 'DSH_PERMISSION_MODE=full-access' : entry
  ));
  assert.throws(
    () => validateHarnessRecoveryBoundary(
      harnessWrongPermissionMode, fixture.descriptor, fixture.descriptor.paths,
    ),
    /drifted/u,
  );
  const harnessTestShadowInjection = harnessInspect(fixture.descriptor);
  harnessTestShadowInjection[0].Config.Env.push('FORGE_TEST_SHADOW_CANDIDATE_WRITE=enabled');
  assert.throws(
    () => validateHarnessRecoveryBoundary(
      harnessTestShadowInjection, fixture.descriptor, fixture.descriptor.paths,
    ),
    /drifted/u,
  );
  const brokerPathInjection = brokerInspect(fixture.descriptor);
  brokerPathInjection[0].Config.Env = brokerPathInjection[0].Config.Env.map((entry) => (
    entry.startsWith('PATH=') ? 'PATH=/workspace/bin:/usr/local/bin:/usr/bin' : entry
  ));
  assert.throws(
    () => validateBrokerRecoveryBoundary(
      brokerPathInjection, fixture.descriptor, fixture.descriptor.paths,
    ),
    /project identity or mount boundary drifted/u,
  );
  const brokerNodeOverlay = brokerInspect(fixture.descriptor);
  brokerNodeOverlay[0].Mounts.push({
    Source: path.join(fixture.root, 'evil-node'),
    Destination: '/usr/local/bin/node',
    RW: false,
    Type: 'bind',
  });
  assert.throws(
    () => validateBrokerRecoveryBoundary(
      brokerNodeOverlay, fixture.descriptor, fixture.descriptor.paths,
    ),
    /security boundary drifted/u,
  );
  const harnessExtraCapability = harnessInspect(fixture.descriptor);
  harnessExtraCapability[0].HostConfig.CapAdd = ['SYS_ADMIN'];
  assert.throws(
    () => validateHarnessRecoveryBoundary(
      harnessExtraCapability, fixture.descriptor, fixture.descriptor.paths,
    ),
    /security boundary drifted/u,
  );
  const harnessUnconfinedProfile = harnessInspect(fixture.descriptor);
  harnessUnconfinedProfile[0].HostConfig.SecurityOpt.push('seccomp=unconfined');
  assert.throws(
    () => validateHarnessRecoveryBoundary(
      harnessUnconfinedProfile, fixture.descriptor, fixture.descriptor.paths,
    ),
    /security boundary drifted/u,
  );
  const harnessHostDevice = harnessInspect(fixture.descriptor);
  harnessHostDevice[0].HostConfig.Devices.push({ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda' });
  assert.throws(
    () => validateHarnessRecoveryBoundary(
      harnessHostDevice, fixture.descriptor, fixture.descriptor.paths,
    ),
    /security boundary drifted/u,
  );
  const harnessBrokerDnsOverride = harnessInspect(fixture.descriptor);
  harnessBrokerDnsOverride[0].HostConfig.ExtraHosts.push('taskspace-broker:203.0.113.10');
  assert.throws(
    () => validateHarnessRecoveryBoundary(
      harnessBrokerDnsOverride, fixture.descriptor, fixture.descriptor.paths,
    ),
    /security boundary drifted/u,
  );
  const harnessUnknownMount = harnessInspect(fixture.descriptor);
  harnessUnknownMount[0].Mounts.push({ Source: '/root', Destination: '/host-root', RW: true, Type: 'bind' });
  assert.throws(
    () => validateHarnessRecoveryBoundary(
      harnessUnknownMount, fixture.descriptor, fixture.descriptor.paths,
    ),
    /mounts drifted/u,
  );
  const harnessExtraNetwork = harnessInspect(fixture.descriptor);
  harnessExtraNetwork[0].NetworkSettings.Networks.foreign = { NetworkID: 'f'.repeat(64) };
  assert.throws(
    () => validateHarnessRecoveryBoundary(
      harnessExtraNetwork, fixture.descriptor, fixture.descriptor.paths,
    ),
    /security boundary drifted/u,
  );
  const brokerUnknownMount = brokerInspect(fixture.descriptor);
  brokerUnknownMount[0].Mounts.push({ Source: '/root', Destination: '/host-root', RW: true, Type: 'bind' });
  assert.throws(
    () => validateBrokerRecoveryBoundary(
      brokerUnknownMount, fixture.descriptor, fixture.descriptor.paths,
    ),
    /mount boundary drifted/u,
  );
  const helperLoaderInjection = helperInspect(fixture.descriptor, prepared, definition);
  helperLoaderInjection[0].Config.Env.push('LD_PRELOAD=/workspace/evil.so');
  assert.throws(
    () => validateRecoveryContainerBoundary(
      helperLoaderInjection, fixture.descriptor, prepared, definition,
    ),
    /exact image and operation projection/u,
  );
  const unsafe = helperInspect(fixture.descriptor, prepared, definition);
  unsafe[0].Mounts.push({ Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true, Type: 'bind' });
  assert.throws(
    () => validateRecoveryContainerBoundary(unsafe, fixture.descriptor, prepared, definition),
    /escaped its fixed security boundary/u,
  );
  const privilegedHelper = helperInspect(fixture.descriptor, prepared, definition);
  privilegedHelper[0].HostConfig.CapAdd = ['SYS_ADMIN'];
  assert.throws(
    () => validateRecoveryContainerBoundary(
      privilegedHelper, fixture.descriptor, prepared, definition,
    ),
    /escaped its fixed security boundary/u,
  );
});

test('maintenance admission requires two consecutive exact drained observations', async () => {
  const observations = [
    { status: 503, body: { ok: false, status: 'maintenance', code: 'TASKSPACE_MAINTENANCE', epoch: `recovery-${operationId}`, drain: { mode: 'connection-tracked', drained: true, activeTcpConnections: 0, activeHttpRequests: 0, activeUpgradeConnections: 0 } } },
    { status: 503, body: { ok: false, status: 'maintenance', code: 'TASKSPACE_MAINTENANCE', epoch: `recovery-${operationId}`, drain: { mode: 'connection-tracked', drained: false, activeTcpConnections: 1, activeHttpRequests: 0, activeUpgradeConnections: 0 } } },
    { status: 503, body: { ok: false, status: 'maintenance', code: 'TASKSPACE_MAINTENANCE', epoch: `recovery-${operationId}`, drain: { mode: 'connection-tracked', drained: true, activeTcpConnections: 0, activeHttpRequests: 0, activeUpgradeConnections: 0 } } },
    { status: 503, body: { ok: false, status: 'maintenance', code: 'TASKSPACE_MAINTENANCE', epoch: `recovery-${operationId}`, drain: { mode: 'connection-tracked', drained: true, activeTcpConnections: 0, activeHttpRequests: 0, activeUpgradeConnections: 0 } } },
  ];
  const result = await waitForStableMaintenanceDrain({
    port: 23080,
    epoch: `recovery-${operationId}`,
    attempts: 4,
    health: async () => observations.shift(),
    sleep: async () => {},
  });
  assert.equal(result.attempts, 4);
});

test('container-loopback maintenance probe is fixed, bounded, and validates its JSON envelope', async () => {
  let invocation;
  const observation = await probeHarnessMaintenanceHealth({
    harnessContainerId: harnessId,
    run: async (program, args, options) => {
      invocation = { program, args, options };
      return {
        code: 0,
        timedOut: false,
        outputExceeded: false,
        stdout: JSON.stringify({
          status: 200,
          body: { ok: true, status: 'open', epoch: 'probe-test' },
        }),
        stderr: '',
      };
    },
  });
  assert.deepEqual(observation, {
    status: 200,
    body: { ok: true, status: 'open', epoch: 'probe-test' },
  });
  assert.equal(invocation.program, 'docker');
  assert.deepEqual(invocation.args.slice(0, 6), [
    'exec', '--user', '1000:983', harnessId, '/usr/local/bin/node', '--eval',
  ]);
  assert.equal(invocation.args.length, 7);
  assert.deepEqual(invocation.options, { timeoutMs: 10_000, maxOutputBytes: 256 * 1024 });
  assert.match(invocation.args[6], /host: '127\.0\.0\.1', port: 23080, path: '\/forge-maintenance\/healthz'/u);
  assert.doesNotMatch(
    invocation.args[6],
    /process\.env|process\.argv|child_process|docker|TOKEN|SECRET|PASSWORD/iu,
  );

  let invalidIdentityRan = false;
  await assert.rejects(
    () => probeHarnessMaintenanceHealth({
      harnessContainerId: 'not-a-container-id',
      run: async () => { invalidIdentityRan = true; },
    }),
    (error) => error.code === 'HOST_RECOVERY_HEALTH_PROBE_INVALID',
  );
  assert.equal(invalidIdentityRan, false);

  for (const invalidResult of [
    { code: 1, stdout: '', stderr: 'rejected' },
    { code: 0, timedOut: true, stdout: '', stderr: '' },
    { code: 0, outputExceeded: true, stdout: '', stderr: '' },
    { code: 0, stdout: '{', stderr: '' },
    { code: 0, stdout: JSON.stringify({ status: 200, body: {}, extra: true }), stderr: '' },
    { code: 0, stdout: JSON.stringify({ status: 200, body: [] }), stderr: '' },
  ]) {
    await assert.rejects(
      () => probeHarnessMaintenanceHealth({
        harnessContainerId: harnessId,
        run: async () => invalidResult,
      }),
      (error) => error.code === 'HOST_RECOVERY_HEALTH_PROBE_FAILED',
    );
  }
});

test('recovery secret metadata permits only non-empty fixed-group provider files and an exact empty root-only placeholder', () => {
  const metadata = (overrides = {}) => ({
    isFile: () => true,
    isSymbolicLink: () => false,
    nlink: 1,
    size: 32,
    uid: 0,
    gid: 983,
    mode: 0o100640,
    ...overrides,
  });
  assert.equal(validateRecoverySecretSourceMetadata(metadata(), {
    label: 'provider key', expectedUid: 0, expectedGid: 983, expectedMode: 0o640,
  }), true);
  assert.equal(validateRecoverySecretSourceMetadata(metadata({ size: 0, gid: 0, mode: 0o100400 }), {
    label: 'placeholder key', expectedUid: 0, expectedGid: 0, expectedMode: 0o400, expectedSize: 0,
  }), true);
  for (const changed of [
    { uid: 1000 },
    { gid: 0 },
    { mode: 0o100660 },
    { mode: 0o100644 },
    { mode: 0o104640 },
    { mode: 0o102640 },
    { mode: 0o101640 },
    { nlink: 2 },
  ]) {
    assert.throws(
      () => validateRecoverySecretSourceMetadata(metadata(changed), {
        label: 'provider key', expectedUid: 0, expectedGid: 983, expectedMode: 0o640,
      }),
      (error) => error.code === 'HOST_RECOVERY_SECRET_SOURCE_INVALID',
    );
  }
  assert.throws(
    () => validateRecoverySecretSourceMetadata(metadata({ size: 0 }), {
      label: 'provider key', expectedUid: 0, expectedGid: 983, expectedMode: 0o640,
    }),
    (error) => error.code === 'HOST_RECOVERY_SECRET_SOURCE_INVALID',
  );
  assert.throws(
    () => validateRecoverySecretSourceMetadata(metadata({ gid: 0, mode: 0o100400 }), {
      label: 'placeholder key', expectedUid: 0, expectedGid: 0, expectedMode: 0o400, expectedSize: 0,
    }),
    (error) => error.code === 'HOST_RECOVERY_SECRET_SOURCE_INVALID',
  );
});

for (const resumedDrift of [
  {
    name: 'workspace',
    mutate: (fixture) => writeFile(path.join(fixture.descriptor.paths.workspaceDirectory, 'drift.txt'), 'drift\n'),
  },
  {
    name: 'phase state',
    mutate: (fixture) => writeFile(fixture.files.phaseStateFile, '{"drift":true}\n'),
  },
  {
    name: 'accepted artifact',
    mutate: (fixture) => writeFile(
      path.join(fixture.descriptor.paths.artifactsDirectory, 'database-schema.json'),
      '{"drift":true}\n',
    ),
  },
]) {
  test(`resumed maintenance without durable intent rejects ${resumedDrift.name} drift`, async (t) => {
    const fixture = await fixtureRoot();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const validated = validateHostRecoveryDescriptor(fixture.descriptor, { allowedRoot: fixture.root });
    await prepareHostRecoveryInputs(validated);
    await seedOwnedMaintenanceResume(fixture);
    await resumedDrift.mutate(fixture);
    let dockerCalls = 0;
    await assert.rejects(
      () => executeHostProtectedRecovery({
        descriptor: fixture.descriptor,
        allowedRoot: fixture.root,
        run: async () => { dockerCalls += 1; throw new Error('docker must not run after live input drift'); },
        health: async () => { throw new Error('health must not run after live input drift'); },
        sleep: async () => {},
      }),
      (error) => [
        'HOST_RECOVERY_INPUT_DRIFT',
        'HOST_RECOVERY_WORKSPACE_DRIFT',
        'HOST_RECOVERY_ARTIFACT_INVALID',
      ].includes(error.code),
    );
    assert.equal(dockerCalls, 0);
    const fence = JSON.parse(await readFile(fixture.files.maintenanceFenceFile, 'utf8'));
    assert.equal(fence.state, 'maintenance');
    assert.equal(fence.epoch, `recovery-${operationId}`);
  });
}

test('host orchestration restores the original fence byte-for-byte after one accepted helper start', async (t) => {
  const fixture = await fixtureRoot();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const originalFence = await readFile(fixture.files.maintenanceFenceFile);
  const beforeSnapshotFile = path.join(fixture.evidence, 'before-snapshot.json');
  await assert.rejects(readFile(beforeSnapshotFile), (error) => error.code === 'ENOENT');
  const validated = validateHostRecoveryDescriptor(fixture.descriptor, { allowedRoot: fixture.root });
  const prepared = await prepareHostRecoveryInputs(validated);
  const definition = buildRecoveryContainerCreateArgs(fixture.descriptor, prepared);
  const calls = [];
  const intentBytes = Buffer.from('{"intent":"durable"}\n');
  let receiptBytes;
  let receiptName;
  const run = async (program, args, options = {}) => {
    assert.equal(program, 'docker');
    calls.push([...args]);
    if (args[0] === 'exec') {
      assert.equal(args.length, 7);
      assert.deepEqual(args.slice(0, 6), [
        'exec', '--user', '1000:983', fixture.descriptor.target.harnessContainerId,
        '/usr/local/bin/node', '--eval',
      ]);
      assert.deepEqual(options, { timeoutMs: 10_000, maxOutputBytes: 256 * 1024 });
      assert.match(args[6], /host: '127\.0\.0\.1', port: 23080, path: '\/forge-maintenance\/healthz'/u);
      assert.match(args[6], /if \(length > 32768\)/u);
      assert.doesNotMatch(args[6], /process\.env|process\.argv|child_process|docker|TOKEN|SECRET|PASSWORD/iu);
      const fence = JSON.parse(await readFile(fixture.files.maintenanceFenceFile, 'utf8'));
      const body = fence.state === 'committed'
        ? { ok: true, status: 'open', epoch: fence.epoch }
        : {
            ok: false, status: 'maintenance', code: 'TASKSPACE_MAINTENANCE', epoch: fence.epoch,
            drain: {
              mode: 'connection-tracked', drained: true,
              activeTcpConnections: 0, activeHttpRequests: 0, activeUpgradeConnections: 0,
            },
          };
      return {
        code: 0,
        timedOut: false,
        outputExceeded: false,
        stdout: JSON.stringify({ status: fence.state === 'committed' ? 200 : 503, body }),
        stderr: '',
      };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      return { code: 0, stdout: JSON.stringify(recoveryHelperImageInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'run') {
      return { code: 0, stdout: JSON.stringify(recoveryHelperProbe(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.harnessContainerId) {
      return { code: 0, stdout: JSON.stringify(harnessInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.brokerContainerId) {
      return { code: 0, stdout: JSON.stringify(brokerInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === definition.name) return { code: 1, stdout: '', stderr: 'not found' };
    if (args[0] === 'create') return { code: 0, stdout: `${helperId}\n`, stderr: '' };
    if (args[0] === 'inspect' && args[1] === helperId) {
      return { code: 0, stdout: JSON.stringify(helperInspect(fixture.descriptor, prepared, definition)), stderr: '' };
    }
    if (args[0] === 'start') {
      const persistedBefore = validateForgeDeliveryWorkspaceSnapshot(
        JSON.parse(await readFile(beforeSnapshotFile, 'utf8')),
      );
      assert.equal(persistedBefore.baseCommit, fixture.descriptor.execution.sourceCommit);
      assert.equal(
        persistedBefore.snapshotDigest,
        fixture.descriptor.execution.workspaceSnapshotDigest,
      );
      await writeFile(path.join(fixture.evidence, `submission-intent-${operationId}.json`), intentBytes);
      receiptBytes = Buffer.from(`${JSON.stringify({
        schemaVersion: 'forge-protected-headless-recovery/v1',
        status: 'accepted',
        operationId,
        taskId,
        sessionId: fixture.descriptor.execution.sessionId,
        rpcId: fixture.descriptor.execution.rpcId,
        promptDigest: fixture.descriptor.digests.promptTextSha256,
        phaseAttemptId: fixture.descriptor.execution.phaseAttemptId,
        phaseId: fixture.descriptor.execution.phaseId,
        executionId: fixture.descriptor.execution.executionId,
        claimId: fixture.descriptor.execution.claimId,
        generation: fixture.descriptor.execution.generation,
        contractId: fixture.descriptor.execution.contractId,
        sourceCommit: fixture.descriptor.execution.sourceCommit,
        maintenance: { epoch: `recovery-${operationId}`, drained: true },
        durableIntent: {
          file: `submission-intent-${operationId}.json`,
          sha256: sha256(intentBytes),
          writtenBeforeIngress: true,
          automaticResendForbidden: true,
        },
        ingress: { forwarded: true, idempotent: false },
        executionConsumption: {
          taskId,
          operationId,
          executionId: fixture.descriptor.execution.executionId,
          claimId: fixture.descriptor.execution.claimId,
          generation: fixture.descriptor.execution.generation,
          contractId: fixture.descriptor.execution.contractId,
          phaseAttemptId: fixture.descriptor.execution.phaseAttemptId,
          lifecycleStatus: 'consumed',
          recoveryStatus: 'consumed',
          consumed: true,
          consumedAt: '2026-09-05T00:00:01.000Z',
          exactIdentity: true,
        },
        proofScope: {
          brokerExecutionContextConsumed: true,
          phaseGuardBound: false,
          classification: 'broker-execution-context-consumed',
        },
      })}\n`);
      receiptName = `recovery-${operationId}-${sha256(receiptBytes)}.json`;
      await writeFile(path.join(fixture.evidence, receiptName), receiptBytes);
      return {
        code: 0,
        stdout: `${JSON.stringify({
          schemaVersion: 'forge-protected-headless-recovery-cli/v1',
          status: 'accepted',
          receiptFile: receiptName,
          receiptSha256: sha256(receiptBytes),
          receiptBytes: receiptBytes.length,
        })}\n`,
        stderr: '',
      };
    }
    throw new Error(`unexpected docker call: ${args.join(' ')}`);
  };
  const result = await executeHostProtectedRecovery({
    descriptor: fixture.descriptor,
    allowedRoot: fixture.root,
    run,
    sleep: async () => {},
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(await readFile(fixture.files.maintenanceFenceFile), originalFence);
  assert.equal(calls.filter((args) => args[0] === 'create').length, 1);
  assert.equal(calls.filter((args) => args[0] === 'start').length, 1);
  assert.equal(calls.filter((args) => args[0] === 'exec').length, 3);
  const journal = JSON.parse(await readFile(path.join(fixture.evidence, 'host-recovery-journal.json'), 'utf8'));
  assert.equal(journal.state, 'restored');
  assert.equal(journal.originalFenceRestored, true);

  await writeFile(
    path.join(fixture.descriptor.paths.workspaceDirectory, 'backend-candidate.java'),
    'final class BackendCandidate {}\n',
  );
  const postPhase = await observeForgeDeliveryPhase({
    workspace: fixture.descriptor.paths.workspaceDirectory,
    baseCommit: fixture.descriptor.execution.sourceCommit,
    before: JSON.parse(await readFile(beforeSnapshotFile, 'utf8')),
  });
  assert.deepEqual(postPhase.phaseChangedPaths, ['backend-candidate.java']);
  assert.deepEqual(postPhase.allChangedPaths, ['backend-candidate.java', 'database.sql']);
});

test('host restores the fence after proving a pre-permit failure against unchanged execution state', async (t) => {
  const fixture = await fixtureRoot();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const unpermittedState = await installDescriptorBoundUnpermittedExecutionState(fixture);
  const originalFence = await readFile(fixture.files.maintenanceFenceFile);
  const validated = validateHostRecoveryDescriptor(fixture.descriptor, { allowedRoot: fixture.root });
  const prepared = await prepareHostRecoveryInputs(validated);
  const definition = buildRecoveryContainerCreateArgs(fixture.descriptor, prepared);
  let startCount = 0;
  let statusCalls = 0;
  const run = async (program, args) => {
    assert.equal(program, 'docker');
    if (args[0] === 'image' && args[1] === 'inspect') {
      return { code: 0, stdout: JSON.stringify(recoveryHelperImageInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'run') {
      return { code: 0, stdout: JSON.stringify(recoveryHelperProbe(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.harnessContainerId) {
      return { code: 0, stdout: JSON.stringify(harnessInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.brokerContainerId) {
      return { code: 0, stdout: JSON.stringify(brokerInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === definition.name) {
      return { code: 1, stdout: '', stderr: 'not found' };
    }
    if (args[0] === 'create') return { code: 0, stdout: `${helperId}\n`, stderr: '' };
    if (args[0] === 'inspect' && args[1] === helperId) {
      return {
        code: 0,
        stdout: JSON.stringify(helperInspect(fixture.descriptor, prepared, definition)),
        stderr: '',
      };
    }
    if (args[0] === 'start') {
      startCount += 1;
      return writePreIngressFailureHelperOutput(fixture, (receipt) => {
        receipt.preIngressState = 'unpermitted-state-unchanged';
        receipt.executionStatus = {
          ...receipt.executionStatus,
          revision: unpermittedState.revision,
          recoveryStatus: null,
          descriptorExecutionStateUnchanged: true,
          executionStateSha256: unpermittedState.sha256,
        };
        receipt.proofScope.brokerRecoveryPermitIssued = false;
      });
    }
    throw new Error(`unexpected docker call: ${args.join(' ')}`);
  };
  const health = async () => {
    const fence = JSON.parse(await readFile(fixture.files.maintenanceFenceFile, 'utf8'));
    return fence.state === 'committed'
      ? { status: 200, body: { ok: true, status: 'open', epoch: fence.epoch } }
      : {
          status: 503,
          body: {
            ok: false, status: 'maintenance', code: 'TASKSPACE_MAINTENANCE', epoch: fence.epoch,
            drain: {
              mode: 'connection-tracked', drained: true,
              activeTcpConnections: 0, activeHttpRequests: 0, activeUpgradeConnections: 0,
            },
          },
        };
  };
  const result = await executeHostProtectedRecovery({
    descriptor: fixture.descriptor,
    allowedRoot: fixture.root,
    run,
    health,
    sleep: async () => {},
    readRecoveryStatus: async () => {
      statusCalls += 1;
      const error = new Error('operation-scoped status is unavailable before permit');
      error.code = 'EXECUTION_RECOVERY_STATUS_MISMATCH';
      throw error;
    },
  });
  assert.equal(result.status, 'pre-ingress-failed');
  assert.equal(result.preIngressFailed, true);
  assert.equal(result.failureCode, 'RECOVERY_BASELINE_DRIFT');
  assert.equal(result.automaticRetryAuthorized, false);
  assert.equal(result.automaticResendForbidden, true);
  assert.equal(startCount, 1);
  assert.equal(statusCalls, 2);
  assert.deepEqual(await readFile(fixture.files.maintenanceFenceFile), originalFence);
  const journal = JSON.parse(await readFile(
    path.join(fixture.evidence, 'host-recovery-journal.json'), 'utf8',
  ));
  assert.equal(journal.state, 'restored');
  assert.equal(journal.originalFenceRestored, true);
  assert.equal(journal.terminalOutcome.state, 'pre-ingress-failed');
  assert.equal(journal.terminalOutcome.executionRevision, unpermittedState.revision);
});

for (const unsafeFailureCase of [
  {
    name: 'durable intent exists',
    prepare: async (fixture) => writeFile(
      path.join(fixture.evidence, `submission-intent-${operationId}.json`),
      '{"intent":"durable"}\n',
    ),
    status: (fixture) => exactHostPermittedRecoveryStatus(fixture),
    expectedCode: 'HOST_RECOVERY_RESULT_AMBIGUOUS',
  },
  {
    name: 'Broker claim exists',
    status: (fixture) => exactHostPermittedRecoveryStatus(fixture, {
      lifecycleStatus: 'submission-attempted',
      recoveryStatus: 'submission-attempted',
      recoveryReadbackSeq: fixture.descriptor.execution.expectedBaselineSeq,
      recoveryReadbackDigest: 'b'.repeat(64),
    }),
    expectedCode: 'HOST_RECOVERY_RESULT_AMBIGUOUS',
  },
  {
    name: 'Broker ingress-forward exists',
    status: (fixture) => exactHostPermittedRecoveryStatus(fixture, {
      lifecycleStatus: 'submission-attempted',
      recoveryStatus: 'ingress-forwarded',
      recoveryReadbackSeq: fixture.descriptor.execution.expectedBaselineSeq,
      recoveryReadbackDigest: 'b'.repeat(64),
    }),
    expectedCode: 'HOST_RECOVERY_RESULT_AMBIGUOUS',
  },
  {
    name: 'content-addressed receipt binds the wrong prompt',
    mutate: (receipt) => { receipt.promptDigest = '0'.repeat(64); },
    status: (fixture) => exactHostPermittedRecoveryStatus(fixture),
    expectedCode: 'HOST_RECOVERY_RESULT_INVALID',
  },
]) {
  test(`host keeps maintenance closed when pre-ingress failure proof conflicts: ${unsafeFailureCase.name}`, async (t) => {
    const fixture = await fixtureRoot();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const validated = validateHostRecoveryDescriptor(fixture.descriptor, { allowedRoot: fixture.root });
    const prepared = await prepareHostRecoveryInputs(validated);
    const definition = buildRecoveryContainerCreateArgs(fixture.descriptor, prepared);
    let startCount = 0;
    const run = async (program, args) => {
      assert.equal(program, 'docker');
      if (args[0] === 'image' && args[1] === 'inspect') {
        return { code: 0, stdout: JSON.stringify(recoveryHelperImageInspect(fixture.descriptor)), stderr: '' };
      }
      if (args[0] === 'run') {
        return { code: 0, stdout: JSON.stringify(recoveryHelperProbe(fixture.descriptor)), stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.harnessContainerId) {
        return { code: 0, stdout: JSON.stringify(harnessInspect(fixture.descriptor)), stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.brokerContainerId) {
        return { code: 0, stdout: JSON.stringify(brokerInspect(fixture.descriptor)), stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === definition.name) {
        return { code: 1, stdout: '', stderr: 'not found' };
      }
      if (args[0] === 'create') return { code: 0, stdout: `${helperId}\n`, stderr: '' };
      if (args[0] === 'inspect' && args[1] === helperId) {
        return {
          code: 0,
          stdout: JSON.stringify(helperInspect(fixture.descriptor, prepared, definition)),
          stderr: '',
        };
      }
      if (args[0] === 'start') {
        startCount += 1;
        const output = await writePreIngressFailureHelperOutput(fixture, unsafeFailureCase.mutate);
        await unsafeFailureCase.prepare?.(fixture);
        return output;
      }
      throw new Error(`unexpected docker call: ${args.join(' ')}`);
    };
    const health = async () => {
      const fence = JSON.parse(await readFile(fixture.files.maintenanceFenceFile, 'utf8'));
      return fence.state === 'committed'
        ? { status: 200, body: { ok: true, status: 'open', epoch: fence.epoch } }
        : {
            status: 503,
            body: {
              ok: false, status: 'maintenance', code: 'TASKSPACE_MAINTENANCE', epoch: fence.epoch,
              drain: {
                mode: 'connection-tracked', drained: true,
                activeTcpConnections: 0, activeHttpRequests: 0, activeUpgradeConnections: 0,
              },
            },
          };
    };
    await assert.rejects(
      () => executeHostProtectedRecovery({
        descriptor: fixture.descriptor,
        allowedRoot: fixture.root,
        run,
        health,
        sleep: async () => {},
        readRecoveryStatus: async () => unsafeFailureCase.status(fixture),
      }),
      (error) => error.code === unsafeFailureCase.expectedCode,
    );
    assert.equal(startCount, 1);
    const fence = JSON.parse(await readFile(fixture.files.maintenanceFenceFile, 'utf8'));
    assert.equal(fence.state, 'maintenance');
    assert.equal(fence.epoch, `recovery-${operationId}`);
    const journal = JSON.parse(await readFile(
      path.join(fixture.evidence, 'host-recovery-journal.json'), 'utf8',
    ));
    assert.equal(journal.state, 'ambiguous-no-resend');
    assert.equal(journal.originalFenceRestored, false);
  });
}

for (const recoveryCase of [
  {
    name: 'created helper is started without consuming the continuation allowance',
    state: {
      Status: 'created', Running: false, Paused: false, Restarting: false, Dead: false,
      StartedAt: '0001-01-01T00:00:00Z',
    },
    lifecycleStatus: 'prepared',
    recoveryStatus: 'permitted',
    expectsMarker: false,
  },
  {
    name: 'one exited pre-ingress helper resumes with a persisted continuation allowance',
    state: {
      Status: 'exited', Running: false, Paused: false, Restarting: false, Dead: false,
      StartedAt: '2026-09-05T00:00:00.500Z',
    },
    lifecycleStatus: 'submission-attempted',
    recoveryStatus: 'submission-attempted',
    expectsMarker: true,
  },
]) {
  test(recoveryCase.name, async (t) => {
    const fixture = await fixtureRoot();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const originalFence = await readFile(fixture.files.maintenanceFenceFile);
    const validated = validateHostRecoveryDescriptor(fixture.descriptor, { allowedRoot: fixture.root });
    const prepared = await prepareHostRecoveryInputs(validated);
    const definition = buildRecoveryContainerCreateArgs(fixture.descriptor, prepared);
    let createCount = 0;
    let startCount = 0;
    const run = async (program, args) => {
      assert.equal(program, 'docker');
      if (args[0] === 'image' && args[1] === 'inspect') {
        return { code: 0, stdout: JSON.stringify(recoveryHelperImageInspect(fixture.descriptor)), stderr: '' };
      }
      if (args[0] === 'run') {
        return { code: 0, stdout: JSON.stringify(recoveryHelperProbe(fixture.descriptor)), stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.harnessContainerId) {
        return { code: 0, stdout: JSON.stringify(harnessInspect(fixture.descriptor)), stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.brokerContainerId) {
        return { code: 0, stdout: JSON.stringify(brokerInspect(fixture.descriptor)), stderr: '' };
      }
      if (args[0] === 'inspect' && [definition.name, helperId].includes(args[1])) {
        return {
          code: 0,
          stdout: JSON.stringify(helperInspect(fixture.descriptor, prepared, definition, {
            state: recoveryCase.state,
          })),
          stderr: '',
        };
      }
      if (args[0] === 'create') {
        createCount += 1;
        return { code: 0, stdout: `${helperId}\n`, stderr: '' };
      }
      if (args[0] === 'start') {
        startCount += 1;
        return writeAcceptedHelperOutput(fixture);
      }
      throw new Error(`unexpected docker call: ${args.join(' ')}`);
    };
    const health = async () => {
      const fence = JSON.parse(await readFile(fixture.files.maintenanceFenceFile, 'utf8'));
      return fence.state === 'committed'
        ? { status: 200, body: { ok: true, status: 'open', epoch: fence.epoch } }
        : {
            status: 503,
            body: {
              ok: false, status: 'maintenance', code: 'TASKSPACE_MAINTENANCE', epoch: fence.epoch,
              drain: { mode: 'connection-tracked', drained: true, activeTcpConnections: 0, activeHttpRequests: 0, activeUpgradeConnections: 0 },
            },
          };
    };
    const result = await executeHostProtectedRecovery({
      descriptor: fixture.descriptor,
      allowedRoot: fixture.root,
      run,
      health,
      sleep: async () => {},
      readRecoveryStatus: async () => ({
        taskId,
        operationId,
        executionId: fixture.descriptor.execution.executionId,
        claimId: fixture.descriptor.execution.claimId,
        generation: fixture.descriptor.execution.generation,
        contractId: fixture.descriptor.execution.contractId,
        phaseAttemptId: fixture.descriptor.execution.phaseAttemptId,
        lifecycleStatus: recoveryCase.lifecycleStatus,
        recoveryStatus: recoveryCase.recoveryStatus,
        consumed: false,
        consumedAt: null,
      }),
    });
    assert.equal(result.status, 'accepted');
    assert.equal(createCount, 0);
    assert.equal(startCount, 1);
    assert.deepEqual(await readFile(fixture.files.maintenanceFenceFile), originalFence);
    const marker = path.join(fixture.evidence, `pre-ingress-continuation-${operationId}.json`);
    assert.equal(await readFile(marker).then(() => true, () => false), recoveryCase.expectsMarker);
  });
}

for (const cancellationCase of [
  {
    name: 'authorization expires before ingress',
    now: (fixture) => () => new Date(Date.parse(fixture.descriptor.operation.authorizationExpiresAt) + 1_000),
    seedContinuation: false,
    expectedReason: 'authorization-expired-before-ingress',
  },
  {
    name: 'the one pre-ingress continuation is already exhausted',
    now: () => () => new Date(),
    seedContinuation: true,
    expectedReason: 'pre-ingress-continuation-exhausted',
  },
]) {
  test(`stopped no-intent recovery is terminalized when ${cancellationCase.name}`, async (t) => {
    const fixture = await fixtureRoot();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const originalFence = await readFile(fixture.files.maintenanceFenceFile);
    const validated = validateHostRecoveryDescriptor(fixture.descriptor, { allowedRoot: fixture.root });
    const prepared = await prepareHostRecoveryInputs(validated);
    await seedOwnedMaintenanceResume(fixture);
    const normalDefinition = buildRecoveryContainerCreateArgs(fixture.descriptor, prepared);
    const cancellationDefinition = buildRecoveryPreIngressCancellationContainerCreateArgs(
      fixture.descriptor, prepared,
    );
    const stoppedState = {
      Status: 'exited', Running: false, Paused: false, Restarting: false, Dead: false,
      StartedAt: '2026-09-05T00:00:00.500Z',
    };
    if (cancellationCase.seedContinuation) {
      await writeFile(
        path.join(fixture.evidence, `pre-ingress-continuation-${operationId}.json`),
        `${JSON.stringify({
          schemaVersion: 'forge-protected-headless-pre-ingress-continuation/v1',
          operationId,
          descriptorSha256: fixture.descriptor.operation.descriptorSha256,
          containerId: helperId,
          beforeStartedAt: stoppedState.StartedAt,
          authorizedAt: '2026-09-05T00:00:01.000Z',
          invariant: 'Only one actual restart of this immutable stopped container is authorized before ingress.',
        })}\n`,
      );
    }
    let normalStarts = 0;
    let cancellationStarts = 0;
    const run = async (program, args) => {
      assert.equal(program, 'docker');
      if (args[0] === 'image' && args[1] === 'inspect') {
        return { code: 0, stdout: JSON.stringify(recoveryHelperImageInspect(fixture.descriptor)), stderr: '' };
      }
      if (args[0] === 'run') {
        return { code: 0, stdout: JSON.stringify(recoveryHelperProbe(fixture.descriptor)), stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.harnessContainerId) {
        return { code: 0, stdout: JSON.stringify(harnessInspect(fixture.descriptor)), stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.brokerContainerId) {
        return { code: 0, stdout: JSON.stringify(brokerInspect(fixture.descriptor)), stderr: '' };
      }
      if (args[0] === 'inspect' && [normalDefinition.name, helperId].includes(args[1])) {
        return {
          code: 0,
          stdout: JSON.stringify(helperInspect(
            fixture.descriptor, prepared, normalDefinition, { state: stoppedState },
          )),
          stderr: '',
        };
      }
      if (args[0] === 'inspect' && args[1] === cancellationDefinition.name) {
        return { code: 1, stdout: '', stderr: 'not found' };
      }
      if (args[0] === 'create') {
        assert.equal(args.includes(cancellationDefinition.name), true);
        return { code: 0, stdout: `${cancellationHelperId}\n`, stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === cancellationHelperId) {
        return {
          code: 0,
          stdout: JSON.stringify(helperInspect(
            fixture.descriptor,
            prepared,
            cancellationDefinition,
            { id: cancellationHelperId },
          )),
          stderr: '',
        };
      }
      if (args[0] === 'start' && args.at(-1) === helperId) {
        normalStarts += 1;
        throw new Error('normal recovery helper must not restart');
      }
      if (args[0] === 'start' && args.at(-1) === cancellationHelperId) {
        cancellationStarts += 1;
        return writeCancellationHelperOutput(fixture);
      }
      throw new Error(`unexpected docker call: ${args.join(' ')}`);
    };
    const health = async () => {
      const fence = JSON.parse(await readFile(fixture.files.maintenanceFenceFile, 'utf8'));
      return fence.state === 'committed'
        ? { status: 200, body: { ok: true, status: 'open', epoch: fence.epoch } }
        : {
            status: 503,
            body: {
              ok: false, status: 'maintenance', code: 'TASKSPACE_MAINTENANCE', epoch: fence.epoch,
              drain: {
                mode: 'connection-tracked', drained: true,
                activeTcpConnections: 0, activeHttpRequests: 0, activeUpgradeConnections: 0,
              },
            },
          };
    };
    const result = await executeHostProtectedRecovery({
      descriptor: fixture.descriptor,
      allowedRoot: fixture.root,
      run,
      health,
      sleep: async () => {},
      now: cancellationCase.now(fixture),
      readRecoveryStatus: async () => ({
        taskId,
        operationId,
        executionId: fixture.descriptor.execution.executionId,
        claimId: fixture.descriptor.execution.claimId,
        generation: fixture.descriptor.execution.generation,
        contractId: fixture.descriptor.execution.contractId,
        phaseAttemptId: fixture.descriptor.execution.phaseAttemptId,
        lifecycleStatus: 'submission-attempted',
        recoveryStatus: 'submission-attempted',
        recoveryReadbackSeq: fixture.descriptor.execution.expectedBaselineSeq,
        recoveryReadbackDigest: 'b'.repeat(64),
        consumed: false,
        consumedAt: null,
        terminalTombstone: null,
      }),
    });
    assert.equal(result.preIngressCancelled, true);
    assert.equal(result.reason, cancellationCase.expectedReason);
    assert.equal(normalStarts, 0);
    assert.equal(cancellationStarts, 1);
    assert.deepEqual(await readFile(fixture.files.maintenanceFenceFile), originalFence);
    const journal = JSON.parse(await readFile(
      path.join(fixture.evidence, 'host-recovery-journal.json'), 'utf8',
    ));
    assert.equal(journal.state, 'restored');
    assert.equal(journal.terminalOutcome.state, 'pre-ingress-cancelled');
  });
}

test('a definitive helper result cannot succeed when the owned fence becomes unreadable', async (t) => {
  const fixture = await fixtureRoot();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const validated = validateHostRecoveryDescriptor(fixture.descriptor, { allowedRoot: fixture.root });
  const prepared = await prepareHostRecoveryInputs(validated);
  const definition = buildRecoveryContainerCreateArgs(fixture.descriptor, prepared);
  const run = async (program, args) => {
    assert.equal(program, 'docker');
    if (args[0] === 'image' && args[1] === 'inspect') {
      return { code: 0, stdout: JSON.stringify(recoveryHelperImageInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'run') {
      return { code: 0, stdout: JSON.stringify(recoveryHelperProbe(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.harnessContainerId) {
      return { code: 0, stdout: JSON.stringify(harnessInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.brokerContainerId) {
      return { code: 0, stdout: JSON.stringify(brokerInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === definition.name) {
      return { code: 1, stdout: '', stderr: 'not found' };
    }
    if (args[0] === 'create') return { code: 0, stdout: `${helperId}\n`, stderr: '' };
    if (args[0] === 'inspect' && args[1] === helperId) {
      return { code: 0, stdout: JSON.stringify(helperInspect(fixture.descriptor, prepared, definition)), stderr: '' };
    }
    if (args[0] === 'start') {
      const output = await writeAcceptedHelperOutput(fixture);
      await rm(fixture.files.maintenanceFenceFile);
      return output;
    }
    throw new Error(`unexpected docker call: ${args.join(' ')}`);
  };
  const health = async () => {
    const fence = JSON.parse(await readFile(fixture.files.maintenanceFenceFile, 'utf8'));
    return {
      status: 503,
      body: {
        ok: false, status: 'maintenance', code: 'TASKSPACE_MAINTENANCE', epoch: fence.epoch,
        drain: { mode: 'connection-tracked', drained: true, activeTcpConnections: 0, activeHttpRequests: 0, activeUpgradeConnections: 0 },
      },
    };
  };
  await assert.rejects(
    () => executeHostProtectedRecovery({
      descriptor: fixture.descriptor,
      allowedRoot: fixture.root,
      run,
      health,
      sleep: async () => {},
    }),
    (error) => error.code === 'HOST_RECOVERY_FENCE_RESTORE_FAILED',
  );
  const journal = JSON.parse(await readFile(path.join(fixture.evidence, 'host-recovery-journal.json'), 'utf8'));
  assert.equal(journal.state, 'fence-restore-failed');
  assert.equal(journal.originalFenceRestored, false);
});

test('expired authorization permits exact own-maintenance cleanup but never creates or starts ingress', async (t) => {
  const fixture = await fixtureRoot();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const validated = validateHostRecoveryDescriptor(fixture.descriptor, { allowedRoot: fixture.root });
  await prepareHostRecoveryInputs(validated);
  const originalFence = await readFile(fixture.files.maintenanceFenceFile);
  const originalMetadata = await lstat(fixture.files.maintenanceFenceFile);
  const originalFenceFile = `original-fence-${operationId}.json`;
  await writeFile(path.join(fixture.evidence, originalFenceFile), originalFence);
  await writeFile(path.join(fixture.evidence, 'host-recovery-journal.json'), `${JSON.stringify({
    schemaVersion: 'forge-protected-headless-host-recovery-journal/v1',
    operationId,
    descriptorSha256: fixture.descriptor.operation.descriptorSha256,
    harnessContainerId: fixture.descriptor.target.harnessContainerId,
    brokerContainerId: fixture.descriptor.target.brokerContainerId,
    recoveryHelperImageId: fixture.descriptor.target.recoveryHelperImageId,
    recoveryHelperBuildInputDigest: fixture.descriptor.target.recoveryHelperBuildInputDigest,
    originalFenceFile,
    originalFenceSha256: sha256(originalFence),
    originalFenceEpoch: 'lifecycle-original',
    originalFenceMode: originalMetadata.mode & 0o777,
    originalFenceUid: originalMetadata.uid,
    originalFenceGid: originalMetadata.gid,
    state: 'fence-installed',
    updatedAt: '2026-09-05T00:00:00.000Z',
  }, null, 2)}\n`);
  await writeFile(
    fixture.files.maintenanceFenceFile,
    `${JSON.stringify({ schemaVersion: 1, state: 'maintenance', epoch: `recovery-${operationId}` })}\n`,
  );
  let createOrStartCount = 0;
  const run = async (program, args) => {
    assert.equal(program, 'docker');
    if (args[0] === 'image' && args[1] === 'inspect') {
      return { code: 0, stdout: JSON.stringify(recoveryHelperImageInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'run') {
      return { code: 0, stdout: JSON.stringify(recoveryHelperProbe(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.harnessContainerId) {
      return { code: 0, stdout: JSON.stringify(harnessInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.brokerContainerId) {
      return { code: 0, stdout: JSON.stringify(brokerInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && String(args[1]).startsWith('forge-recovery-')) {
      return { code: 1, stdout: '', stderr: 'not found' };
    }
    if (['create', 'start'].includes(args[0])) createOrStartCount += 1;
    throw new Error(`unexpected docker call: ${args.join(' ')}`);
  };
  const health = async () => {
    const fence = JSON.parse(await readFile(fixture.files.maintenanceFenceFile, 'utf8'));
    return fence.state === 'committed'
      ? { status: 200, body: { ok: true, status: 'open', epoch: fence.epoch } }
      : {
          status: 503,
          body: {
            ok: false, status: 'maintenance', code: 'TASKSPACE_MAINTENANCE', epoch: fence.epoch,
            drain: { mode: 'connection-tracked', drained: true, activeTcpConnections: 0, activeHttpRequests: 0, activeUpgradeConnections: 0 },
          },
        };
  };
  await assert.rejects(
    () => executeHostProtectedRecovery({
      descriptor: fixture.descriptor,
      allowedRoot: fixture.root,
      run,
      health,
      sleep: async () => {},
      now: () => new Date(Date.parse(fixture.descriptor.operation.authorizationExpiresAt) + 1_000),
    }),
    (error) => error.code === 'HOST_RECOVERY_AUTHORIZATION_EXPIRED',
  );
  assert.equal(createOrStartCount, 0);
  assert.deepEqual(await readFile(fixture.files.maintenanceFenceFile), originalFence);
});

test('an ambiguous helper start with durable intent keeps maintenance closed and never retries', async (t) => {
  const fixture = await fixtureRoot();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const validated = validateHostRecoveryDescriptor(fixture.descriptor, { allowedRoot: fixture.root });
  const prepared = await prepareHostRecoveryInputs(validated);
  const definition = buildRecoveryContainerCreateArgs(fixture.descriptor, prepared);
  let helperInspectionCount = 0;
  let startCount = 0;
  const run = async (program, args) => {
    assert.equal(program, 'docker');
    if (args[0] === 'image' && args[1] === 'inspect') {
      return { code: 0, stdout: JSON.stringify(recoveryHelperImageInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'run') {
      return { code: 0, stdout: JSON.stringify(recoveryHelperProbe(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.harnessContainerId) {
      return { code: 0, stdout: JSON.stringify(harnessInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === fixture.descriptor.target.brokerContainerId) {
      return { code: 0, stdout: JSON.stringify(brokerInspect(fixture.descriptor)), stderr: '' };
    }
    if (args[0] === 'inspect' && args[1] === definition.name) return { code: 1, stdout: '', stderr: 'not found' };
    if (args[0] === 'create') return { code: 0, stdout: `${helperId}\n`, stderr: '' };
    if (args[0] === 'inspect' && args[1] === helperId) {
      helperInspectionCount += 1;
      const inspected = helperInspect(fixture.descriptor, prepared, definition);
      if (helperInspectionCount > 1) {
        inspected[0].State = {
          Status: 'running', Running: true, Paused: false, Restarting: false, Dead: false,
        };
      }
      return { code: 0, stdout: JSON.stringify(inspected), stderr: '' };
    }
    if (args[0] === 'start') {
      startCount += 1;
      await writeFile(
        path.join(fixture.evidence, `submission-intent-${operationId}.json`),
        '{"intent":"durable"}\n',
      );
      return { code: null, signal: 'SIGKILL', timedOut: true, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected docker call: ${args.join(' ')}`);
  };
  const health = async () => {
    const fence = JSON.parse(await readFile(fixture.files.maintenanceFenceFile, 'utf8'));
    return fence.state === 'committed'
      ? { status: 200, body: { ok: true, status: 'open', epoch: fence.epoch } }
      : {
          status: 503,
          body: {
            ok: false, status: 'maintenance', code: 'TASKSPACE_MAINTENANCE', epoch: fence.epoch,
            drain: { mode: 'connection-tracked', drained: true, activeTcpConnections: 0, activeHttpRequests: 0, activeUpgradeConnections: 0 },
          },
        };
  };
  await assert.rejects(
    () => executeHostProtectedRecovery({
      descriptor: fixture.descriptor,
      allowedRoot: fixture.root,
      run,
      health,
      sleep: async () => {},
    }),
    (error) => error.code === 'HOST_RECOVERY_RESULT_AMBIGUOUS',
  );
  assert.equal(startCount, 1);
  const fence = JSON.parse(await readFile(fixture.files.maintenanceFenceFile, 'utf8'));
  assert.equal(fence.state, 'maintenance');
  assert.equal(fence.epoch, `recovery-${operationId}`);
  const journal = JSON.parse(await readFile(path.join(fixture.evidence, 'host-recovery-journal.json'), 'utf8'));
  assert.equal(journal.state, 'ambiguous-no-resend');
  assert.equal(journal.originalFenceRestored, false);
});
