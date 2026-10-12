import { createHash } from 'node:crypto';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export class ForgeUiEditSessionError extends Error { constructor(code, message) { super(message); this.name = 'ForgeUiEditSessionError'; this.code = code; } }
function fail(code, message) { throw new ForgeUiEditSessionError(code, message); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, label) { if (!plain(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) fail('SCHEMA_INVALID', `${label} has unsupported or missing fields.`); }
function safe(value, label, pattern = SAFE) { if (typeof value !== 'string' || !pattern.test(value)) fail('SCHEMA_INVALID', `${label} is invalid.`); return value; }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (!plain(value)) return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); }
function digest(value) { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`; }
function freeze(value) { if (plain(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function fields(value, label, { allowEmpty = false } = {}) { if (!Array.isArray(value) || !allowEmpty && value.length === 0) fail('SCHEMA_INVALID', `${label} must be ${allowEmpty ? 'an array' : 'non-empty'}.`); const normalized = value.map((item) => { exact(item, ['field', 'valueSha256'], label); return { field: safe(item.field, `${label}.field`), valueSha256: safe(item.valueSha256, `${label}.valueSha256`, SHA256) }; }).sort((left, right) => left.field.localeCompare(right.field)); if (new Set(normalized.map((item) => item.field)).size !== normalized.length) fail('SCHEMA_INVALID', `${label} contains duplicate fields.`); return normalized; }
function seal(unsigned) { return freeze({ ...unsigned, sessionDigest: digest(unsigned) }); }
function validate(value) {
  exact(value, ['schemaVersion', 'sessionType', 'sessionId', 'recordId', 'requestEpoch', 'baselineFields', 'currentFields', 'dirtyFields', 'activeRefill', 'submit', 'revision', 'sessionDigest'], 'edit session');
  const unsigned = { ...value }; delete unsigned.sessionDigest;
  if (value.schemaVersion !== 1 || value.sessionType !== 'forge-ui/edit-session' || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Number.isSafeInteger(value.requestEpoch) || value.requestEpoch < 0 || digest(unsigned) !== value.sessionDigest) fail('SESSION_INTEGRITY_INVALID', 'edit session is invalid or tampered.');
  safe(value.sessionId, 'sessionId', UUID); safe(value.recordId, 'recordId');
  const baseline = fields(value.baselineFields, 'baselineFields', { allowEmpty: true }); const current = fields(value.currentFields, 'currentFields', { allowEmpty: true });
  if (value.activeRefill !== null) { exact(value.activeRefill, ['status', 'requestId', 'recordId', 'epoch'], 'activeRefill'); if (!['pending', 'resolved'].includes(value.activeRefill.status) || !Number.isSafeInteger(value.activeRefill.epoch) || value.activeRefill.epoch < 1) fail('SCHEMA_INVALID', 'activeRefill is invalid.'); safe(value.activeRefill.requestId, 'activeRefill.requestId', UUID); safe(value.activeRefill.recordId, 'activeRefill.recordId'); }
  exact(value.submit, ['status', 'idempotencyKey', 'payloadSha256', 'responseSha256'], 'submit'); if (!['idle', 'pending', 'succeeded', 'failed'].includes(value.submit.status)) fail('SCHEMA_INVALID', 'submit status is invalid.');
  if (value.submit.status === 'idle') { if (value.submit.idempotencyKey !== null || value.submit.payloadSha256 !== null || value.submit.responseSha256 !== null) fail('SCHEMA_INVALID', 'idle submit cannot retain a key.'); } else { safe(value.submit.idempotencyKey, 'submit.idempotencyKey', UUID); safe(value.submit.payloadSha256, 'submit.payloadSha256', SHA256); if (value.submit.status === 'succeeded') safe(value.submit.responseSha256, 'submit.responseSha256', SHA256); else if (value.submit.responseSha256 !== null) fail('SCHEMA_INVALID', 'unfinished submit cannot retain a response digest.'); }
  if (!Array.isArray(value.dirtyFields) || value.dirtyFields.some((item) => typeof item !== 'string' || !SAFE.test(item)) || new Set(value.dirtyFields).size !== value.dirtyFields.length || value.dirtyFields.some((item) => !current.some((field) => field.field === item))) fail('SCHEMA_INVALID', 'dirtyFields are invalid.');
  if ((baseline.length === 0 || current.length === 0) && value.activeRefill?.status !== 'pending') fail('SCHEMA_INVALID', 'empty edit state requires an active refill.');
  return value;
}
function transition(session, patch) { const unsigned = { ...session, ...patch, revision: session.revision + 1 }; delete unsigned.sessionDigest; const next = seal(unsigned); return { session: next, cas: { expectedRevision: session.revision, expectedDigest: session.sessionDigest, nextRevision: next.revision, nextDigest: next.sessionDigest }, writerAuthorized: false }; }
function cas(session, expectedRevision) { if (session.revision !== expectedRevision) fail('SESSION_CAS_CONFLICT', 'edit session revision is stale.'); }

export function createForgeUiEditSession(input) {
  exact(input, ['schemaVersion', 'sessionType', 'sessionId', 'recordId', 'fields'], 'edit session input'); if (input.schemaVersion !== 1 || input.sessionType !== 'forge-ui/edit-session') fail('SCHEMA_INVALID', 'edit session header is invalid.'); const initial = fields(input.fields, 'fields'); return seal({ schemaVersion: 1, sessionType: input.sessionType, sessionId: safe(input.sessionId, 'sessionId', UUID), recordId: safe(input.recordId, 'recordId'), requestEpoch: 0, baselineFields: initial, currentFields: initial, dirtyFields: [], activeRefill: null, submit: { status: 'idle', idempotencyKey: null, payloadSha256: null, responseSha256: null }, revision: 0 });
}

export function startForgeUiRefill(sessionInput, input) {
  const session = validate(sessionInput); exact(input, ['expectedRevision', 'requestId', 'recordId'], 'refill request'); cas(session, input.expectedRevision); if (session.submit.status === 'pending') fail('SUBMIT_IN_PROGRESS', 'Refill cannot start during submit.'); const requestId = safe(input.requestId, 'requestId', UUID); const recordId = safe(input.recordId, 'recordId'); const abortRequestIds = session.activeRefill?.status === 'pending' ? [session.activeRefill.requestId] : [];
  const switching = recordId !== session.recordId; const result = transition(session, { recordId, requestEpoch: session.requestEpoch + 1, baselineFields: switching ? [] : session.baselineFields, currentFields: switching ? [] : session.currentFields, dirtyFields: switching ? [] : session.dirtyFields, activeRefill: { status: 'pending', requestId, recordId, epoch: session.requestEpoch + 1 }, submit: switching ? { status: 'idle', idempotencyKey: null, payloadSha256: null, responseSha256: null } : session.submit });
  return freeze({ ...result, abortRequestIds, effect: 'start-refill' });
}

export function markForgeUiFieldDirty(sessionInput, input) {
  const session = validate(sessionInput); exact(input, ['expectedRevision', 'recordId', 'field', 'valueSha256'], 'dirty field input'); cas(session, input.expectedRevision); if (input.recordId !== session.recordId) fail('RECORD_IDENTITY_STALE', 'Dirty change belongs to another record.'); if (session.submit.status === 'pending') fail('SUBMIT_IN_PROGRESS', 'Fields cannot change during submit.'); const field = safe(input.field, 'field'); const valueSha256 = safe(input.valueSha256, 'valueSha256', SHA256); const map = new Map(session.currentFields.map((item) => [item.field, item.valueSha256])); map.set(field, valueSha256); return freeze({ ...transition(session, { currentFields: [...map].map(([name, value]) => ({ field: name, valueSha256: value })).sort((a, b) => a.field.localeCompare(b.field)), dirtyFields: [...new Set([...session.dirtyFields, field])].sort() }), effect: 'field-dirty' });
}

export function resolveForgeUiRefill(sessionInput, input) {
  const session = validate(sessionInput); exact(input, ['expectedRevision', 'requestId', 'recordId', 'epoch', 'responseFields', 'mergeStrategy'], 'refill response'); if (!['preserve-dirty', 'replace-clean-only'].includes(input.mergeStrategy)) fail('SCHEMA_INVALID', 'mergeStrategy is invalid.'); const active = session.activeRefill;
  if (!active || active.status !== 'pending' || input.requestId !== active.requestId || input.recordId !== active.recordId || input.recordId !== session.recordId || input.epoch !== active.epoch || input.epoch !== session.requestEpoch) return freeze({ outcome: 'late-response-ignored', session, cas: null, writerAuthorized: false });
  cas(session, input.expectedRevision);
  const response = fields(input.responseFields, 'responseFields'); const responseMap = new Map(response.map((item) => [item.field, item.valueSha256])); const currentMap = new Map(session.currentFields.map((item) => [item.field, item.valueSha256])); const dirty = new Set(session.dirtyFields);
  if (input.mergeStrategy === 'replace-clean-only' && dirty.size > 0) fail('DIRTY_FIELD_REPLACE_FORBIDDEN', 'replace-clean-only cannot overwrite a dirty session.');
  const merged = response.map((item) => ({ field: item.field, valueSha256: dirty.has(item.field) && input.mergeStrategy === 'preserve-dirty' ? currentMap.get(item.field) ?? item.valueSha256 : item.valueSha256 }));
  for (const field of dirty) if (!responseMap.has(field) && currentMap.has(field)) merged.push({ field, valueSha256: currentMap.get(field) });
  return freeze({ ...transition(session, { baselineFields: response, currentFields: merged.sort((a, b) => a.field.localeCompare(b.field)), activeRefill: { ...active, status: 'resolved' } }), outcome: 'refill-applied', effect: 'merge-refill' });
}

export function beginForgeUiSubmit(sessionInput, input) {
  const session = validate(sessionInput); exact(input, ['expectedRevision', 'recordId', 'idempotencyKey'], 'submit input'); if (input.recordId !== session.recordId) fail('RECORD_IDENTITY_STALE', 'Submit belongs to another record.'); if (session.activeRefill?.status === 'pending') fail('REFILL_PENDING', 'Submit cannot start while refill is pending.'); const key = safe(input.idempotencyKey, 'idempotencyKey', UUID); const payloadSha256 = digest({ recordId: session.recordId, fields: session.currentFields });
  if (session.submit.status === 'pending') { if (session.submit.idempotencyKey === key && session.submit.payloadSha256 === payloadSha256) return freeze({ outcome: 'duplicate-submit-inflight', session, cas: null, writerAuthorized: false }); fail('SUBMIT_IN_PROGRESS', 'Another submit is in progress.'); }
  if (session.submit.status === 'succeeded' && session.submit.idempotencyKey === key && session.submit.payloadSha256 === payloadSha256) return freeze({ outcome: 'duplicate-submit-completed', session, cas: null, writerAuthorized: false });
  if (session.submit.idempotencyKey === key && session.submit.payloadSha256 !== payloadSha256) fail('SUBMIT_IDEMPOTENCY_COLLISION', 'Submit idempotency key was reused with a different payload.');
  cas(session, input.expectedRevision);
  return freeze({ ...transition(session, { submit: { status: 'pending', idempotencyKey: key, payloadSha256, responseSha256: null } }), outcome: 'submit-ready-not-writer-authority', requiresProtectedIdempotentSubmit: true, writerAuthorized: false });
}

export function completeForgeUiSubmit(sessionInput, input) {
  const session = validate(sessionInput); exact(input, ['expectedRevision', 'recordId', 'idempotencyKey', 'responseFields'], 'submit completion'); const response = fields(input.responseFields, 'responseFields');
  const responseSha256 = digest({ recordId: session.recordId, fields: response });
  if (session.submit.status === 'succeeded' && session.submit.idempotencyKey === input.idempotencyKey && session.recordId === input.recordId) { if (responseSha256 !== session.submit.responseSha256) fail('SUBMIT_RESPONSE_COLLISION', 'Completed submit was replayed with a different response.'); return freeze({ outcome: 'duplicate-completion-no-op', session, cas: null, writerAuthorized: false }); }
  cas(session, input.expectedRevision); if (session.submit.status !== 'pending' || session.submit.idempotencyKey !== input.idempotencyKey || session.recordId !== input.recordId) fail('SUBMIT_BINDING_STALE', 'Submit completion does not match the active submit.'); return freeze({ ...transition(session, { baselineFields: response, currentFields: response, dirtyFields: [], submit: { ...session.submit, status: 'succeeded', responseSha256 } }), outcome: 'submit-completed-state-only', writerAuthorized: false });
}

export function failForgeUiSubmit(sessionInput, input) {
  const session = validate(sessionInput); exact(input, ['expectedRevision', 'recordId', 'idempotencyKey'], 'submit failure'); cas(session, input.expectedRevision); if (session.submit.status !== 'pending' || session.submit.idempotencyKey !== input.idempotencyKey || session.recordId !== input.recordId) fail('SUBMIT_BINDING_STALE', 'Submit failure does not match the active submit.'); return freeze({ ...transition(session, { submit: { status: 'failed', idempotencyKey: input.idempotencyKey, payloadSha256: session.submit.payloadSha256, responseSha256: null } }), outcome: 'submit-failed-retryable', writerAuthorized: false });
}
