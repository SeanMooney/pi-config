import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { Context, Effect, Exit, Layer } from "effect";

import { cursorChildEnvironment } from "./environment.js";
import { CursorCliError, UnsupportedCursorVersionError } from "./errors.js";
import {
  cursorVersionIsSupported,
  MIN_CURSOR_CLI_VERSION,
  parseModelIds,
} from "./model-catalog.js";

const execFileAsync = promisify(execFile);

export interface CursorCliService {
  readonly assertVersion: (
    agentCommand?: string,
  ) => Effect.Effect<string, CursorCliError | UnsupportedCursorVersionError>;
  readonly listModelIds: (
    scratchRoot: string,
    agentCommand?: string,
  ) => Effect.Effect<ReadonlySet<string>, CursorCliError>;
}

export class CursorCli extends Context.Service<CursorCli, CursorCliService>()(
  "pi-cursor-acp/CursorCli",
) {
  static readonly layer = Layer.succeed(this)({
    assertVersion: (agentCommand = "agent") =>
      Effect.tryPromise({
        try: (signal) => execFileAsync(agentCommand, ["--version"], { signal, timeout: 10_000 }),
        catch: (cause) =>
          new CursorCliError({
            operation: "version",
            cause,
            message: `Unable to query Cursor CLI version: ${causeMessage(cause)}`,
          }),
      }).pipe(
        Effect.flatMap(({ stdout }) => {
          const version = stdout.trim();
          return cursorVersionIsSupported(version)
            ? Effect.succeed(version)
            : Effect.fail(
                new UnsupportedCursorVersionError({
                  actualVersion: version || "unknown",
                  minimumVersion: MIN_CURSOR_CLI_VERSION,
                  message:
                    `Cursor CLI ${version || "unknown"} is unsupported; ` +
                    `version ${MIN_CURSOR_CLI_VERSION} or newer is required.`,
                }),
              );
        }),
      ),

    listModelIds: (scratchRoot, agentCommand = "agent") =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: async () => {
            await mkdir(scratchRoot, { recursive: true });
            return mkdtemp(join(scratchRoot, "model-config-"));
          },
          catch: (cause) =>
            new CursorCliError({
              operation: "models",
              cause,
              message: `Unable to create Cursor model configuration: ${causeMessage(cause)}`,
            }),
        }),
        (configDir) =>
          Effect.tryPromise({
            try: (signal) =>
              execFileAsync(agentCommand, ["models"], {
                env: cursorChildEnvironment(process.env, { CURSOR_CONFIG_DIR: configDir }),
                maxBuffer: 2 * 1024 * 1024,
                signal,
                timeout: 60_000,
              }),
            catch: (cause) =>
              new CursorCliError({
                operation: "models",
                cause,
                message: `Unable to list Cursor models: ${causeMessage(cause)}`,
              }),
          }).pipe(Effect.map(({ stdout }) => parseModelIds(stdout))),
        (configDir, exit) => {
          const cleanup = Effect.tryPromise({
            try: () => rm(configDir, { recursive: true, force: true }),
            catch: (cause) =>
              new CursorCliError({
                operation: "models",
                cause,
                message: `Unable to remove Cursor model configuration: ${causeMessage(cause)}`,
              }),
          });
          return Exit.isFailure(exit)
            ? cleanup.pipe(Effect.catchCause(() => Effect.void))
            : cleanup;
        },
      ),
  });
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
