import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { buildAgentArgs, isCursorFailureOutput, runCursorDelegation } from "../acp-client.js";
import { MODEL_PROFILES } from "../model-profiles.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = join(root, ".tmp", `acp-test-${process.pid}`);
const fakeAgent = join(scratch, "fake-agent.mjs");

function hasTag(tag: string) {
  return (cause: unknown): boolean =>
    Boolean(cause && typeof cause === "object" && "_tag" in cause && cause._tag === tag);
}

const fakeAgentSource = `#!/usr/bin/env node
import readline from "node:readline";
const modelIndex = process.argv.indexOf("--model");
const cliModel = modelIndex >= 0 ? process.argv[modelIndex + 1] : "";
const models = {
  "composer-2.5-fast": "composer-2.5[fast=true]",
  "cursor-grok-4.5-medium-fast": "grok-4.5[effort=medium,fast=true]",
  "cursor-grok-4.5-high-fast": "grok-4.5[effort=high,fast=true]"
};
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [{ id: "cursor_login", name: "Cursor Login" }]
    }});
  } else if (message.method === "authenticate") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId: "fake-session",
      modes: { currentModeId: "agent", availableModes: [] },
      models: {
        currentModelId: process.env.PI_CURSOR_ACP_FAKE_MODEL || models[cliModel],
        availableModels: []
      }
    }});
  } else if (message.method === "session/set_mode") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    const text = process.env.PI_CURSOR_ACP_FAKE_FAILURE === "1"
      ? "Error: RetriableError: network unavailable" + (process.env.PI_CURSOR_ACP_FAKE_OUTPUT || "")
      : process.env.PI_CURSOR_ACP_FAKE_OUTPUT || "verified output";
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "fake-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text }
      }
    }});
    if (process.env.PI_CURSOR_ACP_FAKE_HANG === "1") return;
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`;

test.before(async () => {
  await mkdir(scratch, { recursive: true });
  await writeFile(fakeAgent, fakeAgentSource);
  await chmod(fakeAgent, 0o755);
});

test.after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("builds a sandboxed ACP command", () => {
  assert.deepEqual(buildAgentArgs(MODEL_PROFILES.review, "/policy"), [
    "--model",
    "cursor-grok-4.5-high-fast",
    "--sandbox",
    "enabled",
    "--plugin-dir",
    "/policy",
    "acp",
  ]);
});

test("detects Cursor transport failures returned as message text", () => {
  assert.equal(isCursorFailureOutput("Error: RetriableError: proxy refused connection"), true);
  assert.equal(isCursorFailureOutput("Review finding: network error handling is weak"), false);
});

test("runs one ACP delegation and verifies the selected model", async () => {
  const result = await Effect.runPromise(
    runCursorDelegation({
      cwd: root,
      profile: MODEL_PROFILES.context,
      task: "Inspect context",
      policyPluginDir: join(root, "policy", "plugin"),
      scratchRoot: scratch,
      agentCommand: fakeAgent,
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onCursorRequest: async () => ({ outcome: { outcome: "cancelled" } }),
    }),
  );
  assert.equal(result.output, "verified output");
  assert.equal(result.modelId, "composer-2.5-fast");
  assert.equal(result.acpModelId, "composer-2.5[fast=true]");
  assert.equal(result.mode, "ask");
  assert.equal(result.stopReason, "end_turn");
});

test("preserves a UTF-8 preview and private spill file for one oversized line", async () => {
  const fullOutput = "😀".repeat(Math.ceil(DEFAULT_MAX_BYTES / 4) + 1_000);
  const result = await Effect.runPromise(
    runCursorDelegation({
      cwd: root,
      profile: MODEL_PROFILES.context,
      task: "Produce large output",
      policyPluginDir: join(root, "policy", "plugin"),
      scratchRoot: scratch,
      agentCommand: fakeAgent,
      testEnvironment: { PI_CURSOR_ACP_FAKE_OUTPUT: fullOutput },
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onCursorRequest: async () => ({ outcome: { outcome: "cancelled" } }),
    }),
  );

  assert.equal(result.truncated, true);
  assert.ok(result.output.length > 0);
  assert.ok(result.output.startsWith("😀"));
  assert.equal(Buffer.from(result.output, "utf8").toString("utf8"), result.output);
  assert.ok(Buffer.byteLength(result.output, "utf8") <= DEFAULT_MAX_BYTES);
  assert.ok(result.fullOutputPath);
  assert.equal(await readFile(result.fullOutputPath, "utf8"), fullOutput);
  assert.equal((await stat(result.fullOutputPath)).mode & 0o777, 0o600);
});

test("truncates output at Pi's line limit", async () => {
  const fullOutput = Array.from({ length: DEFAULT_MAX_LINES + 100 }, () => "line").join("\n");
  const result = await Effect.runPromise(
    runCursorDelegation({
      cwd: root,
      profile: MODEL_PROFILES.context,
      task: "Produce many lines",
      policyPluginDir: join(root, "policy", "plugin"),
      scratchRoot: scratch,
      agentCommand: fakeAgent,
      testEnvironment: { PI_CURSOR_ACP_FAKE_OUTPUT: fullOutput },
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onCursorRequest: async () => ({ outcome: { outcome: "cancelled" } }),
    }),
  );

  assert.equal(result.truncated, true);
  assert.ok(result.output.split("\n").length <= DEFAULT_MAX_LINES);
  assert.ok(result.fullOutputPath);
  assert.equal(await readFile(result.fullOutputPath, "utf8"), fullOutput);
});

test("rejects a silent model fallback", async () => {
  await assert.rejects(
    Effect.runPromise(
      runCursorDelegation({
        cwd: root,
        profile: MODEL_PROFILES.context,
        task: "Inspect context",
        policyPluginDir: join(root, "policy", "plugin"),
        scratchRoot: scratch,
        agentCommand: fakeAgent,
        testEnvironment: { PI_CURSOR_ACP_FAKE_MODEL: "gpt-5.4[reasoning=medium]" },
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onCursorRequest: async () => ({ outcome: { outcome: "cancelled" } }),
      }),
    ),
    hasTag("AcpModelMismatchError"),
  );
});

test("does not spawn before the delegation Effect is executed", async () => {
  const lazyScratch = join(scratch, "lazy");
  runCursorDelegation({
    cwd: root,
    profile: MODEL_PROFILES.context,
    task: "Do not start",
    policyPluginDir: join(root, "policy", "plugin"),
    scratchRoot: lazyScratch,
    agentCommand: fakeAgent,
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    onCursorRequest: async () => ({ outcome: { outcome: "cancelled" } }),
  });
  await assert.rejects(access(lazyScratch));
});

test("cancels a hanging ACP process and removes partial output", async () => {
  const priorOutputFiles = new Set(
    (await readdir(scratch)).filter((name) => name.startsWith("cursor-output-")),
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    Effect.runPromise(
      runCursorDelegation({
        cwd: root,
        profile: MODEL_PROFILES.context,
        task: "Hang",
        policyPluginDir: join(root, "policy", "plugin"),
        scratchRoot: scratch,
        agentCommand: fakeAgent,
        testEnvironment: {
          PI_CURSOR_ACP_FAKE_HANG: "1",
          PI_CURSOR_ACP_FAKE_OUTPUT: "x".repeat(DEFAULT_MAX_BYTES + 1_000),
        },
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onCursorRequest: async () => ({ outcome: { outcome: "cancelled" } }),
      }),
      { signal: controller.signal },
    ),
    /interrupted|cancelled/i,
  );
  assert.deepEqual(
    new Set((await readdir(scratch)).filter((name) => name.startsWith("cursor-output-"))),
    priorOutputFiles,
  );
});

test("times out and cleans up a hanging ACP process", async () => {
  await assert.rejects(
    Effect.runPromise(
      runCursorDelegation({
        cwd: root,
        profile: MODEL_PROFILES.context,
        task: "Hang",
        policyPluginDir: join(root, "policy", "plugin"),
        scratchRoot: scratch,
        agentCommand: fakeAgent,
        testEnvironment: { PI_CURSOR_ACP_FAKE_HANG: "1" },
        timeoutMs: 50,
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onCursorRequest: async () => ({ outcome: { outcome: "cancelled" } }),
      }),
    ),
    /timed out/,
  );
  assert.equal(
    (await readdir(scratch)).some((name) => name.startsWith("cursor-config-")),
    false,
  );
});

test("fails on reported transport errors and removes captured output", async () => {
  const priorOutputFiles = new Set(
    (await readdir(scratch)).filter((name) => name.startsWith("cursor-output-")),
  );
  await assert.rejects(
    Effect.runPromise(
      runCursorDelegation({
        cwd: root,
        profile: MODEL_PROFILES.context,
        task: "Inspect context",
        policyPluginDir: join(root, "policy", "plugin"),
        scratchRoot: scratch,
        agentCommand: fakeAgent,
        testEnvironment: {
          PI_CURSOR_ACP_FAKE_FAILURE: "1",
          PI_CURSOR_ACP_FAKE_OUTPUT: "x".repeat(DEFAULT_MAX_BYTES + 1_000),
        },
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onCursorRequest: async () => ({ outcome: { outcome: "cancelled" } }),
      }),
    ),
    (cause: unknown) => {
      if (!hasTag("CursorReportedFailureError")(cause)) return false;
      const failure = cause as { output: string; message: string };
      assert.ok(failure.output.startsWith("Error: RetriableError: network unavailable"));
      assert.equal(failure.output.length, 16_000);
      assert.ok(failure.message.endsWith(failure.output));
      return true;
    },
  );
  assert.deepEqual(
    new Set((await readdir(scratch)).filter((name) => name.startsWith("cursor-output-"))),
    priorOutputFiles,
  );
});
