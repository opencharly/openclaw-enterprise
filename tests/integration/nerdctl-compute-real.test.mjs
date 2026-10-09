// Opt-in real-runtime proof for the nerdctl Compute Driver. It drives the real helper
// against this host's rootless containerd, so it needs OCC_TEST_NERDCTL_REAL=1, a built
// helper and an imported runtime image. Conformance stays dependency-free in
// tests/conformance/nerdctl-compute.test.mjs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NerdctlComputeDriver } from "../../apps/controller/src/drivers/compute/nerdctl/index.ts";
import {
  egressProxyName,
  networkName,
} from "../../apps/controller/src/drivers/compute/nerdctl/spec.ts";
import { SystemNerdctlHelperExecutor } from "../../apps/controller/src/drivers/compute/nerdctl/executor.ts";

const REAL = process.env.OCC_TEST_NERDCTL_REAL === "1";
const HELPER = process.env.OCC_TEST_NERDCTL_HELPER ?? join(process.cwd(), "bin/compute-nerdctl");
const GATEWAY_IMAGE = process.env.OCC_TEST_NERDCTL_IMAGE ?? "local/oce-gateway:dev";
const NAMESPACE = process.env.OCC_TEST_NERDCTL_NAMESPACE ?? "openclaw-enterprise";
const run = promisify(execFile);

const NAMESPACE_ID = "ns_real_test";
const AGENT_ID = "agt_real_test";
const REVISION_ID = "rev_real_test";

function configuration(credentialsDirectory) {
  return {
    helper: { path: HELPER, timeoutSeconds: 240 },
    containerd: { namespace: NAMESPACE },
    images: { gateway: GATEWAY_IMAGE, agent: GATEWAY_IMAGE, requireImmutableDigest: false },
    credentials: { directory: credentialsDirectory },
    resources: {
      gateway: {
        requests: { cpu: "100m", memory: "1792Mi" },
        limits: { cpu: "4", memory: "3Gi" },
      },
      agent: {
        requests: { cpu: "100m", memory: "512Mi" },
        limits: { cpu: "2", memory: "2Gi" },
      },
      namespace: {
        quota: { "limits.cpu": "8", "limits.memory": "8Gi" },
        containerDefaults: {
          requests: { cpu: "50m", memory: "128Mi" },
          limits: { cpu: "1", memory: "1Gi" },
        },
      },
    },
  };
}

function revision() {
  return {
    id: REVISION_ID,
    namespaceId: NAMESPACE_ID,
    agentId: AGENT_ID,
    revision: 1,
    configurationKind: "agent",
    configurationId: "cfg_real_test",
    configurationGeneration: 1,
    configuration: {
      agents: { defaults: { model: "gpt-6-luna", workspace: "/home/node/.openclaw/workspace" } },
    },
    harness: { id: "openclaw", mode: "embedded", version: "test" },
    compute: { id: "compute-nerdctl", implementation: "occ/nerdctl" },
  };
}

/** Asks the engine itself, rather than the Driver, which planes a container stands on. */
async function planesOf(name) {
  const { stdout } = await run("nerdctl", ["-n", NAMESPACE, "inspect", name]);
  const [container] = JSON.parse(stdout);
  return Object.keys(container.NetworkSettings?.Networks ?? {});
}

function context() {
  // The workspace request is the platform's own projection: the shared setup runtime
  // validates it against a bundled manifest and defaults identifier, so a hand-made
  // payload only proves the runtime's refusal. Workspace seeding is exercised through the
  // platform worker instead; this test proves the runtime path.
  return { harnessAuth: { method: "runtime" }, secretEnvironment: [] };
}

// The engine state this run creates is removed through the Driver's own lifecycle, so the
// ownership checks are exercised on the way out as well as on the way in.
test("the nerdctl Driver delivers a revision on the real rootless engine", async (t) => {
  if (!REAL) {
    t.skip("set OCC_TEST_NERDCTL_REAL=1 to drive the real rootless engine");
    return;
  }
  await access(HELPER).catch(() => {
    throw new Error(`build the helper first (pnpm helper:nerdctl:build): ${HELPER}`);
  });

  const root = await mkdtemp(join(tmpdir(), "oce-nerdctl-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const driver = new NerdctlComputeDriver(configuration(join(root, "credentials")), {
    executor: new SystemNerdctlHelperExecutor(),
  });

  const preflight = await driver.preflight();
  assert.ok(preflight === undefined || Array.isArray(preflight.warnings));
  if (preflight !== undefined) {
    const missing = preflight.warnings.filter((warning) => warning.code === "IMAGE_MISSING");
    assert.equal(missing.length, 0, `the test image must be present: ${GATEWAY_IMAGE}`);
  }

  const namespace = { id: NAMESPACE_ID, name: "Real runtime" };
  // A previous crashed run leaves owned resources behind; the Driver removes them through
  // its own lifecycle rather than the test deleting engine objects by hand.
  await driver
    .deleteAgentRuntimeCredentials({ namespace, agent: { id: AGENT_ID } })
    .catch(() => {});
  await driver.deleteNamespace(namespace).catch(() => {});
  const ensured = await driver.ensureNamespace(namespace);
  assert.equal(ensured.namespaceReady, true, JSON.stringify(ensured));

  const readiness = await driver.prepareRevision(revision(), context());
  assert.equal(readiness.ready, true, JSON.stringify(readiness));

  // The container is the Driver's own: labelled, identified and reporting its image.
  const images = await driver.getRuntimeImages(revision());
  assert.equal(images.length, 1);
  assert.equal(images[0].image, GATEWAY_IMAGE);

  const described = await driver.describeAgentRuntime(revision(), new AbortController().signal);
  assert.equal(described.pods.length, 1);
  assert.equal(described.pods[0].ready, true);

  const logs = await driver.readAgentRuntimeLogs(revision(), {
    source: "gateway",
    pod: described.pods[0].name,
    podUid: described.pods[0].uid,
    container: "gateway",
    previous: false,
    tailLines: 20,
    limitBytes: 8192,
    signal: new AbortController().signal,
  });
  assert.ok(Array.isArray(logs.lines));

  // A published loopback port is what the platform resolves the endpoint from.
  const endpoint = driver.getGatewayEndpoint(revision());
  assert.match(endpoint ?? "", /^ws:\/\/127\.0\.0\.1:\d+\/$/);

  const diagnostics = await driver.diagnoseAgentDeployment(revision());
  assert.ok(diagnostics.checks.length > 0);

  // Retire keeps the Agent's volumes; deleting the Agent releases them and the networks.
  await driver.stopRevision(revision());
  await driver.retireRevision(revision());
  await driver.deleteAgentRuntimeCredentials({ namespace, agent: { id: AGENT_ID } });
  const removed = await driver.deleteNamespace(namespace);
  assert.equal(removed.namespaceDeleted, true, JSON.stringify(removed));
});

// The enforced topology is only as good as its placement, and only the engine can say where a
// container ended up. This case configures an egress proxy and asks the engine directly.
test("an Installation that names a proxy gets one on both of the Agent's planes", async (t) => {
  if (!REAL) {
    t.skip("set OCC_TEST_NERDCTL_REAL=1 to drive the real rootless engine");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "oce-nerdctl-topology-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const driver = new NerdctlComputeDriver(
    {
      ...configuration(join(root, "credentials")),
      // A stand-in proxy image that stays up: the assertion is about placement, and only a
      // running container reports the planes it stands on.
      egress: {
        proxyImage: process.env.OCC_TEST_NERDCTL_PROXY_IMAGE ?? "nginx:alpine",
        allowlist: ["registry.npmjs.org"],
        port: 8080,
      },
    },
    { executor: new SystemNerdctlHelperExecutor() },
  );

  const namespace = { id: NAMESPACE_ID, name: "Enforced topology" };
  // A previous crashed run leaves owned infrastructure behind; the Driver removes it through its
  // own lifecycle, so the placement this case asserts is the one it just created.
  await driver.deleteNamespace(namespace).catch(() => undefined);
  await driver.ensureNamespace(namespace);
  const proxy = egressProxyName(NAMESPACE_ID);
  assert.deepEqual(
    (await planesOf(proxy)).sort(),
    [networkName(NAMESPACE_ID, "edge"), networkName(NAMESPACE_ID, "internal")].sort(),
    "the proxy must stand on the Agent's plane and on the plane that reaches outside",
  );

  // Reconciling again adopts the proxy rather than starting a second one.
  await driver.ensureNamespace(namespace);
  assert.deepEqual((await planesOf(proxy)).length, 2);

  // Deleting the Namespace removes the proxy with it, by label, and nothing else.
  await driver.deleteNamespace(namespace);
  await assert.rejects(() => planesOf(proxy), /No such object|not found/i);
});
