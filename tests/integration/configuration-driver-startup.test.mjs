import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.mjs";

test("configuration-driver-startup selects the filesystem driver for a host-managed store", async (t) => {
  const configuration = createInstallationDriverConfiguration();
  configuration.drivers.configuration = {
    id: "occ/filesystem-configuration",
    configuration: { root: "/var/lib/oce-containerd/configuration" },
  };
  const drivers = await loadInstallationFile(t, configuration);

  assert.ok(drivers.configurationDriver instanceof FilesystemConfigurationDriver);
  assert.equal(drivers.configurationDriver.capability, "configuration");
  assert.equal(drivers.configurationDriver.implementation, "occ/filesystem-configuration");
  assert.equal(
    drivers.installation.drivers.configuration.configuration.root,
    "/var/lib/oce-containerd/configuration",
  );

  const pool = new pg.Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  t.after(async () => pool.end());
  assert.doesNotThrow(() =>
    createControllerWorker({ pool, mode: "production", drivers, emit: () => {} }),
  );

  // A relative root would resolve against the worker's working directory.
  const invalid = createInstallationDriverConfiguration();
  invalid.drivers.configuration = {
    id: "occ/filesystem-configuration",
    configuration: { root: "configuration" },
  };
  await assert.rejects(
    loadInstallationFile(t, invalid),
    /drivers\.configuration\.configuration does not match its Driver configuration schema/,
  );
});

test("configuration-driver-startup leaves the Kubernetes selection to its own ids", async (t) => {
  for (const id of ["configuration-kubernetes", "custom-configuration-id"]) {
    const configuration = createInstallationDriverConfiguration();
    configuration.drivers.configuration.id = id;
    const drivers = await loadInstallationFile(t, configuration);
    assert.ok(
      drivers.configurationDriver instanceof KubernetesConfigurationDriver,
      `${id} must not select the filesystem driver`,
    );
  }
});
