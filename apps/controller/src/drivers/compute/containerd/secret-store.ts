import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { asRecord, isNonEmptyString, sha256Hex } from "@openclaw-enterprise/utils";

import { ConfigurationFailure, OwnershipFailure } from "./errors.ts";

/**
 * The selected Secret Driver's store, as this Compute Driver reads it.
 *
 * The platform stages a credential as a Secret in the selected Secret Driver and hands a Compute
 * Driver only the reference it resolved (`ComputeRevisionContext.harnessAuth`), never the value.
 * The Kubernetes Compute Driver reads that Secret with its own cluster client; an engine with no
 * cluster reads the filesystem Secret Driver's store that composition injects into this Driver.
 * That is the same trust boundary the Kubernetes Compute Driver already has over its cluster's
 * Secret API — a Compute Driver may read the credential backend it delivers from — and it is the
 * only way this engine can deliver the credentials the platform actually staged.
 *
 * The filesystem Secret Driver stores one owner-only JSON document per Secret at
 * `<root>/<sha256Hex(namespaceId, 12)>/<sha256Hex(secretId, 32)>.json`, exposed as
 * `{uid, namespaceId, name, value}`. The path is derived here rather than imported, so this module
 * names the layout it depends on: changing that layout changes both Drivers.
 */

/** The single data key the filesystem Secret Driver exposes, as `backendRef.key` names it. */
export const STORED_SECRET_KEY = "value";

/** One stored Secret document, as the Secret Driver wrote it. */
export interface StoredSecretDocument {
  readonly uid: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly value: string;
}

export function storedSecretPath(directory: string, namespaceId: string, secretId: string): string {
  return join(directory, sha256Hex(namespaceId, 12), `${sha256Hex(secretId, 32)}.json`);
}

/**
 * Reads and authenticates one staged Secret value.
 *
 * Only the uid can prove the document is the one the platform resolved: a Secret Driver whose
 * backend has no cluster coordinates publishes an opaque reference, so its `name` is a locator,
 * not the Secret's name. The document must still belong to the Namespace the revision was placed
 * in. A value is returned verbatim; no caller may log it or repeat it into a file.
 */
export async function readStoredSecretValue(
  directory: string,
  reference: {
    readonly secretId: string;
    readonly namespaceId: string;
    readonly backendRef: { readonly key: string; readonly uid: string };
  },
): Promise<StoredSecretDocument> {
  if (reference.backendRef.key !== STORED_SECRET_KEY) {
    throw new ConfigurationFailure("The staged credential uses an unsupported Secret key.");
  }
  let content: string;
  try {
    content = await readFile(
      storedSecretPath(directory, reference.namespaceId, reference.secretId),
      "utf8",
    );
  } catch {
    // A missing credential is the operator's to fix, and a raw filesystem error would name a path
    // that leads to a credential.
    throw new ConfigurationFailure("The staged credential is not present in Secret storage.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw new ConfigurationFailure("The staged credential storage is malformed.");
  }
  const stored = asRecord(decoded);
  if (
    stored === undefined ||
    !isNonEmptyString(stored.uid) ||
    !isNonEmptyString(stored.namespaceId) ||
    !isNonEmptyString(stored.name) ||
    typeof stored.value !== "string"
  ) {
    throw new ConfigurationFailure("The staged credential storage is malformed.");
  }
  // The reference the platform resolved must still describe this exact document.
  if (stored.uid !== reference.backendRef.uid) {
    throw new OwnershipFailure("The staged credential changed ownership.");
  }
  if (stored.namespaceId !== reference.namespaceId) {
    throw new OwnershipFailure("The staged credential belongs to another Namespace.");
  }
  if (!isNonEmptyString(stored.value)) {
    throw new ConfigurationFailure("The staged credential is empty.");
  }
  return {
    uid: stored.uid,
    namespaceId: stored.namespaceId,
    name: stored.name,
    value: stored.value,
  };
}
