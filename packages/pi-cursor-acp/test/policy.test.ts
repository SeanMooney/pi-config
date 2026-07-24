import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hook = join(root, "policy", "plugin", "scripts", "policy-hook.mjs");

async function runHook(input: Record<string, unknown>) {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn("node", [hook], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(Buffer.concat(errors).toString("utf8")));
    });
    child.stdin.end(JSON.stringify(input));
  });
  return JSON.parse(stdout) as {
    permission: "allow" | "ask" | "deny";
    user_message?: string;
  };
}

test("blocks subagents, MCP, web, and unsafe shell", async () => {
  assert.equal((await runHook({ hook_event_name: "subagentStart" })).permission, "deny");
  assert.equal(
    (
      await runHook({
        hook_event_name: "preToolUse",
        tool_name: "MCP:github",
      })
    ).permission,
    "deny",
  );
  assert.equal(
    (
      await runHook({
        hook_event_name: "preToolUse",
        tool_name: "WebFetch",
      })
    ).permission,
    "deny",
  );
  assert.equal(
    (
      await runHook({
        hook_event_name: "beforeShellExecution",
        command: "git push origin HEAD",
      })
    ).permission,
    "deny",
  );
  assert.equal(
    (
      await runHook({
        hook_event_name: "beforeShellExecution",
        command: "gh auth token",
      })
    ).permission,
    "deny",
  );
  assert.equal(
    (
      await runHook({
        hook_event_name: "beforeShellExecution",
        command: "pytest -q",
      })
    ).permission,
    "ask",
  );
});

test("guards sensitive and outside-workspace paths", async () => {
  const common = {
    hook_event_name: "beforeReadFile",
    workspace_roots: ["/workspace"],
    cwd: "/workspace",
  };
  assert.equal((await runHook({ ...common, file_path: "src/main.py" })).permission, "allow");
  assert.equal((await runHook({ ...common, file_path: ".env" })).permission, "deny");
  assert.equal((await runHook({ ...common, file_path: ".git/config" })).permission, "deny");
  assert.equal(
    (
      await runHook({
        hook_event_name: "preToolUse",
        tool_name: "StrReplace",
        workspace_roots: ["/workspace"],
        cwd: "/workspace",
        tool_input: { path: ".env" },
      })
    ).permission,
    "deny",
  );
  assert.equal(
    (
      await runHook({
        hook_event_name: "preToolUse",
        tool_name: "StrReplace",
        workspace_roots: ["/workspace"],
        cwd: "/workspace",
        tool_input: { path: "src/main.py" },
      })
    ).permission,
    "allow",
  );
  assert.equal((await runHook({ ...common, file_path: "/home/user/.npmrc" })).permission, "deny");
  assert.equal((await runHook({ ...common, file_path: "/outside/file" })).permission, "deny");
});
