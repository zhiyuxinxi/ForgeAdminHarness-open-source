import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = "forge-compaction-budget-v1";
const SELECTION_MARKER = 'forge-compaction-model-selection-v2';
const RECOVERY_MARKER = 'forge-compaction-recovery-v1';
const PROGRESS_MARKER = 'forge-compaction-progress-v2';
const EDITS = [
  [
    "var BasicCompactionEngine = class extends CompactionEngine {",
    "// forge-compaction-budget-v1: use the pinned native estimator for the full replay envelope, including metadata. This is a budget estimate, not exact tokenization.\nfunction forgeSerializedTokens(engine, value) {\n\treturn engine.ctx.tokenMeter.estimateMessage({ role: \"user\", content: [{ type: \"text\", text: JSON.stringify(value) }] });\n}\nfunction forgeRequestTokens(engine, session, pending, maxTokens) {\n\tconst input = buildSummarizationInput(session, session.surface.nodes);\n\treturn forgeSerializedTokens(engine, { ...input, messages: [...input.messages, ...pending] }) + maxTokens + 1024;\n}\nasync function forgeModelBudget(engine, agent, signal, summary = false) {\n\tconst routed = routedTarget(agent.session);\n\tif (routed === void 0) return null;\n\tconst policy = resolveTargetPolicy(engine.config, routed);\n\tconst target = summary && policy.summarizationProvider.length > 0 ? { provider: policy.summarizationProvider, model: policy.summarizationModel } : routed;\n\tconst context = (await engine.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context;\n\tif (context === void 0) return null;\n\treturn { window: resolveCompactSpec(policy, context.contextWindow).thresholdTokens, maxTokens: summary ? policy.maxTokens : Math.max(policy.maxTokens, agent.session.requestHeader()?.config.maxTokens ?? 0) };\n}\nasync function forgeBoundedRange(engine, agent, start, end, signal) {\n\tconst budget = await forgeModelBudget(engine, agent, signal, true);\n\tif (budget === null) throw new Error(\"compaction: no model context capacity for bounded summary\");\n\tconst nodes = agent.session.surface.nodes;\n\tconst first = nodes.indexOf(start), last = nodes.indexOf(end);\n\tif (first !== 0 || last < first) throw new Error(\"compaction: expected a current head-anchored prefix\");\n\tlet selected = null;\n\tconst input = buildSummarizationInput(agent.session, []);\n\tlet bytes = forgeSerializedTokens(engine, { ...input, messages: [{ role: \"user\", content: [{ type: \"text\", text: COMPACTION_INSTRUCTION }] }] }) + budget.maxTokens + 1024;\n\tfor (let index = first; index <= last; index += 1) {\n\t\tconst message = agent.session.deriveEventMessage(agent.session.events[nodes[index]]);\n\t\tif (message !== null) bytes += forgeSerializedTokens(engine, message) + 1;\n\t\tif (bytes > budget.window) break;\n\t\tif (toolPairingBalancedAfter(agent.session, nodes[index])) selected = { start, end: nodes[index] };\n\t}\n\tif (selected === null) throw new Error(\"compaction: no complete tool-balanced prefix fits the model context budget\");\n\treturn selected;\n}\nvar BasicCompactionEngine = class extends CompactionEngine {",
    1
  ],
  [
    "\t\tctx.on(\"agent/pre-step\", async ({ agent, signal }, next) => {\n\t\t\tif (!signal.aborted) try {\n\t\t\t\tconst result = await this.compactIfNeeded(agent, \"pressure\", signal);\n\t\t\t\tif (result !== null) logResult(result, \"step pressure\");\n\t\t\t} catch (error) {\n\t\t\t\tif (error instanceof TargetPressureConfigError) {\n\t\t\t\t\tif (this.warnedPressureConfigTargets.has(error.targetKey)) return next();\n\t\t\t\t\tthis.warnedPressureConfigTargets.add(error.targetKey);\n\t\t\t\t}\n\t\t\t\tconst message = error instanceof Error ? error.message : String(error);\n\t\t\t\tctx.logger.warn(`step compaction failed: ${message}; continuing the turn`);\n\t\t\t}\n\t\t\treturn next();\n\t\t});",
    "\t\tctx.on(\"agent/pre-step\", async ({ agent, signal }, next) => {\n\t\t\tconst decision = await next();\n\t\t\tif (decision.kind !== \"enter\" || signal.aborted) return decision;\n\t\t\tlet failure;\n\t\t\ttry {\n\t\t\t\tconst result = await this.compactIfNeeded(agent, \"pressure\", signal, decision.messages);\n\t\t\t\tif (result !== null) logResult(result, \"step pressure\");\n\t\t\t} catch (error) { failure = error; }\n\t\t\tconst budget = await forgeModelBudget(this, agent, signal);\n\t\t\tif (budget !== null && forgeRequestTokens(this, agent.session, decision.messages, budget.maxTokens) > budget.window) {\n\t\t\t\t// The inbox already claimed these messages. Preserve the same original history transaction.\n\t\t\t\tfor (const message of decision.messages) agent.session.append(\"user/message\", message, { surfaceOp: \"append\" });\n\t\t\t\tthrow failure ?? new Error(\"compaction: pending request still exceeds the model context budget; original messages preserved for continuation\");\n\t\t\t}\n\t\t\tif (failure !== void 0) ctx.logger.warn(`step compaction failed: ${failure instanceof Error ? failure.message : String(failure)}; request remains within the model context budget`);\n\t\t\treturn decision;\n\t\t});",
    1
  ],
  [
    "async compactIfNeeded(agent, trigger, signal) {",
    "async compactIfNeeded(agent, trigger, signal, pending = []) {",
    1
  ],
  [
    "const spec = resolveCompactSpec(policy, context.contextWindow);",
    "const spec = resolveCompactSpec(policy, context.contextWindow);\n\t\tconst requestMaxTokens = Math.max(policy.maxTokens, agent.session.requestHeader()?.config.maxTokens ?? 0);\n\t\tconst fitsRequest = () => forgeRequestTokens(this, agent.session, pending, requestMaxTokens) <= spec.thresholdTokens;",
    1
  ],
  [
    "if (measurement.totalTokens < spec.thresholdTokens) return null;",
    "if (measurement.totalTokens < spec.thresholdTokens && fitsRequest()) return null;",
    2
  ],
  [
    "const range = selectCompactableRange(agent.session, measurement, spec.retainTokens);",
    "const nodes = agent.session.surface.nodes;\n\t\t\tconst range = pending.length > 0 && !fitsRequest() && nodes.length > 0 && toolPairingBalancedAfter(agent.session, nodes[nodes.length - 1]) ? { start: nodes[0], end: nodes[nodes.length - 1] } : selectCompactableRange(agent.session, measurement, spec.retainTokens);",
    1
  ],
  [
    "if (measurement.totalTokens < spec.thresholdTokens) return result;",
    "if (measurement.totalTokens < spec.thresholdTokens && fitsRequest()) return result;",
    1
  ],
  [
    "\tasync compactRegion(start, end, agent, signal) {\n\t\treturn compactSurfaceRegion",
    "\tasync compactRegion(start, end, agent, signal) {\n\t\t({ start, end } = await forgeBoundedRange(this, agent, start, end, signal));\n\t\treturn compactSurfaceRegion",
    1
  ],
  [
    "\t\t\t\t\treturn await compactSurfaceRegion(this.regionDependencies(), agent.session, range.start, range.end, agent, {",
    "\t\t\t\t\tconst bounded = await forgeBoundedRange(this, agent, range.start, range.end, operationSignal);\n\t\t\t\t\treturn await compactSurfaceRegion(this.regionDependencies(), agent.session, bounded.start, bounded.end, agent, {",
    1
  ],
  [
    "for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {",
    "// Successful bounded prefixes are finite work, not retries of a failed request.\n\t\tconst segmentLimit = agent.session.surface.nodes.length;\n\t\tfor (let segment = 0; segment < segmentLimit; segment += 1) {",
    1
  ],
  [
    "result = await this.compactRegion(range.start, range.end, agent, signal);",
    "const beforeTokens = forgeRequestTokens(this, agent.session, pending, requestMaxTokens);\n\t\t\tresult = await this.compactRegion(range.start, range.end, agent, signal);\n\t\t\tif (forgeRequestTokens(this, agent.session, pending, requestMaxTokens) >= beforeTokens) throw new Error(\"compaction: summary did not strictly reduce the serialized request estimate\");",
    1
  ],
  [
    "throw new Error(`compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts (${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`);",
    "throw new Error(`compaction still above threshold or serialized budget after ${segmentLimit} bounded prefix segments (${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`);",
    1
  ]
];

export function patchLegacyCompactionBudget(source) {
  if (source.includes(MARKER)) {
    for (const [, after, count] of EDITS) if (source.split(after).length - 1 !== count) throw new Error("Incomplete compaction budget patch");
    return source;
  }
  for (const [before, , count] of EDITS) if (count < 1 || source.split(before).length - 1 !== count) throw new Error("Unsupported upstream compaction budget anchor");
  for (const [before, after] of EDITS) source = source.split(before).join(after);
  return source;
}

const SELECTION_EDITS = [
  ['const latest = agent.session.requestHeader()?.config;', 'const latest = forgeRoutedTarget(agent);', 1],
  ['const routed = routedTarget(agent.session);', 'const routed = forgeRoutedTarget(agent);', 2],
  ['const target = routedTarget(agent.session);', 'const target = forgeRoutedTarget(agent);', 2],
  ['function routedTarget(session) {', `// ${SELECTION_MARKER}: read the active selection without rewriting the durable request history.
function forgeRoutedTarget(agent) {
\tconst read = agent[Symbol.for("forge.current-model-selection.v1")];
\tconst selected = typeof read === "function" ? read() : void 0;
\tif (selected !== void 0 && typeof selected.provider === "string" && selected.provider.length > 0 && typeof selected.model === "string" && selected.model.length > 0) return { provider: selected.provider, model: selected.model };
\treturn routedTarget(agent.session);
}
function routedTarget(session) {`, 1],
];

const AGENT_SELECTION_EDITS = [
  ['function installModelSelection(agentCtx, selection) {', `function installModelSelection(agentCtx, selection) {
\t// ${SELECTION_MARKER}: maintenance runs before request assembly and needs the same live selection.
\tconst modelOwner = agentCtx.agent;
\tconst selectionKey = Symbol.for("forge.current-model-selection.v1");
\tconst readSelection = () => selection.current;
\tconst previousSelection = modelOwner === void 0 ? void 0 : Object.getOwnPropertyDescriptor(modelOwner, selectionKey);
\tif (modelOwner !== void 0) Object.defineProperty(modelOwner, selectionKey, { configurable: true, value: readSelection });`, 1],
  ['\treturn () => {\n\t\tdisposeAssembly();\n\t\tdisposeRequest();\n\t};', `\treturn () => {
\t\tdisposeAssembly();
\t\tdisposeRequest();
\t\tif (modelOwner !== void 0 && modelOwner[selectionKey] === readSelection) {
\t\t\tif (previousSelection === void 0) delete modelOwner[selectionKey];
\t\t\telse Object.defineProperty(modelOwner, selectionKey, previousSelection);
\t\t}
\t};`, 1],
];

export function patchAgentModelSelection(source) {
  if (source.includes(SELECTION_MARKER)) {
    for (const [, after, count] of AGENT_SELECTION_EDITS) if (source.split(after).length - 1 !== count) throw new Error('Incomplete agent model selection patch');
    return source;
  }
  for (const [before, , count] of AGENT_SELECTION_EDITS) if (source.split(before).length - 1 !== count) throw new Error('Unsupported upstream agent model selection anchor');
  for (const [before, after] of AGENT_SELECTION_EDITS) source = source.split(before).join(after);
  return source;
}

function patchCompactionSelection(source) {
  if (source.includes(SELECTION_MARKER)) {
    let legacy = source;
    for (const [before, after, count] of SELECTION_EDITS) {
      if (legacy.split(after).length - 1 !== count) throw new Error('Incomplete compaction model selection patch');
      legacy = legacy.split(after).join(before);
    }
    if (patchLegacyCompactionBudget(legacy) !== legacy) throw new Error('Incomplete legacy compaction budget patch');
    return source;
  }
  source = patchLegacyCompactionBudget(source);
  for (const [before, , count] of SELECTION_EDITS) if (source.split(before).length - 1 !== count) throw new Error('Unsupported compaction model selection anchor');
  for (const [before, after] of SELECTION_EDITS) source = source.split(before).join(after);
  return source;
}

const RECOVERY_HELPER = `// ${RECOVERY_MARKER}: only repeat the summary stream, never the agent/tool loop.
async function forgeSummaryStream(ctx, options, agent) {
\tconst defaults = resolveRetryPolicy(void 0, "compaction retry policy");
\tconst configured = ctx.llm.providerRetryPolicy?.(options.provider) ?? defaults;
\t// An unbounded interactive policy must not make context maintenance unbounded.
\tconst policy = configured.mode === "normal" ? configured : { ...configured, mode: "normal", maxRetries: defaults.maxRetries, retryableCodes: defaults.retryableCodes };
\tconst signal = options.signal;
\tconst retryId = randomUUID();
\tconst turn = agent.session.events.findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
\tconst step = agent.session.events.findLast((event) => event.type === "step/start" && event.data.turn === turn)?.data.step ?? 0;
\tconst policyKey = JSON.stringify(["compaction", retryId, policy]);
\tfor (let retry = 0; ; retry += 1) {
\t\tsignal?.throwIfAborted();
\t\ttry {
\t\t\tconst assembler = new BlockAssembler();
\t\t\tfor await (const chunk of ctx.llm.stream(options)) {
\t\t\t\tsignal?.throwIfAborted();
\t\t\t\tassembler.push(chunk);
\t\t\t}
\t\t\tsignal?.throwIfAborted();
\t\t\tconst failure = finishError(assembler.finish);
\t\t\tif (failure !== void 0) throw failure;
\t\t\treturn assembler;
\t\t} catch (error) {
\t\t\tsignal?.throwIfAborted();
\t\t\tconst typed = error instanceof LlmError ? error : new LlmError(error instanceof Error ? error.message : String(error), error?.name === "AbortError" ? "ABORTED" : typeof error?.code === "string" ? error.code : "UNKNOWN", { cause: error });
\t\t\tconst failure = typed.failure;
\t\t\tconst canRetry = defaults.retryableCodes.includes(failure.code) && policy.retryableCodes.includes(failure.code) && retry < policy.maxRetries;
\t\t\tconst retryAfter = failure.providerRetryAfterMs;
\t\t\tif (!canRetry || (retryAfter !== void 0 && retryAfter > policy.maxDelayMs)) {
\t\t\t\tthrow new LlmError(\`上下文整理失败（\${failure.code}，已自动重试 \${retry} 次）；原始会话与已有修改已保留，可继续原任务。原因：\${failure.message}\`, failure.code, { ...failure, cause: typed });
\t\t\t}
\t\t\tconst exponential = Math.min(policy.initialDelayMs * 2 ** Math.min(retry, 1024), policy.maxDelayMs);
\t\t\tconst delayMs = retryAfter ?? Math.min(exponential * (1 - policy.jitterRatio + 2 * policy.jitterRatio * Math.random()), policy.maxDelayMs);
\t\t\tagent.session.append("llm/retry", { retryId, turn, step, provider: options.provider, mode: "normal", policyKey, retry: retry + 1, maxRetries: policy.maxRetries, delayMs, failure });
\t\t\tawait ctx.sessions.flush(agent.session);
\t\t\tawait new Promise((resolve, reject) => {
\t\t\t\tconst onAbort = () => { clearTimeout(timer); reject(signal.reason); };
\t\t\t\tconst timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delayMs);
\t\t\t\tsignal?.addEventListener("abort", onAbort, { once: true });
\t\t\t\tif (signal?.aborted) onAbort();
\t\t\t});
\t\t\tsignal?.throwIfAborted();
\t\t\tagent.session.append("llm/retry-started", { retryId, turn, step, retry: retry + 1 });
\t\t}
\t}
}
`;

const RECOVERY_EDITS = [
  ['createUserMessage, deepFreeze, errorChain } from "@deepseek-ai/dsh-llm";', 'createUserMessage, deepFreeze, errorChain, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";'],
  ['async function summarizeWithLlm(ctx, config, input, agent, signal) {', `${RECOVERY_HELPER}async function summarizeWithLlm(ctx, config, input, agent, signal) {`],
  ['\tconst assembler = new BlockAssembler();\n\tconst messages = [...input.messages, createUserMessage({', '\tconst messages = [...input.messages, createUserMessage({'],
  ['\tfor await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);\n\tconst error = finishError(assembler.finish);\n\tif (error !== void 0) throw error;', '\tconst assembler = await forgeSummaryStream(ctx, options, agent);'],
  ['\t\tcase "error":\n\t\tcase "aborted": {\n\t\t\tconst error = new Error(finish.failure.message);\n\t\t\terror.code = finish.failure.code;\n\t\t\treturn error;\n\t\t}', '\t\tcase "error":\n\t\t\treturn new LlmError(finish.failure.message, finish.failure.code, finish.failure);\n\t\tcase "aborted":\n\t\t\treturn new LlmError(finish.failure.message, "ABORTED", finish.failure);'],
];

function patchCompactionRecovery(source) {
  if (source.includes(RECOVERY_MARKER)) {
    let previous = source;
    for (const [before, after] of RECOVERY_EDITS) {
      if (previous.split(after).length - 1 !== 1) throw new Error('Incomplete compaction recovery patch');
      previous = previous.replace(after, before);
    }
    if (patchCompactionSelection(previous) !== previous) throw new Error('Incomplete compaction selection patch');
    return source;
  }
  source = patchCompactionSelection(source);
  for (const [before] of RECOVERY_EDITS) if (source.split(before).length - 1 !== 1) throw new Error('Unsupported compaction recovery anchor');
  for (const [before, after] of RECOVERY_EDITS) source = source.replace(before, after);
  return source;
}

const PROGRESS_HELPERS = `// ${PROGRESS_MARKER}: pressure is advisory; capacity and original-node progress are hard bounds.
class ForgeCompactionNoProgressError extends Error {}
function forgeRequestMaxTokens(agent, target, modelInfo, fallback) {
\tconst header = agent.session.requestHeader();
\tconst sameTarget = header?.config.provider === target.provider && header.config.model === target.model;
\t// Adapter defaults belong to their exact model, not the previous request's model.
\tconst explicit = agent.options.maxTokens ?? (sameTarget && header?.adapterDefaults?.maxTokens !== true ? header?.config.maxTokens : void 0);
\treturn explicit ?? modelInfo.defaultMaxTokens ?? fallback;
}
async function forgeModelBudget(engine, agent, signal, summary = false) {
\tconst routed = forgeRoutedTarget(agent);
\tif (routed === void 0) return null;
\tconst policy = resolveTargetPolicy(engine.config, routed);
\tconst target = summary && policy.summarizationProvider.length > 0 ? { provider: policy.summarizationProvider, model: policy.summarizationModel } : routed;
\tconst modelInfo = await engine.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
\tif (modelInfo.context === void 0) return null;
\treturn { window: modelInfo.context.contextWindow, preferredWindow: Math.floor(modelInfo.context.contextWindow * policy.thresholdRatio), maxTokens: summary ? policy.maxTokens : forgeRequestMaxTokens(agent, target, modelInfo, policy.maxTokens) };
}`;

const PROGRESS_PRE_STEP = `\t\tctx.on("agent/pre-step", async ({ agent, signal }, next) => {
\t\t\tconst decision = await next();
\t\t\tif (decision.kind !== "enter" || signal.aborted) return decision;
\t\t\ttry {
\t\t\t\tlet noProgress;
\t\t\t\ttry {
\t\t\t\t\tconst result = await this.compactIfNeeded(agent, "pressure", signal, decision.messages);
\t\t\t\t\tif (result !== null) logResult(result, "step pressure");
\t\t\t\t} catch (error) {
\t\t\t\t\tsignal.throwIfAborted();
\t\t\t\t\tif (!(error instanceof ForgeCompactionNoProgressError)) throw error;
\t\t\t\t\tnoProgress = error;
\t\t\t\t}
\t\t\t\tconst budget = await forgeModelBudget(this, agent, signal);
\t\t\t\tsignal.throwIfAborted();
\t\t\t\tif (budget === null && noProgress !== void 0) throw noProgress;
\t\t\t\tif (budget !== null) {
\t\t\t\t\tconst estimated = forgeRequestTokens(this, agent.session, decision.messages, budget.maxTokens);
\t\t\t\t\tif (estimated > budget.window) throw new Error(\x60compaction: request estimate \x24{estimated} exceeds model context capacity \x24{budget.window}; original messages preserved for continuation\x24{noProgress === void 0 ? "" : "; " + noProgress.message}\x60, { cause: noProgress });
\t\t\t\t}
\t\t\t\tif (noProgress !== void 0) ctx.logger.warn(\x60step compaction made no progress: \x24{noProgress.message}; original context remains within model capacity, continuing the request\x60);
\t\t\t\treturn decision;
\t\t\t} catch (error) {
\t\t\t\t// The inbox already claimed these messages; preserve their identities and sources once.
\t\t\t\tfor (const message of decision.messages) agent.session.append("user/message", message, { surfaceOp: "append" });
\t\t\t\tthrow error;
\t\t\t}
\t\t});`;

const PROGRESS_EDITS = [
  [EDITS[0][1].slice(EDITS[0][1].indexOf('async function forgeModelBudget('), EDITS[0][1].indexOf('async function forgeBoundedRange(')).trimEnd().replace('const routed = routedTarget(agent.session);', 'const routed = forgeRoutedTarget(agent);'), PROGRESS_HELPERS],
  [EDITS[1][1], PROGRESS_PRE_STEP],
  ['async function forgeBoundedRange(engine, agent, start, end, signal) {', 'async function forgeBoundedRange(engine, agent, start, end, signal, requireOriginal = false) {'],
  ['\tlet selected = null;\n\tconst input = buildSummarizationInput(agent.session, []);', '\tlet selected = null;\n\tlet preferred = null;\n\tlet includesOriginal = false;\n\tconst input = buildSummarizationInput(agent.session, []);'],
  ['\t\tif (toolPairingBalancedAfter(agent.session, nodes[index])) selected = { start, end: nodes[index] };', '\t\tif (message !== null && !(message.source?.kind === "plugin" && message.source.plugin === "compact")) includesOriginal = true;\n\t\tif ((!requireOriginal || includesOriginal) && toolPairingBalancedAfter(agent.session, nodes[index])) {\n\t\t\tselected = { start, end: nodes[index] };\n\t\t\tif (bytes <= budget.preferredWindow) preferred = selected;\n\t\t}'],
  ['\treturn selected;\n}\nvar BasicCompactionEngine', '\treturn preferred ?? selected;\n}\nvar BasicCompactionEngine'],
  ['if (selected === null) throw new Error("compaction: no complete tool-balanced prefix fits the model context budget");', 'if (selected === null) throw new ForgeCompactionNoProgressError("compaction: no complete tool-balanced prefix containing new original history fits the summary model capacity");'],
  ['({ start, end } = await forgeBoundedRange(this, agent, start, end, signal));', '({ start, end } = await forgeBoundedRange(this, agent, start, end, signal, true));'],
  ['const requestMaxTokens = Math.max(policy.maxTokens, agent.session.requestHeader()?.config.maxTokens ?? 0);', 'const requestMaxTokens = (await forgeModelBudget(this, agent, signal)).maxTokens;'],
  ['if (framedSummaryTokenCount >= prepared.shadowedTokenCount) throw new Error(', 'if (framedSummaryTokenCount >= prepared.shadowedTokenCount) throw new ForgeCompactionNoProgressError('],
  ['throw new Error("compaction: summary did not strictly reduce the serialized request estimate");', 'throw new ForgeCompactionNoProgressError("compaction: summary did not strictly reduce the serialized request estimate");'],
  ['throw new Error(`compaction still above threshold or serialized budget after ${segmentLimit} bounded prefix segments (${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`);', 'throw new ForgeCompactionNoProgressError(`compaction remains above the advisory threshold after ${segmentLimit} bounded prefix segments (${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`);'],
];

export function patchCompactionBudget(source) {
  if (source.includes(PROGRESS_MARKER)) {
    let previous = source;
    for (const [before, after] of [...PROGRESS_EDITS].reverse()) {
      if (previous.split(after).length - 1 !== 1) throw new Error('Incomplete compaction progress patch');
      previous = previous.replace(after, before);
    }
    if (patchCompactionRecovery(previous) !== previous) throw new Error('Incomplete compaction recovery patch');
    return source;
  }
  source = patchCompactionRecovery(source);
  for (const [before] of PROGRESS_EDITS) if (source.split(before).length - 1 !== 1) throw new Error('Unsupported compaction progress anchor');
  for (const [before, after] of PROGRESS_EDITS) source = source.replace(before, after);
  return source;
}

export function applyPatch(root) {
  const packages = [
    ['@deepseek-ai/dsh-agent', patchAgentModelSelection],
    ['@deepseek-ai/dsh-compaction-basic', patchCompactionBudget],
  ].map(([name, transform]) => {
    const directory = resolve(root, name);
    const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
    if (pkg.name !== name || pkg.version !== '0.1.1-rc.2') throw new Error('Unsupported Harness compaction dependency: ' + name);
    const file = resolve(directory, 'lib/index.js');
    const before = readFileSync(file, 'utf8');
    return { name, file, before, after: transform(before) };
  });
  // Validate both pinned inputs before either file is changed.
  for (const item of packages) if (item.after !== item.before) writeFileSync(item.file, item.after);
  return { patch: PROGRESS_MARKER, changed: packages.some((item) => item.after !== item.before),
    packages: packages.map(({ name, before, after }) => ({ name, changed: before !== after })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node forge-compaction-budget-patch.mjs NODE_MODULES_ROOT');
  console.log(JSON.stringify(applyPatch(process.argv[2])));
}
