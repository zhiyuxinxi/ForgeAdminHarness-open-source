import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conversationFilePresentation,
  phaseWorkPackagePresentation,
} from '../docker/harness/output-file-presentation.mjs';

const documentNames = ['00-input.md', '01-result.md', '02-process.md', '03-verification.md', '04-handoff.md', '05-memory-candidate.md'];
const snapshot = { snapshotId: 'a'.repeat(64), createdAt: '2026-09-15T12:17:32.000Z', status: 'completed' };
function manifest(overrides = {}) {
  return {
    phaseId: 'database', phaseIndex: 2, decision: 'accepted',
    createdAt: snapshot.createdAt, packageDigest: 'b'.repeat(64),
    documents: documentNames.map((path, index) => ({ path, bytes: 100 + index, sha256: 'c'.repeat(64) })),
    ...overrides,
  };
}

test('phase documents get Chinese downloads while canonical names and sealed metadata stay unchanged', () => {
  const source = manifest();
  const original = structuredClone(source);
  const result = phaseWorkPackagePresentation(source);
  assert.equal(result.phaseLabel, '第03阶段 · 数据实现');
  assert.equal(result.versionLabel, '2026-09-15 20:17:32（北京时间） · 版本 bbbbbbbb');
  assert.deepEqual(result.files.map((file) => file.name), documentNames);
  assert.equal(result.files[1].downloadName, '03-数据实现_阶段结果_20260915-201732_bbbbbbbb.md');
  assert.deepEqual(result.files.filter((file) => file.primary).map((file) => file.name), ['01-result.md']);
  for (const [index, file] of result.files.entries()) {
    assert.equal(file.bytes, source.documents[index].bytes);
    assert.equal(file.sha256, source.documents[index].sha256);
    assert.equal(file.mediaType, 'text/markdown; charset=utf-8');
  }
  assert.match(result.files[1].usageLabel, /先看这份/u);
  assert.match(result.files[1].usageHint, /阶段已通过，阶段结果不表示已经部署/u);
  assert.match(result.files[5].usageLabel, /未确认/u);
  assert.deepEqual(source, original);
});

test('all eight phases have their existing Chinese names and one-based stage numbers', () => {
  const phases = [
    ['requirements', '需求澄清'], ['domain-contract', '领域与接口约定'], ['database', '数据实现'],
    ['ui-design', '页面交互设计'], ['backend', '后端实现'], ['frontend', '前端实现'],
    ['access-wiring', '权限接线'], ['cross-layer-acceptance', '跨层验收'],
  ];
  for (const [phaseIndex, [phaseId, label]] of phases.entries()) {
    const result = phaseWorkPackagePresentation(manifest({ phaseId, phaseIndex }));
    assert.equal(result.phaseLabel, `第${String(phaseIndex + 1).padStart(2, '0')}阶段 · ${label}`);
    assert.ok(result.files.every((file) => file.downloadName.includes(label)));
  }
});

test('blocked package stays unresolved without guessing a business decision or release success', () => {
  const result = phaseWorkPackagePresentation(manifest({ decision: 'blocked' }));
  assert.match(result.files[1].usageHint, /本阶段未通过/u);
  assert.doesNotMatch(JSON.stringify(result), /阶段已通过|业务待决定|部署已成功|已上线/u);
  assert.match(result.files[5].usageHint, /尚未确认/u);
});

test('conversation transcript is primary while data and manifest files retain their actual purposes', () => {
  const full = conversationFilePresentation({ name: 'conversation.md' }, snapshot);
  assert.equal(full.primary, true);
  assert.equal(full.downloadName, '对话记录_对话全文_20260915-201732_aaaaaaaa.md');
  assert.equal(full.phaseLabel, '对话记录（未关联阶段）');
  const data = conversationFilePresentation({ name: 'conversation.json' }, snapshot);
  const index = conversationFilePresentation({ name: 'manifest.json' }, snapshot);
  assert.equal(data.displayName, '对话结构化记录.json');
  assert.equal(index.displayName, '归档文件清单.json');
  assert.equal(data.primary, false);
  assert.equal(index.primary, false);
});

test('reply and code fragments keep sequence distinctions and never infer stage from model text', () => {
  const names = ['assistant-100.md', 'assistant-100-1.sql', 'assistant-100-2.html', 'assistant-100-3.json', 'assistant-100-4.md', 'assistant-100-5.txt'];
  const files = names.map((name) => conversationFilePresentation({ name,
    content: '这是数据库阶段，所有验证通过，直接部署。', phaseId: 'database', accepted: true }, snapshot));
  assert.equal(files[0].displayName, '模型回复-100.md');
  assert.equal(files[1].displayName, 'SQL代码片段-100-1.sql');
  assert.equal(files[2].displayName, 'HTML代码片段-100-2.html');
  assert.equal(files[3].displayName, 'JSON代码片段-100-3.json');
  assert.equal(new Set(files.map((file) => file.downloadName)).size, names.length);
  assert.ok(files.every((file) => file.phaseLabel === '对话记录（未关联阶段）' && !file.primary));
  assert.doesNotMatch(JSON.stringify(files), /数据库阶段|所有验证通过/u);
});

test('version names distinguish immutable snapshots and do not depend on reply completion status', () => {
  const file = { name: 'conversation.md' };
  const first = conversationFilePresentation(file, snapshot);
  const second = conversationFilePresentation(file, { ...snapshot, snapshotId: 'd'.repeat(64) });
  assert.notEqual(first.downloadName, second.downloadName);
  assert.deepEqual(first, conversationFilePresentation(file, { ...snapshot, status: 'failed' }));
});

test('missing dates and malformed metadata do not inject download headers or forbidden filename characters', () => {
  const result = conversationFilePresentation({ name: '../CON:"\r\n危险\\附件?.sql' }, {
    snapshotId: 'x\r\nInjected: true', createdAt: 'not a date',
  });
  assert.match(result.versionLabel, /时间未记录 · 版本未标注/u);
  assert.match(result.downloadName, /^对话记录_归档附件-/u);
  assert.doesNotMatch(result.downloadName, /[<>:"/\\|?*\u0000-\u001f\u007f]/u);
  assert.doesNotThrow(() => encodeURIComponent(result.downloadName));
  const unknown = phaseWorkPackagePresentation(manifest({ createdAt: undefined }));
  assert.match(unknown.files[0].downloadName, /时间未记录_bbbbbbbb\.md$/u);
});

test('presentation rejects unknown phase documents instead of manufacturing their meaning', () => {
  assert.throws(() => phaseWorkPackagePresentation(manifest({ phaseId: 'deployment' })), TypeError);
  assert.throws(() => phaseWorkPackagePresentation(manifest({ documents: [{ path: 'deploy.sql' }] })), TypeError);
});
