#!/usr/bin/env node

import { resolve, sep } from "node:path";

function deny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      continue: true,
      permission: "deny",
      user_message: reason,
      agent_message: reason,
    })}\n`,
  );
}

function allow(permission = "allow") {
  process.stdout.write(`${JSON.stringify({ continue: true, permission })}\n`);
}

function pathFromInput(input) {
  const toolInput =
    input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  for (const value of [
    input.file_path,
    input.filePath,
    input.path,
    input.target_file,
    input.targetFile,
    toolInput.file_path,
    toolInput.filePath,
    toolInput.path,
    toolInput.target_file,
    toolInput.targetFile,
  ]) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function isWithinWorkspace(path, roots, cwd) {
  const target = resolve(cwd, path);
  return roots.some((root) => {
    const base = resolve(root);
    return target === base || target.startsWith(`${base}${sep}`);
  });
}

function isSensitive(path) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return (
    /(^|\/)\.env(?:\.|$)/.test(normalized) ||
    /(^|\/)(?:\.ssh|\.aws|\.azure|\.kube|\.gnupg)(?:\/|$)/.test(normalized) ||
    /(^|\/)\.config\/(?:gcloud|gh)(?:\/|$)/.test(normalized) ||
    /(^|\/)\.docker\/config\.json$/.test(normalized) ||
    /(^|\/)\.git\/config$/.test(normalized) ||
    /(^|\/)(?:\.netrc|\.npmrc|\.pypirc)$/.test(normalized) ||
    /(^|\/)\.local\/share\/keyrings(?:\/|$)/.test(normalized) ||
    /(?:^|\/)(?:credentials?|secrets?|keychain)(?:\.|\/|$)/.test(normalized) ||
    /\.(?:pem|key|p12|pfx)$/.test(normalized)
  );
}

function shellDeniedReason(command) {
  const checks = [
    [/\bgit\s+(?:commit|push|tag)\b/i, "Cursor Agent may not commit, push, or tag."],
    [/\bgh\s+(?:pr|release)\b/i, "Cursor Agent may not create pull requests or releases."],
    [
      /\b(?:npm|pnpm|yarn|cargo|poetry)\s+publish\b|\btwine\s+upload\b|\b(?:docker|podman)\s+push\b/i,
      "Cursor Agent may not publish artifacts.",
    ],
    [
      /\b(?:env|printenv)\b|\b(?:cat|head|tail|less|more|sed|awk)\b[^\n]*(?:\.env|\.ssh|\.aws|\.azure|\.kube|\.netrc|\.npmrc|\.pypirc|credentials?|secrets?|\.pem|\.key)/i,
      "Cursor Agent may not inspect credentials or sensitive files through the shell.",
    ],
    [
      /\bgh\s+auth\s+token\b|\bnpm\s+config\s+(?:get|list)\b|\bgit\s+config\b|\baws\s+configure\s+export-credentials\b|\bgcloud\s+auth\s+print-(?:access|identity)-token\b|\bkubectl\s+config\s+view\b[^\n]*--raw\b|\bsecurity\s+find-(?:generic|internet)-password\b|\bpass\s+(?:show|grep)\b/i,
      "Cursor Agent may not run commands that disclose stored credentials.",
    ],
    [
      /(?:^|[\s'"/])\.\.(?:\/|$)/,
      "Cursor Agent shell commands may not traverse outside the workspace.",
    ],
  ];
  return checks.find(([pattern]) => pattern.test(command))?.[1];
}

let input;
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  deny("Cursor policy could not parse hook input; blocking fail closed.");
  process.exit(0);
}

const event = input.hook_event_name;
const toolName = String(input.tool_name ?? "");

if (event === "subagentStart" || toolName === "Task") {
  deny("Cursor-native subagents are disabled for Pi delegations.");
} else if (event === "beforeMCPExecution" || toolName.startsWith("MCP:")) {
  deny("MCP tools are disabled for Pi Cursor Agent delegations.");
} else if (toolName === "WebFetch" || toolName === "Browser") {
  deny("Web and browser tools are disabled because they cannot be prompted reliably.");
} else if (event === "beforeShellExecution") {
  const command = String(input.command ?? "");
  const reason = shellDeniedReason(command);
  if (reason) deny(reason);
  else allow("ask");
} else if (
  event === "beforeReadFile" ||
  ["Write", "Delete", "StrReplace", "Edit", "MultiEdit", "ApplyPatch"].includes(toolName)
) {
  const path = pathFromInput(input);
  const roots = Array.isArray(input.workspace_roots)
    ? input.workspace_roots.filter((root) => typeof root === "string")
    : [process.env.PI_CURSOR_ACP_WORKSPACE].filter(Boolean);
  const cwd = typeof input.cwd === "string" ? input.cwd : (roots[0] ?? process.cwd());
  if (!path) {
    deny("Cursor policy could not determine the file path; blocking fail closed.");
  } else if (isSensitive(path)) {
    deny(`Cursor Agent may not access sensitive path: ${path}`);
  } else if (!isWithinWorkspace(path, roots, cwd)) {
    deny(`Cursor Agent may not access paths outside the workspace: ${path}`);
  } else {
    allow();
  }
} else {
  allow();
}
