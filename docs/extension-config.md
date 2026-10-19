# Extension configuration

Configure extensions through their documented sidecar files. Profile sidecars
live under `$PI_CODING_AGENT_DIR`; some third-party extensions use a separate
location, such as `~/.config/rpiv-advisor/advisor.json` for `rpiv-advisor`.

## When to use which

- **Sidecar file** — Extension-owned options.
- **`settings.json`** — Only for options that belong to Pi's own schema
  (`packages`, `skills`, `enabledModels`, and similar).

Follow the extension's documentation for supported keys and whether changes
require `/reload` or a restart.

## Current sidecar files

- `web-search.json` — Codex-first search with Brave fallback. See
  `docs/web-search.md` for functionality and configuration.
- `vertex-claude.json` — Vertex Claude family alias overrides. See
  `extensions/vertex-claude/README.md`.
