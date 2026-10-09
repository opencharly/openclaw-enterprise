import { spawn } from "node:child_process";

import { currentComputeAbortSignal } from "../operation-context.ts";

/** The helper answers with one bounded JSON line; keep captured streams small. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const ENVELOPE_VERSION = 1;

/** One helper invocation: a JSON request on stdin, one JSON envelope on stdout. */
export interface NerdctlHelperCall {
  readonly helperPath: string;
  readonly engine: {
    readonly namespace: string;
    readonly namespaceName: string;
    readonly address?: string;
  };
  readonly request: {
    readonly operation: string;
    readonly input?: Readonly<Record<string, unknown>>;
    readonly deadlineMs?: number;
  };
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type NerdctlHelperFailure = {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
};

export type NerdctlHelperResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly error: NerdctlHelperFailure };

/**
 * The seam between the Driver and the host helper. Conformance tests replace it; only
 * tests/integration/nerdctl-compute-real.test.mjs drives the real helper.
 */
export interface NerdctlHelperExecutor {
  invoke(call: NerdctlHelperCall): Promise<NerdctlHelperResult>;
}

export class SystemNerdctlHelperExecutor implements NerdctlHelperExecutor {
  async invoke(call: NerdctlHelperCall): Promise<NerdctlHelperResult> {
    const envelope = JSON.stringify({
      version: ENVELOPE_VERSION,
      operation: call.request.operation,
      engine: {
        namespace: call.engine.namespace,
        namespaceName: call.engine.namespaceName,
        ...(call.engine.address === undefined ? {} : { address: call.engine.address }),
      },
      ...(call.request.deadlineMs === undefined ? {} : { deadlineMs: call.request.deadlineMs }),
      ...(call.request.input === undefined ? {} : { input: call.request.input }),
    });
    const owner = call.signal ?? currentComputeAbortSignal();
    const timeout = AbortSignal.timeout(call.timeoutMs);
    const signal = owner === undefined ? timeout : AbortSignal.any([owner, timeout]);
    signal.throwIfAborted();

    return new Promise<NerdctlHelperResult>((resolve, reject) => {
      // A helper may spawn engine work of its own, so it gets its own process group.
      const child = spawn(call.helperPath, [], { stdio: ["pipe", "pipe", "pipe"], detached: true });
      const stdout: string[] = [];
      const stderr: string[] = [];
      let stdoutBytes = 0;
      let settled = false;
      // Settle exactly once. Guarding on signal.aborted would ignore the abort itself,
      // leaving the caller waiting forever for a helper that was already stopped.
      const settle = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        action();
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes <= MAX_STDOUT_BYTES) {
          stdout.push(chunk);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        // nerdctl writes warnings here; never surface them unbounded.
        if (stderr.join("").length < MAX_STDERR_BYTES) {
          stderr.push(chunk);
        }
      });
      child.on("error", (error) => {
        settle(() => reject(error));
      });
      child.on("close", (code) => {
        settle(() => {
          const envelopeText = stdout.join("").trim();
          if (envelopeText === "") {
            reject(
              new Error(
                `compute-nerdctl helper exited with code ${String(code)} and no response: ${stderr.join("").trim().slice(0, MAX_STDERR_BYTES)}`,
              ),
            );
            return;
          }
          const lines = envelopeText.split("\n");
          const last = lines[lines.length - 1] ?? "";
          let decoded: unknown;
          try {
            decoded = JSON.parse(last);
          } catch (error) {
            reject(
              new Error(`compute-nerdctl helper returned a malformed response: ${String(error)}`),
            );
            return;
          }
          resolve(interpret(decoded));
        });
      });
      signal.addEventListener(
        "abort",
        () => {
          terminate(child);
          settle(() => reject(new Error("compute-nerdctl helper call was aborted or timed out.")));
        },
        { once: true },
      );
      child.stdin.end(envelope);
    });
  }
}

/** terminate stops the helper and everything it started, then releases the pipes. */
function terminate(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

/** interpret maps one decoded envelope onto the executor result. */
function interpret(decoded: unknown): NerdctlHelperResult {
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("compute-nerdctl helper returned a non-object envelope.");
  }
  const envelope = decoded as {
    readonly ok?: unknown;
    readonly output?: unknown;
    readonly error?: unknown;
  };
  if (envelope.ok === true) {
    return { ok: true, output: envelope.output };
  }
  const detail = envelope.error;
  if (typeof detail !== "object" || detail === null) {
    throw new Error("compute-nerdctl helper reported a failure without a detail.");
  }
  const failure = detail as {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly retryable?: unknown;
  };
  return {
    ok: false,
    error: {
      code: typeof failure.code === "string" ? failure.code : "INTERNAL",
      message: typeof failure.message === "string" ? failure.message : "helper failure",
      retryable: failure.retryable === true,
    },
  };
}
