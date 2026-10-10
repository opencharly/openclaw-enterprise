# Local containerd development

Run OpenClaw Enterprise (OCE) against a rootless containerd engine on this host, beside an
existing Kubernetes development profile. One command brings up everything the platform and the
[Rootless containerd Compute Driver](../../reference/drivers/containerd-compute.md) need:
PostgreSQL as a workload on the engine with its own engine volume, its database roles and
migrations applied without a human step, the Installation and its administrator bootstrapped, and
the controller, worker and console running. The Agent gateway arrives on the engine when an Agent
is deployed.

Nothing here requires Docker, Podman, Compose, or a terminator in front of the console. The
engine is the runtime; `nerdctl` is its control and inspection client, and `ctr`, which ships with
containerd, answers the same read-only questions.

Use this profile when you need a local Agent runtime without a cluster. It coexists with the
[local Kubernetes profile](local-kubernetes-development.md): a distinct engine namespace, ports
and state directory keep both stacks independent.

## Prerequisites

Install Node.js 24+, repository-pinned pnpm, the Go version from `go.mod`, and a rootless
containerd engine with CNI plugins:

```bash
containerd-rootless-setuptool.sh install
sudo loginctl enable-linger "$USER"      # keep the engine across logout
systemctl --user status containerd.service
ctr version
```

The controller and the worker must run **on the host**, not as engine workloads: the Driver's
startup preflight executes the host helper, and that helper owns this user's rootless containerd
socket. Everything else in this procedure runs on the engine.

The runtime images are the one input the engine cannot produce by itself. A released deployment
pulls digest-pinned images from its registry; a local build is loaded into the engine namespace
instead, because no builder is required to run the stack:

```bash
nerdctl -n openclaw-enterprise load < image.tar
```

## Bring the stack up

```bash
scripts/containerd-up
```

The script is idempotent and does all of this:

- verifies `nerdctl` reaches the rootless engine and builds `bin/compute-containerd` when it is
  missing;
- creates the engine volume that holds the database;
- generates the stack credentials into `~/.local/state/oce-containerd/stack.env` (mode `0600`)
  and starts PostgreSQL as a container with `--restart=always`, a health check, its data on that
  engine volume, and the local database roles from `migrations/init-local.sql` applied on first
  initialization;
- waits for PostgreSQL, applies the platform migrations as `occ_migrator`, and verifies the
  less-privileged `occ_app` role exists;
- writes the Installation document to `state/installation.yaml` (mode `0600`) and bootstraps the
  platform: the Installation, the administrator and the service key, with no operator step;
- starts the controller and the worker as host processes with logs and pid files under the state
  directory, then waits for `/healthz` and `worker.started`.

Options override one stack's coordinates; a second run against the same state directory resumes
the same namespace, ports and database:

| Option                                                     | Default                         | Purpose                                              |
| ---------------------------------------------------------- | ------------------------------- | ---------------------------------------------------- |
| `--namespace NAME`                                         | `openclaw-enterprise`           | engine namespace for PostgreSQL and Agent containers |
| `--state DIRECTORY`                                        | `~/.local/state/oce-containerd` | credentials, Installation, logs, pid files           |
| `--database-port PORT`                                     | `5433`                          | loopback port PostgreSQL publishes                   |
| `--api-port PORT`                                          | `3100`                          | loopback port for the API and console                |
| `--gateway-image`, `--agent-image`, `--egress-proxy-image` | `local/oce-*:dev`               | runtime images                                       |
| `--egress on\|off`                                         | `off`                           | Agent egress: the allowlisted proxy, or open egress  |

## Credentials and what they survive

Every credential lives in one canonical store, `~/.config/oce-containerd/` (directory `0700`, files
`0600`), outside the checkout and outside any stack's state directory:

| Path               | What it is for                                                                             | What it survives                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `platform.env`     | `OCC_AUTH_SECRET` and the PostgreSQL administrator password, plus this stack's coordinates | every teardown including `--purge`; live sessions and service keys derive from the auth secret, so it is reused and never regenerated |
| `codex-oauth.json` | the operator's own ChatGPT login for a dedicated Codex harness                             | every teardown; an OAuth deployment stays automatable without another device login                                                    |
| `openai.key`       | the model provider key for a provider-key harness                                          | every teardown                                                                                                                        |
| `credentials/`     | the per-Namespace gateway credentials the Driver writes                                    | while the Agent exists; recreated with it                                                                                             |
| `secrets/`         | the filesystem Secret Driver's store                                                       | while staged Secrets are referenced; a consumed OAuth login becomes a marker                                                          |
| `service-key.json` | a canonical copy of a platform service key for API automation                              | written once and never overwritten; the authoritative copy stays in that stack's state directory                                      |

The stack's state directory (`~/.local/state/oce-containerd/`, `0700`) holds only what a run
produces: `installation.yaml`, `namespaces`, `api-port`, pid files, logs, and `bootstrap/` with that
stack's service key and administrator password. `scripts/containerd-up` creates the store when it is
missing and reads it on every later run, so a bring-up needs no credential flag, no prompt and no
second set of credentials.

`scripts/containerd-down` stops the controller, the worker and PostgreSQL, and keeps the engine
volume, the state directory and the store: the next `scripts/containerd-up` resumes the same
database and the same platform state without bootstrapping again. `scripts/containerd-down --purge`
additionally destroys the engine volume, the state directory and the platform containers of the
Namespaces that stack owns. It never touches `~/.config/oce-containerd/`, so a purge cannot take the
OAuth bundle or the platform credentials with it: only `rm` does that, deliberately.

Per-Agent gateway and app-server tokens are generated per Agent and deliberately not reused; they
live in the Driver's `credentials/` and `secrets/` stores for that Agent's lifetime rather than in
the canonical store.

## Deploy a dedicated Codex Agent

The platform deploys an Agent the same way in every environment: an Agent configuration selects
the model and the local gateway, a Namespace-owned Secret holds the model credential, and the
Agent binds that Secret as its harness credential before it is deployed. The script stages the
Secret, creates the configuration and the Agent, grants the Agent's own service principal
`secret:operate` on that Secret, and requests the first deployment:

```bash
node scripts/containerd-agent.mjs --oauth --agent-name codex-agent
```

Every credential comes from the store: `--oauth` stages the stored ChatGPT bundle as the harness
credential, `--auth api_key` uses the stored provider key, and the service key is the one the stack
was bootstrapped with. No credential flag is required, and nothing is prompted for.

`--model` selects the Codex model name and defaults to `gpt-5.6-luna`; `--state` points at a stack
started with a non-default state directory. The provider key file is read by the script and never
printed. The Agent's configuration registers the `codex` provider and the Agent's harness runtime
explicitly, because the platform refuses an implicit runtime for a provider that could run on
either harness.

The worker logs `REVISION_ACTIVATED` when the revision is live. The harness then reports its own
startup phases on standard error, and the
[reference](../../reference/drivers/containerd-compute.md#monitor-a-deployment) shows how to read
them with `ctr`:

```bash
ctr -n openclaw-enterprise tasks logs <container-name>
```

Expect `codex-login` `ok`, `codex.model_probe` `READY`, `model-probe` `ok` and `native-spawn`
`ok`.

`codex-login` `ok` proves the platform delivered the staged credential to the harness. A
`codex.model_probe` that reports `MODEL_PROBE_TIMEOUT` instead means the harness could not reach
its model endpoint: with `--egress on` the Agent stands on the no-egress plane and reaches only
the proxy's allowlist, and this harness probes without traversing that proxy, so its probe never
completes. That is why the local profile defaults to open egress; use `--egress on` when an Agent
must be confined, and add the endpoint host to the Installation's allowlist for a harness that
does route through the proxy.

## Inspect a running stack

```bash
nerdctl -n openclaw-enterprise ps --format '{{.Names}}\t{{.Status}}'
ctr -n openclaw-enterprise containers ls
```

A stack owns one PostgreSQL container (`oce-containerd-postgres`), the controller and worker host
processes, and — once an Agent is deployed — the Agent's gateway, harness, relay and egress proxy
containers. The Agent's containers carry its Namespace, Agent and revision labels; the
[reference](../../reference/drivers/containerd-compute.md#monitor-a-deployment) documents them.

## Stop and clean up

```bash
scripts/containerd-down            # stops the processes and PostgreSQL, keeps the database
scripts/containerd-down --purge    # also removes the engine volume, the stack state, and the
                                   # Agent containers and volumes this stack created
```

Without `--purge` the engine volume, the state directory and the credential store survive, so the
next `scripts/containerd-up` resumes the same platform state with no bootstrap and no new
credentials. `--purge` destroys the database, the state directory and the platform containers and
per-Agent volumes of the Namespaces this stack owns; it never touches containers belonging to
another installation, and it never touches `~/.config/oce-containerd/`. `scripts/containerd-restart`
restarts only the controller and the worker, again with every credential read from the store.

## Limits

- **Images are published, not built here.** The stack consumes the gateway, harness and egress
  proxy images from its registry (digest-pinned in production). A local build has to be loaded
  into the engine namespace; a missing image fails the bring-up with the command that loads it.
- **The controller and worker are host processes.** A containerised controller cannot compose
  this Driver, because its preflight executes the host helper.
- **The egress proxy does not carry a provider-key Codex probe.** With `--egress on`, Agent
  workloads reach only the allowlisted hosts through the proxy; a dedicated Codex harness probing
  its model endpoint without traversing that proxy times out. Until the harness honours the
  proxy, confine an Agent only when its credential needs no endpoint outside the allowlist.
- **Dedicated Codex needs a staged credential.** A dedicated Codex Agent is refused unless a
  provider key or a Codex OAuth login is staged for it.
- **No Sandbox Driver.** A Sandbox Driver is a Kubernetes Gateway; selecting one with
  `compute-containerd` is refused.
- **Repository credentials require Kubernetes.** `drivers.repo` composes only with the bundled
  Kubernetes Compute Driver.
- **Egress is not kernel-enforced.** Isolation is the per-Agent network topology plus the egress
  proxy allowlist. A container that ignores its proxy environment has more latitude than a
  NetworkPolicy allows.

For failures that are not covered here, see
[troubleshooting](../operate/troubleshooting.md).
