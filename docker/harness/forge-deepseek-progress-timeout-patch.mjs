import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'forge-deepseek-progress-timeout-v1';
const HELPER = `// ${MARKER}: generation progress excludes SSE heartbeats and empty metadata.
const FORGE_DEEPSEEK_NO_PROGRESS = "DEEPSEEK_NO_PROGRESS";
function forgeDeepSeekProgressWatchdog(idle, timeoutMs = 120000) {
\tif (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) throw new Error("llm-deepseek: streamProgressTimeoutMs must be a positive finite timer delay");
\tconst controller = new AbortController();
\tconst signal = AbortSignal.any([idle.signal, controller.signal]);
\tlet generation = false, pending = false, disposed = false;
\tlet remaining = timeoutMs, started = 0, timer;
\tconst clear = () => { clearTimeout(timer); timer = void 0; };
\tconst arm = () => {
\t\tclear();
\t\tif (generation && pending && !signal.aborted) timer = setTimeout(() => controller.abort(new TimeoutReason(FORGE_DEEPSEEK_NO_PROGRESS, timeoutMs)), Math.max(0, remaining));
\t};
\treturn {
\t\tsignal,
\t\tasync next(iterator) {
\t\t\tif (disposed || pending) throw new Error("DeepSeek progress watchdog is disposed or already reading");
\t\t\tsignal.throwIfAborted();
\t\t\tpending = true;
\t\t\tstarted = performance.now();
\t\t\tarm();
\t\t\ttry {
\t\t\t\tconst result = await idle.next(iterator);
\t\t\t\tsignal.throwIfAborted();
\t\t\t\tif (generation) {
\t\t\t\t\tconst chunk = result.value;
\t\t\t\t\tconst progress = !result.done && ((chunk.type === "text-delta" || chunk.type === "reasoning-delta") && typeof chunk.text === "string" && chunk.text.length > 0 || chunk.type === "tool-call-delta" && typeof chunk.argumentsDelta === "string" && chunk.argumentsDelta.length > 0);
\t\t\t\t\tremaining = progress ? timeoutMs : Math.max(0, remaining - (performance.now() - started));
\t\t\t\t}
\t\t\t\treturn result;
\t\t\t} finally { clear(); pending = false; }
\t\t},
\t\tactivity(kind) {
\t\t\tif (disposed) return;
\t\t\tif (kind === "preparation") { generation = false; clear(); }
\t\t\telse if (kind === "generation") { generation = true; remaining = timeoutMs; started = performance.now(); arm(); }
\t\t\telse if (kind === void 0) idle.pulse(); // Existing completed-upload activity only.
\t\t},
\t\t[Symbol.dispose]() { if (!disposed) { disposed = true; clear(); idle[Symbol.dispose](); } }
\t};
}
`;

const EDITS = [
  ['import { MAX_TIMER_DELAY_MS, deadline, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";', 'import { MAX_TIMER_DELAY_MS, TimeoutReason, deadline, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";'],
  ['var DeepSeekAdapter = class extends LlmAdapter {', `${HELPER}var DeepSeekAdapter = class extends LlmAdapter {`],
  ['idleWatchdog(options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]), connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE), false);', 'forgeDeepSeekProgressWatchdog(idleWatchdog(options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]), connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE), connection.streamProgressTimeoutMs), false);'],
  ['this.request(options, watchdog.signal, connection, apiKey, userId, attachments, () => {\n\t\t\t\twatchdog.pulse();', 'this.request(options, watchdog.signal, connection, apiKey, userId, attachments, (activity) => {\n\t\t\t\twatchdog.activity(activity);'],
  ['\t\t\t\tif (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) throw new LlmError', '\t\t\t\tif (timeoutOf(watchdog.signal, FORGE_DEEPSEEK_NO_PROGRESS) !== void 0) throw new LlmError(`DeepSeek 连续 ${connection.streamProgressTimeoutMs ?? 120000}ms 未返回有效内容，已结束本次模型请求；原会话和已完成的工具结果保留，可继续原任务。`, FORGE_DEEPSEEK_NO_PROGRESS, { cause: error });\n\t\t\t\tif (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) throw new LlmError'],
  ['\t\twhile (true) {\n\t\t\tconst usedFiles = [];', '\t\twhile (true) {\n\t\t\tonActivity("preparation");\n\t\t\tconst usedFiles = [];'],
  ['\t\t\tconst payload = JSON.stringify(body);\n\t\t\tlet response;', '\t\t\tconst payload = JSON.stringify(body);\n\t\t\tonActivity("generation");\n\t\t\tlet response;'],
  ['yield* translate(parseSse(response.body, onActivity));', 'yield* translate(parseSse(response.body));'],
  ['\tstreamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),', '\tstreamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),\n\tstreamProgressTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(120000),'],
  ['\tconst streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;', '\tconst streamProgressTimeoutMs = config.streamProgressTimeoutMs ?? 120000;\n\tif (!Number.isFinite(streamProgressTimeoutMs) || streamProgressTimeoutMs <= 0 || streamProgressTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-deepseek: streamProgressTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);\n\tconst streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;'],
  ['\t\tstreamIdleTimeoutMs,\n\t\tmaxRequestFilesBytes,', '\t\tstreamIdleTimeoutMs,\n\t\tstreamProgressTimeoutMs,\n\t\tmaxRequestFilesBytes,'],
];

/** Patch only the pinned DeepSeek adapter; native upload, transport and retry ownership stay intact. */
export function patchDeepSeekProgressTimeout(source) {
  if (source.includes(MARKER)) {
    if (source.split(MARKER).length !== 2 || EDITS.some(([, after]) => source.split(after).length !== 2)) {
      throw new Error('Incomplete DeepSeek progress timeout patch');
    }
    return source;
  }
  if (EDITS.some(([before]) => source.split(before).length !== 2)) throw new Error('Unsupported upstream DeepSeek progress timeout anchor');
  for (const [before, after] of EDITS) source = source.replace(before, after);
  return source;
}

export function applyPatch(root) {
  const directory = resolve(root, '@deepseek-ai/dsh-llm-deepseek');
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh-llm-deepseek' || pkg.version !== '0.1.1-rc.2') throw new Error('Unsupported DeepSeek adapter package');
  const file = resolve(directory, 'lib/index.js');
  const before = readFileSync(file, 'utf8');
  const after = patchDeepSeekProgressTimeout(before);
  if (after !== before) writeFileSync(file, after);
  return { patch: MARKER, changed: after !== before };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node forge-deepseek-progress-timeout-patch.mjs NODE_MODULES_ROOT');
  console.log(JSON.stringify(applyPatch(process.argv[2])));
}
