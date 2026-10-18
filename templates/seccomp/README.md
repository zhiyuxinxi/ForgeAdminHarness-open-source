The direct-worker seccomp baseline is the Moby default profile (Apache-2.0),
downloaded from https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json
on 2026-10-11. Its SHA-256 was
`6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6`.
The related AppArmor template is from
https://raw.githubusercontent.com/moby/profiles/main/apparmor/template.go
(SHA-256 `7da15d81aa5c507f5002b844fdc49a969904681447a2cc29222bd6cbe797163b`).
Copyright The Moby Authors. See [LICENSE.moby](LICENSE.moby).

Local changes permit only the separate direct worker's Bubblewrap user/mount/PID
namespace setup and mount/umount2/pivot_root operations. Other default seccomp
filters remain unchanged. The named AppArmor profile retains Docker proc/sys
protection while permitting that setup; network syntax matches Ubuntu's installed
parser. Neither profile grants capabilities in the outer container.

Install with `sudo bash scripts/install-direct-worker-isolation.sh`. The existing
TaskSpace composition path selects `compose.tool-worker.direct.yaml` only when
the operator sets `FORGE_DEVELOPMENT_MODE=direct` in that TaskSpace's environment.
The model container keeps its original security settings. No existing container
is recreated by the installer.

The inner sandbox exposes only six read-only machine-statistics files under
`/proc` to ordinary commands. Only the exact trusted browser-worker executable
gets a new private PID namespace with its own proc mount. It restores Docker's
sensitive proc masks and read-only subpaths before starting the browser; both
paths also hide firmware and powercap. Ordinary commands retain no process view.

Linux 6.8 rejects a new unprivileged proc mount when Docker's outer proc has
locked masked submounts. The common lifecycle/upgrade selector inspects the
configured image's `io.forge.tool-worker.private-proc=v1` capability and only
then adds `compose.tool-worker.private-proc.yaml` with `systempaths=unconfined`
for the credential-free worker. Older or locally unavailable images keep their
original masks; image tag strings and model policy options cannot enable it.
The base and overlay Dockerfiles declare the capability with the matching
sandbox, and incremental image validation binds it to the installed module.
Its proc still belongs
to the container's private PID namespace, never the host. The dedicated AppArmor
profile, seccomp, UID, zero capabilities, no-new-privileges and read-only root
remain required. Do not use this setting on the Harness or without the matching
`forge-direct-worker-sandbox.mjs` restoration. The lifecycle and explicit upgrade
paths share this capability selection; an image-only replacement that preserves the previous
HostConfig does not apply this configuration change. Reconcile only drained,
explicitly selected direct workers. Installing the template does not recreate
running TaskSpaces.
