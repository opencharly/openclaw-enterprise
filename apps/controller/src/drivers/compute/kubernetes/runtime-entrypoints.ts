import { AGENT_RUNTIME_ENTRYPOINT } from "../runtime/agent.ts";
import { nodeProgramArguments } from "../runtime/node-program.ts";
import {
  AUTH_PROBE_FAILURE_HELPER,
  PLUGIN_RUNTIME_HELPERS,
  RUNTIME_READINESS_SERVER_HELPER,
  startupPhaseHelper,
} from "../runtime/program-helpers.ts";

// Match the pinned OpenClaw service stop budget: 315s drain, 10s cleanup,
// and 5s supervisor margin. Idle Gateways exit as soon as their work settles.
export const GATEWAY_STOP_TIMEOUT_MS = 330_000;

// The native probe disables tools and fallback and performs a bounded model turn.
// Its JSON status, not its process exit status alone, establishes provider acceptance.
//
// The native probe disables tools and fallback and performs a bounded model turn.
// Its JSON status, not its process exit status alone, establishes provider acceptance.
//
// The probe is a whole embedded agent run. Its local work (Node and OpenClaw
// boot, SQLite session state, cleanup) took about 16 CPU-seconds on the runtime
// image, on one core however many it may use; --probe-timeout bounds the model
// turn itself. A fixed 30-second cap let the example 500m CPU limit starve that
// local work into MODEL_PROBE_TIMEOUT before the turn finished. The cap is now
// the 15-second turn, 5 seconds of slack, and 45 CPU-seconds of local work at
// the container's CPU limit (cgroup cpu.max, at most one core), at most 600 s.
// A probe that still reaches it after waiting for CPU for over a quarter of the
// time reports MODEL_PROBE_CPU_STARVED: a restart would get the same CPU. The
// wait is cgroup cpu.pressure (throttling and node contention) or, on kernels
// without pressure accounting, cpu.stat throttled_usec (throttling only).
// OpenClaw buckets provider 401/403 and invalid-key responses as "auth". Only
// that deterministic rejection fails the deployment before its deadline.
// The turn allows 256 output tokens. A reasoning model spends output tokens on
// thinking before any text; at 16 it returned none and the probe failed.
// The Gateway times its model-probe phase from wrapper start: it is the first step.
// Generated code stays compact: the Gateway program is near the exec limit.
const OPENCLAW_AUTH_PROBE_HELPERS = String.raw`
${AUTH_PROBE_FAILURE_HELPER}
function probeOpenClawAuthenticationFailure() {
  const fs = require("node:fs");
  const cgroup = (name) => { try { return fs.readFileSync("/sys/fs/cgroup/" + name, "utf8"); } catch { return ""; } };
  const [quota, period] = cgroup("cpu.max").split(" ");
  const capMs = Math.min(600000, 20000 + Math.ceil(45000 / Math.min(1, quota / period || 1)));
  const read = (name) => (name === "cpu.pressure" ? /^some .*total=(\d+)/m : /throttled_usec (\d+)/).exec(cgroup(name))?.[1] / 1000;
  const startedAt = Date.now(), pressure = read("cpu.pressure"), metric = Number.isFinite(pressure) ? "cpu.pressure" : "cpu.stat", before = metric === "cpu.pressure" ? pressure : read(metric);
  let code = runOpenClawAuthenticationProbe(fs, capMs), cause;
  if (typeof code === "object") ({ code, cause } = code);
  const elapsedMs = Date.now() - startedAt, after = read(metric), cpuWaitMs = Math.round(Number.isFinite(after) && after >= before ? after - before : NaN);
  if (code === "CAP") code = cpuWaitMs > elapsedMs / 4 ? "MODEL_PROBE_CPU_STARVED" : "MODEL_PROBE_TIMEOUT";
  console.error(JSON.stringify({ event: "openclaw.model_probe", elapsedMs, capMs, cpuWaitMs, code: code ?? "READY", cause }));
  return code === undefined ? undefined : { code, cause };
}

// The full probe needs 10-20 s of local work before its model request. A
// rejected credential is found first with one empty request to the default
// endpoint, sent with the credential exactly as OpenClaw sends it: the provider
// authenticates before validating, so only 401 means rejection. Anything else
// (400, an error, the 10 s limit) proves nothing and the full probe decides,
// so acceptance still needs a real model turn. A configured endpoint, API,
// headers or request option other than allowPrivateNetwork, a model whose API or
// endpoint differs from the provider's, or an Anthropic setup token, skips this
// request. The request goes to the
// path of the configured API: a key may be scoped to one endpoint, and OpenAI
// answers 401 for a missing scope.
const UPFRONT_ENDPOINTS = {
  openai: ["https://api.openai.com/v1", { "openai-responses": "/responses", "openai-completions": "/chat/completions" }, (key) => ({ authorization: "Bearer " + key })],
  anthropic: ["https://api.anthropic.com", { "anthropic-messages": "/v1/messages" }, (key) => !key.startsWith("sk-ant-oat") && { "x-api-key": key, "anthropic-version": "2023-06-01" }],
};
function credentialRejectedUpfront(provider, fragment, key, stage) {
  fragment ??= {};
  const [base, paths, authorize] = UPFRONT_ENDPOINTS[provider] ?? [];
  const headers = authorize?.(key.trim());
  const api = fragment.api ?? Object.keys(paths ?? {})[0];
  if (!headers || Object.keys(fragment).some((name) => !["baseUrl", "api", "models", "request"].includes(name)) ||
    Object.keys(fragment.request ?? {}).some((name) => name !== "allowPrivateNetwork") ||
    String(fragment.baseUrl ?? base).replace(/\/+$/, "") !== base || !Object.hasOwn(paths, api) ||
    JSON.stringify(fragment.models ?? []).includes('"headers"') ||
    (Array.isArray(fragment.models) && fragment.models.some((model) => (model?.api !== undefined && model.api !== api) || model?.baseUrl !== undefined))) return false;
  const path = paths[api];
  stage("preflight");
  return require("node:child_process").spawnSync(process.execPath, ["-e",
    'fetch(process.env.U,{method:"POST",headers:JSON.parse(process.env.H),body:"{}",signal:AbortSignal.timeout(8000)}).then((r)=>process.exit(r.status===401?3:0),()=>process.exit(0))',
  ], {
    env: { U: base + path, H: JSON.stringify({ ...headers, "content-type": "application/json" }), NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS, SSL_CERT_FILE: process.env.SSL_CERT_FILE },
    stdio: "ignore", timeout: 10000, killSignal: "SIGKILL",
  }).status === 3;
}

function runOpenClawAuthenticationProbe(fs, capMs) {
  const stageStartedAt = Date.now();
  const stage = (stage) => console.error(JSON.stringify({ event: "openclaw.model_probe_stage", stage, elapsedMs: Date.now() - stageStartedAt, capMs }));
  stage("prepare");
  const { spawnSync } = require("node:child_process");
  const temporary = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const directory = fs.mkdtempSync(temporary + "/openclaw-auth-probe-");
  try {
    const model = process.env.OPENCLAW_HARNESS_MODEL;
    const provider = process.env.OPENCLAW_HARNESS_PROVIDER;
    const credentialEnvironment = process.env.OPENCLAW_HARNESS_CREDENTIAL_ENV;
    if (typeof provider !== "string" || typeof credentialEnvironment !== "string" ||
      typeof model !== "string" || !model.startsWith(provider + "/") ||
      !process.env[credentialEnvironment]?.trim()) return "UNAVAILABLE";
    const configuration = JSON.parse(process.env.OPENCLAW_HARNESS_PROBE_CONFIG);
    if (configuration.agents?.defaults?.model !== model) return "UNAVAILABLE";
    if (credentialRejectedUpfront(provider, configuration.models?.providers?.[provider], process.env[credentialEnvironment], stage)) return "AUTHENTICATION_FAILED";
    configuration.agents.defaults.workspace = directory + "/workspace";
    fs.mkdirSync(directory + "/workspace", { mode: 0o700 });
    const configPath = directory + "/openclaw.json";
    fs.writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
    stage("spawn");
    const result = spawnSync("node", [
      "/app/openclaw.mjs", "models", "status", "--json", "--probe",
      "--probe-provider", provider, "--probe-concurrency", "1",
      "--probe-timeout", "15000", "--probe-max-tokens", "256",
    ], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        TMPDIR: directory,
        OPENCLAW_STATE_DIR: directory + "/state",
        OPENCLAW_CONFIG_PATH: configPath,
        NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
        SSL_CERT_FILE: process.env.SSL_CERT_FILE,
        [credentialEnvironment]: process.env[credentialEnvironment],
      },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: capMs, killSignal: "SIGKILL", maxBuffer: 262144,
    });
    stage("returned");
    if (result.error?.code === "ETIMEDOUT") return "CAP";
    if (result.status !== 0 || result.error) return probeExitFailure(result);
    let output;
    try { output = JSON.parse(result.stdout); } catch { return probeFailure("INVALID_OUTPUT", "json"); }
    const results = output?.auth?.probes?.results;
    if (!Array.isArray(results) || results.length !== 1 ||
      results[0]?.provider !== provider || results[0].model !== model ||
      results[0].source !== "env") return probeFailure("INVALID_OUTPUT", "shape");
    const status = results[0].status;
    if (status === "ok") return undefined;
    if (status === "auth") return "AUTHENTICATION_FAILED";
    if (status === "timeout") return "MODEL_PROBE_TIMEOUT";
    return probeFailure("PROBE_STATUS", ["format", "rate_limit", "billing", "unknown", "no_model"].includes(status) ? status : "other");
  } catch {
    return probeFailure("WRAPPER_ERROR");
  } finally {
    stage("cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
    stage("complete");
  }
}
`;

const WORKSPACE_ASSET_HELPERS = String.raw`
const { cpSync, existsSync, lstatSync, readdirSync, symlinkSync } = require("node:fs");
const runtimeHomeDirectory = process.env.HOME || "/home/node";
if (!runtimeHomeDirectory.startsWith("/")) {
  throw new Error("The runtime HOME must be an absolute path.");
}
const runtimeAssetsDirectory = runtimeHomeDirectory + "/openclaw-runtime-assets";
const runtimeOpenClawDirectory = runtimeHomeDirectory + "/.openclaw";

function clearDirectoryContents(directory) {
  mkdirSync(directory, { recursive: true });
  for (const entry of readdirSync(directory)) {
    rmSync(join(directory, entry), { recursive: true, force: true });
  }
}

function publishImageTree(source, destination, required) {
  if (!existsSync(source)) {
    if (required) {
      throw new Error("Required runtime asset tree is missing: " + source);
    }
    clearDirectoryContents(destination);
    return;
  }
  if (!lstatSync(source).isDirectory()) {
    throw new Error("Runtime asset tree is not a directory: " + source);
  }
  if (required && readdirSync(source).length === 0) {
    throw new Error("Required runtime asset tree is empty: " + source);
  }
  mkdirSync(runtimeAssetsDirectory, { recursive: true });
  clearDirectoryContents(destination);
  cpSync(source, destination, { recursive: true });
}

function initializeRuntimeAssets() {
  publishImageTree("/app/skills", runtimeAssetsDirectory + "/bundled-skills", true);
  publishImageTree("/app/custodian-skills", runtimeAssetsDirectory + "/custodian-skills", false);
  publishImageTree("/app/plugin-skills", runtimeAssetsDirectory + "/plugin-skills", false);
  process.env.OPENCLAW_BUNDLED_SKILLS_DIR = runtimeAssetsDirectory + "/bundled-skills";
}

function publishAgentPluginSkillPath() {
  mkdirSync(runtimeOpenClawDirectory, { recursive: true });
  rmSync(runtimeOpenClawDirectory + "/plugin-skills", { recursive: true, force: true });
  symlinkSync(runtimeAssetsDirectory + "/plugin-skills", runtimeOpenClawDirectory + "/plugin-skills", "dir");
}

`;

/**
 * OpenClaw's agent database schema (`OPENCLAW_AGENT_SCHEMA_VERSION` in
 * src/state/openclaw-agent-db-contract.ts) at the runtime image's pinned
 * OPENCLAW_COMMIT. The runtime image test that migrates a released Gateway
 * fails when a pin moves it; update it with the pin.
 */
export const OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION = 24;

// A Gateway keeps its agent databases across runtime image upgrades. OpenClaw
// refuses one with an older schema (exit 78) until "openclaw doctor --fix"
// migrates it, and its own image entrypoint runs that Doctor pass before every
// Gateway start. This wrapper replaces that entrypoint, so it runs the same
// pass, but only when a database needs it: fresh and current state start
// without Doctor's ~15 s. Doctor must not rewrite the controller-owned
// configuration (OPENCLAW_CONFIG_READONLY). The schema versions after Doctor,
// not its exit status, decide: Doctor also exits non-zero for problems it can
// only report here. A failure holds the Gateway unready with the step named,
// rather than restarting into the same refusal and another Doctor backup.
const GATEWAY_STATE_MIGRATION_HELPER = String.raw`
function outdatedAgentDatabases() {
  const agentsDirectory = join(process.env.OPENCLAW_STATE_DIR || "/home/node/.openclaw", "agents");
  let agentIds;
  try {
    agentIds = require("node:fs").readdirSync(agentsDirectory);
  } catch {
    // Fresh state has no agents directory.
    return [];
  }
  // Outside the per-database try: without the module, startup fails instead of skipping.
  const { DatabaseSync } = require("node:sqlite");
  const outdated = [];
  for (const agentId of agentIds) {
    const path = join(agentsDirectory, agentId, "agent", "openclaw-agent.sqlite");
    let version;
    try {
      // A read-only open of a missing database fails here.
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        version = database.prepare("PRAGMA user_version").get().user_version;
      } finally {
        database.close();
      }
    } catch {
      // OpenClaw's own startup check reports a database it cannot read.
      continue;
    }
    // 0 is a database OpenClaw has not initialized; a newer one needs its backup.
    if (version > 0 && version < ${OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION}) outdated.push({ path, version });
  }
  return outdated;
}

function runStateMigrationDoctor() {
  return new Promise((resolve) => {
    const doctor = spawn(
      process.execPath,
      ["/app/openclaw.mjs", "doctor", "--fix", "--non-interactive"],
      { stdio: "inherit", env: { ...gatewayEnvironment(), OPENCLAW_CONFIG_READONLY: "1" } },
    );
    // Doctor's maintenance lease owns termination: let it stop its transaction.
    const stop = (signal) => {
      gatewayTerminating = true;
      doctor.kill(signal);
    };
    const onTerm = () => stop("SIGTERM");
    const onInt = () => stop("SIGINT");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    const settle = (outcome) => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      resolve(outcome);
    };
    doctor.on("error", (error) => settle("error-" + (error?.code ?? "spawn")));
    doctor.on("exit", (code, signal) => settle(signal ?? "exit-" + code));
  });
}

// Resolves true once Doctor brought every outdated database current; otherwise holds.
async function migrateGatewayState(outdated) {
  const startedAt = Date.now();
  console.error(
    "Migrating " + outdated.length + " OpenClaw agent database(s) from schema " +
      outdated.map(({ version }) => version).join(", ") + " to ${OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION} with openclaw doctor --fix.",
  );
  const doctorOutcome = await runStateMigrationDoctor();
  if (gatewayTerminating) process.exit(0);
  const remaining = outdatedAgentDatabases();
  if (remaining.length === 0) {
    logStartupPhase("state-migration", startedAt);
    return true;
  }
  logStartupPhase("state-migration", startedAt, "failed");
  publishRuntimeFailure("state-migration", "UNAVAILABLE");
  console.error(
    "Gateway state migration failed: openclaw doctor --fix (" + doctorOutcome + ") left " +
      remaining.map(({ path, version }) => path + " at schema " + version).join(", ") +
      ". OpenClaw was not started. Read the Doctor output above, fix the cause, then restart the Pod.",
  );
  setInterval(() => {}, 3600000);
  return false;
}
`;

export const GATEWAY_RUNTIME_ENTRYPOINT = String.raw`
const { accessSync, constants: fsConstants, mkdirSync, rmSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawn } = require("node:child_process");

// OCE upgrades this runtime by rolling out a selected image.
process.env.OPENCLAW_NO_AUTO_UPDATE = "1";

${PLUGIN_RUNTIME_HELPERS}
${WORKSPACE_ASSET_HELPERS}
${OPENCLAW_AUTH_PROBE_HELPERS}
${startupPhaseHelper("gateway")}
${GATEWAY_STATE_MIGRATION_HELPER}

function gatewayRuntimeReady() {
  if (pluginRuntimeStatusPort() !== undefined && pluginStatusReport.phase !== "ready") {
    return false;
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ready) => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };
    const request = pluginHttpGet(
      {
        host: "127.0.0.1",
        port: requireNonEmptyString(process.env.OPENCLAW_GATEWAY_PORT, "Gateway port"),
        path: "/readyz",
        timeout: 2_000,
      },
      (response) => {
        response.resume();
        settle(response.statusCode === 200);
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => settle(false));
  });
}

startPluginRuntimeStatusServer(gatewayRuntimeReady);

// A respawn for a changed Harness peer bounds its retries and falls back to a
// container restart when the peer keeps changing.
const GATEWAY_RESPAWN_ATTEMPTS = 3;
const GATEWAY_RESPAWN_LIMIT = 5;
const GATEWAY_RESPAWN_WINDOW_MS = 10 * 60_000;
const GATEWAY_RESPAWN_READY_TIMEOUT_MS = 180_000;
const GATEWAY_RESPAWN_READY_POLL_MS = 500;
const GATEWAY_RESPAWN_KILL_GRACE_MS = 10_000;
let gatewayTerminating = false;

// Forward to the current native process; between a respawn's stop and spawn
// there is none, and the wrapper exits itself.
function forwardTermination(currentChild) {
  const forward = (signal) => {
    if (gatewayTerminating) return;
    gatewayTerminating = true;
    const target = currentChild();
    if (target === undefined) {
      process.exit(0);
      return;
    }
    target.kill(signal);
    setTimeout(() => currentChild()?.kill("SIGKILL"), ${GATEWAY_STOP_TIMEOUT_MS}).unref();
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
}

function configureNativeWorkerProfile() {
  const deviceId = process.env.OPENCLAW_WORKSPACE_NODE_ID;
  const profileId = process.env.OPENCLAW_NATIVE_WORKER_PROFILE;
  if (profileId === undefined || deviceId === undefined) return;
  if (!/^[a-f0-9]{64}$/u.test(deviceId) || !profileId) {
    throw new Error("Dedicated OpenClaw worker placement configuration is invalid.");
  }
  const config = readOpenClawConfig();
  const cloudWorkers = isPlainObject(config.cloudWorkers) ? config.cloudWorkers : {};
  const profiles = isPlainObject(cloudWorkers.profiles) ? cloudWorkers.profiles : {};
  if (profiles[profileId] !== undefined) {
    throw new Error("Dedicated OpenClaw worker profile conflicts with admitted configuration.");
  }
  writeOpenClawConfig({
    ...config,
    cloudWorkers: {
      ...cloudWorkers,
      requiredProfile: profileId,
      profiles: {
        ...profiles,
        [profileId]: {
          provider: "device",
          settings: { device: deviceId, inference: "worker" },
        },
      },
    },
  });
}

function requireWorkspaceNodePlugins(config) {
  const plugins = isPlainObject(config.plugins) ? config.plugins : {};
  if (
    plugins.deny?.includes("file-transfer") ||
    plugins.entries?.["file-transfer"]?.enabled === false
  ) {
    throw new Error("The workspace node requires the file-transfer plugin.");
  }
}

// Every change this makes is under plugins.*, which OpenClaw hot-applies.
function configureWorkspaceNodePlugins(config, workspaceNodeId) {
  requireWorkspaceNodePlugins(config);
  const plugins = config.plugins ??= {};
  if (Array.isArray(plugins.allow)) {
    plugins.allow = [...new Set([...plugins.allow, "file-transfer"])];
  }
  const entries = plugins.entries ??= {};
  const transfer = entries["file-transfer"] ??= {};
  transfer.enabled = true;
  const fileConfig = transfer.config ??= {};
  // Provider-owned Harnesses can relocate the workspace. Deployment-backed
  // Kubernetes Harnesses retain the canonical path when no override is present.
  const nativeWorkspace = process.env.OPENCLAW_NATIVE_WORKER_PROFILE === undefined
    ? undefined : config.agents?.defaults?.workspace;
  const remoteRoot = process.env.OPENCLAW_REMOTE_WORKSPACE_ROOT || nativeWorkspace || "/home/node/workspace";
  // Codex stages reply artifacts while its client is live, even when both
  // hosts use the same workspace path. A shared path no longer means shared files.
  if (entries.codex) {
    const appServer = (entries.codex.config ??= {}).appServer ??= {};
    appServer.remoteWorkspaceRoot ??= remoteRoot;
  }
  // OCC edits four owner documents; native previews read the Agent workspace.
  const editable = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
  const memoryPaths = ["MEMORY.md", "memory.md", "DREAMS.md", "dreams.md", "memory", "memory/**"]
    .map((name) => remoteRoot + "/" + name);
  const skillRoots = [
    "/home/node/.openclaw/skills", "/home/node/.openclaw/plugin-skills",
    "/home/node/.openclaw/agents/*/agent/workshop-skills",
    "/home/node/.openclaw/worktree-sources/empty/*/workspace",
    "/home/node/.agents/skills", "/home/node/openclaw-runtime-assets/bundled-skills",
    "/home/node/openclaw-runtime-assets/custodian-skills",
    "/home/node/openclaw-runtime-assets/plugin-skills", "/app/extensions/*/skills",
  ];
  const nodes = fileConfig.nodes ??= {};
  if (nodes[workspaceNodeId] === undefined && nodes["*"] === undefined) {
    nodes[workspaceNodeId] = {
      ask: "off",
      allowReadPaths: [
        remoteRoot,
        remoteRoot + "/**",
        "/home/node/.openclaw",
        ...skillRoots.flatMap((root) => [root, root + "/**"]),
      ],
      allowWritePaths: [
        ...editable.map((name) => remoteRoot + "/" + name),
        ...memoryPaths,
        remoteRoot + "/skills",
        remoteRoot + "/skills/**",
        remoteRoot + "/.clawhub/lock.json",
        remoteRoot + "/.clawdhub/lock.json",
        remoteRoot + "/.openclaw/skill-installs/**",
        remoteRoot + "/media/inbound/openclaw-staged-*/**",
      ],
      followSymlinks: false,
    };
  }
  fileConfig.policyVersion ??= 2;
  (fileConfig.workspaces ??= {}).main = { nodeId: workspaceNodeId, remoteRoot };
}

// A Gateway with a workspace node serves no workspace: its /home/node/workspace
// is an empty local directory, while Codex runs in the Harness Pod. OpenClaw executes
// its dynamic tools in the Gateway process, so these would list, read, write or
// run commands in the Gateway Pod instead. Codex's native tools cover them in
// the Harness, and the file-transfer tools reach its workspace through the node.
// "terminal" types into shells running in the Gateway Pod, and "openclaw"
// delegates Gateway configuration changes, which could drop this list.
const GATEWAY_LOCAL_CODEX_DYNAMIC_TOOLS = [
  "ls", "read", "write", "edit", "apply_patch",
  "exec", "process", "gateway_exec", "gateway_process",
  "terminal", "openclaw",
];

function excludeGatewayLocalCodexTools(config) {
  const codex = config.plugins?.entries?.codex;
  if (!isPlainObject(codex)) {
    // APP_SERVER_URL names a remote Codex Harness: pin its providers even when
    // the Gateway config lacks the plugin entry. A dedicated OpenClaw Gateway
    // (no APP_SERVER_URL) runs its turns with these rows, so it keeps them.
    if (process.env.APP_SERVER_URL !== undefined) logOverriddenSettings(pinCodexProviderTransport(config));
    return;
  }
  const codexConfig = codex.config ??= {};
  const configured = codexConfig.codexDynamicToolsExclude ?? [];
  if (!Array.isArray(configured)) {
    throw new Error("The Codex plugin codexDynamicToolsExclude setting must be a list.");
  }
  codexConfig.codexDynamicToolsExclude = [...new Set([...configured, ...GATEWAY_LOCAL_CODEX_DYNAMIC_TOOLS])];
  // Automation triggers run model-written commands and scripts in the Gateway
  // process: stream schedules, script payloads and condition scripts. Timed
  // automations still run Codex turns in the Harness.
  const cron = config.cron ??= {};
  if (!isPlainObject(cron)) {
    throw new Error("The cron setting must be an object.");
  }
  const triggers = cron.triggers ??= {};
  if (!isPlainObject(triggers)) {
    throw new Error("The cron.triggers setting must be an object.");
  }
  const overridden = triggers.enabled === undefined || triggers.enabled === false ? [] : ["cron.triggers.enabled"];
  triggers.enabled = false;
  logOverriddenSettings([...overridden, ...pinCodexProviderTransport(config)]);
}

// Say which owner settings this Gateway replaced: setting names only, never values.
function logOverriddenSettings(settings) {
  if (settings.length > 0) console.error(JSON.stringify({ event: "runtime.gateway_settings_overridden", container: "gateway", settings }));
}

// OpenClaw's built-in runtime runs in the Gateway process with Gateway-local
// tools. An operator's "/model codex/<model> --runtime openclaw" selects it for
// a session, and Codex hands a turn to it when the row of one of its providers
// (codex, openai) carries request transport overrides. The Harness reaches the
// model itself, so here those rows only name models: fields that override the
// transport, start a local service, or make Codex declare that fallback are
// dropped, and an authored transport becomes the unreachable stub. A built-in
// run then has no model to call.
const CODEX_PROVIDER_STUB_URL = "http://127.0.0.1:9";
const CODEX_PROVIDER_KEPT_KEYS = new Set(["models", "maxTokens", "agentRuntime"]);
const CODEX_MODEL_KEPT_KEYS = new Set([
  "id", "name", "reasoning", "input", "cost", "contextWindow", "contextTokens",
  "maxTokens", "thinkingLevelMap", "agentRuntime", "mediaInput", "metadataSource",
]);

function keepKeys(value, kept) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => kept.has(key)));
}

// Returns the owner settings it dropped or replaced.
function pinCodexProviderTransport(config) {
  const overridden = new Set();
  const models = config.models ??= {};
  if (!isPlainObject(models)) {
    throw new Error("The models setting must be an object.");
  }
  const providers = models.providers ??= {};
  if (!isPlainObject(providers)) {
    throw new Error("The models.providers setting must be an object.");
  }
  // OpenClaw matches provider keys after trimming and lowercasing.
  const providerId = (key) => key.trim().toLowerCase();
  const keys = Object.keys(providers).filter((key) => ["codex", "openai"].includes(providerId(key)));
  if (!keys.some((key) => providerId(key) === "codex")) {
    // "codex" is a bundled provider: without a row it would keep its own transport.
    providers.codex = {};
    keys.push("codex");
  }
  for (const key of keys) {
    const id = providerId(key);
    const provider = providers[key];
    if (!isPlainObject(provider)) {
      throw new Error("The " + id + " model provider setting must be an object.");
    }
    const pinned = keepKeys(provider, CODEX_PROVIDER_KEPT_KEYS);
    const stub = { baseUrl: CODEX_PROVIDER_STUB_URL, api: "openai-responses" };
    const row = "models.providers." + id + ".";
    for (const name of Object.keys(provider)) {
      if (!CODEX_PROVIDER_KEPT_KEYS.has(name) && provider[name] !== stub[name]) overridden.add(row + name);
    }
    if (provider.models !== undefined) {
      if (!Array.isArray(provider.models) || !provider.models.every(isPlainObject)) {
        throw new Error("The " + id + " model provider models setting must be a list of objects.");
      }
      for (const model of provider.models) {
        for (const name of Object.keys(model)) {
          if (!CODEX_MODEL_KEPT_KEYS.has(name)) overridden.add(row + "models[]." + name);
        }
      }
      pinned.models = provider.models.map((model) => keepKeys(model, CODEX_MODEL_KEPT_KEYS));
    }
    // An openai row that names no transport keeps OpenClaw's default, which has
    // no credential in the Gateway, and Codex keeps owning its account's models.
    const authoredTransport =
      id === "codex" || provider.baseUrl !== undefined || provider.api !== undefined;
    providers[key] = authoredTransport ? { ...pinned, ...stub } : pinned;
  }
  return [...overridden];
}

const WORKSPACE_NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const workspaceNodeBindingPath = process.env.OPENCLAW_WORKSPACE_NODE_PATH;

// The controller writes {revisionId, deviceId} to an optional ConfigMap volume.
// A missing, partial or foreign file (another revision of this Agent) is absent.
function readWorkspaceNodeBinding() {
  if (workspaceNodeBindingPath === undefined) return undefined;
  let binding;
  try {
    binding = JSON.parse(pluginReadFileSync(workspaceNodeBindingPath, "utf8"));
  } catch {
    return undefined;
  }
  if (
    !isPlainObject(binding) ||
    binding.revisionId !== process.env.OPENCLAW_AGENT_REVISION_ID ||
    typeof binding.deviceId !== "string" ||
    !WORKSPACE_NODE_ID_PATTERN.test(binding.deviceId)
  ) {
    return undefined;
  }
  return binding.deviceId;
}

// OpenClaw hot-applies plugins.* and cloudWorkers.* (gateway/config-reload-plan.ts);
// any other change, gateway.* in particular, would restart the Gateway.
const HOT_APPLIED_CONFIG_KEYS = new Set(["plugins", "cloudWorkers"]);

function assertHotApplicableChange(previous, next) {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (!HOT_APPLIED_CONFIG_KEYS.has(key) && !pluginDeepEqual(previous[key], next[key])) {
      throw new Error("A workspace node update would change configuration OpenClaw cannot hot-apply.");
    }
  }
}

// OpenClaw watches the config file: replace it whole so it never reads a partial write.
function replaceOpenClawConfig(config) {
  const { renameSync } = require("node:fs");
  const target = writableOpenClawConfigPath();
  const staged = target + ".workspace-node-" + process.pid;
  pluginWriteFileSync(staged, JSON.stringify(config), { mode: 0o600 });
  renameSync(staged, target);
  process.env.OPENCLAW_CONFIG_PATH = target;
}

// The running Gateway's own view of file-transfer: its runtime state in the
// live plugin registry ("active", "service-failed", "disabled", "unloaded")
// and that registry's generation, which every plugin reload replaces. A Gateway
// that refused this CLI's credentials answers { refused: true, reason }.
async function openClawFileTransferState() {
  const result = await callNativeGateway(
    "plugins.list",
    {},
    8000,
    undefined,
    4 * 1024 * 1024,
  );
  if (result.authenticationRefused === true) {
    return { refused: true, reason: result.authenticationRefusalReason };
  }
  if (!result.ok || !isPlainObject(result.value) || !Array.isArray(result.value.plugins)) {
    return undefined;
  }
  const plugin = result.value.plugins.find((entry) => isPlainObject(entry) && entry.id === "file-transfer");
  const state = isPlainObject(plugin?.runtime) && typeof plugin.runtime.state === "string"
    ? plugin.runtime.state
    : "unloaded";
  return { state, generation: result.value.generation };
}

class WorkspaceNodeFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function withWorkspaceNodeFailure(code, run) {
  try {
    return run();
  } catch (error) {
    throw new WorkspaceNodeFailure(code, error instanceof Error ? error.message : String(error));
  }
}

const openClawAuthenticationFailure =
  process.env.OPENCLAW_HARNESS_PROBE_CONFIG === undefined
    ? undefined
    : probeOpenClawAuthenticationFailure();
if (process.env.OPENCLAW_HARNESS_PROBE_CONFIG !== undefined) {
  logStartupPhase("model-probe", startupPhaseOrigin, openClawAuthenticationFailure === undefined ? "ok" : "failed");
}
if (openClawAuthenticationFailure !== undefined) {
  holdFailedAuthentication("model-probe", openClawAuthenticationFailure.code, openClawAuthenticationFailure.cause);
} else {
mkdirSync("/home/node/.openclaw", { recursive: true });
mkdirSync("/home/node/workspace", { recursive: true });
if (process.env.OPENCLAW_WORKSPACE_DIR !== undefined) {
  const assetsStartedAt = Date.now();
  mkdirSync(process.env.OPENCLAW_WORKSPACE_DIR, { recursive: true });
  initializeRuntimeAssets();
  logStartupPhase("runtime-assets", assetsStartedAt);
}
delete process.env.OPENCLAW_LOG_LEVEL;
const pluginRuntime = readGatewayPluginRuntime();
const followsPeerStatus =
  pluginRuntime?.manifest?.kind === "codex" && hasEnabledPluginSelections(pluginRuntime);
// A respawn configures from the file a container restart would start from.
const initialConfigPath = process.env.OPENCLAW_CONFIG_PATH;

// Write the configuration the native Gateway starts with. It depends only on the
// admitted configuration, the Harness peer status and the workspace node binding,
// so an in-place respawn repeats it for a changed peer. For a Codex peer this
// installs nothing: the Harness installs the plugins; the Gateway applies its result.
function configureGateway(peerStatus) {
  process.env.OPENCLAW_CONFIG_PATH = initialConfigPath;
  configureNativeWorkerProfile();
  const peerFailures = peerStatus?.failures ?? readPluginFailuresFromEnvironment();
  if (peerStatus !== undefined) {
    process.env.APP_SERVER_TOKEN = derivePluginAppServerToken(peerStatus.startupId);
  }
  const pluginInstallStartedAt = Date.now();
  const pluginResult =
    pluginRuntime === undefined
      ? { successfulPluginIds: [], failures: peerFailures }
      : installOpenClawPlugins(pluginRuntime, peerFailures);
  if (pluginRuntime !== undefined) {
    logStartupPhase("plugin-install", pluginInstallStartedAt);
  }
  if (peerStatus !== undefined) {
    pluginResult.successfulPluginIds = peerStatus.successfulPluginIds;
  }
  // A native worker profile, or a Gateway whose controller cannot read its runtime
  // status, receives its node in the environment; the others read the binding file.
  const environmentWorkspaceNodeId = process.env.OPENCLAW_WORKSPACE_NODE_ID;
  let workspaceNodeId;
  if (
    environmentWorkspaceNodeId !== undefined ||
    workspaceNodeBindingPath !== undefined ||
    process.env.APP_SERVER_URL !== undefined ||
    process.env.OPENCLAW_NATIVE_WORKER_PROFILE !== undefined
  ) {
    const config = readOpenClawConfig();
    // The first pairing records its command grant before a node ID is available.
    // gateway.* changes restart OpenClaw, so this is written only before a spawn.
    const commands = ((config.gateway ??= {}).nodes ??= {}).commands ??= {};
    commands.allow = [...new Set([...(commands.allow ?? []), "file.fetch", "file.stat", "file.write", "file.create", "dir.list", "workspace.memory", "workspace.skills"])];
    if (environmentWorkspaceNodeId !== undefined || workspaceNodeBindingPath !== undefined) {
      // Refuse a revision that cannot host its node now, not when the node arrives.
      requireWorkspaceNodePlugins(config);
      excludeGatewayLocalCodexTools(config);
    }
    workspaceNodeId = environmentWorkspaceNodeId ?? readWorkspaceNodeBinding();
    if (workspaceNodeId !== undefined) {
      configureWorkspaceNodePlugins(config, workspaceNodeId);
    }
    writeOpenClawConfig(config);
  }
  return { pluginResult, workspaceNodeId };
}

// The native Gateway process. A respawn for a changed Harness peer replaces it;
// any other exit ends the wrapper, and so restarts the container.
let child;
let childRunning = false;
let childExited;
let respawning = false;
let waitingForPeerDuringOutage = false;
let verifyingServingReplacement = false;
let stoppingContainer = false;
let gatewayGeneration = 0;

// OpenClaw backs up a config file it can write. One OCC mounted read-only is
// externally managed: say so, so OpenClaw skips that backup instead of logging
// EROFS on every start.
function gatewayEnvironment() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (configPath === undefined) return process.env;
  try {
    accessSync(dirname(configPath), fsConstants.W_OK);
    return process.env;
  } catch {
    return { ...process.env, OPENCLAW_CONFIG_READONLY: "1" };
  }
}

function startGatewayProcess() {
  const spawned = spawn(
    "node",
    ["/app/openclaw.mjs", "gateway", "--port", process.env.OPENCLAW_GATEWAY_PORT],
    { stdio: "inherit", env: gatewayEnvironment() },
  );
  child = spawned;
  childRunning = true;
  gatewayGeneration++;
  childExited = new Promise((resolve) => {
    spawned.on("exit", (code, signal) => {
      if (spawned === child) childRunning = false;
      resolve();
      if (stoppingContainer) {
        process.exit(1);
        return;
      }
      if (gatewayTerminating || ((!respawning || waitingForPeerDuringOutage || verifyingServingReplacement) && spawned === child)) {
        process.exit(code ?? (signal === "SIGTERM" ? 0 : 1));
      }
    });
  });
  return Date.now();
}

// Fall back to a container restart, which the kubelet backs off.
function stopContainer() {
  if (stoppingContainer) return;
  stoppingContainer = true;
  if (!childRunning) {
    process.exit(1);
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => process.exit(1), ${GATEWAY_STOP_TIMEOUT_MS}).unref();
}

let pluginResult;
let peerStatus;
let resetWorkspaceNodeTracking = () => {};
(async () => {
peerStatus = followsPeerStatus
  ? await timeStartupPhase("peer-plugin-status", waitForPeerPluginRuntimeStatus)
  : undefined;
const started = configureGateway(peerStatus);
// Doctor reads the configuration the Gateway starts with. Current state adds
// no await before the spawn.
const outdatedDatabases = outdatedAgentDatabases();
if (outdatedDatabases.length > 0 && !(await migrateGatewayState(outdatedDatabases))) return;
pluginResult = started.pluginResult;
publishPluginRuntimeStatus({ phase: "ready", ...pluginResult });
const startWorkspaceNodeId = started.workspaceNodeId;
publishRuntimeReady();
// Everything before this line delays the native Gateway process.
logStartupPhase("native-spawn", startupPhaseOrigin);
// Apply budgets start when OpenClaw does, not at wrapper start: login, the model
// probe and plugin install must not count against them.
const childSpawnedAt = startGatewayProcess();
forwardTermination(() => (childRunning ? child : undefined));
if (workspaceNodeBindingPath !== undefined) {
  // The wrapper writing the config is not the ack: OpenClaw must report the
  // file-transfer plugin active in a plugin registry loaded after the write.
  const WORKSPACE_NODE_APPLY_TIMEOUT_MS = 30_000;
  let written;
  let firstSeenAt;
  let stoppingForChangedWorkspaceNode = false;
  let pollInFlight = false;
  // A new Gateway process loads its configuration, node included, from scratch:
  // its ack is required again.
  resetWorkspaceNodeTracking = (deviceId, spawnedAt) => {
    written = deviceId === undefined
      ? undefined
      : { deviceId, at: spawnedAt, activeBefore: false };
    firstSeenAt = undefined;
    runtimeWorkspaceNodeId = undefined;
    runtimeWorkspaceNodeFailure = undefined;
  };
  resetWorkspaceNodeTracking(startWorkspaceNodeId, childSpawnedAt);
  const reportFailure = (code, reason) => {
    if (runtimeWorkspaceNodeFailure?.code === code) return;
    runtimeWorkspaceNodeFailure = { code, checkedAt: new Date().toISOString() };
    // Fixed codes, and OpenClaw's token-shaped refusal reason, only; a changed
    // cause is logged again.
    console.error(JSON.stringify({
      event: "runtime.workspace_node",
      container: "gateway",
      outcome: "failed",
      code,
      ...(reason === undefined ? {} : { reason }),
    }));
  };
  const pollWorkspaceNode = async () => {
    const deviceId = readWorkspaceNodeBinding();
    if (deviceId === undefined || deviceId === runtimeWorkspaceNodeId) return;
    if (written !== undefined && written.deviceId !== deviceId) {
      // Another node for this revision: replace the config from a clean start.
      if (stoppingForChangedWorkspaceNode) return;
      stoppingForChangedWorkspaceNode = true;
      clearInterval(workspaceNodePoll);
      logStartupPhase("workspace-node-changed", startupPhaseOrigin);
      stopContainer();
      return;
    }
    firstSeenAt ??= Date.now();
    const generation = gatewayGeneration;
    // A respawn replaced the process this poll was talking to: start over.
    const superseded = () => respawning || generation !== gatewayGeneration;
    if (written === undefined) {
      const before = await openClawFileTransferState();
      if (superseded()) return;
      if (before?.refused) {
        reportFailure("GATEWAY_UNAUTHORIZED", before.reason);
        return;
      }
      if (before === undefined) {
        if (Date.now() - firstSeenAt > WORKSPACE_NODE_APPLY_TIMEOUT_MS) reportFailure("GATEWAY_UNAVAILABLE");
        return;
      }
      const previous = withWorkspaceNodeFailure("CONFIG_UNREADABLE", readOpenClawConfig);
      const next = JSON.parse(JSON.stringify(previous));
      withWorkspaceNodeFailure("FILE_TRANSFER_DENIED", () => configureWorkspaceNodePlugins(next, deviceId));
      withWorkspaceNodeFailure("NOT_HOT_APPLICABLE", () => assertHotApplicableChange(previous, next));
      withWorkspaceNodeFailure("CONFIG_UNWRITABLE", () => replaceOpenClawConfig(next));
      written = {
        deviceId,
        at: Date.now(),
        activeBefore: before.state === "active",
        generationBefore: before.generation,
      };
      return;
    }
    const after = await openClawFileTransferState();
    if (superseded()) return;
    if (after?.refused) {
      // The Gateway refuses its own CLI: it cannot confirm this node, now or later.
      reportFailure("GATEWAY_UNAUTHORIZED", after.reason);
      return;
    }
    if (
      after?.state === "active" &&
      (!written.activeBefore || after.generation !== written.generationBefore)
    ) {
      runtimeWorkspaceNodeId = deviceId;
      runtimeWorkspaceNodeFailure = undefined;
      logStartupPhase("workspace-node", written.at);
      return;
    }
    if (after?.state === "service-failed") {
      reportFailure("FILE_TRANSFER_FAILED");
    } else if (Date.now() - written.at > WORKSPACE_NODE_APPLY_TIMEOUT_MS) {
      reportFailure(after === undefined ? "GATEWAY_UNAVAILABLE" : "RELOAD_NOT_CONFIRMED");
    }
  };
  const workspaceNodePoll = setInterval(async () => {
    if (pollInFlight || respawning) return;
    pollInFlight = true;
    try {
      await pollWorkspaceNode();
    } catch (error) {
      // The next poll retries; the status carries the current cause.
      reportFailure(error instanceof WorkspaceNodeFailure ? error.code : "UNAVAILABLE");
    } finally {
      pollInFlight = false;
    }
  }, 1_000);
  workspaceNodePoll.unref?.();
}
if (followsPeerStatus) {
  let pollInFlight = false;
  const recentRespawns = [];
  const peerChanged = (current) =>
    current.startupId !== peerStatus.startupId ||
    current.podUid !== peerStatus.podUid ||
    !samePluginIds(current.successfulPluginIds, peerStatus.successfulPluginIds) ||
    !samePluginFailures(current.failures, pluginResult.failures);
  // Stop the native Gateway within its drain budget; one that outlives SIGKILL
  // leaves only the container restart.
  const stopGatewayProcess = async () => {
    if (!childRunning) return;
    child.kill("SIGTERM");
    const exited = childExited;
    const escalate = setTimeout(() => child.kill("SIGKILL"), ${GATEWAY_STOP_TIMEOUT_MS});
    escalate.unref?.();
    let giveUp;
    const stuck = new Promise((resolve) => {
      giveUp = setTimeout(() => resolve(true), ${GATEWAY_STOP_TIMEOUT_MS} + GATEWAY_RESPAWN_KILL_GRACE_MS);
      giveUp.unref?.();
    });
    const timedOut = await Promise.race([exited.then(() => false), stuck]);
    clearTimeout(escalate);
    clearTimeout(giveUp);
    if (timedOut) throw new Error("The native Gateway did not stop.");
  };
  // Serving means the new process answers its own readiness endpoint; the
  // plugin status stays "starting" until the peer is rechecked.
  const waitForGatewayServing = async () => {
    const deadline = Date.now() + GATEWAY_RESPAWN_READY_TIMEOUT_MS;
    while (childRunning && Date.now() < deadline) {
      try {
        const response = await fetch(
          "http://127.0.0.1:" + process.env.OPENCLAW_GATEWAY_PORT + "/readyz",
          { signal: AbortSignal.timeout(2_000), redirect: "error" },
        );
        if (response.status === 200 && childRunning) {
          verifyingServingReplacement = true;
          return true;
        }
      } catch {}
      await pluginRuntimeDelay(GATEWAY_RESPAWN_READY_POLL_MS);
    }
    return false;
  };
  // A changed Harness peer requires a new credential for the replacement and
  // may change the configured plugin result. Respawn only the native process:
  // the container, its volumes and runtime assets stay, and there is no kubelet
  // crash-loop backoff.
  const respawnForPeerStatus = async (current) => {
    respawning = true;
    // Mark plugin status unready before replacing the native Gateway.
    publishPluginRuntimeStatus({ phase: "starting", ...pluginResult });
    const respawnStartedAt = Date.now();
    logStartupPhase("peer-status-changed", startupPhaseOrigin);
    try {
      if (current === undefined) {
        // Unreadable status need not mean a new Harness: the same Harness
        // process coming back leaves this Gateway's credential valid.
        waitingForPeerDuringOutage = true;
        const returned = await waitForPeerPluginRuntimeStatus();
        waitingForPeerDuringOutage = false;
        if (gatewayTerminating || !childRunning) return;
        if (!peerChanged(returned)) {
          publishPluginRuntimeStatus({ phase: "ready", ...pluginResult });
          logStartupPhase("peer-status-restored", respawnStartedAt);
          return;
        }
      }
      while (recentRespawns.length > 0 && respawnStartedAt - recentRespawns[0] > GATEWAY_RESPAWN_WINDOW_MS) {
        recentRespawns.shift();
      }
      if (recentRespawns.length >= GATEWAY_RESPAWN_LIMIT) {
        throw new Error("The Harness peer changed too often to respawn the Gateway in place.");
      }
      recentRespawns.push(respawnStartedAt);
      await stopGatewayProcess();
      for (let attempt = 1; ; attempt++) {
        // Configure from the latest ready status, which may be newer than the change.
        peerStatus = await waitForPeerPluginRuntimeStatus();
        const configured = configureGateway(peerStatus);
        pluginResult = configured.pluginResult;
        if (gatewayTerminating) return;
        const spawnedAt = startGatewayProcess();
        resetWorkspaceNodeTracking(configured.workspaceNodeId, spawnedAt);
        const serving = await waitForGatewayServing();
        if (gatewayTerminating) return;
        if (serving) break;
        if (attempt >= GATEWAY_RESPAWN_ATTEMPTS) {
          throw new Error("The respawned native Gateway did not become ready.");
        }
        await stopGatewayProcess();
        await pluginRuntimeDelay(1_000 * 2 ** (attempt - 1));
      }
      // Recheck the Harness before marking the replacement ready.
      let verifiedPeer;
      try {
        verifiedPeer = await readPeerPluginRuntimeStatus();
      } catch {
        verifiedPeer = undefined;
      } finally {
        verifyingServingReplacement = false;
      }
      if (gatewayTerminating || !childRunning) return;
      if (verifiedPeer === undefined) {
        throw new Error("The Harness peer became unavailable during Gateway startup.");
      }
      if (peerChanged(verifiedPeer)) {
        logStartupPhase("peer-verification-changed", respawnStartedAt, "failed");
        throw new Error("The Harness peer changed during Gateway startup.");
      }
      publishPluginRuntimeStatus({ phase: "ready", ...pluginResult });
      logStartupPhase("gateway-respawn", respawnStartedAt);
    } catch {
      logStartupPhase("gateway-respawn", respawnStartedAt, "failed");
      stopContainer();
    } finally {
      waitingForPeerDuringOutage = false;
      verifyingServingReplacement = false;
      respawning = false;
    }
  };
  setInterval(async () => {
    if (pollInFlight || respawning || stoppingContainer) return;
    pollInFlight = true;
    try {
      let current;
      try {
        current = await readPeerPluginRuntimeStatus();
      } catch {
        current = undefined;
      }
      if (current === undefined || peerChanged(current)) {
        await respawnForPeerStatus(current);
      }
    } finally {
      pollInFlight = false;
    }
  }, 2_000).unref();
}
})().catch((error) => {
  if (!holdPluginApproverConfigurationFailure(error)) throw error;
});
}
`;

export const CODEX_OAUTH_BOOTSTRAP_ENTRYPOINT = String.raw`
try {
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.CODEX_HOME;
const expected = {
  sourceUid: process.env.OCE_CODEX_OAUTH_SOURCE_UID,
  volumeUid: process.env.OCE_CODEX_OAUTH_VOLUME_UID,
};
if (!directory || !expected.sourceUid || !expected.volumeUid) {
  throw new Error("OAuth bootstrap identity is missing.");
}
const authPath = path.join(directory, "auth.json");
const receiptPath = path.join(directory, ".oce-oauth.json");
const validAuth = (auth) => auth?.auth_mode === "chatgpt" &&
  [auth.tokens?.id_token, auth.tokens?.access_token, auth.tokens?.refresh_token]
    .every((value) => typeof value === "string" && value.trim().length > 0);
const readRegularJson = (target) =>
  fs.lstatSync(target, { throwIfNoEntry: false })?.isFile()
    ? JSON.parse(fs.readFileSync(target, "utf8"))
    : undefined;
if (fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() === false) {
  fs.rmSync(directory, { force: true });
}
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
let receipt;
try {
  receipt = readRegularJson(receiptPath);
} catch {
  // An unreadable receipt proves nothing; seeding below replaces the directory contents.
}
if (receipt?.sourceUid === expected.sourceUid) {
  if (receipt.volumeUid !== expected.volumeUid || !validAuth(readRegularJson(authPath))) {
    throw new Error("OAuth runtime credentials require reconnect.");
  }
} else {
  const auth = JSON.parse(fs.readFileSync(process.env.OCE_CODEX_OAUTH_SEED_PATH, "utf8"));
  if (!validAuth(auth)) {
    throw new Error("OAuth bootstrap credentials are invalid.");
  }
  // A new source starts from an empty Codex home: no previous login, sessions, or links.
  // rmSync removes symbolic links themselves and never follows them.
  for (const entry of fs.readdirSync(directory)) {
    fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
  }
  const writeJson = (target, value) => {
    const temporary = target + ".bootstrap";
    // Exclusive creation fails on any existing path, including a planted symbolic link.
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, target);
  };
  writeJson(authPath, auth);
  writeJson(receiptPath, expected);
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  // Readiness reports only a verified final state.
  const written = readRegularJson(receiptPath);
  if (
    !validAuth(readRegularJson(authPath)) ||
    written?.sourceUid !== expected.sourceUid ||
    written.volumeUid !== expected.volumeUid
  ) {
    throw new Error("OAuth bootstrap could not verify private credentials.");
  }
}
} catch {
  throw new Error("OAuth bootstrap could not initialize private credentials.");
}
`;

// Kubernetes Codex implementation: this file-only node is not an OpenClaw
// execution worker; its explicit command allowlist disables worker hosting.
// It serves files while Codex restarts. Reuse Codex login/plugin initialization
// for each Codex start; other Harnesses need their own execution composition.
// Codex starts from bounded program pieces, like the container that runs this.
//
// A Deployment-backed Harness starts before its node setup exists and reads the
// code from OPENCLAW_NODE_SETUP_PATH, an optional Secret volume. Codex starts at
// once; the node slot starts when the file holds a complete code. The controller
// removes the code after pairing, so a later start without it reconnects with
// the saved device identity. No deadline here: the controller's convergence
// deadline governs a setup that never arrives. SandboxDriver Harnesses still
// receive OPENCLAW_NODE_SETUP_CODE in the environment.
export const AGENT_WITH_NODE_ENTRYPOINT = String.raw`
const { chmodSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { execFile, spawn, spawnSync } = require("node:child_process");
${WORKSPACE_ASSET_HELPERS}
${startupPhaseHelper("agent")}
const state = process.env.OPENCLAW_NODE_STATE_DIR;
const setupEnvironment = process.env.OPENCLAW_NODE_SETUP_CODE;
const setupPath = process.env.OPENCLAW_NODE_SETUP_PATH;
const setupEnvelopePath = process.env.OPENCLAW_NODE_SETUP_ENVELOPE;
const workspaceDirectory = process.env.OPENCLAW_WORKSPACE_DIR ||
  (process.env.HOME || "/home/node") + "/workspace";
const providerSetup = Boolean(setupEnvelopePath);
if (
  !state ||
  !workspaceDirectory.startsWith("/") ||
  [Boolean(setupEnvironment), Boolean(setupPath), providerSetup].filter(Boolean).length !== 1
) {
  throw new Error("The workspace node is not provisioned.");
}
mkdirSync(state, { recursive: true });
initializeRuntimeAssets();
publishAgentPluginSkillPath();
const configPath = join(state, "openclaw.json");
writeFileSync(configPath, JSON.stringify({
  agents: { defaults: JSON.parse(process.env.OPENCLAW_WORKSPACE_BOOTSTRAP || "{}") },
  plugins: {
    allow: ["file-transfer"],
    slots: { memory: "none" },
    entries: { "file-transfer": { enabled: true } },
  },
}), { mode: 0o600 });
// Both the node file worker and Codex execute installed Skill dependencies.
const harnessPath = [
  process.env.PATH,
  runtimeHomeDirectory + "/.local/bin",
  runtimeOpenClawDirectory + "/tools/node/npm/bin",
].filter(Boolean).join(":");
const nodeEnv = {
  HOME: process.env.HOME,
  PATH: harnessPath,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_NO_AUTO_UPDATE: "1",
};
if (process.env.OPENCLAW_NODE_CA_PEM) {
  const caPath = join(state, "gateway-ca.pem");
  writeFileSync(caPath, process.env.OPENCLAW_NODE_CA_PEM, { mode: 0o600 });
  nodeEnv.NODE_EXTRA_CA_CERTS = caPath;
} else if (process.env.OPENCLAW_NODE_CA_PATH) {
  nodeEnv.NODE_EXTRA_CA_CERTS = process.env.OPENCLAW_NODE_CA_PATH;
}
// The workspace belongs to the Harness. Native setup creates missing defaults
// without replacing owner edits; neither child may serve an uninitialized workspace.
const baselineStartedAt = Date.now();
const baseline = spawnSync(process.execPath, [
  "/app/openclaw.mjs", "setup", "--baseline", "--workspace", workspaceDirectory, "--json",
], { env: nodeEnv, stdio: "inherit" });
logStartupPhase("workspace-baseline", baselineStartedAt, baseline.error || baseline.status !== 0 ? "failed" : "ok");
if (baseline.error) throw baseline.error;
if (baseline.status !== 0) throw new Error("Workspace initialization failed.");
const codexEnv = { ...process.env, PATH: harnessPath };
// Per-run hook capabilities are delivered by the authenticated app-server connection.
// Keep them outside the model workspace and the file-transfer plugin's roots.
const hookDirectory = join(process.env.HOME, ".oce-native-hooks");
mkdirSync(hookDirectory, { recursive: true, mode: 0o700 });
chmodSync(hookDirectory, 0o700);
if (process.env.OPENCLAW_NODE_CA_PEM) {
  const inheritedCa = process.env.NODE_EXTRA_CA_CERTS
    ? readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8")
    : "";
  const caPath = join(hookDirectory, "gateway-ca.pem");
  writeFileSync(caPath, [inheritedCa, process.env.OPENCLAW_NODE_CA_PEM].filter(Boolean).join("\n"), { mode: 0o600 });
  codexEnv.NODE_EXTRA_CA_CERTS = caPath;
}
delete codexEnv.OPENCLAW_NODE_SETUP_CODE;
delete codexEnv.OPENCLAW_NODE_SETUP_PATH;
delete codexEnv.OPENCLAW_NODE_SETUP_ENVELOPE;
delete codexEnv.OPENCLAW_NODE_CA_PEM;
delete codexEnv.OPENCLAW_NODE_CA_PATH;
delete codexEnv.OPENCLAW_NODE_STATE_DIR;
delete codexEnv.OPENCLAW_WORKSPACE_BOOTSTRAP;
delete codexEnv.OPENCLAW_NODE_DISPLAY_NAME;
// The node saves its first display name (the first Pod's host name) and reuses
// it across revisions unless told otherwise; the controller names it after the Agent.
const nodeDisplayName = process.env.OPENCLAW_NODE_DISPLAY_NAME;
const nodeCommands = [
  ...(nodeDisplayName ? ["--display-name", nodeDisplayName] : []),
  "--commands", "file.fetch,file.stat,file.write,file.create,dir.list,workspace.memory,workspace.skills",
];
// The kubelet swaps Secret volume contents atomically, but an empty, truncated
// or otherwise undecodable code is treated as absent and never started.
// Provider snapshots can change after setup renewal. Refresh the cached value
// whenever the projection is readable and retain the latest complete snapshot
// as a fallback while the projection is temporarily absent.
let cachedProviderSetupCode;
function readSetupCode() {
  if (setupEnvironment) return setupEnvironment;
  if (providerSetup) {
    try {
      const payload = JSON.parse(readFileSync(setupEnvelopePath, "utf8"));
      if (
        payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        typeof payload.bootstrapToken !== "string" ||
        payload.bootstrapToken.length === 0
      ) {
        return undefined;
      }
      cachedProviderSetupCode = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      return cachedProviderSetupCode;
    } catch {
      return cachedProviderSetupCode;
    }
  }
  let code;
  try {
    code = readFileSync(setupPath, "utf8").trim();
  } catch {
    return undefined;
  }
  const encoded = code.toLowerCase().startsWith("oc-pair://") ? code.slice("oc-pair://".length) : code;
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? code : undefined;
  } catch {
    return undefined;
  }
}
// "unknown" until checked; pairing can create the identity, so a start with a
// code resets it. Only a missing code triggers the check. A failed or timed-out
// probe (CPU contention while Codex starts) is not proof of absence, and a later
// start may need the identity after the controller removed the code, so any
// result other than "present" is re-checked with a bounded backoff.
let savedIdentity = "unknown";
let identityRetryAt = 0;
let identityBackoff = 2_000;
function checkSavedIdentity() {
  savedIdentity = "checking";
  execFile(process.execPath, ["/app/openclaw.mjs", "node", "identity", "--json"],
    { env: nodeEnv, timeout: 30_000 }, (error, stdout) => {
      let deviceId;
      try { deviceId = JSON.parse(stdout).deviceId; } catch {}
      if (!error && /^[a-f0-9]{64}$/u.test(deviceId ?? "")) {
        savedIdentity = "present";
        return;
      }
      savedIdentity = "unknown";
      identityRetryAt = Date.now() + identityBackoff;
      identityBackoff = Math.min(identityBackoff * 2, 30_000);
    });
}
let nodeSetupWait;
function nodeArguments() {
  const code = readSetupCode();
  if (code !== undefined) {
    savedIdentity = "unknown";
    identityRetryAt = 0;
    identityBackoff = 2_000;
    return ["/app/openclaw.mjs", "node", "run", "--pair-if-needed", code, ...nodeCommands];
  }
  if (savedIdentity === "present") return ["/app/openclaw.mjs", "node", "run", ...nodeCommands];
  if (savedIdentity === "unknown" && Date.now() >= identityRetryAt) checkSavedIdentity();
  return undefined;
}
const processes = [
  { name: "workspace node", args: nodeArguments, env: nodeEnv },
  { name: "Codex", args: ${JSON.stringify(["-e", ...nodeProgramArguments(AGENT_RUNTIME_ENTRYPOINT)])}, env: codexEnv },
];
let stopping = false;
// An OpenShell Sandbox reports EPERM for a group left with only zombies, as Darwin
// does. Signal the child itself then; a supervisor crash would end node retries.
function killGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if (error.code === "EPERM") child.kill(signal);
    else if (error.code !== "ESRCH") throw error;
  }
}
function start(slot) {
  if (stopping) return;
  const args = typeof slot.args === "function" ? slot.args() : slot.args;
  if (args === undefined) {
    slot.timer = setTimeout(() => start(slot), 250);
    return;
  }
  if (typeof slot.args === "function" && nodeSetupWait !== undefined) {
    logStartupPhase("node-setup", nodeSetupWait);
    nodeSetupWait = undefined;
  }
  const child = spawn(process.execPath, args, {
    env: slot.env, stdio: "inherit", detached: true,
  });
  slot.child = child;
  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    slot.child = undefined;
    if (stopping) {
      if (processes.every((entry) => !entry.child)) process.exit(0);
    } else {
      slot.timer = setTimeout(() => start(slot), 1_000);
    }
  }
  child.on("error", () => {
    console.error(slot.name + " failed to start.");
    finish();
  });
  child.on("exit", () => {
    // The Codex wrapper may exit after plugin failure while its app-server is
    // still shutting down. Retire that group before starting another wrapper.
    killGroup(child, "SIGKILL");
    finish();
  });
}
function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const slot of processes) {
    clearTimeout(slot.timer);
    killGroup(slot.child, signal);
  }
  if (processes.every((slot) => !slot.child)) process.exit(0);
  setTimeout(() => {
    for (const slot of processes) killGroup(slot.child, "SIGKILL");
    process.exit(1);
  }, 9_000).unref();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
logStartupPhase("supervisor-spawn", startupPhaseOrigin);
nodeSetupWait = Date.now();
// Codex first: it does not wait for the node setup.
for (const slot of [...processes].reverse()) start(slot);
`;

export const NATIVE_WORKER_ENTRYPOINT = String.raw`
const { join } = require("node:path");
const { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { execFile, spawn } = require("node:child_process");
const { createServer: readinessCreateServer } = require("node:http");
${WORKSPACE_ASSET_HELPERS}
${RUNTIME_READINESS_SERVER_HELPER}

function publishRuntimeFailure() {}
function serveHeldRuntimeFailureToTransportPeer() {}
${OPENCLAW_AUTH_PROBE_HELPERS}

const inferenceConfig = process.env.OPENCLAW_NATIVE_INFERENCE_CONFIG;
const state = process.env.OPENCLAW_NODE_STATE_DIR;
const setupCode = process.env.OPENCLAW_NODE_SETUP_CODE;
const workspace = process.env.OPENCLAW_WORKSPACE_DIR;
const temporary = process.env.TMPDIR;
const workerCapacity = Number(process.env.OPENCLAW_NATIVE_WORKER_CAPACITY);
if (
  !inferenceConfig ||
  !state ||
  !setupCode ||
  !workspace?.startsWith("/") ||
  !temporary ||
  !Number.isSafeInteger(workerCapacity) ||
  workerCapacity < 1 ||
  workerCapacity > 1024
) {
  throw new Error("Dedicated OpenClaw worker configuration is invalid.");
}

function nativeWorkerReady() {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["/app/openclaw.mjs", "node", "identity", "--json"],
      {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
        },
        encoding: "utf8",
        timeout: 2_000,
      },
      (error, stdout) => {
        if (error !== null) {
          resolve(false);
          return;
        }
        let deviceId;
        try {
          deviceId = JSON.parse(stdout).deviceId;
        } catch {
          resolve(false);
          return;
        }
        resolve(typeof deviceId === "string" && /^[a-f0-9]{64}$/u.test(deviceId));
      },
    );
  });
}

startRuntimeReadinessServer(nativeWorkerReady);
mkdirSync(temporary, { recursive: true, mode: 0o700 });
chmodSync(temporary, 0o700);
initializeRuntimeAssets();
const authenticationFailure = probeOpenClawAuthenticationFailure();
if (authenticationFailure !== undefined) {
  holdFailedAuthentication("model-probe", authenticationFailure.code, authenticationFailure.cause);
} else {
mkdirSync(state, { recursive: true });
const workerConfigPath = join(state, "openclaw.json");
writeFileSync(workerConfigPath, JSON.stringify({
  ...JSON.parse(inferenceConfig),
  agents: { defaults: { workspace } },
  plugins: {
    allow: ["file-transfer"],
    slots: { memory: "none" },
    entries: { "file-transfer": { enabled: true } },
  },
  nodeHost: {
    workerRuns: {
      enabled: true,
      capacity: workerCapacity,
      isolation: "none",
    },
    skills: { enabled: false },
  },
}), { mode: 0o600 });
delete process.env.OPENCLAW_NATIVE_INFERENCE_CONFIG;
delete process.env.OPENCLAW_HARNESS_PROBE_CONFIG;
const nodeEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: workerConfigPath,
};
if (process.env.OPENCLAW_NODE_CA_PEM) {
  const caPath = join(state, "gateway-ca.pem");
  const inheritedCa = process.env.NODE_EXTRA_CA_CERTS
    ? readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8")
    : "";
  writeFileSync(
    caPath,
    [inheritedCa, process.env.OPENCLAW_NODE_CA_PEM].filter(Boolean).join("\n"),
    { mode: 0o600 },
  );
  nodeEnv.NODE_EXTRA_CA_CERTS = caPath;
}
const connectTargetPath = join(state, "connect-target");
writeFileSync(connectTargetPath, setupCode, { mode: 0o600 });
const child = spawn(
  process.execPath,
  [
    "/app/openclaw.mjs",
    "connect",
    "--target-file",
    connectTargetPath,
    "--ephemeral",
    "--display-name",
    "OpenClaw Enterprise native worker",
  ],
  { stdio: "inherit", env: nodeEnv },
);
let terminating = false;
const stop = (signal) => {
  if (terminating) return;
  terminating = true;
  child.kill(signal);
  setTimeout(() => child.kill("SIGKILL"), 8_000).unref();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGTERM" ? 0 : 1)));
}
`;
