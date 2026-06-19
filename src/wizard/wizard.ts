// src/wizard/wizard.ts
//
// 02_WIZARD_SYSTEM.md: "Non-technical interface ... Rules: max 3 questions,
// always produce plan before execution, no code exposure." This is the
// LOGIC half of that spec — question flow, plan construction, the
// confirm-before-execute gate — with no UI attached, since the Wizard's
// actual interface (the eventual Tauri/React shell) is still a later
// phase. Nothing here assumes that UI exists; a CLI, a test, or a future
// React component can all drive this the same way.
//
// All three rules are enforced structurally, not just documented:
//   - max 3 questions: nextQuestion() hard-stops at MAX_QUESTIONS regardless
//     of how many mode-specific questions remain unanswered.
//   - always a plan before execution: the only way to get an executable
//     TaskGraph out of this module is WizardPlan.confirm() — there is no
//     other path from "built a plan" to "have a graph to run."
//   - no code exposure: WizardPlan's public surface (summary, steps) is
//     built only from plain-language TaskPacket.intent strings. The
//     underlying TaskGraph (which carries node_type, context, constraints —
//     the more code-adjacent fields) is held in a real JS private field
//     (#graph, not TypeScript's `private`), so it isn't reachable even via
//     `as any` from outside this file. Reusing the WIZARD_MODES names
//     here is the only thing borrowed from 02 — the question CONTENT below
//     is this module's own v1 design, not specified anywhere.
//
// v1 question design, same spirit as routing's classifyComplexity and
// ollama's selectModel: a fixed, static per-mode question list, not an
// adaptive "ask only what's missing" flow (that would need an AI judgment
// call this module doesn't make). A future version could skip questions
// whose answers are already implied by an earlier one; this version asks
// every question in a mode's list, in order, up to the 3-question ceiling.

import { GraphBuilder, type GraphBuilderInput, type WizardMode } from "../intelligence/graphBuilder.js";
import { TaskGraph } from "../taskGraph/graph.js";

export const MAX_QUESTIONS = 3;

export interface WizardQuestion {
  id: string;
  prompt: string;
  /** Purely informational for a future UI — this module enforces nothing based on it. */
  optional: boolean;
}

const QUESTIONS_BY_MODE: Record<WizardMode, WizardQuestion[]> = {
  build_feature: [
    { id: "description", prompt: "What feature would you like to build?", optional: false },
    { id: "constraints", prompt: "Any specific requirements or constraints?", optional: true },
    { id: "testing_focus", prompt: "Anything in particular you want tested?", optional: true },
  ],
  fix_issue: [
    { id: "description", prompt: "What's broken? Describe the issue.", optional: false },
    { id: "reproduction", prompt: "How can it be reproduced, if known?", optional: true },
  ],
  create_project: [
    { id: "description", prompt: "What kind of project would you like to create?", optional: false },
    { id: "constraints", prompt: "Any tech stack preferences or constraints?", optional: true },
  ],
  deploy: [
    { id: "description", prompt: "What would you like to deploy, and where?", optional: false },
    { id: "constraints", prompt: "Any deployment constraints — environment, downtime windows?", optional: true },
  ],
};

/**
 * The plan-before-execution gate (02). Built by Wizard.buildPlan(), never
 * constructed directly. summary/steps are the ONLY things a caller can read
 * without confirming — both are plain language, derived solely from
 * TaskPacket.intent strings, never from node_type/context/constraints/
 * patches. confirm() is the one and only path to an executable TaskGraph.
 */
export class WizardPlan {
  readonly mode: WizardMode;
  readonly summary: string;
  readonly steps: { id: string; description: string }[];
  readonly source: "ai" | "fallback";
  #graph: TaskGraph;
  #confirmed = false;

  constructor(mode: WizardMode, summary: string, graph: TaskGraph, source: "ai" | "fallback", userDescription: string) {
    this.mode = mode;
    this.summary = summary;
    this.source = source;
    this.#graph = graph;
    // Strip the extras composite "(constraints: ...)" from intent strings for
    // display — it was needed for GraphBuilder's decomposition but the user
    // should see their own words here, not the internal composite.
    const stripExtras = (intent: string) => intent.replace(/\s*\([^)]*\)\s*$/, "").trim();
    this.steps = topoOrder(graph).map((id) => ({
      id,
      description: graph.get(id).packet.intent.includes(userDescription)
        ? stripExtras(graph.get(id).packet.intent)
        : graph.get(id).packet.intent,
    }));
  }

  get confirmed(): boolean {
    return this.#confirmed;
  }

  /** The explicit "I approve this plan" action. Returns the real,
   *  executable TaskGraph — the only way to obtain it from a WizardPlan. */
  confirm(): TaskGraph {
    this.#confirmed = true;
    return this.#graph;
  }
}

export class Wizard {
  private answers = new Map<string, string>();
  private questionsAsked = 0;
  private readonly questions: WizardQuestion[];

  constructor(readonly mode: WizardMode) {
    this.questions = QUESTIONS_BY_MODE[mode];
  }

  /** Next question to ask, or null when there are none left for this mode
   *  OR the hard 3-question ceiling has been reached — whichever comes first. */
  nextQuestion(): WizardQuestion | null {
    if (this.questionsAsked >= MAX_QUESTIONS) return null;
    return this.questions[this.questionsAsked] ?? null;
  }

  /** Must be called for whatever nextQuestion() currently returns, in order.
   *  Pass an empty string to skip an optional question. */
  answer(questionId: string, value: string): void {
    const expected = this.questions[this.questionsAsked];
    if (!expected) {
      throw new Error(`Wizard (${this.mode}) has no more questions to answer`);
    }
    if (expected.id !== questionId) {
      throw new Error(`Expected an answer to "${expected.id}", got "${questionId}" — answer in order`);
    }
    if (!expected.optional && value.trim() === "") {
      throw new Error(`"${expected.id}" is required and cannot be skipped`);
    }
    this.answers.set(questionId, value);
    this.questionsAsked++;
  }

  isReadyForPlan(): boolean {
    return this.nextQuestion() === null && this.answers.has("description");
  }

  /** "Always produce plan before execution" (02). Delegates graph
   *  construction to GraphBuilder (real Claude decomposition or its
   *  documented fallback — same behavior either way), then wraps the
   *  result in a WizardPlan that withholds the executable graph until
   *  confirmed. */
  async buildPlan(builder: GraphBuilder, ids: { graphId: string; projectId: string }): Promise<WizardPlan> {
    if (!this.isReadyForPlan()) {
      throw new Error("Cannot build a plan before all required questions are answered");
    }
    const description = this.answers.get("description")!;
    const extras = [...this.answers.entries()]
      .filter(([id, value]) => id !== "description" && value.trim() !== "")
      .map(([id, value]) => `${id}: ${value}`);
    // fullDescription goes to GraphBuilder so it has all context for
    // decomposition; bareDescription goes to WizardPlan for display only,
    // so the user sees their own words in the step list, not an internal
    // composite string.
    const fullDescription = extras.length ? `${description} (${extras.join("; ")})` : description;

    const input: GraphBuilderInput = {
      graphId: ids.graphId,
      projectId: ids.projectId,
      description: fullDescription,
      mode: this.mode,
    };
    const outcome = await builder.build(input);
    const summary = `${modeLabel(this.mode)}: ${description}`;
    return new WizardPlan(this.mode, summary, outcome.graph, outcome.source, description);
  }
}

function modeLabel(mode: WizardMode): string {
  return mode
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Presentational only — a simple Kahn's-algorithm topological sort so a
 *  plan's steps read in a sensible order. Not used by execution itself;
 *  the engine's own readiness logic (TaskGraph.readyNodeIds) already
 *  handles real dependency ordering correctly without this. */
function topoOrder(graph: TaskGraph): string[] {
  const nodes = graph.all();
  const remainingDeps = new Map(nodes.map((n) => [n.id, new Set(n.packet.dependencies)]));
  const order: string[] = [];
  const queue: string[] = nodes.filter((n) => n.packet.dependencies.length === 0).map((n) => n.id);

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const node of nodes) {
      const deps = remainingDeps.get(node.id)!;
      if (deps.delete(id) && deps.size === 0 && !order.includes(node.id) && !queue.includes(node.id)) {
        queue.push(node.id);
      }
    }
  }
  return order;
}
