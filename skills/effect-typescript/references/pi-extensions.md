# Pi Extensions with Effect 4

This reference adapts patterns observed in a Pi extension repository. Use the
current Pi documentation, the target extension, installed Effect declarations,
and compiling tests as the sources of truth.

## Boundary

Pi expects a plain extension factory and ordinary callbacks:

- `pi.registerTool` execution;
- commands and event handlers;
- renderers and TUI components;
- session lifecycle hooks.

Keep registration, TypeBox schemas, rendering, and pure formatting as plain
TypeScript. Run an Effect once when an execution path enters the application
core. Each tool or command may have its own outer boundary; “one boundary” does
not mean one boundary for the entire extension.

## New Extension Baseline

For a new Pi extension:

- use Effect 4 as the application core;
- start from `effect@^4.0.0-beta.101` or a newer verified release;
- add related Effect packages on compatible versions;
- use strict ESM TypeScript and `.ts` on local imports;
- adopt supported Effect language-service tooling when compatible;
- add packages with the package manager;
- default to `node:test` unless the project establishes another runner.

A purely synchronous renderer or registration module may contain little Effect
code. Effect-first does not require inventing a runtime or service when there is
no asynchronous workflow or resource lifetime.

## Runtime

Use `Effect.runPromiseExit` directly for a self-contained operation with no
shared layer or resource lifetime.

Create one lazy `ManagedRuntime` per extension instance when tool calls share
services, background fibers, stateful capabilities, or scoped resources:

```ts
const AppLayer = ManagerLive.pipe(Layer.provide(DependencyLive));

const createRuntime = () => ManagedRuntime.make(AppLayer);
type AppRuntime = ReturnType<typeof createRuntime>;

let runtime: AppRuntime | undefined;
const getRuntime = () => (runtime ??= createRuntime());
```

At the Pi boundary:

```ts
const exit = await getRuntime().runPromiseExit(
  program,
  signal ? { signal } : undefined,
);

if (Exit.isSuccess(exit)) return exit.value;
if (Cause.hasInterruptsOnly(exit.cause)) {
  throw new Error("Operation was cancelled.");
}
const [first] = Cause.prettyErrors(exit.cause);
throw new Error(first?.message ?? Cause.pretty(exit.cause));
```

Pi marks a tool result as failed only when `execute` throws. Keep throws at this
host boundary; use typed Effect failures in the core.

## Lifecycle

Do not start long-lived resources during extension factory execution. Start them
during `session_start` or on first use.

In `session_shutdown`:

1. prevent new work from observing the closing instance;
2. unsubscribe Pi-side listeners;
3. clear cached runtime and service promises;
4. await runtime disposal.

Put process, fiber, stream, subscription, and remote-job cleanup in scoped
finalizers. Keep shutdown idempotent and bound waits so a stuck finalizer cannot
hang Pi indefinitely.

## Tools

- Define parameters with TypeBox.
- Use Pi's `StringEnum` helper for string enums.
- Keep prompt snippets and guidelines explicit about the tool name.
- Forward the tool `AbortSignal` into the Effect boundary.
- Use `onUpdate` for meaningful progress, not heartbeat noise.
- Return concise model-facing `content` and typed renderer/state `details`.
- Truncate large output using Pi's helpers and provide a path to the full output
  when appropriate.
- Use `withFileMutationQueue` for file-mutating tools.
- Guard terminal-only behavior with `ctx.mode === "tui"` and UI behavior that
  also works in RPC mode with `ctx.hasUI`.

## External APIs

Inline wrapping is appropriate for one or two simple SDK operations:

```ts
const request = Effect.tryPromise({
  try: (signal) => client.request({ signal }),
  catch: (cause) => new RequestError({ cause }),
});
```

Prefer a named adapter for an SDK or protocol with multiple operations,
transport normalization, shared authentication, repeated error mapping, or reuse
across tools. Use a service when the adapter is shared, replaceable, stateful,
or owns resources.

## Managers and TUI Read Models

A stateful extension may keep mutable collections private to one manager while
exposing readonly snapshots. A synchronous read model is useful when Pi's TUI
must render without entering the Effect runtime.

For backend integrations, normalize provider-specific events into one tagged
domain event union. Fold those events into private snapshots rather than letting
SDK transport types spread into tools and renderers.

Use Effect primitives for state shared across fibers. Encapsulated synchronous
mutation is acceptable when one manager owns it and admission cannot race.

## Concurrency

Parallel tool calls can race. Capacity checks must reserve a slot before the
first asynchronous yield. Include reservations and restart-in-flight states in
capacity calculations, and release bookkeeping in `Effect.ensuring`.

Use semaphores for required serialization and permit-if-available behavior when
background refreshes should coalesce. Deduplicate identifiers before waiting or
cancelling multiple jobs.

Cancellation should:

- mark any result-delivery interest before triggering settlement;
- attempt graceful interruption;
- apply a bounded deadline;
- force-close the owning scope if needed;
- report the correct terminal state exactly once.

## Child Processes and Output

Verify `effect/unstable/process` imports against the selected Effect version. Do
not guess from Effect 3 or early Effect 4 examples.

For long-running processes:

- assign the process and output pump to a scope;
- terminate the process tree, not only the shell;
- bound graceful and forced termination;
- distinguish process exit from stdio closure when descendants may retain file
  descriptors;
- cap in-memory output and model-facing results;
- use private spill files for useful full output;
- make repeated kill and shutdown operations safe.

## Tests

Exercise the same path production tools use:

- a real `ManagedRuntime` with test layers;
- typed local SDK or backend fakes;
- portable real child processes when lifecycle behavior is under test;
- a real `AbortController` for interruption;
- concurrent spawn, wait, cancel, and restart cases;
- event-driven settlement rather than arbitrary delays;
- runtime disposal in `finally`.

Run package-local formatting, linting, checking, and tests. Reconcile API or
version disagreements with the target manifest, lockfile, installed
declarations, and compiling implementation.
