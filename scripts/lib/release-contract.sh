#!/usr/bin/env bash

# This library is sourced by project lifecycle scripts after lib/common.sh.

release_contract_env_value() {
  local env_file="$1"
  local key="$2"
  local value
  value="$(awk -F= -v name="${key}" '$1 == name {sub(/^[^=]*=/, ""); print; exit}' "${env_file}")"
  if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "${value}"
}

release_contract_default_allowed_release_services_json() {
  printf '%s' '["forge-admin","forge-app","forge-flow","forge-ui"]'
}

release_contract_application_runtime_services_json() {
  case "${1:-}" in
    pc-only) printf '%s' '["forge-admin","forge-flow","forge-ui"]' ;;
    pc-mobile) release_contract_default_allowed_release_services_json ;;
    *) printf '%s\n' 'Application runtime must be pc-only or pc-mobile.' >&2; return 1 ;;
  esac
}

# These are the only two reviewed application release sets. New PC-only projects
# omit App from Compose as well; existing four-service topology remains supported.
release_contract_validate_allowed_release_services_json() {
  local allowed_release_services_json="$1"
  jq -e '
    type == "array"
    and all(.[]; type == "string")
    and (([.[]] | sort) as $services | (
        $services == ["forge-admin", "forge-flow", "forge-ui"]
        or $services == ["forge-admin", "forge-app", "forge-flow", "forge-ui"]
      ))
  ' >/dev/null <<<"${allowed_release_services_json}"
}

# Filter only the platform-owned template, before Compose expands any secrets.
# Four-service output remains byte-identical to the canonical template.
release_contract_render_project_compose() {
  local template_file="$1" compose_application_services_json="$2"
  release_contract_validate_allowed_release_services_json "${compose_application_services_json}" || return 1
  if jq -e 'index("forge-app") != null' >/dev/null <<<"${compose_application_services_json}"; then
    cat -- "${template_file}"
    return
  fi
  awk '
    {line=$0; sub(/\r$/, "", line)}
    line ~ /^  [a-z][a-z0-9-]*:$/ {
      section=$1
      sub(/\r$/, "", section)
      if (section == "forge-app:") app_blocks++
    }
    section == "forge-app:" {next}
    section == "forge-ui:" && line == "      - forge-app" {app_dependencies++; next}
    {lines[++count]=$0}
    END {
      if (app_blocks != 1 || app_dependencies != 1) {
        print "Canonical Compose mobile service or UI dependency differs from the reviewed template." > "/dev/stderr"
        exit 1
      }
      for (i=1; i<=count; i++) print lines[i]
    }
  ' "${template_file}"
}

release_contract_protected_input_paths() {
  local allowed_release_services_json="$1"
  release_contract_validate_allowed_release_services_json "${allowed_release_services_json}" || return 1
  jq -r '
    [
      "docker-forge-admin/Dockerfile.admin",
      "docker-forge-admin/Dockerfile.flow",
      "docker-forge-admin/Dockerfile.ui",
      "docker-forge-admin/application-datasource.yml",
      "docker-forge-admin/docker-compose.yml",
      "docker-forge-admin/nginx.conf"
    ] + (if index("forge-app") == null then [] else ["docker-forge-admin/Dockerfile.app"] end)
    | .[]
  ' <<<"${allowed_release_services_json}"
}

# Deliberately read-only so upgrade paths can fail before a maintenance fence.
release_contract_validate_protected_inputs() {
  local protected_source_root="$1" allowed_release_services_json="$2" relative_path protected_paths
  release_contract_validate_allowed_release_services_json "${allowed_release_services_json}" || {
    printf '%s\n' 'Release contract allowedReleaseServices is not a reviewed set.' >&2
    return 1
  }
  [[ -d "${protected_source_root}" && ! -L "${protected_source_root}" ]] || {
    printf 'Release contract protected source root is missing or unsafe: %s\n' "${protected_source_root}" >&2
    return 1
  }
  protected_paths="$(release_contract_protected_input_paths "${allowed_release_services_json}")" || return 1
  while IFS= read -r relative_path; do
    [[ -f "${protected_source_root}/${relative_path}" && ! -L "${protected_source_root}/${relative_path}" ]] || {
      printf 'Protected deployment input is missing or not a regular file: %s\n' "${relative_path}" >&2
      return 1
    }
  done <<<"${protected_paths}"
}

render_release_contract() {
  local slug="$1"
  local project_root="$2"
  local workspace_root="$3"
  local project_env="$4"
  local output_file="$5"
  local protected_source_root="${6:-${workspace_root}}"
  local allowed_release_services_json="${7:-$(release_contract_default_allowed_release_services_json)}"
  # Existing callers retain four-service Compose unless they explicitly select a topology.
  local compose_application_services_json="${8:-$(release_contract_default_allowed_release_services_json)}"
  local shared_env mysql_host mysql_port mysql_database mysql_test_database
  local redis_host redis_port redis_database redis_test_database compose_project
  local test_database_operator_image
  local protected='[]' protected_paths relative_path file_path file_hash temp_file

  for command_name in awk jq sha256sum mktemp; do
    require_command "${command_name}"
  done
  validate_slug "${slug}"
  [[ "${project_root}" == "${DELIVERY_ROOT}/projects/${slug}" ]] \
    || die "Release contract project root is outside the registered project: ${project_root}"
  [[ -d "${workspace_root}" && -d "${protected_source_root}" && -f "${project_env}" ]] \
    || die "Release contract inputs are incomplete for ${slug}."
  release_contract_validate_allowed_release_services_json "${allowed_release_services_json}" \
    || die "Release contract allowedReleaseServices is not a reviewed set."
  release_contract_validate_allowed_release_services_json "${compose_application_services_json}" \
    || die "Release contract Compose application services are not a reviewed set."
  jq --exit-status --argjson compose "${compose_application_services_json}" \
    '(. - $compose) | length == 0' <<<"${allowed_release_services_json}" >/dev/null \
    || die "Release contract Compose omits a required application release service."
  release_contract_validate_protected_inputs "${protected_source_root}" "${allowed_release_services_json}" \
    || die "Release contract protected deployment inputs are incomplete for ${slug}."

  compose_project="$(release_contract_env_value "${project_env}" COMPOSE_PROJECT_NAME)"
  mysql_database="$(release_contract_env_value "${project_env}" MYSQL_DATABASE)"
  mysql_test_database="$(release_contract_env_value "${project_env}" MYSQL_TEST_DATABASE)"
  redis_database="$(release_contract_env_value "${project_env}" REDIS_DATABASE)"
  redis_test_database="$(release_contract_env_value "${project_env}" REDIS_TEST_DATABASE)"
  shared_env="$(release_contract_env_value "${project_env}" SHARED_SERVICES_ENV_FILE)"
  test_database_operator_image="$(release_contract_env_value "${project_env}" RELEASE_DB_OPERATOR_IMAGE)"
  [[ "${compose_project}" == "forge-${slug}" ]] || die "Unexpected Compose project for ${slug}."
  [[ "${mysql_database}" =~ ^[a-z0-9_]{1,64}$ ]] || die "Invalid project MySQL database."
  [[ "${mysql_test_database}" == "${mysql_database}_test" ]] || die "Invalid project MySQL test database."
  [[ "${redis_database}" =~ ^([0-9]|1[0-5])$ ]] || die "Invalid project Redis database."
  [[ "${redis_test_database}" =~ ^([0-9]|1[0-5])$ ]] || die "Invalid project Redis test database."
  [[ "${redis_database}" != "${redis_test_database}" ]] || die "Runtime and test Redis databases must differ."
  [[ -f "${shared_env}" ]] || die "Shared services environment is unavailable: ${shared_env}"
  [[ "${test_database_operator_image}" =~ ^[a-z0-9]+([._/-][a-z0-9]+)*(:[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$ ]] \
    || die "Test database operator image must be pinned by sha256 digest."

  mysql_host="$(release_contract_env_value "${shared_env}" MYSQL_HOST)"
  mysql_port="$(release_contract_env_value "${shared_env}" MYSQL_PORT)"
  redis_host="$(release_contract_env_value "${shared_env}" REDIS_HOST)"
  redis_port="$(release_contract_env_value "${shared_env}" REDIS_PORT)"
  [[ "${mysql_host}" =~ ^[A-Za-z0-9._:-]{1,255}$ && "${mysql_port}" =~ ^[0-9]{1,5}$ ]] \
    || die "Shared MySQL endpoint is invalid."
  [[ "${redis_host}" =~ ^[A-Za-z0-9._:-]{1,255}$ && "${redis_port}" =~ ^[0-9]{1,5}$ ]] \
    || die "Shared Redis endpoint is invalid."

  protected_paths="$(release_contract_protected_input_paths "${allowed_release_services_json}")" \
    || die "Release contract protected deployment inputs are incomplete for ${slug}."
  while IFS= read -r relative_path; do
    file_path="${protected_source_root}/${relative_path}"
    file_hash="$(sha256sum "${file_path}" | awk '{print $1}')"
    protected="$(jq --compact-output \
      --arg relative_path "${relative_path}" \
      --arg file_hash "${file_hash}" \
      '. + [{relativePath: $relative_path, sha256: $file_hash}]' <<<"${protected}")"
  done <<<"${protected_paths}"

  temp_file="$(mktemp "$(dirname -- "${output_file}")/.runtime-contract.XXXXXX")"
  jq --null-input \
    --arg slug "${slug}" \
    --arg compose_project "${compose_project}" \
    --arg project_root "${project_root}" \
    --arg workspace_root "${project_root}/workspace" \
    --arg mysql_host "${mysql_host}" \
    --argjson mysql_port "${mysql_port}" \
    --arg mysql_database "${mysql_database}" \
    --arg mysql_test_database "${mysql_test_database}" \
    --arg redis_host "${redis_host}" \
    --argjson redis_port "${redis_port}" \
    --argjson redis_database "${redis_database}" \
    --argjson redis_test_database "${redis_test_database}" \
    --arg test_database_operator_image "${test_database_operator_image}" \
    --argjson allowed_release_services "${allowed_release_services_json}" \
    --argjson compose_application_services "${compose_application_services_json}" \
    --argjson protected "${protected}" \
    '{
      schemaVersion: 3,
      projectSlug: $slug,
      composeProjectName: $compose_project,
      projectRoot: $project_root,
      workspaceRoot: $workspace_root,
      infrastructure: {
        mysql: {
          mode: "shared-external",
          host: $mysql_host,
          port: $mysql_port,
          database: $mysql_database,
          testDatabase: $mysql_test_database,
          provisioningAllowed: false
        },
        redis: {
          mode: "shared-external",
          host: $redis_host,
          port: $redis_port,
          database: $redis_database,
          testDatabase: $redis_test_database,
          provisioningAllowed: false
        }
      },
      release: {
        fixedComposeFile: ($project_root + "/ops/compose.yaml"),
        allowedComposeServices: ([
          "forge-admin", "forge-app", "forge-flow", "forge-ui", "release-runner", "taskspace-broker",
          "conversation-manager", "protected-acceptance", "verification-runner"
        ] | if ($compose_application_services | index("forge-app")) == null
          then map(select(. != "forge-app")) else . end),
        allowedReleaseServices: $allowed_release_services,
        protectedFiles: $protected,
        databaseProvisioningAllowed: false,
        workspaceComposeAllowed: false,
        testDatabaseLifecycle: {
          mode: "snapshot-restore-on-failure",
          backupRequired: true,
          restoreOnFailure: true,
          fullReplaySupported: false,
          operatorImage: $test_database_operator_image,
          backupRoot: ($project_root + "/backups/test-database-snapshots"),
          recoveryStateFile: ($project_root + "/ops/test-database-recovery.json")
        }
      }
    }' >"${temp_file}"
  chmod 0640 "${temp_file}"
  if [[ "${EUID}" -eq 0 ]]; then
    if [[ -e "${output_file}" ]]; then
      chown --reference="${output_file}" "${temp_file}"
    else
      chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temp_file}"
    fi
  fi
  mv -- "${temp_file}" "${output_file}"
}
