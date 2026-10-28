#!/usr/bin/env bash

# Transactional image-only container replacement.  The original container is
# kept until the caller has verified every candidate and committed the wider
# maintenance transaction.  Callers must provide an operation id containing
# only lower-case letters, digits, and hyphens.

forge_cutover_require_context() {
  [[ "${FORGE_CUTOVER_OPERATION:-}" =~ ^[a-z0-9][a-z0-9-]{1,47}$ \
    && -d "${FORGE_CUTOVER_RECORD_ROOT:-}" \
    && ! -L "${FORGE_CUTOVER_RECORD_ROOT:-}" ]] \
    || { printf 'Container cutover context is missing or unsafe.\n' >&2; return 1; }
}

forge_cutover_record_path() {
  local logical_name="$1"
  [[ "${logical_name}" =~ ^[a-z0-9][a-z0-9-]{1,63}$ ]] || return 1
  printf '%s/%s.json\n' "${FORGE_CUTOVER_RECORD_ROOT}" "${logical_name}"
}

forge_cutover_docker() {
  command docker --host unix:///var/run/docker.sock "$@"
}

forge_cutover_server_api_prefix() {
  local api_version major minor
  api_version="$(curl --fail --silent --show-error --unix-socket /var/run/docker.sock \
    http://localhost/version | jq -er '.ApiVersion | select(type == "string")')" || return 1
  [[ "${api_version}" =~ ^([0-9]+)\.([0-9]+)$ ]] || return 1
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  (( 10#${major} == 1 && 10#${minor} >= 41 )) || return 1
  printf 'v%s\n' "${api_version}"
}

forge_cutover_publish_record_file() {
  local temporary="$1" record="$2"
  [[ -f "${temporary}" && ! -L "${temporary}" && "$(stat -c '%h' -- "${temporary}")" == 1 \
    && "$(dirname -- "${temporary}")" == "${FORGE_CUTOVER_RECORD_ROOT}" \
    && "$(dirname -- "${record}")" == "${FORGE_CUTOVER_RECORD_ROOT}" ]] || return 1
  command -v sync >/dev/null 2>&1 || return 1
  chmod 0600 "${temporary}" \
    && sync -- "${temporary}" \
    && mv --no-target-directory -- "${temporary}" "${record}" \
    && sync -- "${FORGE_CUTOVER_RECORD_ROOT}"
}

forge_cutover_transition_record() {
  local record="$1" promotion_state="$2" promoted="$3" temporary
  [[ -f "${record}" && ! -L "${record}" \
    && "${promotion_state}" =~ ^(prepared|promotion-intent|promoted)$ \
    && "${promoted}" =~ ^(true|false)$ ]] || return 1
  temporary="$(mktemp "${FORGE_CUTOVER_RECORD_ROOT}/.record.XXXXXX")" || return 1
  if ! jq -e --arg state "${promotion_state}" --argjson promoted "${promoted}" \
      '.promotionState=$state | .promoted=$promoted' "${record}" >"${temporary}" \
    || ! forge_cutover_publish_record_file "${temporary}" "${record}"; then
    rm -f -- "${temporary}"
    return 1
  fi
}

forge_cutover_container_snapshot() {
  local requested_id="$1" snapshot full_id name status image_id
  [[ "${requested_id}" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  snapshot="$(forge_cutover_docker inspect --type container --format '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.Image}}' "${requested_id}")" \
    || return 1
  IFS='|' read -r full_id name status image_id <<<"${snapshot}"
  name="${name#/}"
  [[ "${full_id}" =~ ^[0-9a-f]{64}$ && "${full_id}" == "${requested_id}"* \
    && "${name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && "${status}" =~ ^(running|paused|restarting|removing|exited|dead|created)$ \
    && "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  printf '%s|%s|%s|%s\n' "${full_id}" "${name}" "${status}" "${image_id}"
}

forge_cutover_contract_sha_from_file() {
  local inspect_file="$1" canonical digest
  [[ -f "${inspect_file}" && ! -L "${inspect_file}" ]] || return 1
  canonical="$(jq -cS -e '
    def canonical_mounts:
      (. // []) as $mounts
      | if (($mounts | type) != "array")
          or any($mounts[]; ((.Destination | type) != "string") or (.Destination == ""))
          or (($mounts | map(.Destination) | unique | length) != ($mounts | length))
        then error("container mounts do not have unique destinations")
        else ($mounts | sort_by(.Destination))
        end;
    def canonical_host_mounts:
      (. // []) as $mounts
      | if (($mounts | type) != "array")
          or any($mounts[]; ((.Target | type) != "string") or (.Target == ""))
          or (($mounts | map(.Target) | unique | length) != ($mounts | length))
        then error("host mounts do not have unique targets")
        else ($mounts
          | map(if .Type == "bind" then
              .BindOptions = ((.BindOptions // {})
                | .ReadOnlyNonRecursive = (.ReadOnlyNonRecursive // false))
            else . end)
          | sort_by(.Target))
        end;
    .[0]
    | {
        Image: .Image,
        Config: .Config,
        HostConfig: (.HostConfig
          | .OomKillDisable = (.OomKillDisable // false)
          | .Mounts = (.Mounts | canonical_host_mounts)),
        Mounts: (.Mounts | canonical_mounts),
        Networks: (.NetworkSettings.Networks // {})
      }
  ' "${inspect_file}")" || return 1
  digest="$(printf '%s\n' "${canonical}" | sha256sum)" || return 1
  digest="${digest%% *}"
  [[ "${digest}" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "${digest}"
}

forge_cutover_contract_sha_for_id() {
  local container_id="$1" inspect_json canonical digest
  [[ "${container_id}" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  inspect_json="$(forge_cutover_docker inspect --type container "${container_id}")" || return 1
  canonical="$(printf '%s\n' "${inspect_json}" | jq -cS -e '
    def canonical_mounts:
      (. // []) as $mounts
      | if (($mounts | type) != "array")
          or any($mounts[]; ((.Destination | type) != "string") or (.Destination == ""))
          or (($mounts | map(.Destination) | unique | length) != ($mounts | length))
        then error("container mounts do not have unique destinations")
        else ($mounts | sort_by(.Destination))
        end;
    def canonical_host_mounts:
      (. // []) as $mounts
      | if (($mounts | type) != "array")
          or any($mounts[]; ((.Target | type) != "string") or (.Target == ""))
          or (($mounts | map(.Target) | unique | length) != ($mounts | length))
        then error("host mounts do not have unique targets")
        else ($mounts
          | map(if .Type == "bind" then
              .BindOptions = ((.BindOptions // {})
                | .ReadOnlyNonRecursive = (.ReadOnlyNonRecursive // false))
            else . end)
          | sort_by(.Target))
        end;
    .[0]
    | {
        Image: .Image,
        Config: .Config,
        HostConfig: (.HostConfig
          | .OomKillDisable = (.OomKillDisable // false)
          | .Mounts = (.Mounts | canonical_host_mounts)),
        Mounts: (.Mounts | canonical_mounts),
        Networks: (.NetworkSettings.Networks // {})
      }
  ')" || return 1
  digest="$(printf '%s\n' "${canonical}" | sha256sum)" || return 1
  digest="${digest%% *}"
  [[ "${digest}" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "${digest}"
}

forge_cutover_network_id_mismatch_names_for_id() {
  local container_id="$1" networks_json network_name expected_network_id observed_network_id
  local -a network_names=() mismatch_names=()
  [[ "${container_id}" =~ ^[0-9a-f]{64}$ ]] || return 1
  networks_json="$(forge_cutover_docker inspect --type container --format '{{json .NetworkSettings.Networks}}' "${container_id}")" \
    || return 1
  printf '%s\n' "${networks_json}" \
    | jq -e 'type == "object"' >/dev/null || return 1
  mapfile -t network_names < <(printf '%s\n' "${networks_json}" | jq -r 'keys[]')
  for network_name in "${network_names[@]}"; do
    [[ "${network_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || return 1
    expected_network_id="$(printf '%s\n' "${networks_json}" \
      | jq -er --arg network "${network_name}" '.[$network].NetworkID | select(test("^[0-9a-f]{64}$"))')" \
      || { mismatch_names+=("${network_name}"); continue; }
    observed_network_id="$(forge_cutover_docker network inspect --format '{{.Id}}' "${network_name}" 2>/dev/null)" \
      || { mismatch_names+=("${network_name}"); continue; }
    [[ "${observed_network_id}" == "${expected_network_id}" ]] \
      || mismatch_names+=("${network_name}")
  done
  jq --compact-output --null-input --args '$ARGS.positional | unique | sort' -- "${mismatch_names[@]}"
}

forge_cutover_write_equivalence_diagnostic() {
  local logical_name="$1" initial_file="$2" current_file="$3" candidate_file="$4" network_plan_file="$5"
  local target_image_id="$6" target_config_hash="$7" source_image_labels="$8" target_image_labels="$9"
  local candidate_id="${10}" candidate_name="${11}" network_registry_mismatch_names="${12}"
  local runtime_template_file="${13:-${initial_file}}" runtime_template_mode="${14:-false}"
  local diagnostic_file temporary
  forge_cutover_require_context || return 1
  [[ "${logical_name}" =~ ^[a-z0-9][a-z0-9-]{1,63}$ \
    && "${target_image_id}" =~ ^sha256:[0-9a-f]{64}$ \
    && ( -z "${target_config_hash}" || "${target_config_hash}" =~ ^[0-9a-f]{64}$ ) \
    && "${candidate_id}" =~ ^[0-9a-f]{64}$ \
    && "${candidate_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && -f "${initial_file}" && ! -L "${initial_file}" \
    && -f "${current_file}" && ! -L "${current_file}" \
    && -f "${candidate_file}" && ! -L "${candidate_file}" \
    && -f "${network_plan_file}" && ! -L "${network_plan_file}" \
    && -f "${runtime_template_file}" && ! -L "${runtime_template_file}" \
    && "${runtime_template_mode}" =~ ^(true|false)$ ]] || return 1
  printf '%s\n' "${network_registry_mismatch_names}" \
    | jq -e 'type == "array" and all(.[]; type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$"))' \
      >/dev/null || return 1
  diagnostic_file="${FORGE_CUTOVER_RECORD_ROOT}/.${logical_name}.equivalence-diagnostic.json"
  [[ ! -e "${diagnostic_file}" && ! -L "${diagnostic_file}" ]] || return 1
  temporary="$(mktemp "${FORGE_CUTOVER_RECORD_ROOT}/.diagnostic.XXXXXX")" || return 1
  if ! jq -e --null-input \
      --arg logical "${logical_name}" --arg target_image "${target_image_id}" \
      --arg config_hash "${target_config_hash}" \
      --arg candidate_id "${candidate_id}" --arg candidate_name "${candidate_name}" \
      --argjson network_registry_mismatch_names "${network_registry_mismatch_names}" \
      --argjson source_image_labels "${source_image_labels}" --argjson target_image_labels "${target_image_labels}" \
      --argjson runtime_template_mode "${runtime_template_mode}" \
      --slurpfile initial "${initial_file}" --slurpfile current "${current_file}" \
      --slurpfile candidate "${candidate_file}" --slurpfile network_plan "${network_plan_file}" \
      --slurpfile runtime_template "${runtime_template_file}" '
      def differing_keys($expected; $actual):
        ((($expected | keys_unsorted) + ($actual | keys_unsorted)) | unique | sort)
        | map(. as $key | select($expected[$key] != $actual[$key]));
      def host_mounts_have_unique_targets:
        (. // []) as $mounts
        | (($mounts | type) == "array")
          and all($mounts[]; ((.Target | type) == "string") and (.Target != ""))
          and (($mounts | map(.Target) | unique | length) == ($mounts | length));
      def canonical_host_mounts:
        (. // [])
        | map(if .Type == "bind" then
            .BindOptions = ((.BindOptions // {})
              | .ReadOnlyNonRecursive = (.ReadOnlyNonRecursive // false))
          else . end)
        | sort_by(.Target);
      def normalize_host:
        .OomKillDisable = (.OomKillDisable // false)
        | .Mounts = (.Mounts | canonical_host_mounts);
      def safe_host_mount_differences($expected; $actual):
        ($expected | canonical_host_mounts) as $expected_mounts
        | ($actual | canonical_host_mounts) as $actual_mounts
        | [range(0; ([($expected_mounts | length), ($actual_mounts | length)] | max)) as $index
            | ($expected_mounts[$index] // {}) as $expected_mount
            | ($actual_mounts[$index] // {}) as $actual_mount
            | {
                index: $index,
                sourceEqual: ($expected_mount.Source == $actual_mount.Source),
                targetEqual: ($expected_mount.Target == $actual_mount.Target),
                differingNonPathKeys: differing_keys(
                  ($expected_mount | del(.Source, .Target));
                  ($actual_mount | del(.Source, .Target))
                ),
                bindOptionsDifferingKeys: differing_keys(
                  ($expected_mount.BindOptions // {});
                  ($actual_mount.BindOptions // {})
                ),
                volumeOptionsDifferingKeys: differing_keys(
                  ($expected_mount.VolumeOptions // {});
                  ($actual_mount.VolumeOptions // {})
                ),
                tmpfsOptionsDifferingKeys: differing_keys(
                  ($expected_mount.TmpfsOptions // {});
                  ($actual_mount.TmpfsOptions // {})
                )
              }
            | select(
                (.sourceEqual | not)
                or (.targetEqual | not)
                or ((.differingNonPathKeys | length) > 0)
              )];
      def mounts_have_unique_destinations:
        (. // []) as $mounts
        | (($mounts | type) == "array")
          and all($mounts[]; ((.Destination | type) == "string") and (.Destination != ""))
          and (($mounts | map(.Destination) | unique | length) == ($mounts | length));
      def canonical_mounts:
        (. // []) | sort_by(.Destination);
      def endpoint_base:
        {
          IPAMConfig: .IPAMConfig, Links: .Links,
          Aliases: .Aliases, DriverOpts: .DriverOpts
        }
        | walk(if type == "object" then with_entries(select(.value != null)) else . end);
      def type_summary($object; $keys):
        reduce $keys[] as $key ({};
          .[$key] = (if ($object | has($key)) then ($object[$key] | type) else "missing" end));
      ($initial[0][0]) as $original
      | ($current[0][0]) as $original_now
      | ($candidate[0][0]) as $created
      | ($runtime_template[0][0]) as $runtime
      | ($network_plan[0].endpoints) as $expected_endpoints
      | (($original.Config.Labels // {}) | to_entries
        | map(. as $entry | select(
            ($entry.key | startswith("com.docker.compose."))
            or (($source_image_labels | has($entry.key)) | not)
            or ($entry.value != $source_image_labels[$entry.key])
          ))
        | from_entries) as $container_label_overrides
      | (($target_image_labels + $container_label_overrides)
        | if $config_hash == "" then . else .["com.docker.compose.config-hash"] = $config_hash end) as $expected_labels
      | (($runtime.Config.Hostname // "") == ($runtime.Id[0:12])) as $default_hostname
      | ($runtime.Config
          | .Hostname = (if $default_hostname then $created.Id[0:12] else ($runtime.Config.Hostname // "") end)
          | .Domainname = ($runtime.Config.Domainname // "")
          | .Image = $target_image
          | .Labels = $expected_labels) as $expected_config
      | ($runtime.HostConfig
          | .NetworkMode = (if $runtime_template_mode then $original.HostConfig.NetworkMode else .NetworkMode end)
          | .AutoRemove = false | .ContainerIDFile = "") as $expected_host
      | ($created.NetworkSettings.Networks // {}) as $created_endpoints
      | ($expected_endpoints | keys | sort) as $expected_network_names
      | ($created_endpoints | keys | sort) as $created_network_names
      | [($expected_network_names - $created_network_names)[]] as $missing_network_names
      | [($created_network_names - $expected_network_names)[]] as $unexpected_network_names
      | [$expected_network_names[] as $network
          | select($created_endpoints | has($network))
          | select(
              (($created_endpoints[$network].NetworkID // "") != "")
              and (($created_endpoints[$network].NetworkID // "") != ($original.NetworkSettings.Networks[$network].NetworkID // ""))
            )
          | $network] as $network_id_mismatch_names
      | [$expected_network_names[] as $network
          | select($created_endpoints | has($network))
          | (($expected_endpoints[$network] | endpoint_base)
              + (if (($expected_endpoints[$network].MacAddress // "") == "") then {}
                 else {MacAddress: $expected_endpoints[$network].MacAddress} end)
              + {GwPriority: ($expected_endpoints[$network].GwPriority // 0)}) as $expected_endpoint
          | (($created_endpoints[$network] | endpoint_base)
              + (if (($expected_endpoints[$network].MacAddress // "") == "") then {}
                 else {MacAddress: ($created_endpoints[$network].MacAddress // null)} end)
              + {GwPriority: ($created_endpoints[$network].GwPriority // 0)}) as $actual_endpoint
          | differing_keys($expected_endpoint; $actual_endpoint) as $differing_endpoint_keys
          | select(($differing_endpoint_keys | length) > 0)
          | {
              networkName: $network,
              differingKeys: $differing_endpoint_keys,
              expectedTypes: type_summary($expected_endpoint; $differing_endpoint_keys),
              actualTypes: type_summary($actual_endpoint; $differing_endpoint_keys)
            }] as $endpoint_differences
      | [$endpoint_differences[].networkName] as $endpoint_contract_mismatch_names
      | safe_host_mount_differences($expected_host.Mounts; $created.HostConfig.Mounts) as $host_mount_differences
      | {
          schemaVersion: 1,
          kind: "container-cutover-equivalence-diagnostic",
          logicalName: $logical,
          originalDrift: {
            idEqual: ($original_now.Id == $original.Id),
            nameEqual: ($original_now.Name == $original.Name),
            statusEqual: ($original_now.State.Status == $original.State.Status),
            imageEqual: ($original_now.Image == $original.Image),
            differingConfigKeys: differing_keys($original.Config; $original_now.Config),
            differingHostConfigKeys: differing_keys(($original.HostConfig | normalize_host); ($original_now.HostConfig | normalize_host)),
            initialHostMountsValid: ($original.HostConfig.Mounts | host_mounts_have_unique_targets),
            currentHostMountsValid: ($original_now.HostConfig.Mounts | host_mounts_have_unique_targets),
            initialMountsValid: ($original.Mounts | mounts_have_unique_destinations),
            currentMountsValid: ($original_now.Mounts | mounts_have_unique_destinations),
            mountsEqual: (
              ($original.Mounts | mounts_have_unique_destinations)
              and ($original_now.Mounts | mounts_have_unique_destinations)
              and (($original_now.Mounts | canonical_mounts) == ($original.Mounts | canonical_mounts))
            ),
            networksEqual: (($original_now.NetworkSettings.Networks // {}) == ($original.NetworkSettings.Networks // {}))
          },
          candidate: {
            idEqual: ($created.Id == $candidate_id),
            nameEqual: ($created.Name == ("/" + $candidate_name)),
            statusCreated: ($created.State.Status == "created"),
            imageExpected: ($created.Image == $target_image),
            differingConfigKeys: differing_keys($expected_config; $created.Config),
            differingHostConfigKeys: differing_keys(($expected_host | normalize_host); ($created.HostConfig | normalize_host)),
            hostMountDifferences: $host_mount_differences,
            expectedHostMountsValid: ($expected_host.Mounts | host_mounts_have_unique_targets),
            hostMountsValid: ($created.HostConfig.Mounts | host_mounts_have_unique_targets),
            mountsValid: ($created.Mounts | mounts_have_unique_destinations),
            mountsEqual: (
              ($runtime.Mounts | mounts_have_unique_destinations)
              and ($created.Mounts | mounts_have_unique_destinations)
              and (($created.Mounts | canonical_mounts) == ($runtime.Mounts | canonical_mounts))
            ),
            networksContractEqual: (
              ($missing_network_names | length) == 0
              and ($unexpected_network_names | length) == 0
              and ($network_registry_mismatch_names | length) == 0
              and ($network_id_mismatch_names | length) == 0
              and ($endpoint_contract_mismatch_names | length) == 0
            ),
            missingNetworkNames: $missing_network_names,
            unexpectedNetworkNames: $unexpected_network_names,
            networkRegistryIdMismatchNames: $network_registry_mismatch_names,
            networkIdMismatchNames: $network_id_mismatch_names,
            endpointContractMismatchNames: $endpoint_contract_mismatch_names,
            endpointDifferences: $endpoint_differences
          }
        }
    ' >"${temporary}" \
    || ! forge_cutover_publish_record_file "${temporary}" "${diagnostic_file}"; then
    rm -f -- "${temporary}"
    return 1
  fi
}

forge_cutover_container_health() {
  local container_id="$1" health
  [[ "${container_id}" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  health="$(forge_cutover_docker inspect --type container --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${container_id}")" \
    || return 1
  [[ "${health}" =~ ^(healthy|unhealthy|starting|missing)$ ]] || return 1
  printf '%s\n' "${health}"
}

forge_cutover_remove_candidate() {
  local candidate_id="$1" first_allowed_name="$2" second_allowed_name="${3:-}" inventory snapshot
  local full_id current_name current_status current_image
  [[ "${candidate_id}" =~ ^[0-9a-f]{64}$ \
    && "${first_allowed_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && ( -z "${second_allowed_name}" || "${second_allowed_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ) ]] \
    || return 1
  inventory="$(forge_cutover_docker ps --all --quiet --no-trunc --filter "id=${candidate_id}")" || return 1
  [[ -n "${inventory}" ]] || return 0
  [[ "${inventory}" == "${candidate_id}" ]] || return 1
  snapshot="$(forge_cutover_container_snapshot "${candidate_id}")" || return 1
  IFS='|' read -r full_id current_name current_status current_image <<<"${snapshot}"
  [[ "${full_id}" == "${candidate_id}" \
    && ( "${current_name}" == "${first_allowed_name}" \
      || ( -n "${second_allowed_name}" && "${current_name}" == "${second_allowed_name}" ) ) ]] \
    || return 1
  if [[ "${current_status}" =~ ^(running|paused|restarting)$ ]]; then
    forge_cutover_docker stop --time 10 "${candidate_id}" >/dev/null 2>&1 || true
  fi
  forge_cutover_docker rm --force "${candidate_id}" >/dev/null || return 1
  inventory="$(forge_cutover_docker ps --all --quiet --no-trunc --filter "id=${candidate_id}")" || return 1
  [[ -z "${inventory}" ]]
}

forge_cutover_prepare() {
  [[ $# -ge 3 && $# -le 5 ]] || return 1
  local logical_name="$1" original_id="$2" target_image_id="$3" target_config_hash="${4:-}" runtime_template_id="${5:-}"
  local record inspect_file runtime_template_file='' request_file response_file networks_file original_name original_status candidate_name
  local rollback_name candidate_id error_message record_temporary primary_network network_name network_id endpoint_json
  local source_image_id runtime_image_id source_image_labels target_image_labels resolved_target_image_id original_full_id runtime_template_mode=false
  local original_contract_sha candidate_contract_sha network_registry_mismatch_names api_prefix
  local -a additional_networks=()
  forge_cutover_require_context || return 1
  [[ "${original_id}" =~ ^[0-9a-f]{12,64}$ \
    && "${target_image_id}" =~ ^sha256:[0-9a-f]{64}$ \
    && ( -z "${target_config_hash}" || "${target_config_hash}" =~ ^[0-9a-f]{64}$ ) ]] || return 1
  api_prefix="$(forge_cutover_server_api_prefix)" || return 1
  record="$(forge_cutover_record_path "${logical_name}")" || return 1
  [[ ! -e "${record}" && ! -L "${record}" ]] || return 1
  inspect_file="$(mktemp "${FORGE_CUTOVER_RECORD_ROOT}/.inspect.XXXXXX")" || return 1
  request_file="$(mktemp "${FORGE_CUTOVER_RECORD_ROOT}/.create.XXXXXX")" || { rm -f -- "${inspect_file}"; return 1; }
  response_file="$(mktemp "${FORGE_CUTOVER_RECORD_ROOT}/.response.XXXXXX")" || { rm -f -- "${inspect_file}" "${request_file}"; return 1; }
  networks_file="$(mktemp "${FORGE_CUTOVER_RECORD_ROOT}/.networks.XXXXXX")" || { rm -f -- "${inspect_file}" "${request_file}" "${response_file}"; return 1; }
  if ! forge_cutover_docker inspect "${original_id}" >"${inspect_file}"; then
    rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1
  fi
  runtime_template_file="${inspect_file}"
  if ! original_name="$(jq -er '.[0].Name | ltrimstr("/")' "${inspect_file}")" \
    || ! original_status="$(jq -er '.[0].State.Status' "${inspect_file}")" \
    || ! source_image_id="$(jq -er '.[0].Image | select(test("^sha256:[0-9a-f]{64}$"))' "${inspect_file}")" \
    || ! original_full_id="$(jq -er '.[0].Id | select(test("^[0-9a-f]{64}$"))' "${inspect_file}")"; then
    rm -f -- "${inspect_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1
  fi
  [[ "${original_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && "${original_status}" =~ ^(running|paused|exited|created)$ \
    && "${original_full_id}" == "${original_id}"* ]] \
    || { rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1; }
  if [[ -n "${runtime_template_id}" ]]; then
    [[ "${runtime_template_id}" =~ ^[0-9a-f]{12,64}$ ]] || { rm -f -- "${inspect_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1; }
    runtime_template_file="$(mktemp "${FORGE_CUTOVER_RECORD_ROOT}/.template.XXXXXX")" \
      || { rm -f -- "${inspect_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1; }
    if ! forge_cutover_docker inspect "${runtime_template_id}" >"${runtime_template_file}" \
      || ! jq -e --arg requested "${runtime_template_id}" '
        .[0] | (.Id | test("^[0-9a-f]{64}$") and startswith($requested))
      ' "${runtime_template_file}" >/dev/null; then
      rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1
    fi
    runtime_template_mode=true
  fi
  if ! runtime_image_id="$(jq -er '.[0].Image | select(test("^sha256:[0-9a-f]{64}$"))' "${runtime_template_file}")" \
    || { [[ "${runtime_template_mode}" == true ]] && [[ "${runtime_image_id}" != "${target_image_id}" ]]; }; then
    rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1
  fi
  if ! resolved_target_image_id="$(forge_cutover_docker image inspect --format '{{.Id}}' "${target_image_id}")" \
    || [[ "${resolved_target_image_id}" != "${target_image_id}" ]] \
    || ! source_image_labels="$(forge_cutover_docker image inspect --format '{{json .Config.Labels}}' "${source_image_id}")" \
    || ! target_image_labels="$(forge_cutover_docker image inspect --format '{{json .Config.Labels}}' "${target_image_id}")"; then
    rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1
  fi
  [[ "${source_image_labels}" == null ]] && source_image_labels='{}'
  [[ "${target_image_labels}" == null ]] && target_image_labels='{}'
  if ! printf '%s\n' "${source_image_labels}" | jq -e 'type=="object" and all(to_entries[]; (.key|type)=="string" and (.value|type)=="string")' >/dev/null \
    || ! printf '%s\n' "${target_image_labels}" | jq -e 'type=="object" and all(to_entries[]; (.key|type)=="string" and (.value|type)=="string")' >/dev/null; then
    rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1
  fi
  candidate_name="forge-candidate-${FORGE_CUTOVER_OPERATION}-${logical_name}"
  rollback_name="forge-rollback-${FORGE_CUTOVER_OPERATION}-${logical_name}"
  [[ ${#candidate_name} -le 128 && ${#rollback_name} -le 128 \
    && ! "$(forge_cutover_docker ps -aq --filter "name=^/${candidate_name}$")" \
    && ! "$(forge_cutover_docker ps -aq --filter "name=^/${rollback_name}$")" ]] \
    || { rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1; }

  # NetworkSettings.MacAddress is runtime state unless Docker records an
  # explicit container MAC in Config.  This helper intentionally fails closed
  # for that uncommon explicit-MAC contract instead of guessing which endpoint
  # it belongs to.  Top-level mount ordering is not stable, but destinations
  # must remain unique so later comparisons can sort without ambiguity.
  if ! jq -e '
    def mounts_have_unique_destinations:
      (. // []) as $mounts
      | (($mounts | type) == "array")
        and all($mounts[]; ((.Destination | type) == "string") and (.Destination != ""))
        and (($mounts | map(.Destination) | unique | length) == ($mounts | length));
    def host_mounts_have_unique_targets:
      (. // []) as $mounts
      | (($mounts | type) == "array")
        and all($mounts[]; ((.Target | type) == "string") and (.Target != ""))
        and (($mounts | map(.Target) | unique | length) == ($mounts | length));
    .[0] as $container
    | (($container.Config.MacAddress // "") == "")
      and ($container.Mounts | mounts_have_unique_destinations)
      and ($container.HostConfig.Mounts | host_mounts_have_unique_targets)
  ' "${inspect_file}" >/dev/null \
    || ! jq -e '
      def mounts_have_unique_destinations:
        (. // []) as $mounts
        | (($mounts | type) == "array")
          and all($mounts[]; ((.Destination | type) == "string") and (.Destination != ""))
          and (($mounts | map(.Destination) | unique | length) == ($mounts | length));
      def host_mounts_have_unique_targets:
        (. // []) as $mounts
        | (($mounts | type) == "array")
          and all($mounts[]; ((.Target | type) == "string") and (.Target != ""))
          and (($mounts | map(.Target) | unique | length) == ($mounts | length));
      .[0] as $container
      | (($container.Config.MacAddress // "") == "")
        and ($container.Mounts | mounts_have_unique_destinations)
        and ($container.HostConfig.Mounts | host_mounts_have_unique_targets)
    ' "${runtime_template_file}" >/dev/null; then
    printf 'Explicit container MAC or ambiguous mount destinations are not eligible for automatic cutover.\n' >&2
    rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"
    return 1
  fi

  if ! jq '
    .[0] as $container
    | (($container.NetworkSettings.Networks // {})
      | with_entries(.value = {
          IPAMConfig: .value.IPAMConfig, Links: .value.Links,
          Aliases: .value.Aliases, DriverOpts: .value.DriverOpts,
          GwPriority: (if (.value.GwPriority // 0) == 0 then null else .value.GwPriority end)
        })
      | walk(if type == "object" then with_entries(select(.value != null)) else . end)) as $endpoints
    | ($container.HostConfig.NetworkMode // "") as $network_mode
    | {
        primary: (if ($endpoints | has($network_mode)) then $network_mode else (($endpoints | keys | sort | .[0]) // null) end),
        endpoints: $endpoints
      }
  ' "${inspect_file}" >"${networks_file}"; then
    rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1
  fi
  primary_network="$(jq -r '.primary // ""' "${networks_file}")" \
    || { rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1; }

  if ! jq --arg image "${target_image_id}" --arg config_hash "${target_config_hash}" \
    --argjson source_image_labels "${source_image_labels}" --argjson target_image_labels "${target_image_labels}" \
    --arg primary_network "${primary_network}" --argjson runtime_template_mode "${runtime_template_mode}" \
    --slurpfile original "${inspect_file}" '
    .[0] as $container
    | ($original[0][0]) as $original
    | (($original.Config.Labels // {}) | to_entries
      | map(. as $entry | select(
          ($entry.key | startswith("com.docker.compose."))
          or (($source_image_labels | has($entry.key)) | not)
          or ($entry.value != $source_image_labels[$entry.key])
        ))
      | from_entries) as $container_label_overrides
    | (($container.Config
        | .Hostname = (if ($container.Config.Hostname // "") == ($container.Id[0:12]) then "" else ($container.Config.Hostname // "") end)
        | .Domainname = ($container.Config.Domainname // "")
        | .Image = $image
        | .Labels = (($target_image_labels + $container_label_overrides)
          | if $config_hash == "" then . else .["com.docker.compose.config-hash"] = $config_hash end))
      + {
        HostConfig: {
          Binds: $container.HostConfig.Binds, LogConfig: $container.HostConfig.LogConfig,
          Mounts: $container.HostConfig.Mounts,
          NetworkMode: (if $runtime_template_mode then $original.HostConfig.NetworkMode else $container.HostConfig.NetworkMode end), PortBindings: $container.HostConfig.PortBindings,
          RestartPolicy: $container.HostConfig.RestartPolicy, AutoRemove: false, ContainerIDFile: "",
          VolumeDriver: $container.HostConfig.VolumeDriver, VolumesFrom: $container.HostConfig.VolumesFrom,
          CapAdd: $container.HostConfig.CapAdd, CapDrop: $container.HostConfig.CapDrop,
          CgroupnsMode: $container.HostConfig.CgroupnsMode, Dns: $container.HostConfig.Dns,
          DnsOptions: $container.HostConfig.DnsOptions, DnsSearch: $container.HostConfig.DnsSearch,
          ExtraHosts: $container.HostConfig.ExtraHosts, GroupAdd: $container.HostConfig.GroupAdd,
          IpcMode: $container.HostConfig.IpcMode, Cgroup: $container.HostConfig.Cgroup,
          Links: $container.HostConfig.Links, OomScoreAdj: $container.HostConfig.OomScoreAdj,
          PidMode: $container.HostConfig.PidMode, Init: $container.HostConfig.Init, Privileged: $container.HostConfig.Privileged,
          PublishAllPorts: $container.HostConfig.PublishAllPorts,
          ReadonlyRootfs: $container.HostConfig.ReadonlyRootfs,
          SecurityOpt: $container.HostConfig.SecurityOpt, StorageOpt: $container.HostConfig.StorageOpt,
          Tmpfs: $container.HostConfig.Tmpfs, UTSMode: $container.HostConfig.UTSMode,
          UsernsMode: $container.HostConfig.UsernsMode, ShmSize: $container.HostConfig.ShmSize,
          Sysctls: $container.HostConfig.Sysctls, Runtime: $container.HostConfig.Runtime,
          MaskedPaths: $container.HostConfig.MaskedPaths, ReadonlyPaths: $container.HostConfig.ReadonlyPaths,
          CpuShares: $container.HostConfig.CpuShares, Memory: $container.HostConfig.Memory,
          NanoCpus: $container.HostConfig.NanoCpus, CgroupParent: $container.HostConfig.CgroupParent,
          BlkioWeight: $container.HostConfig.BlkioWeight,
          BlkioWeightDevice: $container.HostConfig.BlkioWeightDevice,
          BlkioDeviceReadBps: $container.HostConfig.BlkioDeviceReadBps,
          BlkioDeviceWriteBps: $container.HostConfig.BlkioDeviceWriteBps,
          BlkioDeviceReadIOps: $container.HostConfig.BlkioDeviceReadIOps,
          BlkioDeviceWriteIOps: $container.HostConfig.BlkioDeviceWriteIOps,
          CpuPeriod: $container.HostConfig.CpuPeriod, CpuQuota: $container.HostConfig.CpuQuota,
          CpuRealtimePeriod: $container.HostConfig.CpuRealtimePeriod,
          CpuRealtimeRuntime: $container.HostConfig.CpuRealtimeRuntime,
          CpusetCpus: $container.HostConfig.CpusetCpus, CpusetMems: $container.HostConfig.CpusetMems,
          Devices: $container.HostConfig.Devices, DeviceCgroupRules: $container.HostConfig.DeviceCgroupRules,
          DeviceRequests: $container.HostConfig.DeviceRequests,
          MemoryReservation: $container.HostConfig.MemoryReservation,
          MemorySwap: $container.HostConfig.MemorySwap,
          MemorySwappiness: $container.HostConfig.MemorySwappiness,
          OomKillDisable: $container.HostConfig.OomKillDisable,
          PidsLimit: $container.HostConfig.PidsLimit, Ulimits: $container.HostConfig.Ulimits
        },
        NetworkingConfig: {EndpointsConfig: (($original.NetworkSettings.Networks // {})
          | with_entries(.value = {
              IPAMConfig: .value.IPAMConfig, Links: .value.Links,
              Aliases: .value.Aliases, DriverOpts: .value.DriverOpts,
              GwPriority: (if (.value.GwPriority // 0) == 0 then null else .value.GwPriority end)
            })
          | if $primary_network == "" then {} else with_entries(select(.key == $primary_network)) end)}
      })
    | walk(if type == "object" then with_entries(select(.value != null)) else . end)
  ' "${runtime_template_file}" >"${request_file}"; then
    rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1
  fi
  if ! curl --fail-with-body --silent --show-error --unix-socket /var/run/docker.sock \
      --header 'Content-Type: application/json' --request POST \
      --data-binary "@${request_file}" \
      "http://localhost/${api_prefix}/containers/create?name=${candidate_name}" >"${response_file}"; then
    error_message="$(jq -r '.message // "Docker Engine rejected candidate creation."' "${response_file}" 2>/dev/null || true)"
    printf '%s\n' "${error_message}" >&2
    rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1
  fi
  if ! candidate_id="$(jq -er '.Id | select(test("^[0-9a-f]{64}$"))' "${response_file}")"; then
    candidate_id="$(forge_cutover_docker ps --all --quiet --no-trunc --filter "name=^/${candidate_name}$")" || candidate_id=''
    if [[ "${candidate_id}" =~ ^[0-9a-f]{64}$ ]]; then
      forge_cutover_remove_candidate "${candidate_id}" "${candidate_name}" \
        || printf 'Candidate cleanup could not be verified after an ambiguous create response.\n' >&2
    else
      printf 'Candidate identity could not be reconciled after an ambiguous create response.\n' >&2
    fi
    rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1
  fi
  mapfile -t additional_networks < <(jq -r --arg primary "${primary_network}" '.endpoints | keys[] | select(. != $primary)' "${networks_file}")
  for network_name in "${additional_networks[@]}"; do
    if [[ ! "${network_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
      || ! network_id="$(forge_cutover_docker network inspect --format '{{.Id}}' "${network_name}")" \
      || [[ ! "${network_id}" =~ ^[0-9a-f]{64}$ ]] \
      || ! endpoint_json="$(jq -c --arg network "${network_name}" '.endpoints[$network]' "${networks_file}")" \
      || ! jq --null-input --arg container "${candidate_id}" --argjson endpoint "${endpoint_json}" \
        '{Container:$container,EndpointConfig:$endpoint}' >"${request_file}" \
      || ! curl --fail-with-body --silent --show-error --unix-socket /var/run/docker.sock \
        --header 'Content-Type: application/json' --request POST \
        --data-binary "@${request_file}" \
        "http://localhost/${api_prefix}/networks/${network_id}/connect" >"${response_file}"; then
      error_message="$(jq -r '.message // "Docker Engine rejected an additional candidate network."' "${response_file}" 2>/dev/null || true)"
      printf '%s\n' "${error_message:-Docker Engine rejected an additional candidate network.}" >&2
      forge_cutover_remove_candidate "${candidate_id}" "${candidate_name}" \
        || printf 'Candidate cleanup could not be verified after a network attachment failure.\n' >&2
      rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"
      return 1
    fi
  done

  # Re-read both containers after Docker has canonicalized the create/connect
  # requests.  The original has not been stopped yet, so any drift can fail
  # closed without causing a service interruption.
  if ! forge_cutover_docker inspect "${candidate_id}" >"${response_file}" \
    || ! forge_cutover_docker inspect "${original_id}" >"${request_file}"; then
    printf 'Docker could not re-inspect both containers for equivalence.\n' >&2
    forge_cutover_remove_candidate "${candidate_id}" "${candidate_name}" \
      || printf 'Candidate cleanup could not be verified after re-inspection failure.\n' >&2
    rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"
    return 1
  fi
  network_registry_mismatch_names="$(forge_cutover_network_id_mismatch_names_for_id "${original_full_id}")" \
    || { forge_cutover_remove_candidate "${candidate_id}" "${candidate_name}" \
      || printf 'Candidate cleanup could not be verified after network inventory failure.\n' >&2;
      rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"; return 1; }
  if [[ "${network_registry_mismatch_names}" != '[]' ]] \
    || ! jq -e --null-input \
      --arg candidate_id "${candidate_id}" --arg candidate_name "${candidate_name}" \
      --arg target_image "${target_image_id}" --arg config_hash "${target_config_hash}" \
      --argjson source_image_labels "${source_image_labels}" --argjson target_image_labels "${target_image_labels}" \
      --argjson runtime_template_mode "${runtime_template_mode}" \
      --slurpfile initial "${inspect_file}" --slurpfile current "${request_file}" \
      --slurpfile candidate "${response_file}" --slurpfile network_plan "${networks_file}" \
      --slurpfile runtime_template "${runtime_template_file}" '
      def endpoint_base:
        {
          IPAMConfig: .IPAMConfig, Links: .Links,
          Aliases: .Aliases, DriverOpts: .DriverOpts
        }
        | walk(if type == "object" then with_entries(select(.value != null)) else . end);
      def host_mounts_have_unique_targets:
        (. // []) as $mounts
        | (($mounts | type) == "array")
          and all($mounts[]; ((.Target | type) == "string") and (.Target != ""))
          and (($mounts | map(.Target) | unique | length) == ($mounts | length));
      def canonical_host_mounts:
        (. // [])
        | map(if .Type == "bind" then
            .BindOptions = ((.BindOptions // {})
              | .ReadOnlyNonRecursive = (.ReadOnlyNonRecursive // false))
          else . end)
        | sort_by(.Target);
      def normalize_host:
        .OomKillDisable = (.OomKillDisable // false)
        | .Mounts = (.Mounts | canonical_host_mounts);
      def mounts_have_unique_destinations:
        (. // []) as $mounts
        | (($mounts | type) == "array")
          and all($mounts[]; ((.Destination | type) == "string") and (.Destination != ""))
          and (($mounts | map(.Destination) | unique | length) == ($mounts | length));
      def canonical_mounts:
        (. // []) | sort_by(.Destination);
      ($initial[0][0]) as $original
      | ($current[0][0]) as $original_now
      | ($candidate[0][0]) as $created
      | ($runtime_template[0][0]) as $runtime
      | ($network_plan[0].endpoints) as $expected_endpoints
      | (($original.Config.Labels // {}) | to_entries
        | map(. as $entry | select(
            ($entry.key | startswith("com.docker.compose."))
            or (($source_image_labels | has($entry.key)) | not)
            or ($entry.value != $source_image_labels[$entry.key])
          ))
        | from_entries) as $container_label_overrides
      | (($target_image_labels + $container_label_overrides)
        | if $config_hash == "" then . else .["com.docker.compose.config-hash"] = $config_hash end) as $expected_labels
      | (($runtime.Config.Hostname // "") == ($runtime.Id[0:12])) as $default_hostname
      | ($runtime.Config
          | .Hostname = (if $default_hostname then $created.Id[0:12] else ($runtime.Config.Hostname // "") end)
          | .Domainname = ($runtime.Config.Domainname // "")
          | .Image = $target_image
          | .Labels = $expected_labels) as $expected_config
      | ($runtime.HostConfig
          | .NetworkMode = (if $runtime_template_mode then $original.HostConfig.NetworkMode else .NetworkMode end)
          | .AutoRemove = false | .ContainerIDFile = "") as $expected_host
      | ($created.NetworkSettings.Networks // {}) as $created_endpoints
      | ($original_now.Id == $original.Id)
        and ($original_now.Name == $original.Name)
        and ($original_now.State.Status == $original.State.Status)
        and ($original_now.Image == $original.Image)
        and ($original_now.Config == $original.Config)
        and ($original.HostConfig.Mounts | host_mounts_have_unique_targets)
        and ($original_now.HostConfig.Mounts | host_mounts_have_unique_targets)
        and (($original_now.HostConfig | normalize_host) == ($original.HostConfig | normalize_host))
        and ($original.Mounts | mounts_have_unique_destinations)
        and ($original_now.Mounts | mounts_have_unique_destinations)
        and (($original_now.Mounts | canonical_mounts) == ($original.Mounts | canonical_mounts))
        and (($original_now.NetworkSettings.Networks // {}) == ($original.NetworkSettings.Networks // {}))
        and ($created.Id == $candidate_id)
        and ($created.Name == ("/" + $candidate_name))
        and ($created.State.Status == "created")
        and ($created.Image == $target_image)
        and ($created.Config == $expected_config)
        and ($created.HostConfig.Mounts | host_mounts_have_unique_targets)
        and (($created.HostConfig | normalize_host) == ($expected_host | normalize_host))
        and ($created.Mounts | mounts_have_unique_destinations)
        and (($created.Mounts | canonical_mounts) == ($runtime.Mounts | canonical_mounts))
        and (($created_endpoints | keys | sort) == ($expected_endpoints | keys | sort))
        and ([($expected_endpoints | keys[]) as $network
          | (($original.NetworkSettings.Networks[$network].NetworkID // "") | test("^[0-9a-f]{64}$"))
            and (
              (($created_endpoints[$network].NetworkID // "") == "")
              or (($created_endpoints[$network].NetworkID // "") == $original.NetworkSettings.Networks[$network].NetworkID)
            )
            and (($created_endpoints[$network] | endpoint_base) == ($expected_endpoints[$network] | endpoint_base))
            and ((($expected_endpoints[$network].MacAddress // "") == "")
              or (($created_endpoints[$network].MacAddress // "") == $expected_endpoints[$network].MacAddress))
            and (($created_endpoints[$network].GwPriority // 0)
              == ($expected_endpoints[$network].GwPriority // 0))
        ] | all)
    ' >/dev/null; then
    printf 'Docker canonicalized the candidate away from the original container contract.\n' >&2
    forge_cutover_write_equivalence_diagnostic "${logical_name}" "${inspect_file}" "${request_file}" \
      "${response_file}" "${networks_file}" "${target_image_id}" "${target_config_hash}" \
      "${source_image_labels}" "${target_image_labels}" "${candidate_id}" "${candidate_name}" \
      "${network_registry_mismatch_names}" "${runtime_template_file}" "${runtime_template_mode}" \
      || printf 'A redacted equivalence diagnostic could not be published.\n' >&2
    forge_cutover_remove_candidate "${candidate_id}" "${candidate_name}" \
      || printf 'Candidate cleanup could not be verified after equivalence failure.\n' >&2
    rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"
    return 1
  fi

  if ! original_contract_sha="$(forge_cutover_contract_sha_from_file "${inspect_file}")" \
    || ! candidate_contract_sha="$(forge_cutover_contract_sha_from_file "${response_file}")"; then
    forge_cutover_remove_candidate "${candidate_id}" "${candidate_name}" \
      || printf 'Candidate cleanup could not be verified after contract hashing failed.\n' >&2
    rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"
    return 1
  fi

  if ! record_temporary="$(mktemp "${FORGE_CUTOVER_RECORD_ROOT}/.record.XXXXXX")"; then
    forge_cutover_remove_candidate "${candidate_id}" "${candidate_name}" \
      || printf 'Candidate cleanup could not be verified after record staging failed.\n' >&2
    rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"
    return 1
  fi
  if ! jq --null-input --arg logical "${logical_name}" --arg original "${original_id}" \
    --arg original_full "${original_full_id}" \
    --arg original_name "${original_name}" --arg original_status "${original_status}" \
    --arg candidate "${candidate_id}" --arg candidate_name "${candidate_name}" \
    --arg rollback_name "${rollback_name}" --arg target "${target_image_id}" \
    --arg original_contract_sha "${original_contract_sha}" --arg candidate_contract_sha "${candidate_contract_sha}" \
    '{schemaVersion:1,logicalName:$logical,original:{id:$original,fullId:$original_full,name:$original_name,status:$original_status},candidate:{id:$candidate,name:$candidate_name},rollbackName:$rollback_name,targetImageId:$target,contracts:{originalSha256:$original_contract_sha,candidateSha256:$candidate_contract_sha},promotionState:"prepared",promoted:false}' \
    >"${record_temporary}" \
    || ! forge_cutover_publish_record_file "${record_temporary}" "${record}"; then
    forge_cutover_remove_candidate "${candidate_id}" "${candidate_name}" \
      || printf 'Candidate cleanup could not be verified after record publication failure.\n' >&2
    rm -f -- "${record_temporary}" "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"
    return 1
  fi
  rm -f -- "${inspect_file}" "${runtime_template_file}" "${request_file}" "${response_file}" "${networks_file}"
}

forge_cutover_activate() {
  local record="$1" original_id original_full_id original_name candidate_id candidate_name original_status target_image_id
  local expected_original_contract expected_candidate_contract actual_original_contract actual_candidate_contract
  local original_snapshot candidate_snapshot original_full original_current_name original_current_status original_image
  local candidate_full candidate_current_name candidate_current_status candidate_image network_registry_mismatch_names
  original_id="$(jq -er '.original.id' "${record}")" || return 1
  original_full_id="$(jq -er '.original.fullId | select(test("^[0-9a-f]{64}$"))' "${record}")" || return 1
  original_name="$(jq -er '.original.name' "${record}")" || return 1
  candidate_id="$(jq -er '.candidate.id' "${record}")" || return 1
  candidate_name="$(jq -er '.candidate.name' "${record}")" || return 1
  original_status="$(jq -er '.original.status' "${record}")" || return 1
  target_image_id="$(jq -er '.targetImageId' "${record}")" || return 1
  expected_original_contract="$(jq -er '.contracts.originalSha256 | select(test("^[0-9a-f]{64}$"))' "${record}")" || return 1
  expected_candidate_contract="$(jq -er '.contracts.candidateSha256 | select(test("^[0-9a-f]{64}$"))' "${record}")" || return 1
  [[ "${original_id}" =~ ^[0-9a-f]{12,64}$ && "${original_full_id}" == "${original_id}"* \
    && "${candidate_id}" =~ ^[0-9a-f]{64}$ && "${original_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && "${candidate_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && "${original_status}" =~ ^(running|paused|exited|created)$ \
    && "${target_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1

  original_snapshot="$(forge_cutover_container_snapshot "${original_full_id}")" || return 1
  candidate_snapshot="$(forge_cutover_container_snapshot "${candidate_id}")" || return 1
  IFS='|' read -r original_full original_current_name original_current_status original_image <<<"${original_snapshot}"
  IFS='|' read -r candidate_full candidate_current_name candidate_current_status candidate_image <<<"${candidate_snapshot}"
  [[ "${original_full}" == "${original_full_id}" && "${original_current_name}" == "${original_name}" \
    && "${original_current_status}" == "${original_status}" \
    && "${candidate_full}" == "${candidate_id}" && "${candidate_current_name}" == "${candidate_name}" \
    && "${candidate_current_status}" == created && "${candidate_image}" == "${target_image_id}" ]] || return 1
  actual_original_contract="$(forge_cutover_contract_sha_for_id "${original_full_id}")" || return 1
  actual_candidate_contract="$(forge_cutover_contract_sha_for_id "${candidate_id}")" || return 1
  [[ "${actual_original_contract}" == "${expected_original_contract}" \
    && "${actual_candidate_contract}" == "${expected_candidate_contract}" ]] || return 1
  network_registry_mismatch_names="$(forge_cutover_network_id_mismatch_names_for_id "${original_full_id}")" \
    || return 1
  [[ "${network_registry_mismatch_names}" == '[]' ]] || return 1

  if [[ "${original_status}" == paused ]]; then forge_cutover_docker unpause "${original_id}" >/dev/null || return 1; fi
  if [[ "${original_status}" == running || "${original_status}" == paused ]]; then
    forge_cutover_docker stop --time 30 "${original_id}" >/dev/null || return 1
  fi
  forge_cutover_docker start "${candidate_id}" >/dev/null
}

forge_cutover_promote() {
  local record="$1" original_id candidate_id original_name candidate_name rollback_name target_image_id promoted promotion_state
  local original_snapshot candidate_snapshot original_full original_current_name original_current_status original_image
  local candidate_full candidate_current_name candidate_current_status candidate_image
  original_id="$(jq -er '.original.id' "${record}")" || return 1
  candidate_id="$(jq -er '.candidate.id' "${record}")" || return 1
  original_name="$(jq -er '.original.name' "${record}")" || return 1
  candidate_name="$(jq -er '.candidate.name' "${record}")" || return 1
  rollback_name="$(jq -er '.rollbackName' "${record}")" || return 1
  target_image_id="$(jq -er '.targetImageId' "${record}")" || return 1
  promoted="$(jq -r '.promoted | if type == "boolean" then tostring else error("invalid promoted state") end' "${record}")" || return 1
  promotion_state="$(jq -er 'if has("promotionState") then .promotionState elif .promoted then "promoted" else "prepared" end' "${record}")" || return 1
  [[ "${original_id}" =~ ^[0-9a-f]{12,64}$ && "${candidate_id}" =~ ^[0-9a-f]{64}$ \
    && "${original_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && "${candidate_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && "${rollback_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && "${target_image_id}" =~ ^sha256:[0-9a-f]{64}$ \
    && "${promotion_state}" =~ ^(prepared|promotion-intent|promoted)$ ]] || return 1

  original_snapshot="$(forge_cutover_container_snapshot "${original_id}")" || return 1
  candidate_snapshot="$(forge_cutover_container_snapshot "${candidate_id}")" || return 1
  IFS='|' read -r original_full original_current_name original_current_status original_image <<<"${original_snapshot}"
  IFS='|' read -r candidate_full candidate_current_name candidate_current_status candidate_image <<<"${candidate_snapshot}"
  [[ "${candidate_full}" == "${candidate_id}" && "${candidate_image}" == "${target_image_id}" \
    && ( ( "${original_current_name}" == "${original_name}" && "${candidate_current_name}" == "${candidate_name}" ) \
      || ( "${original_current_name}" == "${rollback_name}" && "${candidate_current_name}" == "${candidate_name}" ) \
      || ( "${original_current_name}" == "${rollback_name}" && "${candidate_current_name}" == "${original_name}" ) ) ]] \
    || return 1

  if [[ "${original_current_name}" != "${rollback_name}" || "${candidate_current_name}" != "${original_name}" \
    || "${promoted}" != true || "${promotion_state}" != promoted ]]; then
    forge_cutover_transition_record "${record}" promotion-intent false || return 1
  fi
  if [[ "${original_current_name}" == "${original_name}" ]]; then
    forge_cutover_docker rename "${original_id}" "${rollback_name}" || return 1
    original_snapshot="$(forge_cutover_container_snapshot "${original_id}")" || return 1
    IFS='|' read -r original_full original_current_name original_current_status original_image <<<"${original_snapshot}"
    [[ "${original_current_name}" == "${rollback_name}" ]] || return 1
  fi
  if [[ "${candidate_current_name}" != "${original_name}" ]]; then
    forge_cutover_docker rename "${candidate_id}" "${original_name}" || return 1
  fi
  original_snapshot="$(forge_cutover_container_snapshot "${original_id}")" || return 1
  candidate_snapshot="$(forge_cutover_container_snapshot "${candidate_id}")" || return 1
  IFS='|' read -r original_full original_current_name original_current_status original_image <<<"${original_snapshot}"
  IFS='|' read -r candidate_full candidate_current_name candidate_current_status candidate_image <<<"${candidate_snapshot}"
  [[ "${original_current_name}" == "${rollback_name}" && "${candidate_current_name}" == "${original_name}" \
    && "${candidate_image}" == "${target_image_id}" ]] || return 1
  forge_cutover_transition_record "${record}" promoted true
}

forge_cutover_rollback() {
  local record="$1" defer_start="${2:-false}" original_id candidate_id original_name original_status promoted candidate_name rollback_name
  local snapshot full_id current_name current_status current_image
  [[ -f "${record}" && ! -L "${record}" ]] || return 0
  original_id="$(jq -er '.original.id' "${record}")" || return 1
  candidate_id="$(jq -er '.candidate.id' "${record}")" || return 1
  original_name="$(jq -er '.original.name' "${record}")" || return 1
  original_status="$(jq -er '.original.status' "${record}")" || return 1
  candidate_name="$(jq -er '.candidate.name' "${record}")" || return 1
  rollback_name="$(jq -er '.rollbackName' "${record}")" || return 1
  promoted="$(jq -r '.promoted | if type == "boolean" then tostring else error("invalid promoted state") end' "${record}")" || return 1
  [[ "${defer_start}" =~ ^(true|false)$ && "${promoted}" =~ ^(true|false)$ \
    && "${original_id}" =~ ^[0-9a-f]{12,64}$ && "${candidate_id}" =~ ^[0-9a-f]{64}$ \
    && "${original_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && "${candidate_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && "${rollback_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && "${original_status}" =~ ^(running|paused|exited|created)$ ]] || return 1

  snapshot="$(forge_cutover_container_snapshot "${original_id}")" || return 1
  IFS='|' read -r full_id current_name current_status current_image <<<"${snapshot}"
  [[ "${current_name}" == "${original_name}" || "${current_name}" == "${rollback_name}" ]] || return 1
  forge_cutover_remove_candidate "${candidate_id}" "${candidate_name}" "${original_name}" || return 1

  snapshot="$(forge_cutover_container_snapshot "${original_id}")" || return 1
  IFS='|' read -r full_id current_name current_status current_image <<<"${snapshot}"
  if [[ "${current_name}" == "${rollback_name}" ]]; then
    forge_cutover_docker rename "${original_id}" "${original_name}" >/dev/null || return 1
    snapshot="$(forge_cutover_container_snapshot "${original_id}")" || return 1
    IFS='|' read -r full_id current_name current_status current_image <<<"${snapshot}"
  fi
  [[ "${current_name}" == "${original_name}" ]] || return 1
  [[ "${defer_start}" == true ]] && return 0
  forge_cutover_restore_original_state "${record}"
}

forge_cutover_restore_original_state() {
  local record="$1" original_id original_name original_status snapshot full_id current_name current_status current_image
  original_id="$(jq -er '.original.id' "${record}")" || return 1
  original_name="$(jq -er '.original.name' "${record}")" || return 1
  original_status="$(jq -er '.original.status' "${record}")" || return 1
  snapshot="$(forge_cutover_container_snapshot "${original_id}")" || return 1
  IFS='|' read -r full_id current_name current_status current_image <<<"${snapshot}"
  [[ "${current_name}" == "${original_name}" ]] || return 1
  case "${original_status}" in
    running)
      if [[ "${current_status}" == paused ]]; then forge_cutover_docker unpause "${original_id}" >/dev/null || return 1
      elif [[ "${current_status}" != running ]]; then forge_cutover_docker start "${original_id}" >/dev/null || return 1
      fi ;;
    paused)
      if [[ "${current_status}" == running ]]; then forge_cutover_docker pause "${original_id}" >/dev/null || return 1
      elif [[ "${current_status}" != paused ]]; then forge_cutover_docker start "${original_id}" >/dev/null && forge_cutover_docker pause "${original_id}" >/dev/null || return 1
      fi ;;
    exited|created) [[ "${current_status}" == "${original_status}" ]] || return 1 ;;
    *) return 1 ;;
  esac
  snapshot="$(forge_cutover_container_snapshot "${original_id}")" || return 1
  IFS='|' read -r full_id current_name current_status current_image <<<"${snapshot}"
  [[ "${current_name}" == "${original_name}" && "${current_status}" == "${original_status}" ]]
}

forge_cutover_discard_original() {
  local record="$1" original_id original_full_id original_name candidate_id rollback_name target_image_id promoted promotion_state
  local original_snapshot candidate_snapshot original_full original_current_name original_current_status original_image
  local candidate_full candidate_current_name candidate_current_status candidate_image candidate_health
  [[ -f "${record}" && ! -L "${record}" ]] || return 1
  original_id="$(jq -er '.original.id' "${record}")" || return 1
  original_full_id="$(jq -er '.original.fullId | select(test("^[0-9a-f]{64}$"))' "${record}")" || return 1
  original_name="$(jq -er '.original.name' "${record}")" || return 1
  candidate_id="$(jq -er '.candidate.id' "${record}")" || return 1
  rollback_name="$(jq -er '.rollbackName' "${record}")" || return 1
  target_image_id="$(jq -er '.targetImageId' "${record}")" || return 1
  promoted="$(jq -r '.promoted | if type == "boolean" then tostring else error("invalid promoted state") end' "${record}")" || return 1
  promotion_state="$(jq -er '.promotionState' "${record}")" || return 1
  [[ "${promoted}" == true && "${promotion_state}" == promoted \
    && "${original_id}" =~ ^[0-9a-f]{12,64}$ && "${original_full_id}" == "${original_id}"* \
    && "${candidate_id}" =~ ^[0-9a-f]{64}$ \
    && "${original_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && "${rollback_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ \
    && "${target_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1

  original_snapshot="$(forge_cutover_container_snapshot "${original_full_id}")" || return 1
  candidate_snapshot="$(forge_cutover_container_snapshot "${candidate_id}")" || return 1
  IFS='|' read -r original_full original_current_name original_current_status original_image <<<"${original_snapshot}"
  IFS='|' read -r candidate_full candidate_current_name candidate_current_status candidate_image <<<"${candidate_snapshot}"
  candidate_health="$(forge_cutover_container_health "${candidate_id}")" || return 1
  [[ "${original_full}" == "${original_full_id}" && "${original_current_name}" == "${rollback_name}" \
    && "${original_current_status}" =~ ^(exited|created)$ \
    && "${candidate_full}" == "${candidate_id}" && "${candidate_current_name}" == "${original_name}" \
    && "${candidate_current_status}" == running && "${candidate_health}" == healthy \
    && "${candidate_image}" == "${target_image_id}" ]] || return 1

  forge_cutover_remove_candidate "${original_full_id}" "${rollback_name}" || return 1
  candidate_snapshot="$(forge_cutover_container_snapshot "${candidate_id}")" || return 1
  IFS='|' read -r candidate_full candidate_current_name candidate_current_status candidate_image <<<"${candidate_snapshot}"
  candidate_health="$(forge_cutover_container_health "${candidate_id}")" || return 1
  [[ "${candidate_full}" == "${candidate_id}" && "${candidate_current_name}" == "${original_name}" \
    && "${candidate_current_status}" == running && "${candidate_health}" == healthy \
    && "${candidate_image}" == "${target_image_id}" ]]
}
