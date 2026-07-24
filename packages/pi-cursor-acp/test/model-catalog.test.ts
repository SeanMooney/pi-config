import assert from "node:assert/strict";
import test from "node:test";

import { cursorVersionIsSupported, parseModelIds } from "../model-catalog.js";

test("enforces the tested Cursor CLI minimum version", () => {
  assert.equal(cursorVersionIsSupported("2026.07.23-e383d2b"), true);
  assert.equal(cursorVersionIsSupported("2026.08.01"), true);
  assert.equal(cursorVersionIsSupported("2026.06.30"), false);
  assert.equal(cursorVersionIsSupported("unknown"), false);
});

test("parses Cursor CLI model output", () => {
  const models = parseModelIds(`Available models

auto - Auto (default)
composer-2.5-fast - Composer 2.5 Fast
cursor-grok-4.5-medium-fast - Cursor Grok 4.5 Fast

Tip: use --model <id>
`);
  assert.deepEqual([...models], ["auto", "composer-2.5-fast", "cursor-grok-4.5-medium-fast"]);
});
