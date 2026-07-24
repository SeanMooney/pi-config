import {
  Context,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  ManagedRuntime,
  Option,
  Ref,
  Semaphore,
  type Exit,
} from "effect";

import { CursorCli } from "./cursor-cli.js";
import { GitState } from "./git-state.js";

export interface AdmissionService {
  readonly tryRun: <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
}

export class DelegationAdmission extends Context.Service<DelegationAdmission, AdmissionService>()(
  "pi-cursor-acp/DelegationAdmission",
) {
  static readonly layer = Layer.effect(
    this,
    Semaphore.make(1).pipe(
      Effect.map((semaphore) => ({
        tryRun: <A, E, R>(program: Effect.Effect<A, E, R>) =>
          semaphore.withPermitsIfAvailable(1)(program),
      })),
    ),
  );
}

export interface WorkflowSupervisorService {
  readonly run: <A, E, R>(program: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly shutdown: Effect.Effect<void>;
}

export class WorkflowSupervisor extends Context.Service<
  WorkflowSupervisor,
  WorkflowSupervisorService
>()("pi-cursor-acp/WorkflowSupervisor") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const fibers = yield* FiberSet.make<unknown, unknown>();
      const closing = yield* Ref.make(false);
      const registration = yield* Semaphore.make(1);
      return {
        run: <A, E, R>(program: Effect.Effect<A, E, R>) =>
          Effect.acquireUseRelease(
            registration.withPermit(
              Effect.gen(function* () {
                if (yield* Ref.get(closing)) return yield* Effect.interrupt;
                return yield* FiberSet.run(fibers, program);
              }),
            ),
            (fiber) => Fiber.join(fiber),
            (fiber) => Fiber.interrupt(fiber),
          ),
        shutdown: registration
          .withPermit(Ref.set(closing, true))
          .pipe(
            Effect.andThen(FiberSet.clear(fibers)),
            Effect.andThen(FiberSet.awaitEmpty(fibers)),
          ),
      } satisfies WorkflowSupervisorService;
    }),
  );
}

const AppLayer = Layer.mergeAll(
  CursorCli.layer,
  GitState.layer,
  DelegationAdmission.layer,
  WorkflowSupervisor.layer,
);

type AppServices = CursorCli | GitState | DelegationAdmission | WorkflowSupervisor;
type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

export class CursorRuntimeOwner {
  #runtime: AppRuntime | undefined;
  #state: "open" | "closing" | "closed" = "open";
  #shutdown: Promise<void> | undefined;

  runPromiseExit<A, E>(
    program: Effect.Effect<A, E, AppServices>,
    signal?: AbortSignal,
  ): Promise<Exit.Exit<A, E>> {
    if (this.#state !== "open") {
      throw new Error("Cursor Agent runtime is shutting down.");
    }
    const runtime = (this.#runtime ??= ManagedRuntime.make(AppLayer));
    const supervised = WorkflowSupervisor.use((service) => service.run(program));
    return runtime.runPromiseExit(supervised, signal ? { signal } : undefined);
  }

  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#state = "closing";
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#shutdown = (async () => {
      if (!runtime) {
        this.#state = "closed";
        return;
      }
      try {
        await runtime.runPromise(WorkflowSupervisor.use((service) => service.shutdown));
      } finally {
        try {
          await runtime.dispose();
        } finally {
          this.#state = "closed";
        }
      }
    })();
    return this.#shutdown;
  }
}

export function argvUsesPiSsh(argv: readonly string[]): boolean {
  return argv.some(
    (arg, index) => arg === "--ssh" || arg.startsWith("--ssh=") || argv[index - 1] === "--ssh",
  );
}

export function isExcludedRuntime(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  return (
    env.PI_SUBAGENT_CHILD === "1" ||
    env.PI_SSH_MODE_ACTIVE === "1" ||
    Boolean(env.PI_SSH_REMOTE) ||
    argvUsesPiSsh(argv)
  );
}
