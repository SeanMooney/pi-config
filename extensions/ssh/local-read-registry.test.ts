import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createLocalReadRegistry } from "./local-read-registry.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-ssh-local-read-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local read registry", () => {
  it("routes exact files, trees, relative paths, and prefix collisions safely", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, "skill");
    const other = join(root, "skill-other");
    await mkdir(skill);
    await mkdir(other);
    const file = join(skill, "SKILL.md");
    await writeFile(file, "skill");
    await writeFile(join(other, "reference.md"), "remote");

    const registry = createLocalReadRegistry();
    const owner = Symbol();
    await registry.replace(owner, [
      { kind: "file", path: file },
      { kind: "tree", path: skill },
    ]);

    assert.deepEqual((await registry.route(file)).kind, "local");
    assert.deepEqual((await registry.route(join(skill, "reference.md"))).kind, "local");
    assert.deepEqual((await registry.route(join(other, "reference.md"))).kind, "remote");
    assert.deepEqual((await registry.route("skill/SKILL.md")).kind, "remote");
  });

  it("uses the local spelling when a registered path also exists remotely", async () => {
    const root = await temporaryDirectory();
    const file = join(root, "same.md");
    await writeFile(file, "local");
    const registry = createLocalReadRegistry();
    await registry.replace(Symbol(), [{ kind: "file", path: file }]);
    assert.deepEqual(await registry.route(file), { kind: "local", path: file });
  });

  it("keeps unregistered aliases and normalized alternate spellings remote", async (t) => {
    if (process.platform === "win32") return t.skip("symlink test requires Unix semantics");
    const root = await temporaryDirectory();
    const safe = join(root, "safe");
    const alias = join(root, "alias");
    const unicodeRoot = join(root, "skill\u00a0tree");
    const normalizedRoot = join(root, "skill tree");
    await mkdir(safe);
    await mkdir(unicodeRoot);
    await mkdir(normalizedRoot);
    await writeFile(join(safe, "reference.md"), "safe");
    await writeFile(join(normalizedRoot, "reference.md"), "unregistered");
    await symlink(safe, alias);

    const registry = createLocalReadRegistry();
    await registry.replace(Symbol(), [
      { kind: "tree", path: safe },
      { kind: "tree", path: unicodeRoot },
    ]);
    assert.equal((await registry.route(join(alias, "reference.md"))).kind, "remote");
    assert.equal((await registry.route(join(unicodeRoot, "reference.md"))).kind, "denied");
  });

  it("allows valid double-dot-prefixed descendants", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, "skill");
    const file = join(skill, "..notes.md");
    await mkdir(skill);
    await writeFile(file, "notes");
    const registry = createLocalReadRegistry();
    await registry.replace(Symbol(), [{ kind: "tree", path: skill }]);
    assert.equal((await registry.route(file)).kind, "local");
  });

  it("routes missing tree descendants to a validated canonical path", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, "skill");
    await mkdir(skill);
    const registry = createLocalReadRegistry();
    await registry.replace(Symbol(), [{ kind: "tree", path: skill }]);
    const missing = join(skill, "references", "missing.md");
    assert.deepEqual(await registry.route(missing), { kind: "local", path: missing });
  });

  it("denies escaping and retargeted symlinks instead of using SSH", async (t) => {
    if (process.platform === "win32") return t.skip("symlink test requires Unix semantics");
    const root = await temporaryDirectory();
    const skill = join(root, "skill");
    const outside = join(root, "outside");
    await mkdir(skill);
    await mkdir(outside);
    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(outside, join(skill, "escape"));

    const registry = createLocalReadRegistry();
    const owner = Symbol();
    await registry.replace(owner, [{ kind: "tree", path: skill }]);
    const escaped = await registry.route(join(skill, "escape", "secret.md"));
    assert.equal(escaped.kind, "denied");

    const target = join(root, "target");
    await mkdir(target);
    await writeFile(join(target, "reference.md"), "target");
    const rootLink = join(root, "skill-link");
    await symlink(skill, rootLink);
    await registry.replace(owner, [{ kind: "tree", path: rootLink }]);
    await rm(rootLink);
    await symlink(target, rootLink);
    const retargeted = await registry.route(join(rootLink, "reference.md"));
    assert.equal(retargeted.kind, "denied");
  });

  it("fails closed when a route is revoked while resolving", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, "skill");
    const file = join(skill, "reference.md");
    await mkdir(skill);
    await writeFile(file, "reference");
    const registry = createLocalReadRegistry();
    await registry.replace(Symbol(), [{ kind: "tree", path: skill }]);
    const pending = registry.route(file);
    registry.clear();
    assert.equal((await pending).kind, "denied");
  });

  it("retains the old owner snapshot until an async replacement installs", async () => {
    const root = await temporaryDirectory();
    const first = join(root, "first");
    const second = join(root, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    const registry = createLocalReadRegistry();
    const owner = Symbol();
    await registry.replace(owner, [{ kind: "tree", path: first }]);

    const pendingRoute = registry.route(join(first, "pending.md"));
    const replacement = registry.replace(owner, [{ kind: "tree", path: second }]);
    const duringReplacement = registry.route(join(first, "old.md"));
    assert.equal((await pendingRoute).kind, "denied");
    assert.notEqual((await duringReplacement).kind, "remote");
    await replacement;
    assert.equal((await registry.route(join(first, "old.md"))).kind, "remote");
    assert.equal((await registry.route(join(second, "new.md"))).kind, "local");
  });

  it("replaces one owner, preserves another, and clears on shutdown", async () => {
    const root = await temporaryDirectory();
    const first = join(root, "first");
    const second = join(root, "second");
    const third = join(root, "third");
    await Promise.all([mkdir(first), mkdir(second), mkdir(third)]);
    const registry = createLocalReadRegistry();
    const firstOwner = Symbol();
    const secondOwner = Symbol();
    await registry.replace(firstOwner, [{ kind: "tree", path: first }]);
    await registry.replace(secondOwner, [{ kind: "tree", path: second }]);
    await registry.replace(firstOwner, [{ kind: "tree", path: third }]);
    assert.equal((await registry.route(join(first, "old.md"))).kind, "remote");
    assert.equal((await registry.route(join(second, "kept.md"))).kind, "local");
    assert.equal((await registry.route(join(third, "new.md"))).kind, "local");
    registry.clear();
    assert.equal((await registry.route(join(second, "kept.md"))).kind, "remote");
  });

  it("rejects relative paths and filesystem-root trees atomically", async () => {
    const root = await temporaryDirectory();
    const file = join(root, "file.md");
    await writeFile(file, "file");
    const registry = createLocalReadRegistry();
    const report = await registry.replace(Symbol(), [
      { kind: "tree", path: "/" },
      { kind: "file", path: "relative.md" },
      { kind: "file", path: file },
    ]);
    assert.equal(report.rejected.length, 2);
    assert.equal(report.accepted.length, 1);
    assert.equal((await registry.route(file)).kind, "local");
  });
});
