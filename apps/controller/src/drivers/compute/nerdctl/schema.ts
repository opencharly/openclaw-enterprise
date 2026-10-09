import { immutableCopy } from "@openclaw-enterprise/utils";

import { ConfigurationFailure } from "./errors.ts";
import { cpusToCores, memoryToBytes } from "./quantity.ts";

/** Driver identity used by Installation selection and the capability matrix. */
export const DRIVER_ID = "compute-nerdctl";
export const DRIVER_IMPLEMENTATION = "occ/nerdctl";

/** The helper and every configured path must be absolute. */
const PATH_SCHEMA = Object.freeze({ type: "string", pattern: "^/" });
/**
 * An image reference. Whether it must carry a digest is a configuration decision: a
 * development profile may run locally built images, production refuses a tag.
 */
const IMAGE_SCHEMA = Object.freeze({ type: "string", minLength: 1, pattern: "^\\S+$" });
const COUNT_SCHEMA = Object.freeze({
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

export interface NerdctlComputeDriverOptions {
  readonly helper: {
    readonly path: string;
    readonly timeoutSeconds: number;
  };
  readonly containerd: {
    readonly namespace: string;
    readonly address?: string;
  };
  readonly images: {
    readonly gateway: string;
    readonly agent: string;
    /** False only outside production, where a locally built image has no digest. */
    readonly requireImmutableDigest: boolean;
  };
  readonly credentials: {
    readonly directory: string;
  };
  readonly egress?: {
    readonly proxyImage: string;
    readonly allowlist: readonly string[];
    /** The port the proxy listens on inside its container; 8080 when unstated. */
    readonly port: number;
  };
  readonly resources: {
    readonly gateway: ResourceLimits;
    readonly agent: ResourceLimits;
    readonly namespace: {
      readonly quota: Readonly<Record<string, string>>;
      readonly containerDefaults: ResourceLimits;
    };
  };
}

/** The limits a container may consume, already converted to engine units. */
export interface ResourceLimits {
  readonly memoryBytes: number;
  readonly cpus: number;
}

export { ConfigurationFailure } from "./errors.ts";

/**
 * The closed Installation configuration for the nerdctl compute Driver. Composition
 * validates the submitted document against this schema before construction.
 */
const RESOURCE_QUANTITY_SCHEMA = Object.freeze({ type: "string", minLength: 1 });
const RESOURCE_REQUIREMENTS_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["requests", "limits"],
  properties: {
    requests: {
      type: "object",
      additionalProperties: false,
      required: ["cpu", "memory"],
      properties: { cpu: RESOURCE_QUANTITY_SCHEMA, memory: RESOURCE_QUANTITY_SCHEMA },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      required: ["cpu", "memory"],
      properties: { cpu: RESOURCE_QUANTITY_SCHEMA, memory: RESOURCE_QUANTITY_SCHEMA },
    },
  },
});

export const configurationSchema = immutableCopy({
  type: "object",
  additionalProperties: false,
  required: ["helper", "containerd", "images", "credentials"],
  properties: {
    helper: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: PATH_SCHEMA,
        timeoutSeconds: COUNT_SCHEMA,
      },
    },
    containerd: {
      type: "object",
      additionalProperties: false,
      required: ["namespace"],
      properties: {
        namespace: { type: "string", minLength: 1 },
        address: PATH_SCHEMA,
      },
    },
    images: {
      type: "object",
      additionalProperties: false,
      required: ["gateway", "agent", "requireImmutableDigest"],
      properties: {
        gateway: IMAGE_SCHEMA,
        agent: IMAGE_SCHEMA,
        requireImmutableDigest: { type: "boolean" },
      },
    },
    credentials: {
      type: "object",
      additionalProperties: false,
      required: ["directory"],
      properties: {
        directory: PATH_SCHEMA,
      },
    },
    egress: {
      type: "object",
      additionalProperties: false,
      required: ["proxyImage", "allowlist", "port"],
      properties: {
        port: COUNT_SCHEMA,
        proxyImage: IMAGE_SCHEMA,
        allowlist: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$" },
        },
      },
    },
    // The same document the Kubernetes Driver reads, so one rendered profile configures
    // either engine. Requests are scheduler reservations and have no engine equivalent.
    resources: {
      type: "object",
      additionalProperties: false,
      required: ["gateway", "agent", "namespace"],
      properties: {
        gateway: RESOURCE_REQUIREMENTS_SCHEMA,
        agent: RESOURCE_REQUIREMENTS_SCHEMA,
        namespace: {
          type: "object",
          additionalProperties: false,
          required: ["quota", "containerDefaults"],
          properties: {
            quota: { type: "object", additionalProperties: { type: "string" } },
            containerDefaults: RESOURCE_REQUIREMENTS_SCHEMA,
          },
        },
      },
    },
  },
});

const DEFAULT_HELPER_TIMEOUT_SECONDS = 180;
const KNOWN_SECTIONS = new Set([
  "helper",
  "containerd",
  "images",
  "credentials",
  "egress",
  "resources",
]);

/** Reads one container's limits out of a resources section, converting its quantities. */
function sectionRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationFailure(`${description} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function resourceLimits(section: string, value: unknown): ResourceLimits {
  // The constructor re-validates the options this function returned, so an already converted
  // section passes through unchanged instead of being parsed twice.
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const converted = value as Record<string, unknown>;
    if (typeof converted.memoryBytes === "number" && typeof converted.cpus === "number") {
      return { memoryBytes: converted.memoryBytes, cpus: converted.cpus };
    }
  }
  const requirements = sectionRecord(value, section);
  const limits = requiredRecord(requirements, "limits");
  const cpu = limits.cpu;
  const memory = limits.memory;
  if (typeof cpu !== "string" || typeof memory !== "string") {
    throw new ConfigurationFailure(`${section}.limits must carry a cpu and a memory quantity.`);
  }
  return {
    memoryBytes: memoryToBytes(`${section}.limits.memory`, memory),
    cpus: cpusToCores(`${section}.limits.cpu`, cpu),
  };
}

/**
 * Resources are required, so a limit is either honoured or the Configuration is refused. The
 * engine has no namespace quota or scheduler request, and this records both rather than
 * pretending otherwise: requests are carried for parity and the namespace quota is admitted
 * unchanged.
 */
function applyResources(
  options: Omit<NerdctlComputeDriverOptions, "resources">,
  document: Record<string, unknown>,
): NerdctlComputeDriverOptions {
  const resources = requiredRecord(document, "resources");
  const namespace = sectionRecord(resources.namespace, "resources.namespace");
  const quota = sectionRecord(namespace.quota, "resources.namespace.quota");
  const entries = Object.entries(quota);
  for (const [key, value] of entries) {
    if (typeof value !== "string") {
      throw new ConfigurationFailure(`resources.namespace.quota.${key} must be a quantity string.`);
    }
  }
  return {
    ...options,
    resources: {
      gateway: resourceLimits("resources.gateway", resources.gateway),
      agent: resourceLimits("resources.agent", resources.agent),
      namespace: {
        quota: Object.fromEntries(entries) as Readonly<Record<string, string>>,
        containerDefaults: resourceLimits(
          "resources.namespace.containerDefaults",
          namespace.containerDefaults,
        ),
      },
    },
  };
}

/**
 * validateConfiguration narrows a submitted document to driver options. Composition
 * already checked the schema, so this enforces the cross-field rules a schema cannot
 * express and fails closed rather than defaulting.
 */
export function validateConfiguration(configuration: unknown): NerdctlComputeDriverOptions {
  if (typeof configuration !== "object" || configuration === null) {
    throw new ConfigurationFailure("nerdctl compute configuration must be an object.");
  }
  const document = configuration as Record<string, unknown>;
  const unknown = Object.keys(document).filter((key) => !KNOWN_SECTIONS.has(key));
  if (unknown.length > 0) {
    throw new ConfigurationFailure(`unknown configuration sections: ${unknown.join(", ")}.`);
  }
  const helper = requiredRecord(document, "helper");
  const containerd = requiredRecord(document, "containerd");
  const images = requiredRecord(document, "images");
  const credentials = requiredRecord(document, "credentials");

  // Read the image policy first: it decides whether a reference must carry a digest.
  const immutableImages = requiredBoolean(
    images,
    "requireImmutableDigest",
    "images.requireImmutableDigest",
  );
  const options: Omit<NerdctlComputeDriverOptions, "resources"> = {
    helper: {
      path: requiredPath(helper, "path", "helper.path"),
      timeoutSeconds:
        optionalCount(helper, "timeoutSeconds", "helper.timeoutSeconds") ??
        DEFAULT_HELPER_TIMEOUT_SECONDS,
    },
    containerd: {
      namespace: requiredText(containerd, "namespace", "containerd.namespace"),
      ...optionalPath(containerd, "address", "containerd.address"),
    },
    images: {
      gateway: requiredImage(images, "gateway", "images.gateway", immutableImages),
      agent: requiredImage(images, "agent", "images.agent", immutableImages),
      requireImmutableDigest: immutableImages,
    },
    credentials: {
      directory: requiredPath(credentials, "directory", "credentials.directory"),
    },
  };
  const withResources = applyResources(options, document);

  const egress = document.egress;
  if (egress !== undefined) {
    const proxy = requiredRecord(document, "egress");
    const port = proxy.port;
    if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new ConfigurationFailure("egress.port must be a TCP port.");
    }
    const allowlist = proxy.allowlist;
    if (!Array.isArray(allowlist) || allowlist.length === 0) {
      throw new ConfigurationFailure("egress.allowlist must name at least one host.");
    }
    // The egress proxy is the allowlist control point: a workload without it can reach
    // any host, so a partial configuration must not silently disable the control.
    for (const entry of allowlist) {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new ConfigurationFailure("egress.allowlist entries must be non-empty host names.");
      }
    }
    return immutableCopy({
      ...withResources,
      egress: {
        port,
        proxyImage: requiredImage(proxy, "proxyImage", "egress.proxyImage", immutableImages),
        allowlist: [...allowlist] as string[],
      },
    });
  }
  return immutableCopy(withResources);
}

function requiredRecord(document: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = document[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationFailure(`${key} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(document: Record<string, unknown>, key: string, description: string): string {
  const value = document[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationFailure(`${description} must be a non-empty string.`);
  }
  return value;
}

function requiredPath(document: Record<string, unknown>, key: string, description: string): string {
  const value = requiredText(document, key, description);
  if (!value.startsWith("/")) {
    throw new ConfigurationFailure(`${description} must be an absolute path.`);
  }
  return value;
}

function optionalPath(
  document: Record<string, unknown>,
  key: string,
  description: string,
): Record<string, string> {
  const value = document[key];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new ConfigurationFailure(`${description} must be an absolute path.`);
  }
  return { address: value };
}

function optionalCount(
  document: Record<string, unknown>,
  key: string,
  description: string,
): number | undefined {
  const value = document[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ConfigurationFailure(`${description} must be a positive integer.`);
  }
  return value;
}

/** An unpinned image would change under a revision the platform treats as immutable. */
function requiredImage(
  document: Record<string, unknown>,
  key: string,
  description: string,
  immutable: boolean,
): string {
  const value = requiredText(document, key, description);
  if (immutable && !/@sha256:[0-9a-f]{64}$/.test(value)) {
    throw new ConfigurationFailure(`${description} must use an immutable SHA-256 digest.`);
  }
  return value;
}

function requiredBoolean(
  document: Record<string, unknown>,
  key: string,
  description: string,
): boolean {
  const value = document[key];
  if (typeof value !== "boolean") {
    throw new ConfigurationFailure(`${description} must be a boolean.`);
  }
  return value;
}
