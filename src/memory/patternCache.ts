// src/memory/patternCache.ts
//
// "pattern cache (global, cross-project): hash of (task-type + context
// signature) -> prior successful output. Checked before any AI call; a
// cache hit skips execution entirely." — 06_MEMORY_SYSTEM.md
//
// Deliberately NOT scoped by project_id — that's the whole point: a pattern
// learned on project A should save a call on project B.
//
// Stores origin_provider/tokens/patch alongside output so a cache hit can
// honestly attribute "who originally produced this" in logs AND actually
// reproduce the original file write (origin_patch), not just the text.
// Skipping the patch on a hit would make caching unsound for any node that
// writes files: it would report success without doing what the original
// call did. Cost is still always 0 on a hit, and the Ledger is never
// touched — see engine/executionEngine.ts.

import { createHash } from "node:crypto";
import type { MemoryDB } from "./db.js";
import type { ExecutorName, Patch, TaskPacket } from "../types.js";

export interface CacheLookup {
  hit: boolean;
  output?: string;
  originProvider?: ExecutorName;
  originTokensIn?: number;
  originTokensOut?: number;
  originPatch?: Patch;
}

export class PatternCache {
  constructor(private memory: MemoryDB) {}

  /** hash(task-type + context signature). Intent text is part of the signature
   *  on purpose — "build a login form" and "build a checkout form" must not
   *  collide just because both are node_type "ui". */
  static key(packet: TaskPacket): string {
    const signature = JSON.stringify({
      node_type: packet.node_type,
      intent: packet.intent,
      context: packet.context,
    });
    return createHash("sha256").update(signature).digest("hex");
  }

  get(packet: TaskPacket): CacheLookup {
    const key = PatternCache.key(packet);
    const row = this.memory.db
      .prepare(`SELECT output, origin_provider, origin_tokens_in, origin_tokens_out, origin_patch FROM pattern_cache WHERE cache_key = ?`)
      .get(key) as
      | { output: string; origin_provider: ExecutorName; origin_tokens_in: number; origin_tokens_out: number; origin_patch: string | null }
      | undefined;
    if (!row) return { hit: false };

    this.memory.db
      .prepare(`UPDATE pattern_cache SET hits = hits + 1, last_hit_at = datetime('now') WHERE cache_key = ?`)
      .run(key);
    return {
      hit: true,
      output: row.output,
      originProvider: row.origin_provider,
      originTokensIn: row.origin_tokens_in,
      originTokensOut: row.origin_tokens_out,
      originPatch: row.origin_patch ? (JSON.parse(row.origin_patch) as Patch) : undefined,
    };
  }

  /** Only ever store on a validated success — never cache a failed/rolled-back result. */
  set(
    packet: TaskPacket,
    output: string,
    originProvider: ExecutorName,
    originTokensIn: number,
    originTokensOut: number,
    originPatch?: Patch
  ): void {
    const key = PatternCache.key(packet);
    this.memory.db
      .prepare(`
        INSERT INTO pattern_cache (cache_key, node_type, intent, output, origin_provider, origin_tokens_in, origin_tokens_out, origin_patch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          output = excluded.output,
          origin_provider = excluded.origin_provider,
          origin_tokens_in = excluded.origin_tokens_in,
          origin_tokens_out = excluded.origin_tokens_out,
          origin_patch = excluded.origin_patch
      `)
      .run(key, packet.node_type, packet.intent, output, originProvider, originTokensIn, originTokensOut, originPatch ? JSON.stringify(originPatch) : null);
  }
}
