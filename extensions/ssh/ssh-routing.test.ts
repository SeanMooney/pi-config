import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createHybridReadExecutor, type ReadExecutor } from "./hybrid-read-router.ts";
import { createLocalReadRegistry } from "./local-read-registry.ts";

type ReadParams = {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
};
type ReadResult = { readonly content: string };

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-ssh-routing-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeReadExecutor(
  calls: string[],
  content: string,
  failure?: Error,
  contexts?: unknown[],
): ReadExecutor<ReadParams, undefined, ReadResult> {
  return {
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      calls.push(`read:${params.path}`);
      contexts?.push(context);
      if (failure) throw failure;
      return { content };
    },
  };
}

describe("SSH hybrid read routing", () => {
  it("uses local reads only for registered absolute skill resources", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, "skill");
    await mkdir(skill);
    const localCalls: string[] = [];
    const remoteCalls: string[] = [];
    const registry = createLocalReadRegistry();
    await registry.replace(Symbol(), [{ kind: "tree", path: skill }]);
    const localContexts: unknown[] = [];
    const remoteContexts: unknown[] = [];
    const localRead = fakeReadExecutor(localCalls, "local", undefined, localContexts);
    const remoteRead = fakeReadExecutor(remoteCalls, "remote", undefined, remoteContexts);
    const hybrid = createHybridReadExecutor(localRead, remoteRead, registry);
    const localContext = { cwd: skill };
    const remoteContext = { cwd: root };

    await hybrid.execute(
      "local",
      { path: join(skill, "references", "ref.md") },
      undefined,
      undefined,
      localContext,
    );
    await hybrid.execute("remote", { path: "relative.md" }, undefined, undefined, remoteContext);
    await hybrid.execute("absolute-remote", { path: join(root, "unregistered.md") });

    assert.deepEqual(localContexts[0], localContext);
    assert.deepEqual(remoteContexts[0], remoteContext);
    assert.ok(localCalls.some((call) => call.startsWith("read:")));
    assert.equal(remoteCalls.filter((call) => call.startsWith("read:")).length, 2);
  });

  it("uses installed Pi readers and denies normalized sibling retargets", async () => {
    const { createReadTool } =
      await import("../../npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
    const root = await temporaryDirectory();
    const approved = join(root, "approved");
    const unicodeRoot = join(root, "skill\u00a0tree");
    const normalizedRoot = join(root, "skill tree");
    await mkdir(approved);
    await mkdir(unicodeRoot);
    await mkdir(normalizedRoot);
    await writeFile(join(approved, "x.md"), "approved content");
    await writeFile(join(unicodeRoot, "x.md"), "unicode content");
    await writeFile(join(normalizedRoot, "x.md"), "unregistered sibling");
    const remoteCalls: string[] = [];
    const registry = createLocalReadRegistry();
    await registry.replace(Symbol(), [
      { kind: "tree", path: approved },
      { kind: "tree", path: unicodeRoot },
    ]);
    const localRead = createReadTool(root);
    const remoteRead = createReadTool(root, {
      operations: {
        async readFile(path: string) {
          remoteCalls.push(`read:${path}`);
          return Buffer.from("remote");
        },
        async access(path: string) {
          remoteCalls.push(`access:${path}`);
        },
        async detectImageMimeType() {
          return null;
        },
      },
    });
    const hybrid = createHybridReadExecutor(localRead, remoteRead, registry);

    const approvedResult = await hybrid.execute("approved", {
      path: join(approved, "x.md"),
    });
    const approvedText = approvedResult.content.find(
      (item: { readonly type: string }): item is { readonly type: "text"; readonly text: string } =>
        item.type === "text",
    );
    assert.equal(approvedText?.text, "approved content");
    await assert.rejects(
      hybrid.execute("unicode", { path: join(unicodeRoot, "x.md") }),
      /SSH local read denied/,
    );
    assert.equal(remoteCalls.length, 0);
  });

  it("preserves read arguments, cancellation, updates, and context", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, "skill");
    await mkdir(skill);
    const calls: string[] = [];
    const signals: AbortSignal[] = [];
    const updates: unknown[] = [];
    const contexts: unknown[] = [];
    const registry = createLocalReadRegistry();
    await registry.replace(Symbol(), [{ kind: "tree", path: skill }]);
    const localRead: ReadExecutor<ReadParams, unknown, ReadResult> = {
      async execute(_toolCallId, params, signal, onUpdate, context) {
        calls.push(`${params.offset}:${params.limit}`);
        if (signal) signals.push(signal);
        updates.push(onUpdate);
        contexts.push(context);
        return { content: "local" };
      },
    };
    const remoteRead = fakeReadExecutor([], "remote");
    const hybrid = createHybridReadExecutor(localRead, remoteRead, registry);
    const controller = new AbortController();
    const update = () => {};
    const context = { cwd: skill };

    await hybrid.execute(
      "preserved",
      { path: join(skill, "reference.md"), offset: 3, limit: 2 },
      controller.signal,
      update,
      context,
    );

    assert.deepEqual(calls, ["3:2"]);
    assert.equal(signals[0], controller.signal);
    assert.equal(updates[0], update);
    assert.equal(contexts[0], context);
  });

  it("does not dispatch an escaping matched path over SSH", async (t) => {
    if (process.platform === "win32") return t.skip("symlink test requires Unix semantics");
    const root = await temporaryDirectory();
    const skill = join(root, "skill");
    const outside = join(root, "outside");
    await mkdir(skill);
    await mkdir(outside);
    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(outside, join(skill, "escape"));
    const remoteCalls: string[] = [];
    const registry = createLocalReadRegistry();
    await registry.replace(Symbol(), [{ kind: "tree", path: skill }]);
    const localRead = fakeReadExecutor([], "local");
    const remoteRead = fakeReadExecutor(remoteCalls, "remote");
    const hybrid = createHybridReadExecutor(localRead, remoteRead, registry);

    await assert.rejects(
      hybrid.execute("denied", { path: join(skill, "escape", "secret.md") }),
      /SSH local read denied/,
    );
    assert.equal(remoteCalls.length, 0);
  });

  it("does not retry matched local failures over SSH", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, "skill");
    await mkdir(skill);
    const localCalls: string[] = [];
    const remoteCalls: string[] = [];
    const registry = createLocalReadRegistry();
    await registry.replace(Symbol(), [{ kind: "tree", path: skill }]);
    const localRead = fakeReadExecutor(localCalls, "", new Error("local failure"));
    const remoteRead = fakeReadExecutor(remoteCalls, "remote");
    const hybrid = createHybridReadExecutor(localRead, remoteRead, registry);

    await assert.rejects(
      hybrid.execute("failed", { path: join(skill, "reference.md") }),
      /local failure/,
    );
    assert.equal(remoteCalls.length, 0);
  });
});
