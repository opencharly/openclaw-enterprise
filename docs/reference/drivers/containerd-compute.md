# Rootless containerd Compute Driver

Use the Rootless containerd Compute Driver to run embedded OpenClaw on the operator's
own rootless containerd engine. **containerd is the runtime dependency**: the Driver
prepares each Namespace inside that engine, runs one gateway container per Agent, and lets
OCC keep ownership of Agent resources, authorization, revisions, and activation.
`nerdctl` is an optional command-line convenience for showing and debugging the running
containers — never the engine, and never part of delivery. `ctr`, which ships with
containerd, and the engine's own state read the same things without it
(see [Monitor a deployment](#monitor-a-deployment)). Trusted Installation YAML can select
`compute-containerd` (implementation `occ/containerd`) in development or production.

Choose this Driver when an Agent must run on the same host as the control plane
without Kubernetes or Docker. For dedicated Codex, OCC-managed model credentials,
workload identity projection, or a kernel-enforced tenant quota, use
[Kubernetes Compute](kubernetes-compute.md) instead; the
[capability matrix](compute-matrix.md) records exactly which rows this Driver holds.

## Requirements and configuration

The dependency to install is a **rootless containerd** service — with RootlessKit,
slirp4netns and a rootless port driver — plus CNI configuration for its namespace. The
helper binary is built from this repository (`pnpm helper:containerd:build`) and
referenced by its absolute path.

The helper reaches containerd directly, in-process: it links
`github.com/containerd/nerdctl/v2` and calls `clientutil.NewClient` to open a containerd
client, then the library's `container`, `volume` and `network` packages for every
lifecycle operation. Container create/start/stop/remove, volume create/list/remove,
network create/remove, container list and inspect, exec, and log reads all travel over
that client to the containerd socket. The library is also where the containerd-side
details live — labels, name store, resource limits, CNI wiring.

Two operations normally belong to the `nerdctl` CLI, and the helper serves them itself:
containerd invokes it as each container's **OCI hook** and **log shim**. That is why
containerd records the helper's own path as the container's log driver and hook, and why
the file must stay exactly where the Installation names it. **Moving or renaming that binary
invalidates container state created before the move**: those containers keep invoking the old
path and fail with `failed to execute …/compute-containerd: No such file or directory`, in their
hook or log reads, while the engine still lists them as running. Recreate the revision, which
creates its containers against the new path; the Agent's volumes and its Codex home are
unaffected, so a consumed OAuth login stays valid. The helper never executes the
`nerdctl` binary; nothing on the delivery path shells out to it.

The controller and the worker run **on the host**, not in a container, because the
Driver's startup preflight executes that helper against the user's engine.

In the trusted Installation document at `OCC_CONFIG_PATH`:

```yaml
compute:
  id: compute-containerd
  configuration:
    helper:
      path: /var/lib/oce-containerd/bin/compute-containerd
    containerd:
      namespace: openclaw-enterprise
    images:
      gateway: registry.example/gateway@sha256:0000…0000
      agent: registry.example/agent@sha256:0000…0000
      requireImmutableDigest: true
    credentials:
      directory: /var/lib/oce-containerd/credentials
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
[local deployment guide](../../guides/deploy/local-containerd-development.md) gives the
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

## Monitor a deployment

Every check below is read-only, and the engine's own `ctr` — which ships with containerd, so
it is already present wherever this Driver runs — answers all of them. `nerdctl` renders
friendlier tables and filters labels; treat it as the optional convenience, not as a
prerequisite. Use the namespace from `containerd.namespace` (the examples use
`openclaw-enterprise`).

List every container this Driver manages, and read one container's labels and specification:

```bash
ctr -n openclaw-enterprise containers ls
ctr -n openclaw-enterprise containers info oce-<namespace hash>-<agent hash>-gateway
```

The base capability is the engine's own state: every container, its labels and its spec are
containerd objects. The optional CLI prints the same set with the role, Agent and status
columns already arranged:

```bash
nerdctl -n openclaw-enterprise ps -a \
  --filter label=org.openclaw.enterprise.managed=true \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Labels}}'
```

Expect one gateway container per Agent plus one container per dedicated harness. Scope a
check to one Agent with `--filter label=org.openclaw.enterprise.agent-id=<agent-id>`, and
pick a role with `--filter label=org.openclaw.enterprise.role=gateway` or `…role=agent`.

Read the labels to see who owns a container:

| Label                                        | Meaning                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `org.openclaw.enterprise.namespace-id`       | the OCC Namespace the container belongs to                                |
| `org.openclaw.enterprise.agent-id`           | the Agent it serves                                                       |
| `org.openclaw.enterprise.revision-id`        | the exact revision that created it                                        |
| `org.openclaw.enterprise.revision-number`    | that revision's number, which orders generations                          |
| `org.openclaw.enterprise.role`               | `gateway`, `agent` (a dedicated harness), or an internal preparation role |
| `org.openclaw.enterprise.configuration-hash` | the gateway configuration it was started from                             |

`ctr containers info` prints the same labels with the container's specification. Names follow
the same identities: `oce-<namespaceHash>-<agentHash>-gateway` for the Agent-scoped gateway,
and `oce-<namespaceHash>-<agentHash>-rev-<revisionHash>` for a revision-scoped container, so a
name alone tells you which Agent and revision it belongs to. A container whose labels do not
match the operation asking for it is refused, never adopted.

Inspect the containers this Agent owns, and its persistent volumes. The optional CLI filters
by the Driver's own labels and lists the volume store:

```bash
AGENT=agt_00000000-0000-4000-8000-000000000000
nerdctl -n openclaw-enterprise ps -a --filter label=org.openclaw.enterprise.agent-id=$AGENT
nerdctl -n openclaw-enterprise volume ls \
  --filter label=org.openclaw.enterprise.agent-id=$AGENT
```

Containerd keeps no volume object, so volumes are the one check where the optional CLI is the
practical reader: the Driver's volumes are directories in the engine's `nerdctl` store, which
`nerdctl volume ls` lists with the labels the Driver wrote. Every container check above has a
`ctr` equivalent; this one does not.

Expect the harness container and the gateway for the active revision to report `Up`, and
one state volume, one workspace volume and (for a dedicated Codex harness) one
`-codex-home` volume per Agent.

Read a container's output — the harness logs its startup phases and its model probe, which
is the quickest way to see whether an Agent authenticates:

```bash
ctr -n openclaw-enterprise tasks logs <container-name>
```

The optional CLI reads the same log stream with `nerdctl -n openclaw-enterprise logs <name>`.

Expect `runtime.startup_phase` lines for `codex-login`, `model-probe` and `native-spawn`,
and `{"event":"codex.model_probe",…,"code":"READY"}` once the model credential is accepted.

The [local deployment guide](../../guides/deploy/local-containerd-development.md) covers
installing the engine and the helper; this page owns the labels, the names, and what the
Driver is allowed to touch.

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

An **embedded OpenClaw gateway** is the harness that authenticates with
`harnessAuth: { "method": "runtime" }`: the operator supplies the model credential to the
runtime the gateway hosts, and a dedicated Codex harness is refused with that method because the
shared runtime would start it with `CODEX_LOGIN_MODE=api_key` and no key.

A **dedicated Codex harness** runs as its own revision-scoped container beside the Agent's
gateway, created before it and removed with it, with one persisted transport token that both roles
present and the gateway reaching the harness by name on the Agent's plane. It authenticates from a
credential this Driver delivers: a staged Codex OAuth login or a staged provider key.
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
runs its model probe before serving.

`harnessAuth: { "method": "api_key" }` is accepted for a dedicated Codex harness whose primary
model is an `openai/` or `codex/` reference. The Driver reads the key from the same Secret store
under the same ownership proof as the login, and hands it to the harness container as
`OPENAI_API_KEY`, exactly as the Kubernetes Compute Driver projects its Secret; the shared runtime
logs in with `codex login --with-api-key`, deletes the variable from its process environment, and
runs its model probe before serving. The key never enters argv, a log line, a file, the gateway
container, or the controller's persisted state. `codex_pat` is still refused: a Backend-issued
account token has no delivery path to exactly one container here, and `credential_source` needs a
paired Credential Gateway this engine does not hold.

Read both deliveries as the trust boundary they are: the Compute Driver reads the Secret Driver's
store to consume the credential, exactly as the Kubernetes Compute Driver reads the same Secret
through its cluster's Secret API. Composition injects the store the selected Secret Driver
already owns, so the operator never names the path twice. The OAuth bundle is never placed in an
environment variable, argv, a log line, the gateway container, or the controller; the provider key
is placed in the harness container's environment alone, as the Kubernetes path projects it, and
the runtime removes it before serving.

A login is spent by the first delivery that seeds it. A failed handoff leaves it reserved but
unspent, so a retry finishes it; losing the Codex volume after consumption means a new sign-in.
A revision delivered without OAuth clears any earlier `auth.json` and receipt from the Codex
volume, so a personal login cannot keep refreshing on the Agent's disk.

This Driver does not pair with a **Sandbox Driver**. It holds no Sandbox placement, so a paired
Sandbox Driver would own no workload: composition refuses `drivers.sandbox` with
`compute-containerd` instead of composing a pairing this engine cannot serve, and a dedicated
Codex harness always runs as this Driver's own revision-scoped container. A **Credential Gateway**
cannot pair with it either, for the same reason the platform admits a credential gateway only
with a Sandbox Driver.

Three rows remain out of reach for a host engine: service-principal workload identity, OCC Secret
bindings, and a Backend-issued account token. All three reach a workload through a **Credential
Gateway**, and the platform admits a credential gateway only with a paired **Sandbox Driver**
(`worker.ts:893`), whose supervisor substitutes a credential on matching outbound requests while
the workload holds only a placeholder. [TASK-0046](../../../specs/plans/46-host-engine-credential-parity.md)
records what would close them, and the decision it waits on.

## Troubleshooting

| Symptom                                                        | Cause and fix                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spawn …/compute-containerd ENOENT` at startup                 | The controller runs where the helper is not. Run the controller and worker on the host that holds the helper and the engine.                                                   |
| Preflight reports an image missing that `nerdctl images` shows | The image is in another containerd namespace. Import it with `-n <configured namespace>`.                                                                                      |
| Runtime exits with `EPERM … chmod '/home/node/.openclaw'`      | The Agent's volumes were never handed to the workload user. Delivery does this; a revision that skips storage preparation cannot start.                                        |
| Gateway never becomes ready                                    | The runtime needs a bootstrapped workspace. Seeding the workspace is the platform's projection, so a delivery without one starts a gateway that cannot pass its own admission. |
| `the Namespace budget … leaves no room`                        | The Namespace already holds containers whose recorded limits fill `resources.namespace.quota`. Retire a revision or raise the budget.                                          |
| `Refusing unrelated workspace storage`                         | A volume with the Agent's name carries foreign labels. Remove it deliberately rather than adopting it.                                                                         |

## Related

- [Local rootless containerd deployment](../../guides/deploy/local-containerd-development.md)
- [ComputeDriver capability matrix](compute-matrix.md)
- [Compute Driver contract](compute.md)
