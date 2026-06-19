// src/routing/router.ts
//
// "Tiered fallback chain (default, cost-ascending): ollama -> free_tier ->
// gpt/claude (paid tier chosen by task complexity). Before each hop, the
// router checks the Memory cost/quota ledger (06)." — 03_ROUTING_ENGINE.md
//
// v1 (this file): static node_type -> complexity mapping picks a *preference*
// between gpt/claude. v3 (learningLoop.rank): historical success/cost/latency
// breaks ties between them. Because rank()'s sort is stable and the tie
// criteria (successRate, avgCost, avgLatencyMs) are all equal for two
// never-used providers, an unseen pair resolves to the v1 preference order
// exactly — and only drifts away from it once real outcomes disagree. This
// is the intended v1->v3 relationship per 03's versioning note, implemented
// without two separate code paths.
//
// v2 ("a small local model classifies task complexity") is NOT implemented
// here — classifyComplexity() below is the v1 static stand-in. Swapping it
// for a real classifier later is a one-function change; nothing else in the
// router depends on how complexity is computed.
//
// Documented gap (not specified in 03/06): what happens if every tier in the
// chain is over budget? The spec only describes skipping to the next tier,
// not a final fallback. We surface that as `allowed: false` with the reason
// list rather than silently exceeding a budget — flag this decision if it
// needs revisiting.

import type { Ledger } from "../memory/ledger.js";
import type { LearningLoop } from "../intelligence/learningLoop.js";
import type { ExecutorName, NodeType, TaskPacket } from "../types.js";

export type Complexity = "low" | "medium" | "high";

/** v1 static task-type -> complexity mapping. */
const COMPLEXITY_BY_NODE_TYPE: Record<NodeType, Complexity> = {
  docs: "low",
  ui: "low",
  tests: "medium",
  backend: "high",
  terminal: "low", // unused — terminal bypasses this entirely, see route()
};

export function classifyComplexity(packet: TaskPacket): Complexity {
  let base = COMPLEXITY_BY_NODE_TYPE[packet.node_type];
  // Small v1 heuristic bump: a long constraint list or intent suggests more
  // context for the model to juggle, regardless of node_type.
  const signalSize = packet.constraints.length + Math.ceil(packet.intent.length / 200);
  if (base === "low" && signalSize >= 3) base = "medium";
  if (base === "medium" && signalSize >= 5) base = "high";
  return base;
}

export interface RouteDecision {
  executor: ExecutorName | null;
  chainTried: { provider: ExecutorName; allowed: boolean; reason?: string }[];
  complexity: Complexity;
}

export class Router {
  constructor(private ledger: Ledger, private learningLoop: LearningLoop) {}

  route(packet: TaskPacket, skip: ExecutorName[] = []): RouteDecision {
    if (packet.node_type === "terminal") {
      return { executor: "terminal", chainTried: [{ provider: "terminal", allowed: true }], complexity: "low" };
    }

    const complexity = classifyComplexity(packet);
    const paidPreference: ExecutorName[] = complexity === "high" ? ["claude", "gpt"] : ["gpt", "claude"];
    const rankedPaid = this.learningLoop.rank(paidPreference, packet.node_type).map((w) => w.provider);

    const chain: ExecutorName[] = ["ollama", "free_tier", ...rankedPaid];
    const chainTried: RouteDecision["chainTried"] = [];
    const skipSet = new Set(skip);

    for (const provider of chain) {
      if (skipSet.has(provider)) {
        chainTried.push({ provider, allowed: false, reason: "skipped after prior failure" });
        continue;
      }
      const check = this.ledger.check(provider);
      chainTried.push({ provider, allowed: check.allowed, reason: check.reason });
      if (check.allowed) {
        return { executor: provider, chainTried, complexity };
      }
    }
    return { executor: null, chainTried, complexity };
  }
}
