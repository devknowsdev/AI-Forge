// src/memory/taskHistory.ts
//
// Per-project stores per 06_MEMORY_SYSTEM.md (contrast with pattern_cache,
// which is deliberately global). Two tables because they answer different
// questions: task_history is "what happened to this node" (status timeline),
// execution_logs is "what did calling a provider cost" (one row per actual
// AI/terminal call, including cache-skipped calls recorded with cache_hit=1
// and zero cost so the ledger/dashboard story stays complete).

import type { MemoryDB } from "./db.js";
import type { NodeOutcome } from "../types.js";

export class TaskHistory {
  constructor(private memory: MemoryDB) {}

  recordStatus(o: { projectId: string; graphId: string; nodeId: string; nodeType: string; intent: string; status: string }): void {
    this.memory.db
      .prepare(`
        INSERT INTO task_history (project_id, graph_id, node_id, node_type, intent, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(o.projectId, o.graphId, o.nodeId, o.nodeType, o.intent, o.status);
  }

  recordOutcome(outcome: NodeOutcome): void {
    const { result } = outcome;
    this.memory.db
      .prepare(`
        INSERT INTO execution_logs
          (project_id, graph_id, node_id, provider, tokens_in, tokens_out, cost, latency_ms, success, error, data_boundary, cache_hit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        outcome.projectId,
        outcome.graphId,
        outcome.nodeId,
        result.provider,
        result.tokensIn,
        result.tokensOut,
        result.cost,
        result.latencyMs,
        result.success ? 1 : 0,
        result.error ?? null,
        outcome.dataBoundary,
        result.cacheHit ? 1 : 0
      );

    this.recordStatus({
      projectId: outcome.projectId,
      graphId: outcome.graphId,
      nodeId: outcome.nodeId,
      nodeType: outcome.nodeType,
      intent: outcome.intent,
      status: result.success ? "success" : "failed",
    });
  }

  /** Recent failed nodes for a project, most recent first. Feeds GraphBuilder's
   *  "past failures" input (11_INTELLIGENCE_LAYER.md). */
  recentFailures(projectId: string, limit = 50): { nodeType: string; intent: string; error: string | null; createdAt: string }[] {
    return this.memory.db
      .prepare(`
        SELECT th.node_type as nodeType, th.intent as intent, el.error as error, el.created_at as createdAt
        FROM execution_logs el
        JOIN task_history th ON th.node_id = el.node_id AND th.graph_id = el.graph_id AND th.project_id = el.project_id
        WHERE el.project_id = ? AND el.success = 0
        ORDER BY el.created_at DESC
        LIMIT ?
      `)
      .all(projectId, limit) as any;
  }

  /** Per-boundary call counts for a project — e.g. "12 calls stayed local,
   *  3 went to a provider that may train on submitted data." The concrete
   *  query a future UI needs to satisfy 00_SYSTEM_OVERVIEW.md's "user must
   *  be able to see and control this boundary" requirement. */
  dataBoundarySummary(projectId: string): { dataBoundary: string; count: number }[] {
    return this.memory.db
      .prepare(`
        SELECT data_boundary as dataBoundary, COUNT(*) as count
        FROM execution_logs WHERE project_id = ?
        GROUP BY data_boundary
      `)
      .all(projectId) as { dataBoundary: string; count: number }[];
  }

  projectSummary(projectId: string): Record<string, any>[] {
    return this.memory.db
      .prepare(`
        SELECT node_type, status, COUNT(*) as count
        FROM task_history WHERE project_id = ?
        GROUP BY node_type, status
      `)
      .all(projectId) as Record<string, any>[];
  }
}
