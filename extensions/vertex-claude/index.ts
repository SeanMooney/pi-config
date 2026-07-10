import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AnthropicOptions, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getModel, streamAnthropic } from "@earendil-works/pi-ai/compat";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleAuth } from "google-auth-library";

const PROVIDER = "vertex-claude";
const AUTH_MARKER = "gcp-vertex-credentials";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type Family = "opus" | "sonnet" | "haiku" | "fable";
type Lifecycle = "active" | "deprecated" | "custom";
type ReasoningLevel = NonNullable<SimpleStreamOptions["reasoning"]>;
type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface VertexClaudeModel {
  id: string;
  name: string;
  family?: Family;
  major: number;
  minor: number;
  lifecycle: Lifecycle;
  /** Explicitly controls manifest aliases; never infer lifecycle from a version. */
  aliasEligible: boolean;
  aliasTarget?: string;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveProjectId(): string | undefined {
  return env("ANTHROPIC_VERTEX_PROJECT_ID") ?? env("GOOGLE_CLOUD_PROJECT") ?? env("GCLOUD_PROJECT");
}

function resolveRegion(): string | undefined {
  return env("CLOUD_ML_REGION") ?? env("GOOGLE_CLOUD_LOCATION");
}

function vertexBaseUrl(region: string): string {
  const override = env("ANTHROPIC_VERTEX_BASE_URL");
  if (override) return override;
  if (region === "global") return "https://aiplatform.googleapis.com/v1";
  if (region === "us") return "https://aiplatform.us.rep.googleapis.com/v1";
  if (region === "eu") return "https://aiplatform.eu.rep.googleapis.com/v1";
  return `https://${region}-aiplatform.googleapis.com/v1`;
}

function normalizeModelId(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

function humanizeModelName(id: string): string {
  return id
    .replace(/@.*$/, "")
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

const FAMILY_FIRST_CLAUDE_MODEL_RE =
  /^claude-(?<family>opus|sonnet|haiku|fable)-(?<major>\d+)(?:-(?<minor>\d+))?(?:@\d{8})?$/i;
const HISTORICAL_CLAUDE_MODEL_RE = new RegExp(
  [
    "^claude-(?<major>\\d+)(?:-(?<minor>\\d+))?-",
    "(?<family>opus|sonnet|haiku|fable)(?:-v\\d+)?(?:@\\d{8})?$",
  ].join(""),
  "i",
);

export function parseClaudeModel(id: string): VertexClaudeModel | undefined {
  // Vertex IDs are either family-first (claude-opus-4-8) or the historical
  // version-first form (claude-3-5-haiku), optionally with an eight-digit
  // publisher revision. Do not accept arbitrary claude-* strings as overrides.
  const match = id.match(FAMILY_FIRST_CLAUDE_MODEL_RE) ?? id.match(HISTORICAL_CLAUDE_MODEL_RE);
  if (!match?.groups) return undefined;
  const family = match.groups.family.toLowerCase() as Family;

  return {
    id,
    name: humanizeModelName(id),
    family,
    major: Number(match.groups.major ?? match.groups.historicalMajor),
    minor: Number(match.groups.minor ?? match.groups.historicalMinor ?? 0),
    lifecycle: "custom",
    aliasEligible: true,
  };
}

function lexicalDateScore(id: string): number {
  const match = id.match(/@([0-9]{8})$/);
  return match ? Number(match[1]) : 0;
}

function versionScore(model: VertexClaudeModel): number {
  return model.major * 1_000_000_000_000 + model.minor * 1_000_000_000 + lexicalDateScore(model.id);
}

// Documented usable Vertex AI publisher model IDs, maintained from:
// https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude
// https://docs.anthropic.com/en/docs/about-claude/models/overview
// Retired models are deliberately absent. Deprecated-but-not-retired entries remain
// registered for existing Vertex users, but never become aliases.
export const DOCUMENTED_VERTEX_MODELS: readonly VertexClaudeModel[] = [
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    family: "opus",
    major: 4,
    minor: 8,
    lifecycle: "active",
    aliasEligible: true,
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    family: "opus",
    major: 4,
    minor: 7,
    lifecycle: "active",
    aliasEligible: false,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    family: "opus",
    major: 4,
    minor: 6,
    lifecycle: "active",
    aliasEligible: false,
  },
  {
    id: "claude-opus-4-5@20251101",
    name: "Claude Opus 4.5",
    family: "opus",
    major: 4,
    minor: 5,
    lifecycle: "deprecated",
    aliasEligible: false,
  },
  {
    id: "claude-opus-4-1@20250805",
    name: "Claude Opus 4.1",
    family: "opus",
    major: 4,
    minor: 1,
    lifecycle: "deprecated",
    aliasEligible: false,
  },
  {
    id: "claude-opus-4@20250514",
    name: "Claude Opus 4",
    family: "opus",
    major: 4,
    minor: 0,
    lifecycle: "deprecated",
    aliasEligible: false,
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    family: "sonnet",
    major: 5,
    minor: 0,
    lifecycle: "active",
    aliasEligible: true,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    family: "sonnet",
    major: 4,
    minor: 6,
    lifecycle: "active",
    aliasEligible: false,
  },
  {
    id: "claude-sonnet-4-5@20250929",
    name: "Claude Sonnet 4.5",
    family: "sonnet",
    major: 4,
    minor: 5,
    lifecycle: "deprecated",
    aliasEligible: false,
  },
  {
    id: "claude-sonnet-4@20250514",
    name: "Claude Sonnet 4",
    family: "sonnet",
    major: 4,
    minor: 0,
    lifecycle: "deprecated",
    aliasEligible: false,
  },
  {
    id: "claude-haiku-4-5@20251001",
    name: "Claude Haiku 4.5",
    family: "haiku",
    major: 4,
    minor: 5,
    lifecycle: "active",
    aliasEligible: true,
  },
  {
    id: "claude-3-5-haiku@20241022",
    name: "Claude Haiku 3.5",
    family: "haiku",
    major: 3,
    minor: 5,
    lifecycle: "deprecated",
    aliasEligible: false,
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    family: "fable",
    major: 5,
    minor: 0,
    lifecycle: "active",
    aliasEligible: true,
  },
];

const manifestById = new Map(DOCUMENTED_VERTEX_MODELS.map((model) => [model.id, model]));

export function modelsFromEnv(): VertexClaudeModel[] {
  const raw = process.env.VERTEX_CLAUDE_MODELS;
  if (raw === undefined) return [];
  if (!raw.trim())
    throw new Error(
      "VERTEX_CLAUDE_MODELS is set but empty; unset it to use the Vertex Claude manifest.",
    );
  return raw.split(",").map((value) => {
    const id = normalizeModelId(value);
    if (!id) throw new Error("VERTEX_CLAUDE_MODELS contains an empty model ID.");
    const model = manifestById.get(id) ?? parseClaudeModel(id);
    if (!model) throw new Error(`Invalid Vertex Claude model ID in VERTEX_CLAUDE_MODELS: ${id}`);
    return model;
  });
}

function dedupe(models: readonly VertexClaudeModel[]): VertexClaudeModel[] {
  const byId = new Map<string, VertexClaudeModel>();
  for (const model of models) byId.set(model.id, model);
  return [...byId.values()].sort(
    (a, b) => versionScore(b) - versionScore(a) || a.id.localeCompare(b.id),
  );
}

export function addAliases(
  models: readonly VertexClaudeModel[],
  manifestMode: boolean,
): VertexClaudeModel[] {
  const result = [...models];
  for (const family of ["opus", "sonnet", "haiku", "fable"] as const) {
    const candidates = models.filter(
      (model) => model.family === family && (!manifestMode || model.aliasEligible),
    );
    const best = candidates.sort(
      (a, b) => versionScore(b) - versionScore(a) || a.id.localeCompare(b.id),
    )[0];
    if (!best) continue;
    const displayFamily = `${family[0].toUpperCase()}${family.slice(1)}`;
    for (const id of [family, `claude-${family}`]) {
      result.push({
        ...best,
        id,
        name: `Claude ${displayFamily} (latest: ${best.id})`,
        aliasTarget: best.id,
      });
    }
  }
  return result;
}

function anthropicCatalogModel(modelId: string): Model<"anthropic-messages"> | undefined {
  const baseId = modelId.replace(/@.*$/, "");
  const catalog = getModel("anthropic", baseId as never);
  return catalog?.api === "anthropic-messages" ? catalog : undefined;
}

function toPiModel(model: VertexClaudeModel) {
  const catalog = anthropicCatalogModel(model.aliasTarget ?? model.id);
  // The host catalog is authoritative whenever it recognizes the base model ID.
  // This retains Vertex's exact request ID while inheriting Pi's continuously
  // updated compat, thinking, input, cost, context, and output metadata.
  return {
    id: model.id,
    name: model.name,
    reasoning: catalog?.reasoning ?? true,
    thinkingLevelMap: catalog?.thinkingLevelMap,
    input: catalog?.input ?? (["text", "image"] as ("text" | "image")[]),
    cost: catalog?.cost ?? DEFAULT_COST,
    contextWindow: catalog?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: catalog?.maxTokens ?? DEFAULT_MAX_TOKENS,
    compat: catalog?.compat,
  };
}

function effortForReasoning(
  level: ReasoningLevel,
  model: Model<"anthropic-messages">,
): AnthropicEffort {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return mapped as AnthropicEffort;
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    default:
      return "high";
  }
}

function legacyThinkingBudget(
  level: ReasoningLevel,
  options: SimpleStreamOptions | undefined,
): number {
  const budgets = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
    ...options?.thinkingBudgets,
  };
  const normalizedLevel = level === "xhigh" || level === "max" ? "high" : level;
  return budgets[normalizedLevel];
}

function legacyMaxTokens(
  model: Model<"anthropic-messages">,
  options: SimpleStreamOptions | undefined,
  budget: number,
): number {
  // Mirrors Pi's public simple-stream behavior: reserve 1K output tokens and
  // expand an explicit output cap by the legacy thinking budget where possible.
  const base = options?.maxTokens ?? model.maxTokens;
  const maxTokens =
    options?.maxTokens === undefined ? model.maxTokens : Math.min(base + budget, model.maxTokens);
  return Math.min(model.maxTokens, Math.max(1, maxTokens));
}

function estimateContextTokens(context: Context): number {
  const safeJson = (value: unknown) => {
    try {
      return JSON.stringify(value) ?? "undefined";
    } catch {
      return "[unserializable]";
    }
  };
  const contentTokens = (content: unknown): number => {
    if (typeof content === "string") return Math.ceil(content.length / 4);
    if (!Array.isArray(content)) return 0;
    return Math.ceil(
      content.reduce(
        (chars, block: any) => chars + (block.type === "text" ? block.text.length : 4800),
        0,
      ) / 4,
    );
  };
  const messageTokens = (message: any): number => {
    if (message.role === "user" || message.role === "toolResult")
      return contentTokens(message.content);
    return Math.ceil(
      message.content.reduce(
        (chars: number, block: any) =>
          chars +
          (block.type === "text"
            ? block.text.length
            : block.type === "thinking"
              ? block.thinking.length
              : block.name.length + safeJson(block.arguments).length),
        0,
      ) / 4,
    );
  };
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
  let usage:
    | {
        totalTokens?: number;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      }
    | undefined;
  let usageIndex = -1;
  for (let index = 0; index < context.messages.length; index++) {
    const message: any = context.messages[index];
    const total =
      message.usage &&
      (message.usage.totalTokens ||
        message.usage.input +
          message.usage.output +
          message.usage.cacheRead +
          message.usage.cacheWrite);
    if (
      message.role === "assistant" &&
      message.timestamp >= latestPrefixTimestamp &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "error" &&
      total > 0
    ) {
      usage = message.usage;
      usageIndex = index;
    }
    latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
  }
  if (usage)
    return (
      (usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite) +
      context.messages
        .slice(usageIndex + 1)
        .reduce((total, message) => total + messageTokens(message), 0)
    );
  return (
    context.messages.reduce((total, message) => total + messageTokens(message), 0) +
    (context.systemPrompt ? Math.ceil(context.systemPrompt.length / 4) : 0) +
    (context.tools?.length ? Math.ceil(safeJson(context.tools).length / 4) : 0)
  );
}

export function clampMaxTokensToContext(
  model: Model<"anthropic-messages">,
  context: Context,
  maxTokens: number,
): number {
  if (model.contextWindow <= 0) return Math.max(1, maxTokens);
  return Math.min(
    maxTokens,
    Math.max(1, model.contextWindow - estimateContextTokens(context) - 4096),
  );
}

export function vertexThinkingOptions(
  model: Model<"anthropic-messages">,
  context: Context,
  options?: SimpleStreamOptions,
): Pick<AnthropicOptions, "maxTokens" | "thinkingEnabled" | "thinkingBudgetTokens" | "effort"> {
  const maxTokens = clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens);
  if (!options?.reasoning) return { maxTokens, thinkingEnabled: false };
  if (model.compat?.forceAdaptiveThinking === true)
    return {
      maxTokens,
      thinkingEnabled: true,
      effort: effortForReasoning(options.reasoning, model),
    };
  const budget = legacyThinkingBudget(options.reasoning, options);
  const expandedMaxTokens = legacyMaxTokens(model, options, budget);
  const clampedMaxTokens = clampMaxTokensToContext(model, context, expandedMaxTokens);
  // The Anthropic builder treats a zero budget as 1024.  If there is not room
  // for that minimum budget plus a 1024-token output reserve, omit thinking.
  if (clampedMaxTokens <= 2048) return { maxTokens: clampedMaxTokens, thinkingEnabled: false };
  return {
    maxTokens: clampedMaxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens: Math.min(budget, clampedMaxTokens - 1024),
  };
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

export function classifyDiagnosticError(error: unknown): string {
  const status = errorStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  // Numeric HTTP statuses are authoritative even when a wrapped Error has a
  // misleading message (for example, a 403 mentioning quota).
  if (status === 401) return "missing ADC/auth configuration";
  if (status === 403) return "permission failure";
  if (status === 404)
    return "ambiguous 404 (model, region, project, or model-access configuration)";
  if (status === 429) return "quota or rate-limit failure";
  if (/default credentials|could not load the default credentials|credential/i.test(message))
    return "missing ADC/auth configuration";
  if (/permission denied|does not have permission|forbidden/i.test(message))
    return "permission failure";
  if (/quota|rate limit|resource exhausted/i.test(message)) return "quota or rate-limit failure";
  if (/enotfound|econnrefused|econnreset|network|fetch failed|timed out|timeout/i.test(message))
    return "network failure";
  return "request/authentication failure";
}

function briefError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240);
}

function reportDiagnostic(
  ctx: {
    hasUI: boolean;
    ui: { notify(message: string, level: "info" | "warning" | "error"): void };
  },
  lines: string[],
  level: "info" | "warning" | "error",
) {
  const message = lines.join("\n");
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(`[vertex-claude] ${message}`);
}

async function validateAdc(): Promise<void> {
  // This deliberately obtains ADC only when /vertex-claude-diagnose is run.
  // Startup and --list-models remain entirely local and do not contact Vertex.
  const auth = new GoogleAuth({
    scopes: "https://www.googleapis.com/auth/cloud-platform",
  });
  const client = await auth.getClient();
  await client.getRequestHeaders();
}

export default function vertexClaudeExtension(pi: ExtensionAPI) {
  const configured = modelsFromEnv();
  const manifestMode = process.env.VERTEX_CLAUDE_MODELS === undefined;
  const concreteModels = dedupe(manifestMode ? DOCUMENTED_VERTEX_MODELS : configured);
  const modelList = addAliases(concreteModels, manifestMode);
  const aliasTargets = new Map(
    modelList.flatMap((model) =>
      model.aliasTarget ? [[model.id, model.aliasTarget] as const] : [],
    ),
  );

  let cachedClient: AnthropicVertex | undefined;
  let cachedProjectId: string | undefined;
  let cachedRegion: string | undefined;
  let cachedBaseUrl: string | undefined;
  function getVertexClient(projectId: string, region: string): AnthropicVertex {
    const baseURL = vertexBaseUrl(region);
    if (
      !cachedClient ||
      cachedProjectId !== projectId ||
      cachedRegion !== region ||
      cachedBaseUrl !== baseURL
    ) {
      cachedClient = new AnthropicVertex({ projectId, region, baseURL });
      cachedProjectId = projectId;
      cachedRegion = region;
      cachedBaseUrl = baseURL;
    }
    return cachedClient;
  }

  pi.registerProvider(PROVIDER, {
    name: "Vertex Claude",
    baseUrl: resolveRegion()
      ? vertexBaseUrl(resolveRegion()!)
      : "https://aiplatform.googleapis.com/v1",
    // Pi requires a provider with models to declare auth. Vertex requests use
    // ADC through AnthropicVertex; this marker is never sent as a credential.
    apiKey: AUTH_MARKER,
    api: "anthropic-messages",
    models: modelList.map(toPiModel),
    streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
      const projectId = resolveProjectId();
      const region = resolveRegion();
      if (!projectId)
        throw new Error(
          "Missing ANTHROPIC_VERTEX_PROJECT_ID, GOOGLE_CLOUD_PROJECT, " +
            "or GCLOUD_PROJECT for vertex-claude",
        );
      if (!region)
        throw new Error("Missing CLOUD_ML_REGION or GOOGLE_CLOUD_LOCATION for vertex-claude");

      const targetId = aliasTargets.get(model.id) ?? model.id;
      // Spread the registered model so inherited compat remains present after
      // replacing an alias with its concrete Vertex request ID.
      const targetModel = {
        ...model,
        id: targetId,
        name: model.name ?? targetId,
      } as Model<"anthropic-messages">;
      const base: AnthropicOptions = {
        ...options,
        apiKey: AUTH_MARKER,
        client: getVertexClient(projectId, region) as any,
      };
      return streamAnthropic(targetModel, context, {
        ...base,
        ...vertexThinkingOptions(targetModel, context, options),
      });
    },
  });

  pi.registerCommand("vertex-claude-diagnose", {
    description:
      "Validate Vertex Claude configuration, or probe one explicit model " +
      "(may incur a small charge)",
    handler: async (args, ctx) => {
      const projectId = resolveProjectId();
      const region = resolveRegion();
      if (!projectId || !region) {
        reportDiagnostic(
          ctx,
          [
            "Vertex Claude diagnostic: missing configuration.",
            ...(!projectId
              ? ["Set ANTHROPIC_VERTEX_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or GCLOUD_PROJECT."]
              : []),
            ...(!region ? ["Set CLOUD_ML_REGION or GOOGLE_CLOUD_LOCATION."] : []),
          ],
          "error",
        );
        return;
      }

      const endpoint = vertexBaseUrl(region);
      try {
        await validateAdc();
      } catch (error) {
        reportDiagnostic(
          ctx,
          [`Vertex Claude diagnostic: ${classifyDiagnosticError(error)}.`, briefError(error)],
          "error",
        );
        return;
      }

      const requested = normalizeModelId(args);
      if (!requested) {
        reportDiagnostic(
          ctx,
          [
            "Vertex Claude diagnostic: configuration and ADC are ready.",
            `Project: ${projectId}; region: ${region}; endpoint: ${endpoint}`,
            "No model was probed. Run /vertex-claude-diagnose <model> " +
              "for an explicit access probe.",
          ],
          "info",
        );
        return;
      }

      const targetId = aliasTargets.get(requested) ?? requested;
      try {
        await getVertexClient(projectId, region).messages.create({
          model: targetId,
          max_tokens: 1,
          messages: [{ role: "user", content: "ok" }],
        });
        reportDiagnostic(
          ctx,
          [
            `Vertex Claude diagnostic: ${targetId} access probe succeeded.`,
            "A minimal inference was requested and may incur a small charge.",
          ],
          "info",
        );
      } catch (error) {
        const status = errorStatus(error);
        reportDiagnostic(
          ctx,
          [
            `Vertex Claude diagnostic: ${targetId} probe failed: ` +
              `${classifyDiagnosticError(error)}${status ? ` (HTTP ${status})` : ""}.`,
            briefError(error),
            status === 404
              ? "A 404 is ambiguous and does not by itself prove an entitlement failure."
              : "",
          ].filter(Boolean),
          "error",
        );
      }
    },
  });
}
