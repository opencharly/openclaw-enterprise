---
rfc: ../rfcs/0019-crabbox-oce-deployment.md
---

# Implementation plan: Deploy OCE development environments with Crabbox

- **ID:** RFC-0019 (primary plan)
- **Delivery status:** Planned
- **Owner:** OCE deployment and development-launcher contributors
- **Authority:** [RFC-0019](../rfcs/0019-crabbox-oce-deployment.md)
- **Source baseline:** Enterprise `3d180654c`; Crabbox `3d9260e7`

## Outcome and scope

This plan delivers the RFC's [goals](../rfcs/0019-crabbox-oce-deployment.md#goals),
using the files and owners listed in its
[proposal](../rfcs/0019-crabbox-oce-deployment.md#proposal). Work starts once the
RFC is accepted.

## Contract and source touchpoints

The script owns `$HOME/.oce-crabbox/` (mode `0700`):

- `state/` is the launcher's state directory.
- `env` holds the non-secret `PATH` that hydration writes.
- `serve` records the Serve handler the script created.

The script exports the Kubernetes-only profile itself instead of relying on
Crabbox's per-lease environment file. As a result, teardown works without
hydration.

## Implementation

### 1. Launcher setting

Implement the RFC's [console origin](../rfcs/0019-crabbox-oce-deployment.md#console-origin)
contract in [`openshell_k3d.go`](../../internal/occdev/openshell_k3d.go). Read the
setting before any effect. Reject it, naming the setting in the error, in two
cases:

- the value has a path other than `/`, a query, a fragment, or user info; or
- the profile is unsupported, including when `OCC_DEVELOPMENT_SIGN_IN` is set.

Add unit tests for validation, Helm values with and without the setting, and
the printed output.

### 2. Toolchain profile

Add a `crabbox` profile to [`setup-tools.sh`](../../scripts/ci/setup-tools.sh).
It runs `require_docker` and the existing kubectl, k3d, Helm, and yq
installers. It also runs a new `install_go`, because local `actions/setup-go`
only verifies a Go that is already installed. `install_go` pins the newest Go
1.27 patch for `linux-amd64` and verifies its SHA-256 through
`download-pinned.sh`.

### 3. Hydration workflow

Write `.github/workflows/crabbox-hydrate.yml` to Crabbox's
[hydrate-workflow contract](https://github.com/openclaw/crabbox/blob/3d9260e7a37e025ed36b3c38fbcf1ae50e4a3520/docs/features/actions-hydration.md#authoring-a-hydrate-workflow),
with a `workflow_dispatch` trigger only. The workflow runs these steps in order:

1. **Check the host before changing it.** Refuse a host that does not match the
   [supported hosts](../rfcs/0019-crabbox-oce-deployment.md#hosts-and-lifetime)
   (`/etc/os-release`, `uname -m`). Also refuse it if `sudo -n true` fails,
   `cpuset` is missing from the cgroup v2 controllers, or `/var/lib` has less
   free space than the [Local Setup](../../docs/guides/quickstart.md#before-you-start)
   storage requirement.
2. **Prepare the host.** Install any missing `docker.io`, `docker-buildx`,
   `jq`, `curl`, and `git` packages, and add the user to the `docker` group.
   Persist the Codex sandbox sysctl in `/etc/sysctl.d/60-oce-development.conf`.
   Print each change.
3. **Install Node.js.** Run `actions/setup-node` with the `NODE_VERSION` from
   `.github/workflows/ci.yml`. Corepack then provides pnpm.
4. **Install the toolchain.** Run `setup-tools.sh crabbox` under `sg docker`,
   because the new group membership does not reach the current session.
5. **Mark the host ready.** Write `env`, then write Crabbox's environment file
   and readiness marker.

### 4. `scripts/crabbox/oce-dev`

Every failure prints `oce-dev: <stage> failed: <reason>`. If the Docker socket
denies access, the script reruns itself under `sg docker`.

`up [--tailscale]`:

1. Source `env`. If `state/` already exists, fail and print the teardown
   command.
2. With `--tailscale`, read `Self.DNSName` from `tailscale status --json` and
   drop its trailing dot. Require a `*.ts.net` name that appears in
   `CertDomains`. Then add the RFC's Serve handler and record it in `serve`.
3. Run `corepack pnpm install --frozen-lockfile`, `corepack pnpm cli:build`,
   and `scripts/dev-up`. If any step fails, remove the handler and exit with
   that step's status.
4. Run `bin/occ installation get` against `http://127.0.0.1:3000`. With
   `--tailscale`, also retry `curl --fail https://<name>/console/` for up to two
   minutes, because the first request provisions the certificate.

`down` attempts both of the following, reports both results, and exits non-zero
if either fails. With nothing to remove, it exits `0`.

- Remove the recorded handler by rerunning its command with `off`.
- If `state/` exists, run `scripts/dev-down`, building `bin/occ` first if it is
  missing.

### 5. Jobs

Verify `.crabbox.yaml` with `crabbox job list` and `crabbox job run --dry-run`.
If Crabbox rejects the YAML merge key, write the Tailscale job out in full. The
caller's configuration selects the provider.

```yaml
jobs:
  oce-deploy: &deploy
    target: linux
    architecture: amd64
    ttl: 4h
    idleTimeout: 4h
    hydrate: { actions: true, waitTimeout: 45m }
    actions: { workflow: .github/workflows/crabbox-hydrate.yml, job: hydrate }
    shell: true
    command: scripts/crabbox/oce-dev up
    stop: never
  oce-deploy-tailscale:
    <<: *deploy
    network: tailscale
    command: scripts/crabbox/oce-dev up --tailscale
  oce-teardown:
    target: linux
    architecture: amd64
    shell: true
    command: scripts/crabbox/oce-dev down
    stop: success
```

### 6. Documentation

- Add the setting to the [development settings](../../docs/reference/settings/development.md)
  and the [environment-variable cheat sheet](../../docs/reference/cheatsheets/environment-variables.md).
- Add `docs/guides/deploy/crabbox-development.md` and register it in
  [`docs.json`](../../docs/docs.json). The guide covers the job commands, the
  caller's [Crabbox Tailscale setup](https://github.com/openclaw/crabbox/blob/3d9260e7a37e025ed36b3c38fbcf1ae50e4a3520/docs/features/tailscale.md),
  lease reuse, and reading credentials through `crabbox ssh`. It links the RFC
  for supported hosts and lifetime.
- Link the guide from local Kubernetes development and from the remote-console
  troubleshooting section.
- Add `.crabbox.yaml` and `scripts/crabbox/` to the [repository layout](../../docs/layout.md).
- Add a flow as the [local-dev](../../.agents/skills/local-dev/SKILL.md) skill
  directs.

## Verification

| Goal | Check                                                                                                                                                                 | Result  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1    | Run `oce-deploy` on a fresh managed lease and on a static Ubuntu 24.04 host, recording provider and class. Run it again on a non-Ubuntu host.                         | Not run |
| 2    | After `oce-deploy-tailscale`, a second device signs in and lists a resource. Repeat with a policy-denied device, an off-tailnet device, and `curl` without a session. | Not run |
| 3    | Run the job against a host Crabbox cannot reach over the tailnet, and on a tailnet with HTTPS certificates disabled.                                                  | Not run |
| 4    | Unit tests from step 1. The real k3d lane signs in through `127.0.0.1:8443` with the configured `Origin`, and existing tests pass with the setting unset.             | Not run |
| 5    | Redeploy on a used lease, then tear down with `--stop never` and redeploy. Force `dev-down` to fail and inspect the Serve configuration and the lease.                | Not run |
| 6    | Search the job output and Crabbox logs for password and key contents.                                                                                                 | Not run |

A fixture test with stub `tailscale` and `occ` commands covers the step
ordering in `oce-dev`. It does not replace the remote checks.

## Delivery record

Not started.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-13: Authored against Enterprise `3d180654c` and Crabbox `3d9260e7`.
