import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { Type } from "typebox";

import { DelegationGate, isExcludedRuntime } from "./runtime.js";
import { runCursorDelegation } from "./acp-client.js";
import { captureGitSnapshot, formatGitComparison, type GitSnapshot } from "./git-state.js";
import { combineAbortSignals, DelegationLifecycle } from "./lifecycle.js";
import { assertCursorVersion, listCursorModelIds } from "./model-catalog.js";
import {
  resolveModelProfile,
  type CursorEffort,
  type CursorIntent,
  type CursorSpeed,
} from "./model-profiles.js";

const TOOL_NAME = "cursor_agent";
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const POLICY_PLUGIN_DIR = join(PACKAGE_ROOT, "policy", "plugin");
const SKILL_DIR = join(PACKAGE_ROOT, "resources");
const SCRATCH_ROOT = join(process.env.PI_CODING_AGENT_DIR ?? PACKAGE_ROOT, ".tmp", "pi-cursor-acp");

const CursorParameters = Type.Object({
  intent: Type.Union([Type.Literal("context"), Type.Literal("implement"), Type.Literal("review")]),
  task: Type.String({
    minLength: 1,
    description: "Self-contained task for the delegated Cursor Agent.",
  }),
  model: Type.Optional(
    Type.String({
      description: "Exact Cursor CLI model ID explicitly requested by the user.",
    }),
  ),
  effort: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  ),
  speed: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("fast")])),
});

export function notifyIfUI(ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "info");
}

export async function confirmDelegation(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  intent: CursorIntent,
  model: string,
  task: string,
): Promise<boolean> {
  if (!ctx.hasUI) return true;
  const summary = task.length > 2_000 ? `${task.slice(0, 2_000)}\n\n[Task truncated]` : task;
  return ctx.ui.confirm(
    "Delegate to Cursor Agent?",
    `Intent: ${intent}\nModel: ${model}\n\n${summary}`,
  );
}

function permissionHandler(ctx: ExtensionContext) {
  return async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    if (!ctx.hasUI) return { outcome: { outcome: "cancelled" } };

    const safeOptions = request.options.filter((option) => option.kind !== "allow_always");
    const choices = safeOptions.map((option) => `${option.name} [${option.kind}]`);
    if (choices.length === 0) return { outcome: { outcome: "cancelled" } };

    const title = request.toolCall.title || "Cursor tool permission";
    const selected = await ctx.ui.select(`Cursor Agent requests permission:\n\n${title}`, choices);
    const index = choices.indexOf(selected ?? "");
    if (index < 0) return { outcome: { outcome: "cancelled" } };
    return {
      outcome: {
        outcome: "selected",
        optionId: safeOptions[index].optionId,
      },
    };
  };
}

function cursorRequestHandler(ctx: ExtensionContext) {
  return async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (!ctx.hasUI) return { outcome: { outcome: "cancelled" } };

    if (method === "cursor/create_plan") {
      const name = typeof params.name === "string" ? params.name : "Cursor plan";
      const plan = typeof params.plan === "string" ? params.plan : "";
      const accepted = await ctx.ui.confirm(name, plan);
      return accepted
        ? { outcome: { outcome: "accepted" } }
        : { outcome: { outcome: "rejected", reason: "Rejected by user" } };
    }

    if (method === "cursor/ask_question") {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      const answers: Array<{
        questionId: string;
        selectedOptionIds: string[];
      }> = [];
      for (const value of questions) {
        if (!value || typeof value !== "object") continue;
        const question = value as Record<string, unknown>;
        const id = typeof question.id === "string" ? question.id : "";
        const prompt = typeof question.prompt === "string" ? question.prompt : "Cursor question";
        const options = Array.isArray(question.options)
          ? question.options.filter((item): item is { id: string; label: string } =>
              Boolean(
                item &&
                typeof item === "object" &&
                typeof (item as Record<string, unknown>).id === "string" &&
                typeof (item as Record<string, unknown>).label === "string",
              ),
            )
          : [];
        if (!id || options.length === 0) continue;
        const selected = await ctx.ui.select(
          prompt,
          options.map((option) => option.label),
        );
        const answer = options.find((option) => option.label === selected);
        if (!answer) return { outcome: { outcome: "cancelled" } };
        answers.push({ questionId: id, selectedOptionIds: [answer.id] });
      }
      return { outcome: { outcome: "answered", answers } };
    }

    return { outcome: { outcome: "cancelled" } };
  };
}

function formatResult(
  result: Awaited<ReturnType<typeof runCursorDelegation>>,
  gitComparison?: string,
): string {
  const sections = [
    `Cursor Agent completed ${result.intent} with ${result.modelId} in ${result.mode} mode.`,
    `Stop reason: ${result.stopReason}`,
    "",
    result.output.trim() || "Cursor Agent returned no text output.",
  ];
  if (result.truncated) sections.push("", "[Cursor output truncated at 100,000 characters]");
  if (gitComparison) sections.push("", gitComparison);
  return sections.join("\n");
}

export default function cursorAcpExtension(
  pi: ExtensionAPI,
  runtime: { env?: NodeJS.ProcessEnv; argv?: readonly string[] } = {},
) {
  if (isExcludedRuntime(runtime.env ?? process.env, runtime.argv ?? process.argv)) return;

  const lifecycle = new DelegationLifecycle();
  const delegationGate = new DelegationGate();
  let activeDelegation: ReturnType<typeof runCursorDelegation> | undefined;

  pi.registerTool({
    name: TOOL_NAME,
    label: "Cursor Agent",
    description:
      "Delegate an explicitly user-requested context, implementation, or review task to Cursor Agent. " +
      "Call only when the user explicitly asks to involve Cursor; interactive sessions require confirmation.",
    parameters: CursorParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!delegationGate.tryStart()) {
        return {
          content: [{ type: "text", text: "A Cursor Agent delegation is already running." }],
          details: { busy: true },
          isError: true,
        };
      }
      let before: GitSnapshot | undefined;
      try {
        const profile = resolveModelProfile(params.intent as CursorIntent, {
          model: params.model,
          effort: params.effort as CursorEffort | undefined,
          speed: params.speed as CursorSpeed | undefined,
        });
        const confirmed = await confirmDelegation(
          ctx,
          profile.intent,
          profile.cliModelId,
          params.task,
        );
        if (!confirmed) {
          return {
            content: [{ type: "text", text: "Cursor Agent delegation cancelled by the user." }],
            details: { cancelled: true },
          };
        }

        await assertCursorVersion();
        const availableModels = await listCursorModelIds(SCRATCH_ROOT);
        if (!availableModels.has(profile.cliModelId)) {
          throw new Error(
            `Cursor model ${profile.cliModelId} is not available for the authenticated account.`,
          );
        }

        if (profile.intent === "implement") {
          before = await captureGitSnapshot(ctx.cwd);
        }

        notifyIfUI(
          ctx,
          `Cursor Agent: ${profile.intent} with ${profile.cliModelId} (${profile.mode})`,
        );
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Starting Cursor Agent with ${profile.cliModelId}...`,
            },
          ],
          details: { intent: profile.intent, model: profile.cliModelId },
        });

        let progress = "";
        activeDelegation = runCursorDelegation({
          cwd: ctx.cwd,
          profile,
          task: params.task,
          policyPluginDir: POLICY_PLUGIN_DIR,
          scratchRoot: SCRATCH_ROOT,
          signal: combineAbortSignals(signal, lifecycle.signal),
          onPermission: permissionHandler(ctx),
          onCursorRequest: cursorRequestHandler(ctx),
          onUpdate(text) {
            progress = (progress + text).slice(-4_000);
            if (text.includes("\n") || text.startsWith("[Cursor")) {
              onUpdate?.({
                content: [{ type: "text", text: progress }],
                details: { intent: profile.intent, model: profile.cliModelId },
              });
            }
          },
        });
        const result = await activeDelegation;

        let comparison: string | undefined;
        if (before) {
          const after = await captureGitSnapshot(ctx.cwd);
          comparison = formatGitComparison(before, after);
        }
        return {
          content: [{ type: "text", text: formatResult(result, comparison) }],
          details: {
            intent: result.intent,
            model: result.modelId,
            acpModel: result.acpModelId,
            mode: result.mode,
            stopReason: result.stopReason,
            truncated: result.truncated,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Cursor Agent failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      } finally {
        activeDelegation = undefined;
        delegationGate.finish();
      }
    },
  });

  pi.on("session_start", () => {
    lifecycle.reset();
  });

  pi.on("resources_discover", () => ({ skillPaths: [SKILL_DIR] }));

  pi.on("session_shutdown", async () => {
    lifecycle.shutdown();
    await activeDelegation?.catch(() => undefined);
  });
}
