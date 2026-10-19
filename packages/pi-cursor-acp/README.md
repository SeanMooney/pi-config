# Pi Cursor ACP

`pi-cursor-acp` adds the `cursor_agent` tool and `cursor-agent` skill for
explicitly requested context gathering, implementation, and review through
Cursor Agent. It is not a Pi model provider and is unavailable in Pi subagent
children or sessions using `--ssh`.

## Setup

Install the package dependencies from `$PI_CODING_AGENT_DIR`:

```bash
(cd packages/pi-cursor-acp && npm ci --ignore-scripts)
```

Install Cursor CLI with ACP support (`2026.07.23` or newer), ensure `agent` is
on Pi's `PATH`, and authenticate:

```bash
agent login
agent models
```

## Usage and configuration

Request Cursor explicitly, for example:

```text
Ask Cursor to gather context on the scheduler filters.
Use Cursor Agent to implement this change.
Have Cursor review my current diff.
```

Interactive sessions require confirmation of each delegation. Headless sessions
require an explicit request but cannot approve permission prompts. Only one
Cursor delegation can run at a time.

<!-- markdownlint-disable MD060 -->

| Intent         | Cursor mode | Default model               |
| -------------- | ----------- | --------------------------- |
| Context        | `ask`       | `composer-2.5-fast`         |
| Implementation | `agent`     | `cursor-grok-4.5-high-fast` |
| Review         | `ask`       | `cursor-grok-4.5-high-fast` |

<!-- markdownlint-enable MD060 -->

Request an exact available model to override the default. Supported model
families also accept `speed: "standard" | "fast"`; Grok accepts
`effort: "low" | "medium" | "high"`. An unavailable or mismatched model fails
rather than silently falling back.

## Permissions

Cursor uses its own sandbox, not Pi's sandbox. Implementation edits the current
worktree and leaves changes uncommitted; inspect and validate them before use.

Cursor delegation blocks:

- Cursor-native subagents, MCP, and web/browser tools;
- sensitive and outside-workspace file access;
- commits, pushes, releases, pull requests, and publishing.

Other shell commands require permission. Permanent permission grants are not
accepted, and requests without an interactive UI are rejected.
