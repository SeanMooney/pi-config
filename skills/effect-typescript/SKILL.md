---
name: effect-typescript
description: >
  Design, implement, refactor, debug, or review TypeScript using strict,
  Effect-first conventions. Use for all TypeScript work, including ordinary
  requests that do not mention Effect, and for building Pi extensions. New
  TypeScript projects default to Effect 4; existing non-Effect projects retain
  their architecture unless migration is requested.
license: Apache-2.0
---

# Effect TypeScript

Use this skill for every TypeScript implementation, design, refactoring,
debugging, and review task.

Repository instructions and established project architecture take precedence
over these global defaults. Do not introduce Effect during an unrelated change
to an existing non-Effect project. For new TypeScript projects, use Effect 4 as
the application foundation.

Read
[references/effect-first-conventions.md](references/effect-first-conventions.md)
before writing or reviewing TypeScript. When the target is a Pi extension, also
read the [Pi extension conventions](references/pi-extensions.md).

## Decision Process

1. Inspect the target repository's guidance, package manifest, compiler
   configuration, source structure, and validation commands.
2. Classify the work:
   - **New project or extension:** start Effect-first.
   - **Existing Effect project:** follow its Effect version and local patterns,
     improving inconsistencies only within the requested scope.
   - **Existing non-Effect project:** preserve its architecture unless the user
     asks for Effect adoption or migration.
3. Identify pure domain logic, external capabilities, asynchronous workflows,
   shared state, resources, and host boundaries before choosing modules.
4. Keep entry points thin. Separate responsibilities among domain models,
   capabilities, live implementations, adapters, and workflows, but create files
   or directories only when the project size warrants them.

## TypeScript Defaults

Apply these strongly unless project rules say otherwise:

- Enable and preserve strict type safety.
- Never use `as any`. Narrow `unknown`, improve the contract, or implement a
  typed adapter.
- Prefer inference; add annotations for public contracts, generic boundaries,
  narrowing, or when they materially guide inference.
- Use `import type` or inline type modifiers for type-only imports.
- Expose readonly contracts and immutable domain values.
- Use `satisfies` to check structure without unnecessarily widening values.
- Model domains explicitly with tagged unions, readonly records, branded or
  opaque identifiers where values are easy to confuse, and exhaustive matching.
- Add or change dependencies through the project's package manager.
- Use the project's formatter, linter, type checker, and test runner.

## Effect-First Defaults

For new TypeScript codebases:

- Put effects, expected failures, configuration, external capabilities,
  concurrency, and resource lifetimes in the Effect core.
- Keep pure transformations and host-facing callbacks as ordinary TypeScript
  where that is clearer.
- Model recoverable or domain failures in the typed error channel. Reserve
  defects for broken invariants and programmer errors.
- Use `Context.Service` and layers for shared or replaceable capabilities. Pass
  pure data and local dependencies as ordinary function arguments.
- Use `Effect.gen` for readable multi-step workflows and pipelines for local
  mapping, error policies, retries, timeouts, and lifecycle modifiers.
- Use Effect primitives such as `Ref`, `Queue`, `Deferred`, `Semaphore`, and
  scoped fibers for shared or concurrent state. Local mutation is acceptable
  when one owner encapsulates it and it cannot race.
- Use Effect Config for environment variables and validated application
  configuration. Do not scatter `process.env` reads through the core.
- Prefer Effect logging over `console` in the Effect core. Add richer tracing
  only when operational complexity warrants it.
- Use Effect Schema at external boundaries in a new Effect-centric project.
  Existing projects retain their established schema library.

## External API Boundary

Integrate Promise and callback libraries pragmatically:

- Inline `Effect.tryPromise` or `Effect.callback` for a small, local operation.
- Create a named adapter when an integration has a broad surface, repeated
  calls, shared configuration, reusable behavior, or non-trivial error mapping.
- Promote an adapter to a service when it is shared, replaceable, stateful, or
  owns resources.
- Return typed Effects from adapters so raw promises and callbacks do not leak
  through the application core.
- Forward interruption signals whenever the external API supports cancellation.

## Toolchain and Versions

For a new project, use `effect@^4.0.0-beta.101` as the minimum baseline or a
newer verified Effect 4 release. Keep related Effect ecosystem packages on
compatible versions. Inspect the installed declarations and compile uncertain or
unstable APIs instead of copying old examples.

Adopt Effect's supported language-service or TypeScript integration when it is
compatible with the selected version. Preserve established compiler and build
tooling in existing projects unless migration is requested.

## Testing

Use the project's existing test runner. For new Pi extensions, default to
`node:test` unless the project establishes another convention.

- Exercise Effects through real runtimes and layers.
- Prefer typed local fakes that implement capability contracts.
- Test typed failures, interruption, finalizers, concurrent state transitions,
  timeouts, and resource cleanup where relevant.
- Prefer event-driven synchronization over arbitrary sleeps.
- Dispose managed runtimes and scoped resources in test cleanup.

## Validation

Run the narrowest complete set of project-provided formatting, linting, type
checking, and focused tests for the changed files. Do not declare completion
with unresolved failures.

## Output

For implementation, report architectural choices, changed files, validation, and
residual risks. For review, lead with prioritized findings and file references,
distinguish defects from optional Effect adoption, and recommend the smallest
change consistent with the target project's architecture.
