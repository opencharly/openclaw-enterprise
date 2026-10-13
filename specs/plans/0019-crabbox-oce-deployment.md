---
rfc: ../rfcs/0019-crabbox-oce-deployment.md
---

# Implementation plan: Deploy OCE development environments with Crabbox

- **ID:** RFC-0019 (primary plan; reuses the RFC's number and topic)
- **Delivery status:** Planned
- **Owner:** OCE deployment and development-launcher contributors
- **Authority:** [RFC-0019](../rfcs/0019-crabbox-oce-deployment.md)
- **Source baseline:** Enterprise `3d180654c`; Crabbox `66b66f8`

## Outcome and scope

Deliver the [RFC's required outcomes](../rfcs/0019-crabbox-oce-deployment.md#delivery-and-verification)
through two repository-defined jobs: `oce-deploy` for remote development startup
and `oce-deploy-tailscale` for private console publication. The caller runs them
from the OCE checkout on a fresh eligible Linux host or an explicitly reused lease.

No implementation or runtime verification has started. The RFC owns the rationale, access
boundaries, and non-goals. Its maintainer scope decision remains unresolved.

## Contract and source touchpoints

| Owner                       | Files and responsibility                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment contributors     | New `.crabbox.yaml` and `.github/workflows/crabbox-hydrate.yml`: job expansion, prerequisites, environment, retention, and teardown.                                                                                                                                                                                                                                                |
| Launcher contributors       | `internal/occdev/openshell_k3d.go`: settings, installation values, startup, and printed URLs; `internal/occdev/keycloak_k3d.go`: console HTTPS checks and sign-in redirects. Inspect routing and browser helpers alongside these files.                                                                                                                                             |
| Documentation contributors  | [Development settings](../../docs/reference/settings/development.md), [environment-variable inventory](../../docs/reference/cheatsheets/environment-variables.md), and the current [local profile guide](../../docs/guides/deploy/local-kubernetes-development.md). Update the owning launcher flow under `docs/flows/` using [local-dev](../../.agents/skills/local-dev/SKILL.md). |
| Caller and tailnet operator | Select the host, configure Crabbox access and lease lifetime, enable tailnet HTTPS, grant client access, and perform cleanup.                                                                                                                                                                                                                                                       |

Reuse `scripts/dev-up`, `scripts/dev-down`, and `scripts/ci/setup-tools.sh`.
The workflow prepares prerequisites; it does not replace the launcher or bypass
its startup checks. Crabbox contracts below refer to the inspected revision, not
a promise about every provider or future release.

## Implementation

### 1. Establish host and launcher prerequisites

Confirm the maintainer scope decision before implementing new deployment behavior.
Select and document the initial Linux image. Verify the
[Local Setup requirements](../../docs/guides/quickstart.md#before-you-start): storage,
free ports, container-engine access, and a kernel that permits the required sandbox.
Use the existing [troubleshooting procedures](../../docs/guides/operate/troubleshooting.md)
for cgroup, DNS, and sandbox failures; report unsupported hosts instead of silently
changing host security settings or skipping startup checks.

Implement `OCC_DEVELOPMENT_BROWSER_ORIGIN` beside the existing launcher settings.
Reject invalid HTTPS origins, missing hosts or ports, and path/query/fragment
components before deployment effects. Derive the installation base URL, console
request origin, applicable redirects, and printed URL from that single value;
disable native admin publication when it is set. Keep unset behavior unchanged.

Resolve TLS and ingress integration before declaring this step complete.
`newDevelopmentConsole` currently pins the development CA and uses the origin's
host as its TLS server name while dialing loopback. A tailnet hostname with that
CA is insufficient. Verify the chosen request path, certificate trust, Host/SNI
handling, and redirect origin together. Keep any Serve upstream certificate
exception confined to the proposed loopback hop. Verify the default password
sign-in flow; explicitly reject any unsupported sign-in/profile combination and
record that limit rather than implying all modes work.

### 2. Add prerequisite hydration

Create `.github/workflows/crabbox-hydrate.yml` with `workflow_dispatch` inputs
`crabbox_id`, `crabbox_runner_label`, `crabbox_keep_alive_minutes`, and
`crabbox_job` (default `hydrate`). Use only syntax supported by Crabbox's
[local hydration translator](https://github.com/openclaw/crabbox/blob/66b66f8/docs/features/actions-hydration.md).

Perform setup in this order:

1. Install or verify Docker and working daemon access for the lease user.
   For a selected Debian-family image lacking Docker, use its package manager
   with `sudo`; verify access in the later SSH session after group changes.
   A Docker binary alone is not readiness evidence.
2. Prepare Node.js using the version selected by `.github/workflows/ci.yml`,
   Go from `go.mod`, and pnpm from `package.json`. The current baseline selects
   Node `24.16.0` and Go `1.27`. Local `actions/setup-go` verifies an installed Go,
   so install it explicitly when needed.
3. Run `scripts/ci/setup-tools.sh k3d` for kubectl, k3d, Helm, and yq.
4. Write a non-secret environment file and the readiness marker at
   `$HOME/.crabbox/actions/<lease>.env`, with the workspace identity and marker
   fields Crabbox requires. Publish readiness only after setup succeeds.
5. On the GitHub-runner path, honor the stop marker and keep-alive input.
   On the default local path, a zero keep-alive value exits immediately.

The sourced environment must carry:

```text
OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
OCC_DEVELOPMENT_SANDBOX_DRIVER=none
OCC_DEVELOPMENT_STATE_DIRECTORY=/var/tmp/oce-dev
OPENCLAW_DEV_PORT=3000
OCC_URL=http://127.0.0.1:3000
OCC_SERVICE_KEY_FILE=/var/tmp/oce-dev/initial-admin-service-key.json
```

Persist the setup tool directory in `PATH` as well: Crabbox retains Node/pnpm
cache paths but does not automatically retain all repository-installed tool paths.
Keep state-directory permissions restricted. These fixed paths support one owned
installation per host; concurrent starts must not share them.

### 3. Define deployment jobs and cleanup profiles

Create `.crabbox.yaml` with these [job contracts](https://github.com/openclaw/crabbox/blob/66b66f8/docs/features/jobs.md):

| Job                    | Profile         | Network                      | Remote work                                                                |
| ---------------------- | --------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `oce-deploy`           | `oce`           | Crabbox's configured default | Hydrate, install locked dependencies, build the CLI, run `scripts/dev-up`. |
| `oce-deploy-tailscale` | `oce-tailscale` | `tailscale`                  | The same work, plus a validated tailnet origin and Serve publication.      |

Both jobs select `target: linux`, `hydrate.actions: true`, the hydration workflow
and `hydrate` job, `shell: true`, and `stop: never`. Verify expansion with
`crabbox job run --dry-run <job>`. Document provider selection and host prerequisites, including noninteractive
`sudo`, alongside invocation.

The base command stages are `corepack pnpm install --frozen-lockfile`,
`corepack pnpm cli:build`, and `scripts/dev-up`, stopping at any failure.
For the Tailscale job, derive the machine's DNS name from `tailscale status --json`,
remove its trailing dot, validate it, and pass `https://<name>:443` as the browser
origin. Configure Serve with:

```sh
sudo tailscale serve --bg --https=443 https+insecure://127.0.0.1:8443
```

Order Serve setup and startup around the selected launcher TLS-check path.
Fail clearly when tailnet HTTPS, host permissions, origin validation, or startup
fails; do not report a ready console merely because Serve accepted configuration.

Each profile provides an `oce-teardown` preset using the same state settings.
The Tailscale preset must remove its publication even when `scripts/dev-down`
fails and report both results. A shell chain using only `&&` would skip that
removal. `tailscale serve reset` is acceptable only for an explicitly dedicated
host; otherwise remove only the owned configuration. Release remains a separate
caller action with `crabbox stop <lease>`.

Verify reuse with `crabbox job run --id <lease> <job>`. Document whether an existing
installation must be stopped first. Set a suitable lease lifetime explicitly;
`stop: never` does not disable provider expiration. Retained failed leases can
continue to incur costs until release or expiry.

Do not declare `junit`, `artifactGlobs`, or `requiredArtifacts` for this first
startup flow: it currently produces no JUnit report, and the state directory
contains credentials. Add artifact collection only for separately reviewed,
non-secret outputs. Startup is not a model-turn test.

### 4. Document and qualify the connected flow

Record the setting in its reference and cheat sheet. Update the launcher flow
and add the remote development procedure to the owning guide, including fresh
and reused leases, supported hosts/sign-in modes, credential access, failures,
and destructive teardown. Keep the existing SSH-tunnel procedure available for
the base job; preserve the printed development hostname and CA rather than
substituting `https://127.0.0.1` as the browser URL.

Run the checks below on the implemented revision and record commands, environments,
results, and limits. Update RFC implementation status and its index row together
only when delivery evidence supports the change.

## Verification

All implementation checks remain **Not run**.

| Required outcome                            | Verification path and prerequisites                                                                                                                                                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh remote startup and API access         | Run each job on a disposable, eligible bare Linux VM. Require launcher readiness, authenticated `./bin/occ installation get`, and a ready initial Namespace using the sourced environment.                                                                             |
| Safe reuse and failure recovery             | Rerun with explicit `--id` after success and after a failed start. Verify retained identity, state handling, documented teardown requirements, and useful failure output.                                                                                              |
| Correct origin and unchanged local behavior | Extend meaningful launcher coverage in `internal/occdev` and the real-cluster lane in `tests/integration/dev-up-openshell-k3d-real.test.mjs`. Check validation before effects, TLS/Host handling, redirects, cookies, native admin disablement, and the unset setting. |
| Allowed console access                      | From a second permitted tailnet device, open the printed HTTPS URL, sign in, and perform an authorized console operation. Tailnet HTTPS and OCE credentials are prerequisites.                                                                                         |
| Denied access                               | Use a denied tailnet client and a client outside the tailnet; neither may reach the Serve publication. Confirm an unauthenticated client receives no protected OCE access.                                                                                             |
| Tailnet reachability failure                | Select an unreachable host with `network: tailscale`; verify refusal before the remote deployment command.                                                                                                                                                             |
| Cleanup after success and failure           | Run the teardown preset and inspect the owned cluster, state, and Serve configuration. Inject a teardown failure and confirm publication cleanup still runs and the error is reported; then explicitly release the lease.                                              |
| Protected credentials and useful evidence   | Inspect logs and configured artifact collection for password, key, CA-private-key, and state-directory exposure. Record startup proof separately from Agent/model or production qualification.                                                                         |

Source inspection and fixtures cannot replace the remote VM, browser, and cleanup
checks. Missing prerequisites keep their outcomes incomplete. Document authoring
uses [documentation checks](../../docs/contributing/documentation.md#preview-and-check),
without running product tests.

## Open decisions

| Decision                                                     | Deciding owner and affected work                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Admit remote development behavior to the approved milestones | Responsible maintainers; blocks new deployment implementation, not this proposal rewrite.                            |
| Select the external-origin TLS/ingress/sign-in path          | Launcher contributors; blocks completion of steps 1 and 3. Retain loopback listeners and authenticated OCE access.   |
| Select the initial host image and safe Serve ownership       | Deployment contributors and tailnet operator; blocks host qualification and destructive Serve reset on shared hosts. |

## Delivery record

Not started. Record the implementation PR or commit, verification results and
unavailable prerequisites, remaining work, and updated guide/reference/flow links
here. RFC acceptance alone is not delivery evidence.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-13: Authoring from RFC-0019 and its verification round, against Crabbox `66b66f8` and Enterprise `3d180654c`.
- 2026-10-13: Rewrite for decision/delivery separation; correct remote-access claims and make TLS, lease reuse, host readiness, cleanup, and remaining proof explicit against the same source baseline and published documentation.
