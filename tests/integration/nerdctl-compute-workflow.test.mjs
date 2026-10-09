// End-to-end proof of the rootless nerdctl Compute Driver through its real caller: the
// production worker, PostgreSQL platform state, and the real work queue. The container engine is
// the external dependency, so a stub helper stands at the Driver's configured path and answers
// the wire protocol; every line of Driver code between the worker and that path runs for real.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { NerdctlComputeDriver } from "../../apps/controller/src/drivers/compute/nerdctl/index.ts";
import { gatewayPasswordPath } from "../../apps/controller/src/drivers/compute/nerdctl/credentials.ts";
import { SystemNerdctlHelperExecutor } from "../../apps/controller/src/drivers/compute/nerdctl/executor.ts";
import { validateConfiguration } from "../../apps/controller/src/drivers/compute/nerdctl/schema.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const { setup, cleanup } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

/**
 * A helper that answers the wire protocol without an engine. It records every request, so the
 * test can assert what the worker's delivery actually asked the engine to do.
 */
async function stubHelper(directory) {
  const log = join(directory, "requests.jsonl");
  const path = join(directory, "compute-nerdctl");
  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(request) + "\\n");
  const images = Object.fromEntries(
    Object.keys((request.input && request.input.images) || {}).map((name) => [name, "present"]),
  );
  const answers = {
    preflight: { ok: true, output: { rootless: true, version: "2.4.1", images } },
    "list-containers": { ok: true, output: { names: [], labels: {} } },
    "ensure-network": { ok: true, output: { created: true, labels: request.input.labels } },
    "ensure-volume": { ok: true, output: { created: true, labels: request.input.labels } },
    "run-to-completion": { ok: true, output: { running: false, exitCode: 0 } },
    "run-container": { ok: true, output: { running: true, ports: { "8080/tcp": "127.0.0.1:18099" } } },
    "stop-container": { ok: true, output: {} },
    "remove-container": { ok: true, output: {} },
  };
  process.stdout.write(JSON.stringify(answers[request.operation] || { ok: true, output: {} }));
});
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return { path, log };
}

function nerdctlConfiguration(helperPath, credentialsDirectory) {
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
  "the worker delivers an Agent through the rootless nerdctl Compute Driver",
  requiresPostgres,
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "nerdctl-workflow-"));
    const credentials = join(root, "credentials");
    const helper = await stubHelper(root);
    const driver = new NerdctlComputeDriver(
      validateConfiguration(nerdctlConfiguration(helper.path, credentials)),
      { executor: new SystemNerdctlHelperExecutor() },
    );
    const fixture = await setup(context, { computeDriver: driver });

    const { owner, candidate } = await fixture.admitInitialRevision("nerdctl worker delivery", {
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
      computeDriverId: "compute-nerdctl",
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

    const requests = (await readFile(helper.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
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
    assert.equal(typeof result.reason_code, "string");
  },
);
