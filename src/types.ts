// src/types.ts
//
// Canonical vocabulary. Per 03_ROUTING_ENGINE.md: "use this exact list everywhere
// (Execution Engine, Task Graph node types, Memory ledger must all reference these
// same five values)". Do not redefine this elsewhere — import from here.

export const EXECUTOR_NAMES = ["ollama", "free_tier", "gpt", "claude", "terminal"] as const;
export type ExecutorName = (typeof EXECUTOR_NAMES)[number];

/** AI-routed tiers only (excludes terminal, which bypasses tier selection — 03). */
export const AI_TIERS: readonly ExecutorName[] = ["ollama", "free_tier", "gpt", "claude"];

/**
 * Data boundary per provider — 00_SYSTEM_OVERVIEW.md: "Local-only by
 * default. Any task routed to a free-tier or paid provider leaves the
 * machine... Free-tier providers may use submitted code/prompts for model
 * training; paid tiers generally do not. The user must be able to see and
 * control this boundary." This was a locked spec requirement with no field
 * to back it — NodeOutcome had no way to say "this call left the machine,
 * to where" except by having a future UI re-derive it from `provider`
 * itself. Deriving it here, once, as data, removes that reconstruction step.
 *
 * The local/remote/may-train split below is the spec's own stated
 * assumption (00), not independently re-verified per-provider policy
 * research — if a specific provider's actual training policy ever needs to
 * be confirmed for something that matters, that's a fresh decision, not
 * implied by this lookup.
 */
export const DATA_BOUNDARY = ["local", "remote_no_training", "remote_may_train"] as const;
export type DataBoundary = (typeof DATA_BOUNDARY)[number];

const DATA_BOUNDARY_BY_PROVIDER: Record<ExecutorName, DataBoundary> = {
  ollama: "local",
  terminal: "local",
  free_tier: "remote_may_train",
  gpt: "remote_no_training",
  claude: "remote_no_training",
};

export function dataBoundaryFor(provider: ExecutorName): DataBoundary {
  return DATA_BOUNDARY_BY_PROVIDER[provider];
}

export const NODE_TYPES = ["ui", "backend", "tests", "docs", "terminal"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/**
 * Task packet — canonical definition per 04_TASK_GRAPH_SYSTEM.md:
 * "The serialized unit handed to a node before execution."
 * A node executes exactly one task packet. Do not redefine this shape elsewhere.
 */
export interface TaskPacket {
  intent: string;
  context: Record<string, unknown>;
  constraints: string[];
  dependencies: string[]; // node ids this packet's node depends on
  node_type: NodeType;
  /**
   * File paths this node's execution will read/write. Used by the Execution
   * Engine (05) for file-level locking in parallel mode. Optional — nodes with
   * no file mutation (e.g. a pure query) can omit it.
   */
  filePaths?: string[];
}

export type NodeStatus =
  | "pending" // waiting on dependencies
  | "ready" // dependencies satisfied, not yet started
  | "running"
  | "success"
  | "failed"
  | "blocked"; // direct dependent of a failed node (07/04 partial-failure policy)

export interface GraphNode {
  id: string;
  packet: TaskPacket;
  status: NodeStatus;
  result?: ExecutionResult;
  /** Populated by TaskGraph at build time from reverse dependency edges. */
  dependents: string[];
}

/**
 * Diff-based patching (07_SAFETY_SYSTEM.md lists this as its own component,
 * parallel to checkpoint/rollback/validation — implemented in safety/patch.ts).
 *
 * Deliberately represented as full-file-write edits, not unified-diff hunks:
 * computing/applying hunk-based patches against an arbitrary base (with line
 * offsets and conflict detection) is a much bigger, more error-prone problem,
 * and git is already doing that computation for us. The actual "diff" artifact
 * — what 10_PRODUCTION_UPGRADE's multi-file diff support or a future advanced
 * view would show — is derived AFTER the fact from git (`git show <sha>`),
 * not stored here. This file only carries "what the executor wants written."
 */
export interface FileEdit {
  path: string; // relative to the engine's workDir
  op: "write" | "delete";
  content?: string; // required for "write", ignored for "delete"
}
export interface Patch {
  edits: FileEdit[];
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  provider: ExecutorName;
  tokensIn: number;
  tokensOut: number;
  cost: number; // USD, 0 for free/local tiers
  latencyMs: number;
  error?: string;
  /** True if served from the global pattern cache — no executor was actually called. */
  cacheHit?: boolean;
  /** Present when the executor is proposing file changes. The engine applies
   *  this to workDir BEFORE checkpointing (see executionEngine.ts) — applying
   *  is what creates the working-tree state the checkpoint commit captures. */
  patch?: Patch;
}

/** Swappable executor interface — every tier (real or mocked) implements this. */
export interface Executor {
  readonly name: ExecutorName;
  execute(packet: TaskPacket): Promise<ExecutionResult>;
}

export type ExecutionMode = "sequential" | "parallel" | "optimized";

/** Outcome fed back into Memory (06) + the learning loop (11) after a node settles. */
export interface NodeOutcome {
  projectId: string;
  graphId: string;
  nodeId: string;
  nodeType: NodeType;
  intent: string;
  provider: ExecutorName;
  /** Derived via dataBoundaryFor(provider) at construction time — see that
   *  function's docblock. Required, not optional: nothing should be able
   *  to silently skip recording this. */
  dataBoundary: DataBoundary;
  result: ExecutionResult;
}
