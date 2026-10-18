import http from 'node:http';

const STAGES = new Set([
  'preflight', 'candidate-validation', 'candidate-preflight', 'candidate-build',
  'candidate-prepared', 'candidate-unchanged', 'candidate-reused', 'promote-candidate', 'controlled-release',
  'test-database-orphan-cleanup', 'test-database-plan', 'test-database-snapshot',
  'test-database-restore', 'test-database-migration', 'publish-configuration',
  'application-deployment', 'application-smoke', 'application-rollback',
  'application-rollback-failed', 'application-rollback-verified', 'complete',
  'failed', 'runner-restart-recovery', 'checkpoint', 'integrate', 'unknown',
]);
const ERROR_HINTS = Object.freeze({
  TASKSPACE_DIRTY: '候选还有未保存的修改，请在原对话保存后重新预检。',
  TASKSPACE_REBASE_REQUIRED: '候选尚未包含最新集成版本，请在原对话先集成最新修改。',
  TASKSPACE_ACCEPTANCE_NOT_READY: '当前候选仍有必要验收项未通过，请在原对话查看缺项。',
  TASKSPACE_RELEASE_SOURCE_CHANGED: '验证过程中代码发生变化，请在原对话核对候选后重新预检。',
  TASKSPACE_RELEASE_AUTHORITY_STALE: '发布授权与当前候选不一致，请在原对话重新确认当前候选。',
  RELEASE_IN_PROGRESS: '已有发布正在执行，请等待其结束后重新预检；当前请求没有自动排队。',
});
const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.@-]{1,100}$/u.test(value) ? value : null;
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const stage = (value) => STAGES.has(value) ? value : 'unknown';
const terminal = (value) => ['success', 'failed', 'interrupted', 'prepared'].includes(value);

// A strict projection: never expose raw runner diagnostics, paths, approval text,
// conversation content, or deployment configuration to project members.
export function publicReleaseOperation(value, { status, action = 'release' } = {}) {
  if (!value) return null;
  const currentStatus = status ?? (terminal(value.status) || value.status === 'running' ? value.status : 'unknown');
  const currentAction = ['release', 'integrate', 'checkpoint'].includes(action) ? action : 'release';
  return {
    operationId: id(value.operationId ?? value.jobId),
    action: currentAction,
    status: currentStatus,
    stage: currentAction === 'release' ? stage(value.stage) : currentAction,
    failedStage: value.failedStage ? stage(value.failedStage) : null,
    taskId: id(value.taskId ?? value.provenance?.taskId),
    actorId: id(value.actorId ?? value.provenance?.actorId),
    commit: /^[a-f0-9]{40}$/u.test(value.commit ?? '') ? value.commit : null,
    version: typeof value.version === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value.version) ? value.version : null,
    services: Array.isArray(value.services) ? value.services.filter((item) => ['forge-admin', 'forge-ui', 'forge-app', 'forge-flow'].includes(item)) : [],
    ...(value.releaseApplied === false || value.result?.releaseApplied === false ? { releaseApplied: false, outcome: 'unchanged' } : {}),
    startedAt: date(value.startedAt ?? value.createdAt),
    updatedAt: date(value.updatedAt ?? value.completedAt ?? value.startedAt ?? value.createdAt),
    completedAt: date(value.completedAt),
    errorCode: Object.hasOwn(ERROR_HINTS, value.errorCode ?? value.error?.code ?? '') ? (value.errorCode ?? value.error.code) : null,
    errorSummary: currentStatus === 'failed'
      ? ERROR_HINTS[value.errorCode ?? value.error?.code] ?? '本次发布失败。请发起人在原对话查看对应发布的诊断，修复后重新预检。'
      : currentStatus === 'interrupted' ? '发布执行已中断，不能视为成功。请在原对话核对当前候选和运行状态。' : null,
  };
}

export function projectReleaseSnapshot({ projectSlug, active, lastRelease, lock, runner, now = new Date().toISOString() }) {
  const result = { schemaVersion: 1, projectSlug, observedAt: now, availability: 'ready', occupied: false, operation: null };
  if (active) {
    result.occupied = true;
    const saved = lastRelease?.operationId === active.operationId ? lastRelease : {};
    const current = { ...active, ...saved };
    const job = runner?.lastJob;
    const matches = active.action === 'release' && job?.provenance?.taskId === active.taskId
      && Date.parse(job.startedAt) >= Date.parse(active.startedAt)
      && (!saved.commit || job.commit === saved.commit || job.provenance.candidateCommit === saved.commit);
    if (matches) {
      Object.assign(current, {
        stage: job.stage, failedStage: job.failedStage, version: job.version,
        services: job.services, updatedAt: job.updatedAt, commit: job.commit ?? saved.commit,
      });
      // Candidate preparation is not the final deployment. Promotion has its
      // own stage even though the runner still holds the prepared job.
      if (['promote-candidate', 'controlled-release'].includes(saved.stage) && job.status === 'prepared') current.stage = saved.stage;
    }
    result.operation = publicReleaseOperation(current, { status: 'running', action: active.action });
    if (!runner && active.action === 'release') result.availability = 'partial';
    return result;
  }
  if (!runner) return { ...result, availability: 'unknown', occupied: null };
  if (runner.active === true) {
    return { ...result, occupied: true, operation: publicReleaseOperation(runner.lastJob, { status: 'running' }) };
  }
  if (lock) {
    // An owner file is not proof that its process is alive. Do not remove it
    // from this read-only endpoint or claim that an abandoned lock is progress.
    return { ...result, availability: 'unknown', occupied: true,
      operation: publicReleaseOperation(lock, { status: 'unknown', action: lock.action }) };
  }
  const job = runner.lastJob;
  const savedTime = Date.parse(lastRelease?.completedAt ?? lastRelease?.startedAt) || 0;
  const jobTime = Date.parse(job?.completedAt ?? job?.startedAt) || 0;
  const latest = jobTime > savedTime ? job : lastRelease ?? job;
  if (latest) {
    result.operation = publicReleaseOperation(latest, { status: latest.status === 'running' ? 'interrupted' : undefined });
    // Prefer the broker's final result for the same release over an older
    // runner stage, retaining the safe version/services fields when available.
    if (lastRelease?.runnerJobId && lastRelease.runnerJobId === job?.jobId) {
      result.operation = publicReleaseOperation({ ...job, ...lastRelease, stage: lastRelease.status === 'success' ? 'complete' : job.stage });
    }
  }
  return result;
}

export function createProjectReleaseStatusServer(readStatus, readMigrationFailure = null) {
  return http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'POST' && request.url === '/cross-layer-migration-failure' && readMigrationFailure) {
      try {
        if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new Error('JSON required');
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 4096) throw new Error('Failure observation request is too large');
          chunks.push(chunk);
        }
        const result = await readMigrationFailure(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.end(JSON.stringify({ ok: true, result }));
      } catch {
        response.writeHead(409);
        response.end('{"ok":false,"error":{"code":"CROSS_LAYER_MIGRATION_FAILURE_UNAVAILABLE","message":"No current protected migration failure matches this conversation."}}');
      }
      return;
    }
    if (request.method !== 'GET' || request.url !== '/status') {
      response.writeHead(404); response.end('{"ok":false}'); return;
    }
    try { response.end(JSON.stringify({ ok: true, status: await readStatus() })); }
    catch { response.writeHead(503); response.end('{"ok":false}'); }
  });
}

export function readProjectReleaseStatus(socketPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: '/status', method: 'GET' }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 32768) response.destroy(new Error('Project release status exceeded its limit.'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || value.ok !== true || value.status?.schemaVersion !== 1) throw new Error('Project release status is unavailable.');
          resolve(value.status);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Project release status timed out.')), timeoutMs);
    request.once('close', () => clearTimeout(timer));
    request.once('error', reject);
    request.end();
  });
}
