import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { streamAnthropic, type Context, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleAuth } from "google-auth-library";

const PROVIDER = "vertex-claude";
const AUTH_MARKER = "gcp-vertex-credentials";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const DISCOVERY_TIMEOUT_MS = 10_000;

type ReasoningLevel = NonNullable<SimpleStreamOptions["reasoning"]>;
type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

interface VertexClaudeModel {
	id: string;
	name: string;
	family: "opus" | "sonnet" | "haiku";
	major: number;
	minor: number;
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

function parseClaudeModel(id: string, displayName?: string): VertexClaudeModel | undefined {
	const haystack = `${id} ${displayName ?? ""}`.toLowerCase();
	const family = haystack.includes("opus")
		? "opus"
		: haystack.includes("sonnet")
			? "sonnet"
			: haystack.includes("haiku")
				? "haiku"
				: undefined;
	if (!family) return undefined;

	const familyIndex = haystack.indexOf(family);
	const afterFamily = familyIndex >= 0 ? haystack.slice(familyIndex + family.length) : haystack;
	const beforeFamily = familyIndex >= 0 ? haystack.slice(0, familyIndex) : haystack;
	const versionMatch =
		afterFamily.match(/(?:^|[-\s])([0-9]+)(?:[.-]([0-9]+))?/) ??
		beforeFamily.match(/(?:claude[-\s])([0-9]+)(?:[.-]([0-9]+))?/);
	if (!versionMatch) return undefined;

	return {
		id,
		name: displayName?.trim() || humanizeModelName(id),
		family,
		major: Number(versionMatch[1]),
		minor: versionMatch[2] ? Number(versionMatch[2]) : 0,
	};
}

function humanizeModelName(id: string): string {
	return id
		.replace(/@.*$/, "")
		.split("-")
		.map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
		.join(" ");
}

function versionScore(model: VertexClaudeModel): number {
	return model.major * 1_000_000_000_000 + model.minor * 1_000_000_000 + lexicalDateScore(model.id);
}

function lexicalDateScore(id: string): number {
	const match = id.match(/(?:@|-)(20\d{6})$/);
	return match ? Number(match[1]) : 0;
}

// Docs-derived fallback list for startup when publisher-model discovery is disabled or unavailable.
// Source: https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude
// Projects without access to a listed model can set VERTEX_CLAUDE_MODELS to an explicit known-good list.
const FALLBACK_MODELS: VertexClaudeModel[] = [
	{ id: "claude-opus-4-7", name: "Claude Opus 4.7", family: "opus", major: 4, minor: 7 },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", family: "sonnet", major: 4, minor: 6 },
	{ id: "claude-opus-4-6", name: "Claude Opus 4.6", family: "opus", major: 4, minor: 6 },
	{ id: "claude-opus-4-5", name: "Claude Opus 4.5", family: "opus", major: 4, minor: 5 },
	{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", family: "sonnet", major: 4, minor: 5 },
	{ id: "claude-opus-4-1", name: "Claude Opus 4.1", family: "opus", major: 4, minor: 1 },
	{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", family: "haiku", major: 4, minor: 5 },
	{ id: "claude-opus-4", name: "Claude Opus 4", family: "opus", major: 4, minor: 0 },
	{ id: "claude-sonnet-4", name: "Claude Sonnet 4", family: "sonnet", major: 4, minor: 0 },
];

function modelsFromEnv(): VertexClaudeModel[] {
	const configured = env("VERTEX_CLAUDE_MODELS");
	if (!configured) return [];
	return configured
		.split(",")
		.map((s) => normalizeModelId(s))
		.filter((s): s is string => Boolean(s))
		.map((id) => parseClaudeModel(id))
		.filter((m): m is VertexClaudeModel => Boolean(m));
}

async function discoverModels(projectId: string | undefined, region: string | undefined): Promise<VertexClaudeModel[]> {
	if (!projectId || !region || env("VERTEX_CLAUDE_DISABLE_DISCOVERY") === "1") return [];

	try {
		return await withTimeout(discoverModelsInner(projectId, region), DISCOVERY_TIMEOUT_MS);
	} catch (error) {
		debugLog("model discovery failed", error);
		return [];
	}
}

async function discoverModelsInner(projectId: string, region: string): Promise<VertexClaudeModel[]> {
	const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
	const client = await auth.getClient();
	const headers = await client.getRequestHeaders();
	const url = `${vertexBaseUrl(region)}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/publishers/anthropic/models`;
	const response = await fetch(url, {
		headers: headers as HeadersInit,
		signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	});
	if (!response.ok) return [];

	const payload = (await response.json()) as {
		publisherModels?: Array<{ name?: string; displayName?: string; versionId?: string }>;
		models?: Array<{ name?: string; displayName?: string; versionId?: string }>;
	};
	const rows = payload.publisherModels ?? payload.models ?? [];
	return rows
		.map((row) => ({
			id: normalizeModelId(row.name ?? row.versionId ?? ""),
			displayName: row.displayName,
		}))
		.filter((item): item is { id: string; displayName: string | undefined } => Boolean(item.id))
		.map(({ id, displayName }) => parseClaudeModel(id, displayName))
		.filter((m): m is VertexClaudeModel => Boolean(m));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

function debugLog(message: string, error?: unknown): void {
	if (env("VERTEX_CLAUDE_DEBUG") !== "1") return;
	const suffix = error instanceof Error ? `: ${error.message}` : error === undefined ? "" : `: ${String(error)}`;
	console.warn(`[vertex-claude] ${message}${suffix}`);
}

function dedupe(models: VertexClaudeModel[]): VertexClaudeModel[] {
	const byId = new Map<string, VertexClaudeModel>();
	for (const model of models) byId.set(model.id, model);
	return [...byId.values()].sort((a, b) => versionScore(b) - versionScore(a) || a.id.localeCompare(b.id));
}

function currentMajorModels(models: VertexClaudeModel[]): VertexClaudeModel[] {
	if (models.length === 0) return [];
	const currentMajor = Math.max(...models.map((m) => m.major));
	return models.filter((m) => m.major === currentMajor);
}

function addAliases(models: VertexClaudeModel[]): VertexClaudeModel[] {
	const result = [...models];
	for (const family of ["opus", "sonnet", "haiku"] as const) {
		const best = models.filter((m) => m.family === family).sort((a, b) => versionScore(b) - versionScore(a))[0];
		if (!best) continue;
		result.push({
			...best,
			id: family,
			name: `Claude ${family[0].toUpperCase()}${family.slice(1)} (latest: ${best.id})`,
			aliasTarget: best.id,
		});
		result.push({
			...best,
			id: `claude-${family}`,
			name: `Claude ${family[0].toUpperCase()}${family.slice(1)} (latest: ${best.id})`,
			aliasTarget: best.id,
		});
	}
	return result;
}

function toPiModel(model: VertexClaudeModel) {
	return {
		id: model.id,
		name: model.name,
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function effortForReasoning(level: ReasoningLevel, modelId: string): AnthropicEffort {
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "xhigh":
			if (modelId.includes("opus-4-6") || modelId.includes("opus.4.6")) return "max";
			if (modelId.includes("opus-4-7") || modelId.includes("opus.4.7")) return "xhigh";
			return "high";
		case "high":
		default:
			return "high";
	}
}

function thinkingBudget(level: ReasoningLevel): number {
	switch (level) {
		case "minimal":
			return 1_024;
		case "low":
			return 4_096;
		case "medium":
			return 8_192;
		case "xhigh":
			return 32_768;
		case "high":
		default:
			return 16_384;
	}
}

function maxTokensForThinking(model: Model<any>, options: SimpleStreamOptions | undefined, budget: number): number {
	const defaultMaxTokens = Math.floor(model.maxTokens / 3);
	const requestedMaxTokens = options?.maxTokens ?? defaultMaxTokens;
	return Math.min(model.maxTokens, Math.max(requestedMaxTokens, budget + 1_024));
}

export default async function vertexClaudeExtension(pi: ExtensionAPI) {
	const projectId = resolveProjectId();
	const region = resolveRegion();
	const discovered = await discoverModels(projectId, region);
	const configured = modelsFromEnv();
	const sourceModels = env("VERTEX_CLAUDE_MODELS") ? configured : [...discovered, ...FALLBACK_MODELS];
	const modelList = addAliases(currentMajorModels(dedupe(sourceModels)));
	const aliasTargets = new Map(modelList.filter((m) => m.aliasTarget).map((m) => [m.id, m.aliasTarget!]));

	let cachedClient: AnthropicVertex | undefined;
	let cachedProjectId: string | undefined;
	let cachedRegion: string | undefined;
	let cachedBaseUrl: string | undefined;
	function getVertexClient(projectId: string, region: string): AnthropicVertex {
		const baseURL = vertexBaseUrl(region);
		if (!cachedClient || cachedProjectId !== projectId || cachedRegion !== region || cachedBaseUrl !== baseURL) {
			cachedClient = new AnthropicVertex({ projectId, region, baseURL });
			cachedProjectId = projectId;
			cachedRegion = region;
			cachedBaseUrl = baseURL;
		}
		return cachedClient;
	}

	pi.registerProvider(PROVIDER, {
		name: "Vertex Claude",
		baseUrl: region ? vertexBaseUrl(region) : "https://aiplatform.googleapis.com/v1",
		// Pi requires provider registrations with models to include an apiKey or oauth config.
		// Vertex uses Google ADC through AnthropicVertex instead; streamSimple always overrides requests.
		apiKey: AUTH_MARKER,
		// Use Pi's Anthropic message conversion/event handling while AnthropicVertex rewrites requests to Vertex.
		api: "anthropic-messages",
		models: modelList.map(toPiModel),
		streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
			const projectId = resolveProjectId();
			const region = resolveRegion();
			if (!projectId) {
				throw new Error("Missing ANTHROPIC_VERTEX_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or GCLOUD_PROJECT for vertex-claude");
			}
			if (!region) {
				throw new Error("Missing CLOUD_ML_REGION or GOOGLE_CLOUD_LOCATION for vertex-claude");
			}

			const targetId = aliasTargets.get(model.id) ?? model.id;
			const targetModel = { ...model, id: targetId, name: model.name ?? targetId } as Model<"anthropic-messages">;
			const client = getVertexClient(projectId, region);
			const reasoning = options?.reasoning;
			const base = {
				...options,
				apiKey: AUTH_MARKER,
				client: client as any,
			};

			if (!reasoning) {
				return streamAnthropic(targetModel, context, { ...base, thinkingEnabled: false });
			}

			const budget = thinkingBudget(reasoning);
			return streamAnthropic(targetModel, context, {
				...base,
				maxTokens: maxTokensForThinking(targetModel, options, budget),
				thinkingEnabled: true,
				effort: effortForReasoning(reasoning, targetId),
				thinkingBudgetTokens: budget,
			});
		},
	});
}
