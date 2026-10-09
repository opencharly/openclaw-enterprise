import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentRevision, WorkspaceSetup } from "@openclaw-enterprise/contracts";

import { WORKSPACE_SETUP_RUNTIME, workspaceSetupMainAgent } from "../workspace-setup-runtime.ts";
import { ConfigurationFailure } from "./schema.ts";
import { STATE_DIRECTORY, WORKSPACE_DIRECTORY } from "./spec.ts";

/**
 * The exact-Agent managed workspace the revision selected. Bootstrap in operator-chosen
 * storage is refused: the Driver owns this directory and nothing else may seed it.
 */
export function workspaceDirectory(revision: Readonly<AgentRevision>): string {
  const agents = asRecord(revision.configuration.agents);
  const defaults = asRecord(agents?.defaults);
  const main = workspaceSetupMainAgent(revision.configuration);
  if (main === undefined) {
    throw new ConfigurationFailure("Workspace setup requires only the native main Agent.");
  }
  const workspace = main?.workspace ?? defaults?.workspace ?? `${STATE_DIRECTORY}/workspace`;
  if (
    (workspace !== `${STATE_DIRECTORY}/workspace` && workspace !== WORKSPACE_DIRECTORY) ||
    defaults?.skipBootstrap === true ||
    defaults?.skipOptionalBootstrapFiles === true ||
    main?.skipBootstrap === true ||
    main?.skipOptionalBootstrapFiles === true
  ) {
    throw new ConfigurationFailure(
      "Workspace setup requires native bootstrap in exact-Agent managed storage.",
    );
  }
  return workspace;
}

/** The file name the initializer reads its setup request from. */
export const WORKSPACE_SETUP_FILE = "workspace-setup.json";

/**
 * The initializer runs as the image's root so it can hand the volumes to the workload
 * user, then drops to that user before running the shared setup runtime. A dedicated Codex
 * home is handed over the same way, and unless this delivery is the one that seeds an OAuth
 * bundle, any earlier personal login is removed: a revision that stopped using OAuth must not
 * leave a credential refreshing on the Agent's disk.
 */
export function workspaceSetupScript(
  options: { readonly codexHome?: string; readonly clearOauth?: boolean } = {},
): string {
  const directories = [STATE_DIRECTORY, WORKSPACE_DIRECTORY];
  if (options.codexHome !== undefined) {
    directories.push(options.codexHome);
  }
  const clear =
    options.clearOauth === true && options.codexHome !== undefined
      ? `
for (const name of ["auth.json", ".oce-oauth.json"]) {
  setupFs.rmSync(${JSON.stringify(options.codexHome)} + "/" + name, { force: true });
}`
      : "";
  return `
const setupFs = require("node:fs");
// An Agent's storage belongs to the workload user, and only root inside the container can
// hand it over. This runs for every delivery: a revision without a workspace projection
// still needs writable state, and its runtime fails without it.
for (const path of ${JSON.stringify(directories)}) {
  setupFs.chownSync(path, 1000, 1000);
  setupFs.chmodSync(path, 0o700);
}${clear}
const payloadPath = process.env.OPENCLAW_WORKSPACE_SETUP_PATH;
if (payloadPath === undefined || !setupFs.existsSync(payloadPath)) {
  // Nothing to seed: the ownership handoff above was the whole job.
  process.exit(0);
}
process.setgid(1000);
process.setuid(1000);
${WORKSPACE_SETUP_RUNTIME}`;
}

/**
 * Writes the setup request to a driver-owned directory the initializer mounts read-only.
 * The payload never reaches a process list, container metadata or the environment, and a
 * rootless engine never has to copy files into a stopped container.
 */
export async function writeWorkspaceSetupPayload(
  directory: string,
  setup: Readonly<WorkspaceSetup>,
): Promise<string> {
  // The initializer reads this payload after it drops to the workload user, so it must be readable
  // by that user. It holds the Agent's own workspace content and no secret, the mount is read-only,
  // and the directory is removed with the initializer.
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const path = join(directory, WORKSPACE_SETUP_FILE);
  await writeFile(path, JSON.stringify(setup), { encoding: "utf8", mode: 0o644 });
  return path;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
