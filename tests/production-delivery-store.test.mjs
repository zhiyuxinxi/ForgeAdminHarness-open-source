import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProductionDeliveryStore } from '../docker/harness/production-delivery-store.mjs';
import { createProductionDeliveryServer } from '../docker/harness/production-delivery-service.mjs';
import { deliverySnapshotDigest } from '../docker/harness/delivery-center-projection.mjs';

const hash = content => createHash('sha256').update(content).digest('hex');
const project = 'example-project';
const otherProject = 'other-project';
const actor = 'test-release-reviewer';
const exportActor = { id: 'fixture-user-1', username: 'fixture-reviewer', displayName: '平台夹具操作人' };
const delivery = { recipient: '平台夹具接收方', projectName: '平台夹具交付项目', purpose: '仅验证生产导出合同，不代表客户上线' };
const image = `sha256:${'a'.repeat(64)}`;
const commit = 'b'.repeat(40);
const key = prefix => `${prefix}-request-key`;
const expectCode = code => error => error.code === code;

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'production-store-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer((_request, response) => { response.writeHead(200); response.end('fixture-only'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const sourceRoot = path.join(root, 'source');
  await mkdir(sourceRoot);
  const auditPath = path.join(sourceRoot, 'release-audit.jsonl');
  await writeFile(auditPath, [
    { status: 'failed', commit: 'c'.repeat(40), version: 'failed-version', images: { 'forge-ui': image } },
    { type: 'controlled-release', status: 'success', jobId: 'historic-job', commit, version: 'tested-version', services: ['forge-ui'],
      images: { 'forge-ui': { id: image, image: 'fixture.invalid/forge-ui:tested' } }, finishedAt: '2026-10-14T01:00:00Z' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const config = {
    archiveRoot: path.join(root, 'archive'), backupRoot: path.join(root, 'backup'),
    environmentRoot: path.join(root, 'environments'), workerPath: path.join(root, 'test-worker.py'),
    bindHost: '127.0.0.1', publicHost: 'validation.example.invalid', portStart: 23000, portEnd: 23010,
    projects: Object.fromEntries([project, otherProject].map(name => [name, {
      projectRoot: sourceRoot, auditPath, architectures: ['amd64'],
      recipe: { application: { services: [{ name: 'forge-ui' }] } },
    }])),
  };
  const launches = [];
  const launch = async request => {
    launches.push(request);
    if (request.action === 'stop') {
      if (options.stop) return options.stop(request);
      return { status: 'success', stopAttemptId: request.stopAttemptId, environment: { id: request.jobId, url, status: 'stopped' } };
    }
    if (options.validate) return options.validate(request);
    // Bytes are deliberately only module-test fixtures, never business delivery evidence.
    const names = { bundle: 'fixture-bundle.txt', sql: 'fixture-sql.txt', 'deployment-guide': 'fixture-deployment.txt',
      'operation-guide': 'fixture-operation.txt', manifest: 'fixture-manifest.json', verification: 'fixture-verification.json' };
    const artifacts = [];
    for (const [artifactKey, name] of Object.entries(names)) {
      const bytes = Buffer.from(`module-fixture:${artifactKey}`);
      await writeFile(path.join(request.jobRoot, name), bytes);
      artifacts.push({ key: artifactKey, name, relativePath: name, size: bytes.length, sha256: hash(bytes) });
    }
    const baselineRoot = path.join(request.jobRoot, 'private-baseline');
    await mkdir(baselineRoot);
    const baselineBytes = Buffer.from('private-module-fixture');
    const baselineFiles=[];
    for(const name of ['database.sql','redis.rdb','files.tar','secrets.tar']){await writeFile(path.join(baselineRoot,name),baselineBytes);baselineFiles.push({name,size:baselineBytes.length,sha256:hash(baselineBytes)});}
    const manifestSha256 = artifacts.find(item => item.key === 'manifest').sha256;
    return { status: 'success', manifestSha256, artifacts,
      environment: { id: request.jobId, url, status: 'running' },
      validation: { status: 'passed', checks: ['module-fixture'], limitations: ['No business installation or upgrade was executed.'] },
      baseline: { manifestSha256, jobRoot: request.jobRoot, path: 'private-baseline',
        files: baselineFiles },
    };
  };
  const store = new ProductionDeliveryStore(config, { launch,probe:async()=>{const response=await fetch(url);await response.body.cancel();return response.status===200;} });
  await store.initialize();
  return { root, config, store, launches };
}

async function release(f, requestKey = key('release'), targetProject = project) {
  const [candidate] = await f.store.candidates(targetProject);
  return (await f.store.createRelease({ project: targetProject, candidateId: candidate.id, title: 'Module test release', idempotencyKey: requestKey }, actor)).item;
}

async function job(f, releaseId, overrides = {}) {
  const created = await f.store.createJob(releaseId, { project, mode: 'initial', architecture: 'amd64', idempotencyKey: key('job'), ...overrides }, actor);
  await f.store.pending.get(created.item.id);
  return (await f.store.getJob(project, created.item.id)).item;
}

async function accept(f, item) {
  return (await f.store.accept(item.id, { project, decision: 'accepted', notes: 'Module-test human decision fixture', expectedManifestSha256: item.manifestSha256 }, actor)).item;
}

async function exportBody(f, overrides = {}) {
  const selected = (await f.store.candidates(overrides.project ?? project))[0];
  return { project, candidateId: selected.id, sourceArtifactId: selected.sourceArtifacts[0].id,
    mode: 'initial', architecture: 'amd64', delivery, idempotencyKey: key('export'), ...overrides };
}

async function exported(f, body) {
  const result = await f.store.createExport(body, exportActor);
  await f.store.pending.get(result.item.id);
  return (await f.store.getJob(body.project, result.item.id)).item;
}

test('production releases are explicitly selected, immutable, backed up, and idempotent under concurrent requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.candidates(project)).length, 1);
  assert.deepEqual((await f.store.listReleases(project)).items, []);
  const [first, duplicate] = await Promise.all([release(f), release(f)]);
  assert.equal(first.id, duplicate.id);
  assert.equal((await f.store.listReleases(project)).items.length, 1);
  assert.equal(f.launches.length, 0, 'selecting a release does not silently start validation');
  const original = await readFile(f.store.recordPath(project, 'releases', first.id));
  assert.deepEqual(await readFile(path.join(f.config.backupRoot, project, 'releases', first.id, 'record.json')), original);
  const candidate = (await f.store.candidates(project))[0];
  await assert.rejects(f.store.createRelease({ project, candidateId: candidate.id, title: 'Different payload', idempotencyKey: key('release') }, actor), expectCode('PRODUCTION_REQUEST_CONFLICT'));
  assert.deepEqual(await readFile(f.store.recordPath(project, 'releases', first.id)), original);
});

test('duplicate validation requests launch once and downloads require a matching human acceptance', async t => {
  const f = await fixture(t);
  const selected = await release(f);
  const body = { project, mode: 'initial', architecture: 'amd64', idempotencyKey: key('job') };
  const [first, second] = await Promise.all([f.store.createJob(selected.id, body, actor), f.store.createJob(selected.id, body, actor)]);
  assert.equal(first.item.id, second.item.id);
  await f.store.pending.get(first.item.id);
  const completed = (await f.store.getJob(project, first.item.id)).item;
  assert.equal(f.launches.length, 1);
  assert.equal(completed.status, 'awaiting-acceptance');
  assert.equal(completed.acceptance, null);
  assert.equal('baseline' in completed, false, 'private database baseline stays out of public records');
  assert.equal(completed.artifacts.some(item => 'relativePath' in item), false);
  await assert.rejects(f.store.download(project, completed.id, 'bundle'), expectCode('PRODUCTION_NOT_ACCEPTED'));
  await assert.rejects(f.store.accept(completed.id, { project, decision: 'accepted', notes: 'wrong material', expectedManifestSha256: '0'.repeat(64) }, actor), expectCode('PRODUCTION_ACCEPTANCE_CONFLICT'));
  assert.equal((await accept(f, completed)).status, 'ready');
  const download = await f.store.download(project, completed.id, 'bundle');
  assert.equal(hash(await readFile(download.file)), download.sha256);
  await assert.rejects(f.store.download(project, completed.id, 'private-baseline'), expectCode('PRODUCTION_NOT_FOUND'));
});

test('accepted downloads reject same-length artifact changes', async t => {
  const f = await fixture(t);
  const completed = await job(f, (await release(f)).id);
  await accept(f, completed);
  const original = await f.store.download(project, completed.id, 'bundle');
  const bytes = await readFile(original.file);
  bytes[0] ^= 1;
  await writeFile(original.file, bytes);
  await assert.rejects(f.store.download(project, completed.id, 'bundle'), expectCode('PRODUCTION_MATERIAL_CHANGED'));
});

test('an unavailable validation environment cannot be accepted but can receive an honest rejection', async t => {
  const f=await fixture(t);const completed=await job(f,(await release(f)).id);
  f.store.probe=async()=>false;
  await assert.rejects(accept(f,completed),expectCode('PRODUCTION_ENVIRONMENT_UNAVAILABLE'));
  assert.equal((await f.store.getJob(project,completed.id)).item.status,'awaiting-acceptance');
  const rejected=await f.store.accept(completed.id,{project,decision:'rejected',notes:'Environment is unavailable',expectedManifestSha256:completed.manifestSha256},actor);
  assert.equal(rejected.item.status,'rejected');
});

test('cross-project records, unsupported architecture, and unaccepted upgrade baselines are rejected', async t => {
  const f = await fixture(t);
  const selected = await release(f);
  await assert.rejects(f.store.releaseDetail(otherProject, selected.id), expectCode('PRODUCTION_NOT_FOUND'));
  await assert.rejects(f.store.createJob(selected.id, { project, mode: 'initial', architecture: 'arm64', idempotencyKey: key('arm') }, actor), expectCode('PRODUCTION_ARCHITECTURE_UNAVAILABLE'));
  const completed = await job(f, selected.id);
  await assert.rejects(f.store.createJob(selected.id, { project, mode: 'upgrade', architecture: 'amd64', baseJobId: completed.id, idempotencyKey: key('unaccepted') }, actor), expectCode('PRODUCTION_BASELINE_UNAVAILABLE'));
  await accept(f, completed);
  const other = await release(f, key('other-release'), otherProject);
  await assert.rejects(f.store.createJob(other.id, { project: otherProject, mode: 'upgrade', architecture: 'amd64', baseJobId: completed.id, idempotencyKey: key('cross-project') }, actor), expectCode('PRODUCTION_NOT_FOUND'));
  await assert.rejects(f.store.createJob(selected.id, { project, mode: 'initial', architecture: 'amd64', baseJobId: completed.id, idempotencyKey: key('wrong-mode') }, actor), expectCode('PRODUCTION_INVALID_INPUT'));
});

test('failed workers retain a failed record and cannot expose a production download', async t => {
  const f = await fixture(t, { validate: async () => { throw new Error('fixture worker failed'); } });
  const completed = await job(f, (await release(f)).id);
  assert.equal(completed.status, 'failed');
  assert.equal(completed.acceptance, null);
  assert.equal(completed.error.code, 'PRODUCTION_VALIDATION_FAILED');
  await access(path.join(f.config.backupRoot, project, 'jobs', completed.id, 'failure.json'));
  await assert.rejects(f.store.download(project, completed.id, 'bundle'), expectCode('PRODUCTION_NOT_ACCEPTED'));
});

test('an explicit stop retries after a worker failure while preserving archived material', async t => {
  let attempts = 0;
  const f = await fixture(t, { stop: async request => {
    if (++attempts === 1) throw new Error('fixture temporary stop failure');
    return { status: 'success', stopAttemptId: request.stopAttemptId };
  } });
  const completed = await job(f, (await release(f)).id);
  await assert.rejects(f.store.stop(completed.id, { project }, actor), expectCode('PRODUCTION_ENVIRONMENT_IN_USE'));
  await accept(f, completed);
  const artifact = await f.store.download(project, completed.id, 'bundle');
  const before = await readFile(artifact.file);
  await assert.rejects(f.store.stop(completed.id, { project }, actor), /temporary stop failure/);
  const [stopped, duplicate] = await Promise.all([f.store.stop(completed.id, { project }, actor), f.store.stop(completed.id, { project }, actor)]);
  assert.equal(stopped.item.environment.status, 'stopped');
  assert.equal(duplicate.item.environmentStoppedAt, stopped.item.environmentStoppedAt);
  assert.equal(attempts, 2);
  const attemptsRoot = path.join(path.dirname(f.store.recordPath(project, 'jobs', completed.id)), 'stop-attempts');
  const preserved = await Promise.all((await readdir(attemptsRoot)).map(async id => JSON.parse(await readFile(path.join(attemptsRoot, id, 'result.json'), 'utf8'))));
  assert.deepEqual(preserved.map(result => result.status).sort(), ['failed', 'success']);
  assert.deepEqual(await readFile(artifact.file), before);
  assert.deepEqual(await readFile(path.join(f.config.backupRoot, project, 'jobs', completed.id, 'materials', path.basename(artifact.file))), before);
});

test('completion archival failure never exposes a job for human acceptance', async t => {
  const f = await fixture(t);
  const selected = await release(f);
  const backupTree = f.store.backupTree.bind(f.store);
  f.store.backupTree = async (...args) => {
    await backupTree(...args);
    // Simulate a concrete destination write failure after material copying.
    await mkdir(path.join(f.config.backupRoot, args[0], 'jobs', args[1], 'validation-completed.json'));
  };
  const atomicRecord = f.store.record.bind(f.store);
  const observed = [];
  f.store.record = async (...args) => {
    const row = await atomicRecord(...args);
    if (args[1] === 'jobs') observed.push(row.status);
    return row;
  };
  const completed = await job(f, selected.id);
  assert.equal(completed.status, 'failed');
  assert.equal(observed.includes('awaiting-acceptance'), false);
  await assert.rejects(accept(f, completed), expectCode('PRODUCTION_ACCEPTANCE_CONFLICT'));
});

test('worker requests preserve the environment root and configured public host', async t => {
  const f = await fixture(t);
  const completed = await job(f, (await release(f)).id);
  assert.equal(completed.status, 'awaiting-acceptance');
  assert.equal(f.launches[0].environmentRoot, f.config.environmentRoot);
  assert.equal(f.launches[0].publicHost, f.config.publicHost);
});

test('release list and details show live worker progress without rewriting job history or replacing a terminal failure', async t => {
  let finish;
  const running = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { validate: async () => { await running; throw new Error('Module fixture terminal failure'); } });
  const selected = await release(f);
  const { item: created } = await f.store.createJob(selected.id, {
    project, mode: 'initial', architecture: 'amd64', idempotencyKey: key('live-job'),
  }, actor);
  const pending = f.store.pending.get(created.id);
  try {
    const recordPath = f.store.recordPath(project, 'jobs', created.id);
    const original = await readFile(recordPath);
    await writeFile(path.join(path.dirname(recordPath), 'progress.json'), JSON.stringify({
      status: 'upgrading', stages: [{ name: 'empty-environment-installation' }],
      environment: { id: created.id, status: 'upgrading' },
    }));
    const detail = await f.store.releaseDetail(project, selected.id);
    const list = await f.store.listReleases(project);
    assert.equal(detail.jobs[0].status, 'upgrading');
    assert.equal(list.items[0].jobs[0].status, 'upgrading');
    assert.deepEqual(detail.jobs[0].stages, [{ name: 'empty-environment-installation' }]);
    assert.deepEqual(await readFile(recordPath), original);
  } finally {
    finish();
    await pending;
  }
  assert.equal((await f.store.releaseDetail(project, selected.id)).jobs[0].status, 'failed');
  assert.equal((await f.store.listReleases(project)).items[0].jobs[0].status, 'failed');
});

test('manual deployment history retains database and application outcomes independently', async t => {
  const f = await fixture(t);
  const selected = await release(f);
  const completed = await job(f, selected.id);
  await accept(f, completed);
  const target = (await f.store.createTarget({ project, name: 'Customer production', idempotencyKey: key('target') }, actor)).item;
  const body = { project, targetId: target.id, releaseId: selected.id, jobId: completed.id,
    occurredAt: '2026-10-14T09:00:00+08:00', databaseStatus: 'success', applicationStatus: 'failed',
    notes: 'Actual partial outcome fixture', idempotencyKey: key('deployment') };
  const first = (await f.store.deployment(body, actor)).item;
  const duplicate = (await f.store.deployment(body, actor)).item;
  assert.equal(first.id, duplicate.id);
  assert.equal(first.databaseStatus, 'success');
  assert.equal(first.applicationStatus, 'failed');
  assert.equal(first.source, 'manual');
  assert.equal(first.createdBy, actor);
  assert.equal((await f.store.releaseDetail(project, selected.id)).deployments.length, 1);
  assert.equal((await readdir(path.join(f.config.archiveRoot, project, 'deployments'))).length, 1);
  await assert.rejects(f.store.deployment({ ...body, actor: 'forged-actor' }, actor), expectCode('PRODUCTION_INVALID_INPUT'));
});

test('single export binds the exact center artifact, trusted actor and purpose in job request and backups', async t => {
  const f = await fixture(t); const body = await exportBody(f);
  const [candidate] = await f.store.candidates(project);
  assert.equal(candidate.sourceReleaseJobId, 'historic-job');
  assert.equal(body.sourceArtifactId, `artifact-${deliverySnapshotDigest([project, 'historic-job', 'forge-ui', image]).slice(0, 32)}`);
  const [first, duplicate] = await Promise.all([f.store.createExport(body, exportActor), f.store.createExport(body, exportActor)]);
  assert.equal(first.item.id, duplicate.item.id); assert.equal(first.release.id, duplicate.release.id);
  assert.equal('source' in first.release, false);
  await f.store.pending.get(first.item.id);
  const completed = (await f.store.getJob(project, first.item.id)).item;
  assert.deepEqual(completed.createdBy, exportActor); assert.deepEqual(completed.delivery, delivery);
  assert.deepEqual(completed.sourceArtifact, candidate.sourceArtifacts[0]); assert.equal(completed.sourceCandidateId, candidate.id);
  assert.equal(completed.baselineAvailable, true); assert.equal('baseline' in completed, false);
  const root = path.dirname(f.store.recordPath(project, 'jobs', completed.id));
  const backup = path.join(f.config.backupRoot, project, 'jobs', completed.id);
  for (const file of ['record.json', 'request.json']) {
    const saved = JSON.parse(await readFile(path.join(root, file), 'utf8'));
    const preserved = JSON.parse(await readFile(path.join(backup, file), 'utf8'));
    for (const item of [saved, preserved]) {
      assert.deepEqual(item.createdBy, exportActor); assert.deepEqual(item.delivery, delivery);
      assert.equal(item.sourceArtifact.id, body.sourceArtifactId); assert.equal(item.sourceCandidateId, body.candidateId);
      assert.equal(item.createdAt, completed.createdAt);
    }
  }
  assert.equal(f.launches.filter(item => item.action === 'validate').length, 1);
  await assert.rejects(f.store.createExport(body, { ...exportActor, id: 'different-user' }), expectCode('PRODUCTION_REQUEST_CONFLICT'));
  assert.equal((await f.store.listJobs(project)).items[0].id, completed.id);
  assert.equal((await f.store.listReleases(project)).items[0].jobs[0].id, completed.id);
});

test('export rejects mismatched artifact rows and forged metadata before writing a release or job', async t => {
  const f = await fixture(t); const body = await exportBody(f);
  const audit = f.config.projects[project].auditPath;
  const rows = (await readFile(audit, 'utf8')).trim().split('\n').map(JSON.parse);
  rows.push({ ...rows[1], jobId: 'second-historic-job' });
  await writeFile(audit, rows.map(JSON.stringify).join('\n') + '\n');
  const [second] = await f.store.candidates(project);
  await assert.rejects(f.store.createExport({ ...body, candidateId: second.id }, exportActor), expectCode('PRODUCTION_SOURCE_ARTIFACT_MISMATCH'));
  await assert.rejects(f.store.createExport({ ...body, project: otherProject }, exportActor), expectCode('PRODUCTION_CANDIDATE_NOT_FOUND'));
  await assert.rejects(f.store.createExport({ ...body, actor: { id: 'forged' } }, exportActor), expectCode('PRODUCTION_INVALID_INPUT'));
  await assert.rejects(f.store.createExport({ ...body, createdAt: '2000-01-01' }, exportActor), expectCode('PRODUCTION_INVALID_INPUT'));
  await assert.rejects(f.store.createExport({ ...body, delivery: { ...delivery, actor: 'forged' } }, exportActor), expectCode('PRODUCTION_INVALID_INPUT'));
  await assert.rejects(f.store.createExport({ ...body, delivery: { ...delivery, purpose: '' } }, exportActor), expectCode('PRODUCTION_INVALID_INPUT'));
  await assert.rejects(f.store.createExport({ ...body, mode: 'upgrade' }, exportActor), expectCode('PRODUCTION_BASELINE_UNAVAILABLE'));
  assert.deepEqual(await f.store.records(project, 'releases'), []); assert.deepEqual(await f.store.records(project, 'jobs'), []);
  assert.equal(f.launches.length, 0);
});

test('separate full exports retain their dates and any qualified full can be an upgrade base', async t => {
  const f = await fixture(t); const body = await exportBody(f);
  const full = [];
  for (const [index, date] of ['2026-01-01T00:00:00Z', '2026-10-01T00:00:00Z'].entries()) {
    f.store.clock = () => date;
    const item = await exported(f, { ...body, idempotencyKey: key(`full-${index}`) });
    await accept(f, item); await f.store.stop(item.id, { project }, exportActor); full.push(item);
  }
  assert.notEqual(full[0].id, full[1].id); assert.notEqual(full[0].createdAt, full[1].createdAt);
  const oldRoot = path.dirname(f.store.recordPath(project, 'jobs', full[0].id));
  const original = await readFile(path.join(oldRoot, 'request.json'));
  f.store.clock = () => '2026-10-15T00:00:00Z';
  const upgrade = await exported(f, { ...body, mode: 'upgrade', baseJobId: full[0].id, idempotencyKey: key('upgrade-old-full') });
  assert.equal(upgrade.baseJobId, full[0].id); assert.equal(upgrade.mode, 'upgrade');
  assert.equal(f.launches.filter(item => item.action === 'validate').at(-1).base.jobRoot, oldRoot);
  assert.deepEqual(await readFile(path.join(oldRoot, 'request.json')), original);
  await accept(f, upgrade); await f.store.stop(upgrade.id, { project }, exportActor);
  const count = (await f.store.records(project, 'releases')).length;
  await assert.rejects(f.store.createExport({ ...body, mode: 'upgrade', baseJobId: upgrade.id, idempotencyKey: key('reject-incremental-base') }, exportActor), expectCode('PRODUCTION_BASELINE_UNAVAILABLE'));
  assert.equal((await f.store.records(project, 'releases')).length, count);
  const latest = await exported(f, { ...body, mode: 'upgrade', baseJobId: full[1].id, idempotencyKey: key('upgrade-new-full') });
  assert.equal(latest.baseJobId, full[1].id);
});

test('one UAT slot is atomic across projects and occupied environments are never automatically stopped', async t => {
  const f = await fixture(t);
  const firstBody = await exportBody(f), secondBody = await exportBody(f, { project: otherProject, idempotencyKey: key('other-export') });
  const results = await Promise.allSettled([f.store.createExport(firstBody, exportActor), f.store.createExport(secondBody, exportActor)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'PRODUCTION_UAT_BUSY');
  const winner = results.find(item => item.status === 'fulfilled').value.item;
  await f.store.pending.get(winner.id);
  const loserProject = winner.project === project ? otherProject : project;
  const capacity = await f.store.capacity(loserProject);
  assert.deepEqual(capacity, { limit: 1, occupied: 1, available: 0, items: [] });
  const own = await f.store.capacity(winner.project);
  assert.equal(own.items[0].jobId, winner.id); assert.equal(own.items[0].releaseId, winner.releaseId);
  assert.equal((await f.store.records(loserProject, 'releases')).length, 0);
  assert.equal(f.launches.filter(item => item.action === 'stop').length, 0);
});

test('a legacy ready environment keeps its UAT slot and old jobs expose missing metadata honestly', async t => {
  const f = await fixture(t); const selected = await release(f); const completed = await job(f, selected.id); await accept(f, completed);
  const recordPath = f.store.recordPath(project, 'jobs', completed.id);
  const old = JSON.parse(await readFile(recordPath, 'utf8'));
  for (const key of ['createdBy', 'delivery', 'sourceArtifact', 'sourceCandidateId']) delete old[key];
  await writeFile(recordPath, JSON.stringify(old)); const oldBytes = await readFile(recordPath);
  const legacy = (await f.store.getJob(project, completed.id)).item;
  for (const key of ['createdBy', 'delivery', 'sourceArtifact', 'sourceCandidateId']) assert.equal(legacy[key], null);
  assert.equal((await f.store.capacity(project)).occupied, 1);
  await assert.rejects(f.store.createExport(await exportBody(f), exportActor), expectCode('PRODUCTION_UAT_BUSY'));
  await assert.rejects(f.store.createJob(selected.id, { project, mode: 'initial', architecture: 'amd64', idempotencyKey: key('legacy-second-job') }, actor), expectCode('PRODUCTION_UAT_BUSY'));
  assert.deepEqual(await readFile(recordPath), oldBytes); assert.equal(f.launches.filter(item => item.action === 'stop').length, 0);
  await f.store.stop(completed.id, { project }, exportActor);
  assert.equal((await f.store.capacity(project)).available, 1);
  const next = await exported(f, await exportBody(f)); assert.notEqual(next.id, completed.id);
});

test('failed exports retain their original request, metadata and failure backup', async t => {
  const f = await fixture(t, { validate: async () => { throw new Error('fixture export failure'); } });
  const body = await exportBody(f); const failed = await exported(f, body);
  assert.equal(failed.status, 'failed'); assert.deepEqual(failed.delivery, delivery); assert.deepEqual(failed.createdBy, exportActor);
  assert.equal(failed.environment, null); assert.equal(failed.environmentSlotOccupied, true);
  assert.equal((await f.store.capacity(project)).occupied, 1);
  const root = path.dirname(f.store.recordPath(project, 'jobs', failed.id));
  const request = await readFile(path.join(root, 'request.json'));
  await f.store.createExport(body, exportActor);
  assert.equal(f.launches.length, 1); assert.deepEqual(await readFile(path.join(root, 'request.json')), request);
  const backup = JSON.parse(await readFile(path.join(f.config.backupRoot, project, 'jobs', failed.id, 'failure.json'), 'utf8'));
  assert.equal(backup.status, 'failed'); assert.deepEqual(backup.delivery, delivery); assert.equal(backup.sourceArtifact.id, body.sourceArtifactId);
  const stopped = await f.store.stop(failed.id, { project }, exportActor);
  assert.equal(stopped.item.environmentSlotOccupied, false); assert.equal((await f.store.capacity(project)).available, 1);
  assert.deepEqual(await readFile(path.join(root, 'request.json')), request);
});

test('production service routes single exports capacity and job lists while preserving release routes', async t => {
  const f = await fixture(t); const server = createProductionDeliveryServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const prefix = `http://127.0.0.1:${server.address().port}/forge-gateway/api/production/`;
  const body = await exportBody(f);
  const unauthorized = await fetch(prefix + 'exports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(unauthorized.status, 403); await unauthorized.arrayBuffer();
  assert.deepEqual(await (await fetch(prefix + 'capacity?project=' + project)).json(), { limit: 1, occupied: 0, available: 1, items: [] });
  const response = await fetch(prefix + 'exports', { method: 'POST', headers: { 'content-type': 'application/json', 'x-production-actor': Buffer.from(JSON.stringify(exportActor)).toString('base64url') }, body: JSON.stringify(body) });
  assert.equal(response.status, 200); const result = await response.json(); await f.store.pending.get(result.item.id);
  assert.deepEqual(result.item.createdBy, exportActor);
  assert.equal((await (await fetch(prefix + 'jobs?project=' + project)).json()).items[0].id, result.item.id);
  assert.equal((await (await fetch(prefix + 'releases?project=' + project)).json()).items[0].jobs[0].id, result.item.id);
});
