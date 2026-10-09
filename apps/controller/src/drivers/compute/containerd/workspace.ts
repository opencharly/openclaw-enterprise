import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRevision, WorkspaceSetup } from "@openclaw-enterprise/contracts";

import { WORKSPACE_SETUP_RUNTIME, workspaceSetupMainAgent } from "../runtime/workspace-setup.ts";
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
let payloadFd;
try {
  payloadFd = setupFs.openSync(payloadPath, setupFs.constants.O_RDONLY | setupFs.constants.O_NOFOLLOW);
} catch {
  // Nothing to seed: the ownership handoff above was the whole job.
  process.exit(0);
}
// The payload is owner-only, so it is opened while this process is still the container's root.
// The dropped user reads the same descriptor, which keeps the payload off every other account.
process.env.OPENCLAW_WORKSPACE_SETUP_FD = String(payloadFd);
delete process.env.OPENCLAW_WORKSPACE_SETUP_PATH;
process.setgid(1000);
process.setuid(1000);
${WORKSPACE_SETUP_RUNTIME}`;
}

/**
 * Stages the setup request for the initializer and returns the mount source and its payload path.
 *
 * The directory is created by `mkdtemp` under the OS temp root, so its name is unpredictable and
 * it is owner-only; the payload is created exclusively (`wx`) at mode `0600`. The initializer
 * opens it while it still runs as the container's root and then drops to the workload user, which
 * reads that already-open descriptor — the payload is never readable by another host account, and
 * a pre-created path or a swapped file cannot be adopted. It carries the Agent's own workspace
 * documents, never a credential: the shared runtime refuses any key outside the setup request.
 */
export async function writeWorkspaceSetupPayload(
  setup: Readonly<WorkspaceSetup>,
): Promise<{ readonly directory: string; readonly path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "oce-containerd-setup-"));
  const path = join(directory, WORKSPACE_SETUP_FILE);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(setup), "utf8");
  } finally {
    await handle.close();
  }
  return { directory, path };
}

/** Removes a staged payload with the initializer that consumed it. */
export async function removeWorkspaceSetupPayload(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
