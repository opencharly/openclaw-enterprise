import type {
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";

import { unsupportedNativeGatewayAuthFields } from "../../../gateway/auth-fields.ts";
import { GATEWAY_PASSWORD_ENV, GATEWAY_PASSWORD_REFERENCE } from "../gateway-runtime.ts";
import { ConfigurationFailure } from "./schema.ts";

/**
 * The gateway document a containerised OpenClaw runtime accepts, and whether this Driver
 * must generate the password it authenticates with. Only native password and trusted-proxy
 * gateway authentication are supported; a managed password is generated on the Driver side
 * and delivered through {@link GATEWAY_PASSWORD_ENV}, never through the configuration
 * document.
 */
export function gatewayConfigurationDocument(configuration: OpenClawConfigurationDocument): {
  readonly configuration: OpenClawConfigurationDocument;
  readonly requiresManagedPassword: boolean;
} {
  const gatewayRecord = asRecord(configuration.gateway);
  if (configuration.gateway !== undefined && gatewayRecord === undefined) {
    throw new ConfigurationFailure("containerd native gateway configuration must be an object.");
  }
  const gateway = (gatewayRecord ?? {}) as Record<string, OpenClawConfigurationValue>;
  const authRecord = asRecord(gateway.auth);
  if (gateway.auth !== undefined && authRecord === undefined) {
    throw new ConfigurationFailure("containerd native gateway auth must be an object.");
  }
  const auth = (authRecord ?? {}) as Record<string, OpenClawConfigurationValue>;

  const unsupported = unsupportedNativeGatewayAuthFields(auth);
  if (unsupported.length > 0) {
    throw new ConfigurationFailure(
      `containerd native gateway authentication contains unsupported field ${unsupported[0]}.`,
    );
  }
  const passwordReference =
    auth.password === undefined ? undefined : gatewayPasswordEnvironmentReference(auth.password);
  if (auth.mode === "trusted-proxy") {
    return {
      configuration,
      requiresManagedPassword: passwordReference === GATEWAY_PASSWORD_ENV,
    };
  }
  if (auth.mode !== undefined && auth.mode !== "password") {
    throw new ConfigurationFailure(
      "the containerd Compute Driver supports only native password or trusted-proxy gateway authentication.",
    );
  }

  const useDefaultPassword = auth.password === undefined;
  return {
    configuration: {
      ...configuration,
      gateway: {
        ...gateway,
        auth: {
          ...auth,
          mode: "password",
          ...(useDefaultPassword ? { password: GATEWAY_PASSWORD_REFERENCE } : {}),
        },
      },
    },
    requiresManagedPassword: useDefaultPassword || passwordReference === GATEWAY_PASSWORD_ENV,
  };
}

/** Recognises the reference that resolves to the managed password variable. */
function gatewayPasswordEnvironmentReference(
  value: OpenClawConfigurationValue,
): string | undefined {
  if (value === GATEWAY_PASSWORD_REFERENCE) {
    return GATEWAY_PASSWORD_ENV;
  }
  const record = asRecord(value);
  if (record?.source === "env" && record.id === GATEWAY_PASSWORD_ENV) {
    return GATEWAY_PASSWORD_ENV;
  }
  return undefined;
}
