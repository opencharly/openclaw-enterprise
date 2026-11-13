import { PLUGIN_RUNTIME_HELPERS } from "./kubernetes/runtime-entrypoints.ts";

/** The environment variable a managed gateway password is delivered in. */
export const GATEWAY_PASSWORD_ENV = "OPENCLAW_GATEWAY_PASSWORD";
/** The configuration reference that resolves to that variable. */
export const GATEWAY_PASSWORD_REFERENCE = `\${${GATEWAY_PASSWORD_ENV}}`;

// Shared by every Driver that runs the OpenClaw gateway as a container. The runtime
// entrypoint, its plugin helpers and its signal forwarding are identical whichever engine
// hosts the container, so no single driver owns a private copy.

export const GATEWAY_RUNTIME_ENTRYPOINT = String.raw`
const { chmodSync, mkdirSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");

${PLUGIN_RUNTIME_HELPERS}

function forwardTermination(child) {
  let terminating = false;
  const forward = (signal) => {
    if (terminating) return;
    terminating = true;
    child.kill(signal);
    setTimeout(() => child.kill("SIGKILL"), 8_000).unref();
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
}

mkdirSync("/home/node/.openclaw", { recursive: true, mode: 0o700 });
mkdirSync("/home/node/workspace", { recursive: true, mode: 0o700 });
chmodSync("/home/node/.openclaw", 0o700);
chmodSync("/home/node/workspace", 0o700);
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, process.env.OPENCLAW_CONFIG_JSON, { mode: 0o600 });
delete process.env.OPENCLAW_CONFIG_JSON;
delete process.env.OPENCLAW_LOG_LEVEL;
const pluginRuntime = readGatewayPluginRuntime();
try {
if (pluginRuntime !== undefined) installOpenClawPlugins(pluginRuntime);
const child = spawn(
  "node",
  ["/app/openclaw.mjs", "gateway", "--port", process.env.OPENCLAW_GATEWAY_PORT],
  { stdio: "inherit" },
);
forwardTermination(child);
child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGTERM" ? 0 : 1)));
} catch (error) {
  if (!holdPluginApproverConfigurationFailure(error)) throw error;
}
`;
