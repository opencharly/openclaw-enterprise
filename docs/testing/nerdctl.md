# Rootless nerdctl runtime tests

The [rootless nerdctl Compute Driver](../reference/drivers/nerdctl-compute.md)
has three test layers. Run the conformance and startup suites with any
`pnpm test` invocation; they need no engine and no host privileges.

```bash
node --test tests/conformance/nerdctl-compute.test.mjs
node --test tests/integration/nerdctl-compute-startup.test.mjs
```

The helper has its own Go suite, which starts no container of its own except in
the opt-in real-engine case:

```bash
pnpm helper:nerdctl:build
pnpm helper:nerdctl:test
```

## Real-runtime delivery

`tests/integration/nerdctl-compute-real.test.mjs` drives the Driver with the real
helper against the rootless engine on this host. It is opt-in because it starts,
stops, and removes containers:

```bash
OCC_TEST_NERDCTL_REAL=1 node --test tests/integration/nerdctl-compute-real.test.mjs
```

It needs a built helper at `bin/compute-nerdctl` (`OCC_TEST_NERDCTL_HELPER`
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

`pnpm parity:compute` compares the nerdctl and Kubernetes columns of the
[capability matrix](../reference/drivers/compute-matrix.md), separating the
deviations the matrix records as intentional from the gaps that remain. `--check`
exits non-zero while an undeclared gap exists.
