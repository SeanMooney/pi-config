import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { Effect, Exit } from "effect";

import { cursorChildEnvironment } from "./environment.js";
import {
  AcpModelMismatchError,
  AcpProcessError,
  AcpProtocolError,
  CursorReportedFailureError,
  DelegationTimeoutError,
  OutputCaptureError,
  type AcpError,
} from "./errors.js";
import { modelSelectionMatches, type CursorIntent, type ModelProfile } from "./model-profiles.js";

const MAX_STDERR_CHARS = 16_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const PROCESS_EXIT_GRACE_MS = 2_000;
const CURSOR_FAILURE_OUTPUT =
  /^Error:\s*(?:RetriableError|AuthenticationError|Unauthorized|Forbidden|NetworkError|ConnectError)\b/im;

export interface CursorQuestionHandler {
  (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface CursorDelegationOptions {
  cwd: string;
  profile: ModelProfile;
  task: string;
  policyPluginDir: string;
  scratchRoot: string;
  timeoutMs?: number;
  onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  onCursorRequest: CursorQuestionHandler;
  onUpdate?: (text: string) => void;
  agentCommand?: string;
  testEnvironment?: NodeJS.ProcessEnv;
}

export interface CursorDelegationResult {
  intent: CursorIntent;
  modelId: string;
  acpModelId: string;
  mode: "ask" | "agent";
  output: string;
  stopReason: string;
  stderr: string;
  truncated: boolean;
  fullOutputPath?: string;
}

function appendCapped(current: string, addition: string, limit: number): string {
  const combined = current + addition;
  if (combined.length <= limit) return combined;
  return combined.slice(combined.length - limit);
}

function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let prefix = "";
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    prefix += character;
    bytes += characterBytes;
  }
  return prefix;
}

class OutputCapture {
  readonly #scratchRoot: string;
  #preview = "";
  #failureScan = "";
  #fullOutputPath: string | undefined;
  #writes = Promise.resolve();

  constructor(scratchRoot: string) {
    this.#scratchRoot = scratchRoot;
  }

  get preview(): string {
    return this.#preview;
  }

  get failureDiagnostic(): string | undefined {
    return isCursorFailureOutput(this.#failureScan) ? this.#failureScan.trim() : undefined;
  }

  append(text: string): void {
    if (this.#failureScan.length < MAX_STDERR_CHARS) {
      this.#failureScan = (this.#failureScan + text).slice(0, MAX_STDERR_CHARS);
    }
    if (this.#fullOutputPath) {
      this.#writes = this.#writes.then(() => appendFile(this.#fullOutputPath!, text));
      return;
    }

    const combined = this.#preview + text;
    const truncation = truncateHead(combined, {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    });
    this.#preview = truncation.content;
    if (!truncation.truncated) return;
    if (!this.#preview && combined) {
      this.#preview = utf8Prefix(combined, DEFAULT_MAX_BYTES);
    }

    this.#fullOutputPath = join(this.#scratchRoot, `cursor-output-${randomUUID()}.log`);
    this.#writes = writeFile(this.#fullOutputPath, combined, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async finish(): Promise<{
    readonly output: string;
    readonly truncated: boolean;
    readonly fullOutputPath?: string;
  }> {
    try {
      await this.#writes;
    } catch (cause) {
      throw new OutputCaptureError({
        cause,
        message: `Unable to preserve full Cursor output: ${causeMessage(cause)}`,
      });
    }
    return {
      output: this.#preview,
      truncated: this.#fullOutputPath !== undefined,
      fullOutputPath: this.#fullOutputPath,
    };
  }

  async discard(): Promise<void> {
    await this.#writes.catch(() => undefined);
    if (this.#fullOutputPath) {
      await rm(this.#fullOutputPath, { force: true }).catch(() => undefined);
    }
  }
}

export function buildAgentArgs(profile: ModelProfile, policyPluginDir: string): string[] {
  return [
    "--model",
    profile.cliModelId,
    "--sandbox",
    "enabled",
    "--plugin-dir",
    policyPluginDir,
    "acp",
  ];
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function forceKillProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function stopProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

  const waitForExit = (timeoutMs: number) =>
    Promise.race([
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

  killProcessTree(child);
  await waitForExit(PROCESS_EXIT_GRACE_MS);
  if (child.exitCode === null && child.signalCode === null) {
    forceKillProcessTree(child);
    await waitForExit(1_000);
  }
}

export function isCursorFailureOutput(output: string): boolean {
  return CURSOR_FAILURE_OUTPUT.test(output.trim());
}

function delegationPrompt(intent: CursorIntent, task: string): string {
  return [
    `You are acting as a delegated Cursor Agent for ${intent}.`,
    "Complete only the requested task and return a concise, evidence-based result.",
    "Do not spawn subagents. Do not commit, push, publish, or open pull requests.",
    intent === "implement"
      ? "You may edit files in the current workspace, but leave all changes uncommitted."
      : "This is read-only work. Do not modify files or execute commands.",
    "",
    task,
  ].join("\n");
}

interface CursorProcessResource {
  readonly child: ChildProcessWithoutNullStreams;
  readonly configDir: string;
  readonly stop: () => Promise<void>;
}

function waitForSpawn(child: ChildProcess, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.removeListener("spawn", spawned);
      child.removeListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const spawned = () => {
      cleanup();
      resolve();
    };
    const failed = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const aborted = () => {
      cleanup();
      reject(new Error("Cursor Agent delegation cancelled."));
    };
    child.once("spawn", spawned);
    child.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

async function acquireCursorProcess(
  options: CursorDelegationOptions,
  signal: AbortSignal,
): Promise<CursorProcessResource> {
  let configDir: string | undefined;
  let child: ChildProcess | undefined;
  try {
    if (signal.aborted) throw new Error("Cursor Agent delegation cancelled.");
    await mkdir(options.scratchRoot, { recursive: true });
    configDir = await mkdtemp(join(options.scratchRoot, "cursor-config-"));
    if (signal.aborted) throw new Error("Cursor Agent delegation cancelled.");

    const args = buildAgentArgs(options.profile, options.policyPluginDir);
    child = spawn(options.agentCommand ?? "agent", args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: cursorChildEnvironment(process.env, {
        CURSOR_CONFIG_DIR: configDir,
        PI_CURSOR_ACP_WORKSPACE: options.cwd,
        ...(options.agentCommand ? options.testEnvironment : undefined),
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("Cursor Agent did not expose the required stdio streams.");
    }
    await waitForSpawn(child, signal);

    let stopping: Promise<void> | undefined;
    return {
      child: child as ChildProcessWithoutNullStreams,
      configDir,
      stop: () => (stopping ??= stopProcessTree(child!)),
    };
  } catch (cause) {
    if (child) await stopProcessTree(child).catch(() => undefined);
    if (configDir) {
      await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw cause;
  }
}

async function releaseCursorProcess(resource: CursorProcessResource): Promise<void> {
  let failed = false;
  let failure: unknown;
  try {
    await resource.stop();
  } catch (cause) {
    failed = true;
    failure = cause;
  }
  try {
    await rm(resource.configDir, { recursive: true, force: true });
  } catch (cause) {
    if (!failed) failure = cause;
    failed = true;
  }
  if (failed) throw failure;
}

async function runCursorSession(
  options: CursorDelegationOptions,
  signal: AbortSignal,
  resource: CursorProcessResource,
): Promise<CursorDelegationResult> {
  const { child } = resource;
  let stderr = "";
  const outputCapture = new OutputCapture(options.scratchRoot);
  let completed = false;
  let sessionId: string | undefined;
  let cancelSession: (() => void) | undefined;
  const abort = () => {
    cancelSession?.();
    void resource.stop();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  child.stderr.on("data", (data: Buffer | string) => {
    stderr = appendCapped(stderr, data.toString(), MAX_STDERR_CHARS);
  });

  const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const outputStream = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, outputStream);

  const client: Client = {
    requestPermission: options.onPermission,
    sessionUpdate(params: SessionNotification) {
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        outputCapture.append(update.content.text);
        options.onUpdate?.(update.content.text);
      } else if (update.sessionUpdate === "tool_call") {
        options.onUpdate?.(`[Cursor tool] ${update.title}\n`);
      } else if (update.sessionUpdate === "tool_call_update" && update.status) {
        options.onUpdate?.(`[Cursor tool ${update.status}]\n`);
      }
    },
    extMethod: options.onCursorRequest,
    extNotification(method, params) {
      if (method === "cursor/task") {
        options.onUpdate?.("[Blocked Cursor subagent notification]\n");
      } else if (method === "cursor/update_todos") {
        options.onUpdate?.("[Cursor updated its task list]\n");
      }
      void params;
    },
  };

  const connection = new ClientSideConnection(() => client, stream);
  cancelSession = () => {
    if (sessionId) void connection.cancel({ sessionId }).catch(() => undefined);
  };

  try {
    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "pi-cursor-acp", version: "0.1.0" },
    });
    await connection.authenticate({ methodId: "cursor_login" });

    const session = await connection.newSession({ cwd: options.cwd, mcpServers: [] });
    sessionId = session.sessionId;
    const extendedSession = session as typeof session & {
      models?: { currentModelId?: string };
    };
    const actualModelId = extendedSession.models?.currentModelId;
    if (!actualModelId) {
      throw new AcpProtocolError({
        cause: session,
        message: "Cursor ACP did not report the selected model.",
      });
    }
    if (!modelSelectionMatches(options.profile.cliModelId, actualModelId)) {
      throw new AcpModelMismatchError({
        actualModelId,
        requestedModelId: options.profile.cliModelId,
        message:
          `Cursor selected ${actualModelId}, not requested model ` +
          `${options.profile.cliModelId}.`,
      });
    }

    await connection.setSessionMode({ sessionId, modeId: options.profile.mode });
    const response = await connection.prompt({
      sessionId,
      prompt: [
        {
          type: "text",
          text: delegationPrompt(options.profile.intent, options.task),
        },
      ],
    });

    if (signal.aborted) throw new Error("Cursor Agent delegation cancelled.");
    const failureDiagnostic = outputCapture.failureDiagnostic;
    if (failureDiagnostic) {
      throw new CursorReportedFailureError({
        output: failureDiagnostic,
        message:
          "Cursor Agent reported a transport or authentication failure: " + failureDiagnostic,
      });
    }

    const captured = await outputCapture.finish();
    completed = true;
    return {
      intent: options.profile.intent,
      modelId: options.profile.cliModelId,
      acpModelId: actualModelId,
      mode: options.profile.mode,
      output: captured.output,
      stopReason: response.stopReason,
      stderr,
      truncated: captured.truncated,
      fullOutputPath: captured.fullOutputPath,
    };
  } catch (cause) {
    if (signal.aborted) throw new Error("Cursor Agent delegation cancelled.");
    if (isAcpError(cause)) throw cause;
    const detail = stderr.trim() ? `\nCursor stderr: ${stderr.trim()}` : "";
    throw new AcpProtocolError({
      cause,
      message: `${causeMessage(cause)}${detail}`,
    });
  } finally {
    signal.removeEventListener("abort", abort);
    if (!completed) await outputCapture.discard();
  }
}

function runCursorSessionEffect(
  options: CursorDelegationOptions,
  resource: CursorProcessResource,
): Effect.Effect<CursorDelegationResult, AcpError> {
  return Effect.callback((resume, signal) => {
    const session = runCursorSession(options, signal, resource);
    void session.then(
      (result) => resume(Effect.succeed(result)),
      (cause) => resume(Effect.fail(toAcpSessionError(cause))),
    );
    return Effect.promise(() =>
      session.then(
        () => undefined,
        () => undefined,
      ),
    );
  });
}

export function runCursorDelegation(
  options: CursorDelegationOptions,
): Effect.Effect<CursorDelegationResult, AcpError | DelegationTimeoutError> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const operation = Effect.acquireUseRelease(
    Effect.tryPromise({
      try: (signal) => acquireCursorProcess(options, signal),
      catch: toAcpProcessError,
    }),
    (resource) => runCursorSessionEffect(options, resource),
    (resource, exit) => {
      const cleanup = Effect.tryPromise({
        try: () => releaseCursorProcess(resource),
        catch: toAcpProcessError,
      });
      return Exit.isFailure(exit) ? cleanup.pipe(Effect.catchCause(() => Effect.void)) : cleanup;
    },
  );
  return operation.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new DelegationTimeoutError({
            timeoutMs,
            message: "Cursor Agent delegation timed out.",
          }),
        ),
    }),
  );
}

function toAcpProcessError(cause: unknown): AcpProcessError {
  return new AcpProcessError({ cause, message: causeMessage(cause) });
}

function toAcpSessionError(cause: unknown): AcpError {
  return isAcpError(cause) ? cause : new AcpProtocolError({ cause, message: causeMessage(cause) });
}

function isAcpError(cause: unknown): cause is AcpError {
  if (!cause || typeof cause !== "object" || !("_tag" in cause)) return false;
  return [
    "AcpProcessError",
    "AcpProtocolError",
    "AcpModelMismatchError",
    "CursorReportedFailureError",
    "OutputCaptureError",
  ].includes(String(cause._tag));
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
