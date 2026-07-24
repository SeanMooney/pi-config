import assert from "node:assert/strict";
import test from "node:test";

import {
  argvUsesPiSsh,
  isExcludedRuntime,
  isExplicitCursorRequest,
  OneShotAuthorization,
} from "../activation.js";

test("recognizes explicit Cursor delegation", () => {
  for (const prompt of [
    "/skill:cursor-agent review this diff",
    "Ask Cursor to gather scheduler context",
    "Use Cursor Agent to implement the fix",
    "Have Cursor review my current diff",
    "Delegate this review to Cursor",
    "Cursor: inspect the validation path",
    "do the cursor review from the main thread",
    "Let Cursor review the current commit",
    "Get Cursor to inspect the extension",
    "Cursor Agent, please review this commit",
    "I'd like Cursor to analyze the policy",
  ]) {
    assert.equal(isExplicitCursorRequest(prompt), true, prompt);
  }
});

test("rejects incidental Cursor mentions and ordinary work", () => {
  for (const prompt of [
    "How does Cursor ACP work?",
    "Compare Cursor with Pi",
    "Review my current diff",
    "Update the Cursor documentation",
    "The Cursor integration uses ACP",
  ]) {
    assert.equal(isExplicitCursorRequest(prompt), false, prompt);
  }
});

test("authorization is one shot", () => {
  const authorization = new OneShotAuthorization();
  assert.equal(authorization.consume(), false);
  authorization.authorize();
  assert.equal(authorization.active, true);
  assert.equal(authorization.consume(), true);
  assert.equal(authorization.consume(), false);
  authorization.authorize();
  authorization.clear();
  assert.equal(authorization.active, false);
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
