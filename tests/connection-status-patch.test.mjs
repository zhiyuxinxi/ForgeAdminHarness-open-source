import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { patchConversationClient } from '../docker/harness/forge-connection-status-patch.mjs';

// Frozen TodoPanel/TodoDock excerpt from the pinned 0.1.1-rc.2 native package.
const todoSource = `
const zh = { "todo.progress.active": "{active} 进行中", };
const en = { "todo.progress.active": "{active} in progress", };
		function StatusGlyph({ status }) {
			switch (status) {
				case "completed": return (0, react_jsx_runtime.jsx)(CompletedGlyph, {});
				case "in_progress": return (0, react_jsx_runtime.jsx)(ProgressGlyph, {});
				case "pending": return (0, react_jsx_runtime.jsx)(PendingGlyph, {});
				/* v8 ignore next -- closed TodoItem status union */
				default: return assertNever(status);
			}
		}
		/** Header summary: "·"-joined per-status counts; zero-count segments are omitted as noise (a non-empty list keeps at least one). */
		function progressLabel(todos, t) {
			const done = todos.filter((item) => item.status === "completed").length;
			const active = todos.filter((item) => item.status === "in_progress").length;
			const pending = todos.length - done - active;
			return [
				...done > 0 ? [t("todo.progress.done", { done })] : [],
				...active > 0 ? [t("todo.progress.active", { active })] : [],
				...pending > 0 ? [t("todo.progress.pending", { pending })] : []
			].join(" · ");
		}
		function TodoPanel({ todos, t }) {
			const [collapsed, setCollapsed] = (0, react.useState)(true);
			if (todos.length === 0) return null;
			return (0, react_jsx_runtime.jsx)("section", {
				className: TodoPanel_module_css_default.root,
				"data-testid": "todo-panel",
				"aria-label": t("todo.title"),
				children: (0, react_jsx_runtime.jsxs)("div", {
					className: TodoPanel_module_css_default.body,
					children: [(0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: TodoPanel_module_css_default.header,
						"aria-expanded": !collapsed,
						onClick: () => {
							setCollapsed((v) => !v);
						},
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: TodoPanel_module_css_default.lead,
								"aria-hidden": true,
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChecklistOutline14, {})
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: TodoPanel_module_css_default.title,
								children: t("todo.title")
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: TodoPanel_module_css_default.progress,
								children: progressLabel(todos, t)
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: TodoPanel_module_css_default.chevron,
								"aria-hidden": true,
								children: collapsed ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
							})
						]
					}), !collapsed && (0, react_jsx_runtime.jsx)("ul", {
						className: TodoPanel_module_css_default.list,
						children: todos.map((item) => (0, react_jsx_runtime.jsxs)("li", {
							className: TodoPanel_module_css_default.item,
							"data-status": item.status,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: TodoPanel_module_css_default.glyph,
								"aria-hidden": true,
								children: (0, react_jsx_runtime.jsx)(StatusGlyph, { status: item.status })
							}), (0, react_jsx_runtime.jsx)("span", {
								className: TodoPanel_module_css_default.content,
								children: item.content
							})]
						}, item.content))
					})]
				})
			});
		}
		/** Dock adapter: reads the host-computed 'todos' projection (whole list; absent or null renders nothing). */
		function TodoDock({ useProjection, t }) {
			return (0, react_jsx_runtime.jsx)(TodoPanel, {
				todos: useProjection("todos") ?? [],
				t
			});
		}
		/**
		* The plan strip as a plain registrant plugin (QueueDock posture), following
		* the input-dock declaration across independent activation and reload.
		*/
		const todoDockEntry = {
			name: "conversation-todo-dock",
			inject: ["slots"],
			/**
			* Register the plan strip before the goal and queue entries (order 0).
			* @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
			*/
			apply(ctx) {
				ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
					name: "conversation.input.dock",
					id: "todo",
					order: 0,
					locale: NS
				}, TodoDock));
			}
		};
`;

const source = `
function ChatView({ useSession, running }) {
 const order = useSession((s) => s.chat.order);
 return [running && (0, react_jsx_runtime.jsx)(TurnStatus, { startTime: 1 })];
}
function inject(ctx) { return { fileMentions: (owner) => ctx.get("chatFileMentions")?.forClosing(owner), }; }
` + todoSource;

test('a disconnected session never presents the cached running flag as live progress', () => {
  const context = vm.createContext({
    react: { useSyncExternalStore: (_subscribe, read) => read() },
    react_jsx_runtime: { jsx: (type, props) => ({ type, props }) },
    ChatView_module_css_default: { turnStatus: 'status' },
    TurnStatus: 'live-turn-status',
  });
  vm.runInContext(patchConversationClient(source), context);
  const render = (connected, running) => context.ChatView({
    connectionStatus: { subscribe() {}, getSnapshot: () => connected ? {} : undefined },
    useSession: (select) => select({ chat: { order: [] } }), running,
  })[0];
  for (const running of [true, false]) {
    const result = render(false, running);
    assert.equal(result.type, 'div');
    assert.equal(result.props['data-forge-connection-status'], 'unavailable');
    assert.match(result.props.children, /运行状态未知/);
  }
  assert.equal(render(true, true).type, 'live-turn-status');
  assert.equal(render(true, false), false);
});

test('pinned client patch is idempotent and rejects upstream or partial drift', () => {
  const result = patchConversationClient(source);
  assert.equal(patchConversationClient(result), result);
  assert.throws(() => patchConversationClient(source.replace('function ChatView', 'function ChangedView')));
  assert.throws(() => patchConversationClient(source + source));
  assert.throws(() => patchConversationClient(result.replace('connectionStatus: ctx.connection', 'changed: ctx.connection')));
});

test('todo activity follows live execution without rewriting the retained plan', () => {
  const context = vm.createContext({
    react: { useState: () => [false, () => {}], useSyncExternalStore: (_subscribe, read) => read() },
    react_jsx_runtime: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    CompletedGlyph: 'completed-glyph', ProgressGlyph: 'spinning-glyph', PendingGlyph: 'static-glyph',
    TodoPanel_module_css_default: {}, _deepseek_ai_dsh_client_ui_primitives: {}, NS: 'conversation',
  });
  vm.runInContext(patchConversationClient(source), context);
  const todos = Object.freeze([
    Object.freeze({ content: '已经验证', status: 'completed' }),
    Object.freeze({ content: '完成最终证据绑定复核', status: 'in_progress' }),
  ]);
  const render = (connected, running) => {
    const dock = context.TodoDock({
      useProjection: key => { assert.equal(key, 'todos'); return todos; },
      session: { running },
      connectionStatus: { subscribe() {}, getSnapshot: () => connected ? {} : undefined },
      t: (key, values) => key + ':' + Object.values(values ?? {}).join(','),
    });
    assert.equal(dock.props.todos, todos);
    const panel = context.TodoPanel(dock.props);
    const [header, list] = panel.props.children.props.children;
    const progress = header.props.children[2].props.children;
    const items = list.props.children;
    const statusGlyph = items[1].props.children[0].props.children;
    return { panel, progress, items, glyph: context.StatusGlyph(statusGlyph.props) };
  };
  const active = render(true, true);
  assert.equal(active.panel.props['data-forge-todo-execution'], 'running');
  assert.match(active.progress, /todo.progress.active:1/);
  assert.equal(active.glyph.type, 'spinning-glyph');

  // A completed/aborted/error turn leaves the host todo unchanged but stops animation.
  const idle = render(true, false);
  assert.equal(idle.panel.props['data-forge-todo-execution'], 'idle');
  assert.match(idle.progress, /todo.progress.idle:1/);
  assert.doesNotMatch(idle.progress, /todo.progress.active/);
  assert.equal(idle.glyph.type, 'static-glyph');
  assert.equal(idle.items[1].props['data-status'], 'in_progress');
  assert.equal(context.StatusGlyph(idle.items[0].props.children[0].props.children.props).type, 'completed-glyph');

  for (const running of [true, false]) {
    const disconnected = render(false, running);
    assert.equal(disconnected.panel.props['data-forge-todo-execution'], 'unknown');
    assert.match(disconnected.progress, /todo.progress.unknown:1/);
    assert.doesNotMatch(disconnected.progress, /todo.progress.active|todo.progress.idle/);
    assert.equal(disconnected.glyph.type, 'static-glyph');
  }
  assert.equal(render(true, true).glyph.type, 'spinning-glyph');
  assert.equal(todos[1].status, 'in_progress');
});

test('todo dock receives the real connection store and supports existing history-patched clients', () => {
  const patched = patchConversationClient(source);
  const historyPatched = patched.replace('function ChatView({ connectionStatus,',
    'function ChatView({ loadQuestionHistory, jumpQuestion, connectionStatus,');
  assert.equal(patchConversationClient(historyPatched), historyPatched);
  assert.throws(() => patchConversationClient(patched.replace('session.running === true', 'false')),
    /Incomplete todo execution status patch/);
  let injected;
  const connection = { hostDescription: { subscribe() {}, getSnapshot() {} } };
  const context = vm.createContext({ NS: 'conversation', ctx: { connection, slots: {
    inject: (_name, callback) => callback(), register: (options) => { injected = options.inject(); },
  } } });
  vm.runInContext(patched + '\ntodoDockEntry.apply(ctx);', context);
  assert.equal(injected.connectionStatus, connection.hostDescription);
});
