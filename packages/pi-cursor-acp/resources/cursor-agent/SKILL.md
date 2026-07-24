---
name: cursor-agent
description: >
  Intentionally delegate a code implementation, code review, or
  context-gathering task to Cursor Agent through the cursor_agent tool. Use only
  when the user explicitly asks to use, invoke, or delegate work to Cursor or
  Cursor Agent. Do not use for ordinary coding work, incidental mentions of
  Cursor, or when choosing a normal Pi provider or Pi subagent.
license: MIT
---

# Cursor Agent

Use this skill only after an explicit user request to involve Cursor Agent. The
`cursor_agent` tool is authorized for one delegation in that turn. Never invoke
it proactively.

## Process

1. Classify the request as exactly one intent:
   - `context`: gather or summarize repository context without changes.
   - `implement`: edit code in the current worktree and validate it.
   - `review`: independently review code or a diff without changes.
2. Prepare a self-contained task containing the goal, relevant paths, known
   constraints, expected output, and validation expectations.
3. Use the workflow default unless the user explicitly requests an override:
   - `context`: `composer-2.5-fast` in Cursor `ask` mode.
   - `implement`: `cursor-grok-4.5-high-fast` in Cursor `agent` mode.
   - `review`: `cursor-grok-4.5-high-fast` in Cursor `ask` mode.
4. Call `cursor_agent` exactly once. Do not delegate through an ordinary Pi
   subagent and do not ask an ordinary subagent to call Cursor.
5. Evaluate Cursor's result rather than accepting it automatically.
   - For implementation, inspect the resulting diff and run appropriate
     validation with Pi's own tools.
   - For review, verify findings against the code before presenting them.
   - For context, distinguish verified facts from Cursor's interpretation.

## Guardrails

- Cursor-native subagents and MCP tools are prohibited.
- Cursor must not commit, push, publish, open pull requests, or access secrets.
- Cursor implementation edits the current worktree and leaves changes
  uncommitted.
- Cursor runs under its own sandbox and policy hooks, not Pi's sandbox.
- Do not claim exact attribution for edits if another process changed the
  worktree concurrently.
- If the requested override is unavailable, report the failure and ask whether
  to use the workflow default. Never silently fall back to another model.

## Output

Report the selected Cursor profile, summarize Cursor's result, state what Pi
independently verified, and identify remaining uncertainty or validation work.
