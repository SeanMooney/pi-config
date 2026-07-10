# Style and formatting

Handwritten Markdown is formatted and checked at 80 columns. Handwritten code
should prefer 80 columns, but may use up to 100 when that improves clarity. Keep
a long URL on its own line when practical. Any line containing a URL is exempt
from the hard width check; do not split URLs or indivisible data literals merely
to meet a width limit.

Oxfmt is the formatter for explicitly supplied TypeScript, JavaScript, JSON, and
Markdown files using the root `.oxfmtrc.json`. markdownlint enforces Markdown
rules and widths. Generated files, lockfiles, dependency trees, caches,
sessions, state, temporary files, credentials, and repository JSON data are
exempt rather than restyled. Shell formatting remains manual.

Use explicit filenames only:

```bash
scripts/format.sh path/to/file.ts path/to/file.md
scripts/check-format.sh path/to/file.ts path/to/file.md
```

The scripts safely ignore deleted, generated, data, and unsupported paths so
they can receive a future pre-commit hook's filename list. They intentionally do
not format the whole repository. Formatter tooling shares the managed npm
manifest and lock, so it changes alongside Pi package updates. Install it with
`(cd "$PI_CODING_AGENT_DIR/npm" && npm ci --include=dev)` when unavailable. The
repository intends pre-commit integration later but does not configure it yet.
