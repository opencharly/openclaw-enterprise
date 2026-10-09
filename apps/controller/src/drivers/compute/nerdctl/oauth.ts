import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { asRecord, isNonEmptyString, sha256Hex } from "@openclaw-enterprise/utils";

import { ConfigurationFailure, OwnershipFailure } from "./errors.ts";

/**
 * The Codex OAuth handoff for this engine.
 *
 * The platform stages a Codex device login as a Secret in the selected Secret Driver and hands
 * a Compute Driver only its reference (`ComputeRevisionContext.harnessAuth`), never the value.
 * The Kubernetes Compute Driver reads that Secret with its own cluster client; an engine with
 * no cluster reads the filesystem Secret Driver's store that composition injects into this
 * Driver. That is the same trust boundary the Kubernetes Compute Driver already has over its
 * cluster's Secret API — a Compute Driver may read the credential backend it delivers from —
 * and it is the only way this engine can consume the login the platform actually staged.
 *
 * Confinement: the bundle reaches the dedicated Codex volume and nothing else. It is never
 * placed in argv, an environment variable, a log line, or a message; the seed travels to the
 * volume through a read-only mount of a Driver-owned file, and the platform's copy is replaced
 * by a consumed marker.
 *
 * The filesystem Secret Driver stores one owner-only JSON document per Secret at
 * `<root>/<sha256Hex(namespaceId, 12)>/<sha256Hex(secretId, 32)>.json`, exposed as
 * `{uid, namespaceId, name, value}`. The path is derived here rather than imported, so this
 * module names the layout it depends on: changing that layout changes both Drivers.
 */

/** Environment variables the shared runtime validates the seeded receipt against. */
export const OAUTH_SOURCE_UID_ENVIRONMENT = "OCE_CODEX_OAUTH_SOURCE_UID";
export const OAUTH_VOLUME_UID_ENVIRONMENT = "OCE_CODEX_OAUTH_VOLUME_UID";

/** Environment of the one-shot seeder inside the dedicated Codex volume. */
export const OAUTH_SEED_PATH_ENVIRONMENT = "OCE_CODEX_OAUTH_SEED_PATH";
export const CODEX_HOME_ENVIRONMENT = "OPENCLAW_CODEX_HOME";

/** The receipt the shared runtime reads beside `auth.json` before it logs in. */
export const OAUTH_RECEIPT_FILE = ".oce-oauth.json";
export const OAUTH_AUTH_FILE = "auth.json";

/** The Driver-owned file the seeder mounts read-only, holding the native bundle. */
export const OAUTH_SEED_FILE = "codex-oauth-seed.json";

/** The login mode the shared Codex runtime expects for this Driver's two paths. */
export type CodexLoginMode = "api_key" | "oauth";

/** What the harness container and the seeded receipt name as this login's identity. */
export interface OAuthReceipt {
  readonly sourceUid: string;
  readonly volumeUid: string;
}

/** The single data key the filesystem Secret Driver exposes, as `backendRef.key` names it. */
const STORED_SECRET_KEY = "value";

/** One staged device login, as the platform wrote it into Secret storage. */
interface StoredLogin {
  readonly uid: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly value: string;
}

/** A staged login with the session envelope it carries and the Secret it came from. */
export interface StagedOAuthLogin {
  readonly secretId: string;
  readonly uid: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly value: string;
  readonly agentId?: string;
  readonly phase: string;
  readonly credential?: string;
  readonly volumeUid?: string;
  readonly expiresAt?: string;
}

/**
 * The native Codex `auth.json` the shared runtime logs in from. It is handed on verbatim after
 * validation, as the Kubernetes Compute Driver seeds `credential.auth` unchanged: the file also
 * carries Codex's own `account_id`, `last_refresh` and a null `OPENAI_API_KEY`, and rebuilding a
 * subset would drop bookkeeping Codex expects to find.
 */
export type NativeCodexAuth = Readonly<Record<string, unknown>>;

/** The identity a Compute Driver reads a staged login by, as the platform resolved it. */
export interface OAuthLoginReference {
  readonly secretId: string;
  readonly namespaceId: string;
  readonly backendRef: {
    readonly name: string;
    readonly key: string;
    readonly uid: string;
  };
}

/**
 * The state volume's identity as the receipt records it. This engine issues no volume UID, so
 * the binding is the Agent-owned volume name, which is itself derived from the exact Namespace
 * and Agent. It proves the seeded bundle belongs to this Agent's own Codex home; it cannot
 * prove the volume was never recreated, which only an engine-issued identity could.
 */
export function codexHomeVolumeUid(namespaceId: string, agentId: string): string {
  return sha256Hex(`nerdctl-codex-home:${namespaceId}/${agentId}`, 32);
}

function storedLoginPath(directory: string, namespaceId: string, secretId: string): string {
  return join(directory, sha256Hex(namespaceId, 12), `${sha256Hex(secretId, 32)}.json`);
}

function record(value: unknown, description: string): Record<string, unknown> {
  const parsed = asRecord(value);
  if (parsed === undefined) {
    throw new ConfigurationFailure(`${description} is not an object.`);
  }
  return parsed;
}

function text(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new ConfigurationFailure(`${description} is missing.`);
  }
  return value;
}

/** Reads and authenticates one staged login from the Secret Driver's store. */
export async function readOAuthLogin(
  directory: string,
  reference: OAuthLoginReference,
): Promise<StagedOAuthLogin> {
  if (reference.backendRef.key !== STORED_SECRET_KEY) {
    throw new ConfigurationFailure("The staged OAuth login uses an unsupported Secret key.");
  }
  let content: string;
  try {
    content = await readFile(
      storedLoginPath(directory, reference.namespaceId, reference.secretId),
      "utf8",
    );
  } catch {
    // A missing login is the operator's to fix, and a raw filesystem error would name a path
    // that leads to a credential.
    throw new ConfigurationFailure("The staged OAuth login is not present in Secret storage.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw new ConfigurationFailure("The staged OAuth login storage is malformed.");
  }
  const stored = record(decoded, "Stored OAuth login");
  const login: StoredLogin = {
    uid: text(stored.uid, "Stored OAuth login UID"),
    namespaceId: text(stored.namespaceId, "Stored OAuth login Namespace"),
    name: text(stored.name, "Stored OAuth login name"),
    value: text(stored.value, "Stored OAuth login value"),
  };
  // The reference the platform resolved must still describe this exact document. Only the uid
  // can prove that: a Secret Driver whose backend has no cluster coordinates publishes an
  // opaque reference (the filesystem Driver hashes the Namespace and Secret names), so its
  // `name` is a locator, not the Secret's name. The path is derived from the Namespace and
  // Secret ids, and the uid is the one this Driver issued and stored in the document.
  if (login.uid !== reference.backendRef.uid) {
    throw new OwnershipFailure("The staged OAuth login changed ownership.");
  }
  if (login.namespaceId !== reference.namespaceId) {
    throw new OwnershipFailure("The staged OAuth login belongs to another Namespace.");
  }
  const envelope = session(login.value);
  if (envelope.namespaceId !== login.namespaceId) {
    // The session inside the document must belong to the Namespace that owns the document.
    throw new OwnershipFailure("The staged OAuth login belongs to another Namespace.");
  }
  return { secretId: reference.secretId, ...login, ...envelope };
}

function session(value: string): {
  readonly namespaceId: string;
  readonly phase: string;
  readonly agentId?: string;
  readonly credential?: string;
  readonly volumeUid?: string;
  readonly expiresAt?: string;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new ConfigurationFailure("The staged OAuth login is not a login session.");
  }
  const envelope = record(decoded, "Staged OAuth login");
  if (
    envelope.kind !== "harness_device_authorization" ||
    envelope.version !== 1 ||
    envelope.harnessId !== "codex" ||
    !isNonEmptyString(envelope.namespaceId) ||
    !isNonEmptyString(envelope.phase)
  ) {
    throw new ConfigurationFailure("The staged OAuth login is not a Codex login session.");
  }
  return {
    namespaceId: envelope.namespaceId as string,
    phase: envelope.phase,
    ...(isNonEmptyString(envelope.agentId) ? { agentId: envelope.agentId } : {}),
    ...(isNonEmptyString(envelope.credential) ? { credential: envelope.credential } : {}),
    ...(isNonEmptyString(envelope.volumeUid) ? { volumeUid: envelope.volumeUid } : {}),
    ...(isNonEmptyString(envelope.expiresAt) ? { expiresAt: envelope.expiresAt } : {}),
  };
}

/**
 * The login's state for this exact Agent and Codex home. `consumed` is the end state: the bundle
 * is already on the Agent's private volume and the staged copy may never be read again.
 */
export function oauthLoginState(
  login: StagedOAuthLogin,
  namespaceId: string,
  agentId: string,
  volumeUid: string,
): "fresh" | "claimed" | "consumed" {
  if (login.phase === "consumed") {
    // A spent login is never replaced: another Agent, or this Agent after storage loss, needs a
    // new sign-in. Checked before the claim check, as the Kubernetes path orders it.
    if (login.agentId !== agentId || login.volumeUid !== volumeUid) {
      throw new ConfigurationFailure(
        "Consumed OAuth credentials cannot be replaced; sign in again.",
      );
    }
    return "consumed";
  }
  if (
    login.agentId !== undefined &&
    login.volumeUid !== undefined &&
    (login.agentId !== agentId || login.volumeUid !== volumeUid)
  ) {
    throw new OwnershipFailure(
      "OAuth credentials belong to another Agent or require reconnect after storage loss.",
    );
  }
  if (login.phase !== "ready" && login.phase !== "claimed") {
    // The platform writes `claimed` here; the other phases are its own admission states.
    throw new ConfigurationFailure("The staged OAuth login is not ready; sign in again.");
  }
  return login.phase === "claimed" ? "claimed" : "fresh";
}

/**
 * Validates a ready login against this exact Agent and extracts the native Codex bundle. The
 * shape is the one the Kubernetes Compute Driver accepts, so the shared runtime logs in from
 * either engine without a second contract.
 */
export function nativeCodexAuth(
  login: StagedOAuthLogin,
  namespaceId: string,
  agentId: string,
): NativeCodexAuth {
  if (login.namespaceId !== namespaceId) {
    throw new OwnershipFailure("The staged OAuth login belongs to another Namespace.");
  }
  if (login.agentId !== undefined && login.agentId !== agentId) {
    throw new OwnershipFailure("The staged OAuth login belongs to another Agent.");
  }
  // A login the platform already expired must not be seeded, exactly as on the Kubernetes path.
  if (
    login.credential === undefined ||
    login.expiresAt === undefined ||
    !(Date.parse(login.expiresAt) > Date.now())
  ) {
    throw new ConfigurationFailure("The staged OAuth login is not ready; sign in again.");
  }
  let credential: Record<string, unknown>;
  try {
    credential = record(JSON.parse(login.credential), "Staged OAuth credential");
  } catch {
    throw new ConfigurationFailure("The staged OAuth credential is malformed.");
  }
  const auth = record(credential.auth, "Staged OAuth credential");
  const tokens = record(auth.tokens, "Staged OAuth tokens");
  if (
    credential.version !== 1 ||
    credential.provider !== "codex" ||
    credential.state !== "ready" ||
    auth.auth_mode !== "chatgpt" ||
    !isNonEmptyString(tokens.id_token) ||
    !isNonEmptyString(tokens.access_token) ||
    !isNonEmptyString(tokens.refresh_token)
  ) {
    throw new ConfigurationFailure("The staged OAuth credential is unavailable; sign in again.");
  }
  return auth as NativeCodexAuth;
}

/**
 * Reserves the login for this exact Agent and Codex home before anything is written, so a
 * concurrent deployment cannot claim the same login and a retry after a partial failure
 * resumes where it stopped. The filesystem store has no Secret annotations, so the state the
 * Kubernetes path keeps in annotations travels in the stored envelope instead; the credential
 * value is preserved until it has been seeded.
 */
export async function claimOAuthLogin(
  directory: string,
  login: StagedOAuthLogin,
  agentId: string,
  volumeUid: string,
): Promise<void> {
  const claimed = JSON.stringify({
    ...record(JSON.parse(login.value), "Staged OAuth login"),
    agentId,
    volumeUid,
    phase: "claimed",
  });
  await writeStoredLogin(directory, login, claimed);
}

/**
 * Irreversibly replaces the staged login with the marker the Kubernetes Compute Driver also
 * leaves behind: after this the login can never be read again by this engine or the API, and
 * the deployed Codex refreshes its own tokens on the private volume.
 */
export async function consumeOAuthLogin(
  directory: string,
  login: StagedOAuthLogin,
  namespaceId: string,
  agentId: string,
  volumeUid: string,
): Promise<void> {
  const marker = JSON.stringify({
    kind: "harness_device_authorization",
    version: 1,
    harnessId: "codex",
    namespaceId,
    agentId,
    phase: "consumed",
    volumeUid,
  });
  await writeStoredLogin(directory, login, marker);
}

async function writeStoredLogin(
  directory: string,
  login: StagedOAuthLogin,
  value: string,
): Promise<void> {
  const path = storedLoginPath(directory, login.namespaceId, login.secretId);
  // The document keeps the backend identity the Secret Driver verifies on every later read; a
  // change to it would make the platform refuse the Secret as foreign.
  const stored: StoredLogin = {
    uid: login.uid,
    namespaceId: login.namespaceId,
    name: login.name,
    value,
  };
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Writes the native bundle to a Driver-owned file the seeder mounts read-only. The directory is
 * private and the file owner-only: the bundle never travels through an environment variable,
 * argv, or a container image layer.
 */
export async function writeOAuthSeedPayload(
  directory: string,
  auth: NativeCodexAuth,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, OAUTH_SEED_FILE);
  await writeFile(path, JSON.stringify(auth), { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function removeOAuthSeedPayload(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * The one-shot seeder's program. It runs as root inside the container so it can hand the files
 * to the workload user on the Codex volume, exactly as the workspace initializer does. With no
 * seed path it removes any earlier personal login instead: a revision that stopped using OAuth
 * must not leave a credential refreshing on the Agent's disk.
 */
export function oauthSeedScript(): string {
  return `
const seedFs = require("node:fs");
const home = process.env.${CODEX_HOME_ENVIRONMENT};
if (typeof home !== "string" || !home.startsWith("/")) {
  throw new Error("The Codex home must be an absolute path.");
}
seedFs.mkdirSync(home, { recursive: true, mode: 0o700 });
const seedPath = process.env.${OAUTH_SEED_PATH_ENVIRONMENT};
if (seedPath === undefined || !seedFs.existsSync(seedPath)) {
  for (const name of [${JSON.stringify(OAUTH_AUTH_FILE)}, ${JSON.stringify(OAUTH_RECEIPT_FILE)}]) {
    seedFs.rmSync(home + "/" + name, { force: true });
  }
  process.exit(0);
}
const auth = JSON.parse(seedFs.readFileSync(seedPath, "utf8"));
const tokens = auth && auth.tokens;
if (
  auth === null ||
  typeof auth !== "object" ||
  auth.auth_mode !== "chatgpt" ||
  tokens === null ||
  typeof tokens !== "object" ||
  [tokens.id_token, tokens.access_token, tokens.refresh_token].some(
    (value) => typeof value !== "string" || value.trim().length === 0,
  )
) {
  throw new Error("The Codex OAuth bundle is not a usable ChatGPT login.");
}
// A new OAuth source starts without an earlier history, as on the Kubernetes path.
seedFs.rmSync(home + "/sessions", { recursive: true, force: true });
const writeOwned = (name, textValue) => {
  const path = home + "/" + name;
  // Tighten the mode while this process still owns the file, then hand it to the workload user;
  // the umask must never be able to widen a credential file.
  seedFs.writeFileSync(path, textValue, { mode: 0o600 });
  seedFs.chmodSync(path, 0o600);
  seedFs.chownSync(path, 1000, 1000);
};
writeOwned(${JSON.stringify(OAUTH_AUTH_FILE)}, JSON.stringify(auth));
writeOwned(
  ${JSON.stringify(OAUTH_RECEIPT_FILE)},
  JSON.stringify({
    sourceUid: process.env.${OAUTH_SOURCE_UID_ENVIRONMENT},
    volumeUid: process.env.${OAUTH_VOLUME_UID_ENVIRONMENT},
  }),
);
`;
}
