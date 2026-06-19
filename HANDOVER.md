# AI Forge — Core Engine: Project Handover

**Scope of this document:** the runnable core engine built so far — task graph, routing engine, memory (SQLite ledger + pattern cache), safety (git checkpoints + diff-based patching), and the five-executor AI layer. It does **not** cover the Wizard UI or the Tauri desktop shell, which are explicitly later phases and contain no code yet.

**Status at handover:** 25/25 automated tests passing, clean TypeScript build, full demo (11 sections) verified to run cleanly across 5 consecutive runs. ~3,600 lines of source + tests across 28 files.

---

## 1. Project Overview

### 1.1 What AI Forge is

AI Forge is a local-first AI orchestration desktop application. The intended end-to-end flow, once the Wizard UI and Tauri shell exist: a non-technical user states an intent through a wizard interface; the system decomposes that intent into a dependency-ordered graph of work items; each item is routed to the cheapest AI executor capable of handling it, in cost-ascending order (free local model → cheap rate-limited cloud → paid cloud reasoning); execution happens under git-checkpointed safety so nothing is permanent until validated; outcomes feed a memory system that tracks cost/quota usage and learns which providers perform best for which kind of work.

The governing philosophy, stated in the original spec and upheld throughout the build: prefer free and local; spend money only when local/free options are genuinely insufficient; never let an unvalidated AI-generated change become permanent; make the data boundary (what stays local vs. what leaves the machine) visible and controllable, not a silent default.

### 1.2 What this phase delivers

Everything **except** the user-facing parts. Concretely: a TypeScript/Node package that takes a `TaskGraph` (or builds one from a raw intent via the Graph Builder) and executes it through the full canonical lifecycle — pattern-cache check, ledger-gated routing, execution, patch application, git checkpointing, automated validation, commit-or-rollback, memory writes, and learning-loop updates — with real SQLite storage, real git operations, and one real AI provider (Claude) wired end to end. It is designed to be imported directly into the eventual Tauri app's backend without restructuring; nothing here assumes a particular UI.

### 1.3 What's deliberately not here

The Wizard's question-flow/plan-confirmation logic (`02_WIZARD_SYSTEM.md`), the Tauri shell (`08_DESKTOP_APP_TAURI.md`), any of `10_PRODUCTION_UPGRADE.md`'s hardening (multi-file diff hunks, finer rollback granularity, an audit-trail UI, an observability dashboard), real network integration for ollama or the free-tier providers (Gemini/Groq/OpenRouter — none of their domains are reachable from the sandbox this was built in, so nothing claiming to call them in this codebase is more than a structured mock), and any private/local web-search or research capability. Each is discussed further in §6 (Weak Points) with the reasoning for why it's out rather than just absent.

### 1.4 Repository layout

```
ai-forge-core/
  src/
    types.ts                  canonical vocabulary — single source of truth
    taskGraph/graph.ts         DAG, dependency resolution, partial-failure semantics
    routing/router.ts          tier selection, ledger-gated fallback chain
    memory/                    db.ts, ledger.ts, patternCache.ts, taskHistory.ts
    intelligence/              learningLoop.ts (routing v3), graphBuilder.ts (intent -> graph)
    safety/                    checkpoint.ts, validation.ts, patch.ts
    engine/                    executionEngine.ts, fileLock.ts, modelLock.ts, asyncMutex.ts
    executors/                 ollama.ts, freeTier.ts, gpt.ts, claude.ts, terminal.ts, + helpers
    wizard/wizard.ts           Wizard backend logic — question-flow, plan gate, no-code exposure
    demo.ts                    11-section narrated walkthrough of every behavior below
  test/run.ts                  25 assertion-based regression tests
  README.md                    living design-decision log, written incrementally during the build
  HANDOVER.md                  this document
  package.json / tsconfig*.json
```

Run `npm install && npm run demo` for a guided tour, or `npm test` for the regression suite (this also typechecks `src/` and `test/` first, via `pretest`).

---

## 2. Source Documents & Governance

### 2.1 The 13 locked specs

The project began from 13 finalized markdown spec files (`00`–`12`), each covering one subsystem. A set of architectural decisions across them are explicitly **locked** — not to be relitigated without an explicit reason from the project owner:

| Doc | Subsystem | Status here |
|---|---|---|
| 00 | System overview, cost-ordered tiers, data boundary | Tier philosophy implemented; data-boundary *visibility* not yet implemented as data (see §6) |
| 01 | Architecture, layer map (L1–L6), canonical node lifecycle | Fully implemented for L2–L6; L1 (UI) not started |
| 02 | Wizard system (modes, max-3-questions, no code exposure) | **Backend logic implemented** (`wizard/wizard.ts`) — question-flow, plan-before-execution gate, no-code-exposure enforcement are all built and tested. The actual UI (Tauri/React) and any adaptive question logic remain for a later phase. |
| 03 | Routing Engine (canonical executor set, tiered fallback) | Fully implemented (v1 static rules + v3 learning-loop tiebreak; v2 AI classification not built) |
| 04 | Task Graph System (task packet schema, partial failure) | Fully implemented |
| 05 | Execution Engine (modes, file-level locking) | Fully implemented, plus a second lock kind (model lock) the doc didn't anticipate |
| 06 | Memory System (history, ledger, pattern cache) | Fully implemented, plus an `error` column and `origin_patch` column added during the build (see §4.3) |
| 07 | Safety System (checkpoint, rollback, diff-based patching, validation) | Fully implemented — diff-based patching was the last of the three to land |
| 08 | Desktop app (Tauri) | Not started |
| 09 | MVP build plan | Followed for steps 3–6, 9–11; steps 1–2, 7–8 (Tauri, real ollama/free-tier/paid network calls) not done |
| 10 | Production upgrades | Not started |
| 11 | Intelligence Layer (learning loop, AI-generated graphs) | Fully implemented — this doc covers two distinct responsibilities (learning loop and graph building) that ended up as two files |
| 12 | Final system spec | Canonical vocabulary (`types.ts`) implements this directly |

The five canonical executors (`ollama`, `free_tier`, `gpt`, `claude`, `terminal`), the cost-ascending tiered fallback gated by the ledger, safety-before-cloud-execution sequencing, fully-automated validation, direct-dependents-only partial failure, the two-scoped memory model, and "routing v3 *is* the learning loop" are all still exactly as locked.

### 2.2 The one external reference document

`Local_AI_Developer_Stack.docx` — a practical guide to a real local AI developer setup, not part of the original 13 specs. It surfaced one concrete gap none of the specs anticipated: a real local model server can only hold one model in memory at a time, and switching costs real time. This produced the `LocalModelLock` (§4.6, §4.7). Everything else in that document (ChromaDB-style semantic memory, a private search service, persona-based system prompts) was evaluated and explicitly **not** acted on yet — see §6.

### 2.3 How decisions are recorded

Three layers, by design, not by accident: inline comments at the exact point a non-obvious decision was made (so the reasoning travels with the code); `README.md`'s "design decisions made while building" section as a single scannable log; this document as the consolidated reference. When extending this codebase, add to all three rather than only the one that's fastest to edit.

---

## 3. Architecture

### 3.1 Layered architecture

```
L1  UI               — NOT BUILT (Wizard, Dashboard, Timeline)
L2  Task system       — taskGraph/graph.ts
L3  Intelligence       — routing/router.ts + intelligence/learningLoop.ts + intelligence/graphBuilder.ts
                          (one logical layer per 01 — these three share state via L6, not separate stores)
L4  Execution          — engine/executionEngine.ts + executors/*
L5  Safety             — safety/checkpoint.ts + safety/validation.ts + safety/patch.ts
L6  Memory             — memory/db.ts + memory/ledger.ts + memory/patternCache.ts + memory/taskHistory.ts
```

### 3.2 Canonical vocabulary (`types.ts`)

Everything else in the codebase imports these rather than redefining them — this is the single most important file to understand first, and the one place a careless edit has the widest blast radius.

`ExecutorName` — exactly `"ollama" | "free_tier" | "gpt" | "claude" | "terminal"`. `NodeType` — exactly `"ui" | "backend" | "tests" | "docs" | "terminal"`. `TaskPacket` — `{ intent, context, constraints, dependencies, node_type, filePaths? }`, the serialized unit handed to one node before execution. `ExecutionResult` — what an executor returns: `success`, `output`, `provider`, token/cost/latency figures, optional `error`, optional `cacheHit`, optional `patch`. `Patch`/`FileEdit` — a list of whole-file write/delete operations an executor proposes. `NodeOutcome` — what gets handed to Memory and the learning loop after a node settles.

### 3.3 The canonical node lifecycle

This sequence, implemented as the body of `ExecutionEngine.runNode`, is the actual heart of the system:

```
pattern cache check (skip if node_type === "terminal")
  └─ HIT  → reuse cached output + provider + patch, cost 0, skip straight to checkpoint
  └─ MISS → route (ledger-gated tier chain) → execute via chosen executor
              (ollama calls additionally serialize through the model lock)
            → record ledger usage
apply any returned patch to the workspace (file writes/deletes)
git checkpoint the resulting working-tree state
validate (executor success + optional build/test commands)
  └─ PASS → mark node success, store in pattern cache (with its patch) if not already a cache hit
  └─ FAIL → git-revert the checkpoint, mark node failed, mark its DIRECT dependents 'blocked'
write to task_history + execution_logs
feed the learning loop (skipped on cache hits — see §4.5)
```

### 3.4 Concurrency model — three different locks, on purpose

This is worth understanding precisely, because each lock protects a genuinely different kind of resource, and conflating them was the source of two real bugs caught during the build (§6.1, §6.2).

`FileLockManager` (`engine/fileLock.ts`) — per-path, independent chains. Two nodes touching different files run fully concurrently; two nodes touching the same file queue. This is the only lock named in the original specs (05).

`AsyncMutex` (`engine/asyncMutex.ts`) — one global FIFO queue, no keys at all. Used by `CheckpointManager` for every git-mutating operation, because a git repository has exactly one `HEAD` regardless of which files a commit touches. Two nodes with zero file-path overlap can still race on this if it's missing — that was a real bug, not a hypothetical (§6.1).

`LocalModelLock` (`engine/modelLock.ts`) — also a single global queue (built on `AsyncMutex` internally), but it additionally tracks *which* model is considered "loaded" and only inserts a delay when a call needs a different one than the previous call did. Protects against a real local model server's actual constraint: it can only hold one model in memory at a time, and switching is slow (§6.2).

None of these three lock kinds can be merged into one without losing correctness: file locks must allow non-overlapping paths to run concurrently (that's the entire point of parallel mode); the git lock and model lock must NOT allow that, because the resource they protect has no "non-overlapping" case — there's only one `HEAD`, and only one model fits in memory.

### 3.5 Module map

| File | Responsibility |
|---|---|
| `types.ts` | Canonical vocabulary — see §3.2 |
| `taskGraph/graph.ts` | DAG construction, cycle detection, readiness, direct-dependents-only failure propagation |
| `routing/router.ts` | v1 static complexity classification, ledger-gated cost-ascending tier chain, v3 tiebreak via the learning loop |
| `memory/db.ts` | SQLite schema (5 tables) + `node:sqlite` connection wrapper |
| `memory/ledger.ts` | Per-provider RPM/RPD/$ budget tracking, lazy window rollover |
| `memory/patternCache.ts` | Global, cross-project cache keyed on `sha256(node_type + intent + context)`, including patch replay |
| `memory/taskHistory.ts` | Per-project status/outcome history, including the failure-reason query Graph Builder reads |
| `intelligence/learningLoop.ts` | Persisted routing weights (success rate / cost / latency per provider per node_type) — this *is* routing v3 |
| `intelligence/graphBuilder.ts` | Intent → `TaskGraph`, real Claude-driven decomposition with a deterministic fallback |
| `safety/checkpoint.ts` | Real git checkpoint-per-node + targeted single-commit revert |
| `safety/validation.ts` | Automated build/test gate, no human-review step |
| `safety/patch.ts` | Applies an executor's proposed file edits; parses `FILE:` blocks out of free-text model output |
| `engine/executionEngine.ts` | Wires everything above into the lifecycle in §3.3 |
| `engine/fileLock.ts`, `modelLock.ts`, `asyncMutex.ts` | The three lock kinds — see §3.4 |
| `executors/*.ts` | The five canonical executors — see §4.6 |
| `wizard/wizard.ts` | Wizard backend — question-flow state machine, `WizardPlan` (plan-before-execute gate, no-code-exposure enforcement) |

---

## 4. Subsystem Design Notes

### 4.1 Task Graph

A `TaskGraph` is built from a flat list of `{id, packet}` pairs; dependency edges come from each packet's `dependencies` array, and reverse edges (`dependents`) are computed once at construction. Cycles are detected and rejected at construction time via a straightforward DFS — this is the *only* place cycle detection happens; nothing else (including the AI-generated graphs from Graph Builder) re-implements it.

Partial failure is intentionally narrow: `markFailed()` only changes the status of the failed node's **direct** dependents, setting them to `'blocked'`. Anything further downstream is never explicitly touched — it simply never satisfies `isReady()` (which requires every dependency to be `'success'`), so it sits at `'pending'` indefinitely. This is a deliberate distinction: a transitively-stuck node correctly reads as "still waiting," not "actively rejected," if the graph is inspected mid-run.

### 4.2 Routing Engine

Three tiers in cost-ascending order: `ollama` → `free_tier` → a paid provider (`gpt` or `claude`). Before each hop, `Ledger.check()` is consulted; the chain skips to the next tier on budget exhaustion, not on call failure — a node that's allowed to call a tier but gets a real error from it does **not** automatically escalate to the next tier. That's a deliberate reading of the spec (03 only describes budget-based hopping) and worth knowing if someone expects automatic retry-on-failure later.

Within the paid tier, `classifyComplexity()` (a v1 static node_type → complexity mapping) sets a *preference* between gpt/claude; `LearningLoop.rank()` breaks ties between them using accumulated success rate, cost, and latency. Because the tie-break criteria are all equal for two never-used providers, and `Array.sort` is stable, an unseen pair resolves to exactly the v1 preference and only drifts once real outcomes disagree — one code path implements both "v1" and "v3," which matches `03_ROUTING_ENGINE.md`'s explicit statement that v3 *is* the learning loop, not a separate mechanism.

### 4.3 Memory System

Five tables: `task_history` and `execution_logs` are per-project; `pattern_cache` is deliberately global and cross-project (a pattern learned on one project should save a call on another); `cost_quota_ledger` tracks per-provider RPM/RPD/$ against configurable ceilings, with lazy window rollover (no background timer — the window is rolled forward the next time a provider is checked, if its reset time has passed); `routing_weights` is the learning loop's persisted state.

Two columns were added after the initial schema, both because a real feature needed them and their absence would have made that feature dishonest: `execution_logs.error` (originally only a `success` boolean — Graph Builder's "informed by past failures" needs the actual failure reason, not just a yes/no), and `pattern_cache.origin_patch` (originally only cached text output — a cache hit on a file-writing node would otherwise report success without actually reproducing the file). Both were plain column additions, acceptable pre-1.0 with no live data to protect; see §6 for why a real migration system is listed as a gap rather than built.

### 4.4 Safety System

Git checkpoint-per-node, not per-task: each node gets its own commit, tagged in-memory by `CheckpointManager` (`shaByNode`). Rollback is `git revert` of that one specific commit (via a `--no-commit` + explicit `--allow-empty commit` two-step, because `git revert` has no `--allow-empty` flag and a plain revert of a no-op checkpoint fails with "nothing to commit"), never a hard reset — a hard reset would also undo any sibling commits made in between under parallel execution. This is safe specifically because of two invariants: file-level locking prevents two nodes from racing on the same path, and a node never starts before its own dependencies have already resolved, so there's never an unrelated commit "underneath" a revert target.

Validation is two layers, both automated: did the executor itself report success, and — if the packet specifies `context.validate.buildCommand`/`testCommand` — does a real shell command actually pass. No human diff-review step exists or is planned, per `02`'s "no code exposure" rule; do not add one without that rule changing first.

Diff-based patching (`safety/patch.ts`) represents proposed changes as whole-file writes/deletes, not unified-diff hunks — git is already computing the actual diff for us (`CheckpointManager.diff()` exposes it via `git show`), so there was no need to re-implement hunk-based patch math. `applyPatch()` explicitly rejects any path that would resolve outside the workspace directory — patch paths come from AI output and were never assumed safe by default.

### 4.5 Intelligence Layer

Two genuinely different responsibilities live under one spec doc (`11`), and ended up as two files for exactly that reason. `learningLoop.ts` is the persisted-weights half — incremental-mean updates to success rate/cost/latency per (provider, node_type), read by the router. `graphBuilder.ts` is the "AI-generated graphs" half — turns a raw intent into a `TaskGraph`, asking Claude for a JSON node list when an API key is available, informed by a keyword-overlap match against this project's recent failures, falling back to a deterministic per-mode template on any failure (no key, bad JSON, an invalid node_type, a dependency outside the batch, or a cycle — the last one caught for free by `TaskGraph`'s own constructor).

A cache hit and the learning loop deliberately don't touch each other: crediting a provider for a call it didn't actually make would distort the very averages routing depends on.

### 4.6 Executors

All five implement one `Executor` interface (`execute(packet): Promise<ExecutionResult>`). `terminal` is real (`execFile`, requires `context.command` explicitly — never falls back to treating `intent` as a shell command). `claude` is real (`fetch` to `api.anthropic.com/v1/messages`; supports file-write requests via `context.targetFile`/`targetFiles`, parsed from `FILE:` blocks in the response; a successful call that doesn't produce all requested files is reported as a failure, not a partial success, though cost/tokens are still recorded). `ollama`, `free_tier`, and `gpt` are mocked — deterministic-ish canned results with simulated latency, each capable of producing a mock patch via the same `targetFile` convention.

`ollama` additionally has `selectModel()` — coding-flavored node types (`ui`/`backend`/`tests`) get `qwen2.5-coder:7b`, everything else gets `qwen3:9b` — feeding the model lock described next.

### 4.7 The local model lock

Surfaced by the external reference document, not the original specs (§2.2). A real local model server holds exactly one model in memory; running two at once on typical hardware spills one to swap and degrades both roughly 10x, and switching between them costs real time (the document cites ~10 seconds). `LocalModelLock` serializes every `ollama`-tier call through one queue and only pays the swap-delay penalty on an actual model change. This is deliberately conservative — it serializes *same*-model calls too, even though a real server could likely serve those concurrently — because a "shared within one key, exclusive across different keys" lock is meaningfully harder to get right and nothing currently needs that throughput. The direct, worth-stating-plainly consequence: "parallel" execution mode gives **no wall-clock speedup for ollama-tier nodes specifically**, by design. It still helps everywhere else.

### 4.8 Wizard subsystem

`wizard/wizard.ts` is the backend logic for `02_WIZARD_SYSTEM.md`'s three rules, enforced structurally rather than by convention:

**Max 3 questions**: `nextQuestion()` returns `null` at `MAX_QUESTIONS` regardless of how many mode-specific questions remain. The ceiling check is one line, separate from any per-mode question list, so adding a question to a mode can never accidentally exceed the ceiling.

**Always a plan before execution**: the only way to get a `TaskGraph` out of this module is `WizardPlan.confirm()`. `WizardPlan` holds its graph in a real JavaScript private field (`#graph`, not TypeScript's `private` keyword), which is unreachable even via `as any` from outside the file. `buildPlan()` additionally refuses to run if any required questions are unanswered.

**No code exposure**: `WizardPlan.summary` and `WizardPlan.steps` are derived solely from the user's own description text — the constraint composite added for GraphBuilder's benefit is stripped back out before display. `node_type`, `context`, `constraints`, `dependencies`, and `patch` are never part of the plan's public surface.

`Wizard` is a per-session state machine (mode → per-mode question list → answers → plan); it does not persist state between sessions. If the Wizard needs to be resumable across app restarts in the future, that's a new responsibility, not a hidden gap in the current design.

The question content itself is v1 (a fixed, static per-mode list), explicitly following the same "v1 static, v2 smarter" pattern as `classifyComplexity` and `selectModel`. The UX heuristic "skip questions whose answers are already implied by an earlier one" is not built — a future version could add that without changing the public interface.

---

## 5. Program Functions & Operating Instructions

### 5.1 Setup

```
npm install
npm run demo        # 10-section narrated walkthrough, fresh DB/git workspace each run
npm test             # typechecks src/+test/, then runs the 19 regression tests
npm run typecheck    # just the typecheck
npm run build        # emits dist/ (rarely needed directly; demo/test use tsx)
```

To exercise the real Claude executor and Graph Builder's AI path instead of their clean fallback behavior: `ANTHROPIC_API_KEY=sk-... npm run demo`.

### 5.2 Public API surface (`src/index.ts`)

Everything needed to embed this engine elsewhere is exported from one place: all of `types.ts`, `MemoryDB`, `Ledger`, `PatternCache`, `TaskHistory`, `LearningLoop`, `Router` + `classifyComplexity`, `TaskGraph`, `CheckpointManager`, `validate`, `FileLockManager`, `ExecutionEngine`, `buildExecutorRegistry`, `GraphBuilder` + `staticFallbackNodes` + `toNodeInputs` + `WIZARD_MODES` and their types.

Minimal usage:

```ts
import { ExecutionEngine, TaskGraph } from "ai-forge-core";

const engine = new ExecutionEngine({ dbPath: "./forge.db", workDir: "./workspace" });
await engine.init();

const graph = new TaskGraph("graph-1", "my-project", [
  { id: "ui", packet: { intent: "Build a login form", node_type: "ui", context: {}, constraints: [], dependencies: [] } },
]);

const logs = await engine.run(graph, "sequential"); // or "parallel" / "optimized"
engine.close();
```

Or, to go straight from a raw intent to a graph:

```ts
import { GraphBuilder } from "ai-forge-core";
const builder = new GraphBuilder(engine.memory, engine.taskHistory);
const { graph, source } = await builder.build({ graphId: "g1", projectId: "my-project", description: "add password reset", mode: "build_feature" });
await engine.run(graph, "sequential");
```

### 5.3 The demo, section by section

Each section isolates one behavior; run `npm run demo` to see all of them with real console output.

1. Normal graph — dependency order, sequential mode. 2. Pattern cache hit on an identical packet across two different graphs. 3. Partial failure — direct dependent blocked, unrelated sibling unaffected. 4. Ledger-driven tier fallback from budget exhaustion. 5. Terminal node, real shell execution. 6. Claude executor, a real API attempt (fails cleanly without a key). 7. Parallel mode + file-level locking. 8. The local model lock preventing two different-model ollama calls from overlapping. 9. Diff-based patching — an AI-tier node really writes a file, inspected via `checkpoints.diff()`, and a validation failure rolling that file back. 10. Graph Builder turning an intent into a graph, informed by an earlier section's failure. 11. Wizard — full question-flow, plan confirmation, then execution; all three spec rules visible in the output.

### 5.4 Common extension tasks

**Add a new Wizard mode.** Add it to `WIZARD_MODES` in `graphBuilder.ts`, add a question list entry in `QUESTIONS_BY_MODE` in `wizard.ts`, and add a fallback template in `staticFallbackNodes()` in `graphBuilder.ts`. The max-3-questions ceiling and plan-before-execution gate apply automatically.

**Add a new node type.** Add it to `NODE_TYPES` in `types.ts`, then decide where it needs special handling: `classifyComplexity()` in `router.ts` (paid-tier preference), `CODING_NODE_TYPES` in `ollama.ts` (local model selection), and `staticFallbackNodes()` in `graphBuilder.ts` (fallback templates). Nothing else needs to know about it — `TaskGraph`, the engine, and the safety layer are all type-agnostic.

**Wire a real executor (ollama/free_tier/gpt).** Replace the body of that file's `execute()` method; the `Executor` interface and everything calling it stay the same. For `ollama` specifically, keep `selectModel()`'s output flowing into the model lock — don't bypass `LocalModelLock` when making the call real, or the §4.7 race comes back.

**Adjust a provider's budget.** `Ledger.setBudget(provider, { rpmLimit, rpdLimit, dollarBudget })` at runtime, or edit `DEFAULT_BUDGETS` in `ledger.ts` for new defaults. All figures currently in that file are illustrative placeholders — see §6.4.

**Add a build/test gate to a node.** Set `packet.context.validate = { buildCommand, testCommand }`; both run as real shell commands in `workDir` via `safety/validation.ts`.

### 5.5 Environment & file conventions

`ANTHROPIC_API_KEY` — optional; both the Claude executor and Graph Builder's AI path degrade cleanly to a documented fallback without it. `dbPath`/`workDir` in `EngineOptions` are the only required configuration; `ollamaSwapDelayMs` is optional (defaults to the realistic ~10,000ms — override for tests/demos). The engine creates both paths if they don't exist; `workDir` becomes a real git repository on first `init()`.

---

## 6. Weak Points & Risks

This section consolidates every limitation flagged individually throughout the build into one risk register. Nothing here is hidden — each item also has an inline comment at its point of origin in the code, and most are also in `README.md`'s "known gaps" list. This is the version meant to be read top to bottom before deciding what to do next.

### 6.1 Caught and fixed during the build (recorded for context, not currently live risks)

A git HEAD-ref race: two parallel nodes with zero file-path overlap could still race on the single git ref every checkpoint commit touches, since file-level locking has no concept of "the whole repository" as a shared resource. Fixed with `AsyncMutex`; verified by confirming the regression test failed without the fix before accepting it.

A local-model race: the same bug class, one layer up — two parallel ollama-tier nodes needing different models had nothing stopping them from running concurrently, which on real hardware causes the exact memory-thrashing scenario described in the external reference document. Fixed with `LocalModelLock`; verified the same way.

### 6.2 Conservative simplifications that trade performance for safety

`LocalModelLock` fully serializes every ollama call, not just calls needing different models — a real local server can likely serve concurrent requests against one already-loaded model without contention, but a lock that's "shared within one key, exclusive across different keys" is meaningfully harder to get correct, and nothing currently needs that throughput. The practical effect: "parallel" mode currently gives no wall-clock speedup for ollama-tier nodes specifically.

### 6.3 Untestable in this build environment

Real network integration for `ollama` (localhost, no server present) and `free_tier` (Gemini/Groq/OpenRouter domains aren't in this sandbox's egress allowlist) could not be built against a live endpoint and verified end to end — both remain structured mocks behind the real `Executor` interface. The real GPT executor is in the same position (OpenAI's domain also isn't reachable here). Only the Claude executor and the terminal executor are real and verified against live infrastructure.

### 6.4 Calibration debt — numbers that are structurally correct but not verified

GPT/Claude per-token cost constants, the free-tier RPM/RPD defaults, the ~10-second ollama swap delay, and the two specific local model names (`qwen2.5-coder:7b` / `qwen3:9b`) are all sourced from either illustrative guesses or one specific document describing one specific 16GB M1 setup. None of these are wrong in *structure* — the ledger, the router, and the model lock all behave correctly given whatever numbers they're handed — but none should be trusted for a real budget or performance decision until verified against current provider pricing and the actual target hardware.

### 6.5 Scope gaps — decisions, not bugs

No Wizard logic (question flow, max-3-questions, plan-before-execution) and no Tauri shell — both explicitly deferred per the original task scope. No real schema migration system — acceptable pre-1.0 with no live data, a real problem the moment there is any. "Past failures" matching in Graph Builder is keyword overlap, not semantic search — works for similar phrasing, won't generalize to a failure described in very different words for the same root cause; the external reference document's own answer to this class of problem (ChromaDB-style vector embeddings) was evaluated and deliberately not built yet, since there's no embedding model reachable from this environment to build it against honestly. No private/local web-search or research capability at all — genuinely outside all 13 specs' scope, and an open question on whether AI Forge should grow toward that breadth or stay focused on code/dev tasks.

### 6.6 Structural assumptions worth surfacing explicitly

Single-process, single-machine: the git lock and SQLite connection both assume one engine process owns one workspace. Nothing here has been designed for, or tested against, multiple engine instances sharing a workspace or database. The `00_SYSTEM_OVERVIEW.md` data-boundary requirement ("user must be able to see and control what leaves the machine") is currently not represented as *data* anywhere — `NodeOutcome` doesn't carry a "this call left the machine, to where" field, so the future UI would have to infer it from `provider` rather than read it directly. Worth adding as a field before the Wizard phase starts, rather than reconstructing it there.

### 6.7 A genuine security boundary, not just a code-quality note

The terminal executor runs arbitrary shell commands from `packet.context.command` with no sandboxing beyond requiring the command be explicit (never inferred from `intent`). That's the correct trust boundary for an engine whose task graphs are either user-approved or AI-generated-then-validated, but it's worth being explicit that nothing currently limits *what* a terminal node can run — there's no allowlist, no resource limit, no privilege restriction. If task graphs are ever accepted from a less-trusted source than they are today, this needs revisiting before that happens, not after.

---

## 7. Standards & Conventions

### 7.1 Language and runtime choices

TypeScript on Node 22, ESM (`"type": "module"`), strict mode. `node:sqlite` (Node's built-in, stable since 22.5) instead of `better-sqlite3` — the latter needs a native build step that fetches headers from `nodejs.org`, unreachable from this sandbox's egress allowlist; functionally equivalent for a single-process engine, and the one place to revisit if a different SQLite binding is ever needed. Real `git` CLI calls (via `execFile`) for checkpointing, not a JS git library — the safety system's correctness depends on git's actual semantics, not an abstraction over them.

### 7.2 Recurring design patterns — look for these before reinventing them

**Real-with-documented-fallback.** Every external call (Claude executor, Graph Builder's AI path) has the same shape: attempt the real thing, and on any failure — missing key, network error, malformed response — degrade to a deterministic, clearly-labeled fallback rather than throwing. New integrations should follow this shape rather than letting a missing credential crash a run.

**v1-static-plus-later-refinement.** `classifyComplexity()` (router), `selectModel()` (ollama), and `staticFallbackNodes()` (graph builder) are all the same pattern: a simple, static, node-type-keyed decision that's explicitly named as the "v1" stand-in for a more sophisticated future version, written so the smarter version is a one-function swap rather than a redesign.

**Decision recorded at its point of origin.** Non-obvious choices (why a revert instead of a reset, why a global mutex instead of a per-path lock, why a column got added) are documented as a comment exactly where the choice was made, not only in README/this document. When extending the code, keep that habit — the reasoning should travel with the code that depends on it.

**Fix verified by first confirming it fails.** Both real concurrency bugs caught during the build (§6.1) were fixed by writing a regression test, confirming that test actually fails against the unpatched code, and only then accepting the fix. Apply the same standard to future concurrency-adjacent changes — a passing test against already-fixed code proves nothing about whether the test would have caught the original bug.

### 7.3 Testing standards

Assertion-based (`node:assert/strict`), no test framework — proportionate to the current size of the suite. Every test gets a fresh SQLite DB and git workspace under `.test-tmp/<test-name>/`, never shared state between tests. `npm test` always typechecks first (`pretest` → `tsconfig.test.json`, a separate config from the build one specifically so test files get real type coverage without affecting `dist/`'s `rootDir`/emit settings).

### 7.4 Documentation standards

Three places, every time a non-obvious decision is made: an inline comment at the decision point, a line in `README.md`'s design-decision log, and (for anything substantial enough to affect a handover) this document. Spec-doc references in comments use the `NN_NAME.md` numbering from the original 13 files so anyone can trace a piece of code back to the requirement it implements — or to the explicit note that it implements a gap *no* spec doc covered.

---

## 8. Suggested Next Steps (not started, in rough priority order)

**Completed in the most recent pass:** verified and updated all pricing/rate-limit constants (Claude exact, GPT calibrated, Gemini free-tier RPD corrected to 1,500); added the `dataBoundary` field to `NodeOutcome` and `execution_logs`, with a `dataBoundarySummary()` query that gives a future UI real data to show instead of re-deriving it from `provider`; implemented the Wizard backend (`wizard/wizard.ts`) — question-flow state machine, `WizardPlan` plan-before-execution gate, and structural no-code-exposure enforcement.

**Remaining, in rough priority order:**

The research/search scope question is still unresolved — whether AI Forge should grow toward a general assistant surface (private local search, research nodes) or remain focused on code/dev tasks. This is a product decision, blocking nothing else, but worth settling before any related code gets written.

The Wizard needs a UI driver — something that renders `nextQuestion()`, takes user input, calls `answer()`, shows the `WizardPlan`, and calls `confirm()`. This is the natural first Tauri/React task; the backend contract (`Wizard`, `WizardPlan`) is fully stable and tested. Wizard session persistence (resuming across app restarts) is a separate, explicit decision if it's ever needed — it's not a hidden gap in the current design.

Calibrate the remaining placeholder numbers (local model swap delay, local model names) against the actual target hardware before they're load-bearing.

Defer semantic memory (embeddings for "past failures" matching) and real ollama/free-tier/GPT network integration until each can be tested against live infrastructure. Don't stub them more than they already are — the `Executor` interface and `graphBuilder.ts`'s fallback pattern are already the right seams; waiting until a real endpoint is available is more honest than building something that can't be verified.
