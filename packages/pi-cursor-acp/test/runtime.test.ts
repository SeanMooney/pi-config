import assert from "node:assert/strict";
import test from "node:test";

import { argvUsesPiSsh, DelegationGate, isExcludedRuntime } from "../runtime.js";

test("delegation gate rejects overlap and permits sequential calls", () => {
  const gate = new DelegationGate();
  assert.equal(gate.tryStart(), true);
  assert.equal(gate.tryStart(), false);
  gate.finish();
  assert.equal(gate.tryStart(), true);
  gate.finish();
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
