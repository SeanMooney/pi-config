# Trigger and Output Evals

Use these cases to review activation and behavior. The skill must activate for
TypeScript work even when the prompt does not mention Effect.

## Should Trigger

1. “Build a small TypeScript CLI that reads a config file and calls two HTTP
   APIs.”
2. “Review this `.ts` diff for type-safety and maintainability problems.”
3. “Refactor our TypeScript job runner so cancellation and cleanup are
   reliable.”
4. “Add a new SDK integration to this TypeScript service.”
5. “Fix the unsafe JSON parsing in `src/catalog.ts`.”
6. “Design the domain types and persistence boundary for a new Node service.”
7. “Create a Pi extension that runs background commands and exposes status and
   kill tools.”
8. “Debug the missing service error in this Effect 4 layer composition.”
9. “Add tests for concurrent updates in this TypeScript manager.”
10. “Migrate this Promise-heavy module to Effect.”

## Should Not Trigger

1. “Review this Python OpenStack patch.”
2. “Write a Rust command-line parser.”
3. “Change the colors in this JSON theme.”
4. “Summarize this architecture document without changing code.”
5. “Create a generic Agent Skill for PDF processing.”
6. “Debug this Bash script.”
7. “Explain database normalization without implementation code.”
8. “Update this Markdown release note.”
9. “Review a Go HTTP handler.”
10. “Fetch the current Jira sprint.”

## Output-Quality Cases

### New project without an Effect request

Prompt: “Create a TypeScript service that polls an API, stores the latest
result, and shuts down cleanly.”

Expected behavior:

- Recognizes this as a new TypeScript project and chooses Effect 4 by default.
- Uses `^4.0.0-beta.101` as the minimum baseline or a newer verified release.
- Separates domain values, an API capability, live adapter, configuration, and
  polling workflow without imposing unnecessary directories.
- Uses Effect Config, typed expected errors, shared-state primitives, and scoped
  cleanup.
- Adds compatible language-service tooling when practical.

### Existing non-Effect project

Prompt: “Fix a response-header bug in this established Express TypeScript
application. Do not redesign unrelated code.”

Expected behavior:

- Activates for the TypeScript work and applies strict type-safety conventions.
- Preserves the Express application's established non-Effect architecture.
- Does not add Effect dependencies or hide an Effect migration in the bug fix.
- May mention Effect adoption separately only if it is materially relevant.

### Small external API

Prompt: “Add one abortable call to a Promise-based geocoding SDK in this new
Effect service.”

Expected behavior:

- Allows a local `Effect.tryPromise` wrapper.
- Maps rejection into a tagged expected error.
- Forwards interruption to the SDK signal.
- Does not require a service or adapter directory for one local operation.

### Broad external API

Prompt: “Integrate a payment SDK across six workflows with shared credentials,
webhook decoding, retries, and transport-specific errors.”

Expected behavior:

- Creates a named adapter that contains SDK and transport types.
- Exposes typed domain Effects to workflows.
- Uses a service and live layer because the integration is shared and
  replaceable.
- Centralizes configuration, error mapping, cancellation, and retry policy.

### Domain discipline

Prompt: “Model orders, customer IDs, payment IDs, and the order lifecycle for a
new TypeScript service.”

Expected behavior:

- Uses distinct branded or opaque identifiers.
- Uses readonly records and a tagged lifecycle union.
- Uses exhaustive matching for lifecycle decisions.
- Uses Effect Schema at external boundaries while keeping domain workflows
  independent of transport data.

### Configuration

Prompt: “Read API credentials, retry counts, and an optional endpoint from the
environment in a new Effect application.”

Expected behavior:

- Uses Effect Config and validates constraints.
- Keeps secrets out of log output.
- Injects configuration into live capabilities rather than repeatedly reading
  `process.env`.

### Shared state

Prompt: “Track concurrent jobs, waiters, and a maximum-running limit.”

Expected behavior:

- Uses Effect primitives for genuinely shared or concurrent state.
- Makes admission and reservation atomic and releases bookkeeping in
  `Effect.ensuring`.
- Permits encapsulated local collections for readonly snapshots when they cannot
  race.
- Tests concurrent admissions, cancellation, and idempotent cleanup.

### Pi extension lifecycle

Prompt: “Build a Pi extension with two tools sharing a process manager and
background fibers.”

Expected behavior:

- Keeps Pi registration and TypeBox schemas plain.
- Uses one lazy managed runtime shared by the tools.
- Crosses into Effect once per tool execution path and forwards Pi's signal.
- Owns resources through scopes and disposes the runtime during
  `session_shutdown`.
- Throws only at the Pi tool boundary, truncates output, and returns typed
  details.

### Review request

Prompt: “Review this TypeScript change; do not edit.”

Expected behavior:

- Leads with prioritized findings and file references.
- Applies strict TypeScript conventions even if Effect is absent.
- Distinguishes defects from optional Effect adoption.
- Does not recommend migrating an established non-Effect project unless the
  review scope requests it.
- Does not modify files.
