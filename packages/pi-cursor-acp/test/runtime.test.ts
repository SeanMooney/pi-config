import assert from "node:assert/strict";
import test from "node:test";

import { Cause, Effect, Exit } from "effect";

import { argvUsesPiSsh, CursorRuntimeOwner, isExcludedRuntime } from "../runtime.js";

test("managed runtime is lazy and cannot restart after shutdown", async () => {
  const owner = new CursorRuntimeOwner();
  const exit = await owner.runPromiseExit(Effect.succeed("ok"));
  assert.equal(Exit.isSuccess(exit) && exit.value, "ok");
  await owner.shutdown();
  await owner.shutdown();
  assert.throws(() => owner.runPromiseExit(Effect.succeed("late")), /shutting down/);
});

test("shutdown interrupts supervised work and awaits finalizers", async () => {
  const owner = new CursorRuntimeOwner();
  let markStarted: (() => void) | undefined;
  let markFinalized: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const finalized = new Promise<void>((resolve) => {
    markFinalized = resolve;
  });
  const running = owner.runPromiseExit(
    Effect.sync(() => markStarted?.()).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(Effect.sync(() => markFinalized?.())),
    ),
  );

  await started;
  await owner.shutdown();
  await finalized;
  const exit = await running;
  assert.equal(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), true);
});

test("shutdown closes admission during an immediate startup race", async () => {
  const owner = new CursorRuntimeOwner();
  const running = owner.runPromiseExit(Effect.never);
  await owner.shutdown();
  const exit = await running;
  assert.equal(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), true);
});

test("detects only Pi SSH mode and subagent children", () => {
  assert.equal(argvUsesPiSsh(["pi", "--ssh", "host"]), true);
  assert.equal(argvUsesPiSsh(["pi", "--ssh=host"]), true);
  assert.equal(argvUsesPiSsh(["pi"]), false);

  assert.equal(isExcludedRuntime({ PI_SUBAGENT_CHILD: "1" }, ["pi"]), true);
  assert.equal(isExcludedRuntime({ PI_SSH_MODE_ACTIVE: "1" }, ["pi"]), true);
  assert.equal(isExcludedRuntime({ PI_SSH_REMOTE: "host" }, ["pi"]), true);
  assert.equal(isExcludedRuntime({ SSH_CONNECTION: "client server" }, ["pi"]), false);
});
