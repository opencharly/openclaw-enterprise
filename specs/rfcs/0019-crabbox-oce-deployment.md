---
status: Proposed
implementation_status: Not implemented
author: aitrawog
---

# Proposal: Deploy OCE with Crabbox

- **ID:** RFC-0019
- **Created:** 2026-10-12
- **Last updated:** 2026-10-13
- **RFC PR:** [#2](https://github.com/opencharly/openclaw-enterprise/pull/2)
- **Implementation plan:** [0019-crabbox-oce-deployment](../plans/0019-crabbox-oce-deployment.md)
- **Related:** [Local Kubernetes development](../../docs/guides/deploy/local-kubernetes-development.md)
  and [Crabbox](https://github.com/openclaw/crabbox)

<a id="problem-and-decision"></a>

## Summary

`crabbox job run oce-deploy` deploys OCE from the caller's checkout onto any
machine that [Crabbox](https://github.com/openclaw/crabbox) can lease, a rented
VPS included. Crabbox provides the machine, the checkout, and the tools that
OCE's scripts expect; the existing `scripts/dev-up` does the deployment. The
job is unattended and repeatable, so the same command also re-proves the
deployment on a fresh lease, with the run's required artifacts and test summary
attached. With `oce-deploy-tailscale`, any device on the tailnet can open the
OCE console.

## Motivation

OpenClaw gateways commonly run on a rented host, and OpenClaw documents
deployment onto VPS hosts. OCE cannot reach those hosts today. Its deployment is
the local profile in the [Local Setup](../../docs/guides/quickstart.md) guide:
an operator prepares a workstation, runs `./bin/occ dev up` there, and
Kubernetes-only mode publishes the console on that machine's loopback under a
`.localhost` name. A `.localhost` name resolves to loopback on every computer,
so from any other device it points at that device itself, not at the
deployment. The documented answer is a troubleshooting procedure,
[Open the console from another machine](../../docs/guides/operate/troubleshooting.md#open-the-console-from-another-machine),
not a deployment other devices can use.

The deployment is manual in the other sense too: nothing re-runs it, and
nothing records what it produced. Crabbox closes both gaps with machinery it
already has. It leases a managed machine or an existing one over `ssh`, syncs a
checkout, runs commands, and forwards ports, and its jobs are named, repo-local
validation flows: one command leases, hydrates, runs, and stops, and the run
carries its own evidence, from required artifacts downloaded locally to a JUnit
summary that `crabbox results` reads. Tailscale then makes the deployment
reachable from every team member's device instead of one workstation.

<a id="scope"></a>

## Goals

- One Crabbox job deploys OCE onto a machine that has only Crabbox's
  prerequisites installed.
- One Crabbox job publishes the OCE console on the tailnet.
- The deploy job is unattended and repeatable, so a fresh lease re-proves the
  same deployment instead of one hand-driven run.

## Non-goals

- Changing what OCE's deployment scripts do, apart from the browser origin
  setting below.
- Agent native admin UIs over the tailnet. They need per-Agent wildcard
  hostnames, which a tailnet machine name cannot provide.

<a id="design"></a>

## Proposal

### Crabbox deployment

The repository-root `.crabbox.yaml` defines the deployment; Crabbox reads that
file from the checkout, and Crabbox-specific files carry `crabbox` in their
name. It carries two jobs over one pair of profiles: one deploying with
Crabbox's default reachability, and one that also asserts the path the console
is published on. Both keep the lease (`stop: never`), take their prerequisites
from one hydration workflow, and run the same deployment.

- `profile: oce` (default reachability) and `profile: oce-tailscale`
  (`network: tailscale`), each with an `oce-teardown` preset that runs
  `scripts/dev-down` and, on the tailnet profile, resets Serve;
- `hydrate: { actions: true }` with
  `actions: { workflow: .github/workflows/crabbox-hydrate.yml, job: hydrate }`;
- `command:` the CLI build and `scripts/dev-up`, and on the tailnet job the
  same command behind `tailscale serve` and `OCC_DEVELOPMENT_BROWSER_ORIGIN`.

Prerequisites come from a `workflow_dispatch`-only workflow that declares the
inputs Crabbox inspects and writes the readiness marker Crabbox waits for, so
OCE CI never runs it. Because the deployment is a Crabbox job, one command
leases, hydrates, runs and stops, and `crabbox job run --dry-run <job>` prints
that expansion without leasing. The file contents, the workflow steps, and the
ordered work are in the
[implementation plan](../plans/0019-crabbox-oce-deployment.md).

Any Crabbox SSH provider works, including `ssh` for an existing host, `proxmox`,
`xcp-ng`, `incus` virtual machines, `multipass`, `kubevirt`, and `external`.

### Tailscale access

Crabbox's [Tailscale support](https://github.com/openclaw/crabbox/blob/main/docs/features/tailscale.md)
puts the machine on the tailnet; this RFC adds no join logic of its own:

- **Managed cloud leases** on a provider with Crabbox Tailscale support, such
  as `hetzner`, `aws`, `azure`, or `gcp`: the caller enables
  `tailscale.enabled` (`CRABBOX_TAILSCALE=1`). Crabbox installs Tailscale,
  joins with its default tags and `crabbox-{slug}` hostname, and logs the
  machine out on `crabbox stop`, best-effort while SSH is still reachable.
- **Existing hosts** on the `ssh` provider: the host is already on the tailnet,
  and `static.host` is its MagicDNS name. Self-hosted virtual machines join
  their tailnet this way, because Crabbox does not join `proxmox`, `xcp-ng`,
  `kubevirt`, `incus`, or `multipass` leases.

`network: tailscale` makes the job fail unless Crabbox reaches the machine over
the tailnet, so the job only runs where the tailnet is already the path. The
console itself is published only on the node `tailscale serve` runs on.

Crabbox does not use Tailscale Serve for its managed leases, so publishing is
the job's own step, after the deployment:

1. `tailscale serve --bg --https=443 https+insecure://127.0.0.1:8443`
   terminates TLS with the tailnet certificate and forwards to the existing
   loopback console proxy;
2. the job passes the machine's tailnet origin to `dev-up`;
3. the `oce-tailscale` teardown preset resets Serve.

`dev-up` gains one optional setting, `OCC_DEVELOPMENT_BROWSER_ORIGIN`, whose
value is the tailnet origin with an explicit port,
`https://<machine>.<tailnet>.ts.net:443`; the launcher refuses an origin without
one. When it is set, the launcher:

- uses that origin as `auth.baseUrl` in place of
  `https://console.<cluster>.oce.localhost:8443`;
- uses it as the Console origin it checks, and as the sign-in redirect host it
  derives today from `console.<cluster>.oce.localhost`;
- disables `agentNativeAdmin`;
- prints `<origin>/console/` as the console URL.

When the setting is unset, the launcher does not change.

### Access

| Task    | Command                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deploy  | `crabbox job run oce-deploy`, or `crabbox job run oce-deploy-tailscale`                                                                                      |
| Console | Open `https://<machine>.<tailnet>.ts.net/console/` on any tailnet device                                                                                     |
| Tunnel  | Without Tailscale: `crabbox tunnel --id <lease> --local-port 8443 8443`, then open `https://127.0.0.1:<local-port>/console/` with the development CA trusted |
| Sign in | `crabbox connect <lease>`, then read the administrator password file printed by the launcher                                                                 |
| CLI     | `crabbox run --id <lease> -- ./bin/occ namespace list`                                                                                                       |
| Remove  | `crabbox run --id <lease> --no-sync --profile <profile> --preset oce-teardown`, then `crabbox stop <lease>`                                                  |

Credentials stay in the launcher's state directory on the machine, which
defaults beneath the temporary directory. Tailscale
Serve publishes the console only on the tailnet, never through Funnel, so
tailnet ACLs and OCE sign-in both apply. Crabbox handles the Tailscale auth
key and never forwards it to the job.

### Architecture

Every arrow below is proposed; none of these connections exists today.

```mermaid
---
config:
  theme: base
  htmlLabels: true
  themeVariables:
    fontSize: 14px
    primaryTextColor: "#344054"
    lineColor: "#8B949E"
    edgeLabelBackground: "#FFFFFF"
  flowchart:
    curve: linear
    nodeSpacing: 28
    rankSpacing: 32
    padding: 14
---
flowchart TB
  Caller["<b>User or Agent</b><br/>Checkout and Crabbox CLI"]
  Crabbox["<b>Crabbox</b><br/>Lease, sync, hydrate"]
  DevUp["<b>scripts/dev-up</b><br/>Existing deployment"]
  Serve["<b>Tailscale Serve</b><br/>Console on tailnet"]
  Browser["<b>Tailnet device</b><br/>Browser"]
  Caller -.->|job run| Crabbox
  Crabbox -.->|runs| DevUp
  Browser -.->|HTTPS| Serve
  Serve -.->|loopback 8443| DevUp
  classDef actor fill:#F1EEF5,stroke:#A091AD,color:#3A3243,stroke-width:1px
  classDef gate fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  classDef pending fill:#F3F4F6,stroke:#98A2AE,color:#44505F,stroke-width:1px,stroke-dasharray:4 4
  class Caller,Browser actor
  class DevUp gate
  class Crabbox,Serve pending
  linkStyle default stroke:#8B949E,stroke-width:1px
```

## Delivery and verification

Delivery status: Planned. Delivery is one launcher setting, the repository's
Crabbox configuration, and the current documentation those touch; the
[implementation plan](../plans/0019-crabbox-oce-deployment.md) orders the work,
names its files, and pairs each outcome below with its check.

Required outcomes and evidence: a second device opens
`https://<machine>.<tailnet>.ts.net/console/` and signs in, while a device
outside the tailnet cannot reach it; the job refuses to run when Crabbox
cannot reach the lease over the tailnet; the launcher's own API check
(`OCC_URL=... OCC_SERVICE_KEY_FILE=... ./bin/occ installation get`, which
`scripts/dev-up` prints when it finishes) answers on the lease; the
`oce-tailscale` teardown preset removes the deployment and resets Serve.

Not yet verified: none of this has run. Reading establishes the Crabbox
configuration and the launcher's contracts, not that this stack comes up on a
leased machine; the bare-VM run on a host with the profile's storage and free
ports (about 20 GB, and 3000, 8443, 6443) is the first proof, and the tailnet
must already serve HTTPS certificates for `tailscale serve --https=443`.

<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

- **Serve the console on a tailnet port with the development CA.** Every
  device would have to trust that CA. Tailscale Serve uses the tailnet's own
  certificate.
- **A Crabbox-specific join script.** It would duplicate Crabbox's
  installation, auth key handling, and logout, and it would bypass
  `network: tailscale`.
- **Keep the local profile as the only deployment.** Teams keep preparing a
  workstation by hand, and the console stays on that workstation's loopback.

## Unresolved questions

- **Milestone scope.** Deployment behavior is outside the approved milestones
  in `AGENTS.md`; the responsible maintainers decide whether it enters them,
  and nothing here is implemented before that decision.
- **The origin shape.** The launcher accepts an `https` Console origin only
  when it names a port. The launcher owner decides whether the job keeps
  passing `:443` or the launcher admits a tailnet name without one.
- **Docker on the lease.** The deployment-config owner decides whether the
  hydration workflow installs Docker or asserts the lease image already has
  it, as Crabbox's own Linux builder image does. A host outside the Debian
  family needs its own setup.
- **A static host's permissions.** On the `ssh` provider, the tailnet operator
  must already have joined the host, and the lease user needs working `sudo`
  for `tailscale serve`.

## References

- [Local Setup](https://docs-enterprise.openclaw.org/guides/quickstart/)
  ([source](../../docs/guides/quickstart.md)) and
  [Open the console from another machine](../../docs/guides/operate/troubleshooting.md#open-the-console-from-another-machine)
- [`scripts/dev-up`](../../scripts/dev-up) and
  [`scripts/ci/setup-tools.sh`](../../scripts/ci/setup-tools.sh)
- Crabbox: [repository](https://github.com/openclaw/crabbox),
  [jobs](https://github.com/openclaw/crabbox/blob/main/docs/features/jobs.md),
  [Actions hydration](https://github.com/openclaw/crabbox/blob/main/docs/features/actions-hydration.md),
  and [configuration](https://github.com/openclaw/crabbox/blob/main/docs/features/configuration.md)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
