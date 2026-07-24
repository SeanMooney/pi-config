import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import cursorAcpExtension, { confirmDelegation, notifyIfUI } from "../index.js";

type Handler = (...args: any[]) => any;
type RegisteredTool = { name: string; execute: Handler };

function extensionHarness(env: NodeJS.ProcessEnv = {}, argv: readonly string[] = ["pi"]) {
  let registeredTool: RegisteredTool | undefined;
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool(tool: RegisteredTool) {
      registeredTool = tool;
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;

  cursorAcpExtension(pi, { env, argv });
  return {
    get registeredTool() {
      return registeredTool;
    },
    handler(event: string): Handler {
      const handler = handlers.get(event)?.[0];
      assert.ok(handler, `missing ${event} handler`);
      return handler;
    },
  };
}

test("eligible main sessions always register the Cursor tool", () => {
  assert.equal(extensionHarness().registeredTool?.name, "cursor_agent");
});

test("subagent and Pi SSH runtimes do not register the Cursor tool", () => {
  assert.equal(extensionHarness({ PI_SUBAGENT_CHILD: "1" }).registeredTool, undefined);
  assert.equal(extensionHarness({ PI_SSH_MODE_ACTIVE: "1" }).registeredTool, undefined);
  assert.equal(extensionHarness({ PI_SSH_REMOTE: "host" }).registeredTool, undefined);
  assert.equal(extensionHarness({}, ["pi", "--ssh", "host"]).registeredTool, undefined);
});

test("resource discovery exposes only the extension skill root", async () => {
  const resources = await extensionHarness().handler("resources_discover")();
  assert.equal(resources.skillPaths.length, 1);
  assert.match(resources.skillPaths[0], /packages\/pi-cursor-acp\/resources$/);
});

test("interactive delegation requires final confirmation", async () => {
  let prompt = "";
  const confirmed = await confirmDelegation(
    {
      hasUI: true,
      ui: {
        async confirm(_title: string, message: string) {
          prompt = message;
          return false;
        },
      },
    } as never,
    "review",
    "cursor-grok-4.5-high-fast",
    "Review commit 123",
  );

  assert.equal(confirmed, false);
  assert.match(prompt, /Intent: review/);
  assert.match(prompt, /Model: cursor-grok-4\.5-high-fast/);
  assert.match(prompt, /Review commit 123/);
});

test("confirmation truncates long tasks", async () => {
  let prompt = "";
  await confirmDelegation(
    {
      hasUI: true,
      ui: {
        async confirm(_title: string, message: string) {
          prompt = message;
          return false;
        },
      },
    } as never,
    "context",
    "composer-2.5-fast",
    "x".repeat(3_000),
  );
  assert.match(prompt, /\[Task truncated\]$/);
  assert.ok(prompt.length < 2_100);
});

test("declined calls are non-errors and release the delegation gate", async () => {
  const tool = extensionHarness().registeredTool;
  assert.ok(tool);
  let confirmations = 0;
  const ctx = {
    hasUI: true,
    ui: {
      async confirm() {
        confirmations += 1;
        return false;
      },
    },
  } as never;
  const invoke = () =>
    tool.execute(
      "call-id",
      { intent: "review", task: "Review the commit" },
      new AbortController().signal,
      undefined,
      ctx,
    );

  for (let count = 0; count < 2; count += 1) {
    const result = await invoke();
    assert.equal(result.details.cancelled, true);
    assert.notEqual(result.isError, true);
  }
  assert.equal(confirmations, 2);
});

test("overlapping Cursor calls are rejected", async () => {
  const tool = extensionHarness().registeredTool;
  assert.ok(tool);
  let releaseConfirmation: ((confirmed: boolean) => void) | undefined;
  const confirmation = new Promise<boolean>((resolve) => {
    releaseConfirmation = resolve;
  });
  const ctx = {
    hasUI: true,
    ui: { confirm: () => confirmation },
  } as never;
  const args = [
    "call-id",
    { intent: "review", task: "Review the commit" },
    new AbortController().signal,
    undefined,
    ctx,
  ] as const;

  const first = tool.execute(...args);
  const second = await tool.execute(...args);
  assert.equal(second.details.busy, true);
  assert.equal(second.isError, true);
  releaseConfirmation?.(false);
  await first;
});

test("headless delegation trusts the skill decision", async () => {
  const confirmed = await confirmDelegation(
    { hasUI: false, ui: {} } as never,
    "context",
    "composer-2.5-fast",
    "Gather context",
  );
  assert.equal(confirmed, true);
});

test("headless notification is a no-op", () => {
  let notifications = 0;
  const ui = {
    notify() {
      notifications += 1;
    },
  };

  notifyIfUI({ hasUI: false, ui } as never, "starting");
  assert.equal(notifications, 0);
  notifyIfUI({ hasUI: true, ui } as never, "starting");
  assert.equal(notifications, 1);
});
