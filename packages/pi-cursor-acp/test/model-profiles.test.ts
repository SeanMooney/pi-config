import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_PROFILES, modelSelectionMatches, resolveModelProfile } from "../model-profiles.js";

test("uses verified workflow defaults", () => {
  assert.deepEqual(
    {
      context: MODEL_PROFILES.context.cliModelId,
      implement: MODEL_PROFILES.implement.cliModelId,
      review: MODEL_PROFILES.review.cliModelId,
    },
    {
      context: "composer-2.5-fast",
      implement: "cursor-grok-4.5-high-fast",
      review: "cursor-grok-4.5-high-fast",
    },
  );
  assert.equal(MODEL_PROFILES.context.mode, "ask");
  assert.equal(MODEL_PROFILES.implement.mode, "agent");
  assert.equal(MODEL_PROFILES.review.mode, "ask");
});

test("applies supported Grok and Composer overrides", () => {
  assert.equal(
    resolveModelProfile("review", { effort: "low", speed: "standard" }).cliModelId,
    "cursor-grok-4.5-low",
  );
  assert.equal(resolveModelProfile("context", { speed: "standard" }).cliModelId, "composer-2.5");
  assert.throws(
    () => resolveModelProfile("context", { effort: "low" }),
    /does not expose an effort override/,
  );
});

test("verifies ACP model selections without silent fallback", () => {
  assert.equal(
    modelSelectionMatches("cursor-grok-4.5-medium-fast", "grok-4.5[effort=medium,fast=true]"),
    true,
  );
  assert.equal(
    modelSelectionMatches("cursor-grok-4.5-medium-fast", "grok-4.5[effort=high,fast=true]"),
    false,
  );
  assert.equal(modelSelectionMatches("composer-2.5-fast", "composer-2.5[fast=true]"), true);
  assert.equal(modelSelectionMatches("composer-2.5-fast", "gpt-5.4[reasoning=medium]"), false);
});
