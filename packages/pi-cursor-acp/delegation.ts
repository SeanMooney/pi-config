import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { Effect, Option } from "effect";

import {
  runCursorDelegation,
  type CursorDelegationResult,
  type CursorQuestionHandler,
} from "./acp-client.js";
import { CursorCli } from "./cursor-cli.js";
import {
  CursorModelUnavailableError,
  DelegationBusyError,
  InteractionError,
  ProfileResolutionError,
  type DelegationError,
} from "./errors.js";
import { formatGitComparison, GitState, type GitSnapshot } from "./git-state.js";
import {
  resolveModelProfile,
  type CursorEffort,
  type CursorIntent,
  type CursorSpeed,
  type ProfileOverrides,
} from "./model-profiles.js";
import { DelegationAdmission } from "./runtime.js";

export interface DelegationRequest {
  readonly cwd: string;
  readonly intent: CursorIntent;
  readonly task: string;
  readonly model?: string;
  readonly effort?: CursorEffort;
  readonly speed?: CursorSpeed;
  readonly policyPluginDir: string;
  readonly scratchRoot: string;
  readonly timeoutMs?: number;
  readonly agentCommand?: string;
  readonly testEnvironment?: NodeJS.ProcessEnv;
  readonly confirm: (intent: CursorIntent, model: string, task: string) => Promise<boolean>;
  readonly onAccepted?: (intent: CursorIntent, model: string, mode: "ask" | "agent") => void;
  readonly onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  readonly onCursorRequest: CursorQuestionHandler;
  readonly onUpdate?: (text: string) => void;
}

export type DelegationOutcome =
  | { readonly _tag: "Declined" }
  | {
      readonly _tag: "Completed";
      readonly result: CursorDelegationResult;
      readonly gitComparison?: string;
    };

export function delegateToCursor(
  request: DelegationRequest,
): Effect.Effect<DelegationOutcome, DelegationError, CursorCli | GitState | DelegationAdmission> {
  return Effect.gen(function* () {
    const admission = yield* DelegationAdmission;
    const outcome = yield* admission.tryRun(delegationWorkflow(request));
    return yield* Option.match(outcome, {
      onNone: () =>
        Effect.fail(
          new DelegationBusyError({
            message: "A Cursor Agent delegation is already running.",
          }),
        ),
      onSome: Effect.succeed,
    });
  });
}

function delegationWorkflow(
  request: DelegationRequest,
): Effect.Effect<DelegationOutcome, DelegationError, CursorCli | GitState> {
  return Effect.gen(function* () {
    const profile = yield* resolveProfile(request.intent, {
      model: request.model,
      effort: request.effort,
      speed: request.speed,
    });

    const confirmed = yield* Effect.tryPromise({
      try: () => request.confirm(profile.intent, profile.cliModelId, request.task),
      catch: (cause) =>
        new InteractionError({
          cause,
          message: `Unable to confirm Cursor delegation: ${causeMessage(cause)}`,
        }),
    });
    if (!confirmed) return { _tag: "Declined" } as const;
    yield* Effect.sync(() =>
      request.onAccepted?.(profile.intent, profile.cliModelId, profile.mode),
    );

    const cursorCli = yield* CursorCli;
    yield* cursorCli.assertVersion(request.agentCommand);
    const availableModels = yield* cursorCli.listModelIds(
      request.scratchRoot,
      request.agentCommand,
    );
    if (!availableModels.has(profile.cliModelId)) {
      return yield* Effect.fail(
        new CursorModelUnavailableError({
          modelId: profile.cliModelId,
          message:
            `Cursor model ${profile.cliModelId} is not available for the ` +
            "authenticated account.",
        }),
      );
    }

    const gitState = yield* GitState;
    let before: GitSnapshot | undefined;
    if (profile.intent === "implement") {
      before = yield* gitState.capture(request.cwd);
    }

    const result = yield* runCursorDelegation({
      cwd: request.cwd,
      profile,
      task: request.task,
      policyPluginDir: request.policyPluginDir,
      scratchRoot: request.scratchRoot,
      timeoutMs: request.timeoutMs,
      onPermission: request.onPermission,
      onCursorRequest: request.onCursorRequest,
      onUpdate: request.onUpdate,
      agentCommand: request.agentCommand,
      testEnvironment: request.testEnvironment,
    });

    let gitComparison: string | undefined;
    if (before) {
      const after = yield* gitState.capture(request.cwd);
      gitComparison = formatGitComparison(before, after);
    }

    return { _tag: "Completed", result, gitComparison } as const;
  });
}

function resolveProfile(intent: CursorIntent, overrides: ProfileOverrides) {
  return Effect.try({
    try: () => resolveModelProfile(intent, overrides),
    catch: (cause) =>
      new ProfileResolutionError({
        cause,
        message: causeMessage(cause),
      }),
  });
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
