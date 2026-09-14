import type { LocalReadRegistry } from "./local-read-registry.ts";

export interface ReadExecutor<TParams extends { readonly path: string }, TUpdate, TResult> {
  execute(
    toolCallId: string,
    params: TParams,
    signal?: AbortSignal,
    onUpdate?: TUpdate,
    context?: unknown,
  ): Promise<TResult>;
}

export function createHybridReadExecutor<
  TParams extends { readonly path: string },
  TUpdate,
  TResult,
>(
  localRead: ReadExecutor<TParams, TUpdate, TResult>,
  remoteRead: ReadExecutor<TParams, TUpdate, TResult>,
  registry: LocalReadRegistry,
): ReadExecutor<TParams, TUpdate, TResult> {
  return {
    async execute(toolCallId, params, signal, onUpdate, context) {
      const decision = await registry.route(params.path);
      if (decision.kind === "denied") {
        throw new Error(`SSH local read denied for "${decision.path}": ${decision.reason}`);
      }
      if (decision.kind === "local") {
        return localRead.execute(
          toolCallId,
          { ...params, path: decision.path },
          signal,
          onUpdate,
          context,
        );
      }
      return remoteRead.execute(toolCallId, params, signal, onUpdate, context);
    },
  };
}
