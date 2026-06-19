// src/executors/types.ts
//
// Re-exported here for discoverability inside executors/, but the canonical
// definition lives in src/types.ts — do not duplicate the shape.
export type { Executor, ExecutionResult, TaskPacket, ExecutorName } from "../types.js";

export function timed<T>(fn: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const start = Date.now();
  return fn().then((value) => ({ value, latencyMs: Date.now() - start }));
}
