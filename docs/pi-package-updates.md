# Updating pinned Pi packages

This profile pins Pi package and MCP npx package versions in `settings.json` and
`mcp.json` for reproducibility. Pi's built-in `pi update` is still useful for the
Pi CLI itself and any unpinned packages, but pinned package specs are intentionally
skipped until their pins move.

Use the helper from `PI_CODING_AGENT_DIR`:

```bash
scripts/check-pi-package-updates.mjs
```

It checks pinned `npm:` package specs in `settings.json` and pinned npx package
arguments in `mcp.json` against `npm view <pkg> version`.

To update the pins intentionally:

```bash
scripts/check-pi-package-updates.mjs --write
pi install
```

Then restart Pi or run `/reload` as appropriate. Review the resulting git diff
before committing.

For self updates, continue to use Pi's built-in updater:

```bash
pi update --self
```
