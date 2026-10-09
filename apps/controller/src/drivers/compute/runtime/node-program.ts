import { deflateRawSync } from "node:zlib";

/**
 * Upper bound for one program piece. Linux rejects any single exec argument or
 * environment string above 128 KiB (MAX_ARG_STRLEN) with E2BIG, and OpenShell
 * carries a Sandbox's whole command in one environment variable.
 */
const NODE_PROGRAM_PIECE_BYTES = 32 * 1024;

// Runs as `node -e`, which already defines require, module and Buffer as globals.
// Removing the pieces leaves process.argv as a plain `node -e <program>` sees it.
const NODE_PROGRAM_LOADER =
  'require("node:vm").runInThisContext(require("node:zlib").inflateRawSync(' +
  'Buffer.from(process.argv.splice(1).join(""), "base64")).toString("utf8"), { filename: "[eval]" });';

/**
 * Arguments that follow `node -e` to run a controller-rendered program. The
 * program travels compressed in bounded pieces after a fixed loader, so no exec
 * argument outgrows a piece and a Sandbox command carries only the compressed size.
 */
export function nodeProgramArguments(program: string): string[] {
  const encoded = deflateRawSync(program).toString("base64");
  const pieces: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += NODE_PROGRAM_PIECE_BYTES) {
    pieces.push(encoded.slice(offset, offset + NODE_PROGRAM_PIECE_BYTES));
  }
  return [NODE_PROGRAM_LOADER, ...pieces];
}

export const RUNTIME_WRAPPER_COMMAND: readonly string[] = Object.freeze([
  "/usr/bin/tini",
  "-s",
  "-e",
  "143",
  "--",
  "node",
  "-e",
]);

export const SETUP_WRAPPER_COMMAND: readonly string[] = Object.freeze([
  "/usr/bin/tini",
  "-s",
  "--",
  "node",
  "-e",
]);
