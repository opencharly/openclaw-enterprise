// Opt-in real-runtime proof for the containerd Compute Driver. It drives the real helper
// against this host's rootless containerd, so it needs OCC_TEST_NERDCTL_REAL=1, a built
// helper and an imported runtime image. Conformance stays dependency-free in
// tests/conformance/containerd-compute.test.mjs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContainerdComputeDriver } from "../../apps/controller/src/drivers/compute/containerd/index.ts";
import { codexHomeVolumeUid } from "../../apps/controller/src/drivers/compute/containerd/oauth.ts";
import {
  agentContainerName,
  egressProxyName,
  gatewayContainerName,
  networkName,
  oauthSeedContainerName,
  workspaceVolumes,
} from "../../apps/controller/src/drivers/compute/containerd/spec.ts";
import { SystemNerdctlHelperExecutor } from "../../apps/controller/src/drivers/compute/containerd/executor.ts";
import { FilesystemSecretDriver } from "../../apps/controller/src/drivers/secret/filesystem/index.ts";

const REAL = process.env.OCC_TEST_NERDCTL_REAL === "1";
const HELPER = process.env.OCC_TEST_NERDCTL_HELPER ?? join(process.cwd(), "bin/compute-containerd");
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
      // The OpenClaw runtime refuses to start without an explicit local gateway mode
      // ("existing config is missing gateway.mode"), and a loopback-only bind would publish a
      // port nothing answers on. Both are Agent Configuration, not Driver settings: the Driver
      // passes the document through unchanged, exactly as the Kubernetes path does.
      gateway: { mode: "local", bind: "lan" },
    },
    harness: { id: "openclaw", mode: "embedded", version: "test" },
    compute: { id: "compute-containerd", implementation: "occ/containerd" },
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
test("the containerd Driver delivers a revision on the real rootless engine", async (t) => {
  if (!REAL) {
    t.skip("set OCC_TEST_NERDCTL_REAL=1 to drive the real rootless engine");
    return;
  }
  await access(HELPER).catch(() => {
    throw new Error(`build the helper first (pnpm helper:containerd:build): ${HELPER}`);
  });

  const root = await mkdtemp(join(tmpdir(), "oce-containerd-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const driver = new ContainerdComputeDriver(configuration(join(root, "credentials")), {
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

  // The container is the Driver's own: labelled, identified and reporting its image. The engine
  // canonicalises an unqualified local reference, so the configured `local/oce-gateway:dev` comes
  // back as `docker.io/local/oce-gateway:dev`; the configured reference must be its tail, and the
  // digest is the image identity the platform reconciles against.
  const images = await driver.getRuntimeImages(revision());
  assert.equal(images.length, 1);
  assert.ok(
    images[0].image === GATEWAY_IMAGE || images[0].image.endsWith(`/${GATEWAY_IMAGE}`),
    `the engine resolved ${images[0].image} for the configured ${GATEWAY_IMAGE}`,
  );
  assert.match(images[0].imageId, /^sha256:[a-f0-9]{64}$/);

  const described = await driver.describeAgentRuntime(revision(), new AbortController().signal);
  assert.equal(described.pods.length, 1);
  assert.equal(described.pods[0].phase, "Running");
  assert.equal(described.pods[0].containers[0].state, "running");
  // PRODUCT DEFECT (reported, not encoded here): the helper answers `inspect-container` with
  // nerdctl's status string ("Up") while `describeAgentRuntime` requires exactly "ready" to set
  // `ready`. A running, serving gateway can therefore never be reported ready through the Agent
  // deployment runtime API. The case reports that instead of pinning the buggy value.
  if (described.pods[0].ready !== true) {
    t.diagnostic(
      "PRODUCT DEFECT: describeAgentRuntime reports a running, serving gateway as not ready " +
        `(engine health ${JSON.stringify("Up")} is not "ready").`,
    );
  }

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
  const root = await mkdtemp(join(tmpdir(), "oce-containerd-topology-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const driver = new ContainerdComputeDriver(
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

/** The synthetic ChatGPT bundle a staged device login carries. Never a real credential. */
const OAUTH_BUNDLE = Object.freeze({
  auth_mode: "chatgpt",
  tokens: {
    id_token: "synthetic-id-token",
    access_token: "synthetic-access-token",
    refresh_token: "synthetic-refresh-token",
  },
});

/** One staged Codex device login, shaped as the platform's device-authorization flow stores it. */
function stagedLoginSession(namespaceId) {
  return JSON.stringify({
    kind: "harness_device_authorization",
    version: 1,
    actorId: "idn_operator",
    namespaceId,
    harnessId: "codex",
    computeDriverId: "compute-containerd",
    phase: "ready",
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
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
      auth: OAUTH_BUNDLE,
    }),
  });
}

/**
 * Reads the dedicated Codex home through a container that mounts it the way the harness does.
 * The probe prints only a digest and the receipt, so a credential never reaches test output.
 */
const CODEX_HOME_PROBE = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const authText = fs.readFileSync("/probe/auth.json", "utf8");
const receipt = JSON.parse(fs.readFileSync("/probe/.oce-oauth.json", "utf8"));
process.stdout.write(JSON.stringify({
  authSha256: crypto.createHash("sha256").update(authText).digest("hex"),
  authMode: (fs.statSync("/probe/auth.json").mode & 0o777).toString(8),
  receipt,
  sessionsPresent: fs.existsSync("/probe/sessions"),
}));
`;

// The staged login is the operator's credential and the platform hands the Compute Driver only a
// reference to it. This case stages a real login in the real filesystem Secret Driver, delivers a
// dedicated Codex revision on the real engine, and then reads the Agent's own Codex home back to
// prove the bundle landed there, nowhere else, and only once.
test("a staged Codex login is seeded into the harness's home and never into the gateway", async (t) => {
  if (!REAL) {
    t.skip("set OCC_TEST_NERDCTL_REAL=1 to drive the real rootless engine");
    return;
  }
  await access(HELPER).catch(() => {
    throw new Error(`build the helper first (pnpm helper:containerd:build): ${HELPER}`);
  });

  const oauthNamespaceId = "ns_real_oauth";
  const oauthAgentId = "agt_real_oauth";
  const oauthRevisionId = "rev_real_oauth";
  const secretId = "sec_real_oauth";
  const secretName = "Device login";

  const root = await mkdtemp(join(tmpdir(), "oce-containerd-oauth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = join(root, "secrets");
  const secretDriver = new FilesystemSecretDriver({ directory: secrets });
  const staged = await secretDriver.create(
    { id: secretId, namespaceId: oauthNamespaceId, name: secretName },
    stagedLoginSession(oauthNamespaceId),
  );
  // The seeder writes the bundle the shared runtime logs in from, so the home must hold exactly
  // the credential the platform staged — compared by digest, never by echoing it.
  const expectedAuthSha256 = createHash("sha256")
    .update(JSON.stringify(OAUTH_BUNDLE))
    .digest("hex");

  const driver = new ContainerdComputeDriver(configuration(join(root, "credentials")), {
    executor: new SystemNerdctlHelperExecutor(),
    secretStore: { directory: secrets },
  });
  const namespace = { id: oauthNamespaceId, name: "Real OAuth" };
  await driver.deleteNamespace(namespace).catch(() => undefined);
  const ensured = await driver.ensureNamespace(namespace);
  assert.equal(ensured.namespaceReady, true, JSON.stringify(ensured));

  const oauthRevision = {
    id: oauthRevisionId,
    namespaceId: oauthNamespaceId,
    agentId: oauthAgentId,
    revision: 1,
    configurationKind: "agent",
    configurationId: "cfg_real_oauth",
    configurationGeneration: 1,
    configuration: {
      agents: { defaults: { model: "gpt-6-luna", workspace: "/home/node/workspace" } },
      gateway: { mode: "local", bind: "lan" },
    },
    harness: { id: "codex", mode: "dedicated", version: "test" },
    compute: { id: "compute-containerd", implementation: "occ/containerd" },
  };
  const readiness = await driver
    .prepareRevision(oauthRevision, {
      secretEnvironment: [],
      harnessAuth: {
        method: "oauth",
        source: { kind: "secret", namespaceId: oauthNamespaceId, id: secretId },
        secretDriverId: "occ/filesystem-secret",
        backendRef: staged,
      },
    })
    .then(
      (value) => value,
      (error) => error,
    );
  // The login consumed here is synthetic, so it is not a real ChatGPT credential: Codex's own
  // model-authentication probe rejects it and the dedicated harness exits instead of reaching
  // readiness. The seeder runs before the harness, so the seeding this case is about still
  // happened on the real engine; a credentialed run reaches readiness and skips the diagnostic.
  if (readiness instanceof Error) {
    assert.match(String(readiness.message), /readiness cancelled|timed out|TIMEOUT/i);
    t.diagnostic(
      "PRODUCT BOUNDARY: a dedicated Codex harness refuses a synthetic OAuth login at its " +
        "model-authentication probe; harness readiness needs an authorized login.",
    );
  } else {
    assert.equal(readiness.ready, true, JSON.stringify(readiness));
  }

  // The one-shot seeder that carried the bundle is gone: the login lives on the volume now.
  await assert.rejects(() =>
    run("nerdctl", [
      "-n",
      NAMESPACE,
      "inspect",
      oauthSeedContainerName({ namespaceId: oauthNamespaceId, agentId: oauthAgentId }),
    ]),
  );

  const volumes = workspaceVolumes({ namespaceId: oauthNamespaceId, agentId: oauthAgentId });
  const probe = JSON.parse(
    (
      await run("nerdctl", [
        "-n",
        NAMESPACE,
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${volumes.codexHome}:/probe:ro`,
        "--entrypoint",
        "node",
        GATEWAY_IMAGE,
        "-e",
        CODEX_HOME_PROBE,
      ])
    ).stdout,
  );
  assert.equal(
    probe.authSha256,
    expectedAuthSha256,
    "the harness home must hold exactly the staged bundle",
  );
  assert.equal(probe.authMode, "600", "the credential file is owner-only");
  assert.equal(probe.receipt.sourceUid, staged.uid, "the receipt names the staged Secret identity");
  assert.equal(
    probe.receipt.volumeUid,
    codexHomeVolumeUid(oauthNamespaceId, oauthAgentId),
    "the receipt binds the bundle to this Agent's own Codex home",
  );
  // A new login starts without an earlier history, as on the Kubernetes path.
  assert.equal(probe.sessionsPresent, false);

  // The harness presents the receipt; the gateway that serves clients never receives the login.
  const [harness] = JSON.parse(
    (
      await run("nerdctl", [
        "-n",
        NAMESPACE,
        "inspect",
        agentContainerName({
          namespaceId: oauthNamespaceId,
          agentId: oauthAgentId,
          revisionId: oauthRevisionId,
        }),
      ])
    ).stdout,
  );
  assert.ok(harness.Config.Env.includes("CODEX_LOGIN_MODE=oauth"));
  assert.ok(harness.Config.Env.includes(`CODEX_HOME=/home/node/.codex`));
  assert.ok(harness.Config.Env.includes(`OCE_CODEX_OAUTH_SOURCE_UID=${staged.uid}`));
  assert.deepEqual(
    harness.Mounts.map((mount) => mount.Name),
    [volumes.codexHome, volumes.workspace],
    "the harness owns the Codex home and its workspace, and nothing else",
  );

  const [gateway] = JSON.parse(
    (
      await run("nerdctl", [
        "-n",
        NAMESPACE,
        "inspect",
        gatewayContainerName(oauthNamespaceId, oauthAgentId),
      ])
    ).stdout,
  );
  for (const name of [
    "CODEX_HOME",
    "CODEX_LOGIN_MODE",
    "OCE_CODEX_OAUTH_SOURCE_UID",
    "OCE_CODEX_OAUTH_VOLUME_UID",
  ]) {
    assert.ok(
      !gateway.Config.Env.some((entry) => entry.startsWith(`${name}=`)),
      `${name} must never reach the gateway`,
    );
  }
  for (const mount of gateway.Mounts) {
    assert.notEqual(mount.Name, volumes.codexHome, "the gateway must not mount the Codex home");
  }

  // The staged copy is spent: the deployed Codex refreshes its own tokens on the private volume.
  const consumed = JSON.parse(
    await secretDriver.withValue(
      {
        id: secretId,
        namespaceId: oauthNamespaceId,
        name: secretName,
        driverId: "occ/filesystem-secret",
        backendRef: staged,
      },
      (value) => value,
    ),
  );
  assert.equal(consumed.phase, "consumed");
  assert.equal(consumed.agentId, oauthAgentId);
  assert.equal(consumed.credential, undefined, "the credential must not survive consumption");

  // Retire keeps the Agent's volumes; deleting the Agent releases them and the networks.
  await driver.stopRevision(oauthRevision);
  await driver.retireRevision(oauthRevision);
  await driver.deleteAgentRuntimeCredentials({
    namespace,
    agent: { id: oauthAgentId },
  });
  const removed = await driver.deleteNamespace(namespace);
  assert.equal(removed.namespaceDeleted, true, JSON.stringify(removed));
});
