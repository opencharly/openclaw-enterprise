/**
 * The Agent's own runtime credentials, held as files on the control-plane host.
 *
 * A containerised engine has no Secret store, so the Driver owns these files the way the
 * Kubernetes Driver owns its credential Secrets: it creates one when it is missing, preserves
 * the value it finds, and removes it with the Agent. The gateway password is the transport
 * credential for an embedded OpenClaw runtime: the platform admits a revision only when it is
 * present, and a replacement container must present the same one, or a restart would lose the
 * authentication its clients are holding.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Hex } from "@openclaw-enterprise/utils";

import { ConfigurationFailure } from "./errors.ts";

/** The credential file names inside an Agent's credential directory. */
export const GATEWAY_PASSWORD_CREDENTIAL = "gateway-password";
/**
 * The transport token a dedicated harness and its gateway both present. One value for two
 * roles, generated once and reused by every later container, is what lets a restart keep the
 * authenticated channel its peers are holding.
 */
export const TRANSPORT_TOKEN_CREDENTIAL = "app-server-token";

/** A managed password is a 32-byte token in hex, so a damaged file is refused, not used. */
const CREDENTIAL_PATTERN = /^[a-f0-9]{64}$/;

export interface CredentialOwnership {
  readonly namespaceId: string;
  readonly agentId: string;
}

export function credentialDirectory(directory: string, ownership: CredentialOwnership): string {
  const prefix = `oce-${sha256Hex(`${ownership.namespaceId}/${ownership.agentId}`, 12)}`;
  return join(directory, prefix);
}

export function gatewayPasswordPath(directory: string, ownership: CredentialOwnership): string {
  return join(credentialDirectory(directory, ownership), GATEWAY_PASSWORD_CREDENTIAL);
}

export function transportTokenPath(directory: string, ownership: CredentialOwnership): string {
  return join(credentialDirectory(directory, ownership), TRANSPORT_TOKEN_CREDENTIAL);
}

/** Reads a managed credential, or undefined when it was never provisioned. */
async function readCredential(path: string): Promise<string | undefined> {
  let value: string;
  try {
    value = await readFile(path, { encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new ConfigurationFailure(`the gateway credential is unreadable: ${String(error)}.`);
  }
  const trimmed = value.trim();
  if (!CREDENTIAL_PATTERN.test(trimmed)) {
    // A credential this Driver did not write cannot be trusted to authenticate a runtime.
    throw new ConfigurationFailure(
      `${path} is not a managed credential; restore or delete it before deploying.`,
    );
  }
  return trimmed;
}

/** Writes a credential beside its target and renames it, so no reader sees a partial value. */
async function writeCredential(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}`;
  await writeFile(temporary, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Reads a credential, creating it and its directory when it was never provisioned. */
async function provisionCredential(
  directory: string,
  ownership: CredentialOwnership,
  path: string,
): Promise<string> {
  const existing = await readCredential(path);
  if (existing !== undefined) {
    return existing;
  }
  await mkdir(credentialDirectory(directory, ownership), { recursive: true, mode: 0o700 });
  const value = randomBytes(32).toString("hex");
  await writeCredential(path, value);
  return value;
}

/** Reads the Agent's gateway password, or undefined when it was never provisioned. */
export function readGatewayPassword(
  directory: string,
  ownership: CredentialOwnership,
): Promise<string | undefined> {
  return readCredential(gatewayPasswordPath(directory, ownership));
}

/** Reads the Agent's transport token, or undefined when it was never provisioned. */
export function readTransportToken(
  directory: string,
  ownership: CredentialOwnership,
): Promise<string | undefined> {
  return readCredential(transportTokenPath(directory, ownership));
}

/** Reads the Agent's transport token, generating it when it is missing. */
export function provisionTransportToken(
  directory: string,
  ownership: CredentialOwnership,
): Promise<string> {
  return provisionCredential(directory, ownership, transportTokenPath(directory, ownership));
}

/** Creates the Agent's gateway password when it is missing and preserves the existing value. */
export function provisionGatewayPassword(
  directory: string,
  ownership: CredentialOwnership,
): Promise<string> {
  return provisionCredential(directory, ownership, gatewayPasswordPath(directory, ownership));
}

/** Removes every credential this Agent owns; nothing else lives in that directory. */
export async function removeAgentCredentials(
  directory: string,
  ownership: CredentialOwnership,
): Promise<void> {
  await rm(credentialDirectory(directory, ownership), { recursive: true, force: true });
}
