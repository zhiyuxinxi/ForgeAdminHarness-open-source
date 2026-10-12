// Browser-only history projection. The durable log and model context are untouched.
export const QUESTION_HISTORY_VERSION = 'forge-question-history-v2';
const SEARCH_PAGE_SIZE = 20;
const SUMMARY_PAGE_SIZE = 30;
const DETAIL_PAGE_SIZE = 160;
const STRUCTURE = new Set(['turn/start', 'turn/end', 'turn/error', 'step/start', 'step/end']);
const DETAIL_TYPES = new Set([...STRUCTURE, 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'llm/retry']);
export function messageOf(event) { return event?.data?.message ?? event?.data; }
export function isQuestion(event) {
  return event?.type === 'user/message' && messageOf(event)?.source?.kind === 'user'
    && event.surfaceOp?.kind !== 'replace';
}
export function questionText(event) {
  const content = messageOf(event)?.content;
  return (typeof content === 'string' ? content : (content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n'));
}
const normalized = text => text.normalize('NFKC').toLocaleLowerCase().trim();
const meaningfulAssistant = e => e.type === 'assistant/message' && (messageOf(e)?.content ?? []).some(x => x.type === 'text' && x.text?.trim());
function withMetadata(event, metadata) {
  const data = event.data.message
    ? { ...event.data, message: { ...event.data.message, forgeHistory: metadata } }
    : { ...event.data, forgeHistory: metadata };
  return { ...event, data };
}
function summaryAnswer(event) {
  if (event.type !== 'assistant/message') return event;
  const message = messageOf(event);
  const visible = { ...message, content: message.content.filter(x => x.type === 'text' || x.type === 'image') };
  return { ...event, data: event.data.message ? { ...event.data, message: visible } : visible };
}
function preparationStatus(events) {
  const calls = new Map();
  let status;
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data.name);
    if (event.type !== 'tool/result') continue;
    const message = messageOf(event), callId = message?.source?.callId ?? event.data.callId;
    if (calls.get(callId) !== 'prepare_task') continue;
    for (const block of message?.content ?? []) {
      const content = block.type === 'tool-result' && !block.isError ? block.content : [];
      for (const part of content ?? []) {
        if (part.type !== 'text' || typeof part.text !== 'string') continue;
        try {
          const value = JSON.parse(part.text);
          if (['prepared', 'needs-confirmation'].includes(value.status)) status = value.status;
        } catch { /* Non-JSON output cannot create a confirmation action. */ }
      }
    }
  }
  return status;
}
function projectQuestion(events, start, end, details, afterSeq) {
  const question = events[start];
  const relevant = events.slice(start, end).filter(e => DETAIL_TYPES.has(e.type) || e.type.startsWith('command/'));
  const finals = new Set(relevant.filter(meaningfulAssistant).map(event => event.seq));
  const summary = new Set([question.seq]);
  let stepStart;
  for (const event of relevant) {
    if (event.type === 'step/start') stepStart = event.seq;
    if (event.type.startsWith('turn/')) summary.add(event.seq);
    if (finals.has(event.seq)) { summary.add(event.seq); if (stepStart !== undefined) summary.add(stepStart); }
    if (event.type === 'step/end' && summary.has(stepStart)) summary.add(event.seq);
    if (isQuestion(event)) summary.add(event.seq);
  }
  const hidden = relevant.filter(e => !summary.has(e.seq));
  const page = details ? hidden.filter(e => afterSeq === undefined || e.seq > afterSeq).slice(0, DETAIL_PAGE_SIZE) : [];
  const selected = new Set([...summary, ...page.map(e => e.seq)]);
  const remaining = details && hidden.some(e => e.seq > (page.at(-1)?.seq ?? afterSeq ?? -1));
  const metadata = { questionSeq: question.seq, detailCount: hidden.length, loaded: details,
    needsConfirmation: preparationStatus(relevant) === 'needs-confirmation',
    nextDetailSeq: remaining ? page.at(-1)?.seq ?? afterSeq : null };
  const rows = relevant.filter(e => selected.has(e.seq)).map(e => e.seq === question.seq ? withMetadata(e, metadata) : details ? e : summaryAnswer(e));
  // Retain the observed tail watermark without transferring its potentially large payload.
  const tail = events[end - 1];
  if (tail && !selected.has(tail.seq)) rows.push({ type: 'forge/history-watermark', seq: tail.seq, time: tail.time, data: {}, ignorable: true });
  return rows;
}
export function questionHistory(events, request) {
  const questions = [];
  for (let i = 0; i < events.length; i++) if (isQuestion(events[i])) questions.push({ index: i, event: events[i] });
  const before = request.beforeSeq ?? Infinity;
  if (request.forgeView === 'questions') {
    const matches = questions.filter(q => q.event.seq < before).reverse();
    const selected = matches.slice(0, SEARCH_PAGE_SIZE);
    return { events: [], hasMore: false, forgeQuestions: {
      items: selected.map(({ event }) => ({ seq: event.seq, time: event.time, text: questionText(event).slice(0, 600) })),
      total: questions.length,
      nextCursor: matches.length > selected.length ? selected.at(-1).event.seq : null,
    } };
  }
  if (request.forgeView === 'search') {
    const query = normalized(request.query ?? '');
    const matches = query ? questions.filter(q => q.event.seq < before && normalized(questionText(q.event)).includes(query)).reverse() : [];
    const selected = matches.slice(0, SEARCH_PAGE_SIZE);
    return { events: [], hasMore: false, forgeSearch: { items: selected.map(({ event }) => ({ seq: event.seq, time: event.time, text: questionText(event).slice(0, 600) })),
      nextCursor: matches.length > selected.length ? selected.at(-1).event.seq : null } };
  }
  if (request.forgeView === 'details') {
    const position = questions.findIndex(q => q.event.seq === request.questionSeq);
    if (position < 0) throw new Error('Question is not present in this session');
    const start = questions[position].index;
    return { events: projectQuestion(events, start, questions[position + 1]?.index ?? events.length, true, request.detailAfterSeq), hasMore: position > 0 };
  }
  let selected = questions.filter(q => q.event.seq < before);
  selected = request.questionSeq === undefined ? selected.slice(-1) : selected.filter(q => q.event.seq >= request.questionSeq).slice(-SUMMARY_PAGE_SIZE);
  if (!selected.length) return { events: [], hasMore: false };
  const rows = selected.flatMap(q => {
    const position = questions.indexOf(q);
    const end = questions[position + 1]?.index ?? events.length;
    return projectQuestion(events, q.index, end, false);
  }).filter(e => e.seq < before);
  return { events: rows, hasMore: questions[0].event.seq < selected[0].event.seq };
}
