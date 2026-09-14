import { strict as assert } from "node:assert";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, describe, it } from "node:test";

const piPackage = pathToFileURL(
  resolve("npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
).href;
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { shortCircuit: true, url: piPackage };
    }
    return nextResolve(specifier, context);
  },
});

interface TestTool {
  readonly name: string;
  execute(
    id: string,
    params: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    context?: unknown,
  ): Promise<unknown>;
}

type Handler = (...args: unknown[]) => unknown;

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;

async function fakeSshDirectory(): Promise<{ readonly directory: string; readonly log: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-ssh-extension-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "ssh.log");
  const executable = join(directory, "ssh");
  await writeFile(
    executable,
    `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$PI_FAKE_SSH_LOG"
last="\${!#}"
if [[ "$last" == "pwd" ]]; then
  printf '/remote/work'
else
  printf 'fake ssh output'
fi
`,
  );
  await chmod(executable, 0o755);
  return { directory, log };
}

async function loadExtension(flags: ReadonlyMap<string, unknown>) {
  const tools: TestTool[] = [];
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerFlag() {},
    getFlag(name: string) {
      return flags.get(name);
    },
    registerTool(tool: TestTool) {
      tools.push(tool);
    },
    on(name: string, handler: Handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
  };
  const { default: sshExtension } = await import(`../ssh.ts?test=${Math.random()}`);
  sshExtension(pi as unknown as Parameters<typeof sshExtension>[0]);
  return { tools, handlers };
}

async function startSession(handlers: ReadonlyMap<string, Handler[]>): Promise<void> {
  const [handler] = handlers.get("session_start") ?? [];
  assert.ok(handler);
  await handler(
    {},
    {
      shutdown() {
        throw new Error("unexpected shutdown");
      },
      ui: {
        notify() {},
        setStatus() {},
        theme: { fg: (_style: string, text: string) => text },
      },
    },
  );
}

async function loggedInvocations(path: string): Promise<readonly (readonly string[])[]> {
  const content = await readFile(path, "utf8");
  const fields = content.split("\0").filter(Boolean);
  const invocations: string[][] = [];
  for (let index = 0; index < fields.length; index += 7) {
    const invocation = fields.slice(index, index + 7);
    assert.equal(invocation.length, 7);
    assert.equal(invocation[0], "-o");
    assert.ok(invocation[4] === "-T" || invocation[4] === "-tt");
    invocations.push(invocation);
  }
  return invocations;
}

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.PI_FAKE_SSH_LOG;
  delete process.env.PI_SSH_MODE_ACTIVE;
  delete process.env.PI_SSH_REMOTE;
  delete process.env.PI_SSH_CWD;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SSH extension Bash wiring", () => {
  for (const tty of [false, true]) {
    it(`routes Bash and user commands through ${tty ? "interactive TTY" : "login"} mode`, async () => {
      const fake = await fakeSshDirectory();
      process.env.PATH = `${fake.directory}${delimiter}${originalPath ?? ""}`;
      process.env.PI_FAKE_SSH_LOG = fake.log;
      const flags = new Map<string, unknown>([["ssh", "user@example.test"]]);
      if (tty) flags.set("tty", true);
      const { tools, handlers } = await loadExtension(flags);
      await startSession(handlers);

      const read = tools.find((tool) => tool.name === "read");
      const bash = tools.find((tool) => tool.name === "bash");
      assert.ok(read);
      assert.ok(bash);
      await read.execute("read", { path: "remote-file.txt" }, undefined, undefined, {
        cwd: process.cwd(),
      });
      await bash.execute("bash", { command: "printf tool" }, undefined, undefined, {
        cwd: process.cwd(),
        sessionManager: {
          getSessionFile: () => undefined,
          getSessionId: () => "test-session",
        },
      });

      const [userBash] = handlers.get("user_bash") ?? [];
      assert.ok(userBash);
      const override = userBash({ command: "printf user" }) as {
        readonly operations: {
          exec(
            command: string,
            cwd: string,
            options: { readonly onData: (data: Buffer) => void },
          ): Promise<unknown>;
        };
      };
      await override.operations.exec("printf user", process.cwd(), { onData: () => {} });

      const invocations = await loggedInvocations(fake.log);
      const bashInvocations = invocations.filter((invocation) =>
        invocation.at(-1)?.startsWith("exec bash "),
      );
      const nonBashInvocations = invocations.filter(
        (invocation) => !invocation.at(-1)?.startsWith("exec bash "),
      );
      assert.equal(bashInvocations.length, 2);
      assert.ok(nonBashInvocations.length >= 2);
      assert.ok(nonBashInvocations.every((invocation) => invocation[4] === "-T"));
      assert.ok(bashInvocations.every((invocation) => invocation[4] === (tty ? "-tt" : "-T")));
      assert.ok(
        bashInvocations.every((invocation) =>
          invocation.at(-1)?.startsWith(tty ? "exec bash -lic " : "exec bash -lc "),
        ),
      );
    });
  }

  it("leaves --tty inert without --ssh", async () => {
    const fake = await fakeSshDirectory();
    process.env.PATH = `${fake.directory}${delimiter}${originalPath ?? ""}`;
    process.env.PI_FAKE_SSH_LOG = fake.log;
    const { tools, handlers } = await loadExtension(new Map([["tty", true]]));

    await startSession(handlers);

    assert.equal(tools.length, 0);
    await assert.rejects(readFile(fake.log), /ENOENT/);
  });
});

after(() => moduleHooks.deregister());
