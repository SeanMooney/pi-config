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
 *
 * The sandbox extension is configured to disable itself when --ssh is active,
 * so remote SSH execution intentionally bypasses local sandboxing.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";

const EXIT_STDIO_GRACE_MS = 100;

function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
    };

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };

    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) postExitTimer = setTimeout(() => finalize(code), EXIT_STDIO_GRACE_MS);
    };
    const onClose = (code: number | null) => finalize(code);

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid);
    else child.kill();
  } catch {
    child.kill();
  }
}

function sshExec(remote: string, command: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", remote, command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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
  return path.startsWith(localCwd) ? path.replace(localCwd, remoteCwd) : path;
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
  return {
    readFile: (path) => sshExec(remote, `cat ${JSON.stringify(toRemotePath(path, remoteCwd, localCwd))}`),
    access: (path) =>
      sshExec(remote, `test -r ${JSON.stringify(toRemotePath(path, remoteCwd, localCwd))}`).then(() => {}),
    detectImageMimeType: async (path) => {
      try {
        const result = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemotePath(path, remoteCwd, localCwd))}`);
        const mimeType = result.toString().trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType) ? mimeType : null;
      } catch {
        return null;
      }
    },
  };
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
  return {
    writeFile: async (path, content) => {
      const b64 = Buffer.from(content).toString("base64");
      await sshExec(remote, `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemotePath(path, remoteCwd, localCwd))}`);
    },
    mkdir: (dir) => sshExec(remote, `mkdir -p ${JSON.stringify(toRemotePath(dir, remoteCwd, localCwd))}`).then(() => {}),
  };
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
  const readOps = createRemoteReadOps(remote, remoteCwd, localCwd);
  const writeOps = createRemoteWriteOps(remote, remoteCwd, localCwd);
  return { readFile: readOps.readFile, access: readOps.access, writeFile: writeOps.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve, reject) => {
        const cmd = `cd ${JSON.stringify(toRemotePath(cwd, remoteCwd, localCwd))} && ${command}`;
        const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", remote, cmd], {
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        const onAbort = () => killProcessTree(child);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });

        waitForChildProcess(child)
          .then((code) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            signal?.removeEventListener("abort", onAbort);
            if (signal?.aborted) reject(new Error("aborted"));
            else if (timedOut) reject(new Error(`timeout:${timeout}`));
            else resolve({ exitCode: code });
          })
          .catch((err) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            signal?.removeEventListener("abort", onAbort);
            reject(err);
          });
      }),
  };
}

function parseSshArg(arg: string): { remote: string; remoteCwd?: string } {
  const match = arg.match(/^([^:]+):(\/.+)$/);
  if (!match) return { remote: arg };
  return { remote: match[1], remoteCwd: match[2] };
}

async function resolveRemoteCwd(remote: string, requestedCwd?: string): Promise<string> {
  if (!requestedCwd) return (await sshExec(remote, "pwd")).toString().trim();
  return (await sshExec(remote, `cd ${JSON.stringify(requestedCwd)} && pwd`)).toString().trim();
}

export default function sshExtension(pi: ExtensionAPI) {
  pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });
  pi.registerFlag("ssh-cwd", { description: "Remote working directory for --ssh", type: "string" });

  const localCwd = process.cwd();
  let resolvedSsh: { remote: string; remoteCwd: string } | null = null;
  let sshRequested = false;
  let sshStartupError: Error | null = null;
  let remoteToolsRegistered = false;

  function getSsh() {
    if (resolvedSsh) return resolvedSsh;
    if (sshStartupError) throw sshStartupError;
    if (sshRequested) throw new Error("SSH mode was requested but the remote connection is not ready");
    return null;
  }

  function registerRemoteTools() {
    if (remoteToolsRegistered || !resolvedSsh) return;
    remoteToolsRegistered = true;

    pi.registerTool({
      ...createReadTool(localCwd, {
        operations: createRemoteReadOps(resolvedSsh.remote, resolvedSsh.remoteCwd, localCwd),
      }),
      label: "read (ssh)",
    });

    pi.registerTool({
      ...createWriteTool(localCwd, {
        operations: createRemoteWriteOps(resolvedSsh.remote, resolvedSsh.remoteCwd, localCwd),
      }),
      label: "write (ssh)",
    });

    pi.registerTool({
      ...createEditTool(localCwd, {
        operations: createRemoteEditOps(resolvedSsh.remote, resolvedSsh.remoteCwd, localCwd),
      }),
      label: "edit (ssh)",
    });

    pi.registerTool({
      ...createBashTool(localCwd, {
        operations: createRemoteBashOps(resolvedSsh.remote, resolvedSsh.remoteCwd, localCwd),
      }),
      label: "bash (ssh)",
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const arg = pi.getFlag("ssh") as string | undefined;
    if (!arg) return;

    sshRequested = true;
    const parsed = parseSshArg(arg);
    const sshCwd = pi.getFlag("ssh-cwd") as string | undefined;

    try {
      const remoteCwd = await resolveRemoteCwd(parsed.remote, sshCwd ?? parsed.remoteCwd);
      resolvedSsh = { remote: parsed.remote, remoteCwd };
      sshStartupError = null;
      registerRemoteTools();

      ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
      ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
    } catch (err) {
      sshStartupError = err instanceof Error ? err : new Error(String(err));
      resolvedSsh = null;
      ctx.ui.setStatus("ssh", ctx.ui.theme.fg("error", "SSH failed"));
      ctx.ui.notify(`SSH connection failed for ${parsed.remote}: ${sshStartupError.message}`, "error");
      ctx.shutdown();
    }
  });

  pi.on("user_bash", (_event) => {
    const ssh = getSsh();
    if (!ssh) return;
    return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd) };
  });

  pi.on("before_agent_start", async (event) => {
    const ssh = getSsh();
    if (!ssh) return;

    return {
      systemPrompt: event.systemPrompt.replace(
        `Current working directory: ${localCwd}`,
        `Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
      ),
    };
  });
}
