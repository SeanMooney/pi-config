import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

import { cursorChildEnvironment } from "./environment.js";
import { modelSelectionMatches, type CursorIntent, type ModelProfile } from "./model-profiles.js";

const MAX_STDERR_CHARS = 16_000;
const MAX_OUTPUT_CHARS = 100_000;
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
  signal?: AbortSignal;
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
}

function appendCapped(current: string, addition: string, limit: number): string {
  const combined = current + addition;
  if (combined.length <= limit) return combined;
  return combined.slice(combined.length - limit);
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
  if (child.exitCode !== null || child.signalCode !== null) return;

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

export async function runCursorDelegation(
  options: CursorDelegationOptions,
): Promise<CursorDelegationResult> {
  if (options.signal?.aborted) throw new Error("Cursor Agent delegation cancelled.");

  await mkdir(options.scratchRoot, { recursive: true });
  const configDir = await mkdtemp(join(options.scratchRoot, "cursor-config-"));
  const args = buildAgentArgs(options.profile, options.policyPluginDir);
  const child = spawn(options.agentCommand ?? "agent", args, {
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
    await stopProcessTree(child);
    await rm(configDir, { recursive: true, force: true });
    throw new Error("Cursor Agent did not expose the required stdio streams.");
  }

  let stderr = "";
  let output = "";
  let truncated = false;
  let sessionId: string | undefined;
  let timedOut = false;
  let stopping: Promise<void> | undefined;
  let cancelSession: (() => void) | undefined;
  const stopChild = () => (stopping ??= stopProcessTree(child));
  const abort = () => {
    cancelSession?.();
    void stopChild();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

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
        const available = MAX_OUTPUT_CHARS - output.length;
        if (available > 0) output += update.content.text.slice(0, available);
        if (update.content.text.length > available) truncated = true;
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
    if (sessionId) {
      void connection.cancel({ sessionId }).catch(() => undefined);
    }
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

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

    const session = await connection.newSession({
      cwd: options.cwd,
      mcpServers: [],
    });
    sessionId = session.sessionId;

    const extendedSession = session as typeof session & {
      models?: { currentModelId?: string };
    };
    const actualModelId = extendedSession.models?.currentModelId;
    if (!actualModelId) {
      throw new Error("Cursor ACP did not report the selected model.");
    }
    if (!modelSelectionMatches(options.profile.cliModelId, actualModelId)) {
      throw new Error(
        `Cursor selected ${actualModelId}, not requested model ${options.profile.cliModelId}.`,
      );
    }

    await connection.setSessionMode({
      sessionId,
      modeId: options.profile.mode,
    });

    const response = await connection.prompt({
      sessionId,
      prompt: [
        {
          type: "text",
          text: delegationPrompt(options.profile.intent, options.task),
        },
      ],
    });

    if (timedOut) throw new Error("Cursor Agent delegation timed out.");
    if (options.signal?.aborted) throw new Error("Cursor Agent delegation cancelled.");
    if (isCursorFailureOutput(output)) {
      throw new Error(
        `Cursor Agent reported a transport or authentication failure: ${output.trim()}`,
      );
    }

    return {
      intent: options.profile.intent,
      modelId: options.profile.cliModelId,
      acpModelId: actualModelId,
      mode: options.profile.mode,
      output,
      stopReason: response.stopReason,
      stderr,
      truncated,
    };
  } catch (error) {
    if (timedOut) throw new Error("Cursor Agent delegation timed out.");
    if (options.signal?.aborted) throw new Error("Cursor Agent delegation cancelled.");
    const message = error instanceof Error ? error.message : String(error);
    const detail = stderr.trim() ? `\nCursor stderr: ${stderr.trim()}` : "";
    throw new Error(`${message}${detail}`);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    await stopChild();
    await rm(configDir, { recursive: true, force: true });
  }
}
