import assert from "node:assert/strict";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { Cause, Effect, Exit } from "effect";

import { CursorCli } from "../cursor-cli.js";

const scratch = join(import.meta.dirname, "..", ".tmp", `cursor-cli-${process.pid}`);
const supportedAgent = join(scratch, "supported-agent.mjs");
const unsupportedAgent = join(scratch, "unsupported-agent.mjs");
const hangingAgent = join(scratch, "hanging-agent.mjs");

function agentSource(version: string, hangModels = false): string {
  return `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stdout.write(${JSON.stringify(version)} + "\\n");
} else if (process.argv[2] === "models") {
  ${hangModels ? "setInterval(() => undefined, 1000);" : 'process.stdout.write("composer-2.5-fast - Composer\\ncursor-grok-4.5-high-fast - Grok\\n");'}
}
`;
}

async function writeAgent(path: string, source: string): Promise<void> {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

test.before(async () => {
  await mkdir(scratch, { recursive: true });
  await Promise.all([
    writeAgent(supportedAgent, agentSource("2026.07.23")),
    writeAgent(unsupportedAgent, agentSource("2026.07.22")),
    writeAgent(hangingAgent, agentSource("2026.07.23", true)),
  ]);
});

test.after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("Cursor CLI layer validates versions, parses models, and cleans up", async () => {
  const result = await Effect.runPromise(
    CursorCli.use((cursor) =>
      Effect.all({
        version: cursor.assertVersion(supportedAgent),
        models: cursor.listModelIds(scratch, supportedAgent),
      }),
    ).pipe(Effect.provide(CursorCli.layer)),
  );

  assert.equal(result.version, "2026.07.23");
  assert.deepEqual([...result.models], ["composer-2.5-fast", "cursor-grok-4.5-high-fast"]);
  assert.equal(
    (await readdir(scratch)).some((name) => name.startsWith("model-config-")),
    false,
  );
});

test("Cursor CLI layer exposes an unsupported-version failure", async () => {
  await assert.rejects(
    Effect.runPromise(
      CursorCli.use((cursor) => cursor.assertVersion(unsupportedAgent)).pipe(
        Effect.provide(CursorCli.layer),
      ),
    ),
    /unsupported/,
  );
});

test("Cursor CLI model discovery is interruptible and cleans up", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const exit = await Effect.runPromiseExit(
    CursorCli.use((cursor) => cursor.listModelIds(scratch, hangingAgent)).pipe(
      Effect.provide(CursorCli.layer),
    ),
    { signal: controller.signal },
  );

  assert.equal(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), true);
  assert.equal(
    (await readdir(scratch)).some((name) => name.startsWith("model-config-")),
    false,
  );
});
