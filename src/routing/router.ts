// src/routing/router.ts
//
// RESTORED — this file was previously overwritten by an unrelated module
// (a standalone Ollama task-classifier pipeline; that code now lives at
// routing/taskClassifier.ts + config/modelRegistry.ts and is NOT deleted,
// just no longer squatting on this path). See PROJECT_BRIEF.md §2/§3 for
// the full story if this comment is ever confusing on its own.
//
// Contract this file MUST satisfy (verified directly against call sites in
// engine/executionEngine.ts and the re-export in index.ts — do not change
// this shape without updating both):
//
//   import { Router } from "../routing/router.js";
//   const router = new Router(ledger, learningLoop);
//   const decision = router.route(packet);                 // first attempt
//   const decision2 = router.route(packet, triedProviders); // retry, excluding already-tried tiers
//   decision.executor   // ExecutorName | null — null means every tier is budget-exhausted
//   decision.chainTried // { provider, allowed, reason? }[] — full ledger-check trail, for logging
//
// Behavior per 03_ROUTING_ENGINE.md / HANDOVER.md §4.2 (this is a restoration
// of documented behavior, not a redesign):
//   1. Cost-ascending tier order: ollama -> free_tier -> paid (gpt or claude).
//   2. Before each hop, Ledger.check() decides allowed/blocked — budget
//      exhaustion skips to the next tier; a call FAILURE does not
//      auto-escalate (that's the engine's fallbackOnFailure loop calling
//      route() again with the failed provider added to `exclude`).
//   3. Within the paid tier, v1 static classifyComplexity() sets a
//      *preference* between gpt/claude; v3 (LearningLoop.rank()) only
//      breaks ties between them. Because Array.sort is stable and ties
//      start equal, an unseen pair resolves to the v1 preference and only
//      drifts once real outcomes disagree — one code path implements both
//      v1 and v3, matching the spec's "v3 IS the learning loop" statement.

import type { ExecutorName, NodeType, TaskPacket } from "../types.js";
import type { Ledger } from "../memory/ledger.js";
import type { LearningLoop } from "../intelligence/learningLoop.js";

export interface ChainAttempt {
  provider: ExecutorName;
  allowed: boolean;
  reason?: string;
}

export interface RouteDecision {
  executor: ExecutorName | null;
  chainTried: ChainAttempt[];
}

export type Complexity = "low" | "medium" | "high";

const HIGH_COMPLEXITY_TYPES: ReadonlySet<NodeType> = new Set(["backend", "tests"]);
const LOW_COMPLEXITY_TYPES: ReadonlySet<NodeType> = new Set(["docs"]);

export function classifyComplexity(packet: TaskPacket): Complexity {
  if (HIGH_COMPLEXITY_TYPES.has(packet.node_type)) return "high";
  if (LOW_COMPLEXITY_TYPES.has(packet.node_type)) return "low";
  return "medium";
}

function paidTierPreference(complexity: Complexity): ExecutorName[] {
  return complexity === "high" ? ["claude", "gpt"] : ["gpt", "claude"];
}

function localTierAvailable(_packet: TaskPacket): boolean {
  return true;
}

export class Router {
  constructor(private ledger: Ledger, private learningLoop: LearningLoop) {}

  route(packet: TaskPacket, exclude: ExecutorName[] = []): RouteDecision {
    if (packet.node_type === "terminal") {
      return { executor: "terminal", chainTried: [{ provider: "terminal", allowed: true }] };
    }

    const chainTried: ChainAttempt[] = [];
    const excludeSet = new Set(exclude);

    if (!excludeSet.has("ollama") && localTierAvailable(packet)) {
      const check = this.ledger.check("ollama");
      chainTried.push({ provider: "ollama", allowed: check.allowed, reason: check.reason });
      if (check.allowed) {
        return { executor: "ollama", chainTried };
      }
    }

    if (!excludeSet.has("free_tier")) {
      const check = this.ledger.check("free_tier");
      chainTried.push({ provider: "free_tier", allowed: check.allowed, reason: check.reason });
      if (check.allowed) {
        return { executor: "free_tier", chainTried };
      }
    }

    const complexity = classifyComplexity(packet);
    const preferred = paidTierPreference(complexity).filter((p) => !excludeSet.has(p));
    const ranked = this.learningLoop.rank(preferred, packet.node_type).map((w) => w.provider);

    for (const provider of ranked) {
      const check = this.ledger.check(provider);
      chainTried.push({ provider, allowed: check.allowed, reason: check.reason });
      if (check.allowed) {
        return { executor: provider, chainTried };
      }
    }

    return { executor: null, chainTried };
  }
}
