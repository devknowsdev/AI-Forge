// src/intelligence/learningLoop.ts
//
// "This loop *is* Routing Engine v3 (03) — there is no separate adaptive-
// routing mechanism. The output of 'improve routing' is updated
// provider/tier weights that the Routing Engine reads on its next decision."
// — 11_INTELLIGENCE_LAYER.md
//
// Scope of influence: this NEVER reorders the cost-ascending tier chain
// (ollama -> free_tier -> paid). It only breaks ties *within* the paid tier
// (gpt vs claude) once the router has already decided "we need a paid call."
// That keeps the documented cost ordering intact while still using historical
// success/cost/latency to pick the better paid option (03's "task complexity"
// v1 rule is the other half of that choice — see routing/router.ts).

import type { MemoryDB } from "../memory/db.js";
import type { ExecutorName, NodeOutcome, NodeType } from "../types.js";

export interface ProviderWeight {
  provider: ExecutorName;
  successRate: number; // 0..1
  avgCost: number;
  avgLatencyMs: number;
  samples: number;
}

export class LearningLoop {
  constructor(private memory: MemoryDB) {}

  /** "execute -> evaluate -> store -> improve routing" — the store+improve half. */
  recordOutcome(outcome: NodeOutcome): void {
    const { provider, result } = outcome;
    const row = this.memory.db
      .prepare(`SELECT * FROM routing_weights WHERE provider = ? AND node_type = ?`)
      .get(provider, outcome.nodeType) as Record<string, any> | undefined;

    if (!row) {
      this.memory.db
        .prepare(`
          INSERT INTO routing_weights (provider, node_type, samples, success_count, avg_cost, avg_latency_ms)
          VALUES (?, ?, 1, ?, ?, ?)
        `)
        .run(provider, outcome.nodeType, result.success ? 1 : 0, result.cost, result.latencyMs);
      return;
    }

    const samples = row.samples + 1;
    const successCount = row.success_count + (result.success ? 1 : 0);
    // Incremental mean update — avoids storing full history just to average it.
    const avgCost = row.avg_cost + (result.cost - row.avg_cost) / samples;
    const avgLatencyMs = row.avg_latency_ms + (result.latencyMs - row.avg_latency_ms) / samples;

    this.memory.db
      .prepare(`
        UPDATE routing_weights
        SET samples = ?, success_count = ?, avg_cost = ?, avg_latency_ms = ?, updated_at = datetime('now')
        WHERE provider = ? AND node_type = ?
      `)
      .run(samples, successCount, avgCost, avgLatencyMs, provider, outcome.nodeType);
  }

  getWeight(provider: ExecutorName, nodeType: NodeType): ProviderWeight {
    const row = this.memory.db
      .prepare(`SELECT * FROM routing_weights WHERE provider = ? AND node_type = ?`)
      .get(provider, nodeType) as Record<string, any> | undefined;
    if (!row) {
      // Optimistic default for unseen (provider, node_type) pairs so a new
      // option isn't starved just because it has zero history.
      return { provider, successRate: 1, avgCost: 0, avgLatencyMs: 0, samples: 0 };
    }
    return {
      provider,
      successRate: row.samples > 0 ? row.success_count / row.samples : 1,
      avgCost: row.avg_cost,
      avgLatencyMs: row.avg_latency_ms,
      samples: row.samples,
    };
  }

  /** Rank candidates best-first: higher success rate wins; ties broken by lower cost, then lower latency. */
  rank(providers: ExecutorName[], nodeType: NodeType): ProviderWeight[] {
    return providers
      .map((p) => this.getWeight(p, nodeType))
      .sort((a, b) => {
        if (b.successRate !== a.successRate) return b.successRate - a.successRate;
        if (a.avgCost !== b.avgCost) return a.avgCost - b.avgCost;
        return a.avgLatencyMs - b.avgLatencyMs;
      });
  }
}
