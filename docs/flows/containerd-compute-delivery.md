---
created: 2026-10-09
updated: 2026-10-09
last_updated_session: nerdctl-rootless
---

# Rootless containerd compute delivery flow

## Overview

An Installation can place Agents on the operator's own rootless containerd engine instead of a
cluster. This flow starts when composition selects `compute-containerd`, follows a Namespace
reconciliation and an AgentRevision delivery through the Driver and its host helper into the
engine, and stops when the worker records the observation it was given — ready, pending, or a
failure it must not retry.

The Driver owns no engine of its own. It renders options, enforces ownership, and hands one JSON
envelope per operation to a host-side helper that talks to containerd; the engine enforces the
limits in that envelope. Nothing in this path needs Kubernetes, a scheduler, or cluster
credentials.

## Entry Points

- Trigger: a worker claiming a `namespace.ensure` or revision-delivery work item.
- Source: `apps/controller/src/composition/installation-config.ts:593`,
  `apps/controller/src/drivers/compute/containerd/index.ts:291` and `:411`.
- Assumptions: one server-owned Installation, the helper at its configured absolute path, the
  engine running as the operator's rootless containerd, and a runtime image already present in
  the configured containerd namespace.

## Namespace preparation

`ensureNamespace` (`index.ts:291`) creates two CNI networks inside the engine's namespace: an
**internal** plane with no connectivity at all and an **edge** plane. Both carry this Driver's
ownership labels, and a plane that already exists is adopted only when its labels match — a
mismatch fails the reconciliation instead of claiming it. A plane that fails halfway is rolled
back under the labels it was created with.

`deleteNamespace` (`index.ts:325`) removes containers, then volumes, then networks, selecting
them by label and verifying ownership before each removal, so a neighbouring Installation's
resources are never touched.

## Revision delivery

`prepareRevision` (`index.ts:411`) decides the tenant budget first
(`admitNamespaceBudget`, `index.ts:1728`): it sums the limits recorded on the Namespace's
containers and refuses a delivery that would exceed `resources.namespace.quota`. Nothing is
created before that decision.

It then ensures the Agent's networks and volumes, prepares storage
(`prepareWorkspaceStorage`, `index.ts:918`) — which hands the volumes to the workload user and
seeds a workspace when the platform sent a request — and starts the workload. An embedded
OpenClaw Agent runs one gateway container; a dedicated Codex harness runs a revision-scoped
harness container first (`reconcileAgent`, `index.ts:1071`) and the gateway then reaches it over
the transport endpoint and token, never over a model credential.

When that harness authenticates with the operator's staged Codex login, one more step precedes it:
`deliverOAuthLogin` (`index.ts:1161`) reads the staged login from the selected Secret Driver's
store, reserves it for this exact Agent and Codex home, and `seedCodexHome` (`index.ts:1199`) runs
a one-shot seeder that writes `auth.json` and the `.oce-oauth.json` receipt into the Agent's own
Codex volume (`oauth.ts`). Only then does the staged login become a consumed marker, so a failed
handoff leaves it spendable for a retry. The harness starts with `CODEX_LOGIN_MODE=oauth` and the
two receipt identities, and the gateway never mounts that volume.

The gateway (`reconcileGateway`, `index.ts:1628`) is Agent-scoped: it serves whichever revision is
active, so its ownership is proven at Agent scope while its labels record the revision that
created it. Readiness comes from a probe inside the container, and the published loopback port is
read back from the running container, which is what `getGatewayEndpoint` resolves.

## Helper protocol

Every operation travels as one JSON envelope through
`apps/controller/src/drivers/compute/containerd/executor.ts:45`, which spawns the helper, bounds it,
and settles once. `helpers/compute-containerd/main.go:26` dispatches on request, on the rootless
parent re-exec, on the OCI hook and on the log shim — the last two being modes nerdctl normally
serves itself, which is why the helper's path must stay stable. The helper reads back the labels
it stored, so ownership is enforced against the engine rather than against the Driver's memory.

## Credentials

`credentials.ts` holds the Agent's own gateway credential and, for a dedicated harness, the
transport token both roles present. A staged Codex OAuth login is different: it lives in the
selected Secret Driver's store until a revision consumes it, and the Compute Driver reads that
store under the trust boundary the flow describes above. The Driver creates one when it is missing, preserves the
value it finds, and removes it with the Agent. The platform admits a revision only when the
credential its mode needs is present, which is why the status reports the stored credential
rather than a running container.

## Failure modes

- A helper that is absent, or an engine that is not rootless, fails preflight and the worker
  records a startup failure rather than delivering.
- A missing runtime image in the configured namespace is reported as a preflight warning, not an
  error, so an operator sees it before a delivery fails.
- A workspace that was never seeded leaves the runtime unable to pass its own admission, so the
  readiness window expires and the revision is reported as not ready.
- A budget that leaves no room, a foreign resource, and an unreadable credential are all
  permanent failures: retrying cannot change them.

## Related

- [Rootless containerd Compute Driver](../reference/drivers/containerd-compute.md)
- [Compute Driver lifecycle hooks](compute-driver-lifecycle-hooks.md)
- [Local rootless containerd deployment](../guides/deploy/local-containerd-development.md)
