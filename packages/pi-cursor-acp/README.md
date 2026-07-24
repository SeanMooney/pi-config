# Pi Cursor ACP

`pi-cursor-acp` provides intentional Cursor Agent delegation from Pi through the
official Cursor CLI's ACP server.

Cursor is not a Pi model provider. The package registers a `cursor_agent` tool
and exposes the `cursor-agent` skill in eligible main sessions. Both are absent
from Pi subagent children and from Pi sessions using `--ssh`.

## Prerequisites

1. Install the package dependencies from `$PI_CODING_AGENT_DIR`:

   ```bash
   cd packages/pi-cursor-acp
   npm ci --ignore-scripts
   ```

2. Install Cursor CLI `2026.07.23` or newer so `agent` is on `PATH`.
3. Authenticate interactively:

   ```bash
   agent login
   ```

4. Confirm the configured models are available:

   ```bash
   agent models
   ```

## Invocation

Cursor delegation must be explicit:

```text
Ask Cursor to gather context on the scheduler filters.
Use Cursor Agent to implement this change.
Have Cursor review my current diff.
/skill:cursor-agent review the current diff
```

The tool remains visible so the main model can apply the skill's
natural-language intent rules. The model must not invoke it for incidental
mentions, conceptual questions, or negated requests. Interactive sessions show a
final confirmation with the intent, model, and task before every delegation.
Headless sessions trust the model's explicit-request judgment. Multiple
sequential delegations are allowed.

For a parallel review, the main model can launch `cursor_agent` in the same
parallel tool batch as an asynchronous ordinary Pi reviewer. Cursor runs as a
separate ACP process and streams tool progress while the Pi subagent is tracked
through its run status. The Pi child never receives `cursor_agent`.

## Default profiles

<!-- markdownlint-disable MD060 -->

| Intent         | Cursor mode | Cursor CLI model            |
| -------------- | ----------- | --------------------------- |
| Context        | `ask`       | `composer-2.5-fast`         |
| Implementation | `agent`     | `cursor-grok-4.5-high-fast` |
| Review         | `ask`       | `cursor-grok-4.5-high-fast` |

<!-- markdownlint-enable MD060 -->

Explicit available model overrides are allowed. The extension verifies the ACP
session's selected model and fails rather than accepting a silent fallback.
Cursor ACP currently advertises only Grok 4.5 High Fast even though the CLI
model list includes other effort aliases.

## Isolation and permissions

Each delegation starts a fresh `agent acp` process and session. A temporary
`CURSOR_CONFIG_DIR` under `$PI_CODING_AGENT_DIR/.tmp/pi-cursor-acp` isolates CLI
settings while retaining the authenticated Cursor account. Child processes
receive an allowlisted environment containing only required system, locale,
proxy/certificate, and XDG variables; arbitrary Pi, provider, cloud, and
registry variables are not forwarded. Required proxy URLs are preserved and may
themselves contain proxy credentials. The process loads only the package's
required policy plugin explicitly. Existing user or project Cursor resources may
still be discovered by Cursor; policy hooks block MCP, Cursor-native subagents,
sensitive paths, and unsafe operations at execution.

The policy:

- blocks Cursor-native subagents and MCP tools;
- blocks web/browser tools because reliable prompt mediation is unavailable;
- blocks sensitive and outside-workspace file-tool access;
- blocks commits, pushes, releases, pull requests, and publishing;
- prompts through ACP for other shell commands;
- never grants `allow-always` through Pi;
- rejects permission requests when Pi has no interactive UI.

Cursor uses Cursor's sandbox and hooks, not Pi's `pi-sandbox`, permission gate,
or protected-path extension. Cursor's `--sandbox enabled` setting is the primary
filesystem boundary for arbitrary shell commands; the shell hook is additional
command inspection, not complete shell containment. Implementation mode edits
the current worktree and leaves changes uncommitted. Pi receives before/after
aggregate Git state and must inspect and validate the result independently.

## Validation

```bash
npm test
npm run check
```

Authenticated no-prompt probes have verified ACP initialization, authentication,
profile selection, mode switching, and acceptance of the `--plugin-dir`
argument. A full read-only review generation has also completed through the
extension's direct child-process path. Policy denial paths remain covered by
deterministic hook tests rather than an end-to-end implementation smoke test.
