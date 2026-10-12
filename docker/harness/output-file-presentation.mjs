const PHASE_NAMES = Object.freeze({
  requirements: '需求澄清',
  'domain-contract': '领域与接口约定',
  database: '数据实现',
  'ui-design': '页面交互设计',
  backend: '后端实现',
  frontend: '前端实现',
  'access-wiring': '权限接线',
  'cross-layer-acceptance': '跨层验收',
});

const PHASE_DOCUMENTS = Object.freeze({
  '00-input.md': ['输入与资料清单', '准备本阶段', '核对当前阶段的输入、资料来源和上游结果。'],
  '01-result.md': ['阶段结果', '阶段结果 · 先看这份', '先看本阶段完成内容与待处理项，再按交接说明继续。'],
  '02-process.md': ['处理过程', '了解处理过程', '查阅可观察的处理动作、决定与纠偏记录。'],
  '03-verification.md': ['验证记录', '核对验证依据', '查看实际检查、失败和未执行项，不能以文件存在代替检查通过。'],
  '04-handoff.md': ['下一阶段交接', '交给下一阶段', '核对下一步、应携带的结果和仍待处理的问题。'],
  '05-memory-candidate.md': ['经验候选', '经验候选 · 未确认', '仅为待审核的经验候选，尚未确认或成为正式项目记忆。'],
});

function safeFilenamePart(value) {
  return Array.from(String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '-')
    .replace(/[. ]+$/u, '')).slice(0, 32).join('') || '附件';
}

function versionPresentation(createdAt, digest) {
  const shortDigest = typeof digest === 'string' && /^[a-f0-9]{64}$/iu.test(digest)
    ? digest.slice(0, 8).toLowerCase() : null;
  const timestamp = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  const date = Number.isFinite(timestamp) ? new Date(timestamp + 8 * 60 * 60 * 1000) : null;
  const iso = date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  const timeLabel = iso === null ? '时间未记录' : `${iso.slice(0, 10)} ${iso.slice(11, 19)}（北京时间）`;
  const versionLabel = `${timeLabel} · ${shortDigest === null ? '版本未标注' : `版本 ${shortDigest}`}`;
  const timePart = iso === null ? '时间未记录' : `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
  return { versionLabel, suffix: `${timePart}_${shortDigest ?? '版本未标注'}` };
}

// The caller verifies the sealed manifest and access scope. These labels never
// alter its canonical paths, contents, or digests.
export function phaseWorkPackagePresentation(manifest) {
  const phaseName = Object.hasOwn(PHASE_NAMES, manifest.phaseId) ? PHASE_NAMES[manifest.phaseId] : null;
  if (phaseName === null || !Number.isSafeInteger(manifest.phaseIndex) || manifest.phaseIndex < 0) {
    throw new TypeError('A verified work package phase is required.');
  }
  const phaseNumber = String(manifest.phaseIndex + 1).padStart(2, '0');
  const statusHint = manifest.decision === 'accepted'
    ? '本阶段已通过，阶段结果不表示已经部署。'
    : '本阶段未通过，请查阅结果与验证记录中的具体问题。';
  const version = versionPresentation(manifest.createdAt, manifest.packageDigest);
  return {
    phaseLabel: `第${phaseNumber}阶段 · ${phaseName}`,
    versionLabel: version.versionLabel,
    files: manifest.documents.map((document) => {
      if (!Object.hasOwn(PHASE_DOCUMENTS, document.path)) {
        throw new TypeError('A canonical work package document is required.');
      }
      const [title, usageLabel, usageHint] = PHASE_DOCUMENTS[document.path];
      return {
        name: document.path,
        displayName: `${phaseName} · ${title}.md`,
        downloadName: `${phaseNumber}-${phaseName}_${title}_${version.suffix}.md`,
        usageLabel,
        usageHint: document.path === '01-result.md' ? `${usageHint} ${statusHint}` : usageHint,
        primary: document.path === '01-result.md',
        mediaType: 'text/markdown; charset=utf-8',
        bytes: document.bytes,
        sha256: document.sha256,
      };
    }),
  };
}

function conversationFileKind(name) {
  if (name === 'conversation.md') return {
    title: '对话全文', extension: 'md', usageLabel: '先看这份', primary: true,
    usageHint: '适合完整回看本次保存的对话输入、模型回复和工具记录。',
  };
  if (name === 'conversation.json') return {
    title: '对话结构化记录', extension: 'json', usageLabel: '数据核对',
    usageHint: '用于程序读取和记录核对，日常阅读请先打开对话全文。',
  };
  if (name === 'manifest.json') return {
    title: '归档文件清单', extension: 'json', usageLabel: '核对文件与摘要',
    usageHint: '核对文件是否完整，以及下载后的内容是否与归档一致。',
  };
  const reply = /^assistant-(\d+)\.md$/u.exec(name);
  if (reply !== null) return {
    title: `模型回复-${reply[1]}`, extension: 'md', usageLabel: '阅读单条回复',
    usageHint: '模型的一条原始回复；所属阶段及验收状态尚未关联。',
  };
  const snippet = /^assistant-(\d+)-(\d+)\.(md|txt|json|html|sql)$/u.exec(name);
  const labels = { md: 'Markdown文本片段', txt: '文本片段', json: 'JSON代码片段', html: 'HTML代码片段', sql: 'SQL代码片段' };
  if (snippet !== null) return {
    title: `${labels[snippet[3]]}-${snippet[1]}-${snippet[2]}`, extension: snippet[3],
    usageLabel: '回复中的片段',
    usageHint: '从模型回复提取的片段，未经此列表验证，不能据此判断可直接执行或部署。',
  };
  const extension = /\.([a-z0-9]{1,10})$/iu.exec(name)?.[1].toLowerCase() ?? 'txt';
  const stem = name.replace(/\.[a-z0-9]{1,10}$/iu, '');
  return {
    title: `归档附件-${safeFilenamePart(stem)}`, extension, usageLabel: '查看归档附件',
    usageHint: '保留原附件内容；用途、所属阶段与验收状态需要结合原对话确认。',
  };
}

export function conversationFilePresentation(file, snapshot = {}) {
  const name = typeof file?.name === 'string' ? file.name : '附件.txt';
  const kind = conversationFileKind(name);
  const version = versionPresentation(snapshot.createdAt, snapshot.snapshotId);
  return {
    displayName: `${kind.title}.${kind.extension}`,
    downloadName: `对话记录_${kind.title}_${version.suffix}.${kind.extension}`,
    phaseLabel: '对话记录（未关联阶段）',
    usageLabel: kind.usageLabel,
    usageHint: kind.usageHint,
    versionLabel: version.versionLabel,
    primary: kind.primary === true,
  };
}
