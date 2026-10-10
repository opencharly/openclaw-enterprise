// End-to-end proof of the rootless containerd Compute Driver through its real caller: the
// production worker, PostgreSQL platform state, and the real work queue. The container engine is
// the external dependency, so a stub helper stands at the Driver's configured path and answers
// the wire protocol; every line of Driver code between the worker and that path runs for real.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";

import { ContainerdComputeDriver } from "../../apps/controller/src/drivers/compute/containerd/index.ts";
import { gatewayPasswordPath } from "../../apps/controller/src/drivers/compute/containerd/credentials.ts";
import { SystemContainerdHelperExecutor } from "../../apps/controller/src/drivers/compute/containerd/executor.ts";
import { validateConfiguration } from "../../apps/controller/src/drivers/compute/containerd/schema.ts";
import {
  agentContainerName,
  gatewayContainerName,
  workspaceVolumes,
} from "../../apps/controller/src/drivers/compute/containerd/spec.ts";
import { FilesystemSecretDriver } from "../../apps/controller/src/drivers/secret/filesystem/index.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const { setup, cleanup } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

/**
 * A helper that owns an engine in a file. It records every request and answers from the state the
 * earlier requests created, so a container a `run-container` call started is one a later
 * `inspect-container` call finds running — the same round trip the real helper performs. The
 * engine is the external dependency this suite stands in for; every line of Driver and worker
 * code between the test and this process runs for real.
 */
const STUB_HELPER_PROGRAM = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const LOG = __LOG__;
const STATE = __STATE__;
function matches(labels, selector) {
  if (!selector) return true;
  return selector.split(",").every((pair) => {
    const [key, value] = pair.split("=");
    return labels[key] === value;
  });
}
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  fs.appendFileSync(LOG, JSON.stringify(request) + "\n");
  const state = fs.existsSync(STATE)
    ? JSON.parse(fs.readFileSync(STATE, "utf8"))
    : { containers: {}, volumes: {}, networks: {} };
  const spec = request.input || {};
  let output = {};
  switch (request.operation) {
    case "preflight":
      output = {
        rootless: true,
        version: "2.4.1",
        images: Object.fromEntries(Object.keys(spec.images || {}).map((name) => [name, "present"])),
      };
      break;
    case "list-containers": {
      const names = Object.values(state.containers)
        .filter((container) => matches(container.labels, spec.labelSelector))
        .map((container) => container.name);
      output = {
        names,
        labels: Object.fromEntries(names.map((name) => [name, state.containers[name].labels])),
      };
      break;
    }
    case "ensure-network":
      output = { created: state.networks[spec.name] === undefined, labels: spec.labels };
      state.networks[spec.name] = { labels: spec.labels };
      break;
    case "ensure-volume":
      output = { created: state.volumes[spec.name] === undefined, labels: spec.labels };
      state.volumes[spec.name] = { labels: spec.labels };
      break;
    case "run-container": {
      const publish = (spec.publish || [])[0];
      const ports = publish
        ? { [publish.containerPort + "/tcp"]: publish.hostIp + ":" + publish.hostPort }
        : {};
      state.containers[spec.name] = {
        name: spec.name,
        labels: spec.labels,
        running: true,
        ports,
        image: spec.image,
      };
      output = { running: true, ports };
      break;
    }
    case "run-to-completion":
      state.containers[spec.name] = {
        name: spec.name,
        labels: spec.labels,
        running: false,
        ports: {},
        image: spec.image,
      };
      output = { running: false, exitCode: 0 };
      break;
    case "inspect-container": {
      const container = state.containers[spec.name];
      output = container
        ? {
            exists: true,
            running: container.running,
            labels: container.labels,
            ports: container.ports,
            image: container.image,
            imageId: "sha256:" + "0".repeat(64),
            containerId: "container-" + spec.name,
            health: container.running ? "ready" : "stopped",
          }
        : { exists: false };
      break;
    }
    case "stop-container": {
      const container = state.containers[spec.name];
      if (container) { container.running = false; }
      output = {};
      break;
    }
    case "remove-container":
      delete state.containers[spec.name];
      output = {};
      break;
    case "remove-volumes":
      state.volumes = {};
      output = {};
      break;
    case "remove-network":
      delete state.networks[spec.name];
      output = {};
      break;
    case "read-logs":
      output = { lines: [], nextCursor: null };
      break;
    default:
      output = {};
  }
  fs.writeFileSync(STATE, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ ok: true, output }));
});
`;

async function stubHelper(directory) {
  const log = join(directory, "requests.jsonl");
  const path = join(directory, "compute-containerd");
  await writeFile(
    path,
    STUB_HELPER_PROGRAM.replace("__LOG__", JSON.stringify(log)).replace(
      "__STATE__",
      JSON.stringify(join(directory, "engine.json")),
    ),
    { encoding: "utf8", mode: 0o755 },
  );
  return { path, log };
}

/** Every request the worker's delivery sent to the engine, in order. */
async function helperRequests(log) {
  const content = await readFile(log, "utf8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function containerdConfiguration(helperPath, credentialsDirectory) {
  return {
    helper: { path: helperPath, timeoutSeconds: 180 },
    containerd: { namespace: "openclaw-enterprise" },
    images: {
      gateway: `registry.example/gateway@${DIGEST}`,
      agent: `registry.example/agent@${DIGEST}`,
      requireImmutableDigest: true,
    },
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

test(
  "the worker delivers an Agent through the rootless containerd Compute Driver",
  requiresPostgres,
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "containerd-workflow-"));
    const credentials = join(root, "credentials");
    const helper = await stubHelper(root);
    const driver = new ContainerdComputeDriver(
      validateConfiguration(containerdConfiguration(helper.path, credentials)),
      { executor: new SystemContainerdHelperExecutor() },
    );
    const fixture = await setup(context, { computeDriver: driver });

    const { owner, candidate } = await fixture.admitInitialRevision("containerd worker delivery", {
      agent: { auth: "runtime" },
    });
    const credentialPath = gatewayPasswordPath(credentials, {
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
    });
    // Admitting an Agent provisions nothing: what the Driver says it requires is provisioned when
    // a revision is deployed.
    assert.equal(existsSync(credentialPath), false);

    const events = [];
    await fixture.start(driver, { emit: (event) => events.push(event) });
    assert.deepEqual(events.at(-1), {
      event: "worker.started",
      computeDriverId: "compute-containerd",
    });

    // The delivery is only done when the worker has recorded an outcome for that revision.
    const result = await waitFor(
      "the worker to record the revision's outcome",
      async () => {
        const rows = (await fixture.workResult(candidate)).rows;
        return rows[0]?.reason_code === undefined || rows[0]?.reason_code === null
          ? undefined
          : rows[0];
      },
      60_000,
    );

    const requests = await helperRequests(helper.log);
    const operations = requests.map((request) => request.operation);

    // The worker's own startup preflight comes first; the delivery then decides the budget before
    // it creates anything.
    const delivery = operations.filter((name) => name !== "preflight");
    assert.equal(delivery[0], "list-containers");
    // Retries converge on the same two planes and two volumes; the invariant is the distinct
    // resources, not how many attempts it took to reach them.
    const named = (operation) =>
      new Set(
        requests
          .filter((request) => request.operation === operation)
          .map((request) => request.input.name),
      );
    assert.equal(named("ensure-network").size, 2, [...named("ensure-network")].join(", "));
    assert.equal(named("ensure-volume").size, 2, [...named("ensure-volume")].join(", "));
    for (const request of requests.filter((entry) => entry.operation === "ensure-network")) {
      assert.equal(
        request.input.labels["org.openclaw.enterprise.namespace-id"],
        fixture.namespace.id,
      );
    }
    assert.ok(delivery.includes("run-to-completion"), "storage is prepared before the runtime");
    assert.ok(
      delivery.indexOf("run-to-completion") < delivery.indexOf("run-container"),
      "the runtime starts after storage preparation",
    );

    const gateway = requests.find((request) => request.operation === "run-container");
    assert.equal(gateway.engine.namespaceName, "openclaw-enterprise");
    assert.equal(gateway.input.image, `registry.example/gateway@${DIGEST}`);
    assert.equal(gateway.input.labels["org.openclaw.enterprise.role"], "gateway");
    assert.equal(
      gateway.input.labels["org.openclaw.enterprise.namespace-id"],
      fixture.namespace.id,
    );
    assert.equal(gateway.input.labels["org.openclaw.enterprise.agent-id"], owner.id);
    // The engine and the outcome of the delivery, recorded for the run's evidence.
    console.log(
      "delivery outcome:",
      result.reason_code,
      JSON.stringify(result.result_data ?? null).slice(0, 200),
    );
    // The Installation's limits reach the engine, converted from their Kubernetes quantities.
    assert.deepEqual(gateway.input.limits, { memoryBytes: 3 * 1024 ** 3, cpus: 4 });
    // Deployment provisioned the Agent's credential through the platform, and that value is what
    // the runtime is handed.
    assert.equal(existsSync(credentialPath), true, "deploying must provision the credential");
    assert.equal(
      gateway.input.env.OPENCLAW_GATEWAY_PASSWORD,
      (await readFile(credentialPath, "utf8")).trim(),
    );
    // The delivery succeeded end to end: the Agent reached an active revision, and the engine
    // holds the container that serves it. A recorded failure here would mean the worker only
    // called the Driver, not that it deployed the Agent.
    assert.equal(
      result.reason_code,
      "REVISION_ACTIVATED",
      JSON.stringify(result.result_data ?? null),
    );
    assert.equal(
      (await fixture.activePointer(owner)).rows[0]?.active_revision_id,
      candidate.id,
      "the Agent must be serving the revision the worker just delivered",
    );
    assert.equal(
      (await fixture.deploymentStatus(owner, candidate)).status,
      "succeeded",
      "the platform must observe the delivered revision as a succeeded deployment",
    );
    // The container the worker delivered is the one the engine now reports running.
    assert.ok(
      requests.some(
        (request) =>
          request.operation === "run-container" &&
          request.input.labels["org.openclaw.enterprise.role"] === "gateway",
      ),
    );
  },
);

/** Waits for one revision's work to settle, whatever terminal state it reaches. */
async function settledWork(fixture, candidate, timeoutMs = 60_000) {
  return waitFor(
    `revision ${candidate.id} work to settle`,
    async () => {
      const row = (
        await fixture.observerPool.query(
          "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
          [candidate.idempotencyKey],
        )
      ).rows[0];
      return row !== undefined && ["succeeded", "failed", "failed_permanent"].includes(row.state)
        ? row
        : undefined;
    },
    timeoutMs,
  );
}

/** The synthetic ChatGPT bundle a staged Codex device login carries. Never a real credential. */
const OAUTH_BUNDLE = Object.freeze({
  auth_mode: "chatgpt",
  tokens: {
    id_token: "synthetic-id-token",
    access_token: "synthetic-access-token",
    refresh_token: "synthetic-refresh-token",
  },
});

/** One staged login, shaped as the platform's device-authorization flow leaves it in the store. */
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

/** The Secret row the platform persisted, as the worker resolves it for the Driver. */
function stagedSecretRecord(fixture, owner) {
  return fixture.state.read((view) =>
    view.secrets.findSecret(fixture.namespace.id, owner.harnessAuth.source.id),
  );
}

/** Starts one worker delivery fixture whose Secret Driver is the real filesystem store. */
async function oauthFixture(context, label) {
  const root = await mkdtemp(join(tmpdir(), `containerd-${label}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const secrets = join(root, "secrets");
  const secretDriver = new FilesystemSecretDriver({ directory: secrets });
  const helper = await stubHelper(root);
  const configuration = containerdConfiguration(helper.path, join(root, "credentials"));
  // These cases admit more than one Agent into one Namespace, and a delivery is refused when the
  // Namespace budget has no room for it. Raise the quota so a refusal can only come from the
  // credential under test, never from capacity.
  configuration.resources.namespace.quota = { "limits.cpu": "32", "limits.memory": "32Gi" };
  const driver = new ContainerdComputeDriver(validateConfiguration(configuration), {
    executor: new SystemContainerdHelperExecutor(),
    // Composition injects the selected Secret Driver's store; the operator never repeats it.
    secretStore: { directory: secrets },
  });
  const fixture = await setup(context, { computeDriver: driver, secretDriver });
  const { owner, candidate } = await fixture.admitInitialRevision(label, {
    agent: {
      executionMode: "dedicated",
      auth: "oauth",
      oauthSession: stagedLoginSession(fixture.namespace.id),
    },
    revision: {
      configuration: {
        agents: { defaults: { model: "gpt-6-luna", workspace: "/home/node/workspace" } },
        gateway: { mode: "local", bind: "lan" },
      },
    },
  });
  return { root, secrets, secretDriver, helper, driver, fixture, owner, candidate };
}

test(
  "the worker hands a staged Codex login to the harness's own home and consumes it exactly once",
  requiresPostgres,
  async (context) => {
    const { secretDriver, helper, driver, fixture, owner, candidate } = await oauthFixture(
      context,
      "oauth",
    );
    const staged = await stagedSecretRecord(fixture, owner);
    await fixture.start(driver);

    const result = await waitFor(
      "the worker to deliver the dedicated Codex revision",
      async () => {
        const rows = (await fixture.workResult(candidate)).rows;
        return rows[0]?.reason_code ? rows[0] : undefined;
      },
      60_000,
    );
    assert.equal(
      result.reason_code,
      "REVISION_ACTIVATED",
      JSON.stringify(result.result_data ?? null),
    );
    assert.equal(
      (await fixture.activePointer(owner)).rows[0]?.active_revision_id,
      candidate.id,
      "an Agent delivered from a staged login must reach an active revision",
    );

    const requests = await helperRequests(helper.log);
    const volumes = workspaceVolumes({ namespaceId: fixture.namespace.id, agentId: owner.id });
    const seeders = requests.filter(
      (request) =>
        request.operation === "run-to-completion" &&
        String(request.input.name).endsWith("-oauth-seed"),
    );
    // Exactly one seed: the platform's staged login is spent on this Agent's own Codex home, and
    // a retry of the same delivery must never seed it a second time.
    assert.equal(seeders.length, 1, "one delivery seeds one Codex home");
    const seed = seeders[0].input;
    assert.equal(
      seed.env.OCE_CODEX_OAUTH_SOURCE_UID,
      staged.backendRef.uid,
      "the receipt names the Secret identity the platform staged",
    );
    assert.deepEqual(seed.mounts[0], { volume: volumes.codexHome, target: "/home/node/.codex" });
    assert.equal(seed.mounts[1].readOnly, true, "the login travels from a read-only mount");
    // The credential never travels through argv or the environment, where any process on the
    // host could read it back.
    for (const value of [JSON.stringify(seed.args), JSON.stringify(seed.env)]) {
      assert.ok(
        !value.includes(OAUTH_BUNDLE.tokens.refresh_token),
        "the bundle must not reach argv or an environment variable",
      );
    }

    const agent = requests.find(
      (request) =>
        request.operation === "run-container" &&
        request.input.labels["org.openclaw.enterprise.role"] === "agent",
    );
    assert.ok(agent, "a dedicated Codex harness is its own container");
    assert.equal(agent.input.env.CODEX_LOGIN_MODE, "oauth");
    assert.equal(agent.input.env.CODEX_HOME, "/home/node/.codex");
    assert.deepEqual(
      agent.input.mounts.map((mount) => mount.volume),
      [volumes.codexHome, volumes.workspace],
      "the harness owns the Codex home and nothing else does",
    );
    assert.equal(
      agent.input.env.OCE_CODEX_OAUTH_VOLUME_UID,
      seed.env.OCE_CODEX_OAUTH_VOLUME_UID,
      "the harness presents the receipt the seeder wrote",
    );

    // The gateway serves clients and reaches the harness; it must never mount or name the login.
    const gateway = requests.find(
      (request) =>
        request.operation === "run-container" &&
        request.input.labels["org.openclaw.enterprise.role"] === "gateway",
    );
    for (const name of [
      "CODEX_HOME",
      "CODEX_LOGIN_MODE",
      "OCE_CODEX_OAUTH_SOURCE_UID",
      "OCE_CODEX_OAUTH_VOLUME_UID",
    ]) {
      assert.equal(gateway.input.env[name], undefined, `${name} must not reach the gateway`);
    }
    for (const mount of gateway.input.mounts ?? []) {
      assert.notEqual(
        mount.volume,
        volumes.codexHome,
        "the gateway must not mount the harness's Codex home",
      );
    }

    // The staged copy is spent: the deployed Codex refreshes its own tokens on the private
    // volume, and the platform can never read the login back.
    const consumed = JSON.parse(await secretDriver.withValue(staged, (value) => value));
    assert.equal(consumed.phase, "consumed");
    assert.equal(consumed.agentId, owner.id);
    assert.equal(
      consumed.credential,
      undefined,
      "the credential must not survive consumption in Secret storage",
    );
    assert.equal(
      consumed.volumeUid,
      seed.env.OCE_CODEX_OAUTH_VOLUME_UID,
      "the marker records the Codex home the bundle was written to",
    );
  },
);

test(
  "a consumed or lost staged login is refused and leaves no half-provisioned Agent",
  requiresPostgres,
  async (context) => {
    const { secretDriver, helper, driver, fixture, owner, candidate } = await oauthFixture(
      context,
      "oauth-failure",
    );
    const staged = await stagedSecretRecord(fixture, owner);
    await fixture.start(driver);
    await fixture.work(candidate, "succeeded", 60_000);
    assert.equal(
      JSON.parse(await secretDriver.withValue(staged, (value) => value)).phase,
      "consumed",
    );

    // A second Agent may not claim the login the first one already spent, even though the Secret
    // row still exists: the platform must fail closed rather than start a harness it cannot log in.
    const second = await fixture.admitInitialRevision("second codex", {
      agent: {
        executionMode: "dedicated",
        auth: "oauth",
        oauthSecretId: staged.id,
      },
    });
    const secondResult = await settledWork(fixture, second.candidate);
    // A semantic refusal is permanent: the Driver marks it so, the worker stops on attempt 1, and
    // the platform reports the Driver's own cause instead of a retryable dependency failure.
    assert.equal(secondResult.state, "failed_permanent", JSON.stringify(secondResult));
    assert.equal(secondResult.reason_code, "CONTAINERD_CONFIGURATION_INVALID");
    assert.equal(
      secondResult.attempt_count,
      1,
      "a permanent refusal must not spend the retry budget",
    );
    assert.equal(
      (await fixture.activePointer(second.owner)).rows[0]?.active_revision_id,
      null,
      "an Agent that could not consume its login must never become active",
    );

    // Losing the Secret Driver's copy under a live Secret row is a failed handoff, not a silent
    // one: the delivery must refuse instead of starting an unauthenticated harness.
    const third = await fixture.admitInitialRevision("lost codex", {
      agent: {
        executionMode: "dedicated",
        auth: "oauth",
        oauthSession: stagedLoginSession(fixture.namespace.id),
      },
    });
    const thirdSecret = await stagedSecretRecord(fixture, third.owner);
    await secretDriver.delete(thirdSecret);
    const thirdResult = await settledWork(fixture, third.candidate);
    assert.equal(thirdResult.state, "failed_permanent", JSON.stringify(thirdResult));
    assert.equal(thirdResult.reason_code, "CONTAINERD_CONFIGURATION_INVALID");
    assert.equal(
      thirdResult.attempt_count,
      1,
      "a permanent refusal must not spend the retry budget",
    );
    assert.equal(
      (await fixture.activePointer(third.owner)).rows[0]?.active_revision_id,
      null,
      "a failed login delivery must not leave an active Agent behind",
    );

    // Neither refused delivery reached the engine to start a harness, and neither left one behind:
    // a half-provisioned Agent is worse than a refused one.
    const requests = await helperRequests(helper.log);
    for (const refused of [second.owner.id, third.owner.id]) {
      assert.ok(
        !requests.some(
          (request) =>
            request.operation === "run-container" &&
            request.input.labels["org.openclaw.enterprise.agent-id"] === refused,
        ),
        `no harness may start for the refused Agent ${refused}`,
      );
    }
  },
);

// --- The real engine: the same workflow, with no stub at all ----------------------------------
// The cases above stand in for the engine. These select the host's rootless containerd directly,
// so they are opt-in and need the same prepared PostgreSQL lane as the cases above.
//
// They are registered only when their selector is present, because this file belongs to the
// prepared application lane, whose preparation can supply a database but not a rootless engine.
// A selected file that reports a skipped case fails that lane, and the engine cases cannot run
// there: with the selector set they run as part of the same file (see docs/testing/containerd.md).

const REAL_ENGINE = process.env.OCC_TEST_CONTAINERD_REAL === "1";
const REAL_HELPER =
  process.env.OCC_TEST_CONTAINERD_HELPER ?? join(process.cwd(), "bin/compute-containerd");
const REAL_IMAGE = process.env.OCC_TEST_CONTAINERD_IMAGE ?? "local/oce-gateway:dev";
const REAL_NAMESPACE = process.env.OCC_TEST_CONTAINERD_NAMESPACE ?? "openclaw-enterprise";
const run = promisify(execFile);

async function nerdctl(args) {
  const { stdout } = await run("nerdctl", ["-n", REAL_NAMESPACE, ...args]);
  return stdout;
}

if (REAL_ENGINE) {
  test(
    "the worker deploys, serves, logs and retires an Agent on the real containerd engine",
    requiresPostgres,
    async (context) => {
      await access(REAL_HELPER).catch(() => {
        throw new Error(`build the helper first (pnpm helper:containerd:build): ${REAL_HELPER}`);
      });
      const root = await mkdtemp(join(tmpdir(), "containerd-real-workflow-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      const configuration = containerdConfiguration(REAL_HELPER, join(root, "credentials"));
      // A locally built image carries no digest, so this opt-in lane runs it as a mutable reference;
      // production keeps the Installation's immutable-digest policy.
      configuration.images = {
        gateway: REAL_IMAGE,
        agent: REAL_IMAGE,
        requireImmutableDigest: false,
      };
      configuration.containerd.namespace = REAL_NAMESPACE;
      const driver = new ContainerdComputeDriver(validateConfiguration(configuration), {
        executor: new SystemContainerdHelperExecutor(),
      });
      const fixture = await setup(context, { computeDriver: driver });
      const { owner, candidate } = await fixture.admitInitialRevision("real containerd delivery", {
        agent: { auth: "runtime" },
        revision: {
          configuration: {
            agents: { defaults: { model: "gpt-6-luna", workspace: "/home/node/workspace" } },
            // Without an explicit local gateway mode the runtime refuses to start; without a LAN
            // bind the published loopback port reaches nothing. Both are Agent Configuration.
            gateway: { mode: "local", bind: "lan" },
          },
        },
      });

      await fixture.start(driver);
      const result = await waitFor(
        "the worker to activate the real revision",
        async () => {
          const row = (await fixture.workResult(candidate)).rows[0];
          return row?.reason_code ? row : undefined;
        },
        180_000,
      );
      assert.equal(
        result.reason_code,
        "REVISION_ACTIVATED",
        JSON.stringify(result.result_data ?? null),
      );
      assert.equal(
        (await fixture.activePointer(owner)).rows[0]?.active_revision_id,
        candidate.id,
        "the real engine must carry an Agent that reaches an active revision",
      );

      // Namespace infrastructure and the runtime are engine objects the worker created, labelled
      // for this exact Namespace and Agent rather than for the test.
      const infra = await nerdctl([
        "network",
        "ls",
        "--filter",
        `label=org.openclaw.enterprise.namespace-id=${fixture.namespace.id}`,
        "--format",
        "{{.Name}}",
      ]);
      assert.equal(infra.trim().split("\n").filter(Boolean).length, 2, infra);
      const containers = await nerdctl([
        "ps",
        "--filter",
        `label=org.openclaw.enterprise.agent-id=${owner.id}`,
        "--format",
        "{{.Names}}",
      ]);
      assert.equal(containers.trim().split("\n").filter(Boolean).length, 1, containers);

      // The endpoint the worker resolved answers from the host: the workload is serving, not just
      // present.
      const endpoint = driver.getGatewayEndpoint(candidate);
      assert.match(endpoint ?? "", /^ws:\/\/127\.0\.0\.1:\d+\/$/);
      const reachable = await fetch(`http://127.0.0.1:${new URL(endpoint).port}/healthz`);
      assert.equal(reachable.status, 200, "the published loopback port must answer");

      // Logs come back from the engine's own log store through the Driver the worker used. The
      // reader takes the platform's own binding: the same object the API hands a Compute Driver.
      const binding = {
        namespace: fixture.namespace,
        agent: await fixture.currentAgent(owner),
        revision: candidate,
      };
      const described = await driver.describeAgentRuntime(candidate, new AbortController().signal);
      const logs = await driver.readAgentRuntimeLogs(binding, {
        source: "gateway",
        pod: described.pods[0].name,
        podUid: described.pods[0].uid,
        container: "gateway",
        previous: false,
        tailLines: 20,
        limitBytes: 8192,
        signal: new AbortController().signal,
      });
      assert.ok(logs.lines.length > 0, "the runtime's own output must be readable");

      // Deleting the Agent retires its containers through the platform lifecycle, and the
      // Namespace teardown that follows releases the volumes and planes it created.
      await fixture.requestDeletion(owner);
      // Deletion is done when the Agent is gone from platform state, exactly as the teardown
      // suite observes it; the work row's own key is an implementation detail of that path.
      await waitFor(
        `Agent ${owner.id} deletion`,
        async () => ((await fixture.currentAgent(owner)) === undefined ? true : undefined),
        180_000,
      );
      const remaining = await nerdctl([
        "ps",
        "-a",
        "--filter",
        `label=org.openclaw.enterprise.agent-id=${owner.id}`,
        "--format",
        "{{.Names}}",
      ]);
      assert.equal(remaining.trim(), "", "retiring an Agent must leave no container of its own");
      const removed = await driver.deleteNamespace({
        id: fixture.namespace.id,
        name: fixture.namespace.name,
      });
      assert.equal(removed.namespaceDeleted, true, JSON.stringify(removed));
    },
  );
}

// --- The provider key: the model credential a dedicated Codex harness executes turns with ------
// The credential is the operator's own, so this case is opt-in twice over: the real-engine
// selector plus the provider credential and model the other real-runtime lanes already require.
// Everything else — the platform's Secret staging, the worker's admission and delivery, the
// engine, and the Codex harness's own login and model probe — runs for real.

const REAL_MODEL = process.env.OCC_TEST_OPENAI_MODEL;
const REAL_PROVIDER_KEY = process.env.OPENAI_API_KEY;

function containerEnvironment(container) {
  return container.Config.Env;
}

if (REAL_ENGINE && REAL_MODEL !== undefined && REAL_PROVIDER_KEY !== undefined) {
  test(
    "the worker hands a staged provider key to a dedicated Codex harness that completes a real model turn",
    requiresPostgres,
    async (context) => {
      await access(REAL_HELPER).catch(() => {
        throw new Error(`build the helper first (pnpm helper:containerd:build): ${REAL_HELPER}`);
      });
      const root = await mkdtemp(join(tmpdir(), "containerd-real-provider-key-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      // Composition injects the selected Secret Driver's store; the platform stages the key there
      // and the revision carries only the reference it resolved.
      const secrets = join(root, "secrets");
      const secretDriver = new FilesystemSecretDriver({ directory: secrets });
      const configuration = containerdConfiguration(REAL_HELPER, join(root, "credentials"));
      configuration.images = {
        gateway: REAL_IMAGE,
        agent: REAL_IMAGE,
        requireImmutableDigest: false,
      };
      configuration.containerd.namespace = REAL_NAMESPACE;
      const driver = new ContainerdComputeDriver(validateConfiguration(configuration), {
        executor: new SystemContainerdHelperExecutor(),
        secretStore: { directory: secrets },
      });
      const fixture = await setup(context, { computeDriver: driver, secretDriver });
      const { owner, candidate } = await fixture.admitInitialRevision("real provider key", {
        agent: {
          executionMode: "dedicated",
          auth: "secret",
          secretValue: REAL_PROVIDER_KEY,
        },
        revision: {
          configuration: {
            // The shared Codex runtime logs in with this provider's key and probes the exact model
            // the configuration selects. The runtime is declared explicitly, as the platform's own
            // standard-codex preset does and as the HTTP validation requires for a provider model:
            // a model that could run on either harness must name the one it runs on.
            agents: {
              defaults: {
                model: `codex/${REAL_MODEL}`,
                models: { [`codex/${REAL_MODEL}`]: { agentRuntime: { id: "codex" } } },
                workspace: "/home/node/workspace",
              },
            },
            models: {
              providers: {
                codex: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
              },
            },
            gateway: { mode: "local", bind: "lan" },
          },
        },
      });

      await fixture.start(driver);
      const result = await waitFor(
        "the worker to activate the provider-key revision",
        async () => {
          const row = (await fixture.workResult(candidate)).rows[0];
          return row?.reason_code === "REVISION_ACTIVATED" ? row : undefined;
        },
        300_000,
      );
      assert.equal(
        result.reason_code,
        "REVISION_ACTIVATED",
        JSON.stringify(result.result_data ?? null),
      );
      assert.equal(
        (await fixture.activePointer(owner)).rows[0]?.active_revision_id,
        candidate.id,
        "an Agent authenticating with a provider key must reach an active revision",
      );

      // The key landed in exactly one container, and the test never writes it anywhere.
      const ownership = {
        namespaceId: fixture.namespace.id,
        agentId: owner.id,
        revisionId: candidate.id,
      };
      const [harness] = JSON.parse(
        (await run("nerdctl", ["-n", REAL_NAMESPACE, "inspect", agentContainerName(ownership)]))
          .stdout,
      );
      const harnessEnvironment = containerEnvironment(harness);
      // The environment must hold the key this test staged, compared as the actual material. The
      // membership assertion carries the value for comparison but prints only its own message when
      // it fails, so a real credential never reaches the log.
      assert.ok(
        harnessEnvironment.includes(`OPENAI_API_KEY=${REAL_PROVIDER_KEY}`),
        "the harness environment must hold exactly the provider key the platform staged",
      );
      assert.ok(harnessEnvironment.includes("CODEX_LOGIN_MODE=api_key"));
      assert.ok(harnessEnvironment.includes("CODEX_HOME=/home/node/.codex"));
      assert.ok(
        !harness.Args.join("\n").includes(REAL_PROVIDER_KEY),
        "the key must never travel as a container argument",
      );

      const [gateway] = JSON.parse(
        (
          await run("nerdctl", [
            "-n",
            REAL_NAMESPACE,
            "inspect",
            gatewayContainerName(fixture.namespace.id, owner.id),
          ])
        ).stdout,
      );
      assert.ok(
        !containerEnvironment(gateway).some((entry) => entry.startsWith("OPENAI_API_KEY=")),
        "the key must never reach the gateway that serves clients",
      );

      // The harness's own startup evidence. `codex.model_probe` reports READY only after one real
      // turn completed: the runtime runs `codex exec` with an authorized model, requires exactly one
      // `turn.started`/`turn.completed` pair and a non-empty `agent_message`, and withholds its
      // readiness until then. The revision could not have activated without that turn.
      const binding = {
        namespace: fixture.namespace,
        agent: await fixture.currentAgent(owner),
        revision: candidate,
      };
      const described = await driver.describeAgentRuntime(candidate, new AbortController().signal);
      const logs = await driver.readAgentRuntimeLogs(binding, {
        source: "agent",
        pod: described.pods[0].name,
        podUid: described.pods[0].uid,
        container: "agent",
        previous: false,
        tailLines: 1000,
        limitBytes: 1_048_576,
        signal: new AbortController().signal,
      });
      const events = logs.lines
        .map((line) => {
          try {
            return JSON.parse(line.raw);
          } catch {
            return undefined;
          }
        })
        .filter((event) => event !== undefined);
      const login = events.find(
        (event) => event.event === "runtime.startup_phase" && event.phase === "codex-login",
      );
      assert.equal(
        login?.outcome,
        "ok",
        `codex-login must succeed from the delivered key: ${JSON.stringify(login)}`,
      );
      const modelProbe = events.find((event) => event.event === "codex.model_probe");
      assert.equal(
        modelProbe?.code,
        "READY",
        `the model probe must complete a real turn: ${JSON.stringify(modelProbe)}`,
      );
      const probePhase = events.find(
        (event) => event.event === "runtime.startup_phase" && event.phase === "model-probe",
      );
      assert.equal(probePhase?.outcome, "ok");
      const agentTurn = events.find(
        (event) => event.event === "runtime.startup_phase" && event.phase === "native-spawn",
      );
      assert.equal(
        agentTurn?.outcome,
        "ok",
        "the authenticated app-server must start its turn loop",
      );
      // The evidence records the phases, the probe's outcome and timings; it carries no credential.
      console.log(
        "provider-key delivery:",
        JSON.stringify({ login, modelProbe, probePhase, agentTurn }),
      );

      // Deleting the Agent retires the harness, and the Namespace teardown releases the volumes.
      await fixture.requestDeletion(owner);
      await waitFor(
        `Agent ${owner.id} deletion`,
        async () => ((await fixture.currentAgent(owner)) === undefined ? true : undefined),
        180_000,
      );
      const removed = await driver.deleteNamespace({
        id: fixture.namespace.id,
        name: fixture.namespace.name,
      });
      assert.equal(removed.namespaceDeleted, true, JSON.stringify(removed));
    },
  );
}
