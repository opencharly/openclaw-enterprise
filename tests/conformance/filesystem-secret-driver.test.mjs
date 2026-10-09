import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FilesystemSecretDriver,
  FilesystemSecretError,
} from "../../apps/controller/src/drivers/secret/filesystem/index.ts";

async function withStorage(t) {
  const directory = await mkdtemp(join(tmpdir(), "oce-filesystem-secret-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, driver: new FilesystemSecretDriver({ directory }) };
}

const IDENTITY = { id: "sec_1", namespaceId: "ns_1", name: "model-token" };

test("filesystem-secret-driver stores, verifies, updates, resolves and deletes one exact Secret", async (t) => {
  const { directory, driver } = await withStorage(t);
  const reference = await driver.create(IDENTITY, "s3cret-one");
  // The persisted reference must satisfy the occ.secrets backend columns, which are
  // Kubernetes Secret coordinates: a DNS-1123 label namespace, a lowercase DNS subdomain
  // name and a UUID uid. This Driver publishes opaque hashes instead of the OCC identities,
  // so the locator carries no namespace or Secret name.
  assert.match(reference.namespaceName, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  assert.ok(reference.namespaceName.length <= 63);
  assert.match(reference.name, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/);
  assert.ok(reference.name.length <= 253);
  assert.equal(reference.key, "value");
  assert.match(reference.uid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(!`${reference.namespaceName}${reference.name}`.includes("ns_1"));
  assert.ok(!`${reference.namespaceName}${reference.name}`.includes("model-token"));

  // The value belongs to one stored file whose permissions keep it off other accounts.
  const stored = join(directory, (await findStoredFile(directory)).name);
  assert.equal((await stat(stored)).mode & 0o777, 0o600);
  assert.ok((await readFile(stored, "utf8")).includes("s3cret-one"));

  const secret = { ...IDENTITY, driverId: driver.id, backendRef: reference, createdAt: "now" };
  assert.deepEqual(await driver.resolve(secret), reference);
  assert.equal(await driver.withValue(secret, async (value) => value.length), 10);

  await driver.update(secret, "s3cret-two");
  assert.equal(await driver.withValue(secret, async (value) => value), "s3cret-two");

  // A conditional write replaces only an exactly matching value.
  assert.equal(await driver.compareAndSwap(secret, "s3cret-two", "s3cret-three"), true);
  assert.equal(await driver.withValue(secret, async (value) => value), "s3cret-three");
  assert.equal(await driver.compareAndSwap(secret, "s3cret-two", "clobbered"), false);
  assert.equal(await driver.withValue(secret, async (value) => value), "s3cret-three");

  await driver.delete(secret);
  await assert.rejects(driver.resolve(secret), FilesystemSecretError);
});

test("filesystem-secret-driver refuses a create that would overwrite a live Secret", async (t) => {
  const { driver } = await withStorage(t);
  await driver.create(IDENTITY, "s3cret-one");
  // Overwriting would destroy a credential that a running revision may still present.
  await assert.rejects(driver.create(IDENTITY, "s3cret-two"), /already exists/);
});

test("filesystem-secret-driver refuses a foreign or malformed backend", async (t) => {
  const { directory, driver } = await withStorage(t);
  const reference = await driver.create(IDENTITY, "s3cret-one");
  const secret = { ...IDENTITY, driverId: driver.id, backendRef: reference, createdAt: "now" };

  // A well-formed but foreign uid: the refusal is about identity, not about the shape.
  const foreign = { ...secret, backendRef: { ...reference, uid: randomUUID() } };
  await assert.rejects(driver.resolve(foreign), /does not own/);
  await assert.rejects(driver.update(foreign, "s3cret-two"), /does not own/);
  await assert.rejects(driver.delete(foreign), /does not own/);
  await assert.rejects(
    driver.withValue(foreign, async (value) => value),
    /does not own/,
  );
  // The refused operations left the real value untouched.
  assert.equal(await driver.withValue(secret, async (value) => value), "s3cret-one");

  const stored = join(directory, (await findStoredFile(directory)).name);
  await writeFile(stored, "not json", "utf8");
  await assert.rejects(driver.resolve(secret), FilesystemSecretError);
});

test("filesystem-secret-driver fails closed on invalid configuration and empty values", async (t) => {
  for (const configuration of [
    { directory: "relative/path" },
    { directory: "/trailing/" },
    { directory: "/ok", extra: true },
    {},
  ]) {
    assert.throws(() => new FilesystemSecretDriver(configuration), FilesystemSecretError);
  }

  const { driver } = await withStorage(t);
  await assert.rejects(driver.create(IDENTITY, ""), /non-empty/);
});

test("filesystem-secret-driver never names a stored value in an error", async (t) => {
  const { driver } = await withStorage(t);
  await driver.create(IDENTITY, "s3cret-one");
  const failure = await driver.create(IDENTITY, "s3cret-two").catch((error) => error);
  assert.ok(failure instanceof FilesystemSecretError);
  assert.ok(!failure.message.includes("s3cret"), "an error must not carry a credential");
});

/** The stored layout is <directory>/<namespace hash>/<identity hash>.json. */
async function findStoredFile(directory) {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(directory)) {
    const nested = await readdir(join(directory, entry)).catch(() => []);
    if (nested.length > 0) {
      return { name: join(entry, nested[0]) };
    }
  }
  throw new Error("no stored file was written");
}
