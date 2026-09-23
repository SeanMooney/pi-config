# Extension configuration

Pi extensions in this profile read their own configuration from per-extension
sidecar files under `PI_CODING_AGENT_DIR`, resolved via Pi's `getAgentDir()`.
This is the current Pi convention. Older extensions kept their options in
`settings.json`; Pi added the sidecar pattern later, so some third-party
packages (for example `rpiv-advisor` at `~/.config/rpiv-advisor/advisor.json`)
also keep config outside `settings.json`.

## When to use which

- **Sidecar file** — Prefer this for new extension-owned options. Pi core does
  not expose a generic API for an extension to read an arbitrary custom key out
  of `settings.json`, and `settings.json` has a fixed, Pi-owned schema.
- **`settings.json`** — Only for options that belong to Pi's own schema
  (`packages`, `skills`, `enabledModels`, and similar).

## Conventions

- Resolve the path from `getAgentDir()`; do not hardcode `~/.pi/agent` or
  `~/.config/pi`.
- Treat a missing file as "use defaults"; fail loudly on malformed or invalid
  config rather than silently falling back.
- Document the file name and schema in the extension's own `README.md`.
- Changes apply on `/reload` or restart, matching how Pi loads extensions.

## Current sidecar files

- `vertex-claude.json` — Vertex Claude family alias overrides. See
  `extensions/vertex-claude/README.md`.
