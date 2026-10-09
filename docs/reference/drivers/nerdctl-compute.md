# Rootless nerdctl Compute Driver

Use the Rootless nerdctl Compute Driver to run embedded OpenClaw on the operator's
own rootless containerd engine. It prepares each Namespace inside the engine,
runs one gateway container per Agent, and lets OCC keep ownership of Agent
resources, authorization, revisions, and activation. Trusted Installation YAML
can select `compute-nerdctl` (implementation `occ/nerdctl`) in development or
production.

Choose this Driver when an Agent must run on the same host as the control plane
without Kubernetes or Docker. For dedicated Codex, OCC-managed model credentials,
workload identity projection, or a kernel-enforced tenant quota, use
[Kubernetes Compute](kubernetes-compute.md) instead; the
[capability matrix](compute-matrix.md) records exactly which rows this Driver holds.

## Requirements and configuration

The engine is rootless containerd driven by nerdctl, with RootlessKit and slirp4netns
and a rootless port driver. The helper binary is built from this repository
(`pnpm helper:nerdctl:build`) and referenced by its absolute path. The engine
invokes that exact path as its OCI hook and log shim, so the file must stay where
it was configured.
The controller and the worker run **on the host**, not in a container, because the
Driver's startup preflight executes that helper against the user's engine.

In the trusted Installation document at `OCC_CONFIG_PATH`:

```yaml
compute:
  id: compute-nerdctl
  configuration:
    helper:
      path: /var/lib/oce-nerdctl/bin/compute-nerdctl
    containerd:
      namespace: openclaw-enterprise
    images:
      gateway: registry.example/gateway@sha256:0000…0000
      agent: registry.example/agent@sha256:0000…0000
      requireImmutableDigest: true
    credentials:
      directory: /var/lib/oce-nerdctl/credentials
    resources:
      gateway:
        requests: { cpu: 100m, memory: 1792Mi }
        limits: { cpu: "4", memory: 3Gi }
      agent:
        requests: { cpu: 100m, memory: 512Mi }
        limits: { cpu: "2", memory: 2Gi }
      namespace:
        quota:
          limits.cpu: "8"
          limits.memory: 8Gi
        containerDefaults:
          requests: { cpu: 50m, memory: 128Mi }
          limits: { cpu: "1", memory: 1Gi }
```

Every path is absolute, production requires immutable digests, and the
`resources` section is required because the same document configures the
Kubernetes Driver. Images must be present **inside the configured containerd
namespace**; import them with `nerdctl -n openclaw-enterprise load`, because a tag
loaded into the default namespace is invisible here. The
[local deployment guide](../../guides/deploy/local-nerdctl-development.md) gives the
full procedure, including PostgreSQL and the console terminator.

## Namespace and revision lifecycle

A Namespace owns two CNI networks in the engine's namespace: an **internal** plane
that carries no egress and an **edge** plane. Each Agent owns two volumes, one for
its private state and one for its workspace.

Preparing a revision admits the requested limits against the Namespace budget,
ensures the networks and volumes, hands the volumes to the workload user, optionally
seeds the workspace, and starts the gateway container from the pinned image with a
readiness probe on its own port. Activation and deactivation are separate stages, so
the predecessor keeps serving until the replacement is verified. Retiring a revision
removes its containers and leaves the Agent's volumes; deleting the Agent removes
containers, then volumes, then networks, and nothing else.

Every resource carries this Driver's ownership labels, and each operation verifies
the labels it finds before touching a resource. A container, volume, or network with
a matching name but foreign labels fails the operation instead of being adopted.
Names are derived from hashed Namespace and Agent identifiers, so they are
deterministic and never collide across Installations.

## Credentials and limits

The Agent's gateway authentication is the managed password by default, stored as an
owned credential file (`<directory>/oce-<hash>/gateway-password`, mode `0600`). The
Driver creates it when it is missing, preserves the value it finds, refuses a file
it did not write, and removes it with the Agent. Because the same file is reused by
every later container, a replacement runtime presents the password its clients
already hold.

Limits are enforced by the engine on every container. The namespace budget is an
admission decision: the Driver sums the limits recorded on the Namespace's
containers and refuses a delivery that would exceed `resources.namespace.quota`.
The engine has no `ResourceQuota` object, so a tenant budget is not a kernel quota,
and `requests` are scheduler reservations that this Driver carries unused.

The internal plane is kernel-enforced no-egress: a container there reaches nothing outside the
Agent. An Installation that names an **egress proxy** gets the enforced topology, and the Driver
will not place a workload on the no-egress plane without one:

- the proxy, one container per Namespace, stands on both planes, so it is the workloads' only
  route out and the allowlist's control point;
- workloads stand on the internal plane alone and are told to use the proxy;
- a **relay** on both planes publishes the gateway's port, because that port cannot be published
  from the no-egress plane. It forwards bytes to the gateway on the internal plane, which is the
  routing layer a cluster would provide from outside the workload.

Without a proxy in the Installation, workloads keep the edge plane and their egress is ungated.

Select `harnessAuth: { "method": "runtime" }` and supply the model credential to the
runtime. A **dedicated Codex harness** runs as its own revision-scoped container beside the
Agent's gateway, created before it and removed with it, with one persisted transport token
that both roles present and the gateway reaching the harness by name on the Agent's plane.
The harness program is roughly 135 KB — above Linux's 128 KiB limit for a single exec argument —
so it runs under the runtime image's `tini` as the repository's fixed loader plus compressed
program pieces, the same bounded command the Kubernetes Harness uses. Passing it as one `-e`
argument fails with `E2BIG` before Node starts: the container exits `255` with no output.
The workload environment — and therefore any model credential — reaches the harness container
alone; the gateway holds only the transport endpoint and token. The harness owns a Codex volume
of its own (`oce-<nsHash12>-<agentHash12>-codex-home`), mounted at `CODEX_HOME` only in that
container; the gateway mounts the OpenClaw state volume instead.

`harnessAuth: { "method": "oauth" }` is accepted for a dedicated Codex harness and uses the
staged Codex device login the platform holds in the selected Secret Driver. The Driver reads
that login, reserves it for the exact Agent and Codex home, writes the native `auth.json` plus
the `.oce-oauth.json` receipt into the Codex volume through a one-shot seeder, and then replaces
the staged login with a consumed marker. The harness starts with `CODEX_LOGIN_MODE=oauth` and the
two `OCE_CODEX_OAUTH_*` receipt identities; the shared runtime logs in from the seeded bundle and
runs its model probe before serving. Only `runtime` and a dedicated Codex `oauth` login are
admitted: `api_key` and `codex_pat` still need Secret-backed key delivery to exactly one
container, and `credential_source` needs a paired Credential Gateway.

Read that delivery as the trust boundary it is: the Compute Driver reads the Secret Driver's
store to consume the login, exactly as the Kubernetes Compute Driver reads the same login
through its cluster's Secret API. Composition injects the store the selected Secret Driver
already owns, so the operator never names the path twice, and the bundle is never placed in an
environment variable, argv, a log line, the gateway container, or the controller.

A login is spent by the first delivery that seeds it. A failed handoff leaves it reserved but
unspent, so a retry finishes it; losing the Codex volume after consumption means a new sign-in.
A revision delivered without OAuth clears any earlier `auth.json` and receipt from the Codex
volume, so a personal login cannot keep refreshing on the Agent's disk.

Pairing a **Sandbox Driver** moves that dedicated harness out of this engine: the Driver
provisions it through the paired Sandbox Driver, waits for it to serve, and points the gateway at
the provider-owned endpoint with the same transport token instead of starting a container of its
own. Stopping or retiring the revision, and deleting the Namespace, delete the Sandbox through
that Driver. A **Credential Gateway** can therefore pair with `compute-nerdctl`: it requires the
Sandbox Driver it attaches sources to, and withdrawing a source resolves the revision's Sandbox
through the paired driver. The Sandbox must be the bundled OpenShell driver with
`gateway.workspaceMode: managed`, because this engine has no Kubernetes object client; that mode
refuses the operator resources, labels, and readiness a Kubernetes placement would apply, and its
`openshell` Backend must name the gateway `endpoint` this host dials. Pairing does not itself
change which `harnessAuth` methods are admitted;
[TASK-0046](../../../specs/plans/46-host-engine-credential-parity.md) records that remaining work.
That path is not usable today: the isolation boundary the real OpenShell supervisor requires is not
implemented, so no Sandbox can be started on this engine and `CreateSandbox` fails closed.

Three rows remain out of reach for a host engine: service-principal workload identity, OCC Secret
bindings, and a Backend-issued account token. All three reach a workload through a **Credential
Gateway**, and the platform admits a credential gateway only with a paired **Sandbox Driver**
(`worker.ts:893`), whose supervisor substitutes a credential on matching outbound requests while
the workload holds only a placeholder.

That is the same missing piece the `sandbox` row records, so all three rows are
consequences of one deviation rather than separate gaps, and the capability matrix says so in
each of their cells. [TASK-0046](../../../specs/plans/46-host-engine-credential-parity.md) records
what would close them, and the decision it waits on.

## Troubleshooting

| Symptom                                                        | Cause and fix                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spawn …/compute-nerdctl ENOENT` at startup                    | The controller runs where the helper is not. Run the controller and worker on the host that holds the helper and the engine.                                                   |
| Preflight reports an image missing that `nerdctl images` shows | The image is in another containerd namespace. Import it with `-n <configured namespace>`.                                                                                      |
| Runtime exits with `EPERM … chmod '/home/node/.openclaw'`      | The Agent's volumes were never handed to the workload user. Delivery does this; a revision that skips storage preparation cannot start.                                        |
| Gateway never becomes ready                                    | The runtime needs a bootstrapped workspace. Seeding the workspace is the platform's projection, so a delivery without one starts a gateway that cannot pass its own admission. |
| `the Namespace budget … leaves no room`                        | The Namespace already holds containers whose recorded limits fill `resources.namespace.quota`. Retire a revision or raise the budget.                                          |
| `Refusing unrelated workspace storage`                         | A volume with the Agent's name carries foreign labels. Remove it deliberately rather than adopting it.                                                                         |

## Related

- [Local rootless nerdctl deployment](../../guides/deploy/local-nerdctl-development.md)
- [ComputeDriver capability matrix](compute-matrix.md)
- [Compute Driver contract](compute.md)
