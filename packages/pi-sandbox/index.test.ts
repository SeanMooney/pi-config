import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  appendUnique,
  collectSkillReadPaths,
  isReadPathAllowed,
  mergeReadAllowances,
} from "./index.ts";

test("interactive grants are additive and cumulative", () => {
  const configuredWrites = [".", "~/repos", "/tmp"];
  const afterReadGrant = appendUnique(configuredWrites, []);
  const afterWriteGrants = appendUnique(afterReadGrant, ["/specific/file", "~/repos"]);

  assert.deepEqual(afterReadGrant, configuredWrites);
  assert.deepEqual(afterWriteGrants, [".", "~/repos", "/tmp", "/specific/file"]);
});

test("loaded skills allow reads only within their skill directories", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-skill-"));
  const skillDir = join(root, "orch");
  const skillFile = join(skillDir, "SKILL.md");
  const asset = join(skillDir, "assets", "implementation-handoff.md");
  const reference = join(skillDir, "references", "review-loop.md");
  const sibling = join(root, "outside.md");

  try {
    for (const filePath of [skillFile, asset, reference, sibling]) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "test\n");
    }

    const allowRead = collectSkillReadPaths([
      { filePath: skillFile, baseDir: skillDir },
      { filePath: skillFile, baseDir: skillDir },
    ]);

    assert.deepEqual(allowRead, [realpathSync(skillDir)]);
    assert.equal(isReadPathAllowed(skillFile, allowRead), true);
    assert.equal(isReadPathAllowed(asset, allowRead), true);
    assert.equal(isReadPathAllowed(reference, allowRead), true);
    assert.equal(isReadPathAllowed(sibling, allowRead), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loaded skill paths fall back to the skill file directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-skill-fallback-"));
  const skillFile = join(root, "SKILL.md");

  try {
    writeFileSync(skillFile, "test\n");
    assert.deepEqual(collectSkillReadPaths([{ filePath: skillFile }]), [realpathSync(root)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated skill allowances never interpret literal paths as globs", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-skill-glob-"));
  const skillDir = join(root, "skill*");
  const siblingDir = join(root, "skill-secret");
  const skillFile = join(skillDir, "SKILL.md");
  const siblingFile = join(siblingDir, "secret.md");

  try {
    mkdirSync(skillDir);
    mkdirSync(siblingDir);
    writeFileSync(skillFile, "test\n");
    writeFileSync(siblingFile, "secret\n");

    const allowRead = collectSkillReadPaths([{ filePath: skillFile, baseDir: skillDir }]);
    assert.deepEqual(allowRead, []);
    assert.equal(isReadPathAllowed(siblingFile, allowRead), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill read allowances are removed when the loaded list is cleared", () => {
  const configured = ["/workspace"];
  const session = ["/session-read"];
  const loadedSkills = ["/skills/orch"];

  assert.deepEqual(mergeReadAllowances(configured, session, loadedSkills), [
    "/workspace",
    "/session-read",
    "/skills/orch",
  ]);
  assert.deepEqual(mergeReadAllowances(configured, session, []), ["/workspace", "/session-read"]);
});
