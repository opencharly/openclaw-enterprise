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

Deliver the RFC's [required outcomes](../rfcs/0019-crabbox-oce-deployment.md#delivery-and-verification).
The RFC owns the rationale, supported hosts, and trust boundaries. Work starts
once the RFC is accepted.

## Contract and source touchpoints

- **Launcher:** [`openshell_k3d.go`](../../internal/occdev/openshell_k3d.go) and its tests.
- **Deployment:** new `.crabbox.yaml`, `.github/workflows/crabbox-hydrate.yml`, and
  `scripts/crabbox/oce-dev`, plus a `crabbox` profile in
  [`setup-tools.sh`](../../scripts/ci/setup-tools.sh).
- **Documentation:** [development settings](../../docs/reference/settings/development.md),
  the [environment-variable cheat sheet](../../docs/reference/cheatsheets/environment-variables.md),
  a new deploy guide, [`docs.json`](../../docs/docs.json), [layout](../../docs/layout.md),
  and a flow per [local-dev](../../.agents/skills/local-dev/SKILL.md).

The script owns `$HOME/.oce-crabbox/` (mode `0700`), which holds three entries:

- `state/` is the launcher state directory.
- `env` is the non-secret `PATH` written by hydration.
- `serve` records the Serve handler.

The script exports the Kubernetes-only profile itself. It does not rely on
Crabbox's per-lease env file, so teardown works without hydration.

## Implementation

### 1. Launcher setting

Read `OCC_DEVELOPMENT_BROWSER_ORIGIN` with the other settings. Reject it before
any effect in these cases:

- it is not an `https` origin;
- it has a path other than `/`, a query, a fragment, or user info;
- the profile is not Kubernetes-only with the `none` sandbox driver; or
- `OCC_DEVELOPMENT_SIGN_IN` is set.

When the setting is valid:

- set `auth.baseUrl` to the origin;
- skip `agentNativeAdmin`; and
- print `Browser console: <origin>/console/` without the CA lines.

Unit-test the validation, the Helm values with and without the setting, and the
printed output.

### 2. Toolchain profile

Add a `crabbox` profile that runs `require_docker`, the kubectl, k3d, Helm, and
yq installers, and a new `install_go`. Local `actions/setup-go` cannot install
Go, so `install_go` pins the newest Go 1.27 patch release for `linux-amd64`,
verifies its SHA-256, and downloads it through `download-pinned.sh`.

### 3. Hydration workflow

Follow Crabbox's [hydrate-workflow contract](https://github.com/openclaw/crabbox/blob/3d9260e7a37e025ed36b3c38fbcf1ae50e4a3520/docs/features/actions-hydration.md#authoring-a-hydrate-workflow).
The workflow has a `workflow_dispatch` trigger only and one job named `hydrate`.

1. Check the host: Ubuntu 24.04 or 26.04, `x86_64`, `sudo -n true`, `cpuset` in
   the cgroup v2 controllers, and at least 20 GB free under `/var/lib`. If any
   check fails, stop before changing the host.
2. Install any missing packages among `docker.io`, `docker-buildx`, `jq`,
   `curl`, and `git`. Add the user to the `docker` group. Persist
   `kernel.apparmor_restrict_unprivileged_userns=0` in
   `/etc/sysctl.d/60-oce-development.conf`. Print each change.
3. Run `actions/setup-node` with Node `24.16.0`, the `NODE_VERSION` in
   `.github/workflows/ci.yml`. pnpm comes from Corepack.
4. Run `setup-tools.sh crabbox`. Use `sg docker` because the group change does
   not reach the current session.
5. Write `$HOME/.oce-crabbox/env`, then Crabbox's env file and readiness marker.

### 4. `scripts/crabbox/oce-dev`

Every failure prints `oce-dev: <stage> failed: <reason>`. Re-run under
`sg docker` when the Docker socket is denied.

`up [--tailscale]`:

1. Source `env`. If `state/` exists, fail and print the teardown command.
2. With `--tailscale`, take `Self.DNSName` from `tailscale status --json` and
   remove the trailing dot. Require a `*.ts.net` name that also appears in
   `CertDomains`. Export the origin, add the Serve handler from the RFC, and
   record it in `serve`.
3. Run `corepack pnpm install --frozen-lockfile`, `corepack pnpm cli:build`, and
   `scripts/dev-up`. If any of them fails, remove the handler and exit with
   that status.
4. Run `bin/occ installation get` against `http://127.0.0.1:3000`. With
   `--tailscale`, retry `curl --fail https://<name>/console/` for up to two
   minutes; the first request provisions the certificate.

`down` attempts both of these steps, reports each result, and exits non-zero if
either failed:

- remove the recorded handler with `off`; and
- if `state/` exists, run `scripts/dev-down`, building `bin/occ` first if needed.

It exits `0` when there is nothing to remove.

### 5. Jobs

Verify the following with `crabbox job list` and `crabbox job run --dry-run`:

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

If Crabbox's parser rejects the YAML anchor, write the Tailscale job out in
full. The caller's configuration selects the provider. No job collects
artifacts, because the state directory holds credentials.

### 6. Documentation

- Add the setting to the settings reference and the cheat sheet.
- Add `docs/guides/deploy/crabbox-development.md` and register it in
  `docs.json`. The guide covers:
  - provider setup, including `CRABBOX_TAILSCALE=1` with a `tag:` value for
    managed leases or `static.host` for a static host;
  - the tailnet HTTPS and access policy;
  - reusing a lease (`oce-teardown --stop never`) and the four-hour limit; and
  - reading credentials through `crabbox ssh`.
- Link the guide from local Kubernetes development and from remote-console
  troubleshooting.
- Add `.crabbox.yaml` and `scripts/crabbox/` to the repository layout.
- Add `docs/flows/crabbox-development-deployment.md`.

## Verification

| Outcome                  | Check                                                                                                                                       | Result  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1. Startup               | `oce-deploy` on a fresh managed lease and on a static Ubuntu 24.04 host; record provider and class. A non-Ubuntu host is refused unchanged. | Not run |
| 2. Access                | Permitted device signs in and lists a resource; denied, off-tailnet, and unauthenticated requests fail.                                     | Not run |
| 3. Tailnet preconditions | An unreachable host is refused before sync; a tailnet without HTTPS fails before `dev-up`.                                                  | Not run |
| 4. Setting               | Unit tests from step 1. The real k3d lane signs in through `127.0.0.1:8443` with the configured `Origin` and refuses `.localhost`.          | Not run |
| 5. Teardown and reuse    | Redeploy on a used lease is refused. Teardown with `--stop never`, then redeploy. A failing `dev-down` still removes Serve.                 | Not run |
| 6. Credentials           | Job output and Crabbox logs contain no password or key material.                                                                            | Not run |

A fixture test with stub `tailscale` and `occ` commands covers `oce-dev`
ordering. Fixture results do not replace the remote checks.

## Delivery record

Not started.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-13: Authoring from RFC-0019 and its verification round, against Crabbox `66b66f8` and Enterprise `3d180654c`.
- 2026-10-13: Rewrite for decision/delivery separation; correct remote-access claims and make TLS, lease reuse, host readiness, cleanup, and remaining proof explicit against the same source baseline and published documentation.
- 2026-10-13: Resolve all open decisions against Enterprise `3d180654c` and Crabbox `3d9260e7`, and shorten both documents.
