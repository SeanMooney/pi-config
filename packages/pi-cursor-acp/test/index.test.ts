import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import cursorAcpExtension, { notifyIfUI } from "../index.js";

type Handler = (...args: any[]) => any;

function extensionHarness() {
  let activeTools = ["read"];
  let registeredTool: { name: string } | undefined;
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool(tool: { name: string }) {
      registeredTool = tool;
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(tools: string[]) {
      activeTools = [...tools];
    },
  } as unknown as ExtensionAPI;

  const subagentChild = process.env.PI_SUBAGENT_CHILD;
  try {
    delete process.env.PI_SUBAGENT_CHILD;
    cursorAcpExtension(pi);
  } finally {
    if (subagentChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = subagentChild;
  }
  return {
    get activeTools() {
      return activeTools;
    },
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

test("extension wiring activates the tool for natural language and clears it", async () => {
  const harness = extensionHarness();
  assert.equal(harness.registeredTool?.name, "cursor_agent");
  assert.deepEqual(harness.activeTools, ["read"]);

  await harness.handler("input")({ text: "do the cursor review from the main thread" });
  assert.deepEqual(harness.activeTools, ["read", "cursor_agent"]);

  await harness.handler("agent_end")();
  assert.deepEqual(harness.activeTools, ["read"]);
});

test("resource discovery exposes only the extension skill root", async () => {
  const harness = extensionHarness();
  const resources = await harness.handler("resources_discover")();
  assert.equal(resources.skillPaths.length, 1);
  assert.match(resources.skillPaths[0], /packages\/pi-cursor-acp\/resources$/);
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
