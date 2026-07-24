import assert from "node:assert/strict";
import test from "node:test";

import { combineAbortSignals, DelegationLifecycle } from "../lifecycle.js";

test("session lifecycle aborts active delegations and resets", () => {
  const lifecycle = new DelegationLifecycle();
  const first = lifecycle.signal;
  assert.equal(first.aborted, false);

  lifecycle.shutdown();
  assert.equal(first.aborted, true);

  lifecycle.reset();
  assert.equal(lifecycle.signal.aborted, false);
  assert.notEqual(lifecycle.signal, first);
});

test("combined signal follows either source", () => {
  const tool = new AbortController();
  const session = new AbortController();
  const combined = combineAbortSignals(tool.signal, session.signal);
  session.abort();
  assert.equal(combined.aborted, true);
});
