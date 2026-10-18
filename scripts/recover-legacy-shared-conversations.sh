#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

DELIVERY_ROOT="${DELIVERY_ROOT:-/srv/forge-delivery}"
PLATFORM_ROOT="${PLATFORM_ROOT:-/opt/forge-delivery-platform}"
PROJECT_SLUG=''
OWNER_USERNAME=''
CONFIRMATION=''
ARCHIVE_TASK_ID='legacy-history-20260827'
ARCHIVE_CONVERSATION_ID='legacy-shared-history-20260827'
ARCHIVE_TITLE='历史对话归档（迁移前共享 Harness）'
LEGACY_CONVERSATION_PREFIX='legacy-session-20260827-'

die() { printf 'Legacy conversation recovery failed: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }

while (($# > 0)); do
  case "$1" in
    --project) PROJECT_SLUG="${2:-}"; shift 2 ;;
    --owner) OWNER_USERNAME="${2:-}"; shift 2 ;;
    --confirm-maintenance-window) CONFIRMATION="${2:-}"; shift 2 ;;
    --help|-h)
      printf 'Usage: %s --project <slug> --owner <admin-username> --confirm-maintenance-window legacy-shared-conversations\n' "$0"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[[ "${PROJECT_SLUG}" =~ ^[a-z0-9][a-z0-9-]{1,47}$ ]] || die 'Project slug is invalid.'
[[ "${OWNER_USERNAME}" =~ ^[a-z0-9][a-z0-9._-]{1,63}$ ]] || die 'Owner username is invalid.'
[[ "${CONFIRMATION}" == legacy-shared-conversations ]] \
  || die 'Explicit legacy-shared-conversations maintenance-window confirmation is required.'
[[ "${EUID}" -eq 0 ]] || die 'Recovery must run as root.'
for command_name in docker flock jq sha256sum zstd; do
  command -v "${command_name}" >/dev/null 2>&1 || die "Required command is unavailable: ${command_name}"
done

project_root="${DELIVERY_ROOT}/projects/${PROJECT_SLUG}"
source_home="${project_root}/dsh-home"
state_root="${DELIVERY_ROOT}/conversation-control-plane/state"
state_file="${state_root}/state.json"
audit_file="${state_root}/audit.jsonl"
control_env="${DELIVERY_ROOT}/conversation-control-plane/control-plane.env"
control_compose="${PLATFORM_ROOT}/templates/conversation-control-plane/compose.yaml"
taskspace_ctl="${PLATFORM_ROOT}/scripts/taskspacectl.sh"
archive_root="${project_root}/taskspaces/${ARCHIVE_TASK_ID}"

[[ -d "${source_home}" && -f "${source_home}/storages/session_projcache.json" ]] \
  || die 'Legacy shared Harness state is unavailable.'
[[ -f "${state_file}" && -f "${audit_file}" && -f "${control_env}" \
   && -f "${control_compose}" && -x "${taskspace_ctl}" ]] \
  || die 'Conversation control-plane or TaskSpace lifecycle is incomplete.'

mapfile -t source_sessions < <(find "${source_home}/sessions" -type f -name session.jsonl.zstd -print | sort)
(( ${#source_sessions[@]} > 0 )) || die 'Legacy shared Harness contains no session payloads.'
for session_file in "${source_sessions[@]}"; do
  zstd -t -q -- "${session_file}" || die "Legacy session integrity check failed: ${session_file}"
done

working_dir="$(mktemp -d)"
inventory_jsonl="${working_dir}/legacy-sessions.jsonl"
inventory_json="${working_dir}/legacy-sessions.json"
cleanup_working_files() {
  rm -f -- "${inventory_jsonl}" "${inventory_json}"
  rmdir -- "${working_dir}" 2>/dev/null || true
}
trap cleanup_working_files EXIT

cache_file="${source_home}/storages/session_projcache.json"
for session_file in "${source_sessions[@]}"; do
  session_id="$(basename -- "$(dirname -- "${session_file}")")"
  [[ "${session_id}" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]] \
    || die "Legacy session identifier is invalid: ${session_id}"
  session_digest="$(printf '%s' "${session_id}" | sha256sum | cut -d ' ' -f 1)"
  conversation_id="${LEGACY_CONVERSATION_PREFIX}${session_digest:0:32}"
  [[ "${conversation_id}" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$ ]] \
    || die "Generated legacy conversation identifier is invalid: ${conversation_id}"
  fallback_at="$(date --utc --date "@$(stat -c '%Y' -- "${session_file}")" --iso-8601=seconds)"
  embedded_title="$(zstd -dc -- "${session_file}" \
    | jq -r 'select(.type=="session/title" and (.data.title? | type)=="string" and (.data.title | length)>0) | .data.title' \
    | tail -n 1)"
  reviewed_title=''
  case "${session_id}" in
    session-18c561b3-41b7-9253-1f1f-13c672671cab) reviewed_title='DEEPSEEK_OK' ;;
    session-9e2bdd9c-9f2f-6494-b91a-93444148311d) reviewed_title='读取文档并计算哈希值' ;;
  esac
  jq --compact-output --arg sessionId "${session_id}" --arg conversationId "${conversation_id}" \
    --arg fallbackAt "${fallback_at}" --arg embeddedTitle "${embedded_title}" \
    --arg reviewedTitle "${reviewed_title}" '
      def safe_iso($value; $fallback):
        if (($value | type) == "number") and $value > 0
        then ($value / 1000 | todateiso8601)
        else $fallback
        end;
      def safe_title($value):
        (($value | type) == "string")
        and (($value | length) >= 1)
        and (($value | length) <= 100)
        and all($value | explode[]; . >= 32 and . != 127 and . != 65533);
      (.tables.sessions[$sessionId] // {}) as $session
      | ($session.rows.title.val? // "") as $candidateTitle
      | ($sessionId | if length > 8 then .[-8:] else . end) as $suffix
      | (safe_iso($session.identity.createdAt?; $fallbackAt)) as $createdAt
      | {
          sessionId: $sessionId,
          conversationId: $conversationId,
          title: (
            if safe_title($candidateTitle)
            then $candidateTitle
            elif safe_title($reviewedTitle)
            then $reviewedTitle
            elif safe_title($embeddedTitle)
            then $embeddedTitle
            else ("历史对话（未索引）· " + $suffix)
            end
          ),
          createdAt: $createdAt,
          updatedAt: safe_iso($session.rows.sessionListMetadata.val.lastPromptAt?; $createdAt)
        }
    ' "${cache_file}" >>"${inventory_jsonl}"
done
jq --slurp 'sort_by(.updatedAt, .sessionId) | reverse' "${inventory_jsonl}" >"${inventory_json}"
inventory_count="$(jq -r 'length' "${inventory_json}")"
[[ "${inventory_count}" -eq "${#source_sessions[@]}" ]] \
  || die 'Legacy session inventory is incomplete.'
jq -e '([.[].sessionId] | unique | length) == length
  and ([.[].conversationId] | unique | length) == length' "${inventory_json}" >/dev/null \
  || die 'Legacy session inventory contains duplicate identities.'
jq -e '([.[] | select(.title=="周长庆-测试-危废功能开发")] | length)==1
  and ([.[] | select(.title=="周长庆-测试-APP功能")] | length)==1' "${inventory_json}" >/dev/null \
  || die 'The two reviewed 周长庆 legacy conversations are not both present.'

owner_id="$(jq -r --arg username "${OWNER_USERNAME}" \
  '.users[] | select(.username==$username and .role=="admin" and .status=="active") | .id' "${state_file}")"
[[ -n "${owner_id}" ]] || die 'The requested active administrator account does not exist.'

existing_conversation_count="$(jq -r --arg id "${ARCHIVE_CONVERSATION_ID}" \
  '[.conversations[] | select(.id==$id)] | length' "${state_file}")"
archive_complete=false
if [[ "${existing_conversation_count}" == 1 && -f "${archive_root}/metadata.json" ]]; then
  jq -e --arg owner "${owner_id}" --arg project "${PROJECT_SLUG}" --arg task "${ARCHIVE_TASK_ID}" \
    '.conversations[] | select(.id=="legacy-shared-history-20260827" and .ownerUserId==$owner and .projectSlug==$project and .taskId==$task)' \
    "${state_file}" >/dev/null || die 'Existing archive conversation does not match the reviewed identity.'
  archive_sessions="$(find "${archive_root}/dsh-home/sessions" -type f -name session.jsonl.zstd | wc -l)"
  [[ "${archive_sessions}" -eq "${#source_sessions[@]}" ]] || die 'Existing archive session count is incomplete.'
  log "Legacy conversation archive is already complete: ${archive_sessions} sessions owned by ${OWNER_USERNAME}."
  archive_complete=true
fi
if [[ "${archive_complete}" != true ]]; then
  [[ "${existing_conversation_count}" == 0 && ! -e "${archive_root}" ]] \
    || die 'Partial legacy archive state exists; refusing an ambiguous retry.'
fi

# Create the mandatory consistent pre-change backup before taking the recovery lock.
bash "${PLATFORM_ROOT}/scripts/backup-conversation-control-plane.sh" \
  --confirm-maintenance-window conversation-control-plane

lock_file="${DELIVERY_ROOT}/registry/conversation-control-plane.recovery.lock"
prepare_delivery_lock "${lock_file}"
exec 8>>"${lock_file}"
flock --exclusive --nonblock 8 || die 'Another control-plane recovery owns the lock.'

compose() {
  docker compose --env-file "${control_env}" --file "${control_compose}" "$@"
}

gateway_was_running=false
if compose ps --status running --services | grep -Fxq conversation-gateway; then gateway_was_running=true; fi
restart_gateway() {
  local status=$?
  trap - EXIT
  if [[ "${gateway_was_running}" == true ]]; then
    compose up --detach --no-deps conversation-gateway >/dev/null 2>&1 \
      || printf 'WARNING: Conversation Gateway restart failed.\n' >&2
  fi
  cleanup_working_files
  exit "${status}"
}
trap restart_gateway EXIT

if [[ "${archive_complete}" != true ]]; then
  # TaskSpace health depends on the live authorization socket, so provisioning
  # deliberately completes before the short control-plane write outage.
  bash "${taskspace_ctl}" "${PROJECT_SLUG}" create \
    --task "${ARCHIVE_TASK_ID}" \
    --actor "${OWNER_USERNAME}" \
    --conversation "${ARCHIVE_CONVERSATION_ID}" \
    --access-mode conversation
  bash "${taskspace_ctl}" "${PROJECT_SLUG}" stop "${ARCHIVE_TASK_ID}"
fi

if [[ "${gateway_was_running}" == true ]]; then compose stop conversation-gateway; fi

if [[ "${archive_complete}" != true ]]; then
  archive_stage="${archive_root}/dsh-home.legacy-stage"
  archive_initial="${archive_root}/dsh-home.pre-legacy"
  [[ ! -e "${archive_stage}" && ! -e "${archive_initial}" ]] || die 'Archive staging path already exists.'
  cp -a -- "${source_home}" "${archive_stage}"
  for session_file in "${archive_stage}"/sessions/*/*/session.jsonl.zstd; do
    [[ -f "${session_file}" ]] || continue
    zstd -t -q -- "${session_file}" || die "Copied archive session integrity check failed: ${session_file}"
  done
  mv -- "${archive_root}/dsh-home" "${archive_initial}"
  mv -- "${archive_stage}" "${archive_root}/dsh-home"
  chown -R --reference="${archive_root}/metadata.json" "${archive_root}/dsh-home" "${archive_initial}"

  created_at="$(jq -r '.createdAt' "${archive_root}/metadata.json")"
  archive_port="$(jq -r '.harnessPort' "${archive_root}/metadata.json")"
  state_temp="${state_file}.legacy-recovery.$$"
  jq --arg id "${ARCHIVE_CONVERSATION_ID}" --arg task "${ARCHIVE_TASK_ID}" \
    --arg project "${PROJECT_SLUG}" --arg owner "${owner_id}" --arg title "${ARCHIVE_TITLE}" \
    --arg created "${created_at}" --argjson port "${archive_port}" \
    '.revision += 1 | .conversations += [{id:$id,taskId:$task,projectSlug:$project,ownerUserId:$owner,title:$title,status:"stopped",port:$port,createdAt:$created,updatedAt:$created,lastOpenedAt:null,lastError:null}]' \
    "${state_file}" >"${state_temp}"
  jq -e --arg id "${ARCHIVE_CONVERSATION_ID}" \
    '([.conversations[] | select(.id==$id)] | length)==1' "${state_temp}" >/dev/null
  chmod 0600 "${state_temp}"
  chown --reference="${state_file}" "${state_temp}"
  mv -- "${state_temp}" "${state_file}"
  jq --null-input --compact-output --arg at "$(date --iso-8601=seconds)" \
    --arg actor "${OWNER_USERNAME}" --arg project "${PROJECT_SLUG}" \
    --arg target "${ARCHIVE_CONVERSATION_ID}" --argjson sessions "${#source_sessions[@]}" \
    '{at:$at,projectSlug:$project,actor:$actor,action:"conversation.legacy-archive-recover",targetType:"conversation",targetId:$target,result:"success",legacySessions:$sessions}' \
    >>"${audit_file}"
  log "Recovered ${#source_sessions[@]} legacy shared Harness sessions into ${ARCHIVE_CONVERSATION_ID}; owner=${OWNER_USERNAME}."
fi

# Surface every immutable DSH session as its own top-level Gateway conversation.
# The rows share one archive TaskSpace so the original workspace semantics and
# uploaded resources remain intact; the Gateway selects the exact DSH session
# only after the normal user/project/owner checks have passed.
jq -e --slurpfile inventory "${inventory_json}" --arg archive "${ARCHIVE_CONVERSATION_ID}" \
  --arg task "${ARCHIVE_TASK_ID}" --arg project "${PROJECT_SLUG}" --arg owner "${owner_id}" '
    . as $state
    | all($inventory[0][]; . as $session
      | ([$state.conversations[] | select(.id==$session.conversationId)]) as $matches
      | (($matches | length) <= 1)
        and (($matches | length) == 0 or (
          $matches[0].conversationKind == "legacy-session"
          and $matches[0].legacyArchiveConversationId == $archive
          and $matches[0].legacySessionId == $session.sessionId
          and $matches[0].taskId == $task
          and $matches[0].projectSlug == $project
          and $matches[0].ownerUserId == $owner
        )))
  ' "${state_file}" >/dev/null || die 'A legacy conversation identifier conflicts with existing state.'

state_temp="${state_file}.legacy-surface.$$"
jq --slurpfile inventory "${inventory_json}" --arg archive "${ARCHIVE_CONVERSATION_ID}" \
  --arg task "${ARCHIVE_TASK_ID}" --arg project "${PROJECT_SLUG}" --arg owner "${owner_id}" '
    . as $before
    | ([.conversations[] | select(.id==$archive)]) as $parents
    | if ($parents | length) != 1 then error("legacy archive conversation is missing") else . end
    | $parents[0] as $parent
    | (.conversations | map({key:.id,value:.}) | from_entries) as $byId
    | ($inventory[0] | map(
        . as $session
        | ($byId[$session.conversationId] // {}) as $existing
        | {
            id: $session.conversationId,
            taskId: $task,
            projectSlug: $project,
            ownerUserId: $owner,
            title: $session.title,
            status: $parent.status,
            port: $parent.port,
            createdAt: $session.createdAt,
            updatedAt: (
              if $existing.conversationKind == "legacy-session"
                and $existing.legacySessionId == $session.sessionId
              then ($existing.updatedAt // $session.updatedAt)
              else $session.updatedAt
              end
            ),
            lastOpenedAt: ($existing.lastOpenedAt // null),
            lastError: ($parent.lastError // null),
            conversationKind: "legacy-session",
            legacySessionId: $session.sessionId,
            legacyArchiveConversationId: $archive
          }
      )) as $legacyConversations
    | (.conversations | map(select(
        .id != $archive
        and ((.legacyArchiveConversationId // "") != $archive)
      ))) as $unrelated
    | .conversations = (
        $unrelated
        + [($parent + {hiddenFromList:true,conversationKind:"legacy-archive"})]
        + $legacyConversations
      )
    | . as $after
    | if $after == $before then . else .revision = ($before.revision + 1) end
  ' "${state_file}" >"${state_temp}"
chmod 0600 "${state_temp}"
chown --reference="${state_file}" "${state_temp}"
old_revision="$(jq -r '.revision' "${state_file}")"
new_revision="$(jq -r '.revision' "${state_temp}")"
if [[ "${new_revision}" != "${old_revision}" ]]; then
  mv -- "${state_temp}" "${state_file}"
  jq --null-input --compact-output --arg at "$(date --iso-8601=seconds)" \
    --arg actor "${OWNER_USERNAME}" --arg project "${PROJECT_SLUG}" \
    --arg target "${ARCHIVE_CONVERSATION_ID}" --argjson sessions "${inventory_count}" \
    '{at:$at,projectSlug:$project,actor:$actor,action:"conversation.legacy-sessions-surface",targetType:"conversation",targetId:$target,result:"success",legacySessions:$sessions}' \
    >>"${audit_file}"
else
  rm -f -- "${state_temp}"
fi
jq -e --slurpfile inventory "${inventory_json}" --arg archive "${ARCHIVE_CONVERSATION_ID}" \
  --arg project "${PROJECT_SLUG}" --arg owner "${owner_id}" '
    ([.conversations[] | select(.id==$archive and .hiddenFromList==true)] | length)==1
    and ([.conversations[] | select(
      .conversationKind=="legacy-session"
      and .legacyArchiveConversationId==$archive
      and .projectSlug==$project
      and .ownerUserId==$owner
    )] | length)==($inventory[0] | length)
    and ([.conversations[] | select(.title=="周长庆-测试-危废功能开发")] | length)==1
    and ([.conversations[] | select(.title=="周长庆-测试-APP功能")] | length)==1
  ' "${state_file}" >/dev/null || die 'Top-level legacy conversation verification failed.'
log "Surfaced ${inventory_count} legacy sessions as peer conversations; archive parent is hidden; owner=${OWNER_USERNAME}."

recovered_orphans=0
for metadata in "${DELIVERY_ROOT}"/projects/*/taskspaces/*/metadata.json; do
  [[ -f "${metadata}" ]] || continue
  conversation_id="$(jq -r '.conversationId' "${metadata}")"
  [[ "${conversation_id}" != "${ARCHIVE_CONVERSATION_ID}" ]] || continue
  if jq -e --arg id "${conversation_id}" '.conversations[] | select(.id==$id)' "${state_file}" >/dev/null; then continue; fi
  task_root="${metadata%/metadata.json}"
  taskspace_sessions="${task_root}/dsh-home/sessions"
  [[ -d "${taskspace_sessions}" ]] || continue
  session_count="$(find "${taskspace_sessions}" -type f -name session.jsonl.zstd -print | wc -l)"
  (( session_count > 0 )) || continue
  while IFS= read -r session_file; do zstd -t -q -- "${session_file}"; done \
    < <(find "${taskspace_sessions}" -type f -name session.jsonl.zstd -print | sort)

  project_slug="$(jq -r '.projectSlug' "${metadata}")"
  task_id="$(jq -r '.taskId' "${metadata}")"
  port="$(jq -r '.harnessPort' "${metadata}")"
  created_at="$(jq -r '.createdAt' "${metadata}")"
  metadata_temp="${metadata}.legacy-recovery.$$"
  jq --arg updated "$(date --iso-8601=seconds)" '.status="stopped" | .updatedAt=$updated' \
    "${metadata}" >"${metadata_temp}"
  chmod 0600 "${metadata_temp}"
  chown --reference="${metadata}" "${metadata_temp}"
  mv -- "${metadata_temp}" "${metadata}"

  state_temp="${state_file}.legacy-recovery.$$"
  jq --arg id "${conversation_id}" --arg task "${task_id}" --arg project "${project_slug}" \
    --arg owner "${owner_id}" --arg title "历史 TaskSpace：${task_id}" --arg created "${created_at}" \
    --argjson port "${port}" \
    '.revision += 1 | .conversations += [{id:$id,taskId:$task,projectSlug:$project,ownerUserId:$owner,title:$title,status:"stopped",port:$port,createdAt:$created,updatedAt:$created,lastOpenedAt:null,lastError:null}]' \
    "${state_file}" >"${state_temp}"
  chmod 0600 "${state_temp}"
  chown --reference="${state_file}" "${state_temp}"
  mv -- "${state_temp}" "${state_file}"
  jq --null-input --compact-output --arg at "$(date --iso-8601=seconds)" \
    --arg actor "${OWNER_USERNAME}" --arg project "${project_slug}" --arg target "${conversation_id}" \
    --argjson sessions "${session_count}" \
    '{at:$at,projectSlug:$project,actor:$actor,action:"conversation.orphan-taskspace-recover",targetType:"conversation",targetId:$target,result:"success",legacySessions:$sessions}' \
    >>"${audit_file}"
  recovered_orphans=$((recovered_orphans + 1))
done

log "Recovered orphaned TaskSpace conversations: ${recovered_orphans}; owner=${OWNER_USERNAME}."
