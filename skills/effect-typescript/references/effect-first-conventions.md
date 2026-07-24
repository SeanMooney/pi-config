# Effect-First TypeScript Conventions

These conventions combine user preferences with patterns observed in a reference
Pi extension repository. The reference repository is provenance, not an
authority and is not assumed to be available in the target project.

## Architecture

Use Effect as the organizing foundation for new TypeScript projects:

```text
host entry point
      |
Promise/callback boundary
      |
Effect workflows and capabilities
      |
small adapters to external systems
```

Effect-first does not mean that every function returns an Effect. Pure
calculation, structural parsing already handled by a project-native schema,
rendering, and host callback registration can remain plain TypeScript. The
important boundary is that effects, recoverable failures, shared dependencies,
concurrency, configuration, and resource ownership are explicit.

In an existing non-Effect project, follow its architecture for ordinary scoped
work. Propose Effect adoption separately rather than hiding a migration inside
an unrelated change.

## Domain Modeling

Prefer domain types that prevent invalid or confused states:

- readonly records for immutable values;
- discriminated unions for lifecycle and result states;
- branded or opaque identifiers when two primitive values are easy to mix up;
- exhaustive matching so adding a union member creates useful compiler errors;
- Effect Schema for decoding external data in new Effect-centric projects;
- the existing schema library in an established project.

Keep transport and SDK types at adapter boundaries. Convert them into domain
values before they reach workflows. Preserve `unknown` until validation or
narrowing proves its shape.

## Capabilities and Layers

Use `Context.Service` for a shared or replaceable capability, such as:

- HTTP or SDK clients;
- persistence;
- process execution;
- filesystem access;
- clocks or randomness when tests need control;
- configuration shared across workflows;
- stateful resources with managed lifetimes.

Use `Layer.sync` for pure construction and `Layer.effect` when construction is
effectful or scoped. Keep layer composition near the application runtime rather
than scattering `Effect.provide` throughout business workflows.

Do not turn ordinary data, one-use local helpers, or pure transformations into
services. Pass those as values or function arguments.

## Errors and Defects

Use typed errors for failures a caller can understand or recover from. Give
errors stable tags and enough domain context to make policy decisions without
parsing messages.

Reserve defects for violated invariants, impossible states, and programmer
errors. Do not silently turn defects into ordinary domain failures merely to
make an error channel appear complete.

At a host boundary that requires thrown errors:

1. run the Effect and inspect its `Exit`;
2. handle interruption separately;
3. translate typed failures or causes into the host's error contract;
4. throw only at that outer boundary.

## Promise and Callback Interop

Small integration:

```ts
const loadUser = (id: UserId) =>
  Effect.tryPromise({
    try: (signal) => sdk.getUser(id, { signal }),
    catch: (cause) => new UserLoadError({ id, cause }),
  });
```

Inline wrapping is appropriate when the operation is local, has straightforward
error mapping, and is unlikely to be reused.

Create a named adapter or module when an external API has multiple operations,
shared configuration, transport types, repeated error mapping, or reusable
behavior. Promote it to a service when it is shared, replaceable, stateful, or
owns resources.

For callback APIs, use `Effect.callback` and return cleanup that unregisters
listeners. Pass the interruption signal to abort-aware APIs. Raw promises and
callbacks should end at the adapter boundary rather than spreading through
workflows.

## State and Concurrency

Use Effect primitives for state observed or modified by concurrent fibers:

- `Ref` for shared atomic state;
- `Deferred` for one-shot completion;
- `Queue` for producer/consumer coordination;
- `Semaphore` for admission and serialization;
- scoped fibers for work owned by a resource lifetime.

Ordinary Maps, Sets, arrays, and variables are acceptable when mutation is
private to one owner, updates are synchronous and non-racing, and callers see
readonly views.

When coordinating capacity or lifecycle:

- make the check and reservation before the first asynchronous yield;
- release reservations with `Effect.ensuring`;
- deduplicate repeated identifiers;
- distinguish running, reserved, restarting, and settled states;
- bound graceful shutdown and force-close paths;
- make cleanup idempotent.

Choose `forkChild`, `forkScoped`, or `forkDetach` according to ownership. A
detached fiber needs an explicit owner that tracks and terminates it.

## Resources

Use scopes and finalizers for processes, subscriptions, streams, remote jobs,
temporary resources, and other lifetimes. Prefer:

- `Effect.acquireUseRelease` for one operation;
- scoped acquisition when a resource participates in a larger workflow;
- a managed runtime when services or resources are shared across host calls;
- explicit, bounded disposal at application shutdown.

Do not duplicate cleanup across ad hoc shutdown handlers and Effect finalizers.
Choose one owner and make the host hook invoke that owner.

## Configuration

For new Effect-first projects, use Effect Config to read, validate, compose, and
redact configuration. Build configuration once through the application layer and
inject it into capabilities. Avoid direct `process.env` access throughout the
core.

An existing project may retain its configuration library. Decode at the outer
boundary and expose a typed capability or pass validated values into the Effect
core.

## Logging

Prefer Effect logging inside Effect workflows and services. Log structured
context rather than interpolating all state into messages. Avoid requiring spans
or annotations for ordinary code; introduce richer telemetry when workflows
cross services, run in the background, or are difficult to diagnose.

Use the host's established logging approach in non-Effect entry points when
appropriate.

## TypeScript Discipline

- Keep strict compiler settings enabled.
- Never solve a typing problem with `as any`.
- Narrow `unknown` with schemas, guards, or protocol adapters.
- Prefer inference over repetitive return annotations.
- Annotate exported contracts, type guards, generic boundaries, and Effect
  environment/error requirements when that improves stability.
- Use type-only imports under ESM and verbatim module syntax.
- Prefer readonly public interfaces and arrays.
- Use `as const` for literal catalogs and `satisfies` for structural checks.
- Keep parsing and formatting in small pure helpers.
- Add dependencies through the package manager rather than editing manifests by
  hand.

## Composition Style

Use `Effect.gen` when a workflow has multiple named steps, branching, or
resource acquisition. Use pipelines for local policies and transformations, such
as mapping, typed recovery, timeout, retry, logging, and finalization.

Do not pursue point-free composition when named intermediate values explain the
domain better. Do not wrap a one-step transformation in a generator solely for
uniformity.

## Versions and API Authority

For a new project, begin with `effect@^4.0.0-beta.101` or a newer verified
Effect 4 version. Related runtime packages must be mutually compatible. A
lockfile records the installed resolution; the package's checks establish
whether the selected APIs compile.

For uncertain APIs, trust sources in this order:

1. the target package manifest and lockfile;
2. installed declarations and source;
3. compiling current project code;
4. current official Effect 4 documentation;
5. old migration notes and examples.

Treat `effect/unstable/*` imports as especially version-sensitive.

## Testing

Keep the project's runner and assertion conventions. Test observable behavior
through real Effect runtimes or provided test layers, using typed local fakes at
external boundaries.

Prioritize tests for:

- domain decoding and exhaustive state transitions;
- typed failure policies;
- interruption reaching external work;
- finalizer and resource cleanup;
- concurrent admission and shared-state behavior;
- timeout and retry policy;
- idempotent shutdown.

Always dispose runtimes in test cleanup. Prefer events, latches, deferred
values, or subscriptions over timing guesses.
