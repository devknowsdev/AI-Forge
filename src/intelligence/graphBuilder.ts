// src/intelligence/graphBuilder.ts
//
// "AI-generated graphs using: task description, memory context (pattern
// cache + execution logs — 06), past failures." — 11_INTELLIGENCE_LAYER.md
//
// This is the Intent -> Graph step of the canonical lifecycle (01/12) that
// nothing else in this codebase implements — until now, every TaskGraph in
// the demo/tests was hand-assembled. 01_ARCHITECTURE.md names "Graph
// Builder" as a distinct L3 sub-component alongside the Routing Engine and
// the Intelligence Layer's learning loop; this file is that component.
//
// Design, mirroring the same real/fallback split used for the Claude
// executor and the v1/v2 routing split:
//   - REAL path: ask Claude to decompose the intent into a JSON node list.
//     Requires ANTHROPIC_API_KEY; on any failure (no key, network error,
//     malformed/invalid JSON, a cycle, an unknown node_type, a dependency
//     referencing an id outside this batch) we don't throw — we fall back.
//   - FALLBACK path: a small deterministic template, parameterized by an
//     optional Wizard mode hint. This is NOT "v2 AI classification" from
//     03 — there's no v1/v2/v3 versioning scheme documented for graph
//     building in 11, so there's only one real generation strategy (AI) and
//     one safety net (template), not a version ladder.
//
// "Past failures" is implemented as a simple keyword-overlap match against
// this project's recent execution_logs.error entries — not semantic search
// (that would need embeddings, which is out of scope here and flagged as
// a known simplification, same spirit as routing v1 standing in for v2).

import type { MemoryDB } from "../memory/db.js";
import type { TaskHistory } from "../memory/taskHistory.js";
import { TaskGraph, type NodeInput } from "../taskGraph/graph.js";
import { NODE_TYPES, type NodeType, type TaskPacket } from "../types.js";

/**
 * The four canonical Wizard modes (02_WIZARD_SYSTEM.md) reused here purely
 * as a label for picking a fallback template — this file does not implement
 * the Wizard's question flow, "max 3 questions" rule, or UI. That's still
 * out of scope.
 */
export const WIZARD_MODES = ["build_feature", "fix_issue", "create_project", "deploy"] as const;
export type WizardMode = (typeof WIZARD_MODES)[number];

export interface GraphBuilderInput {
  graphId: string;
  projectId: string;
  description: string;
  mode?: WizardMode;
}

export interface FailureNote {
  nodeType: string;
  intent: string;
  error: string;
}

export interface BuildOutcome {
  graph: TaskGraph;
  source: "ai" | "fallback";
  fallbackReason?: string;
  failureNotesUsed: FailureNote[];
}

interface RawAINode {
  id: string;
  node_type: string;
  intent: string;
  constraints?: string[];
  dependencies?: string[];
}

const MODEL = "claude-sonnet-4-6";
const STOPWORDS = new Set(["the", "a", "an", "to", "for", "of", "and", "in", "on", "with", "is", "this", "that"]);

export class GraphBuilder {
  constructor(private memory: MemoryDB, private taskHistory: TaskHistory) {}

  async build(input: GraphBuilderInput): Promise<BuildOutcome> {
    const failureNotesUsed = this.findRelevantFailures(input.projectId, input.description);

    const ai = await this.tryAIDecompose(input, failureNotesUsed);
    if (ai.nodes) {
      try {
        const graph = new TaskGraph(input.graphId, input.projectId, toNodeInputs(ai.nodes));
        return { graph, source: "ai", failureNotesUsed };
      } catch (err) {
        // Valid JSON, but TaskGraph rejected it (unknown dependency id, cycle, etc.) — fall back.
        return this.fallback(input, failureNotesUsed, `AI graph failed validation: ${(err as Error).message}`);
      }
    }
    return this.fallback(input, failureNotesUsed, ai.reason!);
  }

  private fallback(input: GraphBuilderInput, failureNotesUsed: FailureNote[], reason: string): BuildOutcome {
    const nodes = staticFallbackNodes(input.description, input.mode);
    const graph = new TaskGraph(input.graphId, input.projectId, toNodeInputs(nodes));
    return { graph, source: "fallback", fallbackReason: reason, failureNotesUsed };
  }

  /** Simple keyword-overlap match — see file docblock for why this isn't semantic search. */
  private findRelevantFailures(projectId: string, description: string, limit = 3): FailureNote[] {
    const descWords = wordSet(description);
    if (descWords.size === 0) return [];

    const candidates = this.taskHistory.recentFailures(projectId, 100);
    const scored = candidates
      .filter((c) => c.error)
      .map((c) => ({ c, score: overlap(descWords, wordSet(`${c.intent} ${c.nodeType}`)) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((s) => ({ nodeType: s.c.nodeType, intent: s.c.intent, error: s.c.error! }));
  }

  private async tryAIDecompose(
    input: GraphBuilderInput,
    failureNotes: FailureNote[]
  ): Promise<{ nodes?: RawAINode[]; reason?: string }> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { reason: "ANTHROPIC_API_KEY not set" };

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1500,
          messages: [{ role: "user", content: buildPrompt(input, failureNotes) }],
        }),
      });
      if (!response.ok) {
        return { reason: `claude API error ${response.status}` };
      }
      const data = (await response.json()) as { content: { type: string; text?: string }[] };
      const text = data.content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n");
      const parsed = parseNodeList(text);
      if (!parsed) return { reason: "AI response was not a valid node-list JSON array" };
      return { nodes: parsed };
    } catch (err) {
      return { reason: `claude call failed: ${(err as Error).message}` };
    }
  }
}

export function toNodeInputs(nodes: RawAINode[]): NodeInput[] {
  return nodes.map((n) => ({
    id: n.id,
    packet: {
      intent: n.intent,
      node_type: n.node_type as NodeType, // already validated by parseNodeList before this is called
      constraints: n.constraints ?? [],
      dependencies: n.dependencies ?? [],
      context: {},
    } satisfies TaskPacket,
  }));
}

function buildPrompt(input: GraphBuilderInput, failureNotes: FailureNote[]): string {
  const lines = [
    "Decompose this task into a dependency-ordered list of work nodes.",
    `Task: ${input.description}`,
    input.mode ? `Wizard mode: ${input.mode}` : "",
    `Each node's "node_type" MUST be exactly one of: ${NODE_TYPES.join(", ")}.`,
    'Respond with ONLY a JSON array, no prose, no markdown fences. Each element: ' +
      '{"id": "short_slug", "node_type": "...", "intent": "...", "constraints": ["..."], "dependencies": ["other_node_id", ...]}.',
    "dependencies must only reference ids of OTHER nodes in this same array, and must not form a cycle.",
  ];
  if (failureNotes.length) {
    lines.push(
      "Avoid repeating these past failures on similar tasks in this project:",
      ...failureNotes.map((f) => `- (${f.nodeType}) "${f.intent}" failed with: ${f.error}`)
    );
  }
  return lines.filter(Boolean).join("\n");
}

function parseNodeList(text: string): RawAINode[] | null {
  let raw: unknown;
  try {
    // Tolerate the model wrapping the array in a fenced code block despite instructions.
    const stripped = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    raw = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const validNodeTypes = new Set<string>(NODE_TYPES);
  const ids = new Set<string>();
  for (const item of raw) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as any).id !== "string" ||
      typeof (item as any).node_type !== "string" ||
      typeof (item as any).intent !== "string" ||
      !validNodeTypes.has((item as any).node_type)
    ) {
      return null;
    }
    ids.add((item as any).id);
  }
  // Dependencies must reference only ids present in this same batch — cycle
  // detection itself is left to TaskGraph's constructor (single source of truth).
  for (const item of raw as RawAINode[]) {
    for (const dep of item.dependencies ?? []) {
      if (!ids.has(dep)) return null;
    }
  }
  return raw as RawAINode[];
}

/** v1-style deterministic template — see file docblock for why this is the only fallback tier. */
export function staticFallbackNodes(description: string, mode?: WizardMode): RawAINode[] {
  const m = mode ?? "build_feature";
  switch (m) {
    case "fix_issue":
      return [
        { id: "diagnose", node_type: "backend", intent: `Diagnose: ${description}`, dependencies: [] },
        { id: "fix", node_type: "backend", intent: `Apply fix: ${description}`, dependencies: ["diagnose"] },
        { id: "verify", node_type: "tests", intent: `Verify fix: ${description}`, dependencies: ["fix"] },
      ];
    case "create_project":
      return [
        { id: "scaffold", node_type: "backend", intent: `Scaffold project: ${description}`, dependencies: [] },
        { id: "ui", node_type: "ui", intent: `Initial UI shell: ${description}`, dependencies: ["scaffold"] },
        { id: "docs", node_type: "docs", intent: `Write initial README: ${description}`, dependencies: ["scaffold"] },
      ];
    case "deploy":
      return [
        { id: "build", node_type: "terminal", intent: `Build for deploy: ${description}`, dependencies: [] },
        { id: "test", node_type: "tests", intent: `Run pre-deploy tests: ${description}`, dependencies: ["build"] },
        { id: "release", node_type: "terminal", intent: `Deploy: ${description}`, dependencies: ["test"] },
      ];
    case "build_feature":
    default:
      return [
        { id: "ui", node_type: "ui", intent: `Build UI for: ${description}`, dependencies: [] },
        { id: "backend", node_type: "backend", intent: `Implement backend for: ${description}`, dependencies: ["ui"] },
        { id: "tests", node_type: "tests", intent: `Write tests for: ${description}`, dependencies: ["backend"] },
        { id: "docs", node_type: "docs", intent: `Document: ${description}`, dependencies: ["backend"] },
      ];
  }
}

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}
