# Pi Agent Config Guidance

This repository is the Pi agent configuration directory managed via dotfiles /
Nix Home Manager.

- Follow the XDG-oriented Pi layout configured by environment variables.
- Do not assume Pi config lives at `~/.pi/agent`; resolve paths from
  `PI_CODING_AGENT_DIR` when planning or changing config.
- Do not assume the default session location; respect
  `PI_CODING_AGENT_SESSION_DIR` for session-related work.
- Never bypass, disable, or work around commit signing failures. Stop after the
  first failure, preserve staged changes and any commit-message draft, and ask
  the user for help.

## Guardrails

- Do not take mutating, destructive, or otherwise state-changing actions without
  the user's express consent. When you notice something that seems wrong, report
  it and ask; do not fix it on your own initiative.
- An observation or correction from the user is not authorization to act. Only
  an explicit instruction to perform a specific action authorizes it, and that
  authorization is scoped to that action alone.
- **Git:** Read-only operations (`git log`, `git diff`, `git status`) are fine.
  Do not run mutating operations (`add`, `commit`, `amend`, `reset`, `checkout`,
  `restore`, `push`, `stash`, `merge`, `rebase`, etc.) unless explicitly
  instructed. Each instruction covers only the action named; do not chain
  follow-on git actions such as amending or reverting a prior commit.
- Do not regenerate lockfiles, delete or move files, install or remove
  dependencies, or run other state-changing commands unless explicitly asked.
- Prefer repository-relative paths when editing this config repo, and mention
  the corresponding environment-variable path in plans.
- Extension config uses per-extension sidecar files under `PI_CODING_AGENT_DIR`
  resolved via `getAgentDir()`, not `settings.json`; see
  `docs/extension-config.md`.
- Keep this file minimal; put detailed workflow guidance in dedicated docs or
  extension comments.
- Formatting follows `docs/style.md`; use its scripts for touched files.
