export const CURSOR_INTENTS = ["context", "implement", "review"] as const;

export type CursorIntent = (typeof CURSOR_INTENTS)[number];
export type CursorEffort = "low" | "medium" | "high";
export type CursorSpeed = "standard" | "fast";

export interface ModelProfile {
  intent: CursorIntent;
  mode: "ask" | "agent";
  cliModelId: string;
  acpModelId: string;
  displayName: string;
}

export const MODEL_PROFILES: Record<CursorIntent, ModelProfile> = {
  context: {
    intent: "context",
    mode: "ask",
    cliModelId: "composer-2.5-fast",
    acpModelId: "composer-2.5[fast=true]",
    displayName: "Composer 2.5 Fast",
  },
  implement: {
    intent: "implement",
    mode: "agent",
    cliModelId: "cursor-grok-4.5-high-fast",
    acpModelId: "grok-4.5[effort=high,fast=true]",
    displayName: "Cursor Grok 4.5 High Fast",
  },
  review: {
    intent: "review",
    mode: "ask",
    cliModelId: "cursor-grok-4.5-high-fast",
    acpModelId: "grok-4.5[effort=high,fast=true]",
    displayName: "Cursor Grok 4.5 High Fast",
  },
};

export interface ProfileOverrides {
  model?: string;
  effort?: CursorEffort;
  speed?: CursorSpeed;
}

function grokModelId(effort: CursorEffort, speed: CursorSpeed): string {
  return `cursor-grok-4.5-${effort}${speed === "fast" ? "-fast" : ""}`;
}

function composerModelId(speed: CursorSpeed): string {
  return speed === "fast" ? "composer-2.5-fast" : "composer-2.5";
}

export function expectedAcpModelId(cliModelId: string): string | undefined {
  if (cliModelId === "composer-2.5") return "composer-2.5[fast=false]";
  if (cliModelId === "composer-2.5-fast") return "composer-2.5[fast=true]";

  const grok = cliModelId.match(/^cursor-grok-4\.5-(low|medium|high)(-fast)?$/);
  if (grok) {
    return `grok-4.5[effort=${grok[1]},fast=${grok[2] ? "true" : "false"}]`;
  }

  return undefined;
}

export function resolveModelProfile(
  intent: CursorIntent,
  overrides: ProfileOverrides = {},
): ModelProfile {
  const base = MODEL_PROFILES[intent];
  let cliModelId = overrides.model ?? base.cliModelId;

  if (overrides.model && (overrides.effort || overrides.speed)) {
    if (!/^(cursor-grok-4\.5-|composer-2\.5)/.test(overrides.model)) {
      throw new Error(
        "Effort and speed overrides are supported only for Grok 4.5 and Composer 2.5; " +
          "otherwise provide an exact Cursor CLI model ID.",
      );
    }
  }

  if (cliModelId.startsWith("cursor-grok-4.5-")) {
    const match = cliModelId.match(/^cursor-grok-4\.5-(low|medium|high)(-fast)?$/);
    if (!match) throw new Error(`Unsupported Grok 4.5 model ID: ${cliModelId}`);
    const effort = overrides.effort ?? (match[1] as CursorEffort);
    const speed = overrides.speed ?? (match[2] ? "fast" : "standard");
    cliModelId = grokModelId(effort, speed);
  } else if (cliModelId.startsWith("composer-2.5")) {
    if (overrides.effort) {
      throw new Error("Composer 2.5 does not expose an effort override.");
    }
    const currentSpeed = cliModelId.endsWith("-fast") ? "fast" : "standard";
    cliModelId = composerModelId(overrides.speed ?? currentSpeed);
  } else if (overrides.effort || overrides.speed) {
    throw new Error(
      "Effort and speed overrides require a supported Grok 4.5 or Composer 2.5 model.",
    );
  }

  return {
    ...base,
    cliModelId,
    acpModelId: expectedAcpModelId(cliModelId) ?? "",
    displayName: cliModelId,
  };
}

export function modelSelectionMatches(cliModelId: string, actualAcpModelId: string): boolean {
  const expected = expectedAcpModelId(cliModelId);
  if (expected) return expected === actualAcpModelId;

  const actualFamily = actualAcpModelId.split("[", 1)[0];
  const requestedFamily = cliModelId
    .replace(/^cursor-/, "")
    .replace(/-(?:low|medium|high|xhigh)(?:-fast)?$/, "")
    .replace(/-fast$/, "");

  if (actualFamily !== requestedFamily) return false;
  if (cliModelId.endsWith("-fast") && !actualAcpModelId.includes("fast=true")) {
    return false;
  }

  const effort = cliModelId.match(/-(low|medium|high|xhigh)(?:-fast)?$/)?.[1];
  if (
    effort &&
    !actualAcpModelId.includes(`effort=${effort}`) &&
    !actualAcpModelId.includes(`reasoning=${effort}`)
  ) {
    return false;
  }

  return true;
}
