#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=../lib/common.sh
source "${SCRIPT_DIR}/../lib/common.sh"
load_platform_config
umask 077

usage() {
  printf '%s\n' \
    "Usage: $0 <validation-project-slug> --stage <candidate-build|test-database-migration> --confirm-validation-project <slug> [--timeout-seconds <30-900>]" \
    "" \
    "Root-only acceptance helper. It kills only the selected project's labelled Release Runner" \
    "after a new controlled job reaches the exact stage, then records restart diagnosis evidence."
}

slug="${1:-}"
[[ -n "${slug}" ]] || { usage >&2; exit 2; }
shift
stage=''
confirm_slug=''
timeout_seconds=300
while (($# > 0)); do
  case "$1" in
    --stage) stage="${2:-}"; shift 2 ;;
    --confirm-validation-project) confirm_slug="${2:-}"; shift 2 ;;
    --timeout-seconds) timeout_seconds="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done

validate_slug "${slug}"
[[ "${slug}" != forge-base ]] || die "Fault injection is permanently disabled for forge-base."
[[ "${confirm_slug}" == "${slug}" ]] \
  || die "--confirm-validation-project must exactly match ${slug}."
case "${stage}" in
  candidate-build|test-database-migration) ;;
  *) die "Unsupported fault-injection stage: ${stage}" ;;
esac
[[ "${timeout_seconds}" =~ ^[0-9]+$ && "${timeout_seconds}" -ge 30 && "${timeout_seconds}" -le 900 ]] \
  || die "--timeout-seconds must be an integer from 30 through 900."
for command_name in date docker flock jq mktemp; do require_command "${command_name}"; done
require_docker_access

project_root="${DELIVERY_ROOT}/projects/${slug}"
ops_root="${project_root}/ops"
env_file="${ops_root}/project.env"
compose_file="${ops_root}/compose.yaml"
state_file="${ops_root}/release-state.json"
[[ -f "${env_file}" && -f "${compose_file}" ]] || die "Validation project is incomplete."
assert_managed_path "${project_root}"

compose() {
  docker compose --env-file "${env_file}" --file "${compose_file}" "$@"
}

recovery_lock="${DELIVERY_ROOT}/registry/${slug}.recovery.lock"
prepare_delivery_lock "${recovery_lock}"
exec 8>>"${recovery_lock}"
flock --exclusive --nonblock 8 \
  || die "A backup or restore operation already owns this validation project."

runner_container="$(compose ps --quiet release-runner)"
[[ -n "${runner_container}" ]] || die "Release Runner is not running."
runner_state="$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "${runner_container}")"
[[ "${runner_state}" == 'running|healthy' ]] || die "Release Runner is not healthy: ${runner_state}"
runner_started_before="$(docker inspect --format '{{.State.StartedAt}}' "${runner_container}")"
baseline_job_id=''
if [[ -f "${state_file}" ]]; then baseline_job_id="$(jq -r '.jobId // empty' "${state_file}")"; fi

deadline=$((SECONDS + timeout_seconds))
observed_job_id=''
observed_state=''
while ((SECONDS < deadline)); do
  if [[ -f "${state_file}" ]]; then
    observed_job_id="$(jq -r '.jobId // empty' "${state_file}" 2>/dev/null || true)"
    observed_stage="$(jq -r '.stage // empty' "${state_file}" 2>/dev/null || true)"
    observed_status="$(jq -r '.status // empty' "${state_file}" 2>/dev/null || true)"
    if [[ -n "${observed_job_id}" && "${observed_job_id}" != "${baseline_job_id}" \
      && "${observed_status}" == running && "${observed_stage}" == "${stage}" ]]; then
      observed_state="$(jq -c '{jobId,status,stage,commit,version,startedAt,updatedAt,provenance}' "${state_file}")"
      break
    fi
  fi
  sleep 0.02
done
[[ -n "${observed_state}" ]] || die "No new release reached ${stage} within ${timeout_seconds} seconds."

migration_containers_at_kill='[]'
if [[ "${stage}" == test-database-migration ]]; then
  migration_deadline=$((SECONDS + 30))
  while ((SECONDS < migration_deadline)); do
    mapfile -t migration_container_ids < <(
      docker ps \
        --filter "label=com.forge-delivery.project=${slug}" \
        --filter 'label=com.forge-delivery.role=test-database-migration' \
        --format '{{.ID}}'
    )
    if ((${#migration_container_ids[@]} > 0)); then
      migration_containers_at_kill="$(printf '%s\n' "${migration_container_ids[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
      break
    fi
    sleep 0.02
  done
  [[ "${migration_containers_at_kill}" != '[]' ]] \
    || die "The release reached test-database-migration, but no labelled migration container became active."
fi

killed_at="$(date --iso-8601=seconds)"
docker kill --signal KILL "${runner_container}" >/dev/null
# `docker kill` intentionally has manual-stop semantics, so the acceptance
# orchestrator immediately asks Compose to recreate/start the governed service.
# A real PID crash is also covered by `restart: unless-stopped`; this explicit
# step makes the injected failure deterministic across Docker Engine versions.
compose up --detach --no-deps release-runner >/dev/null

restart_deadline=$((SECONDS + 120))
runner_container_after=''
runner_started_after=''
while ((SECONDS < restart_deadline)); do
  runner_container_after="$(compose ps --quiet release-runner 2>/dev/null || true)"
  if [[ -n "${runner_container_after}" ]]; then
    runner_started_after="$(docker inspect --format '{{.State.StartedAt}}' "${runner_container_after}" 2>/dev/null || true)"
    runner_state="$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "${runner_container_after}" 2>/dev/null || true)"
    if [[ "${runner_state}" == 'running|healthy' && "${runner_started_after}" != "${runner_started_before}" ]]; then break; fi
  fi
  sleep 1
done
[[ "${runner_state}" == 'running|healthy' && "${runner_started_after}" != "${runner_started_before}" ]] \
  || die "Release Runner did not restart healthy after the injected process death."

diagnosis="$(docker exec "${runner_container_after}" forge-release diagnose)"
jq -e '.ok == true and .result.active == false and .result.lastJob.status == "interrupted" and .result.lastJob.stage == "runner-restart-recovery"' \
  <<<"${diagnosis}" >/dev/null \
  || die "Restarted Runner did not report the interrupted job recovery contract."

evidence_root="${ops_root}/acceptance-faults"
mkdir -p -- "${evidence_root}"
chmod 0700 "${evidence_root}"
stamp="$(date -u +'%Y%m%dT%H%M%SZ')"
evidence_file="${evidence_root}/${stamp}-runner-${stage}.json"
temporary="$(mktemp "${evidence_root}/.runner-fault.XXXXXX")"
jq --null-input \
  --arg projectSlug "${slug}" --arg targetStage "${stage}" \
  --arg baselineJobId "${baseline_job_id}" --argjson observedState "${observed_state}" \
  --arg runnerContainerBefore "${runner_container}" --arg runnerStartedBefore "${runner_started_before}" \
  --argjson migrationContainersAtKill "${migration_containers_at_kill}" \
  --arg killedAt "${killed_at}" --arg runnerContainerAfter "${runner_container_after}" \
  --arg runnerStartedAfter "${runner_started_after}" \
  --argjson diagnosis "$(jq -c '.result | {active,activeJobId,lastJob:{jobId:.lastJob.jobId,status:.lastJob.status,stage:.lastJob.stage,retryable:.lastJob.retryable,recommendedAction:.lastJob.recommendedAction},testDatabaseRecovery:{status:.testDatabaseRecovery.status,lastAttempt:.testDatabaseRecovery.lastAttempt,recoveryPoint:{jobId:.testDatabaseRecovery.recoveryPoint.jobId,commit:.testDatabaseRecovery.recoveryPoint.commit,sha256:.testDatabaseRecovery.recoveryPoint.sha256,objectCount:.testDatabaseRecovery.recoveryPoint.objectCount}}}' <<<"${diagnosis}")" \
  '{schemaVersion:1,projectSlug:$projectSlug,targetStage:$targetStage,baselineJobId:$baselineJobId,observedState:$observedState,processFault:{signal:"SIGKILL",restartAction:"docker compose up --detach --no-deps release-runner",runnerContainerBefore:$runnerContainerBefore,runnerStartedBefore:$runnerStartedBefore,migrationContainersAtKill:$migrationContainersAtKill,killedAt:$killedAt,runnerContainerAfter:$runnerContainerAfter,runnerStartedAfter:$runnerStartedAfter},diagnosis:$diagnosis}' \
  >"${temporary}"
chmod 0600 "${temporary}"
if [[ "${EUID}" -eq 0 ]]; then chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}" "${evidence_root}"; fi
mv -- "${temporary}" "${evidence_file}"
log "Injected ${stage} Runner process death for job ${observed_job_id}; restart diagnosis passed."
log "Evidence: ${evidence_file}"
