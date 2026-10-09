# Local containerd development

Run OpenClaw Enterprise (OCE) against a rootless containerd engine on this host, controlled and inspected with `nerdctl`, beside an
existing Kubernetes development profile. PostgreSQL and the console terminator run in
Compose; the controller, the worker and every Agent container run on the host, because the
`compute-containerd` Driver drives this user's rootless containerd through a host helper.

Use this profile when you need a local Agent runtime without a cluster. It coexists with
the [local Kubernetes profile](local-kubernetes-development.md): a distinct Compose
project, distinct ports, and distinct volumes keep both stacks independent.

## Prerequisites

Install Node.js 24+, repository-pinned pnpm, the Go version from `go.mod`, Docker or
Podman, and a rootless containerd engine with CNI plugins:

```bash
containerd-rootless-setuptool.sh install
sudo loginctl enable-linger "$USER"      # keep the engine across logout
systemctl --user status containerd.service
```

Confirm that the CLI reaches the engine and that the engine is the rootless one:

```bash
nerdctl info | grep -i rootless
```

## Build the helper

The Driver calls a helper that owns every engine operation, including the OCI hook and the
container log shim:

```bash
pnpm helper:containerd:build
pnpm helper:containerd:check
ls -l bin/compute-containerd
```

The helper must keep a stable absolute path: every container records it as its OCI hook, so
moving it makes existing containers unrunnable.

## Start PostgreSQL and the console terminator

```bash
export OCC_AUTH_SECRET="$(openssl rand -hex 32)"
docker compose -f compose.containerd.yaml up -d --build
docker compose -f compose.containerd.yaml ps
```

This starts PostgreSQL on `127.0.0.1:5433`, migrates the database, and terminates TLS for
the console on `127.0.0.1:9443`. Override the port with `OCC_NERDCTL_POSTGRES_PORT`.

The terminator joins the host network so it can reach a controller bound to loopback; a
container on a bridge network cannot.

## Run the controller on the host

The controller must run where the helper lives: its startup preflight executes the helper
against the rootless engine, so a containerised controller fails with `ENOENT`.

```bash
OCC_CONFIG_PATH="$PWD/.build/containerd/installation.yaml" \
OCC_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:5433/openclaw_enterprise \
OCC_HOST=127.0.0.1 OCC_PORT=3100 NODE_ENV=development \
OCC_AUTH_SECRET="$OCC_AUTH_SECRET" \
OCC_AUTH_BASE_URL=https://127.0.0.1:9443 \
node apps/controller/src/server.mjs
```

Expected startup lines name the selected Compute Driver and report the engine's image
state:

```text
{"event":"compute.preflight-warning","computeDriverId":"compute-containerd","code":"IMAGE_MISSING",…}
{"event":"listening","host":"127.0.0.1","port":3100,…}
```

Verify the API and the console through the terminator:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/api/auth/session   # 200
curl -skS -o /dev/null -w '%{http_code}\n' https://127.0.0.1:9443/console         # 200
```

A development controller requires a loopback auth base URL, which is why the console is
reached at `127.0.0.1` rather than a name.

## Trust the console certificate

The terminator generates its own CA on first start. Copy the root certificate out and trust
it for the browser:

```bash
docker compose -f compose.containerd.yaml cp console-tls:/data/caddy/pki/authorities/local/root.crt ./oce-nerdctl-root.crt
sudo trust anchor --store ./oce-nerdctl-root.crt        # Arch, Fedora
```

Then open `https://127.0.0.1:9443/console`. The address must be loopback: a development
controller refuses a non-loopback origin.

## Write the Installation document

The controller reads an Installation document from the path in `OCC_CONFIG_PATH`.
This profile selects the host-managed Secret and Configuration Drivers and the containerd
Compute Driver.

Every path in the document belongs to the controller's own filesystem, so a host process needs
absolute paths it can write, under the account that runs it: the container variant's `/var/lib/...`
roots do not exist here, and the first Configuration created against a missing root fails with
`DEPENDENCY_UNAVAILABLE` and no further explanation. Create them before starting the controller.

```yaml
occ:
  cluster: local-containerd
drivers:
  configuration:
    id: occ/filesystem-configuration
    configuration:
      # Any absolute path the running account can write; create it first.
      root: /opt/oce-containerd/configuration
  iam:
    id: native-iam
    configuration: {}
  compute:
    id: compute-containerd
    configuration:
      helper:
        path: /usr/local/bin/compute-containerd
      containerd:
        namespace: openclaw-enterprise
      images:
        gateway: registry.example/gateway@sha256:0000000000000000000000000000000000000000000000000000000000000000
        agent: registry.example/agent@sha256:0000000000000000000000000000000000000000000000000000000000000000
        # Set false only outside production, where a locally built image has no digest.
        requireImmutableDigest: true
      credentials:
        directory: /var/lib/oce-containerd/credentials

      # The same limits the Kubernetes profile states; requests are scheduler reservations and
      # have no engine equivalent, so this Driver reads the limits.
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
      egress:
        proxyImage: registry.example/egress-proxy@sha256:0000000000000000000000000000000000000000000000000000000000000000
        port: 3128
        allowlist:
          - registry.npmjs.org
  secret:
    id: occ/filesystem-secret
    configuration:
      directory: /var/lib/oce-containerd/secrets
```

Every path in the document must be absolute, both images must be pinned by digest, and the
resource section is required: an unpinned image would change under a revision that the platform
treats as immutable, and a quantity the engine cannot honour fails the Configuration rather than
running unbounded.

## Start the worker on the host

The worker runs outside Compose: the helper owns this user's rootless containerd socket and
writes host paths into container specifications.

```bash
OCC_CONFIG_PATH="$PWD/.build/containerd/installation.yaml" \
OCC_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:5433/openclaw_enterprise \
NODE_ENV=development OCC_AUTH_SECRET="$OCC_AUTH_SECRET" \
node apps/controller/src/worker.mjs
```

A worker that reports `worker.started` with `computeDriverId: compute-containerd` has composed
the Installation; it fails closed when the helper path, engine namespace or image pins are
wrong. Reconciling a Namespace creates that Agent's two network planes in the engine:

```bash
nerdctl -n openclaw-enterprise network ls
```

Expected: `oce-<namespace hash>-internal` and `oce-<namespace hash>-edge`. Inspect a
container or network from another containerd namespace and it will look empty: this Driver works
only in the containerd namespace named in its configuration.

## Configure the Agent gateway

An Agent's Configuration decides how its gateway listens, and two settings are not optional:

```json
{
  "kind": "agent",
  "values": {
    "agents": { "defaults": { "model": "openai/gpt-6-luna" } },
    "gateway": { "mode": "local", "bind": "lan" }
  }
}
```

- **`gateway.mode: "local"`** — without it the gateway refuses to start: _"existing config is
  missing gateway.mode. Treat this as suspicious or clobbered config."_
- **`gateway.bind: "lan"`** — the gateway otherwise listens on loopback only, so the port this
  Driver publishes reaches nothing and the endpoint answers nothing from the host. The published
  port is what makes the Agent reachable; the bind mode is what makes it answer.

Both are Agent Configuration, not Driver settings, and both are the same values the Kubernetes
guide uses.

## Verify an Agent

Deploy an Agent through the console or the API and confirm the runtime the Driver created:

```bash
nerdctl ps --format '{{.Names}}\t{{.Status}}'
nerdctl inspect oce-$(printf 'ns' | sha256sum | cut -c1-12)   # container names carry hashes
```

The container's labels record its namespace, Agent, revision and the Compute Driver that
owns it, and `nerdctl/inspect` shows the helper as its log plugin. Agent containers publish
no ports; only the gateway publishes one loopback port.

## Stop and clean up

```bash
docker compose -f compose.containerd.yaml down
```

`down` keeps the PostgreSQL and CA volumes. Remove Agent containers, networks and volumes
with the Driver's own lifecycle (retire the revision, then delete the Agent) so ownership
labels are checked; deleting resources by hand bypasses that check.

## Limits

- **Dedicated Codex is not available.** `validateHarnessAuth` accepts only operator-managed
  runtime credentials today, so a dedicated Codex Agent is refused rather than started
  half-configured.
- **No Sandbox Driver.** A Sandbox Driver is a Kubernetes Gateway; selecting one with
  `compute-containerd` is refused.
- **Repository credentials require Kubernetes.** `drivers.repo` composes only with the
  bundled Kubernetes Compute Driver.
- **The controller and worker are host processes.** The Compute Driver's startup preflight
  executes the helper, so a containerised controller cannot compose this Driver at all.
- **Egress is not kernel-enforced.** Isolation is the per-Agent network topology plus the
  egress proxy allowlist. A container that ignores its proxy environment has more latitude
  than a NetworkPolicy allows.

For failures that are not covered here, see
[troubleshooting](../operate/troubleshooting.md).

## Related

- [Rootless containerd Compute Driver](../../reference/drivers/containerd-compute.md)
