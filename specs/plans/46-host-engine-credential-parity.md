---
rfc: ../rfcs/0016-sandbox-credential-injection.md
---

# Implementation plan: host-engine credential parity

- **ID:** TASK-0046
- **Delivery status:** Planned
- **Owner:** Driver contracts, Agent deployment, and the rootless container-engine integration.
- **Authority:** [RFC 0016](../rfcs/0016-sandbox-credential-injection.md) establishes the
  mechanism-agnostic `credential_gateway` capability this plan implements for a second engine;
  [RFC 0017](../rfcs/0017-agent-egress-0x/index.md) owns the Agent egress boundary the injection
  point stands on.
- **Source baseline:** inspected at `90ae9f8b7`.

## Outcome and scope

An Agent on a rootless container engine receives the three credential capabilities that today
only a Kubernetes Installation provides, without any of them reaching a workload that must not
hold it: bound OCC Secrets, a projected workload identity, and a Backend-issued account credential.

**This plan was revised after its first draft, because the first draft named the wrong blocker.**
All three capabilities reach the workload through a **Credential Gateway Driver**, and the platform
admits a credential gateway only with a **paired Sandbox Driver** — enforced independently in the
worker and in the Kubernetes driver:

- `apps/controller/src/worker.ts:893` — "The selected Credential Gateway Driver requires a paired
  Sandbox Driver."
- `apps/controller/src/drivers/compute/kubernetes/index.ts:2745` — the same rule at selection.
- The gateway's substitution point is the sandbox supervisor: the workload holds only a placeholder
  and the supervisor substitutes the real value on matching requests, as
  [the OpenShell gateway](../../docs/reference/drivers/openshell-credential-gateway.md) does.

So these three rows are not three independent gaps. They are consequences of the one deviation this
column already records — no Sandbox Driver for this engine — and the capability matrix now says so
in each cell. Closing them means one of two things, and the first is a decision rather than work:

1. **Implement a Sandbox Driver for the rootless engine** (with a supervisor that substitutes
   credentials on outbound requests, for which the Agent's egress proxy is the natural place).
   That is a feature far larger than this plan, and one the objective recorded as its documented
   deviation.
2. **Change the pairing rule** so a host engine can pair a credential gateway with the Compute
   Driver's own egress proxy instead. That is a platform design change and needs its own RFC.

Non-goals: kernel-enforced tenant quota, and any change that lets a Compute Driver hold an OCC
Secret value outside a credential gateway.

## Contract and source touchpoints

- **The capability exists already.** `ComputeDriver` exposes `credentialSources` on a revision
  context (`packages/contracts/src/index.ts:442`) and a `credential_source` harness binding, and
  RFC 0016 defines the `credential_gateway` Driver that manages sources and their attachment
  without naming a mechanism. What is missing is an implementation for an engine that is neither
  Kubernetes nor OpenShell.
- **The Kubernetes reference** reads Agent-owned Secrets and projects them
  (`kubernetes/index.ts:11673`), mints transport and gateway credentials into owned Secrets
  (`:3225-3255`), and enforces tenant budgets with `ResourceQuota` and `LimitRange` (`:4025`).
- **What the rootless Driver already owns** is the substrate this plan builds on: Agent-owned
  credential files with provisioning, preservation and deletion
  (`apps/controller/src/drivers/compute/containerd/credentials.ts`), an egress proxy standing on the
  Agent's no-egress plane and on the plane that reaches outside with an Installation allowlist
  (`nerdctl/spec.ts`, `index.ts:ensureEgressProxy`), and a relay that publishes the gateway's port
  across those planes (`index.ts:reconcileRelay`).
- **The workload boundary** is `reconcileAgent`/`reconcileGateway`, which already route the
  workload environment to the harness alone and give the gateway only the transport endpoint and
  token (`index.ts`).
- Affected documentation: the
  [containerd Compute reference](../../docs/reference/drivers/containerd-compute.md), the
  [delivery flow](../../docs/flows/containerd-compute-delivery.md), and the capability matrix.

## Implementation

The steps below are what a sandbox-enabled host engine would then do. None of them starts before
the decision above is taken.

1. **Name the seam, then implement the smallest one first.** Add a platform-side projection for
   Agent-owned credential material that a Compute Driver can _hold_: a bounded, audience-scoped
   identity written into the Agent's credential directory, with minting and revocation owned by
   the platform. The Driver mounts it read-only into the workload and never reads it. This closes
   `workload-identity` and changes no existing boundary.
2. **Give the egress proxy the broker role.** A `credential_gateway` implementation for the host
   engine holds bound sources inside the Agent's own planes and injects scoped substitutes into
   outbound requests, with the Installation's allowlist as the control point. The workload
   receives a substitute, never a value, which is the state RFC 0016 calls the target rather than
   the Kubernetes exception.
3. **Route the account credential through the same broker**, bound to the exact harness container,
   which is already the only one that receives the workload environment.
4. **Extend the Driver and its Installation schema** for the two new sections the seams need, and
   refuse a Configuration that asks for a capability the selected engine cannot serve.
5. **Update the reference, flow, and matrix** in the same change, and let the CI parity gate turn
   the three rows green as they land.

## Verification

| Required outcome                                                                                     | Real check and prerequisites                                                                                      | Result or remaining proof |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------- |
| A bound source reaches the workload as a substitute, and the value never enters the container        | Conformance on the rendered request, then the opt-in real-runtime test with a broker container on the live engine | Not run                   |
| A projected identity file is bounded, audience-scoped, mounted read-only, and revoked with the Agent | Conformance on the projection decision, then a live engine probe reading the file from inside the workload        | Not run                   |
| The account credential reaches the harness container alone                                           | Extend the dedicated-harness conformance case and the worker workflow test                                        | Not run                   |
| A Configuration that the engine cannot serve fails closed                                            | Conformance on configuration validation                                                                           | Not run                   |
| Parity gate turns the three rows green                                                               | `pnpm parity:compute --check`, already wired into CI                                                              | Not run                   |

## Open decisions

- **Does this engine get a Sandbox Driver, or does the pairing rule change?** The first is a
  product decision larger than this plan; the second is an RFC. Nothing below starts until it is
  answered, and the capability matrix shows the three affected rows as deviations of `sandbox`
  until then.
- If a Sandbox Driver is built: **who mints the workload identity, and with what key material?**
  The IAM owner decides whether the platform issues an opaque token or reuses a signed artefact.
- If a Sandbox Driver is built: **may the driver receive resolved values?** The credential-gateway
  contract already says registration sends them (`CredentialSourceInput.secrets`), so this is a
  confirmation rather than a new choice.
- **The broker's provenance:** an operator-supplied image, as the egress proxy is, or a bundled one.

## Delivery record

Nothing implemented, and deliberately so: the revision on 2026-10-09 established that the three
affected rows depend on a Sandbox Driver rather than on Driver work, and the matrix now records
that dependency in each of their cells.

## Manual Notes

## Changelog

- 2026-10-09: Authored from the capability gap the rootless nerdctl work measured, at `90ae9f8b7`.
  TASK-0045 is held for the rootless nerdctl deployment plan under author review, so this plan
  takes the next free ID.
- 2026-10-09: Revised after review: the first draft named a missing identity-minting decision as the
  blocker. The platform requires a paired Sandbox Driver for any credential gateway
  (`worker.ts:893`), so the blocker is the `sandbox` deviation this column already records.
