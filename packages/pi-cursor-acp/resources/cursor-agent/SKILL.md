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
tool is always visible in eligible main sessions, so the model owns this intent
decision: never invoke it proactively, for a negated request, or for a question
that merely mentions Cursor. Interactive sessions ask the user for final
confirmation before each delegation; headless sessions rely entirely on this
explicit-request rule.

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
4. Call `cursor_agent` once for each delegation the user requested. Multiple
   sequential calls are allowed, and interactive sessions confirm each one. Do
   not ask an ordinary Pi subagent to call Cursor.
5. When the user requests Cursor and ordinary Pi reviewers in parallel, launch
   `cursor_agent` from the main thread in the same parallel tool batch as the Pi
   subagent call. Monitor Cursor through its tool updates and the Pi child
   through the subagent run status; the Pi child still cannot access
   `cursor_agent` itself.
6. Evaluate Cursor's result rather than accepting it automatically.
   - For implementation, inspect the resulting diff and run appropriate
     validation with Pi's own tools.
   - For review, verify findings against the code before presenting them.
   - For context, distinguish verified facts from Cursor's interpretation.

## Guardrails

- Cursor-native subagents and MCP tools are prohibited.
- Ordinary Pi subagent children must never receive the `cursor_agent` tool.
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
