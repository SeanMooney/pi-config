export class DelegationLifecycle {
  #controller = new AbortController();

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  reset(): void {
    this.#controller.abort();
    this.#controller = new AbortController();
  }

  shutdown(): void {
    this.#controller.abort();
  }
}

export function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal,
): AbortSignal {
  if (!first) return second;
  if (first.aborted || second.aborted) return AbortSignal.abort();
  return AbortSignal.any([first, second]);
}
