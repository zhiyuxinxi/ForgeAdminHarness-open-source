#!/usr/bin/env sh

set -eu

readonly jansi_tmpdir='/tmp/forge-maven-jansi'
readonly expected_maven_opts="-Djansi.tmpdir=${jansi_tmpdir}"

if [ "$#" -lt 1 ] || [ "$1" != 'mvn' ]; then
  printf '%s\n' 'maven-verification-exec: expected mvn argv' >&2
  exit 64
fi
if [ "${MAVEN_OPTS:-}" != "${expected_maven_opts}" ]; then
  printf '%s\n' 'maven-verification-exec: MAVEN_OPTS contract mismatch' >&2
  exit 64
fi

rm -rf -- "${jansi_tmpdir}"
install -d -m 0700 -- "${jansi_tmpdir}"

cleanup() {
  rm -rf -- "${jansi_tmpdir}"
}
trap cleanup EXIT HUP INT TERM

"$@"
