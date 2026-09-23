import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import vertexClaudeExtension, {
  DOCUMENTED_VERTEX_MODELS,
  addAliases,
  classifyDiagnosticError,
  loadAliasOverrides,
  modelsFromEnv,
  parseClaudeModel,
  vertexThinkingOptions,
} from "./index.js";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { Effect, FileSystem } from "effect";
import type { Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { join } from "node:path";

const expectedManifest = [
  "claude-opus-5-5",
  "claude-opus-5",
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
const rejectsContaining = async (fn: () => Promise<unknown>, expected: string, label: string) => {
  try {
    await fn();
    fail(`${label}: did not reject`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expected)) fail(`${label}: expected ${expected}, got ${message}`);
  }
};
const runWithFileSystem = <A, E>(program: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(program.pipe(Effect.provide(NodeFileSystem.layer)));
const makeTempDirectory = (prefix: string) =>
  runWithFileSystem(
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.makeTempDirectory({ prefix })),
  );
const writeText = (path: string, content: string) =>
  runWithFileSystem(
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.writeFileString(path, content),
    ),
  );
const removePath = (path: string) =>
  runWithFileSystem(
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.remove(path, { recursive: true, force: true }),
    ),
  );
interface RegisteredModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly compat?: Readonly<Record<string, unknown>>;
  readonly cost: unknown;
  readonly input: unknown;
}
interface RegisteredProvider {
  readonly models: readonly RegisteredModel[];
}
const isRegisteredModel = (value: unknown): value is RegisteredModel =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  "name" in value &&
  typeof value.name === "string" &&
  "contextWindow" in value &&
  typeof value.contextWindow === "number" &&
  "maxTokens" in value &&
  typeof value.maxTokens === "number" &&
  "cost" in value &&
  "input" in value;
const isRegisteredProvider = (value: unknown): value is RegisteredProvider =>
  typeof value === "object" &&
  value !== null &&
  "models" in value &&
  Array.isArray(value.models) &&
  value.models.every(isRegisteredModel);
const captureProvider = (capture: (provider: RegisteredProvider) => void): ExtensionAPI =>
  ({
    registerProvider: (_id: string, value: unknown) => {
      if (isRegisteredProvider(value)) capture(value);
      else fail("invalid registered provider");
    },
    registerCommand: () => {},
  }) as unknown as ExtensionAPI;
const requireProvider = (provider: RegisteredProvider | undefined, label: string) =>
  provider ?? fail(`${label} provider was not registered`);
const requireModel = (models: Map<string, RegisteredModel>, id: string) =>
  models.get(id) ?? fail(`registered ${id}`);
const asAnthropicModel = (model: RegisteredModel) =>
  model as unknown as Model<"anthropic-messages">;

equal(
  JSON.stringify(DOCUMENTED_VERTEX_MODELS.map((model) => model.id)),
  JSON.stringify(expectedManifest),
  "exact manifest",
);
for (const model of DOCUMENTED_VERTEX_MODELS) {
  if (!["active", "deprecated"].includes(model.lifecycle)) fail(`manifest lifecycle ${model.id}`);
  if (
    model.aliasEligible !==
    (model.id === "claude-opus-5-5" ||
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
  opus: "claude-opus-5-5",
  "claude-opus": "claude-opus-5-5",
  sonnet: "claude-sonnet-5",
  "claude-sonnet": "claude-sonnet-5",
  haiku: "claude-haiku-4-5@20251001",
  "claude-haiku": "claude-haiku-4-5@20251001",
  fable: "claude-fable-5",
  "claude-fable": "claude-fable-5",
}))
  equal(aliases.get(alias), target, `alias ${alias}`);

const aliasConfigDir = await makeTempDirectory("vertex-claude-alias-test-");
const aliasConfigPath = join(aliasConfigDir, "vertex-claude.json");
try {
  equal(
    JSON.stringify(await runWithFileSystem(loadAliasOverrides(aliasConfigPath))),
    "{}",
    "missing alias config",
  );
  await writeText(aliasConfigPath, JSON.stringify({ aliases: { opus: "claude-opus-4-6" } }));
  const configuredAliases = new Map(
    addAliases(
      DOCUMENTED_VERTEX_MODELS,
      true,
      await runWithFileSystem(loadAliasOverrides(aliasConfigPath)),
    )
      .filter((model) => model.aliasTarget)
      .map((model) => [model.id, model.aliasTarget]),
  );
  equal(configuredAliases.get("opus"), "claude-opus-4-6", "configured opus alias");
  equal(configuredAliases.get("claude-opus"), "claude-opus-4-6", "configured claude-opus alias");
  equal(configuredAliases.get("sonnet"), "claude-sonnet-5", "independent sonnet default");

  await writeText(aliasConfigPath, "{");
  await rejectsContaining(
    () => runWithFileSystem(loadAliasOverrides(aliasConfigPath)),
    "Failed to parse",
    "malformed config",
  );
  await rejectsContaining(
    () => runWithFileSystem(loadAliasOverrides(aliasConfigDir)),
    "Failed to read",
    "unreadable config",
  );
  await writeText(aliasConfigPath, JSON.stringify({ aliases: { mythos: "claude-mythos-5" } }));
  await rejectsContaining(
    () => runWithFileSystem(loadAliasOverrides(aliasConfigPath)),
    `${aliasConfigPath} contains an unknown alias family: mythos`,
    "unknown alias family",
  );
  throws(
    () => addAliases(DOCUMENTED_VERTEX_MODELS, true, { opus: "claude-sonnet-5" }),
    "Vertex Claude opus alias target belongs to sonnet: claude-sonnet-5",
    "wrong alias family",
  );
  throws(
    () => addAliases(DOCUMENTED_VERTEX_MODELS, true, { opus: "claude-opus-9" }),
    "Vertex Claude opus alias target is not registered: claude-opus-9",
    "unavailable alias target",
  );
} finally {
  await removePath(aliasConfigDir);
}

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
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedModelsOverride = process.env.VERTEX_CLAUDE_MODELS;
const registrationConfigDir = await makeTempDirectory("vertex-claude-registration-test-");
process.env.PI_CODING_AGENT_DIR = registrationConfigDir;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("startup must not fetch");
}) as typeof fetch;
try {
  // A query string forces a fresh extension-module evaluation after fetch is guarded.
  const guardSpecifier: string = "./index.js?startup-network-guard";
  const guardedExtension = await import(guardSpecifier);
  let capturedProvider: RegisteredProvider | undefined;
  await guardedExtension.default(captureProvider((value) => (capturedProvider = value)));
  const provider = requireProvider(capturedProvider, "default");
  equal(fetchCalls, 0, "import, initialization, and model registration have no startup network");
  const registered = new Map(provider.models.map((entry) => [entry.id, entry]));
  for (const id of ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "sonnet"]) {
    const registeredModel = requireModel(registered, id);
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
      ] as const)
        equal(
          JSON.stringify(registeredModel[field]),
          JSON.stringify(catalog[field]),
          `${id} inherited ${field}`,
        );
  }
  equal(
    requireModel(registered, "opus").name.includes("claude-opus-5-5"),
    true,
    "alias metadata target",
  );
  for (const id of ["claude-opus-5-5", "opus", "claude-opus"]) {
    const opus55 = requireModel(registered, id);
    equal(opus55.contextWindow, 1_000_000, `${id} fallback context`);
    equal(opus55.maxTokens, 128_000, `${id} fallback output`);
    equal(opus55.thinkingLevelMap?.off, null, `${id} always-on thinking`);
    equal(opus55.compat?.forceAdaptiveThinking, true, `${id} adaptive thinking`);
    equal(opus55.compat?.supportsMidConvoEffort, true, `${id} per-message effort`);
    equal(
      JSON.stringify(opus55.cost),
      JSON.stringify({
        input: 4,
        output: 20,
        cacheRead: 0.2,
        cacheWrite: 5,
      }),
      `${id} fallback cost`,
    );
  }
  const opus55Context = { messages: [] };
  const opus55Default = vertexThinkingOptions(
    asAnthropicModel(requireModel(registered, aliases.get("opus")!)),
    opus55Context,
    {},
  );
  equal(opus55Default.thinkingEnabled, true, "Opus 5.5 default adaptive thinking");
  equal(opus55Default.effort, "medium", "Opus 5.5 default effort");
  const opus55Explicit = vertexThinkingOptions(
    asAnthropicModel(requireModel(registered, aliases.get("claude-opus")!)),
    opus55Context,
    { reasoning: "max" },
  );
  equal(opus55Explicit.thinkingEnabled, true, "Opus 5.5 explicit adaptive thinking");
  equal(opus55Explicit.effort, "max", "Opus 5.5 explicit effort");
  equal(
    requireModel(registered, "claude-opus-4-8").compat?.forceAdaptiveThinking,
    true,
    "Opus adaptive thinking metadata",
  );
  equal(
    requireModel(registered, "claude-opus-4-8").compat?.supportsTemperature,
    false,
    "Opus temperature metadata",
  );
  equal(
    requireModel(registered, "claude-sonnet-5").compat?.forceAdaptiveThinking,
    true,
    "Sonnet adaptive thinking metadata",
  );

  await writeText(
    join(registrationConfigDir, "vertex-claude.json"),
    JSON.stringify({ aliases: { opus: "claude-opus-4-6" } }),
  );
  const configuredSpecifier: string = "./index.js?configured-alias-registration";
  const configuredExtension = await import(configuredSpecifier);
  let capturedConfiguredProvider: RegisteredProvider | undefined;
  await configuredExtension.default(
    captureProvider((value) => (capturedConfiguredProvider = value)),
  );
  const configuredProvider = requireProvider(capturedConfiguredProvider, "configured");
  const configuredRegistered = new Map(configuredProvider.models.map((entry) => [entry.id, entry]));
  for (const id of ["opus", "claude-opus"])
    equal(
      requireModel(configuredRegistered, id).name.includes("configured: claude-opus-4-6"),
      true,
      `${id} configured registration`,
    );
  equal(
    requireModel(configuredRegistered, "sonnet").name.includes("latest: claude-sonnet-5"),
    true,
    "sonnet default registration",
  );

  process.env.VERTEX_CLAUDE_MODELS = "claude-opus-5-5,claude-sonnet-5";
  const restrictedSpecifier: string = "./index.js?restricted-configured-alias";
  const restrictedExtension = await import(restrictedSpecifier);
  await rejectsContaining(
    () => restrictedExtension.default(captureProvider(() => {})),
    "Vertex Claude opus alias target is not registered: claude-opus-4-6",
    "configured alias excluded by model override",
  );
} finally {
  if (savedModelsOverride === undefined) delete process.env.VERTEX_CLAUDE_MODELS;
  else process.env.VERTEX_CLAUDE_MODELS = savedModelsOverride;
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  await removePath(registrationConfigDir);
  globalThis.fetch = originalFetch;
}

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
