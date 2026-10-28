import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'forge-question-history-v2';
const LEGACY_MARKER = 'forge-question-history-v1';
const WORKPOD_UI_MARKER = 'forge-workpod-flow-v1';
const PROMPT_QUEUE_UI_MARKER = 'forge-prompt-queue-composer-v1';
const PROMPT_QUEUE_NAVIGATION_MARKER = 'forge-prompt-queue-navigation-v1';
const PROMPT_QUEUE_SIDEBAR_MARKER = 'forge-prompt-queue-sidebar-v1';
const clientHelpers = readFileSync(new URL('./forge-question-history-client.js', import.meta.url), 'utf8');
const historySearchProps = "sessionId, loadQuestionHistory, jump, historyRevision: order.reduce((latest, key) => { const node = nodeStore.get(key); return ['user', 'steering'].includes(node?.kind) ? node.data.seq : latest; }, null)";
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Unsupported question history patch anchor: ${before.slice(0, 95)}`);
  return source.replace(before, after);
}
export function patchHistoryHost(source) {
  if (source.includes(`// ${MARKER} host`)) return source;
  if (source.includes(`// ${LEGACY_MARKER} host`)) {
    source = replaceOnce(source, "forgeView: z$1.enum(['summary', 'details', 'search']).optional(),", "forgeView: z$1.enum(['summary', 'details', 'search', 'questions']).optional(),");
    source = replaceOnce(source, 'forgeSearch: z$1.unknown().optional(),', 'forgeSearch: z$1.unknown().optional(),\n forgeQuestions: z$1.unknown().optional(),');
    return replaceOnce(source, `// ${LEGACY_MARKER} host`, `// ${MARKER} host`);
  }
  source = `// ${MARKER} host\nimport { questionHistory } from '/usr/local/lib/forge-question-history.mjs';\n` + source;
  source = replaceOnce(source, 'const sessionHistoryRequestSchema = z$1.object({', `const sessionHistoryRequestSchema = z$1.object({
  forgeView: z$1.enum(['summary', 'details', 'search', 'questions']).optional(),
  questionSeq: z$1.number().int().nonnegative().optional(),
  detailAfterSeq: z$1.number().int().nonnegative().optional(),
  query: z$1.string().max(500).optional(),`);
  source = replaceOnce(source, 'const source = await historySourceFor(sessionId);\n\t\t\t\t\tconst scope =', `const source = await historySourceFor(sessionId);
          if (request.payload.forgeView) {
            const cut = historyCutOf(source, beforeSeq === void 0 && request.payload.forgeView === 'summary');
            const page = questionHistory(cut.events, request.payload);
            const scope = request.payload.forgeView === 'details' ? await presenterScopeFor(sessionId, sourceSession(source)) : undefined;
            return ok(request, { ...page, events: page.events.map(event => {
              const view = scope === undefined ? undefined : viewFor(ctx, event, callId => backscanArgs(cut.events, callId), scope);
              return { event, ...(view === undefined ? {} : { view }) };
            }), ...(cut.projections === undefined ? {} : { projections: cut.projections }) });
          }
          const scope =`);
  return replaceOnce(source, 'const sessionHistoryValueSchema = z$1.object({', 'const sessionHistoryValueSchema = z$1.object({\n forgeSearch: z$1.unknown().optional(),\n forgeQuestions: z$1.unknown().optional(),');
}
export function patchHistoryConnection(source) {
  if (source.includes(`// ${MARKER} connection`)) return source;
  if (source.includes(`// ${LEGACY_MARKER} connection`)) {
    source = replaceOnce(source, 'forgeSearch: unknown().optional(),', 'forgeSearch: unknown().optional(),\n forgeQuestions: unknown().optional(),');
    return replaceOnce(source, `// ${LEGACY_MARKER} connection`, `// ${MARKER} connection`);
  }
  return replaceOnce(source, 'const sessionHistoryValueSchema = object({', `// ${MARKER} connection\nconst sessionHistoryValueSchema = object({\n forgeSearch: unknown().optional(),\n forgeQuestions: unknown().optional(),`);
}
export function patchHistoryRuntime(source) {
  if (source.includes(`// ${MARKER} runtime`)) return source;
  if (source.includes(`// ${LEGACY_MARKER} runtime`)) {
    source = replaceOnce(source, "if (payload.forgeView === 'search') return result.value;", "if (payload.forgeView === 'search' || payload.forgeView === 'questions') return result.value;");
    return replaceOnce(source, `// ${LEGACY_MARKER} runtime`, `// ${MARKER} runtime`);
  }
  source = replaceOnce(source, 'history(payload) {\n\t\t\t\treturn this.address === void 0 ? this.api.sessions.history({', `// ${MARKER} runtime
      async forgeLoadHistory(payload) {
        const generation = this.openGeneration;
        const { result } = await this.history(payload);
        if (!result.ok) throw new Error(result.error.message);
        if (generation !== this.openGeneration) throw new Error('Conversation changed; retry in the current conversation');
        if (payload.forgeView === 'search' || payload.forgeView === 'questions') return result.value;
        const rows = new Map(this.events.map((event, i) => [event.seq, { event, view: this.views[i] }]));
        for (const row of result.value.events) {
          if (row.event.type !== 'forge/history-watermark' || !rows.has(row.event.seq)) rows.set(row.event.seq, row);
        }
        const entries = [...rows.values()].sort((a, b) => a.event.seq - b.event.seq);
        this.installWindow(entries, payload.forgeView === 'details' ? this.hasMore : result.value.hasMore, result.value.projections);
        return result.value;
      }
      async forgeJumpQuestion(seq) {
        while (this.baseSeq > seq) {
          const previous = this.baseSeq;
          await this.forgeLoadHistory({ forgeView: 'summary', questionSeq: seq, beforeSeq: previous });
          if (this.baseSeq >= previous) throw new Error('Question could not be loaded');
        }
      }
      history(payload) {
        return this.address === void 0 ? this.api.sessions.history({ forgeView: 'summary',`);
  source = replaceOnce(source, 'console.error("[web-runtime] loadOlder failed:", error);', 'console.error("[web-runtime] loadOlder failed:", error); throw error;');
  source = replaceOnce(source, 'if (!result.ok) return;\n\t\t\t\t\tconst older = result.value.events;', 'if (!result.ok) throw new Error(result.error.message);\n\t\t\t\t\tconst older = result.value.events;');
  return source;
}
export function patchHistoryUi(source) {
  if (source.includes(`// ${WORKPOD_UI_MARKER} ui`)) {
    // Incremental images already contain this installation marker. Refresh
    // only our helper block and preserve the installed ChatView and its patches.
    const start = source.indexOf(`// ${MARKER} ui`), end = source.indexOf('function ChatView({', start);
    if (start < 0 || end < start) throw new Error('Missing installed workpod history UI boundary');
    return source.slice(0, start) + `// ${MARKER} ui\n${clientHelpers}\n` + source.slice(end);
  }
  const installActions = value => `// ${WORKPOD_UI_MARKER} ui\n` + replaceOnce(value,
    'ForgeQuestionRows, { order, nodeStore, loadQuestionHistory, renderNode:',
    'ForgeQuestionRows, { order, nodeStore, loadQuestionHistory, sessionId, running, connectionReady, renderNode:');
  if (source.includes(`// ${MARKER} ui`)) {
    const start = source.indexOf(`// ${MARKER} ui`), end = source.indexOf('function ChatView({', start);
    if (end < start) throw new Error('Missing question history UI boundary');
    return installActions(source.slice(0, start) + `// ${MARKER} ui\n${clientHelpers}\n` + source.slice(end));
  }
  if (source.includes(`// ${LEGACY_MARKER} ui`)) {
    const start = source.indexOf(`// ${LEGACY_MARKER} ui`);
    const end = source.indexOf('function ChatView({', start);
    if (end < start) throw new Error('Missing legacy question history UI boundary');
    source = source.slice(0, start) + `// ${MARKER} ui\n${clientHelpers}\n` + source.slice(end);
    return installActions(replaceOnce(source, 'react_jsx_runtime.jsx(ForgeQuestionSearch, { sessionId, loadQuestionHistory, jump }, sessionId)', `react_jsx_runtime.jsx(ForgeQuestionSearch, { ${historySearchProps} }, sessionId)`));
  }
  source = replaceOnce(source, 'function ChatView({ connectionStatus,', `// ${MARKER} ui\n${clientHelpers}\nfunction ChatView({ loadQuestionHistory, jumpQuestion, connectionStatus,`);
  source = replaceOnce(source, 'connectionStatus: ctx.connection.hostDescription,', `loadQuestionHistory: request => sessions.binding(sessionId).session.forgeLoadHistory(request),
            jumpQuestion: seq => sessions.binding(sessionId).session.forgeJumpQuestion(seq),
            connectionStatus: ctx.connection.hostDescription,`);
  source = replaceOnce(source, 'loadOlder: () => {\n\t\t\t\t\t\t\tscoped.loadOlder();', 'loadOlder: () => {\n\t\t\t\t\t\t\treturn scoped.loadOlder();');
  source = replaceOnce(source, 'const firstSeqRef = (0, react.useRef)(null);', `const firstSeqRef = (0, react.useRef)(null);
      const [historyError, setHistoryError] = react.useState('');
      const questionTargetRef = react.useRef(null);
      const [, refreshQuestionTarget] = react.useReducer(value => value + 1, 0);
      const jump = async seq => { globalThis.__forgeHistoryNavigationUntil = Date.now() + 1500; questionTargetRef.current = seq; atBottomRef.current = false; try { await jumpQuestion(seq); setAtBottom(false); refreshQuestionTarget(); } catch (error) { questionTargetRef.current = null; throw error; } };`);
  source = replaceOnce(source, 'if (anchorRef.current !== null && firstSeq !== null', `if (questionTargetRef.current !== null && !loadingOlder) {
          const target = questionTargetRef.current;
          const rows = [...local.querySelectorAll('[data-forge-question-seq]')];
          const row = target === 'previous' ? (firstSeq < firstSeqRef.current ? rows[0] : null) : rows.find(r => Number(r.dataset.forgeQuestionSeq) === target);
          if (row) {
            globalThis.__forgeHistoryNavigationUntil = Date.now() + 1500;
            questionTargetRef.current = null; anchorRef.current = null;
            const searchHeight = local.parentElement?.querySelector('.forge-question-search')?.getBoundingClientRect().height ?? 0;
            el.scrollTop += flowTop(row, el) - searchHeight - 12;
            observedTopRef.current = el.scrollTop; atBottomRef.current = false; setAtBottom(false);
            row.focus({ preventScroll: true });
            firstSeqRef.current = firstSeq; lastKeyRef.current = lastKey; lastSteeringIdRef.current = lastSteeringId; followSigRef.current = followSig;
            return;
          }
        }
        if (anchorRef.current !== null && firstSeq !== null`);
  const start = source.indexOf('\t\t\tconst loadOlderAnchored = () => {');
  const end = source.indexOf('\n\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {', start);
  if (start < 0 || end < start) throw new Error('Missing native pagination action');
  source = source.slice(0, start) + `const loadOlderAnchored = () => {
        globalThis.__forgeHistoryNavigationUntil = Date.now() + 1500;
        questionTargetRef.current = 'previous'; anchorRef.current = null; atBottomRef.current = false;
        setHistoryError(''); loadOlder().catch(() => { questionTargetRef.current = null; setHistoryError('上一个问题加载失败，请重试。'); });
      };` + source.slice(end);
  source = replaceOnce(source, 'children: [(0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\t\tref: listRef,', `children: [react_jsx_runtime.jsx(ForgeQuestionSearch, { ${historySearchProps} }, sessionId), historyError && react_jsx_runtime.jsx('div', { role: 'alert', children: historyError }), (0, react_jsx_runtime.jsxs)("div", {
          ref: listRef,`);
  source = replaceOnce(source, 'order.map((nodeKey) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {', 'react_jsx_runtime.jsx(ForgeQuestionRows, { order, nodeStore, loadQuestionHistory, renderNode: (nodeKey) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {');
  source = replaceOnce(source, '}, nodeKey)),\n\t\t\t\t\t\t\t!connectionReady', '}, nodeKey) }),\n\t\t\t\t\t\t\t!connectionReady');
  source = replaceOnce(source, '"data-chat-flow-kind": routedNode.kind,', `"data-chat-flow-kind": routedNode.kind,
        "data-forge-question-seq": ['user', 'steering'].includes(routedNode.kind) ? routedNode.data.seq : undefined,
        tabIndex: ['user', 'steering'].includes(routedNode.kind) ? -1 : undefined,`);
  source = replaceOnce(source, 'const event = match.event;\n\t\t\t\tif (event.data.source.kind !== "user")', 'const event = match.event;\n\t\t\t\tif (event.data.source.kind !== "user")');
  // Both genuine user and user steering nodes retain browser-only lazy metadata.
  const marker = '\t\t\t\t\tkind: "user",\n\t\t\t\t\tseq: event.seq,';
  source = replaceOnce(source, marker, marker + '\n forgeHistory: event.data.forgeHistory ?? event.data.message?.forgeHistory,');
  const steering = '\t\t\t\t\tkind: "steering",\n\t\t\t\t\tmessageId: event.data.id,';
  source = replaceOnce(source, steering, steering + '\n forgeHistory: event.data.forgeHistory ?? event.data.message?.forgeHistory,');
  source = replaceOnce(source, '"chat.loadOlder": "加载更早",', '"chat.loadOlder": "上一个问题",');
  return installActions(source);
}
export function patchPromptQueueUi(source) {
  if (!source.includes(`// ${PROMPT_QUEUE_UI_MARKER}`)) {
  source = replaceOnce(source, 'async send(text) {\n\t\t\t\tconst result = await this.scopedSession("send").prompt([{', `async send(text) {
        const session = this.scopedSession("send");
        if (session.address === void 0 && globalThis.__forgeEnqueuePrompt) {
          await forgeSubmitQueuedSession(session, [{ type: 'text', text }]);
          return;
        }
        const result = await session.prompt([{`);
  source = replaceOnce(source, 'if (!(await session.prompt(content, mode, signal)).ok) return { kind: "error" };', `if (mode === 'queue' && session.address === void 0 && globalThis.__forgeEnqueuePrompt) {
          await forgeSubmitQueuedSession(session, content, signal);
        } else if (!(await session.prompt(content, mode, signal)).ok) return { kind: "error" };`);
  source = replaceOnce(source, 'if (blank && composerPhase === "blank") return null;',
    'if (blank && composerPhase === "blank") return sessionId ? react_jsx_runtime.jsx(ForgePromptQueueStatus, { sessionId, blank: true }) : null;');
    source = `// ${PROMPT_QUEUE_UI_MARKER}\n` + source;
  }
  if (!source.includes(`// ${PROMPT_QUEUE_NAVIGATION_MARKER}`)) {
  source = replaceOnce(source, 'function ChatView({ loadQuestionHistory,', 'function ChatView({ openSession, loadQuestionHistory,');
  source = replaceOnce(source, 'ForgeQuestionRows, { order, nodeStore, loadQuestionHistory, sessionId, running, connectionReady, renderNode:',
    'ForgeQuestionRows, { order, nodeStore, loadQuestionHistory, sessionId, useSessions, openSession, running, connectionReady, renderNode:');
  source = replaceOnce(source, 'jumpQuestion: seq => sessions.binding(sessionId).session.forgeJumpQuestion(seq),',
    'jumpQuestion: seq => sessions.binding(sessionId).session.forgeJumpQuestion(seq),\n            openSession: id => sessions.open(id),');
  source = replaceOnce(source, 'function ConversationSession({ sessionId, useSession,', 'function ConversationSession({ sessionId, useSessions, openSession, useSession,');
  source = replaceOnce(source, 'views,\n\t\t\t\t\t\treleaseSessionImages: (id) => {',
    'views,\n            openSession: id => sessions.open(id),\n\t\t\t\t\t\treleaseSessionImages: (id) => {');
  source = replaceOnce(source, 'ForgePromptQueueStatus, { sessionId, blank: true }', 'ForgePromptQueueStatus, { sessionId, useSessions, openSession, blank: true }');
    source = `// ${PROMPT_QUEUE_NAVIGATION_MARKER}\n` + source;
  }
  if (source.includes(`// ${PROMPT_QUEUE_SIDEBAR_MARKER}`)) return source;
  source = replaceOnce(source, 'function ConversationRoot({ sessionId, useSession,', 'function ConversationRoot({ sessionId, openSession, useSession,');
  source = replaceOnce(source, 'inject: (sessionId) => ({\n\t\t\t\t\thooks: { composerBlock:',
    'inject: (sessionId) => ({\n          openSession: id => sessions.open(id),\n\t\t\t\t\thooks: { composerBlock:');
  source = replaceOnce(source, 'return (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\tclassName: ConversationRoot_module_css_default.root,',
    'return react_jsx_runtime.jsx(ForgeConversationQueueLayout, { sessionId, useSessions, openSession, children: (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\tclassName: ConversationRoot_module_css_default.root,');
  source = replaceOnce(source, 'children: [renderSlot("conversation.session", {}), composerSeat]\n\t\t\t\t})]\n\t\t\t});',
    'children: [renderSlot("conversation.session", {}), composerSeat]\n\t\t\t\t})]\n\t\t\t}) });');
  source = replaceOnce(source, 'if (blank && composerPhase === "blank") return sessionId ? react_jsx_runtime.jsx(ForgePromptQueueStatus, { sessionId, useSessions, openSession, blank: true }) : null;',
    'if (blank && composerPhase === "blank") return null;');
  source = replaceOnce(source, 'const primaryStops = running && subagent === null;\n\t\t\tconst interruptible = running && continuable;',
    'const forgeQueueComposer = subagent === null && typeof globalThis.__forgeEnqueuePrompt === "function";\n      const primaryStops = running && subagent === null && !forgeQueueComposer;\n      const interruptible = running && (continuable || forgeQueueComposer);');
  source = replaceOnce(source, 'const primaryLabel = primaryStops ? t("input.stop") : t("input.send");',
    'const primaryLabel = forgeQueueComposer && running ? "发送并排队" : primaryStops ? t("input.stop") : t("input.send");');
  return `// ${PROMPT_QUEUE_SIDEBAR_MARKER}\n` + source;
}
export function applyQuestionHistoryPatch(root) {
  const changes = [];
  for (const [pkg, filename, transform] of [
    ['dsh-host-apiproxy', 'index.js', patchHistoryHost], ['dsh-client-connection', 'client.js', patchHistoryConnection],
    ['dsh-client-runtime', 'client.js', patchHistoryRuntime], ['dsh-client-ui-conversation', 'client.js', source => patchPromptQueueUi(patchHistoryUi(source))],
  ]) {
    const dir = resolve(root, '@deepseek-ai', pkg);
    const version = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')).version;
    if (version !== '0.1.1-rc.2') throw new Error(`Unsupported pinned package ${pkg}`);
    const file = resolve(dir, 'lib', filename), original = readFileSync(file, 'utf8'), output = transform(original);
    changes.push({ file, original, output });
  }
  for (const { file, original, output } of changes) if (original !== output) writeFileSync(file, output);
  return { patch: MARKER, changed: changes.filter(x => x.original !== x.output).length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(applyQuestionHistoryPatch(process.argv[2])));
