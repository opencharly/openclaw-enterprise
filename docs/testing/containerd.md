# Rootless containerd runtime tests

The [rootless containerd Compute Driver](../reference/drivers/containerd-compute.md)
has three test layers. Run the conformance and startup suites with any
`pnpm test` invocation; they need no engine and no host privileges.

```bash
node --test tests/conformance/containerd-compute.test.mjs
node --test tests/integration/containerd-compute-startup.test.mjs
```

The helper has its own Go suite, which starts no container of its own except in
the opt-in real-engine case:

```bash
pnpm helper:containerd:build
pnpm helper:containerd:test
```

## Real-runtime delivery

`tests/integration/containerd-compute-real.test.mjs` drives the Driver with the real
helper against the rootless engine on this host. It is opt-in because it starts,
stops, and removes containers:

```bash
OCC_TEST_NERDCTL_REAL=1 node --test tests/integration/containerd-compute-real.test.mjs
```

It needs a built helper at `bin/compute-containerd` (`OCC_TEST_NERDCTL_HELPER`
overrides the path) and a runtime image that is present **inside the configured
containerd namespace**, not the default one. Rebuild the helper after any change
to it: a stale binary exercises the old code, and the failure it produces — a
container placed on one network instead of two, for instance — looks like a bug in
the change you just made.

A case that asserts placement must read the engine, and the engine reports the
networks a container stands on only while that container runs. It also adopts an
owned container left by a crashed run, so such a case cleans its Namespace first.

```bash
nerdctl -n openclaw-enterprise load < runtime-image.tar
```

The test asserts preflight, Namespace preparation, revision delivery, runtime
images, description, logs, the resolved endpoint, diagnostics, and the whole
teardown path. It does **not** prove a model turn: a gateway starts only after the
platform's workspace projection has bootstrapped its configuration, so readiness
is verified through the Agent workflow rather than here.

## Capability parity

`pnpm parity:compute` compares the containerd and Kubernetes columns of the
[capability matrix](../reference/drivers/compute-matrix.md), separating the
deviations the matrix records as intentional from the gaps that remain. `--check`
exits non-zero while an undeclared gap exists.

## Platform workflow and OAuth delivery

`tests/integration/containerd-compute-workflow.test.mjs` drives the production worker,
PostgreSQL state and work queue. A helper that owns an engine in a file stands in for containerd,
so the delivery, the staged Codex OAuth handoff, its refusal paths and the Agent lifecycle run
through the platform rather than a direct Driver call. It needs the prepared application lane
from [PostgreSQL](postgresql.md#revision-worker-tests):

```bash
node scripts/ci/prepare.mjs --lane postgres-application \
  --state "$RUN_DIR/state.json" --github-env "$RUN_DIR/owner.env"
node scripts/ci/prepare.mjs --lane postgres-application \
  --file tests/integration/containerd-compute-workflow.test.mjs \
  --state "$RUN_DIR/state.json" --github-env "$RUN_DIR/test.env"
env -u OCC_TEST_DATABASE_URL -u OPENCLAW_ENTERPRISE_CI_STATE -u OPENCLAW_ENTERPRISE_CI_PREFIX \
  OCC_TEST_NERDCTL_REAL=1 \
  node --env-file="$RUN_DIR/test.env" --test tests/integration/containerd-compute-workflow.test.mjs
```

With `OCC_TEST_NERDCTL_REAL=1` the same file also deploys, serves, logs and retires a real Agent
on the rootless engine through the worker. Leave the variable unset to run the platform cases
without an engine; those cases then skip.

### Coverage limits

- A dedicated Codex harness refuses a **synthetic** OAuth login at its own model-authentication
  probe, so the real-engine case seeds and inspects the harness's Codex home but does not reach
  harness readiness. Credentialed readiness needs an authorized login and is not covered here.
- `describeAgentRuntime` cannot report a running container as ready on this engine. The helper
  answers `inspect-container` with nerdctl's status string (`Up`), while the Driver requires
  exactly `ready`, and only the `run-container` response ever carries that value. The Agent
  deployment runtime API therefore reports every containerd runtime, including a gateway that is
  serving, as not ready. The real-runtime case records this as a diagnostic instead of pinning
  the value; the Driver or helper must agree on a probe-backed readiness state.
