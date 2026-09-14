import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createLocalReadRegistry } from "./local-read-registry.ts";
import { collectSkillTreeEntries, createSkillLocalReadPolicy } from "./skill-local-read-policy.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-ssh-skill-policy-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("skill local read policy", () => {
  it("deduplicates alternate skill locations and grants each whole tree", async () => {
    const root = await temporaryDirectory();
    const locations = [
      "coding-agent",
      "agents-skills",
      "project",
      "package",
      "settings",
      "cli",
      "extension",
    ];
    await Promise.all(locations.map((name) => mkdir(join(root, name))));
    const entries = collectSkillTreeEntries(
      locations
        .map((name) => ({ baseDir: join(root, name) }))
        .concat([{ baseDir: join(root, "project") }]),
    );
    assert.equal(entries.length, locations.length);
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      locations.map(() => "tree"),
    );

    const registry = createLocalReadRegistry();
    const policy = createSkillLocalReadPolicy(registry, Symbol());
    const report = await policy.refresh(locations.map((name) => ({ baseDir: join(root, name) })));
    assert.equal(report.changed, true);
    assert.equal(report.rejected.length, 0);
    assert.equal(
      (await registry.route(join(root, "package", "references", "ref.md"))).kind,
      "local",
    );
  });

  it("does not replace unchanged roots and removes stale roots on refresh", async () => {
    const root = await temporaryDirectory();
    const first = join(root, "first");
    const second = join(root, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    const registry = createLocalReadRegistry();
    const policy = createSkillLocalReadPolicy(registry, Symbol());
    const skills = [{ baseDir: first }];
    assert.equal((await policy.refresh(skills)).changed, true);
    assert.equal((await policy.refresh(skills)).changed, false);
    assert.equal((await registry.route(join(first, "SKILL.md"))).kind, "local");
    assert.equal((await policy.refresh([{ baseDir: second }])).changed, true);
    assert.equal((await registry.route(join(first, "old.md"))).kind, "remote");
    assert.equal((await registry.route(join(second, "new.md"))).kind, "local");
  });

  it("represents a standalone markdown skill by its shared parent tree", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "shared"));
    const filePath = join(root, "shared", "standalone.md");
    await writeFile(filePath, "skill");
    const entries = collectSkillTreeEntries([{ baseDir: join(root, "shared"), filePath }]);
    assert.deepEqual(entries, [{ kind: "tree", path: join(root, "shared") }]);

    const registry = createLocalReadRegistry();
    const policy = createSkillLocalReadPolicy(registry, Symbol());
    const report = await policy.refresh([{ baseDir: join(root, "shared"), filePath }]);
    assert.deepEqual(report.standaloneParentTrees, [join(root, "shared")]);
  });

  it("reports an unsafe filesystem root without widening access", async () => {
    const registry = createLocalReadRegistry();
    const policy = createSkillLocalReadPolicy(registry, Symbol());
    const report = await policy.refresh([{ baseDir: "/" }]);
    assert.equal(report.rejected.length, 1);
    assert.equal(report.installed, true);
    assert.equal((await registry.route("/etc/passwd")).kind, "remote");
  });
});
