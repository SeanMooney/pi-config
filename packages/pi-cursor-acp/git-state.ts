import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_SUMMARY_CHARS = 30_000;

export interface GitSnapshot {
  available: boolean;
  status: string;
  diffStat: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim().slice(0, MAX_SUMMARY_CHARS);
}

export async function captureGitSnapshot(cwd: string): Promise<GitSnapshot> {
  try {
    await git(cwd, ["rev-parse", "--show-toplevel"]);
    const [status, unstaged, staged] = await Promise.all([
      git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
      git(cwd, ["diff", "--stat"]),
      git(cwd, ["diff", "--cached", "--stat"]),
    ]);
    return {
      available: true,
      status,
      diffStat: [unstaged, staged].filter(Boolean).join("\n"),
    };
  } catch {
    return { available: false, status: "", diffStat: "" };
  }
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
