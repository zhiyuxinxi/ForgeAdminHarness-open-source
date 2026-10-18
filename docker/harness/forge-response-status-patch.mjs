import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MARKER = 'forge-response-status-v1';

/** A connection heartbeat is not a response phase. Only native session evidence is used. */
export function forgeResponsePhase(events, running, runningCalls = []) {
  if (!running) return null;
  if (runningCalls.length) return 'tool';
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.surfaceOp?.kind === 'replace') continue;
    if (event.type === 'turn/end') return 'preparing';
    if (event.type === 'compaction/start') return 'compacting';
    if (event.type === 'compaction/end') return 'preparing';
    if (event.type === 'tool/result' || event.type === 'step/start') return 'waiting-model';
    if (event.type === 'llm/retry') return 'retrying-model';
    if (event.type === 'assistant/chunk') {
      const chunk = event.data?.chunk;
      if (chunk && !['usage', 'finish'].includes(chunk.type)) return 'responding';
    }
    if (event.type === 'assistant/message') return 'processing';
    if (event.type === 'turn/start') return 'preparing';
  }
  return 'preparing';
}

/** Read only the release command's result or the background job it actually started. */
export function forgeReleaseReceipts(roots) {
  const jobs = new Set(), receipts = new Map();
  for (const root of roots) {
    if (root?.kind !== 'tool-result' || root.isError || !root.call) continue;
    let args;
    try { args = JSON.parse(root.call.argsRaw); } catch { continue; }
    const release = root.call.name === 'bash' && typeof args.command === 'string'
      && /^forge-release\s+release(?:\s|$)/.test(args.command.trim()) && !/[;&|`$<>\r\n]/.test(args.command);
    const job = root.call.name === 'job_output' && jobs.has(args.job_id);
    if (!release && !job) continue;
    for (const part of root.content ?? []) {
      if (part.type !== 'text' || typeof part.text !== 'string') continue;
      if (release) {
        const started = /^started background job ([A-Za-z0-9_-]+)\s*$/.exec(part.text);
        if (started) { jobs.add(started[1]); continue; }
      }
      // Native bash/job_output append stderr and a completion footer after stdout.
      const stdout = part.text.split(/\n\[stderr\]\r?\n|\n\[status: /, 1)[0].trim();
      let value;
      try { value = JSON.parse(stdout); } catch { continue; }
      const result = value?.result;
      if (value?.ok !== (result?.status === 'success') || result?.action !== 'release' || result.terminal !== true
        || !['success', 'failed'].includes(result.status) || typeof result.operationId !== 'string'
        || !/^[a-f0-9-]{36}$/i.test(result.operationId) || typeof result.taskId !== 'string'
        || !/^c-[a-f0-9]+$/i.test(result.taskId) || (result.status === 'success' && result.stage !== 'complete')) continue;
      receipts.set(result.operationId, {
        operationId: result.operationId, taskId: result.taskId, status: result.status,
        commit: typeof result.commit === 'string' && /^[a-f0-9]{40}$/i.test(result.commit) ? result.commit : null,
        completedAt: typeof result.completedAt === 'string' ? result.completedAt : null,
      });
    }
  }
  return [...receipts.values()];
}

export function forgeReleaseHistoryReceipts(events) {
  const calls = new Map(), roots = [];
  for (const event of events) {
    if (event.surfaceOp?.kind === 'replace') continue;
    if (event.type === 'tool/call') calls.set(event.data.callId, { name: event.data.name, argsRaw: event.data.arguments });
    if (event.type !== 'tool/result') continue;
    const message = event.data.message;
    const call = calls.get(message?.source?.callId);
    for (const part of message?.content ?? []) {
      if (part.type === 'tool-result') roots.push({ kind: 'tool-result', call, isError: part.isError, content: part.content });
    }
  }
  return forgeReleaseReceipts(roots);
}

function replaceOnce(source, before, after) {
  const variants = [...new Set([before, before.replace(/\n/g, '\r\n')])];
  const matches = variants.flatMap(value => Array.from(source.matchAll(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')), match => ({ index: match.index, value })));
  if (matches.length !== 1) throw new Error(`Unsupported response status anchor: ${before.slice(0, 100)}`);
  const match = matches[0];
  return source.slice(0, match.index) + after + source.slice(match.index + match.value.length);
}
function patchEdits(source, marker, edits) {
  if (source.includes(marker)) {
    // Upgrade only the complete known v1 helper; partial or unknown patches still fail below.
    const helper = forgeReleaseReceipts.toString();
    const legacyHelper = helper.replace("value?.ok !== (result?.status === 'success')", 'value?.ok !== true');
    if (source.split(legacyHelper).length === 2) source = source.replace(legacyHelper, helper);
    if (!edits.every(([, after]) => source.split(after).length === 2)) throw new Error(`Incomplete ${marker}`);
    return source;
  }
  for (const [before, after] of edits) source = replaceOnce(source, before, after);
  return source;
}

export function patchResponseRuntime(source) {
  const anchor = 'buildSnapshot() {\n\t\t\t\tif (this.pendingCache';
  return patchEdits(source, `${MARKER} runtime`, [
    [anchor, `// ${MARKER} runtime\n${anchor}`],
    ['runningCalls: legacy.runningCalls,', `runningCalls: legacy.runningCalls,\nforgeResponsePhase: (${forgeResponsePhase.toString()})(this.events, this.running, legacy.runningCalls),`],
  ]);
}

export function patchResponseHistory(source) {
  const anchor = 'function projectQuestion(events, start, end, details, afterSeq) {';
  return patchEdits(source, `${MARKER} history`, [
    [anchor, `// ${MARKER} history\n${forgeReleaseReceipts.toString()}\n${forgeReleaseHistoryReceipts.toString()}\n${anchor}`],
    ["needsConfirmation: preparationStatus(relevant) === 'needs-confirmation',", "needsConfirmation: preparationStatus(relevant) === 'needs-confirmation',\n    releaseReceipts: forgeReleaseHistoryReceipts(relevant),"],
  ]);
}

export function ForgeReleaseReceipts({ receipts }) {
  return receipts.map(receipt => react_jsx_runtime.jsxs('div', {
    role: 'status', 'data-forge-release-status': receipt.status, 'data-forge-release-operation': receipt.operationId,
    style: { margin: '8px 0', fontSize: '14px' },
    children: [receipt.status === 'success' ? '发布已成功' : '发布失败',
      receipt.commit ? ` · 版本 ${receipt.commit.slice(0, 12)}` : '',
      ` · 发布回执 ${receipt.operationId.slice(0, 8)}`, '。AI 回复状态单独显示。'],
  }, receipt.operationId));
}

export function patchResponseUi(source) {
  const edits = [
    ['function TurnStatus({ startTime, t }) {', `// ${MARKER} ui\nfunction TurnStatus({ startTime, phase, t }) {`],
    ['children: ["Deep diving...", showClock', `"data-forge-response-phase": phase ?? "preparing",\nchildren: [{ preparing: "正在准备请求", compacting: "正在压缩上下文", tool: "正在执行工具", "waiting-model": "等待模型响应", "retrying-model": "等待模型重试", responding: "模型正在输出", processing: "正在处理模型结果" }[phase] ?? "正在准备请求", showClock`],
    ['children: formatRunDuration(elapsedMs, t)', 'children: "本轮总耗时 " + formatRunDuration(elapsedMs, t)'],
    ['startTime: runningTurnStart,', 'startTime: runningTurnStart,\nphase: responsePhase,'],
    ['const running = useSession((s) => s.running);\n\t\t\tconst openState = useSession((s) => s.openState);', 'const running = useSession((s) => s.running);\nconst responsePhase = useSession((s) => s.forgeResponsePhase);\n\t\t\tconst openState = useSession((s) => s.openState);'],
    ['title: t(provenance.role === "recall" ? "message.contextRecall" : "message.contextInjection"),', 'title: t(provenance.role === "recall" ? "message.contextRecall" : "message.contextInjection") + "（已完成）",'],
  ];
  const helperEdits = [
    ['function forgeWorkpodGroups(order, nodeStore) {', `${forgeReleaseReceipts.toString()}\n${ForgeReleaseReceipts.toString()}\nfunction forgeWorkpodGroups(order, nodeStore) {`],
    ['if (group.standalone) continue;\n    for (const { key, node } of group.nodes) {', `if (group.standalone) continue;\n    group.releaseReceipts = [...new Map([...(group.question.data.forgeHistory?.releaseReceipts ?? []), ...forgeReleaseReceipts(group.nodes.map(({ node }) => node.kind === 'tool-call' ? node.data.root : null))].map(receipt => [receipt.operationId, receipt])).values()];\n    for (const { key, node } of group.nodes) {`],
    ['renderNode(group.question.key),\n    react_jsx_runtime.jsx(ForgeQuestionProcess,', 'renderNode(group.question.key),\n    react_jsx_runtime.jsx(ForgeReleaseReceipts, { receipts: group.releaseReceipts }),\n    react_jsx_runtime.jsx(ForgeQuestionProcess,'],
  ];
  if (source.includes(`${MARKER} ui`) && source.includes('// forge-question-history-v2 ui\n')) {
    // The history patch replaces this entire known block on incremental builds.
    // Restore only its three response additions; partial/unknown blocks still fail below.
    const refreshed = `// forge-question-history-v2 ui\n${readFileSync(new URL('./forge-question-history-client.js', import.meta.url), 'utf8')}\nfunction ChatView({`;
    if (source.includes(refreshed)) {
      const restored = helperEdits.reduce((block, [before, after]) => replaceOnce(block, before, after), refreshed);
      source = replaceOnce(source, refreshed, restored);
    }
  }
  return patchEdits(source, `${MARKER} ui`, [...edits, ...helperEdits]);
}

export function applyPatch(root, helperDirectory = dirname(fileURLToPath(import.meta.url))) {
  const runtime = resolve(root, '@deepseek-ai/dsh-client-runtime');
  const ui = resolve(root, '@deepseek-ai/dsh-client-ui-conversation');
  for (const directory of [runtime, ui]) {
    const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
    if (pkg.version !== '0.1.1-rc.2') throw new Error('Unsupported Harness response status package');
  }
  const edits = [
    [resolve(runtime, 'lib/client.js'), patchResponseRuntime],
    [resolve(ui, 'lib/client.js'), patchResponseUi],
    [resolve(helperDirectory, 'forge-question-history.mjs'), patchResponseHistory],
  ].map(([file, patch]) => { const before = readFileSync(file, 'utf8'); return { file, before, after: patch(before) }; });
  for (const { file, before, after } of edits) if (before !== after) writeFileSync(file, after);
  return { patch: MARKER, changed: edits.some(({ before, after }) => before !== after) };
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node forge-response-status-patch.mjs NODE_MODULES_ROOT');
  console.log(JSON.stringify(applyPatch(process.argv[2])));
}
