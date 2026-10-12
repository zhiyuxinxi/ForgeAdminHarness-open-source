#!/usr/bin/env bash
set -euo pipefail

if (( EUID != 0 )); then
  echo 'Run this fixed host installer as root.' >&2
  exit 1
fi
if (( $# != 0 )); then
  echo 'This installer takes no arguments.' >&2
  exit 1
fi

SOURCE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM_ROOT='/opt/forge-delivery-platform'
UNIT_ROOT='/etc/systemd/system'
UNIT='forge-containerd-metadata-residency.service'
changed=0
temporary_files=()
trap 'for temporary_file in "${temporary_files[@]}"; do rm -f -- "$temporary_file"; done' EXIT

install_if_changed() {
  local source="$1" destination="$2" mode="$3" temporary_file
  if [[ ! -f "$source" || -L "$source" || -L "$destination" ]]; then
    echo "Expected regular source and non-symlink destination: $source -> $destination" >&2
    exit 1
  fi
  if [[ -f "$destination" ]] && cmp -s -- "$source" "$destination"; then
    return
  fi
  if [[ ! -d "$(dirname -- "$destination")" ]]; then
    install -d -m 0755 -o root -g root -- "$(dirname -- "$destination")"
  fi
  temporary_file="$(mktemp "${destination}.install.XXXXXX")"
  temporary_files+=("$temporary_file")
  install -m "$mode" -o root -g root -- "$source" "$temporary_file"
  mv -f -- "$temporary_file" "$destination"
  changed=1
}

install_if_changed "$SOURCE_ROOT/scripts/containerd-metadata-residency.py" \
  "$PLATFORM_ROOT/scripts/containerd-metadata-residency.py" 0755
install_if_changed "$SOURCE_ROOT/templates/systemd/$UNIT" "$UNIT_ROOT/$UNIT" 0644

if (( changed )); then
  systemctl daemon-reload
fi
if ! systemctl is-enabled --quiet "$UNIT"; then
  systemctl enable "$UNIT"
fi
if (( changed )); then
  systemctl restart "$UNIT"
  echo 'Metadata residency files updated; only the residency helper was restarted.'
else
  if ! systemctl is-active --quiet "$UNIT"; then
    systemctl start "$UNIT"
  fi
  echo 'Metadata residency files unchanged; helper enabled and active.'
fi
