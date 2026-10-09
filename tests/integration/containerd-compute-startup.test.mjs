import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { ContainerdComputeDriver } from "../../apps/controller/src/drivers/compute/containerd/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;

function installation() {
  const value = createInstallationDriverConfiguration();
  value.drivers.compute = {
    id: "compute-containerd",
    configuration: {
      helper: { path: "/usr/local/bin/compute-containerd", timeoutSeconds: 180 },
      containerd: { namespace: "openclaw-enterprise" },
      images: {
        gateway: `registry.example/gateway@${DIGEST}`,
        agent: `registry.example/agent@${DIGEST}`,
        requireImmutableDigest: true,
      },
      credentials: { directory: "/var/lib/oce-containerd/credentials" },
      egress: {
        port: 3128,
        proxyImage: `registry.example/proxy@${DIGEST}`,
        allowlist: ["registry.npmjs.org"],
      },
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
    },
  };
  return value;
}

/** The same Installation plus the OpenShell sandbox and credential path, as it must compose. */
function sandboxInstallation() {
  const value = installation();
  value.backend = [
    {
      id: "openshell",
      type: "openshell",
      configuration: {
        endpoint: "http://127.0.0.1:17670",
        auth: { mode: "unauthenticated" },
        insecureTransport: "network-policy",
      },
      drivers: { sandbox: "openshell-sandbox", credential_gateway: "openshell-credentials" },
    },
  ];
  value.drivers.sandbox = {
    id: "openshell-sandbox",
    configuration: {
      // A non-Kubernetes Compute Driver has no object client, so the Gateway owns the Workspace.
      gateway: { workspaceMode: "managed" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model-egress",
            endpoints: [{ host: "api.openai.com", ports: [443] }],
            binaries: [{ path: "/app/bin/model-client" }],
          },
        ],
      },
    },
  };
  value.drivers.credential_gateway = {
    id: "openshell-credentials",
    configuration: { binaries: ["/app/bin/model-client"] },
  };
  return value;
}

test("containerd startup selects occ/containerd in production and constructs a worker", async (t) => {
  const drivers = await loadInstallationFile(t, installation());
  assert.ok(drivers.computeDriver instanceof ContainerdComputeDriver);
  assert.equal(drivers.computeDriver.id, "compute-containerd");
  assert.equal(drivers.computeDriver.implementation, "occ/containerd");
  assert.equal(drivers.installation.drivers.compute.implementation, "occ/containerd");
  // Construction proves production structural acceptance; it does not reach the engine.
  const pool = new pg.Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  t.after(() => pool.end());
  assert.doesNotThrow(() =>
    createControllerWorker({ pool, mode: "production", drivers, emit: () => {} }),
  );
  assert.ok(
    (await loadInstallationFile(t, installation(), { mode: "development" }))
      .computeDriver instanceof ContainerdComputeDriver,
  );
});

test("containerd startup pairs the bundled OpenShell Sandbox with a non-Kubernetes Compute Driver", async (t) => {
  const drivers = await loadInstallationFile(t, sandboxInstallation());
  assert.ok(drivers.computeDriver instanceof ContainerdComputeDriver);
  assert.equal(drivers.installation.drivers.sandbox.id, "openshell-sandbox");
  assert.equal(drivers.installation.drivers.credential_gateway.id, "openshell-credentials");
  // The pairing is injected into the Compute Driver, so the same document composes in the
  // development profile and is admitted in production.
  assert.ok(
    (await loadInstallationFile(t, sandboxInstallation(), { mode: "development" }))
      .computeDriver instanceof ContainerdComputeDriver,
  );

  const operatorMode = sandboxInstallation();
  operatorMode.drivers.sandbox.configuration.gateway.workspaceMode = "operator";
  await assert.rejects(
    loadInstallationFile(t, operatorMode),
    /drivers\.sandbox with compute-containerd requires gateway\.workspaceMode: managed/,
  );

  // A bare Service name only resolves inside a Kubernetes Sandbox namespace.
  const serviceName = sandboxInstallation();
  delete serviceName.backend[0].configuration.endpoint;
  serviceName.backend[0].configuration.serviceName = "openshell-gateway";
  await assert.rejects(
    loadInstallationFile(t, serviceName),
    /openshell backend with compute-containerd requires an explicit gateway endpoint/,
  );

  // A Credential Gateway cannot be left unpaired: its owning openshell backend must name the
  // Sandbox Driver the Installation also selects.
  const unpaired = sandboxInstallation();
  delete unpaired.drivers.sandbox;
  await assert.rejects(
    loadInstallationFile(t, unpaired),
    /backend\[openshell\]\.drivers\.sandbox must match the selected bundled OpenShell drivers\.sandbox\.id/,
  );

  // A bundled Sandbox selection without its owning openshell backend is refused, not ignored.
  const orphan = sandboxInstallation();
  delete orphan.backend;
  delete orphan.drivers.credential_gateway;
  await assert.rejects(
    loadInstallationFile(t, orphan),
    /bundled OpenShell drivers\.sandbox requires a backend entry with type openshell/,
  );
});

test("containerd startup rejects invalid configuration", async (t) => {
  const cases = {
    "relative helper path": (configuration) => {
      configuration.helper.path = "compute-containerd";
    },
    "empty namespace": (configuration) => {
      configuration.containerd.namespace = "";
    },
    "unknown section": (configuration) => {
      configuration.extra = true;
    },
    "missing credentials": (configuration) => {
      delete configuration.credentials;
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const invalid = installation();
    mutate(invalid.drivers.compute.configuration);
    await assert.rejects(
      loadInstallationFile(t, invalid),
      /drivers\.compute\.configuration does not match its Driver configuration schema/,
      `${name} must be refused`,
    );
  }

  // A tagged image is a well-formed reference, so the Driver's own policy refuses it.
  const tagged = installation();
  tagged.drivers.compute.configuration.images.agent = "registry.example/agent:latest";
  await assert.rejects(
    loadInstallationFile(t, tagged),
    /images\.agent must use an immutable SHA-256 digest/,
  );
});

test("containerd startup injects the Secret Driver's store for a staged Codex login", async (t) => {
  const dedicatedCodex = { id: "codex", mode: "dedicated" };
  const oauth = { method: "oauth", source: {}, secretDriverId: "occ/filesystem-secret" };

  // The fixture selects the cluster Secret API, which this engine cannot read: the Driver
  // refuses the login rather than admitting a revision it could not deliver.
  const cluster = await loadInstallationFile(t, installation());
  assert.throws(
    () => cluster.computeDriver.validateHarnessAuth(dedicatedCodex, oauth, {}),
    /requires the selected Secret Driver's store/,
  );

  // With the filesystem Secret Driver selected, composition injects the store it already owns,
  // so the operator never repeats the path in compute-containerd.configuration.
  const filesystem = installation();
  filesystem.drivers.secret = {
    id: "occ/filesystem-secret",
    configuration: { directory: "/var/lib/oce-containerd/secrets" },
  };
  const drivers = await loadInstallationFile(t, filesystem);
  assert.ok(drivers.computeDriver instanceof ContainerdComputeDriver);
  assert.doesNotThrow(() => drivers.computeDriver.validateHarnessAuth(dedicatedCodex, oauth, {}));
});

test("a Compute id this Driver does not claim keeps its previous selection", async (t) => {
  for (const id of ["compute-kubernetes", "compute-ssh"]) {
    const value = createInstallationDriverConfiguration();
    value.drivers.compute = { id, configuration: value.drivers.compute.configuration };
    // The containerd branch must not capture another id: selection stays with the bundled
    // Kubernetes driver (or fails for the SSH driver's own reasons), never with the containerd Driver.
    const loaded = await loadInstallationFile(t, value).catch((error) => error);
    assert.ok(
      !(loaded instanceof ContainerdComputeDriver),
      `${id} must not select the containerd Driver`,
    );
    if (id === "compute-kubernetes") {
      assert.ok(loaded.computeDriver instanceof KubernetesComputeDriver);
    }
  }
});

test("containerd startup refuses a mutable image in production and allows it in development", async (t) => {
  const mutable = installation();
  mutable.drivers.compute.configuration.images.requireImmutableDigest = false;
  mutable.drivers.compute.configuration.images.agent = "registry.example/agent:local";

  // Production must refuse a tag: the platform treats a revision's image as immutable.
  await assert.rejects(
    loadInstallationFile(t, mutable),
    /Production containerd workloads require immutable image digests/,
  );

  // Development may run a locally built image, which has no digest to name.
  const drivers = await loadInstallationFile(t, mutable, { mode: "development" });
  assert.ok(drivers.computeDriver instanceof ContainerdComputeDriver);
  assert.equal(
    drivers.installation.drivers.compute.configuration.images.agent,
    "registry.example/agent:local",
  );
});
