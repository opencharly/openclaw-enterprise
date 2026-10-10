import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  Configuration,
  ConfigurationDriver,
  ConfigurationReference,
  JSONSchema,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { validateModelCredentialReferences } from "../model-auth.ts";
import { immutableCopy } from "@openclaw-enterprise/utils";

const ID = /^(?:ns|cfg)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pathFor(root: string, reference: ConfigurationReference): string {
  for (const [value, prefix] of [
    [reference.namespaceId, "ns"],
    [reference.id, "cfg"],
  ]) {
    if (typeof value !== "string" || !value.startsWith(`${prefix}_`) || !ID.test(value)) {
      throw new Error(`Configuration ${prefix} ID must be a server-generated ${prefix}_ ID.`);
    }
  }
  return join(root, reference.namespaceId, `${reference.id}.json`);
}

export interface FilesystemConfigurationDriverOptions {
  /** Absolute directory that owns the stored Configuration documents. */
  readonly root: string;
}

interface FilesystemConfigurationSelection {
  readonly id?: string;
  readonly implementation?: string;
}

export const FILESYSTEM_CONFIGURATION_ID = "occ/filesystem-configuration";

/**
 * Stores Configuration documents as files on the host that runs the worker, for engines
 * with no cluster ConfigMap API.
 */
export class FilesystemConfigurationDriver implements ConfigurationDriver {
  static readonly configurationSchema: JSONSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["root"],
    properties: {
      // A relative root would resolve against the worker's working directory.
      root: { type: "string", pattern: "^/" },
    },
  });

  static validateConfiguration(configuration: unknown): void {
    const value =
      typeof configuration === "object" && configuration !== null
        ? (configuration as Record<string, unknown>)
        : undefined;
    if (value === undefined) {
      throw new Error("Filesystem Configuration options are required.");
    }
    const unknown = Object.keys(value).filter((key) => key !== "root");
    if (unknown.length > 0) {
      throw new Error(`Filesystem Configuration options contain unsupported field ${unknown[0]}.`);
    }
    const root = value.root;
    if (typeof root !== "string" || !root.startsWith("/")) {
      throw new Error("Filesystem Configuration root must be an absolute path.");
    }
  }

  readonly id: string;
  readonly implementation: string;
  readonly capability = "configuration" as const;
  private readonly root: string;

  constructor(
    options: FilesystemConfigurationDriverOptions,
    selection: FilesystemConfigurationSelection = {},
  ) {
    FilesystemConfigurationDriver.validateConfiguration(options);
    this.id = selection.id ?? FILESYSTEM_CONFIGURATION_ID;
    this.implementation = selection.implementation ?? FILESYSTEM_CONFIGURATION_ID;
    this.root = resolve(options.root);
  }

  async validateValues(values: OpenClawConfigurationDocument): Promise<void> {
    validateModelCredentialReferences(values);
  }

  async validate(configuration: Configuration): Promise<void> {
    pathFor(this.root, configuration);
    await this.validateValues(configuration.values);
  }

  async create(configuration: Configuration): Promise<Configuration> {
    await this.write(configuration);
    return immutableCopy(configuration) as Configuration;
  }

  async read(reference: ConfigurationReference): Promise<Configuration> {
    const configuration: unknown = JSON.parse(
      await readFile(pathFor(this.root, reference), "utf8"),
    );
    if (
      typeof configuration !== "object" ||
      configuration === null ||
      Array.isArray(configuration) ||
      !("id" in configuration) ||
      configuration.id !== reference.id ||
      !("namespaceId" in configuration) ||
      configuration.namespaceId !== reference.namespaceId
    ) {
      throw new Error("Stored Configuration does not belong to the exact requested Namespace.");
    }
    await this.validate(configuration as Configuration);
    return immutableCopy(configuration as Configuration) as Configuration;
  }

  async update(configuration: Configuration): Promise<Configuration> {
    await this.read(configuration);
    return this.create(configuration);
  }

  async delete(reference: ConfigurationReference): Promise<void> {
    await this.read(reference);
    await rm(pathFor(this.root, reference));
  }

  private async write(configuration: Configuration): Promise<void> {
    await this.validate(configuration);
    const path = pathFor(this.root, configuration);
    const directory = join(this.root, configuration.namespaceId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${configuration.id}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(`${JSON.stringify(configuration)}\n`);
      } finally {
        await file.close();
      }
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export function createFilesystemDevelopmentConfigurationDriverFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FilesystemConfigurationDriver {
  const root = environment.OCC_DEVELOPMENT_CONFIGURATION_ROOT ?? "";
  if (root.trim().length === 0) {
    throw new Error(
      "OCC_DEVELOPMENT_CONFIGURATION_ROOT is required for filesystem development configurations.",
    );
  }
  return new FilesystemConfigurationDriver({ root });
}
