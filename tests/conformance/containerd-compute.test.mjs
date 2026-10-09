// Conformance for the containerd compute Driver's configuration schema, spec rendering and
// helper executor. The helper process is a stub here; only
// tests/integration/containerd-compute-real.test.mjs drives the real rootless engine.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigurationFailure,
  configurationSchema,
  validateConfiguration,
} from "../../apps/controller/src/drivers/compute/containerd/schema.ts";
import { SystemNerdctlHelperExecutor } from "../../apps/controller/src/drivers/compute/containerd/executor.ts";
import {
  gatewayPasswordPath,
  transportTokenPath,
} from "../../apps/controller/src/drivers/compute/containerd/credentials.ts";
import { ContainerdComputeDriver } from "../../apps/controller/src/drivers/compute/containerd/index.ts";
import { readOAuthLogin } from "../../apps/controller/src/drivers/compute/containerd/oauth.ts";
import { FilesystemSecretDriver } from "../../apps/controller/src/drivers/secret/filesystem/index.ts";
import { egressProxyName } from "../../apps/controller/src/drivers/compute/containerd/spec.ts";
import {
  AGENT_USER,
  CONFIGURATION_HASH_LABEL,
  agentContainerName,
  agentContainerSpec,
  gatewayContainerName,
  networkName,
  ownershipLabels,
  workspaceVolumes,
} from "../../apps/controller/src/drivers/compute/containerd/spec.ts";
import { writeWorkspaceSetupPayload } from "../../apps/controller/src/drivers/compute/containerd/workspace.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
// The Driver owns its Agent credentials as files, so the fixture points at a real, writable
// directory instead of a path that only exists on an operator's host.
const CREDENTIALS = mkdtempSync(join(tmpdir(), "oce-containerd-credentials-"));

function goodConfiguration() {
  return {
    helper: { path: "/usr/local/bin/compute-containerd" },
    containerd: { namespace: "openclaw-enterprise", address: "/run/containerd/containerd.sock" },
    images: {
      gateway: `registry.example/gateway@${DIGEST}`,
      agent: `registry.example/agent@${DIGEST}`,
      requireImmutableDigest: true,
    },
    credentials: { directory: CREDENTIALS },
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

test("the configuration schema is closed and requires the load-bearing sections", () => {
  assert.equal(configurationSchema.type, "object");
  assert.equal(configurationSchema.additionalProperties, false);
  for (const section of ["helper", "containerd", "images", "credentials"]) {
    assert.ok(configurationSchema.required.includes(section), `${section} must be required`);
    assert.equal(configurationSchema.properties[section].additionalProperties, false);
  }
  // An allowlist that could be omitted silently would disable the egress control point.
  assert.ok(configurationSchema.properties.egress.required.includes("allowlist"));
  assert.ok(configurationSchema.properties.egress.required.includes("proxyImage"));
  // The proxy's port is load-bearing: it is what the workloads are told to use.
  assert.ok(configurationSchema.properties.egress.required.includes("port"));
  // The image policy is a decision the operator states, not a default the Driver assumes.
  assert.ok(configurationSchema.properties.images.required.includes("requireImmutableDigest"));
});

test("the image policy decides whether a reference must carry a digest", () => {
  const tagged = {
    ...goodConfiguration(),
    images: {
      gateway: `registry.example/gateway@${DIGEST}`,
      agent: "registry.example/agent:local",
      requireImmutableDigest: true,
    },
  };
  assert.throws(() => validateConfiguration(tagged), /must use an immutable SHA-256 digest/);

  // Outside production a locally built image has no digest to name.
  const relaxed = validateConfiguration({
    ...tagged,
    images: { ...tagged.images, requireImmutableDigest: false },
  });
  assert.equal(relaxed.images.agent, "registry.example/agent:local");
  assert.equal(relaxed.images.requireImmutableDigest, false);

  // The flag itself must be stated.
  const unstated = goodConfiguration();
  delete unstated.images.requireImmutableDigest;
  assert.throws(() => validateConfiguration(unstated), /must be a boolean/);
});

test("a complete configuration yields driver options with the documented default", () => {
  const options = validateConfiguration(goodConfiguration());
  assert.deepEqual(options.resources.agent, { memoryBytes: 2 * 1024 ** 3, cpus: 2 });
  assert.equal(options.helper.path, "/usr/local/bin/compute-containerd");
  assert.equal(options.helper.timeoutSeconds, 180);
  assert.equal(options.containerd.namespace, "openclaw-enterprise");
  assert.equal(options.containerd.address, "/run/containerd/containerd.sock");
  assert.equal(options.egress, undefined);

  const withEgress = validateConfiguration({
    ...goodConfiguration(),
    egress: {
      proxyImage: `registry.example/proxy@${DIGEST}`,
      allowlist: ["registry.npmjs.org"],
      port: 3128,
    },
  });
  assert.deepEqual(withEgress.egress?.allowlist, ["registry.npmjs.org"]);
  // The Installation states limits as Kubernetes quantities; the Driver converts them once.
  assert.deepEqual(withEgress.resources.gateway, { memoryBytes: 3 * 1024 ** 3, cpus: 4 });
  assert.deepEqual(withEgress.resources.namespace.containerDefaults, {
    memoryBytes: 1024 ** 3,
    cpus: 1,
  });
});

test("an incomplete or drifting configuration fails closed", () => {
  const cases = {
    "relative helper path": { helper: { path: "compute-containerd" } },
    "tagged image": {
      images: {
        gateway: "registry.example/gateway:latest",
        agent: `registry.example/agent@${DIGEST}`,
      },
    },
    "empty namespace": { containerd: { namespace: "" } },
    "egress without proxy": { egress: { allowlist: ["registry.npmjs.org"] } },
    "egress without allowlist": { egress: { proxyImage: `registry.example/proxy@${DIGEST}` } },
    "zero timeout": { helper: { path: "/usr/local/bin/compute-containerd", timeoutSeconds: 0 } },
    "unknown section": { sandbox: {} },
  };
  for (const [name, override] of Object.entries(cases)) {
    const document = { ...goodConfiguration(), ...override };
    assert.throws(
      () => validateConfiguration(document),
      ConfigurationFailure,
      `${name} must be refused`,
    );
  }
  assert.throws(() => validateConfiguration(null), ConfigurationFailure);
  assert.throws(() => validateConfiguration({ helper: {} }), ConfigurationFailure);
});

test("network and container names are deterministic and separated by hash", () => {
  const namespaceId = "ns_c12b7210-6daa-48b2-9ec3-4d8179d19631";
  const agentId = "agt_f5ff8e09-29f5-4b9c-abd4-ea227b3b2c0c";
  const revisionId = "rev_8ce6f4e8-3676-44a3-bbfe-0e67a08bc4e3";

  assert.equal(networkName(namespaceId, "internal"), networkName(namespaceId, "internal"));
  assert.notEqual(networkName(namespaceId, "internal"), networkName(namespaceId, "edge"));
  assert.match(networkName(namespaceId, "edge"), /^oce-[0-9a-f]{12}-edge$/);
  assert.match(
    gatewayContainerName(namespaceId, agentId),
    /^oce-[0-9a-f]{12}-gateway-[0-9a-f]{12}$/,
  );

  const ownership = { namespaceId, agentId, revisionId };
  assert.match(agentContainerName(ownership), /^oce-[0-9a-f]{12}-[0-9a-f]{12}-rev-[0-9a-f]{12}$/);
  // A revision-specific name is what keeps two revisions from sharing containers.
  assert.notEqual(
    agentContainerName(ownership),
    agentContainerName({ ...ownership, revisionId: "rev_other" }),
  );
  assert.throws(() => agentContainerName({ namespaceId }), /exact Agent/);
  assert.throws(() => workspaceVolumes({ namespaceId }), /exact Agent/);
});

test("ownership labels carry the driver, role and optional identifiers", () => {
  const ownership = { namespaceId: "ns_1", agentId: "agt_1", revisionId: "rev_1" };
  const labels = ownershipLabels(ownership, "agent");
  assert.equal(labels["org.openclaw.enterprise.managed"], "true");
  assert.equal(labels["org.openclaw.enterprise.compute-driver"], "nerdctl");
  assert.equal(labels["org.openclaw.enterprise.role"], "agent");
  assert.equal(labels["org.openclaw.enterprise.namespace-id"], "ns_1");
  assert.equal(labels["org.openclaw.enterprise.agent-id"], "agt_1");
  assert.equal(labels["org.openclaw.enterprise.revision-id"], "rev_1");

  const namespaceOnly = ownershipLabels({ namespaceId: "ns_1" }, "egress-proxy");
  assert.equal(namespaceOnly["org.openclaw.enterprise.agent-id"], undefined);
  assert.equal(namespaceOnly["org.openclaw.enterprise.revision-id"], undefined);
});

test("the agent container states every hardening constraint the helper is not given elsewhere", () => {
  const ownership = { namespaceId: "ns_1", agentId: "agt_1", revisionId: "rev_1" };
  const volumes = workspaceVolumes(ownership);
  const spec = agentContainerSpec({
    ownership,
    image: `registry.example/agent@${DIGEST}`,
    args: ["node", "-e", "0"],
    env: { CODEX_HOME: "/home/node/.codex" },
    configurationHash: "hash-1",
    limits: { memoryBytes: 134_217_728, cpus: 0.5 },
    readiness: { command: ["node", "-e", "0"], deadlineMs: 120_000 },
  });

  assert.equal(spec.user, AGENT_USER);
  assert.equal(spec.readOnlyRootfs, true);
  assert.deepEqual(spec.capDrop, ["ALL"]);
  assert.equal(spec.noNewPrivileges, true);
  // Writable paths must exist because the root filesystem is read-only.
  assert.ok(spec.tmpfs?.some((entry) => entry.target === "/tmp"));
  // The harness owns its Codex home and shares the workspace; it joins the Agent's plane,
  // which is the same one its gateway uses.
  assert.equal(spec.network, networkName("ns_1", "edge"));
  assert.deepEqual(
    spec.mounts?.map((mount) => mount.target),
    ["/home/node/.codex", "/home/node/workspace"],
  );
  // CODEX_HOME is its own volume: a credential seeded there must stay unreadable to the
  // gateway container, which mounts the OpenClaw state volume instead.
  assert.equal(spec.mounts?.[0]?.volume, volumes.codexHome);
  assert.notEqual(volumes.codexHome, volumes.state);
  assert.equal(spec.mounts?.[1]?.volume, volumes.workspace);
  assert.equal(spec.labels[CONFIGURATION_HASH_LABEL], "hash-1");
  assert.deepEqual(spec.limits, { memoryBytes: 134_217_728, cpus: 0.5 });
  // The credential never becomes a container argument visible in a process list.
  for (const argument of spec.args) {
    assert.ok(!argument.includes("token"), "arguments must not carry credentials");
  }
});

async function stubHelper(source) {
  const directory = await mkdtemp(join(tmpdir(), "containerd-conformance-"));
  const path = join(directory, "helper.sh");
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
  return { path, directory };
}

test("the system executor sends one envelope and reads one response", async () => {
  // The stub echoes the envelope it received so the test can assert the wire format.
  const helper = await stubHelper(
    '#!/bin/sh\nbody=$(cat)\nprintf \'{"ok":true,"output":%s}\\n\' "$body"\n',
  );
  try {
    const executor = new SystemNerdctlHelperExecutor();
    const result = await executor.invoke({
      helperPath: helper.path,
      engine: { namespace: "default", namespaceName: "default" },
      request: { operation: "preflight", input: { images: [] }, deadlineMs: 1000 },
      timeoutMs: 5000,
    });
    assert.equal(result.ok, true);
    const echoed = result.output;
    assert.equal(echoed.version, 1);
    assert.equal(echoed.operation, "preflight");
    assert.deepEqual(echoed.engine, { namespace: "default", namespaceName: "default" });
    assert.deepEqual(echoed.input, { images: [] });
    assert.equal(echoed.deadlineMs, 1000);
  } finally {
    await rm(helper.directory, { recursive: true, force: true });
  }
});

test("a helper failure envelope is reported, not thrown", async () => {
  const helper = await stubHelper(
    '#!/bin/sh\ncat >/dev/null\nprintf \'{"ok":false,"error":{"code":"OWNERSHIP","message":"mismatch","retryable":false}}\\n\'\n',
  );
  try {
    const executor = new SystemNerdctlHelperExecutor();
    const result = await executor.invoke({
      helperPath: helper.path,
      engine: { namespace: "default", namespaceName: "default" },
      request: { operation: "remove-container" },
      timeoutMs: 5000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "OWNERSHIP");
    assert.equal(result.error?.retryable, false);
  } finally {
    await rm(helper.directory, { recursive: true, force: true });
  }
});

test("a helper that answers nothing fails the call instead of hanging", async () => {
  const helper = await stubHelper("#!/bin/sh\ncat >/dev/null\nexit 3\n");
  try {
    const executor = new SystemNerdctlHelperExecutor();
    await assert.rejects(
      executor.invoke({
        helperPath: helper.path,
        engine: { namespace: "default", namespaceName: "default" },
        request: { operation: "preflight" },
        timeoutMs: 5000,
      }),
      /no response/,
    );
  } finally {
    await rm(helper.directory, { recursive: true, force: true });
  }
});

test("an exceeding call is aborted rather than left running", async () => {
  const helper = await stubHelper("#!/bin/sh\ncat >/dev/null\nsleep 30\n");
  try {
    const executor = new SystemNerdctlHelperExecutor();
    await assert.rejects(
      executor.invoke({
        helperPath: helper.path,
        engine: { namespace: "default", namespaceName: "default" },
        request: { operation: "preflight" },
        timeoutMs: 500,
      }),
      /aborted or timed out/,
    );
  } finally {
    await rm(helper.directory, { recursive: true, force: true });
  }
});

/** Records every helper call and answers from a per-operation table. */
class RecordingExecutor {
  constructor(responses = {}) {
    this.calls = [];
    this.responses = {
      // A real helper answers an ensure-* call with the labels it stored, which is what
      // the ownership guards read back.
      "ensure-volume": (call) => ({
        ok: true,
        output: { created: true, labels: call.request.input.labels },
      }),
      "ensure-network": (call) => ({
        ok: true,
        output: { created: true, labels: call.request.input.labels },
      }),
      ...responses,
    };
  }

  async invoke(call) {
    this.calls.push(call);
    // The workspace initializer is created and removed inside one delivery, so it is absent
    // whenever a test describes the runtime container. A test that needs a leftover
    // initializer supplies "inspect-container-setup".
    if (
      call.request.operation === "inspect-container" &&
      String(call.request.input.name ?? "").endsWith("-setup") &&
      this.responses["inspect-container-setup"] === undefined
    ) {
      return { ok: true, output: { exists: false } };
    }
    const respond = this.responses[call.request.operation];
    if (respond === undefined) {
      return { ok: true, output: {} };
    }
    return typeof respond === "function" ? respond(call) : respond;
  }

  operations() {
    return this.calls.map((call) => call.request.operation);
  }
}

async function configurationHashOf() {
  const { createHash } = await import("node:crypto");
  const { gatewayConfigurationDocument } =
    await import("../../apps/controller/src/drivers/compute/containerd/gateway-configuration.ts");
  // The runtime is configured with the derived gateway document, and the immutable label
  // hashes exactly what the container received.
  const document = gatewayConfigurationDocument(revision().configuration);
  return createHash("sha256")
    .update(JSON.stringify(document.configuration))
    .digest("hex")
    .slice(0, 32);
}

function driverWith(executor, overrides = {}, selection = {}) {
  return new ContainerdComputeDriver(
    validateConfiguration({ ...goodConfiguration(), ...overrides }),
    {
      executor,
      ...selection,
    },
  );
}

const NAMESPACE = { id: "ns_1", name: "team-a" };

test("the driver declares the capabilities the platform relies on", () => {
  const driver = driverWith(new RecordingExecutor());
  assert.equal(driver.id, "compute-containerd");
  assert.equal(driver.implementation, "occ/containerd");
  assert.equal(driver.capability, "compute");
  assert.equal(driver.supportsWorkspaceSetup, true);
  assert.equal(driver.runtimeLogging, "driver");
  // The predecessor keeps serving until this revision is verified.
  assert.equal(driver.activationOrder, "beforeCommit");
  assert.equal(driver.requiresStoppedPredecessors(), true);
});

test("ensureNamespace prepares both planes and never leaks a created network", async () => {
  const executor = new RecordingExecutor();
  const result = await driverWith(executor).ensureNamespace(NAMESPACE);
  assert.equal(result.namespaceReady, true);
  assert.equal(result.namespaceId, "ns_1");
  assert.deepEqual(executor.operations(), ["ensure-network", "ensure-network"]);

  const [internal, edge] = executor.calls.map((call) => call.request.input);
  assert.equal(internal.internal, true, "the Agent plane must not reach the edge");
  assert.equal(edge.internal, false);
  assert.match(internal.name, /-internal$/);
  assert.match(edge.name, /-edge$/);
  assert.notEqual(internal.name, edge.name);

  for (const call of executor.calls) {
    assert.equal(call.engine.namespace, "openclaw-enterprise");
    assert.equal(call.engine.namespaceName, "openclaw-enterprise");
    assert.equal(call.request.input.labels["org.openclaw.enterprise.managed"], "true");
    assert.equal(call.request.input.labels["org.openclaw.enterprise.compute-driver"], "nerdctl");
    assert.equal(call.request.input.labels["org.openclaw.enterprise.namespace-id"], "ns_1");
  }
  // Each plane is independently identifiable, so deletion can prove ownership of both.
  assert.equal(internal.labels["org.openclaw.enterprise.role"], "network-internal");
  assert.equal(edge.labels["org.openclaw.enterprise.role"], "network-edge");
});

test("a refused plane rolls back with the labels it was created under", async () => {
  const executor = new RecordingExecutor({
    "ensure-network": (call) =>
      call.request.input.name.endsWith("-edge")
        ? { ok: false, error: { code: "OWNERSHIP", message: "mismatch", retryable: false } }
        : { ok: true, output: { created: true } },
  });
  const result = await driverWith(executor).ensureNamespace(NAMESPACE);
  assert.equal(result.namespaceReady, false);
  assert.equal(result.failure, "permanent");

  const removal = executor.calls.find((call) => call.request.operation === "remove-network");
  assert.ok(removal, "a created network must be rolled back");
  // The rollback labels must match creation, or the helper refuses and the network leaks.
  assert.equal(
    removal.request.input.expectLabels["org.openclaw.enterprise.role"],
    "network-internal",
  );
  assert.match(removal.request.input.name, /-internal$/);
});

test("deleteNamespace removes containers before volumes before networks", async () => {
  const executor = new RecordingExecutor({
    "list-containers": {
      ok: true,
      output: { names: ["oce-agent-a", "oce-agent-b"], labels: {} },
    },
  });
  const result = await driverWith(executor).deleteNamespace(NAMESPACE);
  assert.equal(result.namespaceDeleted, true);

  assert.deepEqual(executor.operations(), [
    "list-containers",
    "remove-container",
    "remove-container",
    "remove-volumes",
    "remove-network",
    "remove-network",
  ]);
  // Deletion of a network that still has endpoints, or a volume still held open, fails.
  const order = executor.operations();
  assert.ok(order.indexOf("remove-volumes") > order.lastIndexOf("remove-container"));
  assert.ok(order.indexOf("remove-network") > order.indexOf("remove-volumes"));

  for (const call of executor.calls.filter(
    (entry) => entry.request.operation === "remove-container",
  )) {
    assert.equal(call.request.input.expectLabels["org.openclaw.enterprise.namespace-id"], "ns_1");
  }
  const planes = executor.calls
    .filter((call) => call.request.operation === "remove-network")
    .map((call) => call.request.input.expectLabels["org.openclaw.enterprise.role"]);
  assert.deepEqual(planes, ["network-edge", "network-internal"]);
});

test("deleteNamespace reports a failure instead of claiming deletion", async () => {
  const executor = new RecordingExecutor({
    "remove-volumes": {
      ok: false,
      error: { code: "CONFLICT", message: "in use", retryable: false },
    },
  });
  const result = await driverWith(executor).deleteNamespace(NAMESPACE);
  assert.equal(result.namespaceDeleted, false);
  assert.equal(result.failure, "permanent");
});

test("harness auth admits runtime, a dedicated Codex login or provider key, and nothing else", () => {
  const driver = driverWith(new RecordingExecutor());
  const embedded = { id: "openclaw", mode: "embedded" };
  driver.validateHarnessAuth(embedded, { method: "runtime" }, {}, undefined, undefined);

  // A provider key needs a dedicated Codex harness, the Secret Driver's store to read it from,
  // and a model the OpenAI key can authenticate. `codex_pat` stays refused: a Backend-issued
  // account token still has no delivery path to exactly one container on this engine.
  const openai = { agents: { defaults: { model: "openai/gpt-5.6-luna" } } };
  const keyed = driverWith(
    new RecordingExecutor(),
    {},
    { secretStore: { directory: "/var/lib/oce/secrets" } },
  );
  keyed.validateHarnessAuth(
    { id: "codex", mode: "dedicated" },
    { method: "api_key", source: {}, secretDriverId: "occ/filesystem-secret" },
    openai,
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        embedded,
        { method: "api_key", source: {}, secretDriverId: "occ/filesystem-secret" },
        openai,
      ),
    /dedicated Codex harness/,
    "an embedded OpenClaw gateway has no harness container to receive a model key",
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        { id: "codex", mode: "dedicated" },
        { method: "api_key", source: {}, secretDriverId: "occ/filesystem-secret" },
        openai,
      ),
    /requires the selected Secret Driver's store/,
    "the key lives in Secret storage this Driver must be able to read",
  );
  assert.throws(
    () =>
      keyed.validateHarnessAuth(
        { id: "codex", mode: "dedicated" },
        { method: "api_key", source: {}, secretDriverId: "occ/filesystem-secret" },
        { agents: { defaults: { model: "anthropic/claude-sonnet-5" } } },
      ),
    /openai/,
    "another provider's model would be handed the wrong credential",
  );
  assert.throws(
    () =>
      keyed.validateHarnessAuth(
        { id: "codex", mode: "dedicated" },
        { method: "codex_pat", source: {}, secretDriverId: "occ/filesystem-secret" },
        openai,
      ),
    /runtime credentials/,
    "codex_pat must stay refused while its account-token delivery is unbuilt",
  );
  assert.throws(
    () =>
      keyed.validateHarnessAuth(
        { id: "codex", mode: "embedded" },
        { method: "api_key", source: {}, secretDriverId: "occ/filesystem-secret" },
        openai,
      ),
    /always dedicated/,
  );
  // OAuth is a dedicated Codex path only, and it needs the Secret Driver's store to read the
  // staged login from. Both refusals happen before the platform admits the revision.
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        embedded,
        { method: "oauth", source: {}, secretDriverId: "occ/kubernetes-secret" },
        {},
        undefined,
        undefined,
      ),
    /OAuth requires a dedicated Codex harness/,
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        { id: "codex", mode: "dedicated" },
        { method: "oauth", source: {}, secretDriverId: "occ/kubernetes-secret" },
        {},
        undefined,
        undefined,
      ),
    /requires the selected Secret Driver's store/,
  );
  driverWith(
    new RecordingExecutor(),
    {},
    { secretStore: { directory: "/var/lib/oce/secrets" } },
  ).validateHarnessAuth(
    { id: "codex", mode: "dedicated" },
    { method: "oauth", source: {}, secretDriverId: "occ/filesystem-secret" },
    {},
    undefined,
    undefined,
  );
  // A dedicated Codex harness is a container of its own, and one token covers both roles.
  driver.validateHarnessAuth({ id: "codex", mode: "dedicated" }, { method: "runtime" }, {});
  assert.throws(
    () =>
      driver.validateHarnessAuth({ id: "openclaw", mode: "dedicated" }, { method: "runtime" }, {}),
    /embedded in its own gateway/,
  );
  assert.throws(
    () => driver.validateHarnessAuth({ id: "codex", mode: "embedded" }, { method: "runtime" }, {}),
    /always dedicated/,
  );
});

test("a dedicated harness is delivered beside its gateway and holds the workload credential", async () => {
  const executor = new RecordingExecutor({
    "inspect-container": { ok: true, output: { exists: false } },
    "run-to-completion": { ok: true, output: { running: false, exitCode: 0 } },
    "list-containers": listing([]),
  });
  const directory = join(CREDENTIALS, "dedicated");
  // The platform hands a workload its resolved environment through a lifecycle owner, which is
  // the supported path for a credential this Driver never sees as a value.
  const modelCredential = {
    id: "model-credential-owner",
    capability: "configuration",
    implementation: "local-selected",
    computeLifecycleHooks: {
      beforeWorkloadStart(revision, launch) {
        // A lifecycle owner contributes an opaque placeholder, never a credential value: the
        // platform keeps the value and the runtime resolves the placeholder itself.
        launch.environment.OPENAI_API_KEY = "opaque-model-credential";
      },
    },
  };
  const readiness = await driverWith(
    executor,
    { credentials: { directory } },
    { lifecycleDrivers: [modelCredential] },
  ).prepareRevision(dedicatedRevision(), {
    harnessAuth: { method: "runtime" },
    secretEnvironment: [],
  });
  assert.equal(readiness.ready, true);

  const runs = executor.calls.filter((call) => call.request.operation === "run-container");
  assert.equal(runs.length, 2, "a dedicated revision runs a harness and a gateway");
  // Identified by the role label the Driver owns, not by a name shape the test would pin.
  const harness = runs.find(
    (call) => call.request.input.labels["org.openclaw.enterprise.role"] === "agent",
  );
  const gateway = runs.find(
    (call) => call.request.input.labels["org.openclaw.enterprise.role"] === "gateway",
  );
  assert.ok(harness, "the harness container must be created");
  assert.ok(gateway, "the gateway container must be created");

  // The harness waits for the gateway's clients, and the gateway reaches the harness by name.
  const token = harness.request.input.env.APP_SERVER_TOKEN;
  assert.equal(gateway.request.input.env.APP_SERVER_TOKEN, token);
  assert.match(gateway.request.input.env.APP_SERVER_URL, /^ws:\/\/.+:18790$/);
  assert.equal(harness.request.input.env.APP_SERVER_PORT, "18790");
  assert.equal(harness.request.input.env.CODEX_HOME, "/home/node/.codex");

  // The credential split is the point of a dedicated harness: the model credential is the
  // harness's alone, and the gateway holds only the transport token.
  assert.equal(harness.request.input.env.OPENAI_API_KEY, "opaque-model-credential");
  assert.equal(gateway.request.input.env.OPENAI_API_KEY, undefined);
  assert.equal(gateway.request.input.env.APP_SERVER_TOKEN, token);

  // Two containers, one persisted token: both roles present the same value after a restart.
  assert.equal(
    await readFile(
      transportTokenPath(directory, { namespaceId: "ns_1", agentId: "agt_1" }),
      "utf8",
    ),
    `${token}\n`,
  );
});

function revision(overrides = {}) {
  return {
    id: "rev_1",
    namespaceId: "ns_1",
    agentId: "agt_1",
    revision: 1,
    configurationKind: "agent",
    configurationId: "cfg_1",
    configurationGeneration: 1,
    configuration: { agents: { defaults: { model: "gpt-6-luna" } } },
    harness: { id: "openclaw", mode: "embedded", version: "1.2.3" },
    compute: { id: "compute-containerd", implementation: "occ/containerd" },
    ...overrides,
  };
}

/** The same revision, running its harness in a container of its own. */
function dedicatedRevision(overrides = {}) {
  return revision({
    harness: { id: "codex", mode: "dedicated", version: "1.2.3" },
    ...overrides,
  });
}

test("prepareRevision delivers the runtime and reports readiness", async () => {
  const executor = new RecordingExecutor();
  const readiness = await driverWith(executor).prepareRevision(revision());

  assert.equal(readiness.ready, true);
  assert.equal(readiness.revisionId, "rev_1");
  const operations = executor.operations();
  // The tenant budget is decided before anything is created, so the listing comes first.
  assert.deepEqual(operations.slice(0, 5), [
    "list-containers",
    "ensure-network",
    "ensure-network",
    "ensure-volume",
    "ensure-volume",
  ]);
  // Storage is prepared — and its ownership handed over — before the runtime starts.
  assert.ok(operations.includes("run-to-completion"));
  assert.ok(operations.indexOf("run-to-completion") < operations.indexOf("run-container"));
  assert.ok(operations.includes("remove-container"), "the initializer is not left behind");

  const volumes = executor.calls
    .filter((call) => call.request.operation === "ensure-volume")
    .map((call) => call.request.input.name);
  assert.equal(volumes.length, 2);
  assert.notEqual(volumes[0], volumes[1]);

  const run = executor.calls.find((call) => call.request.operation === "run-container");
  assert.equal(run.request.input.image, `registry.example/gateway@${DIGEST}`);
  assert.equal(run.request.input.user, "1000:1000");
  assert.equal(run.request.input.readOnlyRootfs, true);
  assert.deepEqual(run.request.input.capDrop, ["ALL"]);
  // The configuration travels in the environment, so no host file is mounted.
  assert.equal(run.request.input.env.OPENCLAW_CONFIG_PATH, "/home/node/.openclaw/openclaw.json");
  assert.equal(run.request.input.env.HOME, "/home/node");
  // The runtime program is shared with the Docker driver and must be run by Node; the
  // image's own entrypoint would treat a bare argument as a module path.
  assert.deepEqual(run.request.input.entrypoint, ["node"]);
  assert.equal(run.request.input.args[0], "-e");
  assert.match(run.request.input.args[1], /openclaw/i);
  // A gateway document without native auth gets a managed password in the environment,
  // never a literal password in the document itself.
  const document = JSON.parse(run.request.input.env.OPENCLAW_CONFIG_JSON);
  assert.equal(document.gateway.auth.mode, "password");
  assert.match(document.gateway.auth.password, /^\$\{OPENCLAW_GATEWAY_PASSWORD\}$/);
  assert.match(run.request.input.env.OPENCLAW_GATEWAY_PASSWORD, /^[0-9a-f]{64}$/);
  assert.ok(document.agents.defaults.model === "gpt-6-luna");
  // The gateway publishes exactly one loopback port, and readiness is judged in-container.
  assert.equal(run.request.input.publish.length, 1);
  assert.equal(run.request.input.publish[0].hostIp, "127.0.0.1");
  assert.equal(run.request.input.publish[0].containerPort, 8080);
  assert.ok(run.request.input.publish[0].hostPort > 0);
  assert.match(run.request.input.readiness.command.join(" "), /readyz/);
  assert.equal(run.request.input.labels["org.openclaw.enterprise.role"], "gateway");
  assert.equal(run.request.input.labels["org.openclaw.enterprise.revision-id"], "rev_1");
  assert.ok(run.request.deadlineMs > 0);
});

test("a revision this Driver does not own is never reported ready", async () => {
  const executor = new RecordingExecutor();
  const readiness = await driverWith(executor).prepareRevision(
    revision({ compute: { id: "compute-docker-development", implementation: "docker-local" } }),
  );
  assert.equal(readiness.ready, false);
  assert.deepEqual(executor.operations(), [], "an unowned revision must not touch the engine");
});

test("a newer revision keeps the gateway until it is retired", async () => {
  const executor = new RecordingExecutor({
    "inspect-container": {
      ok: true,
      output: {
        exists: true,
        running: true,
        labels: {
          "org.openclaw.enterprise.managed": "true",
          "org.openclaw.enterprise.compute-driver": "nerdctl",
          "org.openclaw.enterprise.namespace-id": "ns_1",
          "org.openclaw.enterprise.agent-id": "agt_1",
          "org.openclaw.enterprise.revision-id": "rev_9",
          "org.openclaw.enterprise.revision-number": "9",
        },
      },
    },
  });
  const readiness = await driverWith(executor).prepareRevision(revision());
  assert.equal(readiness.ready, false);
  assert.ok(
    !executor.operations().includes("run-container"),
    "a serving revision must not be displaced by an older one",
  );
  // The initializer removes itself; the running gateway must survive a newer revision.
  assert.ok(
    !executor.calls.some(
      (call) =>
        call.request.operation === "remove-container" &&
        !String(call.request.input.name).endsWith("-setup"),
    ),
    "a newer revision must not remove the running gateway",
  );
});

test("a healthy gateway is reused and its endpoint recovered from the binding", async () => {
  const executor = new RecordingExecutor({
    "inspect-container": {
      ok: true,
      output: {
        exists: true,
        running: true,
        ports: { published: "127.0.0.1:18099->8080/tcp" },
        labels: {
          "org.openclaw.enterprise.managed": "true",
          "org.openclaw.enterprise.compute-driver": "nerdctl",
          "org.openclaw.enterprise.namespace-id": "ns_1",
          "org.openclaw.enterprise.agent-id": "agt_1",
          "org.openclaw.enterprise.revision-id": "rev_1",
          "org.openclaw.enterprise.revision-number": "1",
          "org.openclaw.enterprise.configuration-hash": await configurationHashOf(),
        },
      },
    },
  });
  const driver = driverWith(executor);
  const readiness = await driver.prepareRevision(revision());
  assert.equal(readiness.ready, true);
  assert.ok(!executor.operations().includes("run-container"), "a healthy gateway is reused");
  // Without a readable binding the platform would advertise an unreachable endpoint.
  assert.equal(driver.getGatewayEndpoint(revision()), "ws://127.0.0.1:18099/");
});

test("an immutable revision cannot silently change its configuration", async () => {
  const executor = new RecordingExecutor({
    "inspect-container": {
      ok: true,
      output: {
        exists: true,
        running: true,
        labels: {
          "org.openclaw.enterprise.managed": "true",
          "org.openclaw.enterprise.compute-driver": "nerdctl",
          "org.openclaw.enterprise.namespace-id": "ns_1",
          "org.openclaw.enterprise.agent-id": "agt_1",
          "org.openclaw.enterprise.revision-id": "rev_1",
          "org.openclaw.enterprise.revision-number": "1",
          "org.openclaw.enterprise.configuration-hash": "stale",
        },
      },
    },
  });
  await assert.rejects(
    driverWith(executor).prepareRevision(revision()),
    /configuration cannot change/,
  );
});

function workspaceContext(overrides = {}) {
  return {
    harnessAuth: { method: "runtime" },
    secretEnvironment: [],
    workspaceSetup: {
      // The shared setup runtime reads a map of file name to content, an identity and a
      // completion flag; a first preparation must carry at least one file.
      id: "ns_1/agt_1",
      namespaceId: "ns_1",
      agentId: "agt_1",
      completed: false,
      files: { "AGENTS.md": "payload-token-xyz" },
    },
    ...overrides,
  };
}

test("workspace setup seeds the volumes in a network-less initializer", async () => {
  const executor = new RecordingExecutor({
    "run-to-completion": { ok: true, output: { running: false, exitCode: 0 } },
  });
  const driver = driverWith(executor);
  const readiness = await driver.prepareRevision(revision(), workspaceContext());
  assert.equal(readiness.ready, true);

  const setup = executor.calls.find((call) => call.request.operation === "run-to-completion");
  assert.ok(setup, "workspace setup must run before the runtime starts");
  assert.equal(setup.request.input.network, "none", "the initializer needs no network");
  assert.equal(setup.request.input.user, "0:0");
  assert.deepEqual(setup.request.input.capDrop, ["ALL"]);
  assert.deepEqual(setup.request.input.capAdd, ["CHOWN", "SETUID", "SETGID", "FOWNER"]);
  assert.equal(setup.request.input.noNewPrivileges, true);
  assert.equal(
    setup.request.input.env.OPENCLAW_WORKSPACE_SETUP_PATH,
    "/run/oce/workspace-setup.json",
  );
  assert.deepEqual(
    setup.request.input.mounts.map((mount) => mount.target),
    ["/home/node/.openclaw", "/home/node/workspace", "/run/oce"],
  );
  const payload = setup.request.input.mounts[2];
  assert.equal(payload.readOnly, true);
  // A unique owner-only directory from mkdtemp: the path is unpredictable, so nothing can
  // pre-create or swap the payload, and the initializer opens it before dropping privileges.
  assert.match(payload.source, /\/oce-containerd-setup-[A-Za-z0-9]{6}$/);
  const setupScript = setup.request.input.args[1];
  assert.ok(
    setupScript.includes("O_NOFOLLOW") && setupScript.includes("OPENCLAW_WORKSPACE_SETUP_FD"),
    "the initializer opens the owner-only payload as root and hands the dropped user its descriptor",
  );
  // A rootless engine cannot copy into a stopped container, so nothing is copied at all.
  assert.equal(setup.request.input.files, undefined);
  assert.equal(setup.request.input.filesAfterStart, undefined);
  assert.ok(
    !JSON.stringify(setup.request.input.args).includes("payload-token-xyz"),
    "the payload stays out of argv",
  );
  assert.ok(
    !JSON.stringify(setup.request.input.env).includes("payload-token-xyz"),
    "the payload stays out of the environment",
  );

  // The initializer script is generated source: the ownership handoff must happen for every
  // delivery, and seeding only when the Driver mounted a request.
  const script = setup.request.input.args[1];
  assert.match(script, /chownSync\(path, 1000, 1000\)/);
  assert.match(script, /chmodSync\(path, 0o700\)/);
  assert.ok(
    script.includes("OPENCLAW_WORKSPACE_SETUP_PATH"),
    "the payload path is read from the environment",
  );
  assert.ok(
    !script.includes("WORKSPACE_SETUP_PAYLOAD_TIMEOUT_MS"),
    "the script must not name a TypeScript constant",
  );
  assert.deepEqual(setup.request.input.entrypoint, ["node"]);

  // The initializer is always removed, whatever it reported.
  const removed = executor.calls.filter(
    (call) =>
      call.request.operation === "remove-container" && call.request.input.name.endsWith("-setup"),
  );
  assert.equal(removed.length, 1);
});

test("a failing initializer is removed and the revision is not ready", async () => {
  const executor = new RecordingExecutor({
    "run-to-completion": { ok: true, output: { running: false, exitCode: 3 } },
  });
  await assert.rejects(
    driverWith(executor).prepareRevision(revision(), workspaceContext()),
    /Workspace initialization failed/,
  );
  assert.ok(
    executor.operations().includes("remove-container"),
    "a failed initializer must not be left behind",
  );
  assert.ok(!executor.operations().includes("run-container"), "the runtime must not start");
});

test("delivery hands storage to the workload user even without a workspace projection", async () => {
  const executor = new RecordingExecutor({
    "run-to-completion": { ok: true, output: { running: false, exitCode: 0 } },
  });
  const readiness = await driverWith(executor).prepareRevision(revision(), {
    harnessAuth: { method: "runtime" },
    secretEnvironment: [],
  });
  assert.equal(readiness.ready, true);

  // A revision whose storage is not writable by the workload user fails inside its runtime,
  // so the handoff happens whether or not the platform seeded a workspace.
  const setup = executor.calls.find((call) => call.request.operation === "run-to-completion");
  assert.ok(setup, "storage preparation must run for every delivery");
  assert.deepEqual(
    setup.request.input.mounts.map((mount) => mount.target),
    ["/home/node/.openclaw", "/home/node/workspace"],
  );
  // Nothing is mounted and no payload path is published when there is nothing to seed.
  assert.equal(setup.request.input.env.OPENCLAW_WORKSPACE_SETUP_PATH, undefined);
  assert.ok(!setup.request.input.mounts.some((mount) => mount.source !== undefined));
});

const GIB = 1024 ** 3;

/** A Namespace already holding containers, as the helper reports them. */
function listing(entries) {
  return {
    ok: true,
    output: {
      names: entries.map((entry) => entry.name),
      labels: Object.fromEntries(entries.map((entry) => [entry.name, entry.labels])),
    },
  };
}

test("a delivery that would exceed the tenant budget is refused before anything is created", async () => {
  const executor = new RecordingExecutor({
    "list-containers": listing([
      {
        name: "oce-aaa-gateway",
        labels: {
          "org.openclaw.enterprise.limit-cpus": "8",
          "org.openclaw.enterprise.limit-memory-bytes": "1",
        },
      },
    ]),
    "run-to-completion": { ok: true, output: { running: false, exitCode: 0 } },
  });
  // The Installation declares a budget of 8 CPUs; the Namespace already holds all of it.
  await assert.rejects(
    driverWith(executor).prepareRevision(revision(), workspaceContext()),
    /Namespace budget of 8 CPUs/,
  );
  assert.ok(!executor.operations().includes("run-container"), "nothing may start");
  assert.ok(!executor.operations().includes("ensure-volume"), "nothing may be created");
});

test("a delivery fits the tenant budget and records what it took", async () => {
  const executor = new RecordingExecutor({
    "list-containers": listing([
      {
        name: "oce-aaa-gateway",
        labels: {
          "org.openclaw.enterprise.limit-cpus": "1",
          "org.openclaw.enterprise.limit-memory-bytes": String(GIB),
        },
      },
      // This revision's own container is replaced, not added, so it is not charged twice.
      {
        name: "oce-bbb-gateway",
        labels: {
          "org.openclaw.enterprise.revision-id": "rev_1",
          "org.openclaw.enterprise.limit-cpus": "8",
          "org.openclaw.enterprise.limit-memory-bytes": String(8 * GIB),
        },
      },
    ]),
    "run-to-completion": { ok: true, output: { running: false, exitCode: 0 } },
  });
  const readiness = await driverWith(executor).prepareRevision(revision(), workspaceContext());
  assert.equal(readiness.ready, true);

  // A later admission check reads these labels instead of asking the engine to re-report limits.
  const gateway = executor.calls.find((call) => call.request.operation === "run-container");
  assert.equal(gateway.request.input.labels["org.openclaw.enterprise.limit-cpus"], "4");
  assert.equal(
    gateway.request.input.labels["org.openclaw.enterprise.limit-memory-bytes"],
    String(3 * GIB),
  );
});

test("an Installation that names an egress proxy gets the enforced topology", async () => {
  const executor = new RecordingExecutor({
    "list-containers": listing([]),
    "run-to-completion": { ok: true, output: { running: false, exitCode: 0 } },
    "run-container": () => ({
      ok: true,
      output: { running: true, ports: { "8080/tcp": "127.0.0.1:18099" } },
    }),
  });
  const driver = driverWith(executor, {
    egress: {
      proxyImage: `registry.example/proxy@${DIGEST}`,
      allowlist: ["registry.npmjs.org"],
      port: 3128,
    },
  });
  await driver.ensureNamespace(NAMESPACE);
  await driver.prepareRevision(revision(), workspaceContext());

  // The proxy stands on the Agent's plane and on the plane that reaches outside, so the workloads'
  // only route out is through it.
  const proxy = executor.calls.find(
    (call) => call.request.input.labels?.["org.openclaw.enterprise.role"] === "egress-proxy",
  );
  assert.ok(proxy, "the Namespace must have an egress proxy");
  assert.deepEqual(proxy.request.input.networks, [
    networkName("ns_1", "internal"),
    networkName("ns_1", "edge"),
  ]);
  assert.equal(proxy.request.input.env.EGRESS_ALLOWLIST, "registry.npmjs.org");

  // Both workloads stand on the no-egress plane alone and are told to use the proxy.
  const runs = executor.calls.filter((call) => call.request.operation === "run-container");
  const gateway = runs.find(
    (call) => call.request.input.labels?.["org.openclaw.enterprise.role"] === "gateway",
  );
  assert.deepEqual(gateway.request.input.networks, [networkName("ns_1", "internal")]);
  assert.equal(gateway.request.input.env.HTTP_PROXY, `http://${egressProxyName("ns_1")}:3128`);
  assert.equal(gateway.request.input.publish, undefined, "the gateway cannot publish from it");

  // A relay on both planes publishes the gateway's port, and it is the endpoint the platform sees.
  const relay = runs.find(
    (call) => call.request.input.labels?.["org.openclaw.enterprise.role"] === "relay",
  );
  assert.ok(relay, "a gateway behind the no-egress plane needs a relay");
  assert.deepEqual(relay.request.input.networks, [
    networkName("ns_1", "internal"),
    networkName("ns_1", "edge"),
  ]);
  assert.equal(
    relay.request.input.env.RELAY_TARGET,
    `${gatewayContainerName("ns_1", "agt_1")}:8080`,
  );
  assert.match(driver.getGatewayEndpoint(revision()), /^ws:\/\/127\.0\.0\.1:\d+\/$/);
});

test("deleting an Agent removes its containers before its storage", async () => {
  // A volume cannot be removed while a container holds it. Deleting the Agent's storage first made
  // the platform retry until it gave up, leaving the Agent stuck in `deleting` forever, so the
  // Agent's containers go first and the order is what this case protects.
  const executor = new RecordingExecutor({
    "list-containers": { ok: true, output: { names: ["oce-x-gateway-y"] } },
    "inspect-container": {
      ok: true,
      output: {
        exists: true,
        running: true,
        containerId: "c1",
        labels: {
          "org.openclaw.enterprise.managed": "true",
          "org.openclaw.enterprise.compute-driver": "nerdctl",
          "org.openclaw.enterprise.namespace-id": "ns_1",
          "org.openclaw.enterprise.agent-id": "agt_1",
        },
      },
    },
    "remove-volumes": { ok: true, output: { removed: [] } },
  });
  await driverWith(executor).deleteAgentRuntimeCredentials({
    namespace: { id: "ns_1" },
    agent: { id: "agt_1" },
  });
  const operations = executor.operations();
  const removedContainer = operations.indexOf("remove-container");
  const removedVolumes = operations.indexOf("remove-volumes");
  assert.notEqual(removedContainer, -1, "the Agent's containers are removed");
  assert.notEqual(removedVolumes, -1, "the Agent's volumes are removed");
  assert.ok(removedContainer < removedVolumes, "a volume is only removed once nothing holds it");
});

test("a predecessor's stop leaves its successor's gateway alone", async () => {
  // The gateway container is one per Agent and serves whichever revision is active. A predecessor
  // being stopped or retired must not take the successor's gateway down with it, so a gateway
  // labelled with another revision is left running.
  const executor = new RecordingExecutor({
    // Only the gateway stands in the way of this rule; the relay is simply absent.
    "inspect-container": (call) =>
      String(call.request.input.name).includes("-gateway-")
        ? {
            ok: true,
            output: {
              exists: true,
              running: true,
              containerId: "c1",
              labels: {
                "org.openclaw.enterprise.managed": "true",
                "org.openclaw.enterprise.namespace-id": "ns_1",
                "org.openclaw.enterprise.agent-id": "agt_1",
                "org.openclaw.enterprise.role": "gateway",
                "org.openclaw.enterprise.revision-id": "rev_2",
              },
            },
          }
        : { ok: true, output: { exists: false } },
  });
  await driverWith(executor).stopRevision(revision());
  assert.ok(
    !executor.operations().includes("stop-container"),
    "a successor's gateway must keep serving",
  );
});

test("stopping an embedded revision stops its gateway", async () => {
  // The workload of an embedded revision is the gateway container. Stopping the Agent has to
  // stop it; stopping a container that does not exist is not a failure.
  // The engine reports nothing to stop, which is the ordinary case for a revision that never
  // started; what matters is which container the Driver goes looking for.
  const executor = new RecordingExecutor({
    "inspect-container": { ok: true, output: { exists: false } },
  });
  await driverWith(executor).stopRevision(revision());
  const inspected = executor.calls
    .filter((call) => call.request.operation === "inspect-container")
    .map((call) => String(call.request.input.name ?? ""));
  assert.ok(
    inspected.some((name) => name.includes("gateway")),
    "an embedded revision stops its gateway",
  );
  assert.ok(
    !inspected.some((name) => name.endsWith("-agent")),
    "an embedded revision has no harness container to stop",
  );
});

test("activation requires the container the revision actually runs", async () => {
  // An embedded revision runs its harness inside the gateway, so there is no harness container to
  // find and demanding one would leave every embedded Agent permanently unactivatable. A dedicated
  // revision is the opposite: its harness container is the workload, and a missing one is a real
  // failure the platform must hear about.
  const gatewayOnly = new RecordingExecutor({
    "inspect-container": { ok: true, output: { exists: true, running: true, containerId: "c1" } },
  });
  await driverWith(gatewayOnly).activateRevision(revision());
  const inspected = gatewayOnly.calls
    .filter((call) => call.request.operation === "inspect-container")
    .map((call) => String(call.request.input.name ?? ""));
  assert.ok(
    inspected.some((name) => name.includes("gateway")),
    "an embedded revision activates on its gateway",
  );
  assert.ok(
    !inspected.some((name) => name.endsWith("-agent")),
    "an embedded revision has no harness container to demand",
  );

  const absent = new RecordingExecutor({
    "inspect-container": { ok: true, output: { exists: false } },
  });
  await assert.rejects(
    () =>
      driverWith(absent).activateRevision(
        revision({ id: "rev_2", harness: { id: "codex", mode: "dedicated", version: "1.2.3" } }),
      ),
    /Agent container is not running/,
    "a dedicated revision fails loudly when its harness is missing",
  );
});

test("stopping or retiring a revision that never started is not a failure", async () => {
  // The platform creates an Agent stopped, and a revision that never started has no harness and no
  // relay. Asking the engine first is what keeps that from reading as a broken delivery.
  const executor = new RecordingExecutor({
    "inspect-container": { ok: true, output: { exists: false } },
  });
  const driver = driverWith(executor);
  await driver.stopRevision(revision());
  await driver.retireRevision(revision());
  assert.ok(
    !executor.operations().includes("stop-container"),
    "nothing may be stopped that does not exist",
  );
  assert.ok(
    !executor.operations().includes("remove-container"),
    "nothing may be removed that does not exist",
  );
});

test("the Installation's limits reach every container the Driver starts", async () => {
  const executor = new RecordingExecutor({
    "run-to-completion": { ok: true, output: { running: false, exitCode: 0 } },
  });
  await driverWith(executor).prepareRevision(revision(), workspaceContext());

  const gateway = executor.calls.find((call) => call.request.operation === "run-container");
  assert.deepEqual(gateway.request.input.limits, { memoryBytes: 3 * 1024 ** 3, cpus: 4 });
  // The initializer is a container in the Agent's Namespace, so the namespace defaults bound
  // it too; a limit the engine cannot hold would otherwise be silently dropped.
  const setup = executor.calls.find((call) => call.request.operation === "run-to-completion");
  assert.deepEqual(setup.request.input.limits, { memoryBytes: 1024 ** 3, cpus: 1 });
});

test("a resource quantity the engine cannot honour fails the delivery closed", async () => {
  assert.throws(
    () =>
      driverWith(new RecordingExecutor(), {
        resources: {
          ...goodConfiguration().resources,
          gateway: {
            requests: { cpu: "100m", memory: "1792Mi" },
            limits: { cpu: "4", memory: "3 gigabytes" },
          },
        },
      }),
    /resources\.gateway\.limits\.memory must be a memory quantity/,
  );
});

test("workspace setup for another Agent is refused", async () => {
  const executor = new RecordingExecutor();
  await assert.rejects(
    driverWith(executor).prepareRevision(
      revision(),
      workspaceContext({
        workspaceSetup: {
          id: "ns_1/agt_other",
          namespaceId: "ns_1",
          agentId: "agt_other",
          completed: false,
          files: { "AGENTS.md": "payload-token-xyz" },
        },
      }),
    ),
    /exact Agent/,
  );
  assert.ok(!executor.operations().includes("run-to-completion"));
});

function revisionBinding() {
  return {
    namespace: { id: "ns_1" },
    agent: { id: "agt_1" },
    revision: { id: "rev_1" },
  };
}

/**
 * Only the gateway container exists for an embedded runtime. The engine reports its own status
 * rendering and the published binding, never a readiness word: containerd keeps no health state.
 */
function gatewayOnly(overrides = {}, options = {}) {
  const ports =
    options.port === undefined ? {} : { published: `127.0.0.1:${options.port}->8080/tcp` };
  return {
    "inspect-container": (call) =>
      call.request.input.name.includes("gateway")
        ? {
            ok: true,
            output: {
              exists: true,
              running: true,
              health: "Up",
              ports,
              containerId: "container-1",
              image: `registry.example/gateway@${DIGEST}`,
              imageId: DIGEST,
              labels: {
                "org.openclaw.enterprise.managed": "true",
                "org.openclaw.enterprise.compute-driver": "nerdctl",
                "org.openclaw.enterprise.namespace-id": "ns_1",
                "org.openclaw.enterprise.agent-id": "agt_1",
              },
            },
          }
        : { ok: true, output: { exists: false } },
    ...overrides,
  };
}

/** The gateway's liveness route, served by a real loopback endpoint. */
async function gatewayLiveness(t, status = 200) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(status);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  return { port: address.port, requests };
}

test("describeAgentRuntime reports one control-host container and invents no events", async (t) => {
  // The container runs and its published endpoint answers, which is everything this engine can
  // prove about readiness. A Driver that compared the engine's status against a readiness word
  // would report every healthy deployment as not ready.
  const { port, requests } = await gatewayLiveness(t);
  const executor = new RecordingExecutor(gatewayOnly({}, { port }));
  const described = await driverWith(executor).describeAgentRuntime(
    revisionBinding(),
    new AbortController().signal,
  );

  assert.equal(described.revisionId, "rev_1");
  assert.equal(described.pods.length, 1);
  const [pod] = described.pods;
  assert.equal(pod.role, "gateway");
  // This engine has no scheduler, so every container runs on the control host.
  assert.equal(pod.cluster, "control");
  assert.equal(pod.phase, "Running");
  assert.equal(pod.ready, true);
  assert.deepEqual(requests, ["/healthz"]);
  // No Kubernetes event stream exists here; an empty list is honest, an invented one is not.
  assert.deepEqual(pod.events, []);
  assert.equal(pod.containers[0].state, "running");
  assert.deepEqual(
    described.sources.map((source) => source.id),
    ["gateway"],
  );
  assert.equal(described.sources[0].available, true);
});

test("a running gateway whose endpoint is unhealthy is not reported ready", async (t) => {
  const { port } = await gatewayLiveness(t, 503);
  const described = await driverWith(
    new RecordingExecutor(gatewayOnly({}, { port })),
  ).describeAgentRuntime(revisionBinding(), new AbortController().signal);

  const [pod] = described.pods;
  assert.equal(pod.phase, "Running");
  assert.equal(pod.containers[0].state, "running");
  assert.equal(
    pod.ready,
    false,
    "readiness must follow the endpoint, not the mere existence of a process",
  );
});

test("a terminated container reports the engine's own status rather than a translation", async () => {
  const executor = new RecordingExecutor(
    gatewayOnly({
      "inspect-container": (call) =>
        call.request.input.name.includes("gateway")
          ? {
              ok: true,
              output: { exists: true, running: false, exitCode: 3, health: "Exited (3)" },
            }
          : { ok: true, output: { exists: false } },
    }),
  );
  const described = await driverWith(executor).describeAgentRuntime(
    revisionBinding(),
    new AbortController().signal,
  );

  const [pod] = described.pods;
  assert.equal(pod.phase, "Failed");
  assert.equal(pod.ready, false);
  assert.equal(pod.containers[0].state, "terminated");
  assert.equal(pod.containers[0].reason, "Exited (3)");
  assert.equal(pod.containers[0].lastTermination.reason, "Exited (3)");
  assert.equal(pod.containers[0].lastTermination.exitCode, 3);
});

test("readAgentRuntimeLogs returns bounded output and refuses what the engine cannot give", async () => {
  const executor = new RecordingExecutor(
    gatewayOnly({
      "read-logs": { ok: true, output: { lines: ["first", "second"], truncated: true } },
    }),
  );
  const driver = driverWith(executor);
  const chunk = await driver.readAgentRuntimeLogs(revisionBinding(), {
    source: "gateway",
    pod: "pod-1",
    podUid: "uid-1",
    container: "gateway",
    previous: false,
    tailLines: 2,
    limitBytes: 4096,
    signal: new AbortController().signal,
  });
  assert.deepEqual(chunk.lines, [
    { time: null, raw: "first" },
    { time: null, raw: "second" },
  ]);
  assert.equal(chunk.truncated, true);
  assert.equal(chunk.stream.source, "gateway");

  const read = executor.calls.find((call) => call.request.operation === "read-logs");
  assert.equal(read.request.input.lines, 2);
  assert.equal(read.request.input.limitBytes, 4096);
  assert.equal(read.request.input.expectLabels["org.openclaw.enterprise.namespace-id"], "ns_1");

  // A replaced container keeps no previous output on this engine.
  const before = executor.calls.length;
  await assert.rejects(
    driver.readAgentRuntimeLogs(revisionBinding(), {
      source: "gateway",
      pod: "pod-1",
      podUid: "uid-1",
      container: "gateway",
      previous: true,
      tailLines: 10,
      limitBytes: 4096,
      signal: new AbortController().signal,
    }),
    /not retained/,
  );
  assert.equal(executor.calls.length, before, "a refused read must not reach the engine");

  const absent = driverWith(new RecordingExecutor());
  await assert.rejects(
    absent.readAgentRuntimeLogs(revisionBinding(), {
      source: "agent",
      pod: "pod-2",
      podUid: "uid-2",
      container: "agent",
      previous: false,
      tailLines: 10,
      limitBytes: 4096,
      signal: new AbortController().signal,
    }),
    /No agent runtime exists/,
  );
});

test("diagnoseAgentDeployment reports the exit code and notices a missing runtime", async () => {
  const exited = new RecordingExecutor(
    gatewayOnly({
      "inspect-container": (call) =>
        call.request.input.name.includes("gateway")
          ? {
              ok: true,
              output: { exists: true, running: false, exitCode: 3, health: "Exited (3)" },
            }
          : { ok: true, output: { exists: false } },
    }),
  );
  const diagnostics = await driverWith(exited).diagnoseAgentDeployment(revisionBinding());
  assert.equal(diagnostics.revisionId, "rev_1");
  const running = diagnostics.checks.find((check) => check.check === "container-running");
  assert.equal(running.state, "failed");
  assert.equal(running.code, "EXIT_3");

  const empty = await driverWith(new RecordingExecutor()).diagnoseAgentDeployment(
    revisionBinding(),
  );
  assert.deepEqual(
    empty.checks.map((check) => check.code),
    ["NO_CONTAINER"],
  );
});

test("runtime images come from the live container and credential status from the stored credential", async () => {
  // A directory of this Agent's own: credential state is durable, so tests must not share it.
  const directory = join(CREDENTIALS, "status");
  const driver = driverWith(new RecordingExecutor(gatewayOnly()), {
    credentials: { directory },
  });
  const images = await driver.getRuntimeImages({
    id: "rev_1",
    namespaceId: "ns_1",
    agentId: "agt_1",
  });
  assert.equal(images.length, 1);
  // The digest is the image identity; the container id is not.
  assert.equal(images[0].imageId, DIGEST);
  assert.equal(images[0].workload, "openclaw");

  // The credential is a file the Driver owns, not a property of a running container: a
  // stopped revision keeps it, and a container that happens to run is not a credential.
  assert.deepEqual(await driver.getAgentRuntimeCredentialStatus(revisionBinding()), {
    transportConfigured: false,
  });
  await driver.provisionAgentRuntimeCredentials(revisionBinding());
  assert.deepEqual(await driver.getAgentRuntimeCredentialStatus(revisionBinding()), {
    transportConfigured: true,
  });
  // Provisioning again preserves the value the platform already handed to the runtime.
  const path = gatewayPasswordPath(directory, { namespaceId: "ns_1", agentId: "agt_1" });
  const first = await readFile(path, "utf8");
  await driver.provisionAgentRuntimeCredentials(revisionBinding());
  assert.equal(await readFile(path, "utf8"), first);
});

test("a replacement runtime presents the credential its clients already hold", async () => {
  // Two deliveries of the same Agent must hand the runtime the same gateway password; a fresh
  // one per delivery would break every client holding the previous one.
  // One Agent, one credential directory: the second delivery replaces the container, not
  // the credential.
  const directory = join(CREDENTIALS, "replacement");
  const passwords = [];
  for (const pass of ["first", "second"]) {
    const executor = new RecordingExecutor({
      // The second delivery finds no running gateway, so the runtime is replaced.
      "inspect-container": { ok: true, output: { exists: false } },
      "run-to-completion": { ok: true, output: { running: false, exitCode: 0 } },
      "list-containers": listing([]),
    });
    const driver = driverWith(executor, { credentials: { directory } });
    await driver.prepareRevision(revision(), workspaceContext());
    const run = executor.calls.find((call) => call.request.operation === "run-container");
    assert.ok(run, `${pass} delivery must start a runtime`);
    passwords.push(run.request.input.env.OPENCLAW_GATEWAY_PASSWORD);
  }
  assert.equal(typeof passwords[0], "string");
  assert.equal(passwords[0], passwords[1], "a replacement must reuse the stored credential");
});

test("preflight reports missing images and refuses a non-rootless engine", async () => {
  const missing = new RecordingExecutor({
    preflight: {
      ok: true,
      output: { rootless: true, images: { "registry.example/agent@sha256:x": "missing" } },
    },
  });
  const result = await driverWith(missing).preflight();
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "IMAGE_MISSING");

  const rootful = new RecordingExecutor({
    preflight: { ok: true, output: { rootless: false, images: {} } },
  });
  await assert.rejects(driverWith(rootful).preflight(), /rootless/);
});

test("an endpoint is only offered once a gateway port is known", () => {
  const driver = driverWith(new RecordingExecutor());
  assert.equal(driver.getGatewayEndpoint({ namespaceId: "ns_1", agentId: "agt_1" }), undefined);
});

// --- Codex OAuth: the staged login is consumed and seeded into the harness's own home -------
// The stage below uses the real filesystem Secret Driver, so the store layout this Driver reads
// is the layout that Driver writes; a change to either is caught here rather than in production.

const SECRET_STORE = mkdtempSync(join(tmpdir(), "oce-containerd-secrets-"));
const OAUTH_TOKENS = {
  id_token: "synthetic-id-token",
  access_token: "synthetic-access-token",
  refresh_token: "synthetic-refresh-token",
};

/** Stages one device login exactly as the platform's device-authorization flow does. */
async function stagedLogin(overrides = {}) {
  const driver = new FilesystemSecretDriver({ directory: SECRET_STORE });
  const identity = {
    id: `sec_${randomBytes(8).toString("hex")}`,
    namespaceId: "ns_1",
    name: "Device login",
  };
  const session = {
    kind: "harness_device_authorization",
    version: 1,
    actorId: "idn_owner",
    namespaceId: identity.namespaceId,
    harnessId: "codex",
    computeDriverId: "compute-containerd",
    phase: "ready",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    nextPollAt: new Date().toISOString(),
    authorization: {
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "TEST-CODE",
      intervalSeconds: 5,
    },
    credential: JSON.stringify({
      version: 1,
      provider: "codex",
      state: "ready",
      auth: { auth_mode: "chatgpt", tokens: OAUTH_TOKENS },
    }),
    ...overrides,
  };
  const backendRef = await driver.create(identity, JSON.stringify(session));
  return {
    driver,
    secretId: identity.id,
    namespaceId: identity.namespaceId,
    backendRef,
    record: {
      id: identity.id,
      namespaceId: identity.namespaceId,
      name: identity.name,
      driverId: "occ/filesystem-secret",
      backendRef,
    },
  };
}

/** The stored value, read back through the Secret Driver rather than by re-implementing it. */
function storedValue(login) {
  return login.driver.withValue(login.record, async (value) => value);
}

function oauthContext(login) {
  return {
    secretEnvironment: [],
    harnessAuth: {
      method: "oauth",
      source: { kind: "secret", namespaceId: login.namespaceId, id: login.secretId },
      secretDriverId: "occ/filesystem-secret",
      backendRef: login.backendRef,
    },
  };
}

function oauthDriver(executor) {
  return driverWith(executor, {}, { secretStore: { directory: SECRET_STORE } });
}

test("a staged Codex login is consumed into the harness home, and never reaches the gateway", async () => {
  const executor = new RecordingExecutor();
  const login = await stagedLogin();
  const driver = oauthDriver(executor);
  const revision = dedicatedRevision();
  const readiness = await driver.prepareRevision(revision, oauthContext(login));

  assert.equal(readiness.ready, true);
  const seeders = executor.calls.filter(
    (call) =>
      call.request.operation === "run-to-completion" &&
      String(call.request.input.name).endsWith("-oauth-seed"),
  );
  assert.equal(seeders.length, 1, "one revision seeds one Codex home");
  const seed = seeders[0].request.input;
  // The bundle travels through a read-only mount of a Driver-owned file, not argv or the
  // environment: the seeder's own arguments and env carry no credential material.
  assert.equal(seed.mounts[0].target, "/home/node/.codex");
  assert.equal(seed.mounts[1].readOnly, true);
  for (const value of [JSON.stringify(seed.args), JSON.stringify(seed.env)]) {
    assert.ok(!value.includes(OAUTH_TOKENS.refresh_token), "the bundle must not reach argv or env");
  }
  assert.equal(
    seed.env.OCE_CODEX_OAUTH_SOURCE_UID,
    login.backendRef.uid,
    "the receipt names the staged Secret identity",
  );
  assert.match(seed.env.OCE_CODEX_OAUTH_VOLUME_UID, /^[0-9a-f]{32}$/);
  assert.equal(seed.user, "0:0");
  assert.equal(seed.network, "none");
  assert.equal(seed.readOnlyRootfs, true);
  assert.deepEqual(seed.capDrop, ["ALL"]);

  // The harness logs in from the seeded bundle.
  const agent = executor.calls.find(
    (call) =>
      call.request.operation === "run-container" &&
      call.request.input.labels["org.openclaw.enterprise.role"] === "agent",
  );
  assert.equal(agent.request.input.env.CODEX_LOGIN_MODE, "oauth");
  assert.equal(agent.request.input.env.CODEX_HOME, "/home/node/.codex");
  assert.equal(agent.request.input.env.OCE_CODEX_OAUTH_SOURCE_UID, login.backendRef.uid);
  assert.equal(
    agent.request.input.env.OCE_CODEX_OAUTH_VOLUME_UID,
    seed.env.OCE_CODEX_OAUTH_VOLUME_UID,
    "the harness presents the receipt the seeder wrote",
  );
  assert.equal(agent.request.input.env.OPENAI_API_KEY, undefined);
  assert.deepEqual(
    agent.request.input.mounts.map((mount) => mount.volume),
    [
      workspaceVolumes({ namespaceId: "ns_1", agentId: "agt_1" }).codexHome,
      workspaceVolumes({ namespaceId: "ns_1", agentId: "agt_1" }).workspace,
    ],
  );

  // The Gateway serves clients and reaches the harness; it never sees the OAuth material.
  const gateway = executor.calls.find(
    (call) =>
      call.request.operation === "run-container" &&
      call.request.input.labels["org.openclaw.enterprise.role"] === "gateway",
  );
  assert.equal(gateway.request.input.env.APP_SERVER_URL !== undefined, true);
  for (const name of ["OCE_CODEX_OAUTH_SOURCE_UID", "OCE_CODEX_OAUTH_VOLUME_UID", "CODEX_HOME"]) {
    assert.equal(gateway.request.input.env[name], undefined, `${name} must not reach the gateway`);
  }
  for (const mount of gateway.request.input.mounts ?? []) {
    assert.notEqual(
      mount.volume,
      workspaceVolumes({ namespaceId: "ns_1", agentId: "agt_1" }).codexHome,
      "the gateway must not mount the Codex home",
    );
  }

  // The staged login is spent and can never be read again, exactly as the Kubernetes path
  // leaves it; the deployed Codex refreshes its own tokens on the private volume.
  const consumed = JSON.parse(await storedValue(login));
  assert.equal(consumed.kind, "harness_device_authorization");
  assert.equal(consumed.phase, "consumed");
  assert.equal(consumed.agentId, "agt_1");
  assert.equal(consumed.volumeUid, seed.env.OCE_CODEX_OAUTH_VOLUME_UID);
  assert.equal(consumed.credential, undefined, "the credential must not survive consumption");
});

test("a consumed login is not seeded twice, and a foreign or unready one is refused", async () => {
  const first = new RecordingExecutor();
  const login = await stagedLogin();
  const driver = oauthDriver(first);
  await driver.prepareRevision(dedicatedRevision(), oauthContext(login));

  // A retry of the same revision finds the bundle already on its own Codex volume.
  const retry = new RecordingExecutor();
  const readiness = await oauthDriver(retry).prepareRevision(
    dedicatedRevision(),
    oauthContext(login),
  );
  assert.equal(readiness.ready, true);
  assert.ok(
    !retry.operations().includes("run-to-completion") ||
      !retry.calls.some(
        (call) =>
          call.request.operation === "run-to-completion" &&
          String(call.request.input.name).endsWith("-oauth-seed"),
      ),
    "a spent login must not be seeded again",
  );

  // Another Agent's spent login, an unready one and a foreign claim are all refused before the
  // harness starts.
  const foreign = await stagedLogin({
    phase: "consumed",
    agentId: "agt_other",
    volumeUid: "0".repeat(32),
  });
  await assert.rejects(
    oauthDriver(new RecordingExecutor()).prepareRevision(
      dedicatedRevision(),
      oauthContext(foreign),
    ),
    /Consumed OAuth credentials cannot be replaced/,
  );
  const pending = await stagedLogin({ phase: "pending", credential: undefined });
  await assert.rejects(
    oauthDriver(new RecordingExecutor()).prepareRevision(
      dedicatedRevision(),
      oauthContext(pending),
    ),
    /not ready; sign in again/,
  );
  const expired = await stagedLogin({ expiresAt: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(
    oauthDriver(new RecordingExecutor()).prepareRevision(
      dedicatedRevision(),
      oauthContext(expired),
    ),
    /not ready; sign in again/,
  );
  const otherNamespace = await stagedLogin({ namespaceId: "ns_other" });
  await assert.rejects(
    oauthDriver(new RecordingExecutor()).prepareRevision(
      dedicatedRevision(),
      oauthContext(otherNamespace),
    ),
    /another Namespace/,
  );
  const notCodex = await stagedLogin({ harnessId: "openclaw" });
  await assert.rejects(
    oauthDriver(new RecordingExecutor()).prepareRevision(
      dedicatedRevision(),
      oauthContext(notCodex),
    ),
    /not a Codex login session/,
  );
  const wrongShape = await stagedLogin({
    credential: JSON.stringify({
      version: 1,
      provider: "codex",
      state: "ready",
      auth: { auth_mode: "apikey", tokens: OAUTH_TOKENS },
    }),
  });
  await assert.rejects(
    oauthDriver(new RecordingExecutor()).prepareRevision(
      dedicatedRevision(),
      oauthContext(wrongShape),
    ),
    /credential is unavailable/,
  );
});

test("a failed seal leaves the login claimed, so a retry can finish the handoff", async () => {
  const login = await stagedLogin();
  const failing = new RecordingExecutor({
    "run-to-completion": (call) =>
      String(call.request.input.name).endsWith("-oauth-seed")
        ? { ok: true, output: { exitCode: 1 } }
        : { ok: true, output: { exitCode: 0 } },
  });
  await assert.rejects(
    oauthDriver(failing).prepareRevision(dedicatedRevision(), oauthContext(login)),
    /OAuth seeding failed/,
  );
  // The bundle was never delivered, so the login is reserved but not spent: the next attempt
  // can still finish it. Consuming it here would burn the operator's login.
  const claimed = JSON.parse(await storedValue(login));
  assert.equal(claimed.phase, "claimed");
  assert.equal(claimed.agentId, "agt_1");
  assert.ok(claimed.credential !== undefined, "the credential survives a failed handoff");

  const retry = new RecordingExecutor();
  const readiness = await oauthDriver(retry).prepareRevision(
    dedicatedRevision(),
    oauthContext(login),
  );
  assert.equal(readiness.ready, true);
  assert.equal(JSON.parse(await storedValue(login)).phase, "consumed");
});

test("a dedicated harness without OAuth keeps its Codex home clean", async () => {
  const executor = new RecordingExecutor();
  const driver = driverWith(executor);
  await driver.prepareRevision(dedicatedRevision());

  const initializer = executor.calls.find(
    (call) =>
      call.request.operation === "run-to-completion" &&
      String(call.request.input.name).endsWith("-setup"),
  );
  // The initializer hands the Codex home over and removes any earlier personal login, so a
  // revision that stopped using OAuth cannot keep a credential refreshing on the volume.
  assert.deepEqual(initializer.request.input.mounts[2], {
    volume: workspaceVolumes({ namespaceId: "ns_1", agentId: "agt_1" }).codexHome,
    target: "/home/node/.codex",
  });
  assert.ok(!initializer.request.input.env.OCE_CODEX_OAUTH_SOURCE_UID);
  const agent = executor.calls.find(
    (call) =>
      call.request.operation === "run-container" &&
      call.request.input.labels["org.openclaw.enterprise.role"] === "agent",
  );
  assert.equal(agent.request.input.env.CODEX_LOGIN_MODE, "api_key");
});

test("the harness runtime command fits the kernel's per-argument limit", async () => {
  const executor = new RecordingExecutor();
  await driverWith(executor).prepareRevision(dedicatedRevision());

  const agent = executor.calls.find(
    (call) =>
      call.request.operation === "run-container" &&
      call.request.input.labels["org.openclaw.enterprise.role"] === "agent",
  );
  // The OpenClaw runtime program is ~135 KB, above Linux's 128 KiB MAX_ARG_STRLEN. Passing it
  // as one `-e` argument fails with E2BIG before Node starts: the container exits 255 with no
  // output at all. It therefore travels compressed in bounded pieces after the repository's
  // fixed loader, under tini, exactly as the Kubernetes Harness runs it.
  assert.deepEqual(agent.request.input.entrypoint, ["/usr/bin/tini"]);
  assert.deepEqual(agent.request.input.args.slice(0, 6), ["-s", "-e", "143", "--", "node", "-e"]);
  const pieces = agent.request.input.args.slice(7);
  assert.ok(pieces.length > 1, "the program must travel in several bounded pieces");
  for (const piece of agent.request.input.args) {
    // A whole piece is exactly 32 KiB, comfortably below the 128 KiB kernel limit.
    assert.ok(
      Buffer.byteLength(piece) <= 32 * 1024,
      `no single argument may approach the kernel's argument limit: ${Buffer.byteLength(piece)} bytes`,
    );
  }
  // The readiness probe is small enough to stay a direct `-e` program.
  assert.deepEqual(agent.request.input.readiness.command.slice(0, 2), ["node", "-e"]);
});

test("a spent or missing staged login fails as permanent configuration, not as a retry", async () => {
  // A spent login cannot be fixed by retrying: the operator must sign in again. The platform
  // reads the Driver's own classification, so it must say permanent and name configuration.
  const spent = await stagedLogin({
    phase: "consumed",
    agentId: "agt_other",
    volumeUid: "0".repeat(32),
  });
  const driver = oauthDriver(new RecordingExecutor());
  const refused = await driver.prepareRevision(dedicatedRevision(), oauthContext(spent)).then(
    () => undefined,
    (error) => error,
  );
  assert.match(String(refused?.message), /Consumed OAuth credentials cannot be replaced/);
  const diagnostic = driver.describePrepareRevisionFailure(refused);
  assert.equal(diagnostic?.code, "CONTAINERD_CONFIGURATION_INVALID");
  // The platform validates the stage vocabulary before it trusts any field: a hyphen made the
  // whole diagnostic invalid, so nothing was logged and nothing was classified.
  assert.match(String(diagnostic?.stage), /^[a-z][a-z0-9_]{0,63}$/);
  assert.equal(diagnostic?.permanent, true, "retrying a spent login only burns the budget");

  // Preparation aggregates the primary failure with a cleanup failure. The classification must
  // survive that wrapper, or every permanent cause wrapped this way is retried instead.
  const wrapped = new AggregateError(
    [refused, new Error("cleanup failed")],
    "compute-containerd workload preparation and cleanup failed.",
    { cause: refused },
  );
  assert.deepEqual(driver.describePrepareRevisionFailure(wrapped), diagnostic);

  // A login that was never staged is the same class of operator fix.
  const foreign = oauthContext(await stagedLogin());
  const missing = await driver
    .prepareRevision(dedicatedRevision(), {
      ...foreign,
      harnessAuth: {
        ...foreign.harnessAuth,
        source: { kind: "secret", namespaceId: "ns_1", id: "sec_absent" },
      },
    })
    .then(
      () => undefined,
      (error) => error,
    );
  assert.equal(
    driver.describePrepareRevisionFailure(missing)?.code,
    "CONTAINERD_CONFIGURATION_INVALID",
  );
  assert.equal(driver.describePrepareRevisionFailure(missing)?.permanent, true);
});

test("a helper deadline is retried rather than classified as permanent", async () => {
  // A first start can miss the readiness deadline and succeed on the next pass, and the helper
  // omits its retry hint on most failures. Permanence must come from a semantic refusal, never
  // from a missing hint, or one slow start would end a deployment for good.
  const executor = new RecordingExecutor({
    "run-container": {
      ok: false,
      error: { code: "TIMEOUT", message: "readiness deadline exceeded", retryable: false },
    },
  });
  const error = await driverWith(executor)
    .prepareRevision(dedicatedRevision())
    .then(
      () => undefined,
      (failure) => failure,
    );
  const diagnostic = driverWith(new RecordingExecutor()).describePrepareRevisionFailure(error);
  assert.equal(diagnostic?.code, "TIMEOUT");
  assert.equal(diagnostic?.permanent, undefined, "a timeout must leave the platform free to retry");
});

test("a staged login is identified by the uid its Driver issued, not by the reference name", async () => {
  // A Secret Driver with no cluster coordinates publishes an opaque locator as its backend
  // name - the filesystem Driver hashes the Namespace and Secret names - while the document
  // it stores carries the Secret's own name. Comparing the two would refuse every delivery
  // on a host engine, so ownership rests on the uid the Driver issued.
  const login = await stagedLogin();
  assert.notEqual(login.backendRef.name, login.record.name);
  assert.match(login.backendRef.name, /^[0-9a-f]{32}$/);

  const reference = {
    namespaceId: login.namespaceId,
    secretId: login.secretId,
    backendRef: login.backendRef,
  };
  const read = await readOAuthLogin(SECRET_STORE, reference);
  assert.equal(read.uid, login.backendRef.uid);

  await assert.rejects(
    readOAuthLogin(SECRET_STORE, {
      ...reference,
      backendRef: { ...login.backendRef, uid: randomUUID() },
    }),
    /changed ownership/,
  );
});

test("the staged setup payload is owner-only in a unique owner-only directory", async (t) => {
  // The payload is transient, so its contract is proved on the helper that stages it: a
  // mkdtemp directory keeps the path unpredictable and owner-only, and `wx` at 0600 keeps the
  // file exclusive, so no other account can read it and nothing can adopt a pre-created path.
  const setup = {
    id: `ws_${randomUUID()}`,
    namespaceId: "ns_1",
    agentId: "agt_1",
    completed: false,
    files: { "AGENTS.md": "instructions" },
  };
  const first = await writeWorkspaceSetupPayload(setup);
  const second = await writeWorkspaceSetupPayload(setup);
  t.after(() =>
    Promise.all([
      rm(first.directory, { recursive: true, force: true }),
      rm(second.directory, { recursive: true, force: true }),
    ]),
  );

  assert.notEqual(first.directory, second.directory, "the directory name must be unpredictable");
  assert.equal((await stat(first.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  assert.equal((await stat(first.path)).nlink, 1);
  assert.deepEqual(JSON.parse(await readFile(first.path, "utf8")), setup);
});

// --- Provider key: the OpenAI key a dedicated Codex harness authenticates with ----------------
// The platform stages the key as a Secret in the selected Secret Driver and hands the revision
// only the reference it resolved. The Driver reads that store, exactly as the Kubernetes Compute
// Driver reads the same Secret through its cluster API, and the key reaches the dedicated Codex
// harness environment and nothing else. This stage uses the real filesystem Secret Driver, so the
// store layout this Driver reads is the layout that Driver writes.

/** A synthetic key: this stage proves the delivery path, not the provider. */
const PROVIDER_KEY = "provider-key-conformance-canary";

async function stagedProviderKey(value = PROVIDER_KEY) {
  const driver = new FilesystemSecretDriver({ directory: SECRET_STORE });
  const identity = {
    id: `sec_${randomBytes(8).toString("hex")}`,
    namespaceId: "ns_1",
    name: "Provider key",
  };
  const backendRef = await driver.create(identity, value);
  return {
    driver,
    secretId: identity.id,
    namespaceId: identity.namespaceId,
    backendRef,
  };
}

function providerKeyContext(key) {
  return {
    secretEnvironment: [],
    harnessAuth: {
      method: "api_key",
      source: { kind: "secret", namespaceId: key.namespaceId, id: key.secretId },
      secretDriverId: "occ/filesystem-secret",
      backendRef: key.backendRef,
    },
  };
}

function providerKeyDriver(executor) {
  return driverWith(executor, {}, { secretStore: { directory: SECRET_STORE } });
}

test("a staged provider key reaches the dedicated harness environment and nothing else", async () => {
  const executor = new RecordingExecutor();
  const key = await stagedProviderKey();
  const driver = providerKeyDriver(executor);
  const revision = dedicatedRevision();
  const readiness = await driver.prepareRevision(revision, providerKeyContext(key));
  assert.equal(readiness.ready, true);

  // The shared Codex runtime logs in with `codex login --with-api-key`, reading the key from
  // stdin, so the harness environment is the only place the value may appear.
  const agent = executor.calls.find(
    (call) =>
      call.request.operation === "run-container" &&
      call.request.input.labels["org.openclaw.enterprise.role"] === "agent",
  );
  assert.equal(agent.request.input.env.OPENAI_API_KEY, PROVIDER_KEY);
  assert.equal(agent.request.input.env.CODEX_LOGIN_MODE, "api_key");
  assert.ok(
    !JSON.stringify(agent.request.input.args).includes(PROVIDER_KEY),
    "the key must never become a container argument",
  );
  // The helper runs every readiness probe with a fixed minimal environment and cwd `/`, so the
  // harness probe must be self-contained: it checks the Codex app-server's own local port
  // instead of the shared entrypoint, which needs the container's token variables and its
  // module path and can only ever fail there.
  const probe = agent.request.input.readiness.command;
  assert.deepEqual(probe.slice(0, 2), ["node", "-e"]);
  assert.match(probe[2], /127\.0\.0\.1:18790\/readyz/);
  assert.ok(!probe.join(" ").includes("OCE_CODEX_OAUTH"), "the probe needs no receipt");

  // The gateway serves clients and reaches the harness over the transport channel; a model
  // credential belongs to the harness that executes turns, never to this container.
  const gateway = executor.calls.find(
    (call) =>
      call.request.operation === "run-container" &&
      call.request.input.labels["org.openclaw.enterprise.role"] === "gateway",
  );
  assert.equal(gateway.request.input.env.OPENAI_API_KEY, undefined);
  assert.ok(
    !JSON.stringify(gateway.request.input).includes(PROVIDER_KEY),
    "the key must not reach the gateway in any field",
  );

  // One delivery, one recipient: every other helper call, including the workspace initializer
  // and the readiness probe, must be free of the value.
  const carriers = executor.calls.filter((call) =>
    JSON.stringify(call.request.input).includes(PROVIDER_KEY),
  );
  assert.equal(carriers.length, 1, "only the dedicated harness container may carry the key");
  assert.equal(carriers[0], agent);

  // A value the store no longer owns is refused rather than delivered under another identity.
  const foreign = providerKeyContext({
    ...key,
    backendRef: { ...key.backendRef, uid: randomUUID() },
  });
  await assert.rejects(
    providerKeyDriver(new RecordingExecutor()).prepareRevision(dedicatedRevision(), foreign),
    /changed ownership/,
  );
});

test("the initializer clears an earlier login before it hands the Codex home over", async () => {
  // A dedicated Codex harness that seeds no OAuth bundle must not leave an earlier personal login
  // refreshing on the Agent's disk. Removing it after the ownership handoff fails: a container
  // root without `DAC_OVERRIDE` cannot write a directory the workload user owns, so a delivery
  // over an already-handed-over Codex home dies before its harness ever starts.
  const executor = new RecordingExecutor({
    "run-to-completion": { ok: true, output: { running: false, exitCode: 0 } },
  });
  const readiness = await providerKeyDriver(executor).prepareRevision(
    dedicatedRevision(),
    providerKeyContext(await stagedProviderKey()),
  );
  assert.equal(readiness.ready, true);

  const setup = executor.calls.find((call) => call.request.operation === "run-to-completion");
  const script = setup.request.input.args[1];
  const clear = script.indexOf('chownSync("/home/node/.codex", 0, 0)');
  const handoff = script.indexOf("chownSync(path, 1000, 1000)");
  assert.ok(clear >= 0, "a delivery that seeds no OAuth bundle clears an earlier login");
  assert.ok(
    handoff > clear,
    "the earlier login is cleared before the Codex home is handed to the workload user",
  );
  assert.ok(script.includes("auth.json") && script.includes(".oce-oauth.json"));
  assert.match(script, /rmSync\(/);
});
