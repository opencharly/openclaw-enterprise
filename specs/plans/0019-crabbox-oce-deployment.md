---
rfc: ../rfcs/0019-crabbox-oce-deployment.md
---

# Implementation plan: Deploy OCE development environments with Crabbox

- **ID:** RFC-0019 (primary plan)
- **Delivery status:** Planned
- **Owner:** OCE deployment and development-launcher contributors
- **Authority:** [RFC-0019](../rfcs/0019-crabbox-oce-deployment.md)
- **Source baseline:** Enterprise `3d180654c`; Crabbox `3d9260e7`; Tailscale `v1.104.1`

## Outcome and scope

Deliver the RFC's [goals](../rfcs/0019-crabbox-oce-deployment.md#goals) through
its selected local profile and unchanged OCE authentication. Implementation
starts after responsible maintainers accept the RFC and its deployment scope.

## Contract and source touchpoints

`scripts/crabbox/oce-dev` owns `$HOME/.oce-crabbox/` (mode `0700`): launcher
`state/`, non-secret toolchain `env`, publication recovery record `serve`, and
an operation lock. Hydration creates the parent, not the launcher's state directory.

The script sources tool paths and sets this environment itself for startup,
checks, and teardown. Reject conflicting inherited profile/port/state settings;
the base job must not inherit a browser-origin override.

```text
OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
OCC_DEVELOPMENT_SANDBOX_DRIVER=none
OCC_DEVELOPMENT_CONTAINER_ENGINE=docker
OCC_DEVELOPMENT_STATE_DIRECTORY=$HOME/.oce-crabbox/state
OPENCLAW_DEV_PORT=3000
OCC_DEVELOPMENT_BROWSER_PORT=8443
OCC_DEVELOPMENT_KUBERNETES_API_PORT=6443
OCC_URL=http://127.0.0.1:3000
OCC_SERVICE_KEY_FILE=$HOME/.oce-crabbox/state/initial-admin-service-key.json
```

Expand `$HOME` when exporting; keep `OCC_DEVELOPMENT_SIGN_IN` empty. Only the
Tailscale job sets the derived browser origin. Pass the service-key file path,
never its contents, to checks. Teardown does not require hydration.

## Implementation

### 1. Launcher setting

Implement the [origin contract](../rfcs/0019-crabbox-oce-deployment.md#console-origin-and-authentication)
through `internal/occdev`, `internal/occcli/dev.go`, and `scripts/dev-up`.
Validate at the shared Go startup boundary before profile dispatch; also guard
the shell startup entry point so Docker/Compose cannot silently ignore the setting.
Direct `occdev.Up` calls must enforce the same contract.

Require HTTPS, a valid nonempty host, and an absent or valid port. Reject
whitespace/control characters, malformed URLs, user info, query, fragment,
non-root paths, and unsupported profiles/sign-in. Normalize the root slash and
default port before writing `auth.baseUrl` in `openshell_k3d.go`; omit native
admin and update the printed URL. Keep the unset path unchanged. Do not change
proxy trust or authentication rules.

Cover validation before effects, unsupported entry paths, normalized Helm values,
native admin, and printed output with meaningful launcher checks.

### 2. Toolchain profile

Add `crabbox` to [`setup-tools.sh`](../../scripts/ci/setup-tools.sh):
`require_docker`, kubectl, k3d, Helm, yq, and explicit Go installation. Local
`actions/setup-go` only checks an installed Go. Pin an exact supported Go 1.27
patch and linux-amd64 SHA-256 through `download-pinned.sh`; persist its bin path.

### 3. Hydration workflow

Create `.github/workflows/crabbox-hydrate.yml` using the pinned Crabbox
[workflow contract](https://github.com/openclaw/crabbox/blob/3d9260e7a37e025ed36b3c38fbcf1ae50e4a3520/docs/features/actions-hydration.md#authoring-a-hydrate-workflow)
and `workflow_dispatch` only. Declare required inputs and marker fields from
that contract; local hydration exits immediately after readiness.

1. Before OCE package/sysctl changes, verify Ubuntu 24.04/26.04, amd64,
   noninteractive sudo, cgroup-v2 `cpuset`, and required storage. Check the actual
   Docker data filesystem when already installed, otherwise `/var/lib`. Refuse
   unsupported hosts; Crabbox bootstrap/sync has already occurred.
2. Install missing `docker.io`, `docker-buildx`, `jq`, `curl`, and `git`;
   enable working Docker daemon access and add the user to `docker`. Persist
   the documented Codex sysctl at `/etc/sysctl.d/60-oce-development.conf`.
   Print changes; teardown leaves host preparation in place.
3. Use `actions/setup-node` with the CI-pinned `NODE_VERSION`, declared in this
   workflow too. Verify Corepack and the repository-pinned pnpm are usable.
4. Run `setup-tools.sh crabbox` under `sg docker` for new group membership.
5. Write the private parent and non-secret toolchain `env`, then Crabbox's
   environment and readiness marker only after setup succeeds.

### 4. Deployment script

Every failure names its stage and reason. Serialize `up`/`down`; retry a Docker
permission failure under `sg docker` at most once. Unsupported Serve versions
or status formats fail before mutation. Qualify the selected TCP mode against
Tailscale `v1.104.1`; later versions require equivalent behavior checks.

`up [--tailscale]`:

1. Source tool paths, validate the fixed environment, and refuse existing
   launcher state or an unresolved publication record with a recovery command.
   Require free loopback ports 3000, 8443, and 6443 before adding a publication.
2. With Tailscale, trim `Self.DNSName` and require the resulting `*.ts.net` name
   in `CertDomains`. Check `tailscale serve status --json` for TCP/HTTP/Funnel
   conflicts on 443. Refuse existing configuration rather than adopt or overwrite it.
3. Write a mode-`0600`, atomic intent record with the exact host, port, TCP target,
   and shutdown flags before configuring the RFC's
   [TCP publication](../rfcs/0019-crabbox-oce-deployment.md#tailnet-publication).
   Install cleanup handling first. Read back status after configuration; resolve
   an uncertain outcome from live configuration, not a repeated mutation.
4. Install locked dependencies, build the CLI, and call `scripts/dev-up`.
5. Using the explicit URL/key environment, require `bin/occ installation get`
   and a ready initial Namespace. With Tailscale, retry certificate-validated
   `curl --fail https://<name>/console/` for two minutes. This checks publication,
   not authentication; remote authenticated API proof remains in verification.

Every failure after publication intent, including checks, INT/TERM, and failed
record updates, attempts bounded cleanup of only the matching owned publication.
Keep the original failure status and report cleanup separately. If startup left
an installation, report its state and `down` command; do not silently delete it
when a post-start check fails. Uncatchable interruption leaves the durable intent
for reconciliation on the next operation. Erase the record only after verified
removal or confirmed absence.

`down` attempts publication and installation cleanup independently. Compare live
port-443 configuration with the record before invoking:

```sh
sudo tailscale serve --bg --tls-terminated-tcp=443 tcp://127.0.0.1:3000 off
```

Do not remove an operator replacement or unrelated handler; report drift as a
cleanup failure. Configuration edits by other tools during OCE operations are
unsupported. If launcher state exists, run `scripts/dev-down`, building the CLI
if necessary. Preserve failed-cleanup state/records. Exit nonzero on either
failure, and zero only when both owned resources are absent.

### 5. Jobs

The caller selects the provider. Validate the jobs with `job list` and dry-run;
the merge key is supported by Crabbox's YAML parser.

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

Require `crabbox job run --id <lease> oce-teardown`; no ID would allocate a new
lease. For reuse, run `crabbox job run --id <lease> --stop never oce-teardown`,
then the deploy job with the same ID. Record effective lifetime/policy clamping;
static hosts provide persistent use. Declare no credential-bearing artifacts.

### 6. Documentation

Update the development setting reference and environment-variable cheat sheet.
Add `docs/guides/deploy/crabbox-development.md`, register it in `docs.json`, and
link it from local development and remote-console troubleshooting. Document
current supported hosts/profile, certificate preparation, unchanged local login,
private credential retrieval through SSH, lease identity/lifetime, recovery,
and destructive teardown. Keep those current procedures in the guide.

Update `docs/layout.md` for `.crabbox.yaml` and `scripts/crabbox/`, and the owning
launcher flow under `docs/flows/` as [local-dev](../../.agents/skills/local-dev/SKILL.md)
requires. Update RFC implementation status and index together only with evidence.

## Verification

All checks are planned, not run. Exercise the implemented revision and record
commands, host/image/provider, Tailscale version, results, and missing prerequisites.

| RFC goal | Required implementation proof                                                                                                                                                                                                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Fresh managed and static hosts covering Ubuntu 24.04 and 26.04 amd64: launcher readiness, authenticated Installation read, ready Namespace. Refuse wrong OS/architecture, missing sudo/cpuset/storage, occupied ports, and conflicting environment before OCE setup/publication.                                                                           |
| 2        | A permitted second device loads login unauthenticated, signs in with ordinary OCE credentials, lists a protected resource, and logs out. Compare missing-session and missing-permission behavior with local setup. Denied/off-tailnet devices cannot connect. Confirm injected forwarded headers remain rejected and normal TCP-forwarded requests work.   |
| 3        | Refuse unreachable tailnet SSH and missing certificate eligibility. Fail certificate issuance/HTTPS checks and verify publication cleanup and reported installation state.                                                                                                                                                                                 |
| 4        | Shared-entry validation and unset regressions; real k3d sign-in and protected API operations with the configured Origin. For local HTTPS proof, retain the development certificate's hostname/SNI while dialing loopback. Verify TLS-terminated TCP behavior against the selected Tailscale version.                                                       |
| 5        | Reuse with explicit lease ID; retain/redeploy using `--stop never`. Check conflicting/replaced Serve configuration, uncertain mutation, INT/TERM, interruption recovery, failed post-start checks, and independent removal failures. Preserve unrelated settings, records, and lease on cleanup failure; verify successful cleanup and release separately. |
| 6        | Inspect job/Crabbox logs and artifact configuration for password, service-key, and CA-private-key values; keep state out of artifacts.                                                                                                                                                                                                                     |

Stub script checks may cover ordering and failure paths; they do not replace
real k3d, host, browser, and tailnet proof. Required unrun checks keep delivery
incomplete. Use documentation checks, without product tests, for this proposal.

## Delivery record

Not started.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-13: Authored against Enterprise `3d180654c` and Crabbox `3d9260e7`.
- 2026-10-13: Align all RFC goals with concrete steps/checks; preserve local authentication, select header-free TCP publication, and specify credential inputs, validation, ownership, and failure recovery (Tailscale `v1.104.1`).
