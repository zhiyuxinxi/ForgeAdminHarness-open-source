import { createHash } from 'node:crypto';
import path from 'node:path';
import { deliveryCenterMetadata } from './delivery-center-semantics.mjs';
import { sanitizeDeliveryDetail } from './delivery-center-asset-projection.mjs';

const TASK = /^[a-z0-9][a-z0-9-]{1,47}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const documentPath = value => typeof value === 'string' && value.length <= 512
  && value.startsWith('code-copilot/changes/') && value.endsWith('.md')
  && !/[\\\u0000-\u001f]/u.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');

/** Read only successful Broker checkpoint receipts, never TaskSpace worktrees.
 * `read` is the collector's existing no-symlink, byte-bounded stable reader. */
export async function collectCheckpointDeliveryDocuments({ projectSlug, phaseRoot, audits, read, taskIdFilter }) {
  const documents = []; const batches = []; const gaps = []; const seen = new Map();
  const deadline = Date.now() + 45000;
  const eligible = audits.filter(audit => audit?.type === 'taskspace-checkpoint' && audit.action === 'checkpoint'
    && audit.status === 'success' && audit.checkpointStatus === 'checkpointed'
    && audit.deliveryCenterDocuments && (!taskIdFilter || audit.taskId === taskIdFilter));
  if (eligible.length > 2000) fail('CHECKPOINT_DOCUMENT_COUNT_LIMIT');
  for (const audit of eligible) {
    if (Date.now() > deadline) fail('CHECKPOINT_DOCUMENT_SCAN_LIMIT');
    const capture = audit.deliveryCenterDocuments;
    if (capture.status === 'not-applicable') continue;
    if (capture.status === 'failed') {
      const sourceCorrection = capture.code === 'COMMITTED_DOCUMENT_INVALID_JSON';
      const sourcePath = documentPath(capture.path) && Array.isArray(audit.changedPaths) && audit.changedPaths.includes(capture.path) ? capture.path : null;
      const fenceLine = sourcePath && Number.isSafeInteger(capture.fenceLine) && capture.fenceLine > 0 ? capture.fenceLine : null;
      const reason = ['invalid-json', 'invalid-metadata', 'unterminated-fence'].includes(capture.reason) ? capture.reason : null;
      gaps.push({ code: 'CHECKPOINT_DOCUMENT_CAPTURE_FAILED', label: '工作舱已提交，但过程文档采集失败，尚未收录',
        taskId: audit.taskId, sourceCommit: audit.commit, captureCode: typeof capture.code === 'string' ? capture.code : null,
        sourcePath, fenceLine, line: fenceLine && capture.line === fenceLine + 1 ? capture.line : null, reason,
        recordIndex: reason === 'invalid-metadata' && Number.isSafeInteger(capture.recordIndex) && capture.recordIndex >= 0 ? capture.recordIndex : null,
        recovery: sourceCorrection ? 'source-correction-required' : 'cause-resolution-required',
        recoveryMessage: sourceCorrection
          ? '请在原对话核对该提交的文档定义；修正后正常提交。原失败提交保留，重复采集不会修正文档。'
          : '先核查采集失败原因及环境变化；该记录不代表已恢复，不自动重复采集。' });
      continue;
    }
    if (capture.status !== 'captured') fail('CHECKPOINT_DOCUMENT_ARTIFACT_INVALID');
    const transition = audit.sourceTransition;
    const { digest: transitionDigest, ...transitionPayload } = object(transition) ? transition : {};
    if (!phaseRoot || !TASK.test(audit.taskId ?? '') || !COMMIT.test(audit.commit ?? '') || !COMMIT.test(audit.tree ?? '')
      || audit.operation !== 'checkpoint' || transition?.schemaVersion !== 1 || transition.phase !== 'checkpointed'
      || transition.digestAlgorithm !== 'sha256' || transition.digestEncoding !== 'canonical-json-v1'
      || !SHA.test(transitionDigest ?? '') || transitionDigest !== hash(transitionPayload)
      || transition.operationId !== audit.operationId || transition.task?.projectSlug !== projectSlug
      || transition.task?.taskId !== audit.taskId || transition.task?.conversationId !== audit.conversationId
      || !ID.test(transition.task?.conversationId ?? '') || !ID.test(transition.task?.dshSessionId ?? '')
      || transition.to?.head !== audit.commit || capture.sourceCommit !== audit.commit
      || !SHA.test(capture.sha256 ?? '') || !Number.isSafeInteger(capture.documentBlocks) || capture.documentBlocks < 1) {
      fail('CHECKPOINT_DOCUMENT_ARTIFACT_INVALID');
    }
    const relativePath = `.committed-documents/${audit.taskId}/${audit.commit}.json`;
    if (capture.relativePath !== relativePath) fail('CHECKPOINT_DOCUMENT_PATH_UNSAFE');
    const previous = seen.get(relativePath);
    if (previous && previous !== capture.sha256) fail('CHECKPOINT_DOCUMENT_SOURCE_CHANGED');
    if (previous) continue;
    seen.set(relativePath, capture.sha256);
    let bytes;
    try { bytes = await read(path.join(phaseRoot, relativePath)); }
    catch { fail('CHECKPOINT_DOCUMENT_UNAVAILABLE'); }
    if (Date.now() > deadline) fail('CHECKPOINT_DOCUMENT_SCAN_LIMIT');
    if (hash(bytes) !== capture.sha256) fail('CHECKPOINT_DOCUMENT_SOURCE_CHANGED');
    let envelope;
    try { envelope = JSON.parse(bytes.toString('utf8')); } catch { fail('CHECKPOINT_DOCUMENT_INVALID_JSON'); }
    if (envelope?.schemaVersion !== 'forge-delivery-checkpoint-documents/v1' || envelope.projectSlug !== projectSlug
      || envelope.taskId !== audit.taskId || envelope.conversationId !== transition.task.conversationId
      || envelope.dshSessionId !== transition.task.dshSessionId || envelope.sourceCommit !== audit.commit
      || envelope.sourceTree !== audit.tree || envelope.sourceTransitionDigest !== transitionDigest
      || !date(envelope.capturedAt) || !Array.isArray(envelope.documents)
      || envelope.documents.length !== capture.documentBlocks || documents.length + envelope.documents.length > 4096) {
      fail('CHECKPOINT_DOCUMENT_ARTIFACT_INVALID');
    }
    const batchId = `checkpoint-${hash([projectSlug, audit.taskId, audit.commit]).slice(0, 40)}`;
    const source = { sourceScope: 'taskspace-checkpoint', taskId: audit.taskId,
      conversationId: envelope.conversationId, dshSessionId: envelope.dshSessionId,
      sourceTransitionDigest: transitionDigest, sourceTree: envelope.sourceTree,
      envelopePath: relativePath, envelopeDigest: capture.sha256, batchId };
    const pointers = new Set();
    for (const document of envelope.documents) {
      const pointer = `${document?.path}:${document?.fenceLine}`;
      if (!object(document) || !documentPath(document.path) || !Array.isArray(audit.changedPaths)
        || !audit.changedPaths.includes(document.path) || document.commit !== audit.commit
        || !COMMIT.test(document.blob ?? '') || !SHA.test(document.contentDigest ?? '') || !date(document.committedAt)
        || !Number.isSafeInteger(document.line) || !Number.isSafeInteger(document.fenceLine)
        || document.fenceLine < 1 || document.line !== document.fenceLine + 1 || pointers.has(pointer)
        || !Array.isArray(document.records) || document.records.length > 10000
        || document.records.some(row => !object(row) || !deliveryCenterMetadata(row))) fail('CHECKPOINT_DOCUMENT_ARTIFACT_INVALID');
      pointers.add(pointer);
      documents.push({ path: document.path, blob: document.blob, commit: document.commit,
        committedAt: document.committedAt, contentDigest: document.contentDigest,
        line: document.line, fenceLine: document.fenceLine, records: document.records, ...source, isCurrent: false });
    }
    const named = envelope.documents.flatMap(document => document.records)
      .filter(row => ['function', 'requirement', 'menu'].includes(row.deliveryCenter.kind))
      .sort((a, b) => ['function', 'requirement', 'menu'].indexOf(a.deliveryCenter.kind)
        - ['function', 'requirement', 'menu'].indexOf(b.deliveryCenter.kind))
      .map(row => [row.name, row.title, row.label, row.resourceName].find(value => typeof value === 'string' && value.trim()))
      .filter(Boolean).map(value => sanitizeDeliveryDetail(value.trim()).slice(0, 48));
    const names = [...new Set(named)].slice(0, 2);
    batches.push({ id: batchId, taskId: audit.taskId, name: names.length ? `${names.join('、')} · 工作舱提交` : '工作舱过程提交',
      sourceLabel: '工作舱已提交的过程定义；集成、采用和发布分别依据原记录',
      status: 'documented', sourceScope: 'taskspace-checkpoint', createdAt: envelope.documents[0]?.committedAt ?? null,
      updatedAt: envelope.capturedAt, sessionId: envelope.dshSessionId, conversationId: envelope.conversationId,
      sourceCommit: audit.commit, sourceTree: audit.tree, sourceTransitionDigest: transitionDigest,
      isCurrent: false, acceptedArtifactDigests: {}, sources: [{ kind: 'taskspace-checkpoint', ...source, commit: audit.commit }] });
  }
  return { documents, batches, gaps, coverage: { source: 'broker-successful-checkpoint-documents',
    batches: batches.length, definitionBlocks: documents.length, includesUncommittedConversations: false,
    sourceScope: 'taskspace-checkpoint', isCurrent: false } };
}
