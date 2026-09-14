import { basename, resolve } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  type LocalReadEntry,
  type LocalReadRegistrationReport,
  type LocalReadRegistry,
} from "./local-read-registry.ts";

export type DiscoveredSkill = Pick<Skill, "baseDir"> & Partial<Pick<Skill, "filePath">>;

export interface SkillReadRefreshReport extends LocalReadRegistrationReport {
  readonly changed: boolean;
  readonly fingerprint: string;
  readonly standaloneParentTrees: readonly string[];
}

export interface SkillLocalReadPolicy {
  refresh(skills: readonly DiscoveredSkill[] | undefined): Promise<SkillReadRefreshReport>;
  reset(): void;
}

// A directory-form skill grants its own tree; a standalone Markdown skill's
// baseDir is its shared parent. The latter whole-tree grant is intentional.
export function collectSkillTreeEntries(
  skills: readonly DiscoveredSkill[] | undefined,
): readonly LocalReadEntry[] {
  const roots = new Set<string>();
  for (const skill of skills ?? []) roots.add(resolve(skill.baseDir));
  return [...roots].sort().map((path) => ({ kind: "tree", path }));
}

function collectStandaloneParentTrees(
  skills: readonly DiscoveredSkill[] | undefined,
): readonly string[] {
  const roots = new Set<string>();
  for (const skill of skills ?? []) {
    if (skill.filePath && basename(skill.filePath).toLowerCase() !== "skill.md") {
      roots.add(resolve(skill.baseDir));
    }
  }
  return [...roots].sort();
}

export function createSkillLocalReadPolicy(
  registry: LocalReadRegistry,
  owner: symbol,
): SkillLocalReadPolicy {
  let fingerprint: string | undefined;

  return {
    async refresh(skills) {
      const entries = collectSkillTreeEntries(skills);
      const standaloneParentTrees = collectStandaloneParentTrees(skills);
      const nextFingerprint = entries.map((entry) => entry.path).join("\u0000");
      if (nextFingerprint === fingerprint) {
        return {
          accepted: entries,
          rejected: [],
          installed: true,
          changed: false,
          fingerprint: nextFingerprint,
          standaloneParentTrees,
        };
      }

      const report = await registry.replace(owner, entries);
      if (report.installed) fingerprint = nextFingerprint;
      return {
        ...report,
        changed: true,
        fingerprint: nextFingerprint,
        standaloneParentTrees,
      };
    },
    reset() {
      fingerprint = undefined;
    },
  };
}
