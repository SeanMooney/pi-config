import assert from "node:assert/strict";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildAgentArgs, isCursorFailureOutput, runCursorDelegation } from "../acp-client.js";
import { MODEL_PROFILES } from "../model-profiles.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = join(root, ".tmp", `acp-test-${process.pid}`);
const fakeAgent = join(scratch, "fake-agent.mjs");

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
    if (process.env.PI_CURSOR_ACP_FAKE_HANG === "1") return;
    const text = process.env.PI_CURSOR_ACP_FAKE_FAILURE === "1"
      ? "Error: RetriableError: network unavailable"
      : "verified output";
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "fake-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text }
      }
    }});
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
  const result = await runCursorDelegation({
    cwd: root,
    profile: MODEL_PROFILES.context,
    task: "Inspect context",
    policyPluginDir: join(root, "policy", "plugin"),
    scratchRoot: scratch,
    agentCommand: fakeAgent,
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    onCursorRequest: async () => ({ outcome: { outcome: "cancelled" } }),
  });
  assert.equal(result.output, "verified output");
  assert.equal(result.modelId, "composer-2.5-fast");
  assert.equal(result.acpModelId, "composer-2.5[fast=true]");
  assert.equal(result.mode, "ask");
  assert.equal(result.stopReason, "end_turn");
});

test("rejects a silent model fallback", async () => {
  await assert.rejects(
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
    /not requested model/,
  );
});

test("does not spawn for a pre-aborted delegation", async () => {
  const controller = new AbortController();
  controller.abort();
  const abortedScratch = join(scratch, "pre-aborted");

  await assert.rejects(
    runCursorDelegation({
      cwd: root,
      profile: MODEL_PROFILES.context,
      task: "Do not start",
      policyPluginDir: join(root, "policy", "plugin"),
      scratchRoot: abortedScratch,
      agentCommand: fakeAgent,
      signal: controller.signal,
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onCursorRequest: async () => ({ outcome: { outcome: "cancelled" } }),
    }),
    /cancelled/,
  );
  await assert.rejects(access(abortedScratch));
});

test("cancels a hanging ACP process", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    runCursorDelegation({
      cwd: root,
      profile: MODEL_PROFILES.context,
      task: "Hang",
      policyPluginDir: join(root, "policy", "plugin"),
      scratchRoot: scratch,
      agentCommand: fakeAgent,
      testEnvironment: { PI_CURSOR_ACP_FAKE_HANG: "1" },
      signal: controller.signal,
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onCursorRequest: async () => ({ outcome: { outcome: "cancelled" } }),
    }),
    /cancelled/,
  );
});

test("times out and cleans up a hanging ACP process", async () => {
  await assert.rejects(
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
    /timed out/,
  );
});

test("fails when Cursor returns a transport error as output", async () => {
  await assert.rejects(
    runCursorDelegation({
      cwd: root,
      profile: MODEL_PROFILES.context,
      task: "Inspect context",
      policyPluginDir: join(root, "policy", "plugin"),
      scratchRoot: scratch,
      agentCommand: fakeAgent,
      testEnvironment: { PI_CURSOR_ACP_FAKE_FAILURE: "1" },
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onCursorRequest: async () => ({ outcome: { outcome: "cancelled" } }),
    }),
    /transport or authentication failure/,
  );
});
