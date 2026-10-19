#!/usr/bin/env node
// Exercise the pinned upstream router with fake auth and transport: no API calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "../npm/node_modules/jiti/lib/jiti.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.env.PI_CODING_AGENT_DIR = root;
process.env.BRAVE_API_KEY = "test-only-placeholder";
delete process.env.OPENAI_API_KEY;

const config = JSON.parse(readFileSync(`${root}web-search.json`, "utf8"));
assert.deepEqual(config.openaiSearchProviders, ["openai-codex"]);
assert.equal(config.braveApiKey, "$BRAVE_API_KEY");
assert.equal(config.provider, undefined);
assert.equal(config.searchProvider, undefined);
assert.equal(config.searchRouting.useCurrentModel, false);
assert.deepEqual(config.searchRouting.providers, ["openai", "brave"]);
assert.deepEqual(config.webSearch.allowedProviders, ["openai", "brave"]);
assert.equal(config.workflow, "none");
const manifest = JSON.parse(readFileSync(`${root}npm/package.json`, "utf8"));
const lock = JSON.parse(readFileSync(`${root}npm/package-lock.json`, "utf8"));
const settings = JSON.parse(readFileSync(`${root}settings.json`, "utf8"));
const installed = JSON.parse(
  readFileSync(`${root}npm/node_modules/pi-web-access/package.json`, "utf8"),
);
assert.equal(installed.version, "0.42.0");
assert.equal(manifest.dependencies["pi-web-access"], installed.version);
assert.equal(lock.packages[""].dependencies["pi-web-access"], installed.version);
assert.equal(lock.packages["node_modules/pi-web-access"].version, installed.version);
assert.ok(settings.packages.includes(`npm:pi-web-access@${installed.version}`));
assert.ok(settings.packages.includes("npm:pi-smart-fetch@0.3.17"));

const jiti = createJiti(import.meta.url, { fsCache: false });
const { search, getConfiguredSearchRouting } = await jiti.import(
  "../npm/node_modules/pi-web-access/gemini-search.ts",
);
assert.deepEqual(getConfiguredSearchRouting(), config.searchRouting);
const codex = {
  provider: "openai-codex",
  id: "gpt-6-luna",
  baseUrl: "https://chatgpt.com/backend-api",
};
let authAvailable = true;
const context = {
  model: { provider: "anthropic", id: "claude-test" },
  modelRegistry: {
    getAll: () => [codex],
    getApiKeyAndHeaders: async (model) => {
      assert.equal(model.provider, "openai-codex");
      return { ok: authAvailable, apiKey: "fake-codex-token", headers: {} };
    },
  },
};
const success = {
  output: [
    { type: "web_search_call" },
    {
      type: "message",
      content: [{ type: "output_text", text: "Test answer", annotations: [] }],
    },
  ],
};
let failure;
let calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  calls.push(url.hostname);
  if (url.hostname === "chatgpt.com") {
    assert.equal(url.pathname, "/backend-api/codex/responses");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fake-codex-token");
    assert.equal(JSON.parse(init.body).model, codex.id);
    if (failure instanceof Error) throw failure;
    return Response.json(failure?.body ?? success, { status: failure?.status ?? 200 });
  }
  assert.equal(url.hostname, "api.search.brave.com");
  assert.equal(url.pathname, "/res/v1/web/search");
  assert.equal(new Headers(init.headers).get("x-subscription-token"), "test-only-placeholder");
  return Response.json({
    web: { results: [{ title: "Example", url: "https://example.com", description: "Test" }] },
  });
};
try {
  const run = (provider) => search("test query", { extensionContext: context, provider });
  assert.equal((await run()).provider, "openai");
  assert.deepEqual(calls, ["chatgpt.com"]);
  const cases = [
    ["quota", { status: 429, body: { error: "quota" } }],
    ["unsupported", { status: 400, body: { error: "web_search tool not supported" } }],
    ["network", new TypeError("fetch failed")],
    ["transient", { status: 503, body: { error: "unavailable" } }],
    ["invalid-response", { body: { output: [] } }],
  ];
  assert.deepEqual(new Set(config.searchRouting.fallbackOn), new Set(cases.map(([kind]) => kind)));
  for (const [kind, error] of cases) {
    failure = error;
    calls = [];
    assert.equal((await run()).provider, "brave", kind);
    assert.deepEqual(calls, ["chatgpt.com", "api.search.brave.com"], kind);
  }
  calls = [];
  await assert.rejects(run("openai"));
  assert.deepEqual(calls, ["chatgpt.com"], "explicit provider bypasses fallback");
  failure = { status: 401, body: { error: "unauthorized" } };
  calls = [];
  await assert.rejects(run(), (error) => error.kind === "auth");
  assert.deepEqual(calls, ["chatgpt.com"], "auth errors must not trigger fallback");
  calls = [];
  await assert.rejects(run("exa"), /disabled provider/i);
  assert.deepEqual(calls, []);
  authAvailable = false;
  calls = [];
  assert.equal((await run()).provider, "brave");
  assert.deepEqual(calls, ["api.search.brave.com"], "unavailable Codex is skipped");
  console.log("PASS: pins, config, independent Codex auth, five fallbacks, strict overrides");
} finally {
  globalThis.fetch = originalFetch;
}
