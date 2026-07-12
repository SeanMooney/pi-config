import test from "node:test";

import assert from "node:assert/strict";

import { appendUnique } from "./index.ts";

test("interactive grants are additive and cumulative", () => {
  const configuredWrites = [".", "~/repos", "/tmp"];
  const afterReadGrant = appendUnique(configuredWrites, []);
  const afterWriteGrants = appendUnique(afterReadGrant, ["/specific/file", "~/repos"]);

  assert.deepEqual(afterReadGrant, configuredWrites);
  assert.deepEqual(afterWriteGrants, [".", "~/repos", "/tmp", "/specific/file"]);
});
