import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { cursorChildEnvironment } from "./environment.js";

const execFileAsync = promisify(execFile);

export const MIN_CURSOR_CLI_VERSION = "2026.07.23";

function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

export function cursorVersionIsSupported(version: string): boolean {
  if (!/^\d{4}\.\d{2}\.\d{2}(?:[-+].*)?$/.test(version)) return false;
  const actual = versionParts(version);
  const minimum = versionParts(MIN_CURSOR_CLI_VERSION);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

export async function assertCursorVersion(agentCommand = "agent"): Promise<string> {
  const { stdout } = await execFileAsync(agentCommand, ["--version"], {
    timeout: 10_000,
  });
  const version = stdout.trim();
  if (!cursorVersionIsSupported(version)) {
    throw new Error(
      `Cursor CLI ${version || "unknown"} is unsupported; ` +
        `version ${MIN_CURSOR_CLI_VERSION} or newer is required.`,
    );
  }
  return version;
}

export function parseModelIds(output: string): Set<string> {
  const ids = new Set<string>();
  for (const line of output.split("\n")) {
    const match = line.match(/^([a-z0-9][a-z0-9._-]*)\s+-\s+/i);
    if (match) ids.add(match[1]);
  }
  return ids;
}

export async function listCursorModelIds(
  scratchRoot: string,
  agentCommand = "agent",
): Promise<Set<string>> {
  await mkdir(scratchRoot, { recursive: true });
  const configDir = await mkdtemp(join(scratchRoot, "model-config-"));
  try {
    const { stdout } = await execFileAsync(agentCommand, ["models"], {
      env: cursorChildEnvironment(process.env, { CURSOR_CONFIG_DIR: configDir }),
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60_000,
    });
    return parseModelIds(stdout);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}
