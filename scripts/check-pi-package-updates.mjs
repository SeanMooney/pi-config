#!/usr/bin/env node
/*
 * Check pinned npm package versions in this Pi profile.
 *
 * Usage:
 *   scripts/check-pi-package-updates.mjs
 *   scripts/check-pi-package-updates.mjs --write
 *
 * The script reads settings.json package pins and npx-based MCP server package
 * pins in mcp.json. With --write it rewrites those pins to npm's current latest
 * versions. It intentionally ignores local, git, and non-npm package sources.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const write = process.argv.includes("--write");
const root = process.env.PI_CODING_AGENT_DIR ?? process.cwd();
const settingsPath = resolve(root, "settings.json");
const mcpPath = resolve(root, "mcp.json");

function npmLatest(name) {
  return execFileSync("npm", ["view", name, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseNpmSpec(spec) {
  if (!spec.startsWith("npm:")) return null;
  const body = spec.slice(4);
  const at = body.startsWith("@") ? body.indexOf("@", 1) : body.indexOf("@");
  if (at === -1) return { name: body, version: null };
  return { name: body.slice(0, at), version: body.slice(at + 1) };
}

function formatNpmSpec(name, version) {
  return `npm:${name}@${version}`;
}

function parsePackageArg(arg) {
  const at = arg.startsWith("@") ? arg.indexOf("@", 1) : arg.indexOf("@");
  if (at === -1) return { name: arg, version: null };
  return { name: arg.slice(0, at), version: arg.slice(at + 1) };
}

function findNpxPackageArgIndex(command, args) {
  if (!command || !command.endsWith("npx")) return -1;
  return args.findIndex((arg) => typeof arg === "string" && !arg.startsWith("-"));
}

function report(label, name, current, latest) {
  const marker = current === latest ? "=" : "→";
  const from = current ?? "un pinned";
  console.log(`${label}: ${name} ${from} ${marker} ${latest}`);
}

let changed = false;

const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
if (Array.isArray(settings.packages)) {
  settings.packages = settings.packages.map((entry) => {
    const source = typeof entry === "string" ? entry : entry?.source;
    const parsed = typeof source === "string" ? parseNpmSpec(source) : null;
    if (!parsed) return entry;

    const latest = npmLatest(parsed.name);
    report("pi package", parsed.name, parsed.version, latest);
    if (!write || parsed.version === latest) return entry;

    changed = true;
    const nextSource = formatNpmSpec(parsed.name, latest);
    return typeof entry === "string" ? nextSource : { ...entry, source: nextSource };
  });
}

let mcp;
try {
  mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
} catch {
  mcp = null;
}

if (mcp?.mcpServers) {
  for (const [serverName, server] of Object.entries(mcp.mcpServers)) {
    if (!Array.isArray(server.args)) continue;
    const packageArgIndex = findNpxPackageArgIndex(server.command, server.args);
    if (packageArgIndex === -1) continue;

    const arg = server.args[packageArgIndex];
    const parsed = parsePackageArg(arg);
    if (!parsed.name) continue;

    const latest = npmLatest(parsed.name);
    report(`mcp ${serverName}`, parsed.name, parsed.version, latest);
    if (!write || parsed.version === latest) continue;

    changed = true;
    server.args[packageArgIndex] = `${parsed.name}@${latest}`;
  }
}

if (write && changed) {
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  if (mcp) writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
  console.log("\nUpdated pins. Run `pi install` or restart Pi to sync installed packages if needed.");
} else if (write) {
  console.log("\nAll checked pins are already current.");
} else {
  console.log("\nDry run only. Re-run with --write to update pins.");
}
