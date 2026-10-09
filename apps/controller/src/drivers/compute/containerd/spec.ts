import { sha256Hex } from "@openclaw-enterprise/utils";

import { GATEWAY_RUNTIME_ENTRYPOINT } from "../runtime/gateway.ts";

/** Ownership labels. Every helper operation verifies these before acting. */
export const MANAGED_LABEL = "org.openclaw.enterprise.managed";
export const MANAGED_VALUE = "true";
export const COMPUTE_DRIVER_LABEL = "org.openclaw.enterprise.compute-driver";
export const NAMESPACE_LABEL = "org.openclaw.enterprise.namespace-id";
export const AGENT_LABEL = "org.openclaw.enterprise.agent-id";
export const REVISION_LABEL = "org.openclaw.enterprise.revision-id";
export const ROLE_LABEL = "org.openclaw.enterprise.role";
export const CONFIGURATION_HASH_LABEL = "org.openclaw.enterprise.configuration-hash";
export const REVISION_NUMBER_LABEL = "org.openclaw.enterprise.revision-number";
export const HARNESS_VERSION_LABEL = "org.openclaw.enterprise.harness-version";
/** The allowlist the egress proxy reads for itself. */
export const EGRESS_ALLOWLIST_LABEL = "org.openclaw.enterprise.egress-allowlist";
// The limits a container was created with. The engine enforces them; recording them lets the
// Driver sum a Namespace's committed budget without asking the engine to re-report it.
export const LIMIT_CPUS_LABEL = "org.openclaw.enterprise.limit-cpus";
export const LIMIT_MEMORY_LABEL = "org.openclaw.enterprise.limit-memory-bytes";
// Frozen: this is the ownership value already labelled on every container this Driver created,
// and the helper verifies expectLabels before it stops or removes one. Changing it would make
// each pre-existing container unverifiable, so it changes only with a container recreation.
const COMPUTE_DRIVER_VALUE = "nerdctl";

/** The two planes of an Agent's network. Only the gateway joins the edge plane. */
export type NerdctlPlane = "internal" | "edge";

export type NerdctlOwner = {
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly revisionId?: string;
  readonly revisionNumber?: number;
};

export type NerdctlRole =
  | "gateway"
  | "agent"
  | "relay"
  | "egress-proxy"
  | "network-internal"
  | "network-edge"
  | "oauth-seed";

export interface NerdctlTmpfs {
  readonly target: string;
  readonly sizeBytes?: number;
  readonly mode?: string;
  /** Owner of the mount inside the container; the hardened runtime drops every capability. */
  readonly uid?: number;
  readonly gid?: number;
}

export interface NerdctlMount {
  readonly volume: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

export interface NerdctlPublish {
  readonly hostIp: string;
  readonly hostPort: number;
  readonly containerPort: number;
}

export interface NerdctlReadiness {
  readonly command: readonly string[];
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly deadlineMs?: number;
}

/** The helper's run-container input, as this Driver renders it. */
export interface NerdctlContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly network: string;
  /** The planes this container joins when it needs more than one. */
  readonly networks?: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  readonly user?: string;
  /** Overrides the image entrypoint; the runtime program needs Node, not the image's shell. */
  readonly entrypoint?: readonly string[];
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly readOnlyRootfs?: boolean;
  readonly capDrop?: readonly string[];
  readonly noNewPrivileges?: boolean;
  readonly tmpfs?: readonly NerdctlTmpfs[];
  readonly mounts?: readonly NerdctlMount[];
  readonly publish?: readonly NerdctlPublish[];
  readonly readiness?: NerdctlReadiness;
  readonly limits?: { readonly memoryBytes?: number; readonly cpus?: number };
}

/** The writable state an Agent keeps across revisions, and its workspace. */
export function workspaceVolumes(ownership: NerdctlOwner): {
  readonly state: string;
  readonly workspace: string;
  readonly codexHome: string;
} {
  return {
    state: `${agentPrefix(ownership)}-state`,
    workspace: `${agentPrefix(ownership)}-workspace`,
    // The dedicated Harness's Codex home is its own volume. An OAuth bundle seeded into it must
    // stay unreadable to the Agent's gateway, which mounts the OpenClaw state volume instead.
    codexHome: `${agentPrefix(ownership)}-codex-home`,
  };
}

/**
 * The scope an operation expects to find. Expectations are a subset: the helper accepts a
 * resource whose labels contain them, so a deletion does not need to know a resource's
 * role, agent or revision in advance.
 */
export function scopeLabels(scope: NerdctlOwner): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {
    [MANAGED_LABEL]: MANAGED_VALUE,
    [COMPUTE_DRIVER_LABEL]: COMPUTE_DRIVER_VALUE,
    [NAMESPACE_LABEL]: scope.namespaceId,
  };
  if (scope.agentId !== undefined) {
    labels[AGENT_LABEL] = scope.agentId;
  }
  if (scope.revisionId !== undefined) {
    labels[REVISION_LABEL] = scope.revisionId;
  }
  return labels;
}

/**
 * The labels an Agent's workspace storage carries. Creation, adoption and removal all read
 * this one function: a differing set makes the helper refuse storage it created itself.
 */
export function workspaceVolumeLabels(ownership: NerdctlOwner): Readonly<Record<string, string>> {
  return { ...scopeLabels(ownership), [ROLE_LABEL]: "workspace" };
}

/** The limits a container carries, as labels, so a later admission check can sum them. */
export function limitLabels(
  limits: { readonly memoryBytes?: number; readonly cpus?: number } | undefined,
): Readonly<Record<string, string>> {
  if (limits === undefined || limits.memoryBytes === undefined || limits.cpus === undefined) {
    return {};
  }
  return {
    [LIMIT_MEMORY_LABEL]: String(limits.memoryBytes),
    [LIMIT_CPUS_LABEL]: String(limits.cpus),
  };
}

/**
 * The relay a gateway needs when it stands on the no-egress plane. A published port does not work
 * on that plane, so something on the plane that reaches outside forwards the port to it — the
 * routing layer a cluster would provide from outside the workload.
 */
export const RELAY_PROGRAM = String.raw`
const net = require("node:net");
const [host, port] = String(process.env.RELAY_TARGET).split(":");
net
  .createServer((client) => {
    const upstream = net.connect(Number(port), host);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  })
  .listen(Number(process.env.RELAY_PORT ?? 8080), "0.0.0.0");
`;

export function ownershipLabels(
  ownership: NerdctlOwner,
  role: NerdctlRole,
): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {
    [MANAGED_LABEL]: MANAGED_VALUE,
    [COMPUTE_DRIVER_LABEL]: COMPUTE_DRIVER_VALUE,
    [NAMESPACE_LABEL]: ownership.namespaceId,
    [ROLE_LABEL]: role,
  };
  if (ownership.agentId !== undefined) {
    labels[AGENT_LABEL] = ownership.agentId;
  }
  if (ownership.revisionId !== undefined) {
    labels[REVISION_LABEL] = ownership.revisionId;
  }
  return labels;
}

/** Each Agent owns an internal plane; only a gateway may join the edge plane. */
export function networkName(namespaceId: string, plane: NerdctlPlane): string {
  return `oce-${sha256Hex(namespaceId, 12)}-${plane}`;
}

/**
 * The single source of a plane's ownership labels. Creation, rollback and deletion must
 * agree here: a differing label set makes the helper refuse to touch its own network.
 */
export function planeLabels(
  namespaceId: string,
  plane: NerdctlPlane,
): Readonly<Record<string, string>> {
  return ownershipLabels({ namespaceId }, plane === "edge" ? "network-edge" : "network-internal");
}

export function gatewayContainerName(namespaceId: string, agentId: string): string {
  return `oce-${sha256Hex(namespaceId, 12)}-gateway-${sha256Hex(agentId, 12)}`;
}

export function agentContainerName(ownership: NerdctlOwner): string {
  if (ownership.agentId === undefined || ownership.revisionId === undefined) {
    throw new Error("An Agent container name requires an exact Agent and revision.");
  }
  return `${agentPrefix(ownership)}-rev-${sha256Hex(ownership.revisionId, 12)}`;
}

/**
 * The one-shot seeder that writes a staged OAuth bundle into the revision's Codex home. It is
 * revision-scoped like the harness it precedes, and removed inside the same delivery.
 */
export function oauthSeedContainerName(ownership: NerdctlOwner): string {
  if (ownership.agentId === undefined || ownership.revisionId === undefined) {
    throw new Error("An OAuth seeder container name requires an exact Agent and revision.");
  }
  return `${agentPrefix(ownership)}-rev-${sha256Hex(ownership.revisionId, 12)}-oauth-seed`;
}

/** Writable paths an Agent needs when its root filesystem is read-only. */
/** The workload user's home, which OpenClaw needs writable for its caches and configuration. */
export const HOME_DIRECTORY = "/home/node";

// A hardened container runs with a read-only root and no capabilities, so anything OpenClaw
// writes outside its mounted volumes has to land on a writable mount: `$HOME` for its caches and
// configuration discovery, `/tmp` for scratch. The Agent's state and workspace volumes are
// mounted inside `$HOME` and take precedence over it. This mirrors the Docker Driver.
export const AGENT_TMPFS: readonly NerdctlTmpfs[] = Object.freeze([
  { target: HOME_DIRECTORY, sizeBytes: 1_073_741_824, mode: "700", uid: 1000, gid: 1000 },
  { target: "/tmp", sizeBytes: 67_108_864, mode: "1777" },
]);

export const AGENT_USER = "1000:1000";

/**
 * agentContainerSpec renders the hardened Agent runtime. The helper owns no policy of
 * its own, so every constraint the Kubernetes driver gets from a Pod security context
 * is stated here.
 */
export function agentContainerSpec(input: {
  readonly ownership: NerdctlOwner;
  readonly image: string;
  /** The planes the harness joins; the Agent's no-egress plane when a proxy carries its egress. */
  readonly networks?: readonly string[];
  /**
   * Overrides the image entrypoint. The harness runs under the repository's tini wrapper,
   * because its program travels compressed in bounded pieces rather than one `-e` argument.
   */
  readonly entrypoint?: readonly string[];
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly configurationHash: string;
  readonly limits?: { readonly memoryBytes?: number; readonly cpus?: number };
  readonly readiness?: NerdctlReadiness;
}): NerdctlContainerSpec {
  const volumes = workspaceVolumes(input.ownership);
  return {
    name: agentContainerName(input.ownership),
    image: input.image,
    // The harness shares the Agent's plane with its gateway and reaches the model through the
    // same egress path; the Docker Driver puts both containers on one network for the same
    // reason, this engine having no per-port egress policy.
    network: networkName(input.ownership.namespaceId, "edge"),
    ...(input.networks === undefined ? {} : { networks: input.networks }),
    labels: {
      ...ownershipLabels(input.ownership, "agent"),
      [CONFIGURATION_HASH_LABEL]: input.configurationHash,
    },
    user: AGENT_USER,
    ...(input.entrypoint === undefined ? {} : { entrypoint: input.entrypoint }),
    args: input.args,
    env: input.env,
    readOnlyRootfs: true,
    capDrop: ["ALL"],
    noNewPrivileges: true,
    tmpfs: AGENT_TMPFS,
    mounts: [
      // The harness owns its Codex home and shares the workspace: a revision change reattaches
      // both rather than re-provisioning the Agent, and a credential seeded into CODEX_HOME is
      // reachable only from this container.
      { volume: volumes.codexHome, target: CODEX_HOME_DIRECTORY },
      { volume: volumes.workspace, target: WORKSPACE_DIRECTORY },
    ],
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    ...(input.readiness === undefined ? {} : { readiness: input.readiness }),
  };
}

function agentPrefix(ownership: NerdctlOwner): string {
  if (ownership.agentId === undefined) {
    throw new Error("Agent-owned resources require an exact Agent.");
  }
  return `oce-${sha256Hex(ownership.namespaceId, 12)}-${sha256Hex(ownership.agentId, 12)}`;
}

/**
 * The egress proxy one Namespace stands on both planes. Agents' workloads reach it on the
 * no-egress plane and it is their only route out; an Installation that names no proxy image has
 * no such route and its workloads stay on the edge plane.
 */
export function egressProxySpec(input: {
  readonly namespaceId: string;
  readonly image: string;
  readonly allowlist: readonly string[];
  readonly limits?: { readonly memoryBytes?: number; readonly cpus?: number };
}): NerdctlContainerSpec {
  const ownership = { namespaceId: input.namespaceId };
  return {
    name: egressProxyName(input.namespaceId),
    image: input.image,
    network: networkName(input.namespaceId, "internal"),
    networks: [networkName(input.namespaceId, "internal"), networkName(input.namespaceId, "edge")],
    labels: {
      ...ownershipLabels(ownership, "egress-proxy"),
      // The proxy reads its own allowlist; the Driver states policy once and never inspects it.
      EGRESS_ALLOWLIST_LABEL: input.allowlist.join(","),
    },
    // The proxy image brings its own command; the Driver supplies only its configuration.
    args: [],
    env: { EGRESS_ALLOWLIST: input.allowlist.join(",") },
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  };
}

export function egressProxyName(namespaceId: string): string {
  return `oce-${sha256Hex(namespaceId, 12)}-proxy`;
}

/** The relay that publishes an Agent's gateway port from the no-egress plane. */
export function relaySpec(input: {
  readonly ownership: NerdctlOwner;
  readonly image: string;
  readonly target: string;
  readonly publishedPort: number;
  readonly limits?: { readonly memoryBytes?: number; readonly cpus?: number };
}): NerdctlContainerSpec {
  return {
    name: relayContainerName(input.ownership),
    image: input.image,
    network: networkName(input.ownership.namespaceId, "internal"),
    networks: [
      networkName(input.ownership.namespaceId, "internal"),
      networkName(input.ownership.namespaceId, "edge"),
    ],
    labels: {
      ...ownershipLabels(input.ownership, "relay"),
      [ROLE_LABEL]: "relay",
    },
    entrypoint: ["node"],
    args: ["-e", RELAY_PROGRAM],
    env: { RELAY_TARGET: input.target, RELAY_PORT: String(GATEWAY_PORT) },
    readOnlyRootfs: true,
    capDrop: ["ALL"],
    noNewPrivileges: true,
    tmpfs: AGENT_TMPFS,
    publish: [{ hostIp: "127.0.0.1", hostPort: input.publishedPort, containerPort: GATEWAY_PORT }],
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  };
}

export function relayContainerName(ownership: NerdctlOwner): string {
  return `${agentPrefix(ownership)}-relay`;
}

/** The transport port the OpenClaw gateway listens on inside its container. */
export const GATEWAY_PORT = 8080;
export const AGENT_TRANSPORT_PORT = 18_790;
export const STATE_DIRECTORY = "/home/node/.openclaw";
export const WORKSPACE_DIRECTORY = "/home/node/workspace";
/** The dedicated harness keeps its own home, beside the gateway's state in the same volume. */
export const CODEX_HOME_DIRECTORY = "/home/node/.codex";
export const CONFIGURATION_DOCUMENT = `${STATE_DIRECTORY}/openclaw.json`;

/**
 * The readiness probe the gateway reports on. It runs inside the container, so a
 * published port is not needed for the Driver to judge readiness.
 */
export const GATEWAY_READINESS_COMMAND: readonly string[] = Object.freeze([
  "node",
  "-e",
  `fetch("http://127.0.0.1:${GATEWAY_PORT}/readyz").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));`,
]);

/**
 * gatewayContainerSpec renders the OpenClaw runtime that hosts an embedded harness. The
 * configuration travels in the environment so the container needs no host file, and the
 * state and workspace volumes are the Agent's durable storage.
 */
export function gatewayContainerSpec(input: {
  readonly ownership: NerdctlOwner;
  readonly image: string;
  /** The planes the gateway joins; the Agent's no-egress plane when a proxy carries its egress. */
  readonly networks?: readonly string[];
  readonly configurationJson: string;
  readonly configurationHash: string;
  readonly harnessVersion: string;
  /** The loopback port to publish; absent when a relay publishes it instead. */
  readonly publishedPort?: number;
  readonly environment: Readonly<Record<string, string>>;
  /** CPU and memory ceilings the engine enforces on the runtime container. */
  readonly limits?: { readonly memoryBytes?: number; readonly cpus?: number };
  readonly readinessDeadlineMs?: number;
}): NerdctlContainerSpec {
  const volumes = workspaceVolumes(input.ownership);
  return {
    name: gatewayContainerName(input.ownership.namespaceId, input.ownership.agentId ?? ""),
    image: input.image,
    network: networkName(input.ownership.namespaceId, "edge"),
    ...(input.networks === undefined ? {} : { networks: input.networks }),
    labels: {
      ...ownershipLabels(input.ownership, "gateway"),
      [CONFIGURATION_HASH_LABEL]: input.configurationHash,
      [REVISION_NUMBER_LABEL]: String(input.ownership.revisionNumber ?? 0),
      [HARNESS_VERSION_LABEL]: input.harnessVersion,
      ...limitLabels(input.limits),
    },
    user: AGENT_USER,
    // The gateway runtime is shared with the Docker driver: it prepares the state
    // directory, execs OpenClaw and forwards termination signals. The image's entrypoint
    // prepends `node` to a bare argument, which would read the program as a module path,
    // so the program is passed to Node explicitly, exactly as the Docker driver does.
    entrypoint: ["node"],
    args: ["-e", GATEWAY_RUNTIME_ENTRYPOINT],
    env: {
      ...input.environment,
      HOME: "/home/node",
      OPENCLAW_STATE_DIR: STATE_DIRECTORY,
      OPENCLAW_CONFIG_PATH: CONFIGURATION_DOCUMENT,
      OPENCLAW_CONFIG_JSON: input.configurationJson,
      OPENCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
    },
    readOnlyRootfs: true,
    capDrop: ["ALL"],
    noNewPrivileges: true,
    tmpfs: AGENT_TMPFS,
    mounts: [
      { volume: volumes.state, target: STATE_DIRECTORY },
      { volume: volumes.workspace, target: WORKSPACE_DIRECTORY },
    ],
    ...(input.publishedPort === undefined
      ? {}
      : {
          publish: [
            { hostIp: "127.0.0.1", hostPort: input.publishedPort, containerPort: GATEWAY_PORT },
          ],
        }),
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    readiness: {
      command: GATEWAY_READINESS_COMMAND,
      intervalMs: 2_000,
      timeoutMs: 5_000,
      deadlineMs: input.readinessDeadlineMs ?? 120_000,
    },
  };
}
