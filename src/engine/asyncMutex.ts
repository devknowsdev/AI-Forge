// src/engine/asyncMutex.ts
//
// A single global FIFO mutex. Extracted from what was a private
// `withGitLock` helper inside CheckpointManager — that exact same
// "one global lock, not one per key" shape is needed again for the local
// model lock (modelLock.ts), so it's worth having one audited
// implementation instead of two copies that could quietly drift apart.
//
// Contrast with engine/fileLock.ts: FileLockManager deliberately has
// per-path independent chains (two different paths run fully concurrently).
// AsyncMutex is the opposite shape — every call serializes with every other
// call, regardless of any key — which is exactly what "only one git HEAD"
// and "only one model fits in memory at once" both need.

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => mine);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
