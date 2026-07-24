import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Context, Effect, Layer } from "effect";

const execFileAsync = promisify(execFile);
const MAX_SUMMARY_CHARS = 30_000;

export interface GitSnapshot {
  available: boolean;
  status: string;
  diffStat: string;
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    signal,
  });
  return stdout.trim().slice(0, MAX_SUMMARY_CHARS);
}

export async function captureGitSnapshot(cwd: string, signal?: AbortSignal): Promise<GitSnapshot> {
  try {
    await git(cwd, ["rev-parse", "--show-toplevel"], signal);
    const [status, unstaged, staged] = await Promise.all([
      git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], signal),
      git(cwd, ["diff", "--stat"], signal),
      git(cwd, ["diff", "--cached", "--stat"], signal),
    ]);
    return {
      available: true,
      status,
      diffStat: [unstaged, staged].filter(Boolean).join("\n"),
    };
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return { available: false, status: "", diffStat: "" };
  }
}

export interface GitStateService {
  readonly capture: (cwd: string) => Effect.Effect<GitSnapshot>;
}

export class GitState extends Context.Service<GitState, GitStateService>()(
  "pi-cursor-acp/GitState",
) {
  static readonly layer = Layer.succeed(this)({
    capture: (cwd) => Effect.promise((signal) => captureGitSnapshot(cwd, signal)),
  });
}

export function formatGitComparison(before: GitSnapshot, after: GitSnapshot): string {
  if (!before.available || !after.available) {
    return "Git state unavailable; inspect the workspace directly.";
  }

  const baseline = before.status || "clean";
  const final = after.status || "clean";
  const stat = after.diffStat || "No tracked diff stat.";
  return [
    "Git baseline before Cursor:",
    baseline,
    "",
    "Git state after Cursor:",
    final,
    "",
    "Final aggregate diff stat:",
    stat,
    "",
    "This is an aggregate before/after view, not exact attribution if other processes edited concurrently.",
  ].join("\n");
}
