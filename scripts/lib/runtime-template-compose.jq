def resource_references($root; $selected; $field):
  [
    $selected[] as $service
    | ($root.services[$service][$field] // [])[]
    | if type == "string" then .
      elif type == "object" and (.source | type) == "string" and .source != "" then .source
      else error("selected service has an invalid \($field) reference")
      end
  ]
  | unique;

def selected_resources($root; $names; $field):
  if ($names | length) == 0 then null
  else
    reduce $names[] as $name ({};
      if (($root[$field] // {}) | has($name)) then
        .[$name] = $root[$field][$name]
      else
        error("selected service references missing \($field) resource: \($name)")
      end)
  end;

if ($services | type) != "array"
    or ($services | length) == 0
    or any($services[]; type != "string" or test("^[a-z0-9][a-z0-9-]*$") | not)
    or (($services | unique | length) != ($services | length)) then
  error("services must be a non-empty array of unique canonical service names")
elif (.services | type) != "object" then
  error("Compose document has no services object")
else
  . as $root
  | $services as $selected
  | if ([
      $selected[] as $service
      | select(($root.services | has($service)) | not)
    ] | length) != 0 then
      error("requested runtime-template service is absent")
    elif ([
      $selected[] as $service
      | ($root.services[$service].volumes // [])[]
      | select(type != "object" or .type != "bind")
    ] | length) != 0 then
      error("runtime-template services may use only bind volumes")
    else
      resource_references($root; $selected; "secrets") as $secret_names
      | resource_references($root; $selected; "configs") as $config_names
      | selected_resources($root; $secret_names; "secrets") as $selected_secrets
      | selected_resources($root; $config_names; "configs") as $selected_configs
      | .services = reduce $selected[] as $service ({};
          .[$service] = ($root.services[$service]
            | del(.depends_on, .networks)
            | .network_mode = "none"))
      | del(.networks, .volumes, .secrets, .configs)
      | if $selected_secrets != null then .secrets = $selected_secrets else . end
      | if $selected_configs != null then .configs = $selected_configs else . end
      # Compose interpolates JSON input too. Escape the already-resolved values
      # exactly once so a second `compose config` preserves every literal `$`.
      | walk(if type == "string" then gsub("\\$"; "$$") else . end)
    end
end
