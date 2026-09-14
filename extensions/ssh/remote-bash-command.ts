import { type ChildProcess, spawn } from "node:child_process";

const EXIT_STDIO_GRACE_MS = 100;

export interface RemoteBashInvocation {
  readonly args: readonly string[];
  readonly script: string;
}

export interface RemoteBashOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      readonly onData: (data: Buffer) => void;
      readonly signal?: AbortSignal;
      readonly timeout?: number;
    },
  ): Promise<{ readonly exitCode: number | null }>;
}

type SpawnSsh = (args: readonly string[]) => ChildProcess;
type KillChild = (child: ChildProcess) => void;

export interface RemoteBashDependencies {
  readonly spawnSsh?: SpawnSsh;
  readonly killChild?: KillChild;
}

export function quotePosixShell(value: string): string {
  if (value.includes("\0")) throw new Error("SSH Bash values cannot contain NUL bytes");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function createRemoteBashInvocation(
  remote: string,
  remoteCwd: string,
  command: string,
  tty: boolean,
): RemoteBashInvocation {
  const script = `builtin cd -- ${quotePosixShell(remoteCwd)} && ${command}`;
  const bashMode = tty ? "-lic" : "-lc";
  const remoteCommand = `exec bash ${bashMode} ${quotePosixShell(script)}`;
  return {
    args: [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      tty ? "-tt" : "-T",
      remote,
      remoteCommand,
    ],
    script,
  };
}

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
      if (exited && !settled && stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
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

export function createRemoteBashOperations(
  remote: string,
  tty: boolean,
  resolveRemoteCwd: (cwd: string) => string,
  dependencies: RemoteBashDependencies = {},
): RemoteBashOperations {
  const spawnSsh =
    dependencies.spawnSsh ??
    ((args) =>
      spawn("ssh", args, {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      }));
  const killChild = dependencies.killChild ?? killProcessTree;

  return {
    exec: (command, cwd, { onData, signal, timeout }) => {
      if (signal?.aborted) return Promise.reject(new Error("aborted"));
      return new Promise((resolve, reject) => {
        const invocation = createRemoteBashInvocation(remote, resolveRemoteCwd(cwd), command, tty);
        const child = spawnSsh(invocation.args);
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killChild(child);
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        const onAbort = () => killChild(child);
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
          .catch((error) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          });
      });
    },
  };
}
