// src/engine/fileLock.ts
//
// "Concurrency: parallel nodes that touch the same file path must acquire a
// file-level lock before execution; conflicting writes queue rather than
// race." — 05_EXECUTION_ENGINE.md
//
// Per-path FIFO mutex chain. A node naming multiple filePaths acquires them
// in sorted order (not declaration order) so two nodes that both need paths
// [a, b] can never deadlock by acquiring them in opposite order.

export type Release = () => void;

export class FileLockManager {
  private tails = new Map<string, Promise<void>>();

  /** Resolves once every requested path is exclusively held; call the returned
   *  function to release all of them together. Empty/undefined paths = no-op. */
  async acquire(paths: string[] | undefined): Promise<Release> {
    if (!paths || paths.length === 0) return () => {};

    const sorted = [...new Set(paths)].sort();
    const releases: Release[] = [];

    for (const path of sorted) {
      const prev = this.tails.get(path) ?? Promise.resolve();
      let release!: Release;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.tails.set(path, prev.then(() => mine));
      await prev; // wait until whoever held this path before us has released it
      releases.push(release);
    }

    return () => releases.forEach((r) => r());
  }
}
