/**
 * Provider-neutral program fragments the OpenClaw workload programs embed.
 *
 * A fragment is not a program: each Compute Driver composes the programs it runs from these
 * pieces, so a fragment shared by two engines has one owner instead of a private copy inside
 * whichever Driver needed it first.
 */
import { PLUGIN_RUNTIME_TRANSLATOR_SOURCE } from "../../plugin/runtime-translator.ts";

const STARTUP_PHASE_EVENT = "runtime.startup_phase";

export const PLUGIN_APP_SERVER_TOKEN_HMAC_DOMAIN = "openclaw-plugin-runtime/app-server-token/v1";
export const RUNTIME_READINESS_PATH = "/readyz";

export function startupPhaseHelper(container: "gateway" | "agent"): string {
  return String.raw`
const startupPhaseOrigin = Date.now();
function logStartupPhase(phase, startedAt, outcome = "ok", code) {
  const now = Date.now();
  const failed = outcome !== "ok";
  console.error(JSON.stringify({
    event: ${JSON.stringify(STARTUP_PHASE_EVENT)},
    container: ${JSON.stringify(container)},
    phase,
    outcome: failed ? "failed" : "ok",
    ms: now - startedAt,
    sinceStartMs: now - startupPhaseOrigin,
    ...(failed && typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? { code } : {}),
  }));
}
async function timeStartupPhase(phase, run) {
  const startedAt = Date.now();
  const result = await run();
  logStartupPhase(phase, startedAt);
  return result;
}
`;
}

export const PLUGIN_APP_SERVER_TOKEN_DERIVATION_HELPER = String.raw`
function derivePluginAppServerTokenFromBase(baseToken, revisionId, startupId) {
  if (
    typeof baseToken !== "string" ||
    baseToken.length === 0 ||
    typeof revisionId !== "string" ||
    revisionId.length === 0 ||
    typeof startupId !== "string" ||
    startupId.length === 0
  ) {
    throw new Error("Codex app-server token derivation inputs are invalid.");
  }
  return createHmac("sha256", baseToken)
    .update(${JSON.stringify(PLUGIN_APP_SERVER_TOKEN_HMAC_DOMAIN)})
    .update("\0")
    .update(revisionId)
    .update("\0")
    .update(startupId)
    .digest("hex");
}
`;

export const AUTH_PROBE_FAILURE_HELPER = String.raw`
function holdFailedAuthentication(check = "model-probe", code = "UNAVAILABLE", cause) {
  publishRuntimeFailure(check, code, cause);
  serveHeldRuntimeFailureToTransportPeer(check, code, cause);
  console.error("Harness model authentication probe failed.");
  setInterval(() => {}, 3600000);
}
function probeFailure(kind, detail) {
  return { code: "MODEL_PROBE_FAILED", cause: detail === undefined ? { kind } : { kind, detail } };
}
function probeExitFailure({ error, status, signal }) {
  return probeFailure("PROCESS_EXIT", /^E[A-Z0-9]{1,15}$/.test(error?.code) ? "error-" + error.code
    : Number.isInteger(status) && status > 0 && status < 1000 ? "exit-" + status
    : /^SIG[A-Z0-9]{1,10}$/.test(signal) ? "signal-" + signal : undefined);
}
`;

export const CODEX_STDERR_FILTER_HELPER = String.raw`
const codexVerboseLog = /^(?:debug|trace)(?:,|$)/i.test(process.env.RUST_LOG ?? "");
const CODEX_REMOTE_CONTROL_WAIT = "waiting to resolve remote control preference until authentication is available";
const CODEX_MISSING_BWRAP_WARNING = "Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.";
const CODEX_UNIX_SOCKETS_PLATFORM_WARNING = "allowUnixSockets and dangerouslyAllowAllUnixSockets are macOS-only; requests will be rejected on this platform";
const CODEX_UNTRUSTED_PROJECT_WARNING = "until the project is trusted";
const CODEX_UNTRUSTED_WORKSPACE_MESSAGE = /^Project-local config, hooks, and exec policies are disabled in the following folders until the project is trusted, but skills still load\.\n {4}1\. \/home\/node\/workspace\/\.codex\n {7}To load project-local config, hooks, and exec policies, add \/home\/node\/workspace as a trusted project in \S+\/config\.toml\.\n?$/;
const CODEX_STDERR_LINE_LIMIT = 65536;
let codexRemoteControlWaitAt = -Infinity;
let codexUnixSocketsPlatformWarned = false;
function codexStderrLineKept(line, now = Date.now()) {
  if (codexVerboseLog || !line.startsWith("{")) return true;
  if (
    !line.includes('"message":"new"') &&
    !line.includes('"message":"close"') &&
    !line.includes('"message":"enter"') &&
    !line.includes('"message":"exit"') &&
    !line.includes('"message":"websocket client connected"') &&
    !line.includes(CODEX_REMOTE_CONTROL_WAIT) &&
    !line.includes(CODEX_UNIX_SOCKETS_PLATFORM_WARNING) &&
    !line.includes(CODEX_MISSING_BWRAP_WARNING) &&
    !line.includes(CODEX_UNTRUSTED_PROJECT_WARNING)
  ) return true;
  let record;
  try { record = JSON.parse(line); } catch { return true; }
  if (record === null || typeof record !== "object" || record.fields === null || typeof record.fields !== "object") return true;
  const message = record.fields.message;
  if (
    (message === "new" || message === "close" || message === "enter" || message === "exit") &&
    record.span !== null &&
    typeof record.span === "object" &&
    !Array.isArray(record.span)
  ) {
    return (
      (message === "new" || message === "close") &&
      record.target === "codex_core::tasks" &&
      record.span.name === "turn"
    );
  }
  if (
    record.target === "codex_app_server_transport::transport::websocket" &&
    message === "websocket client connected" &&
    /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|\[::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}\]):\d{1,5}$/.test(String(record.fields.peer_addr))
  ) {
    return false;
  }
  if (
    record.target === "codex_app_server_transport::transport::remote_control::websocket" &&
    message === CODEX_REMOTE_CONTROL_WAIT
  ) {
    if (now - codexRemoteControlWaitAt < 600000) return false;
    codexRemoteControlWaitAt = now;
  }
  if (record.target === "codex_app_server" && message === CODEX_MISSING_BWRAP_WARNING) return false;
  if (record.target === "codex_app_server" && typeof message === "string" && CODEX_UNTRUSTED_WORKSPACE_MESSAGE.test(message)) return false;
  if (record.target === "codex_network_proxy::proxy" && message === CODEX_UNIX_SOCKETS_PLATFORM_WARNING) {
    if (codexUnixSocketsPlatformWarned) return false;
    codexUnixSocketsPlatformWarned = true;
  }
  return true;
}
// Resolves when the stream ends. A line longer than the limit is forwarded
// unfiltered as it arrives, so the wrapper never buffers without bound.
function forwardCodexStderr(stream) {
  let pending = "";
  let passthrough = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (passthrough) {
        process.stderr.write(line + "\n");
        passthrough = false;
      } else if (codexStderrLineKept(line)) {
        process.stderr.write(line + "\n");
      }
    }
    if (pending.length > CODEX_STDERR_LINE_LIMIT) {
      process.stderr.write(pending);
      pending = "";
      passthrough = true;
    }
  });
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (pending !== "" && (passthrough || codexStderrLineKept(pending))) process.stderr.write(pending);
      pending = "";
      resolve();
    };
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
}
`;

// Docker Compute runs the remaining Codex readiness program as a container healthcheck.
// It emits only a fixed-vocabulary reason when the container is unready, never a response body.
export const READINESS_FAILURE_HELPER = String.raw`
const { writeSync: readinessWriteSync } = require("node:fs");
const readinessHttp = require("node:http");
let readinessFailing = false;
function readinessExit(reason) {
  try {
    readinessWriteSync(1, reason + "\n");
  } catch {}
  process.exit(1);
}
function readinessToken(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value)
    ? value
    : undefined;
}
function readinessErrorCode(error) {
  return readinessToken(error?.code) ?? readinessToken(error?.error?.code) ?? "request failed";
}
// A wrapper that holds a failed startup check (a rejected model credential, for
// example) publishes its fixed check name and code in runtime status: add them.
function readinessFail(reason) {
  if (readinessFailing) return;
  readinessFailing = true;
  const port = process.env.OPENCLAW_RUNTIME_STATUS_PORT;
  if (port === undefined) readinessExit(reason);
  const request = readinessHttp.get(
    { host: "127.0.0.1", port, path: "/openclaw/runtime/status", timeout: 500 },
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) readinessExit(reason);
      });
      response.on("end", () => {
        let failure;
        try {
          failure = JSON.parse(body).runtimeFailure;
        } catch {}
        const check = readinessToken(failure?.check);
        const code = readinessToken(failure?.code);
        readinessExit(
          check === undefined || code === undefined
            ? reason
            : reason + "; startup check " + check + " failed with " + code,
        );
      });
    },
  );
  request.on("timeout", () => request.destroy());
  request.on("error", () => readinessExit(reason));
}
`;

export const READINESS_PLUGIN_STATUS_HELPER = String.raw`
function checkPluginStatus(ready) {
  const request = readinessHttp.get(
    "http://127.0.0.1:" + process.env.OPENCLAW_PLUGIN_STATUS_PORT + "/openclaw/plugin-runtime/status",
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) readinessExit("plugin runtime status response is too large");
      });
      response.on("end", () => {
        let status;
        try {
          status = JSON.parse(body);
        } catch {
          readinessFail("plugin runtime status returned HTTP " + response.statusCode + " without JSON");
          return;
        }
        if (response.statusCode !== 200) {
          readinessFail("plugin runtime status returned HTTP " + response.statusCode);
          return;
        }
        if (status?.phase !== "ready") {
          readinessFail("plugin runtime phase is " + (readinessToken(status?.phase) ?? "unknown"));
          return;
        }
        ready(status);
      });
    },
  );
  request.on("error", (error) =>
    readinessFail("plugin runtime status unavailable: " + readinessErrorCode(error)),
  );
}
`;

const RUNTIME_READINESS_RESPONSE_HELPER = String.raw`
async function answerRuntimeReadiness(response, readiness) {
  let ready = false;
  try {
    ready = await readiness() === true;
  } catch {}
  if (response.destroyed) return;
  response.writeHead(ready ? 200 : 503, { "cache-control": "no-store" });
  response.end();
}
`;

// The /readyz program a workload starts when the platform probes it. Both this module and the
// Kubernetes provider compose it into their programs.
export const RUNTIME_READINESS_SERVER_HELPER = String.raw`
${RUNTIME_READINESS_RESPONSE_HELPER}
function startRuntimeReadinessServer(readiness) {
  const port = Number(process.env.OPENCLAW_RUNTIME_STATUS_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Runtime status port is invalid.");
  }
  const server = readinessCreateServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET" || pathname !== ${JSON.stringify(RUNTIME_READINESS_PATH)}) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    void answerRuntimeReadiness(response, readiness);
  });
  server.listen(port, "0.0.0.0");
}
`;

export const PLUGIN_RUNTIME_HELPERS = String.raw`
const pluginRuntimeTranslator = (${PLUGIN_RUNTIME_TRANSLATOR_SOURCE})();
const {
  dirname: pluginDirname,
  resolve: pluginResolve,
} = require("node:path");
const {
  existsSync: pluginExistsSync,
  mkdirSync: pluginMkdirSync,
  mkdtempSync: pluginMkdtempSync,
  readFileSync: pluginReadFileSync,
  rmSync: pluginRmSync,
  writeFileSync: pluginWriteFileSync,
} = require("node:fs");
const { tmpdir: pluginTmpdir } = require("node:os");
const {
  createHmac,
  timingSafeEqual: pluginTimingSafeEqual,
  randomUUID: pluginRandomUUID,
} = require("node:crypto");
const { spawnSync: pluginSpawnSync } = require("node:child_process");
const { createServer: pluginCreateServer, get: pluginHttpGet } = require("node:http");
const { isDeepStrictEqual: pluginDeepEqual } = require("node:util");

const CODEX_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS = Number(process.env.OPENCLAW_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS ?? "10000");
const CODEX_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS = Number(process.env.OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS ?? "60000");
const PLUGIN_STATUS_PATH = "/openclaw/plugin-runtime/status";
const REMOTE_PLUGIN_STATUS_PATH = "/openclaw/plugin-runtime/remote-status";
const RUNTIME_STATUS_PATH = "/openclaw/runtime/status";
const RUNTIME_DIAGNOSTICS_PATH = "/openclaw/runtime/diagnostics";
const RUNTIME_IMAGE_PATH = "/openclaw/runtime/image";
const RUNTIME_READINESS_PATH = ${JSON.stringify(RUNTIME_READINESS_PATH)};
const PLUGIN_DIAGNOSTIC_CODES = new Set(["PLUGIN_INSTALL_FAILED", "PLUGIN_AUTH_REQUIRED"]);
const RUNTIME_DIAGNOSTIC_CODES = new Set([
  "LOGIN_FAILED",
  "MODEL_PROBE_FAILED",
  "MODEL_PROBE_TIMEOUT",
  "MODEL_PROBE_CPU_STARVED",
  "UNAVAILABLE",
  "NOT_CONFIGURED",
  "AUTHENTICATION_FAILED",
  "DISCONNECTED",
  "INCOMPATIBLE_RESPONSE",
  "PROBE_FAILED",
]);
const pluginBaseAppServerToken = process.env.APP_SERVER_TOKEN;

${PLUGIN_APP_SERVER_TOKEN_DERIVATION_HELPER}
${RUNTIME_READINESS_RESPONSE_HELPER}

class PluginTerminalDiagnosticError extends Error {
  constructor(diagnostic, message) {
    super(message);
    this.diagnostic = diagnostic;
  }
}

class CodexAppServerRequestError extends Error {
  constructor(method, message) {
    super(message);
    this.method = method;
  }
}

function readRuntimePayload() {
  const encoded = process.env.OPENCLAW_PLUGIN_RUNTIME_JSON;
  const manifestPath = process.env.OPENCLAW_PLUGIN_RUNTIME_MANIFEST;
  if (encoded === undefined && manifestPath === undefined) return undefined;
  if (encoded !== undefined) return JSON.parse(encoded);
  return {
    manifest: JSON.parse(pluginReadFileSync(manifestPath, "utf8")),
    codexConfigurationToml:
      process.env.OPENCLAW_PLUGIN_CODEX_CONFIG_TOML === undefined
        ? undefined
        : pluginReadFileSync(process.env.OPENCLAW_PLUGIN_CODEX_CONFIG_TOML, "utf8"),
  };
}

function readPluginRuntime(kind) {
  const runtime = readRuntimePayload();
  if (runtime === undefined) return undefined;
  if (runtime.manifest?.kind !== kind) throw new Error("Plugin runtime artifact kind mismatch.");
  return runtime;
}

function readGatewayPluginRuntime() {
  const runtime = readRuntimePayload();
  if (runtime === undefined) return undefined;
  if (runtime.manifest?.kind === "openclaw" || runtime.manifest?.kind === "codex") {
    return runtime;
  }
  throw new Error("Plugin runtime artifact kind mismatch.");
}

function safeRuntimePath(root, relative) {
  if (typeof relative !== "string" || relative.length === 0 || relative.startsWith("/")) {
    throw new Error("Plugin runtime path must be relative.");
  }
  const resolved = pluginResolve(root, relative);
  const normalizedRoot = pluginResolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + "/")) {
    throw new Error("Plugin runtime path escapes its target directory.");
  }
  return resolved;
}

function writeCodexConfigToml(runtime) {
  if (runtime.manifest?.kind !== "codex") {
    throw new Error("Codex plugin runtime artifact kind mismatch.");
  }
  if (runtime.codexConfigurationToml === undefined) {
    throw new Error("Codex plugin config.toml is missing.");
  }
  const target = safeRuntimePath(process.env.CODEX_HOME, "config.toml");
  pluginMkdirSync(pluginDirname(target), { recursive: true });
  pluginWriteFileSync(target, runtime.codexConfigurationToml, { mode: 0o600 });
}

function pluginRuntimeReady() {
  const marker = process.env.OPENCLAW_PLUGIN_READY_MARKER;
  if (marker !== undefined) pluginWriteFileSync(marker, "ready\n", { mode: 0o600 });
}

function pluginRuntimeStatusContainer() {
  return requireNonEmptyString(process.env.OPENCLAW_PLUGIN_STATUS_CONTAINER, "Plugin status container");
}

function pluginRuntimeRevisionId() {
  return requireNonEmptyString(process.env.OPENCLAW_AGENT_REVISION_ID, "Plugin status revision ID");
}

function pluginRuntimeStatusPort() {
  if (process.env.OPENCLAW_PLUGIN_STATUS_PORT === undefined) return undefined;
  const port = Number(process.env.OPENCLAW_PLUGIN_STATUS_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Plugin status port is invalid.");
  }
  return port;
}

function runtimeStatusPort() {
  if (process.env.OPENCLAW_RUNTIME_STATUS_PORT === undefined) return undefined;
  const port = Number(process.env.OPENCLAW_RUNTIME_STATUS_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Runtime status port is invalid.");
  }
  return port;
}

function runtimeStatusContainer() {
  return requireNonEmptyString(process.env.OPENCLAW_RUNTIME_STATUS_CONTAINER, "Runtime status container");
}

let pluginStatusReport = {
  revisionId: process.env.OPENCLAW_AGENT_REVISION_ID ?? "",
  container: process.env.OPENCLAW_PLUGIN_STATUS_CONTAINER ?? "",
  startupId: pluginRandomUUID(),
  podUid: process.env.OPENCLAW_POD_UID ?? "",
  phase: "starting",
  successfulPluginIds: [],
  failures: [],
};

let runtimeStartupFailure;
// The workspace node OpenClaw itself reports applied (its file-transfer plugin
// loaded from a config with the node), and the current reason it is not.
let runtimeWorkspaceNodeId;
let runtimeWorkspaceNodeFailure;

function publishPluginRuntimeStatus(report) {
  if (pluginRuntimeStatusPort() === undefined) return;
  const successfulPluginIds = [...new Set(report.successfulPluginIds ?? [])];
  const failures = [
    ...new Map((report.failures ?? []).map((failure) => [failure.pluginId, pluginDiagnostic(failure.pluginId, failure.code)])).values(),
  ];
  if (successfulPluginIds.some((pluginId) => failures.some((failure) => failure.pluginId === pluginId))) {
    throw new Error("Plugin status report cannot mark a plugin successful and failed.");
  }
  pluginStatusReport = {
    ...pluginStatusReport,
    revisionId: pluginRuntimeRevisionId(),
    container: pluginRuntimeStatusContainer(),
    podUid: requireNonEmptyString(process.env.OPENCLAW_POD_UID, "Plugin status Pod UID"),
    phase: report.phase,
    successfulPluginIds,
    failures,
  };
}

function publishRuntimeFailure(check, code, cause) {
  if (runtimeStatusPort() === undefined) return;
  requireNonEmptyString(check, "Runtime failure check");
  if (!RUNTIME_DIAGNOSTIC_CODES.has(code)) {
    throw new Error("Runtime failure code is invalid.");
  }
  runtimeStartupFailure = {
    component: runtimeStatusContainer(),
    check,
    checkedAt: new Date().toISOString(),
    code,
    ...(cause === undefined ? {} : { cause }),
  };
}

// A provider-owned Codex Harness gets only the transport token's verifier and
// no Compute status port, and Compute cannot reach it through a Pod proxy. While
// a startup failure is held nothing else listens on the app-server port, so the
// failure is served there, through the provider's bearer-passthrough exposure,
// to a caller presenting the token the verifier names. Compute reads it and
// fails the revision with the code the status port would have reported.
function serveHeldRuntimeFailureToTransportPeer(check, code, cause) {
  const verifier = process.env.APP_TOKEN_SHA;
  const port = Number(process.env.APP_SERVER_PORT);
  if (
    runtimeStatusPort() !== undefined ||
    typeof verifier !== "string" ||
    !/^[a-f0-9]{64}$/.test(verifier) ||
    !Number.isSafeInteger(port) || port < 1 || port > 65535
  ) {
    return;
  }
  requireNonEmptyString(check, "Runtime failure check");
  if (!RUNTIME_DIAGNOSTIC_CODES.has(code)) {
    throw new Error("Runtime failure code is invalid.");
  }
  const { createHash: heldFailureHash } = require("node:crypto");
  const expected = Buffer.from(verifier, "hex");
  const body = JSON.stringify({
    runtimeFailure: {
      component: "agent",
      check,
      checkedAt: new Date().toISOString(),
      code,
      ...(cause === undefined ? {} : { cause }),
    },
  });
  const server = pluginCreateServer((request, response) => {
    const authorization = typeof request.headers.authorization === "string"
      ? /^Bearer ([!-~]+)$/i.exec(request.headers.authorization)
      : null;
    const supplied = authorization === null
      ? undefined
      : heldFailureHash("sha256").update(authorization[1]).digest();
    if (supplied === undefined || !pluginTimingSafeEqual(supplied, expected)) {
      response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET" || pathname !== RUNTIME_STATUS_PATH) {
      response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(body);
  });
  // Keep holding the failure even if it cannot be served; Compute then times out.
  server.on("error", (error) => {
    console.error("Held runtime failure server failed: " + (error?.code ?? "unknown"));
  });
  server.listen(port, "0.0.0.0");
}

function publishRuntimeReady() {
  if (runtimeStatusPort() === undefined) return;
  runtimeStartupFailure = undefined;
}

function runtimeDiagnosticCheck(check, state, checkedAt, code) {
  requireNonEmptyString(check, "Runtime diagnostic check");
  if (code !== undefined && !RUNTIME_DIAGNOSTIC_CODES.has(code)) {
    throw new Error("Runtime diagnostic code is invalid.");
  }
  return {
    component: runtimeStatusContainer(),
    check,
    state,
    checkedAt,
    ...(code === undefined ? {} : { code }),
  };
}

function runtimeStatusReport() {
  return {
    revisionId: requireNonEmptyString(process.env.OPENCLAW_AGENT_REVISION_ID, "Runtime status revision ID"),
    container: runtimeStatusContainer(),
    podUid: requireNonEmptyString(process.env.OPENCLAW_POD_UID, "Runtime status Pod UID"),
    ...(runtimeStartupFailure === undefined ? {} : { runtimeFailure: runtimeStartupFailure }),
    ...(runtimeWorkspaceNodeId === undefined ? {} : { workspaceNodeId: runtimeWorkspaceNodeId }),
    ...(runtimeWorkspaceNodeFailure === undefined ? {} : { workspaceNodeFailure: runtimeWorkspaceNodeFailure }),
  };
}

function remotePluginStatusAuthorization() {
  const token = requireNonEmptyString(pluginBaseAppServerToken, "Plugin status base token");
  return "Bearer " + createHmac("sha256", token)
    .update("openclaw-plugin-status/v1\\0" + pluginRuntimeRevisionId()).digest("hex");
}

function statusCheckFromBoolean(check, value, checkedAt, failureCode) {
  if (value === true) return runtimeDiagnosticCheck(check, "succeeded", checkedAt);
  if (value === false) return runtimeDiagnosticCheck(check, "failed", checkedAt, failureCode);
  return runtimeDiagnosticCheck(check, "unknown", checkedAt, "INCOMPATIBLE_RESPONSE");
}

function clearTimer(timer) {
  clearTimeout(timer);
}

function armTimer(callback, timeoutMs) {
  const timer = setTimeout(callback, timeoutMs);
  if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
  return timer;
}

// Connect-error codes with which the Gateway refuses this CLI's own credentials.
// They follow from the admitted configuration (D381: no gateway.auth.password,
// so the in-Pod CLI connects with none), so every later call is refused too.
// Refusals that can clear by themselves are excluded: rate limiting, pairing,
// device identity, and a token mismatch, which OpenClaw retries with a device token.
// AUTH_UNAUTHORIZED is OpenClaw's catch-all; the one transient reason behind it
// (a failed local interface check) applies only to a non-loopback client, and
// this CLI always connects over 127.0.0.1. Re-check the set if that changes.
const GATEWAY_AUTH_REFUSAL_CODES = new Set([
  "AUTH_UNAUTHORIZED",
  "AUTH_TOKEN_MISSING",
  "AUTH_TOKEN_NOT_CONFIGURED",
  "AUTH_PASSWORD_MISSING",
  "AUTH_PASSWORD_MISMATCH",
  "AUTH_PASSWORD_NOT_CONFIGURED",
]);

// OpenClaw's internal reason for a refusal, such as trusted_proxy_untrusted_source,
// kept only when it is a plain token so it is safe to log.
function gatewayAuthRefusalReason(error) {
  const reason = error.details.authReason;
  return typeof reason === "string" && /^[a-z0-9_]{1,64}$/u.test(reason) ? reason : undefined;
}

function gatewayRefusedAuthentication(gatewayRuntime, error) {
  return (
    typeof gatewayRuntime?.isGatewayClientRequestError === "function" &&
    gatewayRuntime.isGatewayClientRequestError(error) === true &&
    error.retryable !== true &&
    isPlainObject(error.details) &&
    GATEWAY_AUTH_REFUSAL_CODES.has(error.details.code)
  );
}

// The Gateway resolves its loaded channel plugins plus manifest plugins for the channels the
// Configuration sets up, so channels.status for a channel the Agent does not use is refused
// as INVALID_REQUEST "unknown channel: <id>" (src/gateway/server-methods/channels.ts in the
// pinned OpenClaw). A configured channel whose plugin failed to load still resolves and takes
// the status path.
function gatewayRefusedUnknownChannel(gatewayRuntime, error, channel) {
  return (
    typeof channel === "string" &&
    typeof gatewayRuntime?.isGatewayClientRequestError === "function" &&
    gatewayRuntime.isGatewayClientRequestError(error) === true &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message === "unknown channel: " + channel
  );
}

// Query the running Gateway through OpenClaw's public SDK. Starting a CLI here
// also starts its launcher/respawn lifecycle; killing that launcher cannot bound
// a probe whose descendant still owns stdout.
function callNativeGateway(method, params, timeoutMs, abortSignal, maxBytes = 65536) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let timer;
    let gatewayRuntime;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      abortSignal?.removeEventListener?.("abort", cancel);
      resolve(result);
    };
    const cancel = () => {
      controller.abort();
      finish({ ok: false, code: "UNAVAILABLE" });
    };
    if (abortSignal?.aborted) {
      cancel();
      return;
    }
    timer = armTimer(cancel, timeoutMs);
    abortSignal?.addEventListener?.("abort", cancel, { once: true });
    Promise.resolve().then(async () => {
      if (settled) return;
      gatewayRuntime = require("openclaw/plugin-sdk/gateway-runtime");
      const value = await gatewayRuntime.callGatewayFromCli(method, { json: true, timeout: String(timeoutMs) }, params, {
        progress: false,
        // Status probes must not initialize shared state alongside Gateway startup.
        sharedStateMode: "read-only",
        signal: controller.signal,
      });
      if (settled) return;
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
        finish({ ok: false, code: "INCOMPATIBLE_RESPONSE" });
        return;
      }
      finish({ ok: true, value });
    }).catch((error) => {
      if (gatewayRuntime?.isGatewayTransportError(error)) {
        finish({ ok: false, code: "UNAVAILABLE" });
        return;
      }
      finish({
        ok: false,
        code: "PROBE_FAILED",
        ...(gatewayRefusedUnknownChannel(gatewayRuntime, error, params?.channel) ? { unknownChannel: true } : {}),
        ...(gatewayRefusedAuthentication(gatewayRuntime, error)
          ? { authenticationRefused: true, authenticationRefusalReason: gatewayAuthRefusalReason(error) }
          : {}),
      });
    });
  });
}

// No Slack channel: the expected answer for an Agent that does not use Slack, so nothing
// past configuration was checked.
function notConfiguredSlackChecks(checkedAt) {
  return [
    runtimeDiagnosticCheck("configuration", "failed", checkedAt, "NOT_CONFIGURED"),
    runtimeDiagnosticCheck("authentication", "unknown", checkedAt),
    runtimeDiagnosticCheck("connectivity", "unknown", checkedAt),
  ];
}

function unknownSlackChecks(checkedAt, code) {
  return [
    runtimeDiagnosticCheck("configuration", "unknown", checkedAt, code),
    runtimeDiagnosticCheck("authentication", "unknown", checkedAt, code),
    runtimeDiagnosticCheck("connectivity", "unknown", checkedAt, code),
  ];
}

const SAFE_AUTHENTICATION_REJECTION_CODES = new Set([
  "auth_failed",
  "authentication_failed",
  "invalid_auth",
  "account_inactive",
  "not_authed",
  "token_revoked",
  "missing_token",
  "missing_user_token",
]);

function normalizedAuthenticationRejectionCode(value) {
  const normalizedCode = value?.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  return SAFE_AUTHENTICATION_REJECTION_CODES.has(normalizedCode) ? normalizedCode : undefined;
}

function probeErrorAuthenticationCode(error) {
  const direct = normalizedAuthenticationRejectionCode(error);
  if (direct !== undefined) return direct;
  const wrapped = error.match(/^An API error occurred:\s*([a-z_][a-z0-9_]*)(?:$|;)/i)?.[1];
  return normalizedAuthenticationRejectionCode(wrapped);
}

function credentialRejectionCode(probe) {
  if (!isPlainObject(probe) || probe.ok !== false) return undefined;
  const rawCode = typeof probe.error === "string" ? probe.error : undefined;
  if (rawCode !== undefined && probeErrorAuthenticationCode(rawCode) !== undefined) {
    return "AUTHENTICATION_FAILED";
  }
  return "PROBE_FAILED";
}

function authenticationCheckFromProbe(probe, checkedAt) {
  if (!isPlainObject(probe) || typeof probe.ok !== "boolean") {
    return runtimeDiagnosticCheck("authentication", "unknown", checkedAt, "INCOMPATIBLE_RESPONSE");
  }
  if (probe.ok === true) return runtimeDiagnosticCheck("authentication", "succeeded", checkedAt);
  const code = credentialRejectionCode(probe);
  return runtimeDiagnosticCheck(
    "authentication",
    code === "AUTHENTICATION_FAILED" ? "failed" : "unknown",
    checkedAt,
    code,
  );
}

function connectivityCheckFromConnected(connected, checkedAt) {
  if (connected === true) return runtimeDiagnosticCheck("connectivity", "succeeded", checkedAt);
  if (connected === false) {
    return runtimeDiagnosticCheck("connectivity", "failed", checkedAt, "DISCONNECTED");
  }
  return runtimeDiagnosticCheck("connectivity", "unknown", checkedAt, "INCOMPATIBLE_RESPONSE");
}

function slackChecksFromStatusPayload(payload, checkedAt) {
  const channelSummary = isPlainObject(payload?.channels) ? payload.channels.slack : undefined;
  const accountsByChannel = isPlainObject(payload?.channelAccounts) ? payload.channelAccounts : undefined;
  const defaultAccounts = isPlainObject(payload?.channelDefaultAccountId)
    ? payload.channelDefaultAccountId
    : undefined;
  const defaultAccountId =
    typeof defaultAccounts?.slack === "string" && defaultAccounts.slack.length > 0
      ? defaultAccounts.slack
      : undefined;
  if (!isPlainObject(channelSummary) || !Array.isArray(accountsByChannel?.slack) || defaultAccountId === undefined) {
    return unknownSlackChecks(checkedAt, "INCOMPATIBLE_RESPONSE");
  }
  const accounts = accountsByChannel.slack.filter(isPlainObject);
  const account = accounts.find((candidate) => candidate.accountId === defaultAccountId);
  if (!isPlainObject(account)) return unknownSlackChecks(checkedAt, "INCOMPATIBLE_RESPONSE");
  const configured =
    typeof channelSummary.configured === "boolean"
      ? channelSummary.configured
      : typeof account.configured === "boolean"
        ? account.configured
        : undefined;
  if (configured === false) return notConfiguredSlackChecks(checkedAt);
  const probe = isPlainObject(account.probe) ? account.probe : undefined;
  const connected =
    typeof channelSummary.connected === "boolean"
      ? channelSummary.connected
      : typeof account.connected === "boolean"
        ? account.connected
        : undefined;
  return [
    statusCheckFromBoolean("configuration", configured, checkedAt, "NOT_CONFIGURED"),
    authenticationCheckFromProbe(probe, checkedAt),
    connectivityCheckFromConnected(connected, checkedAt),
  ];
}

async function slackChannelDiagnosticChecks(checkedAt, abortSignal) {
  if (runtimeStatusContainer() !== "gateway") return [];
  const result = await callNativeGateway(
    "channels.status",
    { channel: "slack", probe: true, timeoutMs: 5000 },
    6000,
    abortSignal,
  );
  if (!result.ok) {
    return result.unknownChannel === true
      ? notConfiguredSlackChecks(checkedAt)
      : unknownSlackChecks(checkedAt, result.code);
  }
  return slackChecksFromStatusPayload(result.value, checkedAt);
}

async function runtimeDiagnosticsReport(abortSignal) {
  const observedAt = new Date().toISOString();
  return {
    revisionId: requireNonEmptyString(process.env.OPENCLAW_AGENT_REVISION_ID, "Runtime status revision ID"),
    container: runtimeStatusContainer(),
    podUid: requireNonEmptyString(process.env.OPENCLAW_POD_UID, "Runtime status Pod UID"),
    observedAt,
    checks: (await slackChannelDiagnosticChecks(observedAt, abortSignal)).slice(0, 32),
  };
}

function startPluginRuntimeStatusServer(readiness) {
  const port = runtimeStatusPort() ?? pluginRuntimeStatusPort();
  if (port === undefined) return;
  const server = pluginCreateServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && pathname === RUNTIME_READINESS_PATH) {
      await answerRuntimeReadiness(response, readiness);
      return;
    }
    const remote = pathname === REMOTE_PLUGIN_STATUS_PATH && process.env.OPENCLAW_REMOTE_PLUGIN_STATUS === "true";
    if (remote) {
      const expected = Buffer.from(remotePluginStatusAuthorization());
      const supplied = Buffer.from(typeof request.headers.authorization === "string" ? request.headers.authorization : "");
      if (expected.length !== supplied.length || !pluginTimingSafeEqual(expected, supplied)) {
        response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }
    if (
      request.method !== "GET" ||
      !remote && ![
        RUNTIME_STATUS_PATH,
        RUNTIME_DIAGNOSTICS_PATH,
        PLUGIN_STATUS_PATH,
        RUNTIME_IMAGE_PATH,
      ].includes(pathname)
    ) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (pathname === RUNTIME_IMAGE_PATH) {
      let commit = null;
      try {
        const metadata = JSON.parse(pluginReadFileSync("/opt/oce/runtime/build.json", "utf8"));
        if (typeof metadata.commit === "string" && /^[a-f0-9]{40}$/.test(metadata.commit)) commit = metadata.commit;
      } catch {}
      response.writeHead(200, { "content-type": "application/json" });
      let openclawCommit = null;
      try {
        const provenance = JSON.parse(pluginReadFileSync("/opt/oce/runtime/provenance.json", "utf8"));
        if (provenance.source === "https://github.com/openclaw/openclaw" &&
            typeof provenance.commit === "string" && /^[a-f0-9]{40}$/.test(provenance.commit)) {
          openclawCommit = provenance.commit;
        }
      } catch {}
      response.end(JSON.stringify({ commit, openclawCommit }));
      return;
    }
    if (pathname === RUNTIME_STATUS_PATH) {
      if (runtimeStatusPort() === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(runtimeStatusReport()));
      return;
    }
    if (pathname === RUNTIME_DIAGNOSTICS_PATH) {
      if (runtimeStatusPort() === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      request.on?.("aborted", abort);
      response.on?.("close", abort);
      try {
        const report = await runtimeDiagnosticsReport(abortController.signal);
        if (abortController.signal.aborted) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(report));
      } catch {
        if (!abortController.signal.aborted) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "unavailable" }));
        }
      } finally {
        request.off?.("aborted", abort);
        response.off?.("close", abort);
      }
      return;
    }
    if (pluginRuntimeStatusPort() === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(pluginStatusReport));
  });
  server.listen(port, "0.0.0.0");
}

function pluginBestEffortEnabled() {
  return pluginRuntimeStatusPort() !== undefined;
}

function derivePluginAppServerToken(startupId) {
  return derivePluginAppServerTokenFromBase(
    requireNonEmptyString(pluginBaseAppServerToken, "Codex app-server base token"),
    pluginRuntimeRevisionId(),
    requireNonEmptyString(startupId, "Plugin runtime startup ID"),
  );
}

function pluginDiagnostic(pluginId, code) {
  requireNonEmptyString(pluginId, "Plugin diagnostic plugin ID");
  if (!PLUGIN_DIAGNOSTIC_CODES.has(code)) {
    throw new Error("Plugin diagnostic code is invalid.");
  }
  return { pluginId, code };
}

function isPluginDiagnostic(value) {
  return (
    isPlainObject(value) &&
    typeof value.pluginId === "string" &&
    value.pluginId.length > 0 &&
    PLUGIN_DIAGNOSTIC_CODES.has(value.code)
  );
}

function isPluginTerminalDiagnosticError(error) {
  return error instanceof PluginTerminalDiagnosticError && isPluginDiagnostic(error.diagnostic);
}

function readOpenClawConfig() {
  return JSON.parse(pluginReadFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
}

function writableOpenClawConfigPath() {
  if (typeof process.env.OPENCLAW_STATE_DIR === "string" && process.env.OPENCLAW_STATE_DIR.length > 0) {
    return safeRuntimePath(process.env.OPENCLAW_STATE_DIR, "openclaw.json");
  }
  return safeRuntimePath(requireNonEmptyString(process.env.HOME, "OpenClaw runtime home"), ".openclaw/openclaw.json");
}

function writeOpenClawConfig(config) {
  const target = writableOpenClawConfigPath();
  pluginMkdirSync(pluginDirname(target), { recursive: true });
  pluginWriteFileSync(target, JSON.stringify(config), { mode: 0o600 });
  process.env.OPENCLAW_CONFIG_PATH = target;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  }
  return value;
}

function mergeConfig(base, overlay) {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return cloneJson(overlay);
  const next = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    next[key] = key in next ? mergeConfig(next[key], value) : cloneJson(value);
  }
  return next;
}

function objectAtPath(root, path) {
  let current = root;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return isPlainObject(current) ? current : undefined;
}

function isManagedOpenClawPluginEntry(value, pluginId) {
  if (!isPlainObject(value) || typeof value.enabled !== "boolean") return false;
  const keys = Object.keys(value);
  if (keys.length === 1) return true;
  const managedConfig = pluginRuntimeTranslator.openClawManagedEntryConfig(pluginId);
  return (
    keys.length === 2 &&
    hasOwn(value, "config") &&
    managedConfig !== undefined &&
    pluginDeepEqual(value.config, managedConfig)
  );
}

// The Gateway serves browsers through an OCC-authenticated public origin only
// when native admin routes that exact origin to it with trusted-proxy auth.
function gatewayServesPublicOrigin(config) {
  const gateway = config?.gateway;
  const raw = gateway?.publicOrigin;
  return (
    typeof raw === "string" &&
    /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(raw) &&
    gateway.auth?.mode === "trusted-proxy" &&
    Array.isArray(gateway.controlUi?.allowedOrigins) &&
    gateway.controlUi.allowedOrigins.includes(raw)
  );
}

function conflictingApproverList(configured, managedList) {
  return isPlainObject(configured) && Object.hasOwn(configured, "approvers") &&
    managedList !== undefined &&
    (!Array.isArray(configured.approvers) ||
      !pluginDeepEqual(
        configured.approvers.map((id) => typeof id === "string" ? id.toLowerCase() : id).sort(),
        managedList.map((id) => id.toLowerCase()).sort(),
      ));
}

function assertNoOpenClawPluginConfigConflict(base, overlay, options = {}) {
  const managedApprovers = objectAtPath(overlay, ["approvals", "plugin", "slack"]);
  const configuredApprovers = objectAtPath(base, ["approvals", "plugin", "slack"]);
  if (managedApprovers !== undefined && configuredApprovers !== undefined) {
    // A native child list must not bypass an inherited Agent or plugin approver list.
    const managedDefault = managedApprovers.approvers;
    const configuredPlugins = isPlainObject(configuredApprovers.plugins)
      ? Object.entries(configuredApprovers.plugins)
      : [];
    const conflictingPlugin = configuredPlugins.some(([pluginId, configuredPlugin]) => {
      const managedPlugin = isPlainObject(managedApprovers.plugins)
        ? managedApprovers.plugins[pluginId]
        : undefined;
      const pluginList = managedPlugin?.approvers ?? managedDefault;
      if (conflictingApproverList(configuredPlugin, pluginList)) return true;
      const configuredTools = isPlainObject(configuredPlugin?.tools)
        ? Object.entries(configuredPlugin.tools)
        : [];
      return configuredTools.some(([toolId, configuredTool]) => {
        const managedTool = isPlainObject(managedPlugin?.tools)
          ? managedPlugin.tools[toolId]
          : undefined;
        return conflictingApproverList(configuredTool, managedTool?.approvers ?? pluginList);
      });
    });
    if (conflictingApproverList(configuredApprovers, managedDefault) || conflictingPlugin) {
      throw new Error("OpenClaw plugin approval configuration conflicts with managed Agent approvers.");
    }
  }
  const baseEntries = objectAtPath(base, ["plugins", "entries"]);
  const overlayEntries = objectAtPath(overlay, ["plugins", "entries"]);
  if (overlayEntries === undefined) return;
  const policyIds = (value) => Array.isArray(value)
    ? value.map((id) => id.trim().toLowerCase()).filter(Boolean)
    : [];
  const allow = policyIds(base?.plugins?.allow);
  const deny = policyIds(base?.plugins?.deny);
  for (const pluginId of Object.keys(overlayEntries)) {
    if (overlayEntries[pluginId].enabled === true) {
      let conflict;
      if (base?.plugins?.enabled === false) conflict = "plugins.enabled is false";
      else if (deny.includes(pluginId)) conflict = "plugins.deny includes the plugin";
      else if (allow.length > 0 && !allow.includes(pluginId)) conflict = "plugins.allow excludes the plugin";
      if (conflict !== undefined) {
        throw new Error("OpenClaw plugin configuration conflicts with managed plugin selection " + pluginId + ": " + conflict + ". Update Configuration or the Agent plugin selection.");
      }
    }
    if (pluginId === "codex") continue;
    if (
      baseEntries?.[pluginId] !== undefined &&
      JSON.stringify(baseEntries[pluginId]) !== JSON.stringify(overlayEntries[pluginId])
    ) {
      if (
        options.allowManagedOpenClawPluginReplacement === true &&
        isManagedOpenClawPluginEntry(baseEntries[pluginId], pluginId) &&
        isManagedOpenClawPluginEntry(overlayEntries[pluginId], pluginId)
      ) {
        continue;
      }
      throw new Error("OpenClaw plugin configuration conflicts with managed plugin selections.");
    }
  }
  const overlayBridge = objectAtPath(overlay, ["plugins", "entries", "codex", "config", "codexPlugins"]);
  if (overlayBridge === undefined) return;
  const baseBridge = objectAtPath(base, ["plugins", "entries", "codex", "config", "codexPlugins"]);
  if (baseBridge === undefined) return;
  if (JSON.stringify(baseBridge) !== JSON.stringify(overlayBridge)) {
    throw new Error("OpenClaw Codex bridge configuration conflicts with managed Codex plugin selections.");
  }
}

function mergeOpenClawPluginConfiguration(base, overlay, options = {}) {
  assertNoOpenClawPluginConfigConflict(base, overlay, options);
  const next = mergeConfig(base, overlay);
  for (const key of ["allow", "alsoAllow", "deny"]) {
    const baseAllow = Array.isArray(base?.tools?.[key]) ? base.tools[key] : [];
    const overlayAllow = Array.isArray(overlay?.tools?.[key]) ? overlay.tools[key] : [];
    if (overlayAllow.length === 0) continue;
    next.tools[key] = [
      ...baseAllow,
      ...overlayAllow.filter((tool) => !baseAllow.includes(tool)),
    ];
  }
  const overlayEntries = objectAtPath(overlay, ["plugins", "entries"]);
  if (overlayEntries !== undefined) {
    const disabledManagedTools = Object.entries(overlayEntries)
      .filter(([pluginId, entry]) => pluginId !== "codex" && isManagedOpenClawPluginEntry(entry, pluginId) && entry.enabled === false)
      .map(([pluginId]) => pluginId);
    if (disabledManagedTools.length > 0 && Array.isArray(next.tools?.alsoAllow)) {
      next.tools.alsoAllow = next.tools.alsoAllow.filter((tool) => !disabledManagedTools.includes(tool));
    }
  }
  return next;
}

function pluginFailureIds(failures) {
  return new Set((failures ?? []).map((failure) => failure.pluginId));
}

function hasEnabledPluginSelections(runtime) {
  return Object.values(runtime?.manifest?.selections ?? {}).some((selection) => selection?.enabled === true);
}

function readPluginFailuresFromEnvironment() {
  const encoded = process.env.OPENCLAW_PLUGIN_FAILURES_JSON;
  if (encoded === undefined || encoded.length === 0) return [];
  const parsed = JSON.parse(encoded);
  if (!Array.isArray(parsed)) throw new Error("Plugin failure set is invalid.");
  return parsed.map((failure) => pluginDiagnostic(failure.pluginId, failure.code));
}

async function readPeerPluginRuntimeStatus() {
  let url;
  const remote = process.env.OPENCLAW_PEER_PLUGIN_STATUS_URL;
  if (remote !== undefined) {
    url = new URL(remote);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Peer plugin status requires a verified HTTPS endpoint.");
    }
  } else {
    if (typeof process.env.APP_SERVER_URL !== "string" || !process.env.APP_SERVER_URL.startsWith("ws://")) return undefined;
    url = new URL(process.env.APP_SERVER_URL.replace(/^ws:/, "http:"));
    url.port = String(pluginRuntimeStatusPort() ?? "");
    url.pathname = PLUGIN_STATUS_PATH;
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(CODEX_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS),
    redirect: "error",
    ...(remote === undefined ? {} : { headers: { authorization: remotePluginStatusAuthorization() } }),
  });
  if (response.status !== 200) throw new Error("Peer plugin runtime status is unavailable.");
  const status = await response.json();
  if (
    !isPlainObject(status) ||
    status.revisionId !== pluginRuntimeRevisionId() ||
    status.container !== "agent" ||
    typeof status.startupId !== "string" ||
    status.startupId.length === 0 ||
    typeof status.podUid !== "string" ||
    status.podUid.length === 0 ||
    status.phase !== "ready" ||
    !Array.isArray(status.successfulPluginIds) ||
    status.successfulPluginIds.some((pluginId) => typeof pluginId !== "string" || pluginId.length === 0) ||
    !Array.isArray(status.failures)
  ) {
    throw new Error("Peer plugin runtime status is not ready.");
  }
  if (!status.failures.every(isPluginDiagnostic)) {
    throw new Error("Peer plugin runtime status returned invalid diagnostics.");
  }
  const failures = status.failures.map((failure) => pluginDiagnostic(failure.pluginId, failure.code));
  const successfulPluginIds = [...new Set(status.successfulPluginIds)];
  if (successfulPluginIds.some((pluginId) => failures.some((failure) => failure.pluginId === pluginId))) {
    throw new Error("Peer plugin runtime status is inconsistent.");
  }
  return {
    revisionId: status.revisionId,
    container: status.container,
    startupId: status.startupId,
    podUid: status.podUid,
    phase: status.phase,
    successfulPluginIds,
    failures,
  };
}

// The Gateway may start before its Harness is ready: on a first dedicated
// deploy both are created together, and the agent Service lists the Harness
// only once it is ready. This wait has no deadline and never rejects, so a slow
// Harness cannot crash-loop the Gateway; the controller's convergence deadline
// governs a Harness that never reports. The Gateway stays unready meanwhile.
async function waitForPeerPluginRuntimeStatus() {
  let lastReportedAt;
  for (;;) {
    let reason;
    try {
      const status = await readPeerPluginRuntimeStatus();
      if (status !== undefined) return status;
      reason = "Peer plugin runtime status endpoint is not configured.";
    } catch (error) {
      reason = pluginRuntimeErrorMessage(error);
    }
    if (lastReportedAt === undefined || Date.now() - lastReportedAt >= 30_000) {
      lastReportedAt = Date.now();
      console.error("Waiting for Harness plugin runtime status: " + reason);
    }
    await pluginRuntimeDelay(250);
  }
}

function samePluginIds(left, right) {
  const leftIds = new Set(left ?? []);
  const rightIds = new Set(right ?? []);
  return leftIds.size === rightIds.size && [...leftIds].every((id) => rightIds.has(id));
}

function samePluginFailures(left, right) {
  return JSON.stringify([...(left ?? [])].sort((a, b) => a.pluginId.localeCompare(b.pluginId))) ===
    JSON.stringify([...(right ?? [])].sort((a, b) => a.pluginId.localeCompare(b.pluginId)));
}

function openClawPluginConfiguration(runtime, failures = [], base) {
  if (runtime.manifest?.kind === "openclaw") {
    return pluginRuntimeTranslator.openClawRuntimeArtifact(
      runtime.manifest.selections ?? {},
      failures,
      runtime.manifest.pluginApprovers,
      gatewayServesPublicOrigin(base),
    ).configuration;
  }
  if (runtime.manifest?.kind === "codex") {
    return pluginRuntimeTranslator.codexOpenClawConfiguration(
      runtime.manifest.selections ?? {},
      failures,
      runtime.manifest.repositoryBrokerNetworkPolicy,
      runtime.manifest.pluginApprovers,
    );
  }
  return undefined;
}

class PluginApproverConfigurationError extends Error {
  constructor() {
    super("The selected OpenClaw gateway image cannot validate approvals.plugin.slack. Use a gateway image with Slack plugin approver support, or omit the Agent, plugin, and tool approver overrides.");
  }
}

let validatedPluginApproverConfiguration;

function validateOpenClawPluginApprovers(overlay) {
  const candidate = JSON.stringify({ approvals: overlay.approvals });
  if (candidate === validatedPluginApproverConfiguration) return;
  let directory;
  try {
    directory = pluginMkdtempSync(pluginResolve(pluginTmpdir(), "oce-plugin-approvers-"));
    const configPath = pluginResolve(directory, "openclaw.json");
    pluginWriteFileSync(configPath, candidate, { mode: 0o600 });
    // Probe only the exact generated approval policy: selected external plugins
    // may not be installed yet, so a full-config check would reject them early.
    const result = pluginSpawnSync("node", ["/app/openclaw.mjs", "config", "validate", "--json"], {
      cwd: directory,
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error !== undefined || result.status !== 0 || JSON.parse(result.stdout)?.valid !== true) {
      throw new PluginApproverConfigurationError();
    }
    validatedPluginApproverConfiguration = candidate;
  } catch {
    throw new PluginApproverConfigurationError();
  } finally {
    if (directory !== undefined) {
      pluginRmSync(directory, { recursive: true, force: true });
    }
  }
}

function holdPluginApproverConfigurationFailure(error) {
  if (!(error instanceof PluginApproverConfigurationError)) return false;
  publishRuntimeFailure("plugin-approvers", "INCOMPATIBLE_RESPONSE");
  console.error(error.message);
  // Keep startup evidence available without launching an invalid gateway or
  // discarding the admitted policy through a restart loop.
  setInterval(() => {}, 3600000);
  return true;
}

function applyOpenClawPluginConfiguration(runtime, failures = [], options = {}) {
  const base = readOpenClawConfig();
  const overlay = openClawPluginConfiguration(runtime, failures, base);
  if (overlay === undefined) return;
  if (objectAtPath(overlay, ["approvals", "plugin", "slack"]) !== undefined) {
    const slack = objectAtPath(base, ["channels", "slack"]);
    if (slack === undefined || slack.enabled === false) {
      // Stored approver policy applies when Slack is configured. Omitting this
      // generated overlay preserves explicit deny lists in the admitted manifest.
      delete overlay.approvals.plugin.slack;
      if (Object.keys(overlay.approvals.plugin).length === 0) delete overlay.approvals.plugin;
      if (Object.keys(overlay.approvals).length === 0) delete overlay.approvals;
    } else {
      validateOpenClawPluginApprovers(overlay);
    }
  }
  // Native allow and alsoAllow are mutually exclusive. Keep grants in the
  // configured policy form so both application and verification use that form.
  if (base?.tools?.allow?.length > 0 && Array.isArray(overlay?.tools?.alsoAllow)) {
    overlay.tools.allow = overlay.tools.alsoAllow;
    delete overlay.tools.alsoAllow;
  }
  writeOpenClawConfig(mergeOpenClawPluginConfiguration(base, overlay, options));
  return overlay;
}

function assertConfigContainsOverlay(base, overlay, path) {
  if (isPlainObject(overlay)) {
    if (!isPlainObject(base)) throw new Error("OpenClaw plugin effective config is missing an object.");
    for (const [key, value] of Object.entries(overlay)) {
      assertConfigContainsOverlay(base[key], value, path === undefined ? key : path + "." + key);
    }
    return;
  }
  if (["tools.allow", "tools.alsoAllow", "tools.deny"].includes(path) && Array.isArray(base) && Array.isArray(overlay)) {
    for (const tool of overlay) {
      if (!base.includes(tool)) {
        throw new Error("OpenClaw plugin effective config does not match admitted configuration.");
      }
    }
    return;
  }
  if (JSON.stringify(base) !== JSON.stringify(overlay)) {
    throw new Error("OpenClaw plugin effective config does not match admitted configuration.");
  }
}

function assertCodexPluginRuntime(runtime) {
  if (runtime.manifest?.kind !== "codex") {
    throw new Error("Codex plugin runtime artifact kind mismatch.");
  }
  if (!isPlainObject(runtime.manifest.selections ?? {})) {
    throw new Error("Codex plugin selections are invalid.");
  }
}

function requireNonEmptyString(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(description + " is missing.");
  }
  return value;
}

function openClawPluginPackageSpec(plugin) {
  const packageName = requireNonEmptyString(plugin.packageName, "OpenClaw plugin package name");
  const version = requireNonEmptyString(plugin.version, "OpenClaw plugin version");
  return packageName + "@" + version;
}

function runOpenClaw(args, description, diagnostic) {
  const result = pluginSpawnSync("node", ["/app/openclaw.mjs", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || typeof result.status !== "number") {
    throw new Error(description + " failed.");
  }
  if (result.status !== 0 && diagnostic !== undefined) {
    throw new PluginTerminalDiagnosticError(diagnostic, description + " failed.");
  }
  if (result.status !== 0) {
    throw new Error(description + " failed.");
  }
  return result.stdout;
}

function runOpenClawJson(args, description) {
  const stdout = runOpenClaw(args, description);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(description + " returned invalid JSON.");
  }
}

function installRecordIntegrity(record) {
  return record?.integrity ?? record?.npmIntegrity ?? record?.acceptedSurfaceIntegrity;
}

function assertPathInside(parent, child, description) {
  const root = pluginResolve(parent);
  const candidate = pluginResolve(child);
  if (candidate !== root && !candidate.startsWith(root + "/")) {
    throw new Error(description + " does not resolve inside the admitted install path.");
  }
}

function verifyOpenClawPluginInstall(plugin) {
  const nativeId = requireNonEmptyString(plugin.nativeId, "OpenClaw plugin native ID");
  const packageName = requireNonEmptyString(plugin.packageName, "OpenClaw plugin package name");
  const version = requireNonEmptyString(plugin.version, "OpenClaw plugin version");
  const report = runOpenClawJson(["plugins", "inspect", nativeId, "--json"], "OpenClaw plugin inspect");
  if (report?.plugin?.id !== nativeId) {
    throw new Error("OpenClaw plugin installed identity does not match the admitted release.");
  }
  if (report.plugin.version !== version) {
    throw new Error("OpenClaw plugin runtime version does not match the admitted release.");
  }
  const record = report.install;
  if (record?.source !== "npm") {
    throw new Error("OpenClaw plugin install record source does not match the admitted release.");
  }
  if (record.resolvedName !== packageName) {
    throw new Error("OpenClaw plugin installed package does not match the admitted release.");
  }
  if ((record.resolvedVersion ?? record.version) !== version) {
    throw new Error("OpenClaw plugin installed version does not match the admitted release.");
  }
  if (plugin.integrity !== undefined && installRecordIntegrity(record) !== plugin.integrity) {
    throw new Error("OpenClaw plugin installed integrity does not match the admitted release.");
  }
  const installPath = requireNonEmptyString(record.installPath, "OpenClaw plugin install path");
  const rootDir = requireNonEmptyString(report.plugin.rootDir, "OpenClaw plugin runtime root directory");
  assertPathInside(installPath, rootDir, "OpenClaw plugin runtime root directory");
  if (typeof report.plugin.source === "string" && report.plugin.source.startsWith("/")) {
    assertPathInside(installPath, report.plugin.source, "OpenClaw plugin runtime source");
  }
}

function installOpenClawPlugins(runtime, failures = []) {
  const artifact =
    runtime.manifest?.kind === "openclaw"
      ? pluginRuntimeTranslator.openClawRuntimeArtifact(runtime.manifest.selections ?? {}, failures, runtime.manifest.pluginApprovers)
      : { installs: [] };
  const installs = artifact.installs ?? [];
  const failed = [...failures];
  const successfulPluginIds = [];
  const failedIds = pluginFailureIds(failed);
  const originalTools = readOpenClawConfig().tools;
  applyOpenClawPluginConfiguration(runtime, failed);
  for (const plugin of installs) {
    if (failedIds.has(plugin.pluginId)) continue;
    const spec = openClawPluginPackageSpec(plugin);
    try {
      runOpenClaw(
        ["plugins", "install", spec, "--pin", "--force", "--no-enable"],
        "OpenClaw plugin install",
        pluginDiagnostic(plugin.pluginId, "PLUGIN_INSTALL_FAILED"),
      );
      successfulPluginIds.push(plugin.pluginId);
    } catch (error) {
      if (isPluginTerminalDiagnosticError(error)) {
        if (!pluginBestEffortEnabled()) throw error;
        failed.push(error.diagnostic);
        failedIds.add(error.diagnostic.pluginId);
        continue;
      }
      throw error;
    }
  }
  if (successfulPluginIds.length > 0) {
    runOpenClawJson(["plugins", "registry", "--refresh", "--json"], "OpenClaw plugin registry refresh");
  }
  // Rebuild grants from the operator's policy so failed installs cannot leave
  // generated allow entries behind or erase an original restrictive allowlist.
  const installedConfig = readOpenClawConfig();
  installedConfig.tools = originalTools;
  writeOpenClawConfig(installedConfig);
  const overlay = applyOpenClawPluginConfiguration(runtime, failed, { allowManagedOpenClawPluginReplacement: true });
  if (overlay !== undefined) {
    assertConfigContainsOverlay(readOpenClawConfig(), overlay);
  }
  for (const plugin of installs) {
    if (failedIds.has(plugin.pluginId)) continue;
    verifyOpenClawPluginInstall(plugin);
  }
  return { successfulPluginIds, failures: failed };
}

function pluginRuntimeDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pluginRuntimeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function codexAppServerUrl() {
  return "ws://127.0.0.1:" + requireNonEmptyString(process.env.APP_SERVER_PORT, "Codex app-server port");
}

function codexAppServerHeaders() {
  return { Authorization: "Bearer " + requireNonEmptyString(process.env.APP_SERVER_TOKEN, "Codex app-server token") };
}

function createPluginWebSocket(url, options) {
  try {
    const WebSocketConstructor = require("ws");
    return new WebSocketConstructor(url, options);
  } catch {
    throw new Error("Codex app-server plugin runtime WebSocket client is unavailable.");
  }
}

function isJsonRpcError(value) {
  return (
    isPlainObject(value) &&
    Number.isInteger(value.code) &&
    typeof value.message === "string"
  );
}

function isAppSummary(value) {
  return (
    isPlainObject(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    (value.needsAuth === undefined || typeof value.needsAuth === "boolean") &&
    (value.category === undefined || value.category === null || typeof value.category === "string") &&
    (value.description === undefined ||
      value.description === null ||
      typeof value.description === "string") &&
    (value.installUrl === undefined ||
      value.installUrl === null ||
      typeof value.installUrl === "string")
  );
}

function codexAppServerRequestSequence(requests, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createPluginWebSocket(codexAppServerUrl(), { headers: codexAppServerHeaders() });
    const results = [];
    let requestIndex = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      const method = requests[requestIndex]?.method ?? "unknown";
      finish(new Error("Codex app-server plugin runtime request timed out during " + method + "."));
    }, timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.close();
      } catch {}
      if (error) reject(error);
      else resolve(value);
    }

    function sendNext() {
      const request = requests[requestIndex];
      socket.send(JSON.stringify({ id: requestIndex + 1, method: request.method, params: request.params }));
    }

    function sendInitialized() {
      socket.send(JSON.stringify({ method: "initialized", params: {} }));
    }

    socket.on("open", sendNext);
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        finish(new Error("Codex app-server plugin runtime response was invalid JSON."));
        return;
      }
      if (!isPlainObject(message)) {
        finish(new Error("Codex app-server plugin runtime response was malformed."));
        return;
      }
      if (message.id !== requestIndex + 1) return;
      // Codex 0.156.0's app-server protocol uses id plus exactly one of
      // result or error; its pinned schema omits a jsonrpc response field.
      const hasResult = hasOwn(message, "result");
      const hasError = hasOwn(message, "error");
      if (hasResult === hasError) {
        finish(new Error("Codex app-server plugin runtime response was malformed."));
        return;
      }
      if (hasError) {
        const method = requests[requestIndex]?.method ?? "unknown";
        if (!isJsonRpcError(message.error)) {
          finish(new Error("Codex app-server plugin runtime response was malformed."));
          return;
        }
        finish(new CodexAppServerRequestError(method, "Codex app-server plugin runtime request failed during " + method + ": " + (message.error.message ?? "unknown error")));
        return;
      }
      results.push(message.result);
      if (requests[requestIndex]?.method === "initialize") sendInitialized();
      requestIndex += 1;
      if (requestIndex >= requests.length) {
        finish(undefined, results);
      } else {
        sendNext();
      }
    });
    socket.on("error", () => {
      finish(new Error("Codex app-server plugin runtime transport failed."));
    });
    socket.on("close", () => {
      if (!settled) finish(new Error("Codex app-server plugin runtime transport closed."));
    });
  });
}

async function codexAppServerRequest(method, params) {
  const responses = await codexAppServerRequestSequence(
    [
      {
        method: "initialize",
        params: {
          clientInfo: {
            name: "openclaw-enterprise-plugin-runtime",
            title: "OpenClaw Enterprise Plugin Runtime",
            version: "1.0.0",
          },
          capabilities: { experimentalApi: true },
        },
      },
      { method, params },
    ],
    CODEX_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS,
  );
  return responses[1];
}

function codexConfigPathSegment(segment) {
  requireNonEmptyString(segment, "Codex config path segment");
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

function codexPluginConfigEdits(configuration) {
  return [
    ...["apps", "plugins", "remote_plugin"].map((feature) => ({
      keyPath: "features." + feature,
      mergeStrategy: "replace",
      value: configuration.features?.[feature] === true,
    })),
    // Project the complete OCE-owned policy without retaining native table entries.
    ...["apps", "plugins"].map((keyPath) => ({
      keyPath,
      mergeStrategy: "replace",
      value: configuration[keyPath],
    })),
  ];
}

async function writeCodexPluginConfiguration(configuration) {
  const effective = await readCodexPluginConfiguration();
  const edits = codexPluginConfigEdits(configuration);
  // Replacing a user table does not erase descendants inherited from other
  // config layers. Materialize the selection and approval policy at those keys.
  // Native requirements still apply independently; readback below remains mandatory.
  for (const [appId, actual] of Object.entries(effective?.apps ?? {})) {
    if (appId === "_default") continue;
    const app = configuration.apps?.[appId];
    const path = "apps." + codexConfigPathSegment(appId);
    if (app === undefined) {
      edits.push({ keyPath: path + ".enabled", mergeStrategy: "replace", value: false });
      continue;
    }
    if (app.enabled === false) continue;
    for (const [toolName, tool] of Object.entries(actual?.tools ?? {})) {
      for (const [field, defaultField] of [
        ["enabled", "default_tools_enabled"],
        ["approval_mode", "default_tools_approval_mode"],
      ]) {
        const expected = app.tools?.[toolName]?.[field] ?? app[defaultField];
        if (tool[field] == null || expected === undefined) continue;
        edits.push({
          keyPath: path + ".tools." + codexConfigPathSegment(toolName) + "." + field,
          mergeStrategy: "replace",
          value: expected,
        });
      }
    }
    for (const [linkId, link] of Object.entries(actual?.links ?? {})) {
      for (const field of ["default_tools_approval_mode", "approvals_reviewer"]) {
        if (link[field] == null || app[field] === undefined) continue;
        edits.push({
          keyPath: path + ".links." + codexConfigPathSegment(linkId) + "." + field,
          mergeStrategy: "replace",
          value: app[field],
        });
      }
    }
  }
  await codexAppServerRequest("config/batchWrite", {
    edits,
    reloadUserConfig: true,
  });
}

async function readCodexPluginConfiguration() {
  // Match the dedicated Harness workspace; a thread-agnostic read omits its
  // trusted .codex layers and can validate a different policy than the Agent uses.
  const response = await codexAppServerRequest("config/read", {
    cwd: process.env.OPENCLAW_WORKSPACE_DIR || "/home/node/workspace",
  });
  return response?.config;
}

function verifyCodexPluginConfiguration(configuration, effective) {
  assertConfigContainsOverlay(effective, configuration);
  for (const [id, policy] of Object.entries(effective.plugins ?? {})) {
    // Only explicit enablement overrides the verified default-off policy.
    if (id !== "_default" && !hasOwn(configuration.plugins, id) && policy?.enabled === true) {
      throw new Error("Codex effective plugins configuration enables an unselected entry; remove the native override or update the Agent selection.");
    }
  }
  for (const [appId, actual] of Object.entries(effective.apps ?? {})) {
    const app = configuration.apps?.[appId];
    if (app === undefined) {
      // An explicit app entry overrides _default.enabled. Unselected disabled
      // entries are harmless; never admit an enabled app outside the selection.
      if (actual.enabled !== false) {
        throw new Error("Codex effective app policy conflicts with the selected apps; remove the unselected enabled app.");
      }
      continue;
    }
    // Failed-only bindings are disabled by the required-field check above.
    // Their inherited defaults and tool exceptions cannot enable a disabled app.
    if (appId !== "_default" && app.enabled === false) continue;
    for (const [field, value] of Object.entries(actual)) {
      if (field === "tools" || field === "links" || value == null) continue;
      if (field === "approvals_reviewer" && app.approvals_reviewer === undefined) continue;
      // Codex serializes global category defaults as true, optional fields as
      // null, and an empty exposure list imposes no additional restriction.
      if (field === "omit_tools_from" && Array.isArray(value) && value.length === 0 && app[field] === undefined) continue;
      // Category values inherit; resolve OCE's intended defaults, not the native
      // values being checked. Explicit tool enablement still requires an exact match.
      const expected = ["destructive_enabled", "open_world_enabled"].includes(field)
        ? app[field] ?? configuration.apps?._default?.[field] ?? true
        : app[field];
      if (JSON.stringify(value) !== JSON.stringify(expected)) {
        throw new Error("Codex effective app policy conflicts at apps." + appId + "." + field + "; remove the native override or update the Agent policy.");
      }
    }
    if (appId === "_default") continue;
    // Native tables merge across layers; replacing the user app table does not
    // remove inherited tool exceptions. Null fields mean inheritance, not overrides.
    for (const [toolName, tool] of Object.entries(actual?.tools ?? {})) {
      for (const [field, defaultField] of [
        ["enabled", "default_tools_enabled"],
        ["approval_mode", "default_tools_approval_mode"],
      ]) {
        const expected = app.tools?.[toolName]?.[field] ?? app[defaultField];
        if (tool[field] != null && tool[field] !== expected) {
          throw new Error("Codex effective tool policy conflicts with the admitted " + field + "; remove the native tool override or update the Agent policy.");
        }
      }
    }
    for (const link of Object.values(actual?.links ?? {})) {
      if (link.default_tools_approval_mode != null &&
          link.default_tools_approval_mode !== app.default_tools_approval_mode) {
        throw new Error("Codex effective account policy conflicts with the admitted approval default; remove the native account override or update the Agent policy.");
      }
    }
  }
}

async function verifyCodexReviewerConfiguration(configuration, effective) {
  const requestedApps = Object.entries(configuration.apps ?? {})
    .filter(([, app]) => app.approvals_reviewer !== undefined);
  if (requestedApps.length === 0) return;
  const response = await codexAppServerRequest("configRequirements/read", {});
  if (!isPlainObject(response) ||
      (response.requirements !== null && !isPlainObject(response.requirements))) {
    throw new Error("Codex reviewer requirements are unavailable; use a runtime supporting configRequirements/read.");
  }
  const requirements = response.requirements ?? {};
  const allowed = requirements.allowedApprovalsReviewers;
  const requiredModels = requirements.autoReview?.requiredOnModels ?? [];
  if ((allowed != null && (!Array.isArray(allowed) || allowed.some((value) => !["user", "auto_review"].includes(value)))) ||
      !Array.isArray(requiredModels) || requiredModels.some((value) => typeof value !== "string")) {
    throw new Error("Codex reviewer requirements are invalid; verify the runtime's managed requirements.");
  }
  for (const [appId, app] of requestedApps) {
    const reviewer = app.approvals_reviewer;
    const actual = effective?.apps?.[appId];
    if (actual?.approvals_reviewer !== reviewer ||
        Object.values(actual?.links ?? {}).some((link) => link?.approvals_reviewer != null && link.approvals_reviewer !== reviewer)) {
      throw new Error("Codex effective app or account reviewer conflicts with toolDefaults.reviewer; remove the conflicting override.");
    }
    if (allowed != null && !allowed.includes(reviewer)) {
      throw new Error("Codex managed requirements forbid the requested reviewer; choose an allowed reviewer or omit the override.");
    }
    if (reviewer === "auto_review") {
      const approval = effective?.approval_policy;
      if (approval !== "on-request" && !(isPlainObject(approval) && isPlainObject(approval.granular))) {
        throw new Error("Codex automatic reviewer requires session approval on-request or granular; verify a compatible effective policy before enabling it.");
      }
    } else if (requiredModels.length > 0) {
      const model = effective?.model;
      // Native required-model matching strips one valid provider prefix.
      const slug = typeof model === "string" ? model.replace(/^[A-Za-z0-9_-]+\/([^/]*)$/, "$1") : undefined;
      if (slug === undefined || requiredModels.includes(slug)) {
        throw new Error("Codex managed model requirements prevent verifying the human reviewer; choose auto or a permitted model.");
      }
    }
  }
  // TODO: establish compatible start/resume and turn routing before claiming
  // enforcement; these checks verify startup configuration, not future turns.
}

function codexPluginSlug(plugin) {
  const registry = requireNonEmptyString(plugin.registry, "Codex plugin registry");
  const nativeId = requireNonEmptyString(plugin.nativeId, "Codex plugin native ID");
  const suffix = "@" + registry;
  return nativeId.endsWith(suffix) ? nativeId.slice(0, -suffix.length) : nativeId;
}

function codexSummaryMatchesInstall(summary, plugin) {
  const slug = codexPluginSlug(plugin);
  return summary?.id === plugin.nativeId || summary?.id === slug || summary?.name === slug;
}

function verifyCodexPluginDetail(plugin, readParams, detail) {
  const summary = detail?.plugin?.summary;
  if (summary?.installed !== true || summary?.enabled !== true) {
    throw new Error("Codex plugin was not installed and enabled before runtime readiness.");
  }
  if (detail.plugin.marketplaceName !== undefined && detail.plugin.marketplaceName !== plugin.registry) {
    throw new Error("Codex plugin installed marketplace does not match the admitted release.");
  }
  if (!codexSummaryMatchesInstall(summary, plugin) && summary.remotePluginId !== readParams.pluginName) {
    throw new Error("Codex plugin installed identity does not match the admitted release.");
  }
}

function enabledCodexSelectionIds(selections) {
  return new Set(
    Object.entries(selections ?? {})
      .filter(([, selection]) => isPlainObject(selection) && selection.enabled === true)
      .map(([pluginId]) => pluginId),
  );
}

async function readCodexToolStatuses() {
  const statuses = [];
  const cursors = new Set();
  let cursor;
  // Bound startup discovery even if a server keeps returning fresh cursors.
  for (let page = 0; page < 100; page += 1) {
    const response = await codexAppServerRequest("mcpServerStatus/list", {
      detail: "toolsAndAuthOnly",
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (
      !isPlainObject(response) || !Array.isArray(response.data) ||
      (response.nextCursor !== null &&
        (typeof response.nextCursor !== "string" || response.nextCursor.trim().length === 0))
    ) {
      throw new Error("Codex tool discovery returned invalid pagination data.");
    }
    statuses.push(...response.data);
    if (response.nextCursor === null) return statuses;
    if (cursors.has(response.nextCursor)) {
      throw new Error("Codex tool discovery returned a repeated cursor.");
    }
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error("Codex tool discovery exceeded its page limit.");
}

async function readCodexPluginDetails(readParamsList, read = (params) => codexAppServerRequest("plugin/read", params)) {
  const details = [];
  // Bound concurrent authenticated requests and drain each batch before a
  // retry or any installation/configuration write can start.
  for (let offset = 0; offset < readParamsList.length; offset += 4) {
    const results = await Promise.allSettled(readParamsList.slice(offset, offset + 4).map(
      async (params, index) => read(params, offset + index),
    ));
    const failure = results.find((result) => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
    details.push(...results.map((result) => result.value));
  }
  return details;
}

async function installCodexSelectionSet(selections, failures = []) {
  if (Object.keys(selections).length === 0) return { successfulPluginIds: [], failures: [] };
  const enabledPluginIds = enabledCodexSelectionIds(selections);
  const listed = await codexAppServerRequest("plugin/list", {});
  const readParamsList = pluginRuntimeTranslator.codexReadParamsForSelections(selections, listed);
  const resolvedDetails = await readCodexPluginDetails(readParamsList);
  const failed = [...failures];
  const failedIds = pluginFailureIds(failed);
  const successfulPluginIds = [];
  const installs = pluginRuntimeTranslator.codexInstallPlan(selections, resolvedDetails);
  // Native installation reports connector auth only for enabled plugins.
  // Grant validated selections before installation; app grants still wait for revalidation.
  await codexAppServerRequest("config/batchWrite", {
    edits: [{ keyPath: "plugins", mergeStrategy: "replace", value: {
      _default: { enabled: false },
      ...Object.fromEntries(installs.map((plugin) => [plugin.nativeId, {
        enabled: enabledPluginIds.has(plugin.pluginId) && !failedIds.has(plugin.pluginId),
      }])),
    } }],
    reloadUserConfig: true,
  });
  for (const readParams of readParamsList) {
    const selectedPlugin = installs.find(
      (candidate) => candidate.remotePluginId === readParams.pluginName,
    );
    if (selectedPlugin !== undefined && !enabledPluginIds.has(selectedPlugin.pluginId)) continue;
    if (selectedPlugin !== undefined && failedIds.has(selectedPlugin.pluginId)) continue;
    let install;
    try {
      install = await codexAppServerRequest("plugin/install", readParams);
    } catch (error) {
      if (
        error instanceof CodexAppServerRequestError &&
        error.method === "plugin/install" &&
        selectedPlugin !== undefined
      ) {
        if (!pluginBestEffortEnabled()) {
          throw new PluginTerminalDiagnosticError(
            pluginDiagnostic(selectedPlugin.pluginId, "PLUGIN_INSTALL_FAILED"),
            "Codex plugin installation failed.",
          );
        }
        const diagnostic = pluginDiagnostic(selectedPlugin.pluginId, "PLUGIN_INSTALL_FAILED");
        failed.push(diagnostic);
        failedIds.add(diagnostic.pluginId);
        continue;
      }
      throw error;
    }
    if (!isPlainObject(install)) {
      throw new Error("Codex plugin installation returned invalid data.");
    }
    if (install.authPolicy !== "ON_INSTALL" && install.authPolicy !== "ON_USE") {
      throw new Error("Codex plugin installation returned invalid authentication data.");
    }
    const appsNeedingAuth = install.appsNeedingAuth;
    if (appsNeedingAuth !== undefined && !Array.isArray(appsNeedingAuth)) {
      throw new Error("Codex plugin installation returned invalid authentication data.");
    }
    if ((appsNeedingAuth ?? []).some((app) => !isAppSummary(app))) {
      throw new Error("Codex plugin installation returned invalid authentication data.");
    }
    if ((appsNeedingAuth ?? []).length > 0) {
      if (selectedPlugin !== undefined) {
        if (!pluginBestEffortEnabled()) {
          throw new PluginTerminalDiagnosticError(
            pluginDiagnostic(selectedPlugin.pluginId, "PLUGIN_AUTH_REQUIRED"),
            "Codex plugin installation requires connector authentication.",
          );
        }
        const diagnostic = pluginDiagnostic(selectedPlugin.pluginId, "PLUGIN_AUTH_REQUIRED");
        failed.push(diagnostic);
        failedIds.add(diagnostic.pluginId);
        continue;
      }
      throw new Error("Codex plugin installation requires connector authentication.");
    }
    if (selectedPlugin !== undefined) successfulPluginIds.push(selectedPlugin.pluginId);
  }
  const enabledSelections = Object.fromEntries(
    Object.entries(selections).filter(([pluginId]) => enabledPluginIds.has(pluginId) && !failedIds.has(pluginId)),
  );
  const toolStatuses = pluginRuntimeTranslator.codexNeedsToolInventory(enabledSelections)
    ? await readCodexToolStatuses()
    : [];
  const effectiveResolvedArtifact = pluginRuntimeTranslator.codexRuntimeArtifact(selections, resolvedDetails, failed, toolStatuses);
  const installedDetails = await readCodexPluginDetails(readParamsList, (readParams, index) => {
    const selectedPlugin = installs.find(
      (candidate) => candidate.remotePluginId === readParams.pluginName,
    );
    if (
      selectedPlugin !== undefined &&
      (failedIds.has(selectedPlugin.pluginId) || !enabledPluginIds.has(selectedPlugin.pluginId))
    ) {
      return resolvedDetails[index];
    }
    return codexAppServerRequest("plugin/read", readParams);
  });
  const installedArtifact = pluginRuntimeTranslator.codexRuntimeArtifact(selections, installedDetails, failed, toolStatuses);
  if (JSON.stringify(installedArtifact.installs) !== JSON.stringify(effectiveResolvedArtifact.installs)) {
    throw new Error("Codex plugin installed release metadata does not match startup resolution.");
  }
  if (JSON.stringify(installedArtifact.configuration) !== JSON.stringify(effectiveResolvedArtifact.configuration)) {
    throw new Error("Codex plugin installed app mapping does not match startup resolution.");
  }
  // Remote plugin/read reports catalog metadata, not cached bundle contents.
  // Recheck the admitted release and app mapping before granting apps.
  await writeCodexPluginConfiguration(effectiveResolvedArtifact.configuration);
  const enabledReadParams = readParamsList.filter((readParams) => installs.some(
    (plugin) => plugin.remotePluginId === readParams.pluginName &&
      !failedIds.has(plugin.pluginId) && enabledPluginIds.has(plugin.pluginId),
  ));
  const enabledDetails = await readCodexPluginDetails(enabledReadParams);
  for (const plugin of effectiveResolvedArtifact.installs) {
    if (failedIds.has(plugin.pluginId) || !enabledPluginIds.has(plugin.pluginId)) continue;
    const readParams = enabledReadParams.find((candidate) => candidate.pluginName === plugin.remotePluginId);
    if (readParams === undefined) {
      throw new Error("Codex plugin installed identity does not match the selected catalog entry.");
    }
    const detail = enabledDetails[enabledReadParams.indexOf(readParams)];
    verifyCodexPluginDetail(plugin, readParams, detail);
  }
  // TODO: use native effective app/tool policy introspection when available.
  // Codex 0.156 config/read omits managed app requirements applied at execution;
  // this readback verifies loaded configuration, not future thread policy.
  const effectiveConfiguration = await readCodexPluginConfiguration();
  await verifyCodexReviewerConfiguration(effectiveResolvedArtifact.configuration, effectiveConfiguration);
  verifyCodexPluginConfiguration(effectiveResolvedArtifact.configuration, effectiveConfiguration);
  return { successfulPluginIds, failures: failed };
}

// Codex serves the curated remote catalog only to ChatGPT logins and rejects an
// API-key login ("api key auth is not supported"), so retrying cannot succeed.
// Disable every enabled selection as an authentication requirement and turn the
// plugin features off instead of holding the Harness unready.
async function disableCodexSelectionsWithoutChatGptLogin(selections, failures = []) {
  const failed = [...failures];
  const failedIds = pluginFailureIds(failed);
  for (const pluginId of enabledCodexSelectionIds(selections)) {
    if (failedIds.has(pluginId)) continue;
    const diagnostic = pluginDiagnostic(pluginId, "PLUGIN_AUTH_REQUIRED");
    if (!pluginBestEffortEnabled()) {
      throw new PluginTerminalDiagnosticError(
        diagnostic,
        "Codex plugins require a ChatGPT login; API-key authentication cannot install them.",
      );
    }
    failed.push(diagnostic);
    failedIds.add(pluginId);
  }
  if (Object.keys(selections).length > 0) {
    const configuration = {
      features: { apps: false, plugins: false, remote_plugin: false },
      apps: { _default: { enabled: false } },
      plugins: { _default: { enabled: false } },
    };
    // The app-server may still be starting: retry like the ChatGPT install path.
    const deadline = Date.now() + CODEX_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS;
    let lastError = new Error("Codex plugin disable deadline expired before the first attempt.");
    while (Date.now() < deadline) {
      try {
        await writeCodexPluginConfiguration(configuration);
        verifyCodexPluginConfiguration(configuration, await readCodexPluginConfiguration());
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await pluginRuntimeDelay(250);
      }
    }
    if (lastError !== undefined) {
      const failure = new Error("Codex plugin disable did not reach readiness: " + pluginRuntimeErrorMessage(lastError));
      failure.startupCode = codexPluginStartupFailureCode(lastError);
      throw failure;
    }
  }
  return { successfulPluginIds: [], failures: failed };
}

async function installCodexPlugins(runtime, failures = []) {
  assertCodexPluginRuntime(runtime);
  const selections = runtime.manifest.selections ?? {};
  if (process.env.CODEX_LOGIN_MODE === "api_key") {
    return disableCodexSelectionsWithoutChatGptLogin(selections, failures);
  }
  const deadline = Date.now() + CODEX_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS;
  let lastError = new Error("Codex plugin installation deadline expired before the first attempt.");
  let result = { successfulPluginIds: [], failures };
  while (Date.now() < deadline) {
    try {
      result = await installCodexSelectionSet(selections, failures);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      await pluginRuntimeDelay(250);
    }
  }
  if (lastError !== undefined) {
    const failure = new Error("Codex plugin installation did not reach readiness: " + pluginRuntimeErrorMessage(lastError));
    failure.startupCode = codexPluginStartupFailureCode(lastError);
    throw failure;
  }
  return result;
}

// A fixed cause code for remote logs; the message, which can carry native
// Codex error text, stays in local container output.
function codexPluginStartupFailureCode(error) {
  switch (pluginRuntimeErrorMessage(error)) {
    case "Codex plugin catalog did not contain the selected plugin.":
      return "PLUGIN_NOT_IN_CATALOG";
    case "Codex plugin detail did not contain the selected plugin.":
      return "PLUGIN_DETAIL_MISSING";
    default:
      return "PLUGIN_NOT_READY";
  }
}
`;
