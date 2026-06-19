// src/engine/modelLock.ts
//
// Not derived from any of the 13 spec docs — surfaced by reading
// Local_AI_Developer_Stack.docx, which documents the actual constraint a
// real local Ollama instance operates under: "Never run two models
// simultaneously on 16 GB. Ollama will load both, but one will spill to
// swap memory and the result is a 10x slowdown on both," and "Ollama
// hot-swaps between them in ~10 seconds."
//
// This was invisible while OllamaExecutor was a flat mock — there was
// nothing to model a constraint about. It becomes a real correctness
// concern the moment ollama execution is wired to a real local instance:
// two parallel nodes needing DIFFERENT models (e.g. one coding-flavored,
// one general-reasoning-flavored) would, under the existing FileLockManager
// alone, run fully concurrently if they don't share a file path — exactly
// the scenario the document says causes a 10x degradation. Same bug
// *class* as the git HEAD-ref race (engine/asyncMutex.ts's other caller):
// a globally shared, non-file-scoped resource that file-path locking has
// no language for.
//
// Deliberate simplification, named rather than hidden: this fully
// serializes EVERY ollama-tier call, not just calls that need different
// models. A real Ollama server can serve concurrent requests against one
// already-loaded model without contention, so this is more conservative
// than strictly necessary — but a "shared lock for same key, exclusive
// across different keys" primitive is meaningfully more complex to get
// right, and nothing here currently needs that throughput. If concurrent
// same-model throughput becomes a real bottleneck later, this is the one
// place to revisit.
//
// Consequence worth stating plainly: this makes "parallel" execution mode
// provide NO wall-clock speedup for ollama-tier nodes specifically — by
// design, because a real local model can't actually do unrelated
// concurrent generations without contention. Parallel mode still helps for
// nodes on other tiers (free_tier/gpt/claude run against independent
// remote capacity; terminal runs as independent OS processes).

import { AsyncMutex } from "./asyncMutex.js";

export class LocalModelLock {
  private mutex = new AsyncMutex();
  private currentModel: string | null = null;

  /** Document says ~10s for a real hot-swap; defaults to that so the
   *  "real" number isn't buried, callers (tests/demo) override for speed. */
  constructor(private swapDelayMs = 10_000) {}

  async run<T>(model: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      if (this.currentModel !== null && this.currentModel !== model) {
        await sleep(this.swapDelayMs);
      }
      this.currentModel = model;
      return fn();
    });
  }

  /** For observability/tests — which model the lock currently considers loaded. */
  loadedModel(): string | null {
    return this.currentModel;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
