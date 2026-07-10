import vertexClaudeExtension, {
  DOCUMENTED_VERTEX_MODELS,
  addAliases,
  classifyDiagnosticError,
  modelsFromEnv,
  parseClaudeModel,
  vertexThinkingOptions,
} from "./index.js";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { getModel } from "@earendil-works/pi-ai/compat";

const expectedManifest = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5@20251101",
  "claude-opus-4-1@20250805",
  "claude-opus-4@20250514",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5@20250929",
  "claude-sonnet-4@20250514",
  "claude-haiku-4-5@20251001",
  "claude-3-5-haiku@20241022",
  "claude-fable-5",
];
const fail = (message: string): never => {
  throw new Error(message);
};
const equal = (actual: unknown, expected: unknown, label: string) => {
  if (actual !== expected) fail(`${label}: expected ${String(expected)}, got ${String(actual)}`);
};
const throws = (fn: () => unknown, expected: string, label: string) => {
  try {
    fn();
    fail(`${label}: did not throw`);
  } catch (error) {
    equal((error as Error).message, expected, label);
  }
};

equal(
  JSON.stringify(DOCUMENTED_VERTEX_MODELS.map((model) => model.id)),
  JSON.stringify(expectedManifest),
  "exact manifest",
);
for (const model of DOCUMENTED_VERTEX_MODELS) {
  if (!["active", "deprecated"].includes(model.lifecycle)) fail(`manifest lifecycle ${model.id}`);
  if (
    model.aliasEligible !==
    (model.id === "claude-opus-4-8" ||
      model.id === "claude-sonnet-5" ||
      model.id === "claude-haiku-4-5@20251001" ||
      model.id === "claude-fable-5")
  )
    fail(`manifest alias eligibility ${model.id}`);
}
const aliases = new Map(
  addAliases(DOCUMENTED_VERTEX_MODELS, true)
    .filter((model) => model.aliasTarget)
    .map((model) => [model.id, model.aliasTarget]),
);
for (const [alias, target] of Object.entries({
  opus: "claude-opus-4-8",
  "claude-opus": "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  "claude-sonnet": "claude-sonnet-5",
  haiku: "claude-haiku-4-5@20251001",
  "claude-haiku": "claude-haiku-4-5@20251001",
  fable: "claude-fable-5",
  "claude-fable": "claude-fable-5",
}))
  equal(aliases.get(alias), target, `alias ${alias}`);
for (const id of [
  "claude-nonsense",
  "claude-",
  "claude-opus",
  "claude-4-foo",
  "claude-opus-4@bad",
  "other-claude-opus-4",
])
  equal(parseClaudeModel(id), undefined, `malformed ${id}`);
for (const id of ["claude-opus-4-8", "claude-3-5-haiku@20241022", "claude-sonnet-9@20260101"]) {
  if (!parseClaudeModel(id)) fail(`valid override rejected: ${id}`);
}
const savedOverride = process.env.VERTEX_CLAUDE_MODELS;
process.env.VERTEX_CLAUDE_MODELS = "";
throws(
  modelsFromEnv,
  "VERTEX_CLAUDE_MODELS is set but empty; unset it to use the Vertex Claude manifest.",
  "empty override",
);
process.env.VERTEX_CLAUDE_MODELS = "claude-nonsense,claude-";
throws(
  modelsFromEnv,
  "Invalid Vertex Claude model ID in VERTEX_CLAUDE_MODELS: claude-nonsense",
  "malformed override",
);
if (savedOverride === undefined) delete process.env.VERTEX_CLAUDE_MODELS;
else process.env.VERTEX_CLAUDE_MODELS = savedOverride;

const model = {
  id: "test",
  name: "test",
  api: "anthropic-messages",
  contextWindow: 10_000,
  maxTokens: 8_000,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as any;
const context = {
  messages: [{ role: "user", content: "x".repeat(7_600), timestamp: 1 }],
} as any;
const noThinking = vertexThinkingOptions(model, context, {});
equal(noThinking.maxTokens, 4_004, "no-thinking clamp");
equal(noThinking.thinkingEnabled, false, "no-thinking flag");
const adaptive = vertexThinkingOptions(
  {
    ...model,
    compat: { forceAdaptiveThinking: true },
    thinkingLevelMap: { high: "xhigh" },
  },
  context,
  { reasoning: "high" } as any,
);
equal(adaptive.maxTokens, 4_004, "adaptive clamp");
equal(adaptive.effort, "xhigh", "adaptive effort");
const legacy = vertexThinkingOptions(model, context, {
  reasoning: "high",
  maxTokens: 3_000,
} as any);
equal(legacy.maxTokens, 4_004, "legacy post-expansion clamp");
equal(legacy.thinkingBudgetTokens, 2_980, "legacy budget after clamp");
const tightContext = {
  messages: [{ role: "user", content: "x".repeat(15_808), timestamp: 1 }],
} as any;
const tight = vertexThinkingOptions(model, tightContext, {
  reasoning: "low",
} as any);
equal(tight.maxTokens, 1_952, "tight context clamp");
equal(tight.thinkingEnabled, false, "tight context disables legacy thinking");
for (const [error, expected] of [
  [Object.assign(new Error("credential failure"), { status: 403 }), "permission failure"],
  [
    Object.assign(new Error("permission denied"), { status: 401 }),
    "missing ADC/auth configuration",
  ],
  [
    Object.assign(new Error("missing"), { status: 404 }),
    "ambiguous 404 (model, region, project, or model-access configuration)",
  ],
  [Object.assign(new Error("permission denied"), { status: 429 }), "quota or rate-limit failure"],
  [new Error("fetch failed: network timeout"), "network failure"],
  [new Error("unexpected"), "request/authentication failure"],
] as const)
  equal(classifyDiagnosticError(error), expected, `diagnostic ${expected}`);

let fetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("startup must not fetch");
}) as typeof fetch;
// A query string forces a fresh extension-module evaluation after fetch is guarded.
const guardSpecifier: string = "./index.js?startup-network-guard";
const guardedExtension = await import(guardSpecifier);
let provider: any;
guardedExtension.default({
  registerProvider: (_id: string, value: unknown) => {
    provider = value;
  },
  registerCommand: () => {},
} as any);
equal(fetchCalls, 0, "import, initialization, and model registration have no startup network");
const registered = new Map<string, any>(provider.models.map((entry: any) => [entry.id, entry]));
for (const id of ["claude-opus-4-8", "opus", "claude-sonnet-5", "sonnet"]) {
  const registeredModel = registered.get(id);
  if (!registeredModel) fail(`registered ${id}`);
  const target = aliases.get(id) ?? id;
  const catalog = getModel("anthropic", target.replace(/@.*$/, "") as never) as any;
  if (catalog)
    for (const field of [
      "compat",
      "thinkingLevelMap",
      "cost",
      "input",
      "contextWindow",
      "maxTokens",
    ])
      equal(
        JSON.stringify(registeredModel[field]),
        JSON.stringify(catalog[field]),
        `${id} inherited ${field}`,
      );
}
equal(registered.get("opus").name.includes("claude-opus-4-8"), true, "alias metadata target");
equal(
  registered.get("claude-opus-4-8").compat.forceAdaptiveThinking,
  true,
  "Opus adaptive thinking metadata",
);
equal(
  registered.get("claude-opus-4-8").compat.supportsTemperature,
  false,
  "Opus temperature metadata",
);
equal(
  registered.get("claude-sonnet-5").compat.forceAdaptiveThinking,
  true,
  "Sonnet adaptive thinking metadata",
);
globalThis.fetch = originalFetch;

const urls: string[] = [];
const fakeAuth = {
  projectId: "test-project",
  getRequestHeaders: async () => ({ Authorization: "Bearer fake" }),
};
const client = new AnthropicVertex({
  projectId: "test-project",
  region: "global",
  authClient: fakeAuth as any,
  maxRetries: 0,
  fetch: async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-opus-4-8",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  },
});
await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 1,
  messages: [{ role: "user", content: "hi" }],
});
equal(urls.length, 1, "fake transport call count");
equal(
  urls[0],
  "https://aiplatform.googleapis.com/v1/projects/test-project/locations/" +
    "global/publishers/anthropic/models/claude-opus-4-8:rawPredict",
  "0.16.1 rawPredict endpoint",
);
if (urls[0].includes("/v1/v1/messages")) fail("transport retained /v1/v1/messages");
console.log("vertex-claude behavior harness passed");
