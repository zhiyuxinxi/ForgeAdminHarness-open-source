import { createHash } from 'node:crypto';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const FILE_TYPES = new Map([
  ['json', ['json', 'application/json']], ['html', ['html', 'text/html']],
  ['htm', ['html', 'text/html']], ['sql', ['sql', 'text/plain']],
  ['md', ['md', 'text/markdown']], ['markdown', ['md', 'text/markdown']],
  ['text', ['txt', 'text/plain']], ['txt', ['txt', 'text/plain']],
]);

export class ConversationOutputError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function invalid(message) {
  throw new ConversationOutputError('OUTPUT_HISTORY_INVALID', message, 502);
}

// Use the same credential forms already removed from Host diagnostics. The
// export never includes request/header, tool-private metadata or environments.
export function redactConversationOutput(value, secrets = []) {
  let text = String(value)
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/giu, 'Bearer [REDACTED]')
    .replace(/((?:["']?(?:password|passwd|token|secret|api[ _-]?key|密码|口令)["']?)\s*[=:：]\s*)(["'])[^"'\r\n]*\2/giu, '$1$2[REDACTED]$2')
    .replace(/((?:["']?(?:password|passwd|token|secret|api[ _-]?key|密码|口令)["']?)\s*[=:：]\s*)[^\s,"'}]+/giu, '$1[REDACTED]');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[REDACTED]');
  }
  return text;
}

function textContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    if (block?.type === 'tool-result') return textContent(block.content);
    if (block?.type === 'image' || block?.type === 'file') return '[附件：原件按对话资料权限保留]';
    return '';
  }).filter(Boolean).join('\n');
}

function endStatus(reason) {
  if (reason?.kind === 'completed') return 'completed';
  if (['cancelled', 'canceled', 'aborted', 'stopped'].includes(reason?.kind)) return 'stopped';
  return 'failed';
}

export function projectConversationOutput(history, { secrets = [] } = {}) {
  if (!history || !SESSION_ID.test(history.session?.sessionId ?? '')
    || history.session?.cwd !== '/workspace' || !Array.isArray(history.events)) {
    invalid('对话历史身份无效，未保存记录。');
  }
  const entries = [];
  const files = [];
  const pending = new Map();
  let status = 'empty';
  let previousSeq = -1;
  let outputBytes = 0;
  const clean = (value) => {
    const text = redactConversationOutput(value, secrets);
    outputBytes += Buffer.byteLength(text, 'utf8');
    if (outputBytes > MAX_OUTPUT_BYTES) {
      throw new ConversationOutputError('OUTPUT_TOO_LARGE', '本次记录超过保存上限，原对话仍保留，请分段整理后保存。', 413);
    }
    return text;
  };
  for (const event of history.events) {
    if (!Number.isSafeInteger(event?.seq) || event.seq < 0 || event.seq <= previousSeq
      || typeof event.type !== 'string') invalid('对话事件顺序无效，未保存记录。');
    previousSeq = event.seq;
    const data = event.data ?? {};
    const base = { seq: event.seq, type: event.type,
      ...(Number.isSafeInteger(data.turn) ? { turn: data.turn } : {}) };
    if (event.type === 'turn/start') {
      status = 'running';
      entries.push({ ...base, status: 'running' });
    } else if (event.type === 'turn/end') {
      status = endStatus(data.reason);
      entries.push({ ...base, status, text: clean(data.reason?.message ?? data.reason?.error?.message ?? '') });
    } else if (event.type === 'user/message' || event.type === 'assistant/message') {
      const message = data.message ?? data;
      const role = event.type === 'assistant/message' ? 'assistant'
        : ['user', 'human'].includes(message.source?.kind) ? 'user' : 'context';
      const text = clean(textContent(message.content));
      entries.push({ ...base, role, text, ...(data.interrupted === true ? { status: 'stopped' } : {}) });
      if (role === 'assistant' && text !== '') {
        files.push({ name: `assistant-${event.seq}.md`, mediaType: 'text/markdown', content: text });
        let blockIndex = 0;
        for (const match of text.matchAll(/^```([a-zA-Z]+)[^\r\n]*\r?\n([\s\S]*?)^```\s*$/gmu)) {
          const format = FILE_TYPES.get(match[1].toLowerCase());
          if (format === undefined) continue;
          blockIndex += 1;
          files.push({ name: `assistant-${event.seq}-${blockIndex}.${format[0]}`, mediaType: format[1], content: match[2] });
        }
      }
    } else if (event.type === 'tool/call') {
      const entry = { ...base, toolName: clean(data.name ?? '工具'), callId: clean(data.callId ?? ''),
        text: clean(data.arguments ?? ''), status: 'pending' };
      entries.push(entry);
      pending.set(data.callId, entry);
    } else if (event.type === 'tool/result') {
      const message = data.message ?? {};
      const callId = message.source?.callId;
      const block = message.content?.find((value) => value?.type === 'tool-result');
      const resultStatus = block?.isError || data.error ? 'failed' : 'completed';
      // Native compaction replacements retain old call IDs. Preserve their
      // provenance without settling a pending execution a second time.
      const replacement = event.surfaceOp?.op === 'replace';
      if (!replacement && pending.has(callId)) {
        pending.get(callId).status = resultStatus;
        pending.delete(callId);
      }
      entries.push({ ...base, type: replacement ? 'tool/result-replacement' : event.type,
        callId: clean(callId ?? ''), text: clean(textContent(message.content)), status: resultStatus });
    } else if (['agent/error', 'agent-error', 'llm/retry', 'compaction/summary'].includes(event.type)) {
      entries.push({ ...base, text: clean(data.message ?? data.error?.message ?? data.summary ?? '') });
    }
  }
  if (status === 'empty' && entries.length > 0) status = history.session.running ? 'running' : 'completed';
  return Object.freeze({
    schemaVersion: 'forge-conversation-output/v1', sessionId: history.session.sessionId,
    status, firstSeq: history.events[0]?.seq ?? 0, lastSeq: history.events.at(-1)?.seq ?? 0,
    eventCount: history.events.length,
    eventDigest: createHash('sha256').update(JSON.stringify(history.events)).digest('hex'),
    entries, files,
  });
}
