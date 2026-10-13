---
rfc: ../rfcs/0019-crabbox-oce-deployment.md
---

# Implementation plan: deploy OCE with Crabbox and publish the console on a tailnet

- **ID:** RFC-0019 (the primary plan for RFC-0019; it reuses the RFC's number and topic)
- **Delivery status:** Planned
- **Owner:** OpenClaw Enterprise deployment configuration and the local launcher (`internal/occdev`)
- **Authority:** [RFC-0019: Deploy OCE with Crabbox](../rfcs/0019-crabbox-oce-deployment.md)
- **Source baseline:** Enterprise `3d180654c`; [Crabbox](https://github.com/openclaw/crabbox) `66b66f8`, the revision every Crabbox contract below was checked against

## Outcome and scope

An operator with a leased or already-rented Linux host runs `crabbox job run
oce-deploy` from an OCE checkout; the job deploys OCE on that host, and a second
device on the tailnet opens the console. The job is unattended and re-runnable,
and Crabbox can attach the run's artifacts and test summary to it.

The deployment stays `scripts/dev-up` — the profile
[Local Setup](https://docs-enterprise.openclaw.org/guides/quickstart/)
([source](../../docs/guides/quickstart.md)) documents — and the only OCE change
is one optional launcher setting. [RFC-0019](../rfcs/0019-crabbox-oce-deployment.md)
owns the requirement, the access contract, and the non-goals; this plan adds
only what executing them needs.

## Contract and source touchpoints

- `.crabbox.yaml` (new, repository root). Crabbox reads either `crabbox.yaml` or
  `.crabbox.yaml`; a job is a repo-local validation flow, so the deploying
  command is also the deployment's check.
- `.github/workflows/crabbox-hydrate.yml` (new). Crabbox's local hydration path runs it
  over SSH, so it must declare the inputs Crabbox inspects
  and write the readiness marker Crabbox waits for.
- `internal/occdev/openshell_k3d.go` reads the profile's settings
  (`OCC_DEVELOPMENT_BROWSER_PORT` at `:88`, `OPENCLAW_DEV_PORT` at `:75`),
  builds the installation values (`auth.baseUrl` at `:700`, `agentNativeAdmin`
  at `:701-703`) and prints the console URL at `:388-390`;
  `internal/occdev/keycloak_k3d.go:864-868` validates the Console origin and
  `:434-437` derives the sign-in redirect host.
- `docs/reference/settings/development.md:32` and
  `docs/reference/cheatsheets/environment-variables.md:112` own the setting
  inventories, so the new variable is recorded there. The launcher change is a
  runtime change: follow `.agents/skills/local-dev`, including its flow-doc
  requirement.
- Unchanged: `scripts/dev-up`, `scripts/dev-down`, and
  `scripts/ci/setup-tools.sh`.

## Implementation

1. **Add `OCC_DEVELOPMENT_BROWSER_ORIGIN` to the launcher.** Read it beside the
   existing settings; when set, it becomes `auth.baseUrl`, the Console origin the
   launcher checks and the sign-in redirect host it derives today from
   `console.<cluster>.oce.localhost`, disables `agentNativeAdmin`, and is printed
   as `<origin>/console/`. It must name a port (`newDevelopmentConsole` refuses
   one without), so the documented value is
   `https://<machine>.<tailnet>.ts.net:443`; unset, nothing changes.
2. **Add `.crabbox.yaml`**: one profile per reachability mode, one teardown preset
   per profile, two deploy jobs. `stop: never` keeps the lease; `--dry-run` prints
   the expansion without leasing.

   ```yaml
   profiles:
     oce:
       presets:
         oce-teardown:
           command: scripts/dev-down
     oce-tailscale:
       presets:
         oce-teardown:
           shell: true
           command: scripts/dev-down && sudo tailscale serve reset
   jobs:
     oce-deploy: &oce-deploy
       target: linux
       profile: oce
       hydrate:
         actions: true
       actions:
         workflow: .github/workflows/crabbox-hydrate.yml
         job: hydrate
       shell: true
       command: corepack pnpm install --frozen-lockfile && corepack pnpm cli:build && scripts/dev-up
       stop: never
     oce-deploy-tailscale:
       <<: *oce-deploy
       profile: oce-tailscale
       network: tailscale
       command: >
         corepack pnpm install --frozen-lockfile && corepack pnpm cli:build &&
         sudo tailscale serve --bg --https=443 https+insecure://127.0.0.1:8443 &&
         OCC_DEVELOPMENT_BROWSER_ORIGIN="https://$(tailscale status --json |
         yq -p json '.Self.DNSName | sub("\\.$"; "")'):443" scripts/dev-up
   ```

   The deploy writes no JUnit XML today and the state directory holds
   credentials, so neither job declares `junit:`, `artifactGlobs:` or
   `requiredArtifacts:` yet. Add them for any non-secret output a later check
   produces, and keep the state directory out of the artifact globs.

3. **Add `crabbox-hydrate.yml`.** `on: workflow_dispatch` only, declaring
   `crabbox_id`, `crabbox_runner_label` and `crabbox_keep_alive_minutes` (plus
   `crabbox_job`, defaulting to `hydrate`). Steps, in order:

   - install Docker as root (`sudo`) only when the image lacks it
     (`command -v docker`), through `apt-get install docker.io` on the
     Debian-family images the managed leases use, with the lease user added to
     `docker`;
   - `actions/setup-node` with `24.16.0`, the version pinned in `ci.yml`;
   - install the `go.mod` Go (1.27) in a `run:` step: on Crabbox's local
     hydration path `actions/setup-go` only verifies an installed Go;
   - `scripts/ci/setup-tools.sh k3d` for kubectl, k3d, Helm and yq;
   - write Crabbox's readiness marker `$HOME/.crabbox/actions/<lease>.env`, which
     points `ENV_FILE` at a sourced env file that carries
     `OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes`,
     `OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes`,
     `OCC_DEVELOPMENT_SANDBOX_DRIVER=none`,
     `OCC_DEVELOPMENT_STATE_DIRECTORY=/var/tmp/oce-dev` (durable, unlike the
     temporary default), `OPENCLAW_DEV_PORT=3000`,
     `OCC_URL=http://127.0.0.1:3000`,
     `OCC_SERVICE_KEY_FILE=/var/tmp/oce-dev/initial-admin-service-key.json`, and
     `export PATH="$RUNNER_TEMP/bin:$PATH"`. That `PATH` export is what carries
     kubectl, k3d, Helm and yq to the deploy command: Crabbox persists only the
     Node and pnpm tool-cache paths itself.
   - keep the job alive for GitHub-runner hydration, and exit immediately on
     the local path.

4. **Record the setting** in `docs/reference/settings/development.md` and in the
   [environment-variable cheat sheet](../../docs/reference/cheatsheets/environment-variables.md),
   and update the flow page that owns the local launcher's behavior, as
   `.agents/skills/local-dev` requires.

## Verification

| Required outcome                                                                                                                            | Real check and prerequisites                                                                                                                                                                                       | Result or remaining proof |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| The deploy job completes the profile on a fresh Linux lease                                                                                 | `crabbox job run oce-deploy` on a bare VM with the prerequisites [Local Setup](https://docs-enterprise.openclaw.org/guides/quickstart/) lists (about 20 GB of engine storage; free 3000, 8443, 6443)               | Not run                   |
| A second tailnet device opens the console and signs in                                                                                      | `crabbox job run oce-deploy-tailscale`, then `https://<machine>.<tailnet>.ts.net/console/` from another device; the tailnet needs HTTPS certificates for `serve --https=443`                                       | Not run                   |
| A device outside the tailnet cannot reach the console                                                                                       | The same run, then a device without tailnet access                                                                                                                                                                 | Not run                   |
| The job refuses a machine Crabbox cannot reach over the tailnet                                                                             | `network: tailscale` with an unreachable lease                                                                                                                                                                     | Not run                   |
| The launcher's own API check answers on the lease                                                                                           | `OCC_URL=… OCC_SERVICE_KEY_FILE=… ./bin/occ installation get`, the check [Local Setup](../../docs/guides/quickstart.md#read-the-installation-with-the-bootstrap-service-key) documents and `scripts/dev-up` prints | Not run                   |
| Teardown removes the deployment and resets Tailscale Serve                                                                                  | The profile's `oce-teardown` preset, then `crabbox stop`                                                                                                                                                           | Not run                   |
| The setting changes `auth.baseUrl`, the Console origin, the redirect host and the printed URL, and leaves the launcher unchanged when unset | Extend the launcher tests in `internal/occdev` (`internal/occdev/keycloak_k3d_test.go` asserts the installation values today) and the real-cluster lane (`tests/integration/dev-up-openshell-k3d-real.test.mjs`)   | Not run                   |

## Open decisions

- **Milestone scope.** `AGENTS.md` keeps deployment behavior outside the approved
  milestones, so a maintainer decides whether this delivery enters them; it
  gates everything below.
- **The origin shape.** The launcher accepts an `https` Console origin only when
  it names a port. The launcher owner decides whether the job keeps passing
  `:443` or the launcher admits a tailnet name without one.
- **Whether the workflow installs Docker or asserts it.** Resolve against the
  lease image in use; Crabbox's own Linux builder image already installs Docker
  and adds the lease user to the group. A host outside the Debian family needs
  its own setup.
- **Whether `serve --https=443` can obtain a certificate in the target
  tailnet.** The tailnet operator confirms HTTPS certificates are enabled;
  without them Serve has no certificate to terminate with.
- **A static host's permissions.** On the `ssh` provider, the tailnet operator
  must already have joined the host, and the lease user needs working `sudo` for
  `tailscale serve`.

## Delivery record

Not started. Record the implementation PR, the checks above with their results
and limits, and the updated documentation links here as the work proceeds.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-13: Authoring from RFC-0019 and its verification round, against Crabbox `66b66f8` and Enterprise `3d180654c`.
