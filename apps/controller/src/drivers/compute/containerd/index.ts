import type {
  AgentRevision,
  AgentDeploymentDiagnostics,
  AgentRuntimeCredentialStatus,
  AgentRuntimeDescription,
  AgentRuntimeDescribeOptions,
  AgentRuntimeLogChunk,
  AgentRuntimeLogRequest,
  AgentRuntimeLogSource,
  AgentRuntimePodStatus,
  ComputeAgentBinding,
  ComputeAgentRevisionBinding,
  ComputeDriver,
  ComputePreflightResult,
  ComputePrepareRevisionFailureDiagnostic,
  ComputeReadiness,
  ComputeRevisionContext,
  Driver,
  HarnessAuthSnapshot,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  OpenClawConfigurationDocument,
  RevisionHarnessDescriptor,
  RuntimeDiagnosticCheck,
  RuntimeImage,
  SecretBindings,
  WorkspaceSetup,
  CredentialSourceType,
} from "@openclaw-enterprise/contracts";
import { createServer } from "node:net";
import { immutableCopy, sha256Hex, splitModelRef } from "@openclaw-enterprise/utils";
import type { NerdctlHelperExecutor, NerdctlHelperResult } from "./executor.ts";
import { SystemNerdctlHelperExecutor } from "./executor.ts";
import {
  provisionGatewayPassword,
  provisionTransportToken,
  readGatewayPassword,
  readTransportToken,
  removeAgentCredentials,
} from "./credentials.ts";
import { AdmissionFailure, ConfigurationFailure, OwnershipFailure } from "./errors.ts";
import { cpusToCores, memoryToBytes } from "./quantity.ts";
import {
  AGENT_TRANSPORT_PORT,
  CODEX_HOME_DIRECTORY,
  GATEWAY_PORT,
  CONFIGURATION_HASH_LABEL,
  LIMIT_CPUS_LABEL,
  LIMIT_MEMORY_LABEL,
  REVISION_LABEL,
  REVISION_NUMBER_LABEL,
  ROLE_LABEL,
  STATE_DIRECTORY,
  WORKSPACE_DIRECTORY,
  agentContainerName,
  agentContainerSpec,
  egressProxyName,
  egressProxySpec,
  gatewayContainerName,
  gatewayContainerSpec,
  HARNESS_READINESS_COMMAND,
  relayContainerName,
  relaySpec,
  limitLabels,
  networkName,
  oauthSeedContainerName,
  ownershipLabels,
  planeLabels,
  scopeLabels,
  workspaceVolumeLabels,
  workspaceVolumes,
} from "./spec.ts";
import {
  DRIVER_ID,
  DRIVER_IMPLEMENTATION,
  configurationSchema as containerdConfigurationSchema,
  type ContainerdComputeDriverOptions,
  validateConfiguration as validateNerdctlConfiguration,
} from "./schema.ts";
import {
  WORKSPACE_SETUP_FILE,
  workspaceDirectory,
  workspaceSetupScript,
  removeWorkspaceSetupPayload,
  writeWorkspaceSetupPayload,
} from "./workspace.ts";
import type { CodexLoginMode, NativeCodexAuth, OAuthReceipt } from "./oauth.ts";
import {
  CODEX_HOME_ENVIRONMENT,
  OAUTH_SOURCE_UID_ENVIRONMENT,
  OAUTH_VOLUME_UID_ENVIRONMENT,
  OAUTH_SEED_FILE,
  OAUTH_SEED_PATH_ENVIRONMENT,
  claimOAuthLogin,
  codexHomeVolumeUid,
  consumeOAuthLogin,
  nativeCodexAuth,
  oauthLoginState,
  oauthSeedScript,
  readOAuthLogin,
  removeOAuthSeedPayload,
  writeOAuthSeedPayload,
} from "./oauth.ts";
import { gatewayConfigurationDocument } from "./gateway-configuration.ts";
import { readStoredSecretValue } from "./secret-store.ts";
import {
  pollHarnessDeviceAuthorization,
  startHarnessDeviceAuthorization,
} from "../runtime/device-auth.ts";
import { discoverHarnessModels } from "../runtime/model-discovery.ts";
import { AGENT_RUNTIME_ENTRYPOINT } from "../runtime/agent.ts";
import { RUNTIME_WRAPPER_COMMAND } from "../runtime/node-program.ts";
import { nodeProgramArguments } from "../runtime/node-program.ts";
import { GATEWAY_PASSWORD_ENV } from "../runtime/gateway.ts";
import { ComputeLifecycleDispatcher } from "../runtime/lifecycle-hooks.ts";

/** A gateway liveness probe must be cheap: describe runs per console view. */
const GATEWAY_LIVENESS_TIMEOUT_MS = 2_000;

class HelperFailure extends Error {
  // Node runs these modules in strip-only TypeScript mode, which rejects constructor
  // parameter properties, so fields are declared and assigned explicitly.
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/** The helper bounds its own message, so nothing here can grow without limit. */
function failure(error: unknown): "retryable" | "permanent" {
  if (
    error instanceof OwnershipFailure ||
    error instanceof ConfigurationFailure ||
    error instanceof AdmissionFailure
  ) {
    return "permanent";
  }
  if (error instanceof HelperFailure) {
    return error.retryable ? "retryable" : "permanent";
  }
  return "retryable";
}

export interface ContainerdComputeDriverSelection {
  readonly id?: string;
  readonly implementation?: string;
  readonly executor?: NerdctlHelperExecutor;
  readonly lifecycleDrivers?: readonly Driver[];
  /**
   * The selected Secret Driver's store, injected by composition. This Driver reads the staged
   * Codex OAuth login from it, the same way the Kubernetes Compute Driver reads its cluster's
   * Secret API; the operator never repeats the path in `drivers.compute.configuration`.
   */
  readonly secretStore?: { readonly directory: string };
}

export type { ContainerdComputeDriverOptions } from "./schema.ts";

export class ContainerdComputeDriver implements ComputeDriver {
  /** Composition validates the Configuration against this before construction. */
  static readonly configurationSchema = containerdConfigurationSchema;

  static validateConfiguration(configuration: unknown): void {
    validateNerdctlConfiguration(configuration);
  }

  // Device authorization runs against the provider from the control plane, so the Driver
  // adopts the shared flow rather than reaching into a container.
  readonly startHarnessDeviceAuthorization = startHarnessDeviceAuthorization;
  // Model discovery is a provider request from the control plane for the same reason: the
  // runtime is not consulted, so the shared helper serves this Driver unchanged.
  readonly discoverHarnessModels = discoverHarnessModels;
  readonly pollHarnessDeviceAuthorization = pollHarnessDeviceAuthorization;

  readonly id: string;
  readonly implementation: string;
  readonly capability = "compute" as const;
  readonly supportsWorkspaceSetup = true as const;
  // The platform observes and provisions the Agent's gateway credential before admitting a
  // revision, so a replacement container always presents the password its clients hold.
  readonly requiresAgentRuntimeCredentials = true as const;
  readonly runtimeLogging = "driver" as const;
  // The predecessor keeps serving until this revision is verified, so activation must
  // happen before the platform commits the new revision as active.
  readonly activationOrder = "beforeCommit" as const;

  private readonly options: ContainerdComputeDriverOptions;
  private readonly executor: NerdctlHelperExecutor;
  /** The Secret Driver's store, read only to consume a staged Codex OAuth login. */
  private readonly secretStoreDirectory: string | undefined;
  private readonly engine: {
    readonly namespace: string;
    readonly namespaceName: string;
    readonly address?: string;
  };
  private readonly timeoutMs: number;
  private lifecycle: ComputeLifecycleDispatcher;
  private lifecycleStarted = false;

  constructor(
    options: ContainerdComputeDriverOptions,
    selection: ContainerdComputeDriverSelection = {},
  ) {
    ContainerdComputeDriver.validateConfiguration(options);
    this.id = selection.id ?? DRIVER_ID;
    this.implementation = selection.implementation ?? DRIVER_IMPLEMENTATION;
    this.options = immutableCopy(options);
    this.executor = selection.executor ?? new SystemNerdctlHelperExecutor();
    this.lifecycle = new ComputeLifecycleDispatcher(selection.lifecycleDrivers ?? []);
    const storeDirectory = selection.secretStore?.directory;
    if (
      storeDirectory !== undefined &&
      (!storeDirectory.startsWith("/") || storeDirectory.endsWith("/"))
    ) {
      throw new ConfigurationFailure(
        "The injected Secret store directory must be an absolute path without a trailing separator.",
      );
    }
    this.secretStoreDirectory = storeDirectory;
    if (this.id.trim() === "" || this.implementation.trim() === "") {
      throw new ConfigurationFailure("The containerd Compute Driver identity must be configured.");
    }
    this.engine = {
      namespace: this.options.containerd.namespace,
      namespaceName: this.options.containerd.namespace,
      ...(this.options.containerd.address === undefined
        ? {}
        : { address: this.options.containerd.address }),
    };
    this.timeoutMs = this.options.helper.timeoutSeconds * 1000;
  }

  setLifecycleDrivers(drivers: readonly Driver[]): void {
    if (this.lifecycleStarted) {
      throw new Error("Compute lifecycle Drivers cannot change after lifecycle operations begin.");
    }
    this.lifecycle = new ComputeLifecycleDispatcher(drivers);
  }

  /** A revision needs its predecessor stopped before the same volumes are reattached. */
  requiresStoppedPredecessors(): boolean {
    return true;
  }

  async preflight(): Promise<void | ComputePreflightResult> {
    const result = await this.invoke("preflight", {
      images: [this.options.images.gateway, this.options.images.agent],
    });
    const output = asRecord(result.output);
    if (output?.rootless !== true) {
      // The helper only reaches the rootless socket, so a non-rootless answer means the
      // engine it found is not the one this Driver manages.
      throw new ConfigurationFailure("compute-containerd requires the rootless containerd engine.");
    }
    const missing = Object.entries(asRecord(output.images) ?? {})
      .filter(([, state]) => state !== "present")
      .map(([image]) => image);
    return immutableCopy({
      warnings: missing.map((image) => ({
        code: "IMAGE_MISSING",
        message: `image ${image} is not present in the configured engine`,
      })),
    }) as ComputePreflightResult;
  }

  async ensureNamespace(namespace: Namespace): Promise<NamespaceEnsureResult> {
    const result = { namespaceId: namespace.id, namespaceReady: false };
    const created: { readonly name: string; readonly labels: Readonly<Record<string, string>> }[] =
      [];
    try {
      // Every Agent owns an internal plane; only a gateway may join the edge plane.
      const internal = await this.ensureNetwork(namespace.id, "internal", true);
      if (internal.created) {
        created.push(internal);
      }
      const edge = await this.ensureNetwork(namespace.id, "edge", false);
      if (edge.created) {
        created.push(edge);
      }
      // A Namespace that names an egress proxy gets one before its workloads do, so no workload is
      // ever placed on the no-egress plane without a route out.
      await this.ensureEgressProxy(namespace.id);
      await this.lifecycle.afterNamespacePrepared(namespace);
      return { ...result, namespaceReady: true };
    } catch (error) {
      for (const network of created.reverse()) {
        await this.invoke("remove-network", {
          name: network.name,
          expectLabels: network.labels,
        }).catch(() => undefined);
      }
      return { ...result, failure: failure(error) };
    }
  }

  async deleteNamespace(namespace: Namespace): Promise<NamespaceDeleteResult> {
    const result = { namespaceId: namespace.id, namespaceDeleted: false };
    try {
      await this.lifecycle.beforeNamespaceDelete(namespace);
      const ownership = { namespaceId: namespace.id };
      const selector = `${MANAGED_LABEL}=${MANAGED_VALUE},${NAMESPACE_LABEL}=${namespace.id}`;
      const listed = await this.invoke("list-containers", { labelSelector: selector });
      const names = asStringArray(asRecord(listed.output)?.names);
      // Containers first: a network cannot be removed while it still has endpoints, and
      // a volume cannot be removed while a container still holds it.
      for (const name of names) {
        await this.invoke("remove-container", { name, expectLabels: scopeLabels(ownership) });
      }
      await this.invoke("remove-volumes", {
        labelSelector: selector,
        expectLabels: scopeLabels(ownership),
      });
      await this.invoke("remove-network", {
        name: networkName(namespace.id, "edge"),
        expectLabels: planeLabels(namespace.id, "edge"),
      });
      await this.invoke("remove-network", {
        name: networkName(namespace.id, "internal"),
        expectLabels: planeLabels(namespace.id, "internal"),
      });
      return { ...result, namespaceDeleted: true };
    } catch (error) {
      return { ...result, failure: failure(error) };
    }
  }

  /**
   * Operator-managed runtime credentials for the embedded OpenClaw gateway, and the operator's
   * staged provider key or Codex OAuth login for a dedicated Codex Harness. `codex_pat` stays
   * refused: a Backend-issued account token still has no delivery path to exactly one container
   * on this engine.
   */
  validateHarnessAuth(
    harness: RevisionHarnessDescriptor,
    auth: HarnessAuthSnapshot,
    configuration: OpenClawConfigurationDocument,
    _secretBindings?: SecretBindings,
    _credentialSourceType?: CredentialSourceType,
  ): void {
    if (harness.id !== "openclaw" && harness.id !== "codex") {
      throw new ConfigurationFailure(
        "compute-containerd delivers OpenClaw or a dedicated Codex harness.",
      );
    }
    if (harness.id === "codex" && harness.mode !== "dedicated") {
      throw new ConfigurationFailure("A Codex harness is always dedicated.");
    }
    if (harness.id === "openclaw" && harness.mode !== "embedded") {
      throw new ConfigurationFailure("An OpenClaw harness is embedded in its own gateway.");
    }
    if (auth?.method === "api_key") {
      if (harness.id !== "codex" || harness.mode !== "dedicated") {
        throw new ConfigurationFailure(
          "A provider API key is delivered to a dedicated Codex harness only.",
        );
      }
      // The key reaches the harness as the OpenAI provider's environment variable, exactly as
      // the Kubernetes Compute Driver projects its Secret. Another provider's model would be
      // handed the wrong credential, so the admission refuses rather than failing at startup.
      const model = harnessPrimaryModel(configuration);
      const provider = model === undefined ? undefined : splitModelRef(model).provider;
      if (provider !== "openai" && provider !== "codex") {
        throw new ConfigurationFailure(
          "A provider API key requires an openai/ or codex/ primary model.",
        );
      }
      if (this.secretStoreDirectory === undefined) {
        // The key lives in the selected Secret Driver's store; without it this Driver could admit
        // the revision and then be unable to deliver the credential.
        throw new ConfigurationFailure(
          "A provider API key requires the selected Secret Driver's store; select a filesystem Secret Driver.",
        );
      }
      return;
    }
    if (auth?.method === "oauth") {
      if (harness.id !== "codex") {
        throw new ConfigurationFailure("OAuth requires a dedicated Codex harness.");
      }
      if (this.secretStoreDirectory === undefined) {
        // The staged login lives in the selected Secret Driver's store; without it this Driver
        // could admit the revision and then be unable to deliver the credential.
        throw new ConfigurationFailure(
          "OAuth requires the selected Secret Driver's store; select a filesystem Secret Driver.",
        );
      }
      return;
    }
    if (auth?.method === "runtime") {
      if (harness.id === "codex") {
        // A dedicated Codex Harness logs in from a credential this Driver delivers: the shared
        // runtime starts it with CODEX_LOGIN_MODE=api_key, so a runtime revision hands it no key
        // and can only fail. Refuse the configuration instead of retrying it until the budget runs
        // out. The embedded OpenClaw gateway is the harness that authenticates with a runtime
        // credential of its own.
        throw new ConfigurationFailure(
          "A dedicated Codex harness requires a staged provider key or a staged Codex OAuth login.",
        );
      }
      return;
    }
    throw new ConfigurationFailure(
      "compute-containerd requires operator-managed runtime credentials, a staged Codex provider key, or a staged Codex OAuth login.",
    );
  }

  /**
   * prepareRevision delivers the OpenClaw runtime that hosts this revision's harness.
   * The predecessor keeps serving until activation, so this never removes another
   * revision's runtime.
   */
  async prepareRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<ComputeReadiness> {
    const result = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
      ready: false,
    };
    this.lifecycleStarted = true;
    if (!this.accepts(revision)) {
      return result;
    }
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    await this.admitNamespaceBudget(ownership, revision.id);
    const prepared = immutableCopy(revision);
    let launchPrepared = false;
    let created: string | undefined;
    try {
      // Networks and volumes are idempotent, so a retry after a partial deploy converges.
      await this.ensureNetwork(revision.namespaceId, "internal", true);
      await this.ensureNetwork(revision.namespaceId, "edge", false);
      // Storage preparation ensures the volumes, checks their labels and hands ownership
      // to the workload user, so delivery does not ensure them a second time.
      const dedicated = prepared.harness.mode === "dedicated";
      const oauthRequested = dedicated && context?.harnessAuth.method === "oauth";
      const providerKeyRequested = dedicated && context?.harnessAuth.method === "api_key";
      await this.prepareWorkspaceStorage(prepared, context?.workspaceSetup, {
        dedicated,
        oauth: oauthRequested,
      });
      const launch = await this.lifecycle.beforeWorkloadStart(prepared);
      launchPrepared = true;
      // A dedicated harness is its own container, so it starts first and the gateway is told how
      // to reach it. The harness alone receives the workload environment, which is where a model
      // credential travels; the gateway receives the transport endpoint and token instead.
      // An Installation that names an egress proxy gets the enforced topology: its workloads stand
      // on the plane that reaches nothing, and the proxy is their only route out.
      const egress = this.options.egress;
      const planes =
        egress === undefined ? undefined : [networkName(revision.namespaceId, "internal")];
      const proxyEnvironment = this.proxyEnvironment(revision.namespaceId);
      // The operator's staged OAuth login is consumed here, after the lifecycle hook has
      // succeeded, so a rejected delivery never spends it. The bundle reaches only the
      // dedicated Codex volume; the Gateway receives the transport endpoint and token instead.
      const oauth = oauthRequested ? await this.deliverOAuthLogin(prepared, context) : undefined;
      // A staged provider key travels the same way to the same one container: the harness
      // environment, which the gateway never receives.
      const providerKey = providerKeyRequested
        ? await this.deliverProviderKey(prepared, context)
        : undefined;
      const agent =
        prepared.harness.mode === "dedicated"
          ? await this.reconcileAgent(
              prepared,
              { ...launch.environment, ...proxyEnvironment },
              oauth === undefined ? "api_key" : "oauth",
              oauth,
              providerKey,
              planes,
            )
          : undefined;
      const gateway = await this.reconcileGateway(
        prepared,
        {
          ...(agent !== undefined ? agent.environment : launch.environment),
          ...proxyEnvironment,
        },
        { ...(planes === undefined ? {} : { planes }), publish: egress === undefined },
      );
      if (egress !== undefined) {
        // The gateway cannot publish from the no-egress plane, so a relay on both planes carries
        // its port; this is the endpoint the platform hands to clients.
        this.gatewayPorts.set(gatewayKey(prepared), await this.reconcileRelay(prepared));
      }
      created = gateway.created ? gateway.name : undefined;
      return { ...result, ready: gateway.ready };
    } catch (error) {
      const failures: unknown[] = [error];
      if (created !== undefined) {
        try {
          await this.invoke("remove-container", {
            name: created,
            expectLabels: scopeLabels(ownership),
          });
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (launchPrepared) {
        try {
          await this.lifecycle.beforeWorkloadStop(prepared, { cleanup: true });
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "compute-containerd workload preparation and cleanup failed.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  describePrepareRevisionFailure(
    error: unknown,
  ): ComputePrepareRevisionFailureDiagnostic | undefined {
    // Preparation wraps the primary failure in an AggregateError when its cleanup also fails,
    // so the cause that decides retry behavior must be read through that wrapper.
    const failure = primaryPreparationFailure(error);
    if (failure instanceof HelperFailure) {
      return {
        code: failure.code,
        // The platform accepts a lower-case stage without hyphens; a Driver name is not a stage.
        stage: "prepare_revision",
        errorClass: "HelperFailure",
        message: failure.message,
        // Deliberately no permanence: `retryable` is the helper's immediate-retry hint, absent on
        // most failures, and a readiness deadline on a first start clears itself on the next pass.
      };
    }
    if (failure instanceof ConfigurationFailure) {
      return {
        code: "CONTAINERD_CONFIGURATION_INVALID",
        stage: "prepare_revision",
        errorClass: "ConfigurationFailure",
        message: failure.message,
        permanent: true,
      };
    }
    if (failure instanceof OwnershipFailure) {
      return {
        code: "CONTAINERD_OWNERSHIP_CONFLICT",
        stage: "prepare_revision",
        errorClass: "OwnershipFailure",
        message: failure.message,
        permanent: true,
      };
    }
    if (failure instanceof AdmissionFailure) {
      return {
        code: "CONTAINERD_ADMISSION_REFUSED",
        stage: "prepare_revision",
        errorClass: "AdmissionFailure",
        message: failure.message,
        permanent: true,
      };
    }
    return undefined;
  }

  async activateRevision(
    revision: AgentRevision,
    _context?: ComputeRevisionContext,
  ): Promise<void> {
    // An embedded revision runs its harness inside the gateway container, so the gateway is its
    // workload; a dedicated revision runs a separate harness container. Requiring the workload
    // the revision actually has is what keeps an embedded Agent from looking like a failed one.
    const ownership = revisionOwnership(revision);
    const embedded = revision.harness.mode === "embedded";
    const name = embedded
      ? gatewayContainerName(ownership.namespaceId, ownership.agentId ?? "")
      : agentContainerName({ ...ownership });
    const state = await this.inspect(name);
    if (state.running !== true) {
      throw new HelperFailure(
        "UNAVAILABLE",
        embedded ? "the gateway container is not running." : "the Agent container is not running.",
        true,
      );
    }
    await this.lifecycle.beforeWorkloadStart(revision);
  }

  async deactivateRevision(revision: AgentRevision): Promise<void> {
    this.lifecycleStarted = true;
    const ownership = revisionOwnership(revision);
    await this.inspect(
      revision.harness.mode === "embedded"
        ? gatewayContainerName(ownership.namespaceId, ownership.agentId ?? "")
        : agentContainerName({ ...ownership }),
    );
  }

  async stopRevision(revision: AgentRevision): Promise<void> {
    this.lifecycleStarted = true;
    await this.lifecycle.beforeWorkloadStop(revision, { cleanup: false });
    // A revision that never started has nothing to stop: an embedded Agent has no harness
    // container, and a revision stopped before its relay exists has none either. Absence is not a
    // failure, and the engine is asked before the Driver claims otherwise.
    const ownership = revisionOwnership(revision);
    // An embedded revision runs its workload in the gateway container, a dedicated one in its
    // harness container; either way the workload and the relay are what stop.
    const workload =
      revision.harness.mode === "embedded"
        ? ([
            [gatewayContainerName(ownership.namespaceId, ownership.agentId ?? ""), "gateway"],
            [relayContainerName(ownership), "relay"],
          ] as const)
        : ([
            [agentContainerName(ownership), "agent"],
            [relayContainerName(ownership), "relay"],
          ] as const);
    for (const [name, role] of workload) {
      const state = await this.inspect(name);
      if (!state.exists) {
        continue;
      }
      // The gateway container is one per Agent and serves whichever revision is active, so a
      // predecessor's stop must not touch a successor's gateway. Only the revision that owns
      // the running gateway may stop or retire it.
      if (role === "gateway" && state.labels?.[REVISION_LABEL] !== revision.id) {
        continue;
      }
      this.verifyScope(
        state.labels,
        ownershipLabels(revisionOwnership(revision), role),
        `container ${name}`,
      );
      await this.invoke("stop-container", {
        name,
        expectLabels: ownershipLabels(revisionOwnership(revision), role),
        timeoutMs: 10_000,
      });
    }
  }

  async retireRevision(revision: AgentRevision): Promise<void> {
    this.lifecycleStarted = true;
    // Retirement keeps the Agent's volumes: a replacement revision reattaches them.
    await this.lifecycle.beforeWorkloadStop(revision, { cleanup: false });
    const ownership = revisionOwnership(revision);
    // An embedded revision runs its workload in the gateway container, a dedicated one in its
    // harness container; either way the workload and the relay are what retire.
    const workload =
      revision.harness.mode === "embedded"
        ? ([
            [gatewayContainerName(ownership.namespaceId, ownership.agentId ?? ""), "gateway"],
            [relayContainerName(ownership), "relay"],
          ] as const)
        : ([
            [agentContainerName(ownership), "agent"],
            [relayContainerName(ownership), "relay"],
          ] as const);
    for (const [name, role] of workload) {
      const state = await this.inspect(name);
      if (!state.exists) {
        continue;
      }
      // The gateway container is one per Agent and serves whichever revision is active, so a
      // predecessor's stop must not touch a successor's gateway. Only the revision that owns
      // the running gateway may stop or retire it.
      if (role === "gateway" && state.labels?.[REVISION_LABEL] !== revision.id) {
        continue;
      }
      this.verifyScope(
        state.labels,
        ownershipLabels(revisionOwnership(revision), role),
        `container ${name}`,
      );
      await this.invoke("remove-container", {
        name,
        expectLabels: ownershipLabels(revisionOwnership(revision), role),
      });
    }
  }

  async getRuntimeImages(revision: AgentRevision): Promise<readonly RuntimeImage[]> {
    const images: RuntimeImage[] = [];
    for (const role of RUNTIME_ROLES) {
      const state = await this.inspect(this.runtimeContainerName(revisionScope(revision), role));
      if (!state.exists) {
        continue;
      }
      images.push({
        // The gateway hosts embedded OpenClaw; a second container is the Codex Agent.
        workload: role === "gateway" ? "openclaw" : "codex",
        container: role,
        image: state.image,
        imageId: state.imageId === "" ? null : state.imageId,
        commit: null,
        openclawCommit: null,
      });
    }
    return images;
  }

  /**
   * Describes the containers that carry this revision. There is one Pod per container:
   * this engine has no scheduler, so every container runs on the control host and no
   * Kubernetes-style event stream exists. Each entry is therefore reported as `control`
   * with an empty `events` list rather than an invented one.
   */
  async describeAgentRuntime(
    binding: ComputeAgentRevisionBinding,
    _signal: AbortSignal,
    _options?: AgentRuntimeDescribeOptions,
  ): Promise<AgentRuntimeDescription> {
    const observedAt = new Date().toISOString();
    const pods: AgentRuntimePodStatus[] = [];
    const sources: AgentRuntimeLogSource[] = [];
    for (const role of RUNTIME_ROLES) {
      const name = this.runtimeContainerName(revisionScope(binding), role);
      const state = await this.inspect(name);
      if (!state.exists) {
        continue;
      }
      const uid = state.containerId === "" ? name : state.containerId;
      const ready = await this.runtimeReady(role, state);
      pods.push({
        role,
        cluster: "control",
        name,
        uid,
        phase: runtimePhase(state.running === true, state.exitCode),
        ready,
        createdAt: null,
        containers: [
          {
            name: role,
            state: state.running === true ? "running" : "terminated",
            // The engine's own rendering of the container ("Exited (3)"), reported as it is
            // rather than translated into a vocabulary containerd does not produce.
            reason: state.running === true ? null : (state.health ?? null),
            ready,
            restartCount: 0,
            startedAt: null,
            lastTermination:
              state.running === true
                ? null
                : {
                    reason: state.health ?? null,
                    exitCode: state.exitCode ?? 0,
                    finishedAt: null,
                  },
          },
        ],
        events: [],
      });
      sources.push({
        id: role,
        kind: "container",
        pods: [{ name, uid, container: role, restartCount: 0 }],
        available: true,
        // Container output is read back from the engine's log store, not buffered here.
        retention: "engine",
      });
    }
    return { revisionId: binding.revision.id, observedAt, pods, sources };
  }

  /** Bounded container output. This engine retains no previous container's output. */
  async readAgentRuntimeLogs(
    binding: ComputeAgentRevisionBinding,
    request: AgentRuntimeLogRequest,
  ): Promise<AgentRuntimeLogChunk> {
    if (request.previous === true) {
      throw new HelperFailure(
        "NOT_FOUND",
        "Previous container output is not retained on this engine.",
        false,
      );
    }
    const name = this.runtimeContainerName(revisionScope(binding), request.source);
    const state = await this.inspect(name);
    if (!state.exists) {
      throw new HelperFailure(
        "NOT_FOUND",
        `No ${request.source} runtime exists for this revision.`,
        false,
      );
    }
    const result = await this.invoke("read-logs", {
      name,
      expectLabels: this.agentScope(binding),
      lines: request.tailLines,
      limitBytes: request.limitBytes,
    });
    const output = asRecord(result.output) ?? {};
    return {
      stream: {
        source: request.source,
        pod: request.pod,
        podUid: request.podUid,
        container: request.container,
        restartCount: 0,
      },
      observedAt: new Date().toISOString(),
      lines: asStringArray(output.lines).map((raw) => ({ time: null, raw })),
      truncated: output.truncated === true,
    };
  }

  /** Reports whether each expected container of this revision is present and running. */
  async diagnoseAgentDeployment(
    binding: ComputeAgentRevisionBinding,
  ): Promise<AgentDeploymentDiagnostics> {
    const observedAt = new Date().toISOString();
    const checks: RuntimeDiagnosticCheck[] = [];
    for (const role of RUNTIME_ROLES) {
      const state = await this.inspect(this.runtimeContainerName(revisionScope(binding), role));
      if (!state.exists) {
        continue;
      }
      const running = state.running === true;
      checks.push({
        component: role,
        check: "container-running",
        state: running ? "succeeded" : "failed",
        checkedAt: observedAt,
        ...(running ? {} : { code: `EXIT_${String(state.exitCode ?? 0)}` }),
      });
      checks.push({
        component: role,
        check: "readiness",
        state: running ? "succeeded" : "unknown",
        checkedAt: observedAt,
      });
    }
    if (checks.length === 0) {
      checks.push({
        component: "runtime",
        check: "container-present",
        state: "failed",
        checkedAt: observedAt,
        code: "NO_CONTAINER",
      });
    }
    return { revisionId: binding.revision.id, observedAt, checks };
  }

  /**
   * The transport is configured when this Agent's gateway credential exists. It is deliberately
   * not tied to a running container: a stopped or retired revision keeps its credential, and the
   * platform would otherwise demand an operator restore it before the next deployment.
   */
  async getAgentRuntimeCredentialStatus(
    binding: ComputeAgentBinding,
  ): Promise<AgentRuntimeCredentialStatus> {
    const ownership = { namespaceId: binding.namespace.id, agentId: binding.agent.id };
    const directory = this.options.credentials.directory;
    const password = await readGatewayPassword(directory, ownership);
    if (password === undefined) {
      return { transportConfigured: false };
    }
    if (binding.agent.executionMode !== "dedicated") {
      // An embedded runtime is its own transport; there is no separate token to hold.
      return { transportConfigured: true };
    }
    // A dedicated harness presents a token of its own, and so does the gateway that reaches it.
    const token = await readTransportToken(directory, ownership);
    return { transportConfigured: token !== undefined };
  }

  /**
   * Creates the Agent's gateway credential when it is missing and preserves the existing value.
   * The Kubernetes Driver proves the same contract with an Agent-owned Secret.
   */
  async provisionAgentRuntimeCredentials(
    binding: ComputeAgentBinding,
  ): Promise<AgentRuntimeCredentialStatus> {
    this.lifecycleStarted = true;
    const ownership = { namespaceId: binding.namespace.id, agentId: binding.agent.id };
    const directory = this.options.credentials.directory;
    await provisionGatewayPassword(directory, ownership);
    if (binding.agent.executionMode === "dedicated") {
      await provisionTransportToken(directory, ownership);
    }
    return { transportConfigured: true };
  }

  getGatewayEndpoint(revision: AgentRevision): string | undefined {
    const port = this.gatewayPorts.get(gatewayKey(revision));
    return port === undefined ? undefined : `ws://127.0.0.1:${String(port)}/`;
  }

  async deleteAgentRuntimeCredentials(binding: ComputeAgentBinding): Promise<void> {
    this.lifecycleStarted = true;
    const ownership = { namespaceId: binding.namespace.id, agentId: binding.agent.id };
    const selector = `${MANAGED_LABEL}=${MANAGED_VALUE},${AGENT_LABEL}=${binding.agent.id}`;
    // The Agent is being deleted, so every container it owns goes before its storage does: a
    // volume cannot be removed while a container still holds it, and a gateway left behind makes
    // the deletion retry until the platform gives up.
    const listed = await this.invoke("list-containers", { labelSelector: selector });
    for (const name of asStringArray(asRecord(listed.output)?.names) ?? []) {
      const state = await this.inspect(name);
      if (!state.exists) {
        continue;
      }
      this.verifyScope(state.labels, scopeLabels(ownership), `container ${name}`);
      if (state.running === true) {
        await this.invoke("stop-container", {
          name,
          expectLabels: scopeLabels(ownership),
          timeoutMs: 10_000,
        });
      }
      await this.invoke("remove-container", { name, expectLabels: scopeLabels(ownership) });
    }
    await this.invoke("remove-volumes", {
      labelSelector: selector,
      expectLabels: scopeLabels(ownership),
    });
    await removeAgentCredentials(this.options.credentials.directory, ownership);
    this.gatewayPorts.delete(`${binding.namespace.id}/${binding.agent.id}`);
  }

  /** Published loopback ports recorded when a gateway is prepared. */
  private readonly gatewayPorts = new Map<string, number>();

  /**
   * initializeWorkspace seeds the Agent's managed storage once, in a container that holds
   * only the workspace volumes, runs without a network, and is removed whatever happens.
   */
  private async prepareWorkspaceStorage(
    revision: Readonly<AgentRevision>,
    setup: Readonly<WorkspaceSetup> | undefined,
    harness: { readonly dedicated: boolean; readonly oauth: boolean },
  ): Promise<void> {
    if (
      setup !== undefined &&
      (setup.namespaceId !== revision.namespaceId || setup.agentId !== revision.agentId)
    ) {
      throw new OwnershipFailure("Workspace setup must belong to the exact Agent.");
    }
    const workspace = workspaceDirectory(revision);
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const expected = scopeLabels(ownership);
    const volumes = workspaceVolumes(ownership);

    const volumeLabels = workspaceVolumeLabels(ownership);
    // A dedicated Harness owns a Codex home of its own; an embedded runtime runs inside the
    // Gateway and needs none.
    const names = harness.dedicated
      ? [volumes.state, volumes.workspace, volumes.codexHome]
      : [volumes.state, volumes.workspace];
    for (const name of names) {
      const volume = await this.invoke("ensure-volume", { name, labels: volumeLabels });
      const labels = asRecord(asRecord(volume.output)?.labels);
      if (labels === undefined || labels[ROLE_LABEL] !== "workspace") {
        // A volume with this name but another purpose would be seeded by accident.
        throw new OwnershipFailure("Refusing unrelated workspace storage.");
      }
    }

    // The payload is staged in a unique driver-owned directory and removed with the initializer:
    // it is transient, owner-only, and the container mounts it read-only.
    const payload = setup === undefined ? undefined : await writeWorkspaceSetupPayload(setup);
    const payloadMounts =
      payload === undefined
        ? []
        : [
            {
              source: payload.directory,
              target: "/run/oce",
              readOnly: true,
            },
          ];
    const name = `${gatewayContainerName(revision.namespaceId, revision.agentId)}-setup`;
    const existing = await this.inspect(name);
    if (existing.exists) {
      this.verifyScope(existing.labels, expected, `container ${name}`);
      if (existing.running === true) {
        throw new HelperFailure("CONFLICT", "Workspace initialization is already running.", false);
      }
      await this.invoke("remove-container", { name, expectLabels: expected });
    }

    try {
      const result = await this.invoke(
        "run-to-completion",
        {
          name,
          image: this.options.images.gateway,
          // The initializer needs no network: it only writes to its own volumes.
          network: "none",
          labels: {
            ...expected,
            [ROLE_LABEL]: "workspace-setup",
            ...limitLabels(this.options.resources.namespace.containerDefaults),
          },
          user: "0:0",
          // The namespace defaults from the Installation bound every container, including
          // this short-lived one.
          limits: this.options.resources.namespace.containerDefaults,
          // The image's entrypoint prepends `node` to a bare argument, so the program is
          // handed to Node explicitly, exactly as the Docker driver does.
          entrypoint: ["node"],
          args: [
            "-e",
            workspaceSetupScript({
              ...(harness.dedicated ? { codexHome: CODEX_HOME_DIRECTORY } : {}),
              // Only the delivery that seeds an OAuth bundle may keep one on the volume.
              clearOauth: harness.dedicated && !harness.oauth,
            }),
          ],
          env: {
            HOME: "/home/node",
            OPENCLAW_STATE_DIR: STATE_DIRECTORY,
            OPENCLAW_EXECUTABLE: "/app/openclaw.mjs",
            ...(payload === undefined
              ? {}
              : { OPENCLAW_WORKSPACE_SETUP_PATH: `/run/oce/${WORKSPACE_SETUP_FILE}` }),
            OPENCLAW_WORKSPACE_DIR: workspace,
          },
          // Root is needed only to hand the volumes to the workload user.
          capDrop: ["ALL"],
          capAdd: ["CHOWN", "SETUID", "SETGID", "FOWNER"],
          noNewPrivileges: true,
          mounts: [
            { volume: volumes.state, target: STATE_DIRECTORY },
            { volume: volumes.workspace, target: WORKSPACE_DIRECTORY },
            ...(harness.dedicated
              ? [{ volume: volumes.codexHome, target: CODEX_HOME_DIRECTORY }]
              : []),
            ...payloadMounts,
          ],
          exitDeadlineMs: 120_000,
        },
        undefined,
      );
      // The helper omits a zero exit code, so an absent field means success.
      const exitCode = Number(asRecord(result.output)?.exitCode ?? 0);
      if (exitCode !== 0) {
        throw new HelperFailure("INTERNAL", "Workspace initialization failed.", true);
      }
    } finally {
      await this.invoke("remove-container", { name, expectLabels: expected }).catch(
        () => undefined,
      );
      if (payload !== undefined) {
        await removeWorkspaceSetupPayload(payload.directory);
      }
    }
  }

  /** A revision this Driver does not own is never reported ready. */
  private accepts(revision: Readonly<AgentRevision>): boolean {
    if (
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation
    ) {
      return false;
    }
    if (
      revision.configurationKind !== "agent" ||
      !Number.isSafeInteger(revision.revision) ||
      revision.revision < 1 ||
      !Number.isSafeInteger(revision.configurationGeneration) ||
      revision.configurationGeneration < 1
    ) {
      throw new ConfigurationFailure("AgentRevision Configuration ownership is invalid.");
    }
    return true;
  }

  /**
   * reconcileGateway converges the OpenClaw runtime for this Agent. A newer revision owns
   * the gateway until it is retired, and an immutable revision keeps its configuration.
   */
  /**
   * Starts the dedicated harness for one revision and returns the transport environment its
   * gateway needs. The harness is revision-scoped, unlike the Agent-scoped gateway: the platform
   * activates one revision at a time, and a retired revision takes its own harness with it.
   */
  private async reconcileAgent(
    revision: Readonly<AgentRevision>,
    workloadEnvironment: Readonly<Record<string, string>>,
    loginMode: CodexLoginMode,
    oauth: OAuthReceipt | undefined,
    providerKey: string | undefined,
    planes?: readonly string[],
  ): Promise<{
    readonly environment: Readonly<Record<string, string>>;
  }> {
    const ownership = revisionOwnership(revision);
    const expected = ownershipLabels(ownership, "agent");
    const name = agentContainerName(ownership);
    const configurationJson = JSON.stringify(
      gatewayConfigurationDocument(revision.configuration).configuration,
    );
    const configurationHash = sha256Hex(configurationJson, 32);

    // One token for two roles: the harness presents it and the gateway presents the same value,
    // so a replacement keeps the authenticated channel its peer is holding.
    const token = await provisionTransportToken(this.options.credentials.directory, {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
    });

    const existing = await this.inspect(name);
    if (existing.exists) {
      this.verifyScope(existing.labels, expected, `container ${name}`);
      if (existing.running === true) {
        return { environment: this.transportEnvironment(name, token) };
      }
      await this.invoke("remove-container", { name, expectLabels: expected });
    }

    const spec = agentContainerSpec({
      ownership,
      image: this.options.images.agent,
      // The harness program is ~135 KB, above Linux's 128 KiB limit for one exec argument, so
      // passing it as a single `-e` value fails with E2BIG before Node ever starts. It travels
      // compressed in bounded pieces after the repository's fixed loader, under tini, exactly as
      // the Kubernetes Harness runs it.
      entrypoint: [RUNTIME_WRAPPER_COMMAND[0]!],
      args: [
        ...RUNTIME_WRAPPER_COMMAND.slice(1),
        ...nodeProgramArguments(AGENT_RUNTIME_ENTRYPOINT),
      ],
      env: {
        HOME: "/home/node",
        PATH: "/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        APP_SERVER_PORT: String(AGENT_TRANSPORT_PORT),
        APP_SERVER_TOKEN: token,
        CODEX_HOME: CODEX_HOME_DIRECTORY,
        CODEX_LOGIN_MODE: loginMode,
        // The provider key this harness logs in with. The Kubernetes Compute Driver projects
        // the same Secret as this exact environment variable into the same one container; the
        // shared runtime reads it, logs in, and deletes it from the process environment before
        // it serves. The gateway receives the transport endpoint and token instead.
        ...(providerKey === undefined ? {} : { OPENAI_API_KEY: providerKey }),
        // The shared runtime logs in from the seeded bundle and refuses a receipt that names
        // another staged login or another Codex home.
        ...(oauth === undefined
          ? {}
          : {
              [OAUTH_SOURCE_UID_ENVIRONMENT]: oauth.sourceUid,
              [OAUTH_VOLUME_UID_ENVIRONMENT]: oauth.volumeUid,
            }),
        LOG_FORMAT: "json",
        ...(this.harnessModel(revision) === undefined
          ? {}
          : { OPENCLAW_HARNESS_MODEL: this.harnessModel(revision) as string }),
        ...workloadEnvironment,
      },
      ...(planes === undefined ? {} : { networks: planes }),
      configurationHash,
      limits: this.options.resources.agent,
      readiness: {
        // The image's entrypoint prepends `node`, so the probe program is handed to Node. The
        // helper runs the probe with a fixed minimal environment, so it checks the Codex
        // app-server's own local readiness instead of the shared entrypoint, which needs the
        // container's variables and its module path.
        command: [...HARNESS_READINESS_COMMAND],
        intervalMs: 2_000,
        timeoutMs: 5_000,
        deadlineMs: 120_000,
      },
    });
    await this.invoke("run-container", { ...spec }, spec.readiness?.deadlineMs);
    return { environment: this.transportEnvironment(name, token) };
  }

  /**
   * Reads the operator's staged provider key for a dedicated Codex harness.
   *
   * The platform resolves the Agent's Harness Secret and hands this Driver only the reference it
   * resolved, so the key is read from the selected Secret Driver's store under the same ownership
   * proof as the OAuth login: the document must still carry the uid the platform resolved and
   * belong to this revision's Namespace. The value is handed straight to the harness container
   * environment and nowhere else — never argv, a log line, a file, or the Gateway container — and
   * the shared runtime deletes it from its process environment before it serves.
   */
  private async deliverProviderKey(
    revision: Readonly<AgentRevision>,
    context: ComputeRevisionContext | undefined,
  ): Promise<string> {
    const directory = this.secretStoreDirectory;
    const auth = context?.harnessAuth;
    if (directory === undefined || auth?.method !== "api_key") {
      throw new ConfigurationFailure(
        "Provider key delivery requires the selected Secret Driver's store.",
      );
    }
    const namespaceId = requiredText(revision.namespaceId, "AgentRevision Namespace ID");
    const stored = await readStoredSecretValue(directory, {
      secretId: requiredText(auth.source.id, "provider key Secret ID"),
      namespaceId,
      backendRef: {
        key: requiredText(auth.backendRef.key, "provider key Secret key"),
        uid: requiredText(auth.backendRef.uid, "provider key Secret UID"),
      },
    });
    return requiredText(stored.value, "provider key value");
  }

  /**
   * Consumes the operator's staged Codex OAuth login and seeds the dedicated Codex volume.
   *
   * The login is read from the selected Secret Driver's store (composition injects its root),
   * reserved for this Agent and Codex home, written into the harness's CODEX_HOME through a
   * one-shot seeder that mounts the bundle read-only, and then irreversibly replaced by a
   * consumed marker. The bundle never reaches an environment variable, argv, a log line, the
   * Gateway container or the controller's API.
   */
  private async deliverOAuthLogin(
    revision: Readonly<AgentRevision>,
    context: ComputeRevisionContext | undefined,
  ): Promise<OAuthReceipt> {
    const directory = this.secretStoreDirectory;
    const auth = context?.harnessAuth;
    if (directory === undefined || auth?.method !== "oauth") {
      throw new ConfigurationFailure("OAuth delivery requires the selected Secret Driver's store.");
    }
    const ownership = revisionOwnership(revision);
    const namespaceId = requiredText(revision.namespaceId, "AgentRevision Namespace ID");
    const agentId = requiredText(revision.agentId, "AgentRevision Agent ID");
    const login = await readOAuthLogin(directory, {
      secretId: requiredText(auth.source.id, "OAuth login Secret ID"),
      namespaceId,
      backendRef: {
        name: requiredText(auth.backendRef.name, "OAuth login Secret name"),
        key: requiredText(auth.backendRef.key, "OAuth login Secret key"),
        uid: requiredText(auth.backendRef.uid, "OAuth login Secret UID"),
      },
    });
    const volumeUid = codexHomeVolumeUid(namespaceId, agentId);
    const state = oauthLoginState(login, namespaceId, agentId, volumeUid);
    const receipt: OAuthReceipt = { sourceUid: login.uid, volumeUid };
    if (state === "consumed") {
      // The bundle is already on this Agent's own Codex volume and the staged copy is spent.
      return receipt;
    }
    if (state === "fresh") {
      await claimOAuthLogin(directory, login, agentId, volumeUid);
    }
    const bundle = nativeCodexAuth(login, namespaceId, agentId);
    await this.seedCodexHome(ownership, bundle, receipt);
    await consumeOAuthLogin(directory, login, namespaceId, agentId, volumeUid);
    return receipt;
  }

  /** Runs the one-shot seeder that owns the only copy of the bundle on the Codex volume. */
  private async seedCodexHome(
    ownership: {
      readonly namespaceId: string;
      readonly agentId: string;
      readonly revisionId: string;
    },
    bundle: NativeCodexAuth,
    receipt: OAuthReceipt,
  ): Promise<void> {
    const volumes = workspaceVolumes(ownership);
    const expected = ownershipLabels(ownership, "oauth-seed");
    const name = oauthSeedContainerName(ownership);
    const existing = await this.inspect(name);
    if (existing.exists) {
      this.verifyScope(existing.labels, expected, `container ${name}`);
      if (existing.running === true) {
        throw new HelperFailure("CONFLICT", "OAuth seeding is already running.", false);
      }
      await this.invoke("remove-container", { name, expectLabels: expected });
    }
    // The bundle is staged in a unique Driver-owned directory and removed with the seeder: it is
    // transient, owner-only, and the container mounts it read-only.
    const payload = await writeOAuthSeedPayload(bundle);
    try {
      const result = await this.invoke(
        "run-to-completion",
        {
          name,
          image: this.options.images.agent,
          // The seeder needs no network: it only writes to its own volume.
          network: "none",
          labels: {
            ...expected,
            ...limitLabels(this.options.resources.namespace.containerDefaults),
          },
          // Root is needed only to hand the files to the workload user, exactly as the
          // workspace initializer does.
          user: "0:0",
          limits: this.options.resources.namespace.containerDefaults,
          entrypoint: ["node"],
          args: ["-e", oauthSeedScript()],
          env: {
            HOME: "/home/node",
            [CODEX_HOME_ENVIRONMENT]: CODEX_HOME_DIRECTORY,
            [OAUTH_SEED_PATH_ENVIRONMENT]: `/run/oce/${OAUTH_SEED_FILE}`,
            [OAUTH_SOURCE_UID_ENVIRONMENT]: receipt.sourceUid,
            [OAUTH_VOLUME_UID_ENVIRONMENT]: receipt.volumeUid,
          },
          // The seeder hands the bundle to the workload user and clears an earlier login from
          // a Codex home that user owns, so it needs CHOWN and DAC_OVERRIDE for that handover.
          // It holds no other capability, has no network, and mounts only the Codex volume and
          // the Driver-owned seed file; the alternative would be a credential readable by
          // every local user while the seeder runs.
          capDrop: ["ALL"],
          capAdd: ["CHOWN", "DAC_OVERRIDE"],
          noNewPrivileges: true,
          readOnlyRootfs: true,
          mounts: [
            { volume: volumes.codexHome, target: CODEX_HOME_DIRECTORY },
            { source: payload.directory, target: "/run/oce", readOnly: true },
          ],
          exitDeadlineMs: 120_000,
        },
        undefined,
      );
      const exitCode = Number(asRecord(result.output)?.exitCode ?? 0);
      if (exitCode !== 0) {
        throw new HelperFailure("INTERNAL", "OAuth seeding failed.", true);
      }
    } finally {
      await this.invoke("remove-container", { name, expectLabels: expected }).catch(
        () => undefined,
      );
      await removeOAuthSeedPayload(payload.directory);
    }
  }

  /** The model the harness is asked to serve, as the configuration states it. */
  private harnessModel(revision: Readonly<AgentRevision>): string | undefined {
    return harnessPrimaryModel(revision.configuration);
  }

  /**
   * The endpoint and token a gateway uses to reach this harness. The name resolves on the
   * Agent's own network, and the token is the harness's, not the model credential.
   */
  private transportEnvironment(name: string, token: string): Readonly<Record<string, string>> {
    return {
      APP_SERVER_URL: `ws://${name}:${String(AGENT_TRANSPORT_PORT)}`,
      APP_SERVER_TOKEN: token,
    };
  }

  private async reconcileGateway(
    revision: Readonly<AgentRevision>,
    launchEnvironment: Readonly<Record<string, string>>,
    options: { readonly planes?: readonly string[]; readonly publish?: boolean } = {},
  ): Promise<{ readonly name: string; readonly created: boolean; readonly ready: boolean }> {
    // The gateway is Agent-scoped: it serves whichever revision is active, so ownership is
    // proven at Agent scope while the revision labels record who created it.
    const expected = scopeLabels({ namespaceId: revision.namespaceId, agentId: revision.agentId });
    const name = gatewayContainerName(revision.namespaceId, revision.agentId);
    // The runtime authenticates with a generated password, never with a value taken from
    // the configuration document stored in the revision.
    const gatewayConfiguration = gatewayConfigurationDocument(revision.configuration);
    const configurationJson = JSON.stringify(gatewayConfiguration.configuration);
    const configurationHash = sha256Hex(configurationJson, 32);
    const key = `${revision.namespaceId}/${revision.agentId}`;

    const existing = await this.inspect(name);
    if (existing.exists) {
      this.verifyScope(existing.labels, expected, `container ${name}`);
      const currentNumber = Number(existing.labels?.[REVISION_NUMBER_LABEL] ?? "");
      const currentRevision = existing.labels?.[REVISION_LABEL];
      if (
        !Number.isSafeInteger(currentNumber) ||
        currentNumber < 1 ||
        currentRevision === undefined
      ) {
        throw new OwnershipFailure(`Refusing an unlabelled gateway ${name}.`);
      }
      if (currentNumber > revision.revision) {
        // A newer revision is serving; this one must not displace it.
        return { name, created: false, ready: false };
      }
      if (currentNumber === revision.revision && currentRevision === revision.id) {
        const currentHash = existing.labels?.[CONFIGURATION_HASH_LABEL];
        if (currentHash !== configurationHash) {
          throw new ConfigurationFailure(
            "Immutable AgentRevision gateway configuration cannot change.",
          );
        }
        if (existing.running === true) {
          const port = publishedPortFrom(existing.ports);
          if (port === undefined) {
            // A running gateway whose binding cannot be read would give the platform an
            // endpoint it cannot reach, so it is replaced rather than reused.
            await this.invoke("remove-container", { name, expectLabels: expected });
          } else {
            this.gatewayPorts.set(key, port);
            return { name, created: false, ready: true };
          }
        }
      }
      await this.invoke("remove-container", { name, expectLabels: expected });
    }

    const publish = options.publish ?? true;
    const publishedPort = publish ? await freeLoopbackPort() : undefined;
    const spec = gatewayContainerSpec({
      ownership: {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        revisionNumber: revision.revision,
      },
      image: this.options.images.gateway,
      configurationJson,
      configurationHash,
      harnessVersion: revision.harness.version,
      ...(publishedPort === undefined ? {} : { publishedPort }),
      ...(options.planes === undefined ? {} : { networks: options.planes }),
      // The Installation's limits, converted once at validation; the engine enforces them.
      limits: this.options.resources.gateway,
      environment: {
        ...launchEnvironment,
        ...(gatewayConfiguration.requiresManagedPassword
          ? {
              // The Agent's own persisted credential: a replacement container must present the
              // same password, so this is never generated fresh at delivery time.
              [GATEWAY_PASSWORD_ENV]: await provisionGatewayPassword(
                this.options.credentials.directory,
                { namespaceId: revision.namespaceId, agentId: revision.agentId },
              ),
            }
          : {}),
      },
    });
    // The helper bounds the operation itself; the executor bound stays as a backstop.
    await this.invoke("run-container", { ...spec }, spec.readiness?.deadlineMs);
    if (publishedPort !== undefined) {
      this.gatewayPorts.set(key, publishedPort);
    }
    return { name, created: true, ready: true };
  }

  /**
   * Refuses a delivery that would exceed the tenant budget the Installation declares. The
   * Kubernetes Driver enforces the same budget with a ResourceQuota; this engine has no such
   * object, so the Driver sums what it recorded on the Namespace's containers and decides
   * before it creates anything. A rollout therefore needs budget for both revisions, exactly
   * as a ResourceQuota would demand.
   */
  private async admitNamespaceBudget(
    ownership: { readonly namespaceId: string; readonly agentId: string },
    revisionId: string,
  ): Promise<void> {
    const quota = this.options.resources.namespace.quota;
    const cpuValue = quota["limits.cpu"];
    const memoryValue = quota["limits.memory"];
    if (cpuValue === undefined && memoryValue === undefined) {
      // No budget is declared, so there is nothing to enforce.
      return;
    }
    const cpuCap =
      cpuValue === undefined
        ? undefined
        : cpusToCores("resources.namespace.quota.limits.cpu", cpuValue);
    const memoryCap =
      memoryValue === undefined
        ? undefined
        : memoryToBytes("resources.namespace.quota.limits.memory", memoryValue);

    const selector = `${MANAGED_LABEL}=${MANAGED_VALUE},${NAMESPACE_LABEL}=${ownership.namespaceId}`;
    const listed = await this.invoke("list-containers", { labelSelector: selector });
    const output = asRecord(listed.output);
    const names = asStringArray(output?.names) ?? [];
    const reported = asRecord(output?.labels) ?? {};
    let committedCpus = 0;
    let committedMemory = 0;
    for (const name of names) {
      const labels = asRecord(reported[name]) ?? {};
      if (labels[REVISION_LABEL] === revisionId) {
        // This revision's own containers are replaced, not added.
        continue;
      }
      committedCpus += Number(labels[LIMIT_CPUS_LABEL] ?? 0) || 0;
      committedMemory += Number(labels[LIMIT_MEMORY_LABEL] ?? 0) || 0;
    }

    // The initializer runs beside the gateway, so both are charged to the budget.
    const requestedCpus =
      this.options.resources.gateway.cpus + this.options.resources.namespace.containerDefaults.cpus;
    const requestedMemory =
      this.options.resources.gateway.memoryBytes +
      this.options.resources.namespace.containerDefaults.memoryBytes;
    if (cpuCap !== undefined && committedCpus + requestedCpus > cpuCap) {
      throw new AdmissionFailure(
        `the Namespace budget of ${String(cpuCap)} CPUs leaves no room for ${String(
          committedCpus + requestedCpus,
        )}.`,
      );
    }
    if (memoryCap !== undefined && committedMemory + requestedMemory > memoryCap) {
      throw new AdmissionFailure(
        `the Namespace budget of ${String(memoryCap)} bytes leaves no room for ${String(
          committedMemory + requestedMemory,
        )}.`,
      );
    }
  }

  /**
   * The Namespace's egress proxy: one container standing on the Agent's no-egress plane and on the
   * plane that reaches outside, so it is the workloads' only route out. An Installation that names
   * no proxy image gets no proxy, and its workloads keep the edge plane.
   */
  private async ensureEgressProxy(namespaceId: string): Promise<void> {
    const egress = this.options.egress;
    if (egress === undefined) {
      return;
    }
    const name = egressProxyName(namespaceId);
    const expected = scopeLabels({ namespaceId });
    const existing = await this.inspect(name);
    if (existing.exists) {
      // Adoption is deliberate: a proxy already serving this Namespace is reused, and a container
      // with foreign labels is refused rather than claimed.
      this.verifyScope(existing.labels, expected, `container ${name}`);
      return;
    }
    const spec = egressProxySpec({
      namespaceId,
      image: egress.proxyImage,
      allowlist: egress.allowlist,
      limits: this.options.resources.namespace.containerDefaults,
    });
    await this.invoke("run-container", { ...spec });
  }

  /** The proxy variables a workload needs; empty when the Installation names no proxy. */
  private proxyEnvironment(namespaceId: string): Readonly<Record<string, string>> {
    const egress = this.options.egress;
    if (egress === undefined) {
      return {};
    }
    const url = `http://${egressProxyName(namespaceId)}:${String(egress.port)}`;
    return {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      NO_PROXY: "127.0.0.1,localhost",
    };
  }

  /**
   * The relay that publishes an Agent's gateway port when the gateway stands on the no-egress
   * plane, which cannot publish a port itself. It is the routing layer a cluster would provide
   * from outside the workload.
   */
  private async reconcileRelay(revision: Readonly<AgentRevision>): Promise<number> {
    const ownership = revisionOwnership(revision);
    const expected = ownershipLabels(ownership, "relay");
    const name = relayContainerName(ownership);
    const existing = await this.inspect(name);
    if (existing.exists) {
      this.verifyScope(existing.labels, expected, `container ${name}`);
      const published = publishedPortFrom(existing.ports);
      if (published !== undefined) {
        return published;
      }
      await this.invoke("remove-container", { name, expectLabels: expected });
    }
    const publishedPort = await freeLoopbackPort();
    const spec = relaySpec({
      ownership,
      image: this.options.images.gateway,
      target: `${gatewayContainerName(revision.namespaceId, revision.agentId)}:${String(GATEWAY_PORT)}`,
      publishedPort,
      limits: this.options.resources.namespace.containerDefaults,
    });
    await this.invoke("run-container", { ...spec });
    return publishedPort;
  }

  /** Labels a container must carry for this Driver to consider it its own. */
  private verifyScope(
    labels: Readonly<Record<string, string>> | undefined,
    expected: Readonly<Record<string, string>>,
    description: string,
  ): void {
    for (const [key, value] of Object.entries(expected)) {
      if (labels?.[key] !== value) {
        throw new OwnershipFailure(`Refusing unowned ${description}.`);
      }
    }
  }

  /** The container that runs one runtime role for an exact revision. */
  /**
   * Ready means what this engine can prove. containerd keeps no readiness state for a
   * container: the helper reports the engine's own status rendering ("Up", "Exited (3)"), and
   * the Driver must never compare that against a value the engine does not produce. A gateway
   * is ready when its container runs and its published endpoint answers; a dedicated harness
   * publishes nothing, passed its own readiness probe at delivery, and is therefore ready while
   * it runs.
   */
  private async runtimeReady(
    role: (typeof RUNTIME_ROLES)[number],
    state: { readonly running?: boolean; readonly ports?: Readonly<Record<string, string>> },
  ): Promise<boolean> {
    if (state.running !== true) {
      return false;
    }
    if (role !== "gateway") {
      return true;
    }
    const port = publishedPortFrom(state.ports);
    if (port === undefined) {
      return false;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
        signal: AbortSignal.timeout(GATEWAY_LIVENESS_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      return response.ok;
    } catch {
      // A gateway that does not answer is not ready; the caller needs no error detail.
      return false;
    }
  }

  private runtimeContainerName(scope: RevisionScope, role: (typeof RUNTIME_ROLES)[number]): string {
    if (role === "gateway") {
      return gatewayContainerName(scope.namespaceId, scope.agentId);
    }
    return agentContainerName(scope);
  }

  private agentScope(binding: {
    readonly namespace: { readonly id: string };
    readonly agent: { readonly id: string };
  }): Readonly<Record<string, string>> {
    return scopeLabels({ namespaceId: binding.namespace.id, agentId: binding.agent.id });
  }

  private async ensureNetwork(
    namespaceId: string,
    plane: "internal" | "edge",
    internal: boolean,
  ): Promise<{
    readonly name: string;
    readonly created: boolean;
    readonly labels: Readonly<Record<string, string>>;
  }> {
    const name = networkName(namespaceId, plane);
    const labels = planeLabels(namespaceId, plane);
    const result = await this.invoke("ensure-network", { name, internal, labels });
    return { name, created: asRecord(result.output)?.created === true, labels };
  }

  private async inspect(name: string): Promise<{
    readonly exists: boolean;
    readonly running?: boolean;
    readonly image: string;
    readonly imageId: string;
    readonly containerId: string;
    readonly exitCode?: number;
    readonly health?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly ports?: Readonly<Record<string, string>>;
  }> {
    const result = await this.invoke("inspect-container", { name });
    const output = asRecord(result.output) ?? {};
    return {
      exists: output.exists === true,
      running: output.running === true,
      image: typeof output.image === "string" ? output.image : "",
      imageId: typeof output.imageId === "string" ? output.imageId : "",
      containerId: typeof output.containerId === "string" ? output.containerId : "",
      ...(typeof output.exitCode === "number" ? { exitCode: output.exitCode } : {}),
      ...(typeof output.health === "string" ? { health: output.health } : {}),
      ...(asRecord(output.ports) === undefined
        ? {}
        : { ports: asRecord(output.ports) as Record<string, string> }),
      ...(asRecord(output.labels) === undefined
        ? {}
        : { labels: asRecord(output.labels) as Record<string, string> }),
    };
  }

  private async invoke(
    operation: string,
    input: Readonly<Record<string, unknown>>,
    deadlineMs?: number,
  ): Promise<NerdctlHelperResult & { readonly ok: true }> {
    const result = await this.executor.invoke({
      helperPath: this.options.helper.path,
      engine: this.engine,
      request: {
        operation,
        input,
        ...(deadlineMs === undefined ? {} : { deadlineMs }),
      },
      timeoutMs: this.timeoutMs,
    });
    if (result.ok) {
      return result;
    }
    if (result.error.code === "OWNERSHIP") {
      throw new OwnershipFailure(result.error.message);
    }
    throw new HelperFailure(result.error.code, result.error.message, result.error.retryable);
  }
}

const MANAGED_LABEL = "org.openclaw.enterprise.managed";
const MANAGED_VALUE = "true";
const NAMESPACE_LABEL = "org.openclaw.enterprise.namespace-id";
const AGENT_LABEL = "org.openclaw.enterprise.agent-id";

function revisionOwnership(revision: Readonly<AgentRevision>): {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
} {
  return { namespaceId: revision.namespaceId, agentId: revision.agentId, revisionId: revision.id };
}

function gatewayKey(revision: Readonly<AgentRevision>): string {
  return `${revision.namespaceId}/${revision.agentId}`;
}

/**
 * The helper reports a published port the way nerdctl renders it, for example
 * "127.0.0.1:18099->8080/tcp".
 */
/**
 * The failure that decides retry behavior: preparation aggregates a cleanup failure around the
 * primary one, and a wrapper must not downgrade a permanent refusal into a retry.
 */
function primaryPreparationFailure(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof AggregateError && current.errors.length > 0) {
      current = current.errors[0];
      continue;
    }
    if (current instanceof Error && current.cause !== undefined && current.cause !== current) {
      current = current.cause;
      continue;
    }
    break;
  }
  return current;
}

function publishedPortFrom(
  ports: Readonly<Record<string, string>> | undefined,
): number | undefined {
  const rendered = ports?.published;
  if (rendered === undefined) {
    return undefined;
  }
  const match = /^[^:]*:(\d+)->/.exec(rendered.trim());
  if (match === null) {
    return undefined;
  }
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port > 0 ? port : undefined;
}

/**
 * A loopback port the Driver reserves for the gateway. Rootless publishing needs an
 * explicit host port, so the Driver chooses one rather than asking the engine.
 */
async function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("cannot resolve a free loopback port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

/** The identity every per-revision resource is named and labelled by. */
interface RevisionScope {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
}

/** An AgentRevision names its own scope; a revision binding carries the Agent beside it. */
function revisionScope(
  source:
    | { readonly namespaceId: string; readonly agentId: string; readonly id: string }
    | {
        readonly namespace: { readonly id: string };
        readonly agent: { readonly id: string };
        readonly revision: { readonly id: string };
      },
): RevisionScope {
  // Discriminate on the binding's own shape: an AgentRevision has no `namespace` property,
  // whereas a binding carries the Agent and revision beside the namespace.
  if ("namespace" in source && "agent" in source && "revision" in source) {
    return {
      namespaceId: source.namespace.id,
      agentId: source.agent.id,
      revisionId: source.revision.id,
    };
  }
  return { namespaceId: source.namespaceId, agentId: source.agentId, revisionId: source.id };
}

/** The runtime roles one revision can carry: embedded OpenClaw, or a Codex Agent. */
// The containers this Driver reports and logs for one revision. The relay is not among them: it
// forwards bytes and has no runtime to report on.
const RUNTIME_ROLES = ["gateway", "agent"] as const;

function runtimePhase(running: boolean, exitCode: number | undefined): string {
  if (running) {
    return "Running";
  }
  return (exitCode ?? 0) === 0 ? "Succeeded" : "Failed";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The primary model the harness is asked to serve, as the configuration selects it. Admission
 * reads it to decide which provider credential a dedicated Codex harness can be handed.
 */
function harnessPrimaryModel(configuration: OpenClawConfigurationDocument): string | undefined {
  const agents = asRecord(configuration.agents);
  const defaults = asRecord(agents?.defaults);
  const model = defaults?.model;
  return typeof model === "string" ? model : (asRecord(model)?.primary as string | undefined);
}

function requiredText(value: unknown, description: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationFailure(`${description} is missing.`);
  }
  return value;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}
