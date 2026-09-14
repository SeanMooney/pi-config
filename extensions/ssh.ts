/**
 * SSH Remote Execution Extension
 *
 * Registers a --ssh flag. When provided, the built-in read/write/edit/bash
 * tools and user ! commands are routed through SSH to the remote host.
 *
 * Usage:
 *   pi --ssh user@host
 *   pi --ssh user@host:/remote/path
 *   pi --ssh user@host --ssh-cwd /remote/path
 *   pi --ssh user@host --tty
 *
 * The sandbox extension is configured to disable itself when --ssh is active,
 * so remote SSH execution intentionally bypasses local sandboxing.
 */

import { spawn } from "node:child_process";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { createLocalReadRegistry } from "./ssh/local-read-registry.ts";
import { createSkillLocalReadPolicy } from "./ssh/skill-local-read-policy.ts";
import { createHybridReadExecutor } from "./ssh/hybrid-read-router.ts";
import { createRemoteBashOperations } from "./ssh/remote-bash-command.ts";
const SSH_MODE_ENV = "PI_SSH_MODE_ACTIVE";
const SSH_REMOTE_ENV = "PI_SSH_REMOTE";
const SSH_CWD_ENV = "PI_SSH_CWD";

function sshExec(remote: string, command: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", remote, command],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (data) => chunks.push(data));
    child.stderr.on("data", (data) => errChunks.push(data));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

function toRemotePath(path: string, remoteCwd: string, localCwd: string): string {
  const remainder = relative(localCwd, path);
  if (remainder === "") return remoteCwd;
  const traversesParent = remainder === ".." || remainder.startsWith(`..${sep}`);
  if (!traversesParent && !isAbsolute(remainder)) return join(remoteCwd, remainder);
  return path;
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
  return {
    readFile: (path) =>
      sshExec(remote, `cat ${JSON.stringify(toRemotePath(path, remoteCwd, localCwd))}`),
    access: (path) =>
      sshExec(remote, `test -r ${JSON.stringify(toRemotePath(path, remoteCwd, localCwd))}`).then(
        () => {},
      ),
    detectImageMimeType: async (path) => {
      try {
        const result = await sshExec(
          remote,
          `file --mime-type -b ${JSON.stringify(toRemotePath(path, remoteCwd, localCwd))}`,
        );
        const mimeType = result.toString().trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType)
          ? mimeType
          : null;
      } catch {
        return null;
      }
    },
  };
}

function createRemoteWriteOps(
  remote: string,
  remoteCwd: string,
  localCwd: string,
): WriteOperations {
  return {
    writeFile: async (path, content) => {
      const b64 = Buffer.from(content).toString("base64");
      await sshExec(
        remote,
        `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemotePath(path, remoteCwd, localCwd))}`,
      );
    },
    mkdir: (dir) =>
      sshExec(remote, `mkdir -p ${JSON.stringify(toRemotePath(dir, remoteCwd, localCwd))}`).then(
        () => {},
      ),
  };
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
  const readOps = createRemoteReadOps(remote, remoteCwd, localCwd);
  const writeOps = createRemoteWriteOps(remote, remoteCwd, localCwd);
  return { readFile: readOps.readFile, access: readOps.access, writeFile: writeOps.writeFile };
}

function parseSshArg(arg: string): { remote: string; remoteCwd?: string } {
  const match = arg.match(/^([^:]+):(\/.+)$/);
  if (!match) return { remote: arg };
  return { remote: match[1], remoteCwd: match[2] };
}

function argvHasSshFlag(): boolean {
  return process.argv.some(
    (arg, index, argv) =>
      arg === "--ssh" || arg.startsWith("--ssh=") || argv[index - 1] === "--ssh",
  );
}

async function resolveRemoteCwd(remote: string, requestedCwd?: string): Promise<string> {
  if (!requestedCwd) return (await sshExec(remote, "pwd")).toString().trim();
  return (await sshExec(remote, `cd ${JSON.stringify(requestedCwd)} && pwd`)).toString().trim();
}

export default function sshExtension(pi: ExtensionAPI) {
  pi.registerFlag("ssh", {
    description: "SSH remote: user@host or user@host:/path",
    type: "string",
  });
  pi.registerFlag("ssh-cwd", { description: "Remote working directory for --ssh", type: "string" });
  pi.registerFlag("tty", {
    description: "Use a remote PTY and interactive login Bash for --ssh commands",
    type: "boolean",
    default: false,
  });

  if (argvHasSshFlag() || process.env[SSH_REMOTE_ENV]) process.env[SSH_MODE_ENV] = "1";

  const localCwd = process.cwd();
  const localReadRegistry = createLocalReadRegistry();
  const skillTreesOwner = Symbol("ssh-skill-trees");
  const skillLocalReadPolicy = createSkillLocalReadPolicy(localReadRegistry, skillTreesOwner);
  let resolvedSsh: { remote: string; remoteCwd: string; tty: boolean } | null = null;
  let sshRequested = false;
  let sshStartupError: Error | null = null;
  let remoteToolsRegistered = false;

  function getSsh() {
    if (resolvedSsh) return resolvedSsh;
    if (sshStartupError) throw sshStartupError;
    if (sshRequested)
      throw new Error("SSH mode was requested but the remote connection is not ready");
    return null;
  }

  function registerRemoteTools() {
    if (remoteToolsRegistered || !resolvedSsh) return;
    remoteToolsRegistered = true;
    const ssh = resolvedSsh;

    const localRead = createReadTool(localCwd);
    const remoteRead = createReadTool(localCwd, {
      operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd),
    });
    const hybridRead = createHybridReadExecutor(localRead, remoteRead, localReadRegistry);
    pi.registerTool({
      ...remoteRead,
      execute: hybridRead.execute,
      label: "read (ssh)",
    });

    pi.registerTool({
      ...createWriteTool(localCwd, {
        operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd),
      }),
      label: "write (ssh)",
    });

    pi.registerTool({
      ...createEditTool(localCwd, {
        operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd),
      }),
      label: "edit (ssh)",
    });

    pi.registerTool({
      ...createBashTool(localCwd, {
        operations: createRemoteBashOperations(ssh.remote, ssh.tty, (cwd) =>
          toRemotePath(cwd, ssh.remoteCwd, localCwd),
        ) satisfies BashOperations,
      }),
      label: "bash (ssh)",
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const arg = pi.getFlag("ssh") as string | undefined;
    const inheritedRemote = process.env[SSH_REMOTE_ENV];
    if (!arg && !inheritedRemote) return;

    sshRequested = true;
    process.env[SSH_MODE_ENV] = "1";
    const parsed = arg ? parseSshArg(arg) : { remote: inheritedRemote! };
    const sshCwd = pi.getFlag("ssh-cwd") as string | undefined;
    const inheritedCwd = process.env[SSH_CWD_ENV];
    const tty = (pi.getFlag("tty") as boolean | undefined) ?? false;

    try {
      const remoteCwd = await resolveRemoteCwd(
        parsed.remote,
        sshCwd ?? parsed.remoteCwd ?? inheritedCwd,
      );
      resolvedSsh = { remote: parsed.remote, remoteCwd, tty };
      process.env[SSH_REMOTE_ENV] = resolvedSsh.remote;
      process.env[SSH_CWD_ENV] = resolvedSsh.remoteCwd;
      sshStartupError = null;
      registerRemoteTools();

      ctx.ui.setStatus(
        "ssh",
        ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`),
      );
      ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
    } catch (err) {
      sshStartupError = err instanceof Error ? err : new Error(String(err));
      resolvedSsh = null;
      ctx.ui.setStatus("ssh", ctx.ui.theme.fg("error", "SSH failed"));
      ctx.ui.notify(
        `SSH connection failed for ${parsed.remote}: ${sshStartupError.message}`,
        "error",
      );
      ctx.shutdown();
    }
  });

  pi.on("user_bash", (_event) => {
    const ssh = getSsh();
    if (!ssh) return;
    return {
      operations: createRemoteBashOperations(ssh.remote, ssh.tty, (cwd) =>
        toRemotePath(cwd, ssh.remoteCwd, localCwd),
      ) satisfies BashOperations,
    };
  });

  pi.on("session_shutdown", () => {
    localReadRegistry.remove(skillTreesOwner);
    localReadRegistry.clear();
    skillLocalReadPolicy.reset();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const ssh = getSsh();
    if (!ssh) return;

    const report = await skillLocalReadPolicy.refresh(event.systemPromptOptions.skills);
    if (report.rejected.length > 0) {
      ctx.ui.notify(
        `${report.rejected.length} discovered skill tree(s) are unavailable for local SSH reads`,
        "warning",
      );
    }
    if (report.changed && report.standaloneParentTrees.length > 0) {
      ctx.ui.notify(
        `${report.standaloneParentTrees.length} standalone Markdown skill(s) grant local reads to their shared parent tree(s)`,
        "info",
      );
    }

    return {
      systemPrompt: event.systemPrompt.replace(
        `Current working directory: ${localCwd}`,
        `Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
      ),
    };
  });
}
