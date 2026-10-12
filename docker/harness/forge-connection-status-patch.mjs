import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'forge-connection-status-v1';
const TODO_MARKER = 'forge-todo-execution-status-v1';

/** A plan item's saved status is not proof that its session is still executing. */
export function patchTodoExecutionStatus(source) {
  const edits = [
    ['function StatusGlyph({ status }) {', 'function StatusGlyph({ status, running, connectionReady }) {'],
    ['case "in_progress": return (0, react_jsx_runtime.jsx)(ProgressGlyph, {});',
      'case "in_progress": return (0, react_jsx_runtime.jsx)(connectionReady && running ? ProgressGlyph : PendingGlyph, {});'],
    ['function progressLabel(todos, t) {', 'function progressLabel(todos, t, running, connectionReady) {'],
    ['[t("todo.progress.active", { active })]',
      '[t(!connectionReady ? "todo.progress.unknown" : running ? "todo.progress.active" : "todo.progress.idle", { active })]'],
    ['function TodoPanel({ todos, t }) {', 'function TodoPanel({ todos, t, running, connectionReady }) {'],
    ['"data-testid": "todo-panel",',
      '"data-testid": "todo-panel",\n"data-forge-todo-execution": connectionReady ? running ? "running" : "idle" : "unknown",'],
    ['children: progressLabel(todos, t)', 'children: progressLabel(todos, t, running, connectionReady)'],
    ['StatusGlyph, { status: item.status }', 'StatusGlyph, { status: item.status, running, connectionReady }'],
    ['function TodoDock({ useProjection, t }) {',
      `// ${TODO_MARKER}: preserve the host todo projection; render activity from the live session.
function TodoDock({ useProjection, session, connectionStatus, t }) {
const connectionReady = (0, react.useSyncExternalStore)(connectionStatus.subscribe, connectionStatus.getSnapshot) !== void 0;
const running = session.running === true;`],
    ['todos: useProjection("todos") ?? [],', 'todos: useProjection("todos") ?? [],\nrunning, connectionReady,'],
    ['name: "conversation-todo-dock",\n\t\t\tinject: ["slots"],',
      'name: "conversation-todo-dock",\n\t\t\tinject: ["slots", "connection"],'],
    ['id: "todo",\n\t\t\t\t\torder: 0,\n\t\t\t\t\tlocale: NS',
      'id: "todo",\n\t\t\t\t\torder: 0,\n\t\t\t\t\tlocale: NS,\n                    inject: () => ({ connectionStatus: ctx.connection.hostDescription })'],
    ['"todo.progress.active": "{active} 进行中",',
      '"todo.progress.active": "{active} 进行中",\n"todo.progress.idle": "{active} 未完成，当前未执行，待继续",\n"todo.progress.unknown": "{active} 未完成，连接不可用，运行状态未知",'],
    ['"todo.progress.active": "{active} in progress",',
      '"todo.progress.active": "{active} in progress",\n"todo.progress.idle": "{active} unfinished, not running, awaiting continuation",\n"todo.progress.unknown": "{active} unfinished, disconnected, execution unknown",'],
  ];
  if (source.includes(TODO_MARKER)) {
    if (!edits.every(([, after]) => source.split(after).length === 2)) {
      throw new Error('Incomplete todo execution status patch');
    }
    return source;
  }
  for (const [before] of edits) {
    if (source.split(before).length !== 2) throw new Error(`Unsupported upstream todo client: ${before}`);
  }
  for (const [before, after] of edits) source = source.replace(before, after);
  return source;
}

/** Bind the pinned upstream view to its existing live connection store. */
export function patchConversationClient(source) {
  const edits = [
    ['function ChatView({ useSession,', 'function ChatView({ connectionStatus, useSession,'],
    ['const order = useSession((s) => s.chat.order);',
      `// ${MARKER}: a cached running flag is not live execution evidence.
const connectionReady = (0, react.useSyncExternalStore)(connectionStatus.subscribe, connectionStatus.getSnapshot) !== void 0;
const order = useSession((s) => s.chat.order);`],
    ['fileMentions: (owner) => ctx.get("chatFileMentions")?.forClosing(owner),',
      'connectionStatus: ctx.connection.hostDescription,\nfileMentions: (owner) => ctx.get("chatFileMentions")?.forClosing(owner),'],
    ['running && (0, react_jsx_runtime.jsx)(TurnStatus, {',
      `!connectionReady ? (0, react_jsx_runtime.jsx)("div", {
className: ChatView_module_css_default.turnStatus,
role: "status",
"aria-live": "polite",
"data-forge-connection-status": "unavailable",
children: "连接不可用，正在重连；运行状态未知。"
}) : running && (0, react_jsx_runtime.jsx)(TurnStatus, {`],
  ];
  if (source.includes(MARKER)) {
    // The existing history patch adds its two props ahead of the connection prop.
    const installedView = edits[0][1];
    const supportedViewCount = source.split(installedView).length - 1
      + source.split(installedView.replace('connectionStatus,', 'loadQuestionHistory, jumpQuestion, connectionStatus,')).length - 1;
    if (supportedViewCount !== 1 || !edits.slice(1).every(([, after]) => source.split(after).length === 2)) {
      throw new Error('Incomplete connection status patch');
    }
    return patchTodoExecutionStatus(source);
  }
  for (const [before] of edits) {
    if (source.split(before).length !== 2) throw new Error('Unsupported upstream conversation client');
  }
  for (const [before, after] of edits) source = source.replace(before, after);
  return patchTodoExecutionStatus(source);
}

export function applyPatch(root) {
  const directory = resolve(root, '@deepseek-ai/dsh-client-ui-conversation');
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh-client-ui-conversation' || pkg.version !== '0.1.1-rc.2') {
    throw new Error('Unsupported Harness UI package');
  }
  const file = resolve(directory, 'lib/client.js');
  const before = readFileSync(file, 'utf8');
  const after = patchConversationClient(before);
  if (after !== before) writeFileSync(file, after);
  return { patch: MARKER, changed: after !== before };
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node forge-connection-status-patch.mjs NODE_MODULES_ROOT');
  console.log(JSON.stringify(applyPatch(process.argv[2])));
}
