#!/bin/sh

set -eu

if [ "$#" -gt 1 ]; then
  printf '%s\n' 'Usage: validate-runtime-tree-metadata.sh [runtime-root]' >&2
  exit 2
fi

runtime_root="${1:-/opt/forge-harness-runtime}"

[ -d "${runtime_root}" ] && [ ! -L "${runtime_root}" ] \
  || { printf 'Runtime dependency root is missing, linked, or non-directory: %s\n' "${runtime_root}" >&2; exit 1; }

# Symlink mode bits are not meaningful on Linux and are normally reported as
# 0777, so the write/set-id mode gate applies only to directories and files.
# UID/GID and link-count checks use find -P and therefore inspect each link
# inode itself without following it. The JS closure validator separately
# permits only contained relative node_modules/.bin launchers.
violation="$(
  LC_ALL=C find -P "${runtime_root}" -xdev \
    \( \
      \( ! -uid 0 -o ! -gid 0 \) \
      -o \( \( -type d -o -type f \) -a -perm /06022 \) \
      -o \( -type f -a ! -links 1 \) \
      -o \( -type l -a ! -links 1 \) \
      -o \( ! -type d -a ! -type f -a ! -type l \) \
    \) \
    -print -quit
)" || { printf '%s\n' 'Runtime dependency metadata traversal failed.' >&2; exit 1; }

if [ -n "${violation}" ]; then
  printf 'Runtime dependency metadata policy rejected: %s\n' "${violation}" >&2
  exit 1
fi
