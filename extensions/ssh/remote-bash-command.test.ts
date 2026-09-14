import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createRemoteBashInvocation,
  createRemoteBashOperations,
  quotePosixShell,
} from "./remote-bash-command.ts";

const temporaryDirectories: string[] = [];
const fakeChildren = new Set<ReturnType<typeof spawn>>();

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("fake SSH test timed out")), 2_000);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(() => {
  for (const child of fakeChildren) {
    if (child.exitCode === null) child.kill();
  }
  fakeChildren.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("remote Bash command", () => {
  it("uses a non-PTY login shell by default", () => {
    const invocation = createRemoteBashInvocation(
      "user@example.test",
      "/remote/work tree",
      "printf '%s\\n' \"$PATH\"",
      false,
    );

    assert.deepEqual(invocation.args.slice(0, -2), [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-T",
    ]);
    assert.equal(invocation.args.at(-2), "user@example.test");
    assert.match(invocation.args.at(-1) ?? "", /^exec bash -lc /);
    assert.equal(
      invocation.script,
      `builtin cd -- '/remote/work tree' && printf '%s\\n' \"$PATH\"`,
    );
  });

  it("opts into a PTY and an interactive login shell", () => {
    const invocation = createRemoteBashInvocation("user@example.test", "/remote/work", "env", true);

    assert.equal(invocation.args.at(4), "-tt");
    assert.match(invocation.args.at(-1) ?? "", /^exec bash -lic /);
  });

  it("preserves shell syntax while safely quoting unusual working directories", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-ssh-bash-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "work '$()`tick`\nline");
    mkdirSync(cwd);
    const command = 'printf \'%s\\n\' "$PWD" "$(printf inner)" "`printf legacy`"\nprintf done';
    const invocation = createRemoteBashInvocation("unused", cwd, command, false);
    const output = execFileSync("bash", ["-c", invocation.args.at(-1)!], {
      encoding: "utf8",
      timeout: 2_000,
    });

    assert.equal(output, `${cwd}\ninner\nlegacy\ndone`);
  });

  it("streams fake SSH output and returns its exit status", async () => {
    let capturedArgs: readonly string[] = [];
    const chunks: Buffer[] = [];
    const operations = createRemoteBashOperations(
      "user@example.test",
      false,
      (cwd) => `/remote${cwd}`,
      {
        spawnSsh(args) {
          capturedArgs = args;
          const child = spawn(
            process.execPath,
            ["-e", "process.stdout.write('fake ssh'); process.exit(7)"],
            {
              detached: process.platform !== "win32",
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          fakeChildren.add(child);
          return child;
        },
      },
    );

    const result = await withDeadline(
      operations.exec("status", "/work", {
        onData: (data) => chunks.push(data),
      }),
    );

    assert.equal(capturedArgs.at(4), "-T");
    assert.match(capturedArgs.at(-1) ?? "", /^exec bash -lc /);
    assert.equal(Buffer.concat(chunks).toString(), "fake ssh");
    assert.equal(result.exitCode, 7);
  });

  it("kills fake SSH on timeout and cancellation", async () => {
    for (const mode of ["timeout", "abort"] as const) {
      let killed = false;
      const operations = createRemoteBashOperations("user@example.test", true, (cwd) => cwd, {
        spawnSsh(args) {
          assert.equal(args.at(4), "-tt");
          assert.match(args.at(-1) ?? "", /^exec bash -lic /);
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
          fakeChildren.add(child);
          return child;
        },
        killChild(child) {
          killed = true;
          child.kill();
        },
      });
      const controller = new AbortController();
      const execution = operations.exec("wait", "/remote/work", {
        onData: () => {},
        signal: controller.signal,
        timeout: mode === "timeout" ? 0.01 : undefined,
      });
      if (mode === "abort") setImmediate(() => controller.abort());

      await withDeadline(assert.rejects(execution, mode === "timeout" ? /timeout/ : /aborted/));
      assert.equal(killed, true);
    }
  });

  it("does not spawn SSH for an already-aborted request", async () => {
    let spawnCount = 0;
    const operations = createRemoteBashOperations("user@example.test", false, (cwd) => cwd, {
      spawnSsh() {
        spawnCount += 1;
        throw new Error("unexpected spawn");
      },
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      operations.exec("status", "/remote/work", {
        onData: () => {},
        signal: controller.signal,
      }),
      /aborted/,
    );
    assert.equal(spawnCount, 0);
  });

  it("rejects values that cannot be represented in a shell command", () => {
    assert.throws(() => quotePosixShell("invalid\0value"), /NUL/);
  });
});
