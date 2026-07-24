import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Exit, Layer } from "effect";

import { CursorCli } from "../cursor-cli.js";
import { delegateToCursor, type DelegationRequest } from "../delegation.js";
import { GitState } from "../git-state.js";
import { DelegationAdmission } from "../runtime.js";

function request(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    cwd: process.cwd(),
    intent: "review",
    task: "Review the change",
    policyPluginDir: process.cwd(),
    scratchRoot: process.cwd(),
    confirm: async () => true,
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    onCursorRequest: async () => ({ outcome: { outcome: "cancelled" } }),
    ...overrides,
  };
}

function testLayer(
  models: ReadonlySet<string>,
  capture: () => Effect.Effect<{
    available: boolean;
    status: string;
    diffStat: string;
  }> = () => Effect.succeed({ available: false, status: "", diffStat: "" }),
) {
  return Layer.mergeAll(
    Layer.succeed(CursorCli)({
      assertVersion: () => Effect.succeed("2026.07.23"),
      listModelIds: () => Effect.succeed(models),
    }),
    Layer.succeed(GitState)({ capture }),
    DelegationAdmission.layer,
  );
}

test("workflow uses a fake Cursor CLI layer for model policy", async () => {
  await assert.rejects(
    Effect.runPromise(delegateToCursor(request()).pipe(Effect.provide(testLayer(new Set())))),
    /not available/,
  );
});

test("operational failure releases admission for the next workflow", async () => {
  const program = Effect.gen(function* () {
    const first = yield* Effect.exit(delegateToCursor(request()));
    assert.equal(Exit.isFailure(first), true);
    return yield* delegateToCursor(request({ confirm: async () => false }));
  }).pipe(Effect.provide(testLayer(new Set())));

  const second = await Effect.runPromise(program);
  assert.equal(second._tag, "Declined");
});

test("implementation workflow captures Git state before ACP acquisition", async () => {
  let captures = 0;
  await assert.rejects(
    Effect.runPromise(
      delegateToCursor(
        request({
          intent: "implement",
          agentCommand: "",
        }),
      ).pipe(
        Effect.provide(
          testLayer(new Set(["cursor-grok-4.5-high-fast"]), () =>
            Effect.sync(() => {
              captures += 1;
              return { available: true, status: "clean", diffStat: "" };
            }),
          ),
        ),
      ),
    ),
    (cause: unknown) =>
      Boolean(
        cause && typeof cause === "object" && "_tag" in cause && cause._tag === "AcpProcessError",
      ),
  );
  assert.equal(captures, 1);
});
