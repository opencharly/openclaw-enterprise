import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  JSONSchema,
  Secret,
  SecretBackendRef,
  SecretDriver,
  SecretIdentity,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";

export const DRIVER_ID = "occ/filesystem-secret";
export const DRIVER_IMPLEMENTATION = "occ/filesystem-secret";

/** The single data key a stored value is exposed under, as a backend reference names it. */
const SECRET_KEY = "value";

export interface FilesystemSecretDriverOptions {
  /** Absolute directory that owns the stored values. It is created on first writes. */
  readonly directory: string;
}

interface FilesystemSecretSelection {
  readonly id?: string;
  readonly implementation?: string;
}

/** A stored secret: its backend identity plus the value the platform never logs. */
interface StoredSecret {
  readonly uid: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly value: string;
}

export class FilesystemSecretError extends Error {}

/**
 * Stores secret values as owner-only files on the host that runs the worker, for engines
 * that have no cluster Secret API. Values never leave this module except through
 * `resolve`, `withValue`, or the reference the platform persists.
 */
export class FilesystemSecretDriver implements SecretDriver {
  static readonly configurationSchema: JSONSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["directory"],
    properties: {
      // A relative directory would resolve against the process working directory and
      // silently scatter credentials.
      directory: { type: "string", pattern: "^/" },
    },
  });

  static validateConfiguration(configuration: unknown): void {
    const value = asRecord(configuration);
    if (value === undefined) {
      throw new FilesystemSecretError("Filesystem Secret options are required.");
    }
    const unknown = Object.keys(value).filter((key) => key !== "directory");
    if (unknown.length > 0) {
      throw new FilesystemSecretError(
        `Filesystem Secret options contain unsupported field ${unknown[0]}.`,
      );
    }
    const directory = value.directory;
    if (typeof directory !== "string" || !directory.startsWith("/") || directory.endsWith("/")) {
      throw new FilesystemSecretError(
        "Filesystem Secret directory must be an absolute path without a trailing separator.",
      );
    }
  }

  readonly id: string;
  readonly implementation: string;
  readonly capability = "secret" as const;

  private readonly options: FilesystemSecretDriverOptions;

  constructor(options: FilesystemSecretDriverOptions, selection: FilesystemSecretSelection = {}) {
    FilesystemSecretDriver.validateConfiguration(options);
    this.id = selection.id ?? DRIVER_ID;
    this.implementation = selection.implementation ?? DRIVER_IMPLEMENTATION;
    this.options = immutableCopy(options);
  }

  async create(identity: SecretIdentity, value: string): Promise<SecretBackendRef> {
    const path = this.pathFor(identity);
    // A create that overwrote an existing value would silently destroy a credential in use.
    if (await this.exists(path)) {
      throw new FilesystemSecretError("A Secret already exists for this identity.");
    }
    const stored: StoredSecret = {
      uid: randomBytes(16).toString("hex"),
      namespaceId: identity.namespaceId,
      name: identity.name,
      value: requiredValue(value),
    };
    await this.write(path, stored);
    return this.reference(stored);
  }

  async update(secret: Secret, value: string): Promise<void> {
    const path = this.pathFor(secret);
    const stored = await this.owned(path, secret);
    await this.write(path, { ...stored, value: requiredValue(value) });
  }

  /**
   * Replaces the current value only when it exactly matches `expected`.
   *
   * The worker serializes Secret operations, so a read-compare-rename is atomic in
   * practice; two processes writing the same file at once would race.
   */
  async compareAndSwap(secret: Secret, expected: string, value: string): Promise<boolean> {
    const path = this.pathFor(secret);
    const stored = await this.owned(path, secret);
    if (stored.value !== expected) {
      return false;
    }
    await this.write(path, { ...stored, value: requiredValue(value) });
    return true;
  }

  async delete(secret: Secret): Promise<void> {
    const path = this.pathFor(secret);
    await this.owned(path, secret);
    await rm(path, { force: false });
  }

  async resolve(secret: Secret): Promise<SecretBackendRef> {
    return this.reference(await this.owned(this.pathFor(secret), secret));
  }

  async withValue<T>(secret: Secret, use: (value: string) => Promise<T>): Promise<T> {
    const stored = await this.owned(this.pathFor(secret), secret);
    return use(stored.value);
  }

  /** Reads a stored secret, refusing one whose identity or UID does not match exactly. */
  private async owned(path: string, secret: Secret): Promise<StoredSecret> {
    const stored = await this.read(path);
    if (
      stored.uid !== secret.backendRef.uid ||
      stored.namespaceId !== secret.namespaceId ||
      stored.name !== secret.name
    ) {
      throw new FilesystemSecretError("Refusing a Secret this Driver does not own.");
    }
    return stored;
  }

  private async read(path: string): Promise<StoredSecret> {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      throw new FilesystemSecretError("The Secret is not present in filesystem storage.");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(content);
    } catch {
      // A raw parse error would carry stored bytes into a message the platform may log.
      throw new FilesystemSecretError("Filesystem Secret storage is malformed.");
    }
    const parsed = asRecord(decoded);
    if (
      parsed === undefined ||
      typeof parsed.uid !== "string" ||
      typeof parsed.namespaceId !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.value !== "string"
    ) {
      throw new FilesystemSecretError("Filesystem Secret storage is malformed.");
    }
    return {
      uid: parsed.uid,
      namespaceId: parsed.namespaceId,
      name: parsed.name,
      value: parsed.value,
    };
  }

  /** Writes through a private temporary file so a reader never sees a partial value. */
  private async write(path: string, stored: StoredSecret): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }

  private async exists(path: string): Promise<boolean> {
    return (await stat(path).catch(() => undefined))?.isFile() === true;
  }

  private pathFor(identity: SecretIdentity): string {
    // Directory per namespace keeps a listing bounded, and the hash keeps an identity out
    // of the filesystem layout.
    return join(
      this.options.directory,
      sha256Hex(identity.namespaceId, 12),
      `${sha256Hex(identity.id, 32)}.json`,
    );
  }

  private reference(stored: StoredSecret): SecretBackendRef {
    return {
      namespaceName: stored.namespaceId,
      name: stored.name,
      key: SECRET_KEY,
      uid: stored.uid,
    };
  }
}

/** An empty value would be indistinguishable from a missing credential. */
function requiredValue(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FilesystemSecretError("A Secret value must be a non-empty string.");
  }
  return value;
}
