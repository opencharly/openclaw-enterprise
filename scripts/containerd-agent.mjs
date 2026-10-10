#!/usr/bin/env node
// Deploy a dedicated Codex Agent through the platform a stack scripts/containerd-up started.
//
// Credentials come from the canonical store by default, so this runs unattended: the harness
// credential is either the stored ChatGPT OAuth bundle or the stored provider key, the service key
// is the one the platform was bootstrapped with, and nothing is prompted for or regenerated.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function parseArguments(argv) {
  const store = process.env.OCC_CONTAINERD_STORE ?? join(homedir(), ".config/oce-containerd");
  const options = {
    store,
    state: process.env.OCC_CONTAINERD_STATE ?? join(homedir(), ".local/state/oce-containerd"),
    baseUrl: process.env.OCC_BASE_URL ?? "",
    namespaceId: "",
    namespaceName: process.env.OCC_CONTAINERD_BOOTSTRAP_NAMESPACE ?? "default",
    agentName: process.env.OCC_CONTAINERD_AGENT_NAME ?? "codex-agent",
    model: process.env.OCC_CONTAINERD_AGENT_MODEL ?? "",
    auth: process.env.OCC_CONTAINERD_AUTH ?? "",
    providerKeyFile: process.env.OCC_CONTAINERD_PROVIDER_KEY_FILE ?? "",
    oauthBundleFile: process.env.OCC_CONTAINERD_OAUTH_BUNDLE ?? "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--state":
        options.state = value ?? "";
        index += 1;
        break;
      case "--store":
        options.store = value ?? "";
        index += 1;
        break;
      case "--base-url":
        options.baseUrl = value ?? "";
        index += 1;
        break;
      case "--namespace-id":
        options.namespaceId = value ?? "";
        index += 1;
        break;
      case "--namespace-name":
        options.namespaceName = value ?? "";
        index += 1;
        break;
      case "--agent-name":
        options.agentName = value ?? "";
        index += 1;
        break;
      case "--model":
        options.model = value ?? "";
        index += 1;
        break;
      case "--auth":
        options.auth = value ?? "";
        index += 1;
        break;
      case "--oauth":
        options.auth = "oauth";
        break;
      case "--provider-key-file":
        options.providerKeyFile = value ?? "";
        index += 1;
        break;
      case "--oauth-bundle":
        options.oauthBundleFile = value ?? "";
        index += 1;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  return options;
}

function usage() {
  process.stderr.write(
    [
      "Usage: node scripts/containerd-agent.mjs [options]",
      "",
      "Credentials default to the canonical store (~/.config/oce-containerd):",
      "  codex-oauth.json  the ChatGPT OAuth bundle, used when --auth oauth",
      "  openai.key        the provider key, used when --auth api_key",
      "  service-key.json  the platform service key written by the stack bootstrap",
      "  platform.env      the API port this stack serves on",
      "",
      "  --auth oauth|api_key   harness credential route (default: oauth when a bundle is stored)",
      "  --agent-name NAME      Agent name (default codex-agent)",
      "  --model NAME           Codex model name (default gpt-6-luna for OAuth, gpt-5.6-luna for a key)",
      "  --store DIRECTORY      canonical credential store",
      "  --state DIRECTORY      stack state directory (logs, pids, Installation)",
      "  --base-url URL         controller base URL (default from the store)",
      "  --namespace-id ID      exact OCC Namespace to deploy into",
      "  --namespace-name NAME  OCC Namespace name to resolve (default default)",
      "",
    ].join("\n"),
  );
}

async function callRequest(baseUrl, apiKey, method, path, body) {
  const headers = { "x-api-key": apiKey };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = payload?.error?.code ?? response.status;
    const message = payload?.error?.message ?? "the request failed";
    return { ok: false, error: `${method} ${path} failed: ${code}: ${message}` };
  }
  return { ok: true, data: payload.data };
}

async function call(baseUrl, apiKey, method, path, body) {
  const result = await callRequest(baseUrl, apiKey, method, path, body);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.data;
}

/** The stack's own API port, then the store's, so several stacks coexist unattended. */
async function stackApiPort(state, store) {
  try {
    return (await readFile(join(state, "api-port"), "utf8")).trim();
  } catch {
    try {
      const contents = await readFile(join(store, "platform.env"), "utf8");
      return /^OCC_CONTAINERD_API_PORT=(\d+)$/m.exec(contents)?.[1];
    } catch {
      return undefined;
    }
  }
}

/** Reads the service key from the store, falling back to a bootstrap file inside the state. */
async function serviceKey(state, store) {
  const candidates = [
    join(state, "bootstrap/initial-admin-service-key.json"),
    join(store, "service-key.json"),
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(await readFile(path, "utf8")).data.key;
    } catch {
      continue;
    }
  }
  throw new Error(`no service key in ${store}/service-key.json or ${state}/bootstrap`);
}

async function existingSecret(baseUrl, key, namespaceId, name) {
  const secrets = await call(baseUrl, key, "GET", `/namespaces/${namespaceId}/secrets`);
  return secrets.find((entry) => entry.name === name);
}

async function stageSecret(baseUrl, key, namespaceId, name, value) {
  const created = await callRequest(baseUrl, key, "POST", `/namespaces/${namespaceId}/secrets`, {
    name,
    value,
  });
  if (created.ok) {
    return created.data;
  }
  if (!created.error.includes("RESOURCE_CONFLICT")) {
    throw new Error(created.error);
  }
  const existing = await existingSecret(baseUrl, key, namespaceId, name);
  if (existing === undefined) {
    throw new Error(created.error);
  }
  return call(baseUrl, key, "PATCH", `/namespaces/${namespaceId}/secrets/${existing.id}`, {
    value,
  });
}

async function roleForSecret(baseUrl, key, namespaceId, roleName) {
  const created = await callRequest(baseUrl, key, "POST", `/namespaces/${namespaceId}/iam/roles`, {
    name: roleName,
    permissions: [{ resourceKind: "secret", action: "operate" }],
  });
  if (created.ok) {
    return created.data;
  }
  if (!created.error.includes("RESOURCE_CONFLICT")) {
    throw new Error(created.error);
  }
  const roles = await call(baseUrl, key, "GET", `/namespaces/${namespaceId}/iam/roles`);
  const existing = roles.find((entry) => entry.name === roleName);
  if (existing === undefined) {
    throw new Error(created.error);
  }
  return existing;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help === true) {
    usage();
    return;
  }

  const oauthBundleFile = options.oauthBundleFile || join(options.store, "codex-oauth.json");
  const providerKeyFile = options.providerKeyFile || join(options.store, "openai.key");
  const route =
    options.auth !== ""
      ? options.auth
      : await readFile(oauthBundleFile).then(
          () => "oauth",
          () => "api_key",
        );
  if (route !== "oauth" && route !== "api_key") {
    usage();
    throw new Error("--auth must be oauth or api_key");
  }

  const port = (await stackApiPort(options.state, options.store)) ?? "3100";
  const baseUrl = options.baseUrl !== "" ? options.baseUrl : `http://127.0.0.1:${port}`;
  const key = await serviceKey(options.state, options.store);
  const model =
    options.model !== "" ? options.model : route === "oauth" ? "gpt-6-luna" : "gpt-5.6-luna";
  const modelRef = model.includes("/") ? model : `codex/${model}`;

  let namespaceId = options.namespaceId;
  if (namespaceId === "") {
    const namespaces = await call(baseUrl, key, "GET", "/namespaces");
    const match = (namespaces ?? []).find((entry) => entry.name === options.namespaceName);
    if (match === undefined) {
      throw new Error(
        `no Namespace named ${options.namespaceName}; pass --namespace-id or --namespace-name`,
      );
    }
    namespaceId = match.id;
  }

  // The staged value is the platform's own harness credential document. An OAuth harness gets the
  // device-authorization envelope carrying the stored ChatGPT login; a provider-key harness gets
  // the key itself. Neither value is printed, logged, or written outside the store and the API.
  let secretId;
  if (route === "oauth") {
    const auth = JSON.parse(await readFile(oauthBundleFile, "utf8"));
    const envelope = JSON.stringify({
      kind: "harness_device_authorization",
      version: 1,
      harnessId: "codex",
      namespaceId,
      phase: "ready",
      credential: JSON.stringify({ version: 1, provider: "codex", state: "ready", auth }),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    const secret = await stageSecret(
      baseUrl,
      key,
      namespaceId,
      `${options.agentName}-oauth-login`,
      envelope,
    );
    secretId = secret.id;
  } else {
    const providerKey = (await readFile(providerKeyFile, "utf8")).trim();
    if (providerKey === "") {
      throw new Error(`${providerKeyFile} is empty`);
    }
    const secret = await stageSecret(
      baseUrl,
      key,
      namespaceId,
      `${options.agentName}-harness-key`,
      providerKey,
    );
    secretId = secret.id;
  }

  const configuration = await call(
    baseUrl,
    key,
    "POST",
    `/namespaces/${namespaceId}/configurations`,
    {
      kind: "agent",
      values: {
        agents: {
          defaults: {
            model: modelRef,
            // A dedicated Agent states its Harness runtime explicitly, and the Codex runtime runs the
            // model from its own credential rather than through a platform provider endpoint.
            models: { [modelRef]: { agentRuntime: { id: "codex" } } },
            workspace: "/home/node/workspace",
          },
        },
        models: {
          providers: { codex: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" } },
        },
        // Without an explicit local gateway mode the runtime refuses to start; without a LAN bind the
        // published loopback port reaches nothing.
        gateway: { mode: "local", bind: "lan" },
      },
    },
  );

  const agent = await call(baseUrl, key, "POST", `/namespaces/${namespaceId}/agents`, {
    name: options.agentName,
    configurationId: configuration.id,
    executionMode: "dedicated",
    harnessAuth: {
      method: route === "oauth" ? "oauth" : "api_key",
      source: { kind: "secret", namespaceId, id: secretId },
    },
    plugins: {},
  });

  // The Agent's own service principal has to operate the staged credential before it can deploy.
  const role = await roleForSecret(baseUrl, key, namespaceId, `${options.agentName}-operator`);
  await call(baseUrl, key, "POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: `service-agent-${agent.id}`,
    roleId: role.id,
    resourceKind: "secret",
    resourceId: secretId,
  });

  // The deploy operation admits the Agent's own saved draft and accepts no request body.
  const deployment = await call(
    baseUrl,
    key,
    "POST",
    `/namespaces/${namespaceId}/agents/${agent.id}/deploy`,
  );

  process.stdout.write(
    [
      "containerd-agent: the Agent is deploying",
      "",
      `  namespace     ${namespaceId}`,
      `  agent         ${agent.id} (${agent.name})`,
      `  model         ${modelRef}`,
      `  harness auth  ${route} from Secret ${secretId}`,
      `  revision      ${deployment?.revisionId ?? deployment?.id ?? "queued"}`,
      "",
      "Watch the platform deliver it:",
      "",
      `  grep -h "REVISION_ACTIVATED" ${options.state}/worker.log`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`containerd-agent: ${error.message}\n`);
  process.exitCode = 1;
});
