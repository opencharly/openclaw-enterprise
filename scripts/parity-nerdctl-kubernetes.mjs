// Cross-installation parity between the bundled Kubernetes and rootless nerdctl Compute
// Drivers: the capability rows the matrix records, the deviations it declares intentional, and
// the contract methods each driver actually implements.
//
// Usage:
//   node scripts/parity-nerdctl-kubernetes.mjs           report, exit 0
//   node scripts/parity-nerdctl-kubernetes.mjs --check   exit 1 on an undeclared capability gap
//
// --check is the acceptance gate the capability matrix is maintained against: the nerdctl
// column must hold on every row the Kubernetes column holds, except where the matrix records a
// deviation. Run it after `node scripts/generate-compute-matrix.mjs`.
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { KubernetesComputeDriver } from "../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { NerdctlComputeDriver } from "../apps/controller/src/drivers/compute/nerdctl/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = path.join(root, "docs/assets/compute-driver-matrix.json");
const contractsPath = path.join(root, "packages/contracts/src/index.ts");

const BASELINE = "kubernetes";
const COMPARED = "nerdctl";
const STRENGTH = Object.freeze({ supported: 2, partial: 1, unknown: 0, unsupported: 0 });

async function matrix() {
  return JSON.parse(await readFile(matrixPath, "utf8"));
}

/** Member names the ComputeDriver contract asks for, including what it extends. */
async function contractMembers() {
  const source = await readFile(contractsPath, "utf8");
  const members = new Set();
  for (const interfaceName of ["Driver", "ComputeDriver"]) {
    const start = source.indexOf(`export interface ${interfaceName} `);
    if (start < 0) {
      throw new Error(`the contract no longer declares ${interfaceName}`);
    }
    const body = source.slice(start, source.indexOf("\n}", start));
    for (const line of body.split("\n")) {
      const method = /^\s{2}(?:readonly\s+)?([a-zA-Z][A-Za-z0-9]*)\??\s*[(<]/.exec(line);
      const field = /^\s{2}readonly\s+([a-zA-Z][A-Za-z0-9]*)\??\s*:/.exec(line);
      if (method !== null) {
        members.add(method[1]);
      } else if (field !== null) {
        members.add(field[1]);
      }
    }
  }
  return [...members].sort();
}

function methodsOf(driver) {
  return new Set(Object.getOwnPropertyNames(driver.prototype));
}

function capabilityGaps(data) {
  const deviations = new Map(
    (data.deviations ?? []).map((entry) => [`${entry.driver}:${entry.row}`, entry.reason]),
  );
  const gaps = [];
  const allowed = [];
  for (const row of data.rows) {
    const held = row.cells[BASELINE];
    const compared = row.cells[COMPARED];
    if (held === undefined || compared === undefined) {
      gaps.push({ row: row.id, name: row.name, reason: "a column does not assess this row" });
      continue;
    }
    if (STRENGTH[compared.status] < STRENGTH[held.status]) {
      const entry = {
        row: row.id,
        name: row.name,
        held: held.status,
        compared: compared.status,
        reason: compared.detail,
      };
      const deviation = deviations.get(`${COMPARED}:${row.id}`);
      if (deviation === undefined) {
        gaps.push(entry);
      } else {
        allowed.push({ ...entry, reason: deviation });
      }
    }
  }
  return { gaps, allowed };
}

const data = await matrix();
const members = await contractMembers();
const drivers = [
  { name: BASELINE, driver: KubernetesComputeDriver },
  { name: COMPARED, driver: NerdctlComputeDriver },
];

console.log(`Baseline: ${BASELINE} (${data.baseline})`);

// A prototype lists the methods a class declares, but not its instance fields — and both
// drivers assign several contract members (id, capability, and the optional flags) as fields,
// nor the members they assign as arrow functions. This section is therefore a surface report
// for a human to read, never a compliance claim: each driver's own conformance suite is what
// proves the contract.
console.log(`\nContract members: ${members.length}; prototype surface, informational only:`);
const surfaces = new Map(drivers.map(({ name, driver }) => [name, methodsOf(driver)]));
for (const { name, driver } of drivers) {
  console.log(`${name.padEnd(11)} ${driver.name}: ${surfaces.get(name).size} prototype members`);
}
// Only contract members are compared: each driver's private helpers are its own business.
const contractOnly = (held, other) =>
  members.filter((member) => held.has(member) && !other.has(member));
const onlyBaseline = contractOnly(surfaces.get(BASELINE), surfaces.get(COMPARED));
const onlyCompared = contractOnly(surfaces.get(COMPARED), surfaces.get(BASELINE));
console.log(
  `  contract members on the ${BASELINE} surface only: ${onlyBaseline.join(", ") || "(none)"}`,
);
console.log(
  `  contract members on the ${COMPARED} surface only: ${onlyCompared.join(", ") || "(none)"}`,
);

const { gaps, allowed } = capabilityGaps(data);
console.log(`\nCapability rows: ${data.rows.length} assessed in both columns.`);
for (const entry of allowed) {
  console.log(
    `  declared deviation  ${entry.row}: ${entry.held} -> ${entry.compared} (${entry.reason})`,
  );
}
for (const entry of gaps) {
  console.log(
    `  GAP                 ${entry.row}: ${entry.held} -> ${entry.compared} - ${entry.reason}`,
  );
}
if (gaps.length === 0) {
  console.log("  No undeclared capability gap remains.");
}

if (process.argv.includes("--check") && gaps.length > 0) {
  console.error(`\n${gaps.length} capability gap(s) are not declared as deviations in the matrix.`);
  process.exit(1);
}
