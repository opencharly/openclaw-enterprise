#!/usr/bin/env node
// Deploy a dedicated Codex Agent through the platform a stack scripts/containerd-up started.
//
// This mirrors the console and API workflow the chart's initialization Job leaves an operator:
// one namespace-owned Secret holds the provider key, one Agent configuration selects the model
// and the local gateway, and one Agent binds that Secret as its harness credential before it is
// deployed. Nothing here reaches into the engine: the platform's own Driver delivers the Agent.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function parseArguments(argv) {
  const options = {
    state: process.env.OCC_CONTAINERD_STATE ?? join(homedir(), ".local/state/oce-containerd"),
    baseUrl: "",
    namespaceId: "",
    namespaceName: process.env.OCC_CONTAINERD_BOOTSTRAP_NAMESPACE ?? "default",
    agentName: process.env.OCC_CONTAINERD_AGENT_NAME ?? "codex-api-key-agent",
    model: process.env.OCC_CONTAINERD_AGENT_MODEL ?? "gpt-5.6-luna",
    providerKeyFile: process.env.OCC_CONTAINERD_PROVIDER_KEY_FILE ?? "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--state":
        options.state = value ?? "";
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
      case "--provider-key-file":
        options.providerKeyFile = value ?? "";
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
      "Usage: node scripts/containerd-agent.mjs --provider-key-file FILE [options]",
      "",
      "  --provider-key-file FILE  file holding the provider key, read and never printed",
      "  --state DIRECTORY         state directory of the running stack",
      "  --base-url URL            controller base URL (default from the state directory)",
      "  --namespace-id ID         exact OCC Namespace to deploy into",
      "  --namespace-name NAME     OCC Namespace name to resolve (default default)",
      "  --agent-name NAME         Agent name (default codex-api-key-agent)",
      "  --model NAME              Codex model name (default gpt-5.6-luna)",
      "",
    ].join("\n"),
  );
}

async function readStackEnvironment(state) {
  const contents = await readFile(join(state, "stack.env"), "utf8");
  const values = new Map();
  for (const line of contents.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match !== null) {
      values.set(match[1], match[2]);
    }
  }
  return values;
}

async function request(baseUrl, apiKey, method, path, body) {
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
  const result = await request(baseUrl, apiKey, method, path, body);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.data;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help === true) {
    usage();
    return;
  }
  if (options.providerKeyFile === "") {
    usage();
    throw new Error("--provider-key-file is required");
  }

  const stack = await readStackEnvironment(options.state);
  const baseUrl =
    options.baseUrl !== ""
      ? options.baseUrl
      : `http://127.0.0.1:${stack.get("OCC_CONTAINERD_API_PORT") ?? "3100"}`;
  const serviceKey = JSON.parse(
    await readFile(join(options.state, "bootstrap/initial-admin-service-key.json"), "utf8"),
  ).data.key;
  // The value is read here and travels only in the request body. It is never printed, logged or
  // written anywhere else.
  const providerKey = (await readFile(options.providerKeyFile, "utf8")).trim();
  // The model reference names its provider; a bare model name is a Codex model.
  const modelRef = options.model.includes("/") ? options.model : `codex/${options.model}`;
  if (providerKey === "") {
    throw new Error("the provider key file is empty");
  }

  let namespaceId = options.namespaceId;
  if (namespaceId === "") {
    const namespaces = await call(baseUrl, serviceKey, "GET", "/namespaces");
    const match = (namespaces ?? []).find((entry) => entry.name === options.namespaceName);
    if (match === undefined) {
      throw new Error(
        `no Namespace named ${options.namespaceName}; pass --namespace-id or --namespace-name`,
      );
    }
    namespaceId = match.id;
  }

  // Staging the harness credential is idempotent: a Secret of this name is restaged with the
  // current key rather than refused, so a repeated run deploys the key the operator supplies.
  const secretName = `${options.agentName}-harness-key`;
  let secret = await call(baseUrl, serviceKey, "POST", `/namespaces/${namespaceId}/secrets`, {
    name: secretName,
    value: providerKey,
  }).catch(async (error) => {
    if (!String(error.message).includes("RESOURCE_CONFLICT")) {
      throw error;
    }
    const existing = (
      await call(baseUrl, serviceKey, "GET", `/namespaces/${namespaceId}/secrets`)
    ).find((entry) => entry.name === secretName);
    if (existing === undefined) {
      throw error;
    }
    return call(baseUrl, serviceKey, "PATCH", `/namespaces/${namespaceId}/secrets/${existing.id}`, {
      value: providerKey,
    });
  });

  const configuration = await call(
    baseUrl,
    serviceKey,
    "POST",
    `/namespaces/${namespaceId}/configurations`,
    {
      kind: "agent",
      values: {
        agents: {
          defaults: {
            model: modelRef,
            // A dedicated Agent states its Harness runtime explicitly, and the Codex harness runs
            // the model from its own staged credential rather than a platform provider endpoint.
            models: { [modelRef]: { agentRuntime: { id: "codex" } } },
            workspace: "/home/node/workspace",
          },
        },
        models: {
          providers: { codex: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" } },
        },
        // Without an explicit local gateway mode the runtime refuses to start; without a LAN bind
        // the published loopback port reaches nothing.
        gateway: { mode: "local", bind: "lan" },
      },
    },
  );

  const agent = await call(baseUrl, serviceKey, "POST", `/namespaces/${namespaceId}/agents`, {
    name: options.agentName,
    configurationId: configuration.id,
    executionMode: "dedicated",
    harnessAuth: {
      method: "api_key",
      source: { kind: "secret", namespaceId, id: secret.id },
    },
    plugins: {},
  });

  // The Agent's own service principal has to be able to operate the staged credential; the
  // platform refuses to deploy an Agent that cannot reach its harness Secret.
  const roleName = `${options.agentName}-harness-key-operator`;
  const role = await call(baseUrl, serviceKey, "POST", `/namespaces/${namespaceId}/iam/roles`, {
    name: roleName,
    permissions: [{ resourceKind: "secret", action: "operate" }],
  }).catch(async (error) => {
    if (!String(error.message).includes("RESOURCE_CONFLICT")) {
      throw error;
    }
    const roles = await call(baseUrl, serviceKey, "GET", `/namespaces/${namespaceId}/iam/roles`);
    const existing = roles.find((entry) => entry.name === roleName);
    if (existing === undefined) {
      throw error;
    }
    return existing;
  });
  await call(baseUrl, serviceKey, "POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: `service-agent-${agent.id}`,
    roleId: role.id,
    resourceKind: "secret",
    resourceId: secret.id,
  });

  // The deploy operation admits the Agent's own saved draft and accepts no request body.
  const deployment = await call(
    baseUrl,
    serviceKey,
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
      `  harness auth  api_key from Secret ${secret.id} (operate granted to service-agent-${agent.id})`,
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
