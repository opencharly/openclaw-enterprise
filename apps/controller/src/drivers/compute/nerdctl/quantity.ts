/**
 * Kubernetes resource quantities, parsed for a container engine.
 *
 * The Installation document that configures this Driver is the same document the Kubernetes
 * Driver reads, so a resource limit arrives as a quantity string ("3Gi", "4", "100m"). The
 * engine takes bytes and a CPU count, so the Driver converts once, here, and refuses anything
 * it cannot honour exactly rather than rounding a limit down.
 */

import { ConfigurationFailure } from "./errors.ts";

const MEMORY_SUFFIXES: Readonly<Record<string, number>> = Object.freeze({
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
});

const QUANTITY = /^([0-9]+(?:\.[0-9]+)?)([A-Za-z]*)?$/;

function fail(section: string, value: string, expected: string): never {
  throw new ConfigurationFailure(`${section} must be ${expected}, received "${value}".`);
}

/** Converts a memory quantity to whole bytes. */
export function memoryToBytes(section: string, value: string): number {
  const match = QUANTITY.exec(value.trim());
  if (match === null) {
    fail(section, value, "a memory quantity such as 3Gi, 512Mi or a byte count");
  }
  const amount = match[1] ?? "";
  const suffix = match[2] ?? "";
  const scale = suffix === "" ? 1 : MEMORY_SUFFIXES[suffix];
  if (scale === undefined) {
    fail(
      section,
      value,
      "a memory quantity with a binary (Ki, Mi, Gi, Ti) or decimal (k, M, G, T) suffix",
    );
  }
  const bytes = Number(amount) * scale;
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    fail(section, value, "a memory quantity of at least one byte that a container engine can hold");
  }
  return bytes;
}

/** Converts a CPU quantity to cores, accepting millicores. */
export function cpusToCores(section: string, value: string): number {
  const match = QUANTITY.exec(value.trim());
  if (match === null) {
    fail(section, value, "a CPU quantity such as 4, 0.5 or 100m");
  }
  const amount = match[1] ?? "";
  const suffix = match[2] ?? "";
  if (suffix !== "" && suffix !== "m") {
    fail(section, value, "a CPU quantity in cores or millicores, such as 4 or 500m");
  }
  const cpus = suffix === "m" ? Number(amount) / 1000 : Number(amount);
  if (!(cpus > 0)) {
    fail(section, value, "a CPU quantity greater than zero");
  }
  return cpus;
}
