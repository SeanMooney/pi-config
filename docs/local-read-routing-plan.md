# Local read routing in SSH mode

## Status

Implemented as a narrow fix on `fix/ssh-local-skill-reads` before rebasing
`feature/pi-orchestrator-effect` onto the updated `master` branch.

## Problem

Pi discovers skills on the local control host and publishes their absolute paths
in the system prompt. In SSH mode, `extensions/ssh.ts` replaces the `read` tool
with an implementation that sends every path to the remote host. Loading a
locally discovered skill therefore fails when that path does not also exist on
the remote host.

The same problem applies to local reference files that belong to a skill. Skills
may come from `PI_CODING_AGENT_DIR`, `.agents/skills`, project directories,
packages, settings, CLI paths, or extension resource discovery, so hard-coding
one configuration directory is insufficient.

## Decision

Add one instance-scoped local-read registry and compose two policies around it:

1. the SSH `read` override asks the registry whether an absolute path is an
   approved local control-host path;
2. a skill policy refreshes one approved directory tree for every discovered
   skill `baseDir` before an agent turn begins; and
3. unmatched reads continue to use the SSH workspace backend.

The selected skill policy approves the **whole skill tree**, including bundled
references and assets. It does not approve local script execution.

Implement this on a new `fix/ssh-local-skill-reads` branch created from updated
`master`. Merge the narrow fix first, then rebase
`feature/pi-orchestrator-effect`. The orchestrator branch currently adds only
`packages/pi-orchestrator/**` and two design documents, so it has no file-level
overlap with `extensions/ssh.ts` or the proposed helper files.

## Goals

- Load discovered `SKILL.md` files locally while Pi uses an SSH workspace.
- Allow local reads of references and assets beneath each skill `baseDir`.
- Support every skill location reported by Pi rather than a fixed directory.
- Provide a reusable registration primitive for later local control resources.
- Keep relative workspace reads and all unmatched reads remote.
- Preserve Pi's built-in read behavior for offsets, truncation, images,
  cancellation, rendering, and tool-call policy hooks.
- Fail closed when a registered local path escapes or changes identity.

## Non-goals

- Local writes or edits in SSH mode.
- Local Bash execution or execution of scripts bundled with skills.
- Local `grep`, `find`, or `ls` routing.
- Remote skill discovery.
- Changes to `/skill:name`, Pi core, `pi-subagents`, or child process behavior.
- Integration with orchestration state, Effect services, or workspace provider
  APIs.
- A model-callable tool that can register or widen local access.

## Proposed files

```text
extensions/
├── ssh.ts
└── ssh/
    ├── local-read-registry.ts
    ├── local-read-registry.test.ts
    ├── skill-local-read-policy.ts
    └── skill-local-read-policy.test.ts
```

Keep the existing non-Effect SSH architecture. This is a small synchronous and
filesystem-bound policy component, not a reason to introduce an Effect runtime.

## Local-read registry

### Contract

Use an instance created inside `sshExtension()`, then pass that instance to the
SSH read router and skill policy. Do not use a process-global singleton or a
second extension that competes for ownership of the `read` tool.

A conceptual contract is:

```typescript
type LocalReadEntry =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "tree"; readonly path: string };

type LocalReadDecision =
  | { readonly kind: "remote" }
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "denied"; readonly path: string; readonly reason: string };

interface LocalReadRegistry {
  replace(
    owner: symbol,
    entries: readonly LocalReadEntry[],
  ): Promise<LocalReadRegistrationReport>;
  remove(owner: symbol): void;
  route(path: string): Promise<LocalReadDecision>;
  clear(): void;
}
```

`replace()` updates only one owner's entries and removes stale entries from its
previous registration. Other owners remain intact. It validates all submitted
entries, installs the valid subset atomically, and reports rejected entries for
an extension diagnostic. Repeating the same replacement is idempotent.

The first consumer uses a private `skillTreesOwner` symbol. Future adapters may
register other explicit control-host files or trees by receiving the same
registry instance from the SSH composition root.

### Path rules

- Only absolute input paths are eligible for local routing. Relative tool paths
  always remain in the remote workspace namespace.
- Registration accepts only absolute paths that exist at registration time.
- A tree registration for the filesystem root is rejected.
- Matching is component-aware using `path.relative()`, never string-prefix
  matching. For example, `/safe-skill-other` is not beneath `/safe-skill`.
- Registration stores both the supplied lexical root and its `realpath()`.
- A request may use the registered lexical path or canonical path.
- Existing requested files are canonicalized before approval. Their canonical
  targets must remain inside the registered canonical tree.
- For a missing requested path beneath a registered tree, canonicalize its
  nearest existing ancestor. If that ancestor is still contained, route the
  request locally and let the local read report the normal missing-file error.
- A symlink that escapes the canonical tree produces a `denied` decision.
- If a registered root symlink is retargeted after registration, requests that
  no longer resolve beneath the pinned canonical root are denied.
- A denied or failed matched local read never falls back to SSH.
- When the same absolute path exists locally and remotely, a registered local
  match takes precedence.

These checks reduce accidental namespace confusion and symlink escapes. They do
not eliminate all filesystem time-of-check/time-of-use races; that limitation
must be documented in the implementation.

## SSH read routing

Create both tools once after SSH connection resolution:

- `localRead = createReadTool(localCwd)`;
- `remoteRead = createReadTool(localCwd, { operations: remoteReadOps })`.

Register one `read` wrapper with the remote tool's schema and metadata. Its
`execute()` method routes before any remote path rewriting:

1. relative input: delegate to `remoteRead`;
2. absolute input with `remote` decision: delegate to `remoteRead`;
3. absolute input with `local` decision: delegate to `localRead`; or
4. `denied` decision: throw a local access error.

Delegating to Pi's two built-in read instances preserves read semantics and
avoids duplicating offsets, truncation, image processing, cancellation, result
shape, and rendering.

Do not put the registry into `createRemoteReadOps()`. `createRemoteEditOps()`
currently reuses those operations for edit's internal read. Keeping routing in
the top-level `read` wrapper ensures `edit` remains entirely remote.

Existing `tool_call` permission and audit handlers still run before the selected
read implementation because Pi sees only one registered `read` tool.

## Automatic skill-tree registration

Register a `before_agent_start` handler in the SSH extension composition. At
that point Pi 0.85.1 exposes the fully loaded skill list as
`event.systemPromptOptions.skills`, including default, settings, CLI, package,
project, and `resources_discover` contributions.

For each skill:

1. take `skill.baseDir` as a `{ kind: "tree" }` entry;
2. deduplicate identical roots;
3. compute a stable fingerprint of the requested roots;
4. call `replace(skillTreesOwner, entries)` only when the fingerprint changes;
   and
5. report rejected roots without exposing unrelated local paths to the model.

This handler runs before the first model response, so automatic model-initiated
skill reads are routed correctly. `/skill:name` already expands through Pi's
local resource loader and remains unchanged.

On `/reload` or session replacement, the next `before_agent_start` refresh
replaces the skill owner's complete set and removes stale roots. On
`session_shutdown`, remove the skill owner and clear the registry owned by that
SSH extension instance.

### Whole-tree consequence

A directory-form skill normally grants only its self-contained skill directory.
A standalone Markdown skill has `baseDir` equal to its parent directory. Under
the selected whole-tree policy, such a skill grants local read access to that
entire shared parent directory. This is intentional and must be visible in the
implementation documentation and diagnostics; it must not silently fall back to
exact-file registration.

The filesystem root remains invalid as a tree registration. If encountered,
reject it and report the skill as unavailable for automatic local reading rather
than granting access to the entire local filesystem.

Project-local skills retain Pi's existing project-trust boundary: the policy
registers only skills Pi has already loaded and supplied in
`systemPromptOptions.skills`.

## Orchestrator compatibility

The narrow registry represents local control-resource read exceptions. It does
not represent a workspace backend and must not import `packages/pi-orchestrator`
types.

Treat an approved match as an explicit control-resource route selected before
workspace dispatch. It is never a fallback inside `WorkspaceProvider`; once a
read is classified as a workspace operation, the provider must retain its
existing no-local-fallback invariant.

This is compatible with the orchestrator design invariants:

- Pi resources stay on the local control host;
- ordinary workspace reads remain remote;
- there is still exactly one owner for the `read` tool; and
- no local fallback exists for an unmatched SSH workspace operation.

Do not automatically register orchestration artifact directories. The
orchestrator design reserves those for its attempt-scoped artifact-ID tool.
Likewise, do not propagate a parent's registered paths implicitly into children.
A future child bootstrap must construct its own approved control-resource
registry from the resources deliberately exposed to that child.

The future `pi-workspace-runtime` package should absorb the routing adapter when
it replaces `extensions/ssh.ts`. The registration semantics—owner-scoped exact
files or trees and canonical containment—can remain stable. A future provider
may represent approved local reads with its branded `ControlPath`, but the
orchestrator reducer and workflow state should not depend on this transitional
registry.

## Validation

### Registry unit tests

Cover:

1. exact files and explicit trees;
2. component-aware prefix collisions;
3. relative paths remaining remote;
4. local and remote files with the same absolute spelling, where registered
   local access wins;
5. symlinks contained within a tree;
6. symlinks escaping a tree;
7. a registered root symlink retargeted after registration;
8. missing descendants returning a local missing-file path;
9. rejected relative paths and filesystem-root trees;
10. owner replacement removing stale entries while preserving other owners; and
11. registry clearing on shutdown.

### Skill policy tests

Use synthetic `Skill` objects for:

1. skills under `PI_CODING_AGENT_DIR`;
2. `.agents/skills` and project-local skills;
3. package, settings, CLI, and extension-contributed locations;
4. multiple skills sharing one directory;
5. standalone Markdown skills granting their shared parent tree;
6. deduplication and unchanged fingerprints;
7. resource refresh removing deleted skills; and
8. rejection diagnostics for an unsafe root.

### SSH routing tests

Use injected local and fake-SSH read implementations to prove:

1. registered absolute skill and reference paths use local reads;
2. unregistered absolute paths use SSH;
3. all relative paths use SSH;
4. denied local matches never call SSH;
5. local read failures never retry remotely;
6. offsets, truncation, images, and cancellation retain Pi behavior; and
7. write, edit, Bash, and user `!` operations remain remote and unchanged.

No test should require a live SSH host.

## Delivery sequence

1. Create `fix/ssh-local-skill-reads` from updated `master`.
2. Add the registry and focused unit tests.
3. Add the single hybrid SSH `read` router and fake-SSH tests.
4. Add automatic whole-skill-tree registration and lifecycle tests.
5. Run formatting, type checks, focused tests, and a manual fake-SSH smoke test.
6. Merge the fix into `master`.
7. Rebase `feature/pi-orchestrator-effect` onto that new `master`.
8. Run the orchestrator package's existing unit suite after rebase.

Do not combine the orchestrator rebase with the local-read implementation
commit. Keeping them separate makes regressions and any later migration into
`pi-workspace-runtime` easier to review.

## Definition of done

- A model can automatically read every discovered local skill and files beneath
  its `baseDir` while using `--ssh`.
- Relative and unregistered reads still execute remotely.
- No denied or failed local match falls back to SSH.
- No mutation or execution capability is granted locally.
- Reload and session replacement remove stale skill roots.
- Symlink and path-prefix tests pass.
- The implementation has no dependency on `pi-orchestrator`.
- The orchestrator branch rebases and its unit suite still passes afterward.
