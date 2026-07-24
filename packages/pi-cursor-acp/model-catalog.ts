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

export function parseModelIds(output: string): Set<string> {
  const ids = new Set<string>();
  for (const line of output.split("\n")) {
    const match = line.match(/^([a-z0-9][a-z0-9._-]*)\s+-\s+/i);
    if (match) ids.add(match[1]);
  }
  return ids;
}
