# AI Forge — Core Engine (Phase: pre-Tauri-shell)

This is the runnable core of AI Forge: task graph + routing engine + memory
(SQLite ledger + global pattern cache) + safety (real git checkpoints) +
swappable AI executors. It is plain TypeScript/Node, deliberately not wired
into Tauri yet — the goal was a core that drops into the desktop app's L2–L6
later without a rewrite, not a UI.

## Setup

```
npm install
npm run demo       # narrated walkthrough of every documented behavior
npm test           # typechecks (src + test), then runs automated assertions
npm run typecheck  # just the typecheck, on its own
```

`npm run demo` and `npm test` each use their own throwaway SQLite DB and git
workspace under `.demo/` / `.test-tmp/` (gitignored, deleted/recreated on
each run). To exercise the real Claude executor instead of getting a clean
"no API key" failure, run `ANTHROPIC_API_KEY=sk-... npm run demo`.

## Module map (which file implements which spec doc)

| Spec doc | Implementation |
|---|---|
| 00 System Overview (data boundary, cost-ordered tiers) | `routing/router.ts` (tier order), `executors/*` (per-tier behavior) |
| 01 Architecture (node lifecycle) | `engine/executionEngine.ts` — the lifecycle is literally the body of `runNode` |
| 03 Routing Engine | `routing/router.ts` |
| 04 Task Graph System | `taskGraph/graph.ts` |
| 05 Execution Engine (modes, file locking) | `engine/executionEngine.ts`, `engine/fileLock.ts` |
| 06 Memory System | `memory/db.ts`, `memory/ledger.ts`, `memory/patternCache.ts`, `memory/taskHistory.ts` |
| 07 Safety System | `safety/checkpoint.ts`, `safety/validation.ts`, `safety/patch.ts` (diff-based patching — named in 07, not built in the first pass) |
| 09 MVP Build Plan | this whole package, minus Tauri (step 1–2) and the wizard UI |
| 11 Intelligence Layer — learning loop (= routing v3) | `intelligence/learningLoop.ts`, consumed by `routing/router.ts` |
| 11 Intelligence Layer — "AI-generated graphs" / Graph Builder (named as an L3 sub-component in 01, not built in the first pass) | `intelligence/graphBuilder.ts` |
| 12 Final System Spec | `types.ts` (canonical vocabulary) + everything above |

`02_WIZARD_SYSTEM.md` and `08_DESKTOP_APP_TAURI.md` aren't implemented —
that's the explicitly out-of-scope next phase. `10_PRODUCTION_UPGRADE.md`
(multi-file diffs, finer rollback granularity, audit trail UI) is also not
built; the current safety layer is the 07 baseline it's meant to extend.

## Local model lock — a gap the 13 specs never raised

Source: `Local_AI_Developer_Stack.docx` (a real-world "what to install on
your M1" guide), not any of the 13 spec docs — none of them mention
model-switching cost or memory contention at all. The document's "golden
rule" — never run two models simultaneously on 16GB, since one spills to
swap and both degrade 10x, and a real Ollama hot-swap costs ~10 seconds —
exposed a real gap: `FileLockManager` (05) only serializes nodes sharing a
*file path*. Two ollama-tier nodes needing *different* models share no
file path at all, so the existing lock would let them run fully
concurrently — precisely the scenario the document warns about. This was
invisible while `OllamaExecutor` was a flat mock with no notion of "which
model"; it becomes a real correctness concern the instant ollama execution
is wired to a real local instance.

Same bug *class* as the git HEAD-ref race from an earlier pass: a globally
shared, non-file-scoped resource that file-path locking has no language
for. Fixed the same way: `engine/modelLock.ts`'s `LocalModelLock` serializes
every ollama-tier call through a single queue, tracking which model is
"loaded" and only paying the swap-delay penalty on an actual switch.
`executors/ollama.ts` gained `selectModel()` — a v1-style static node_type
mapping (coding node types → `qwen2.5-coder:7b`, others →
`qwen3:9b`, the document's concrete recommendation for 16GB hardware),
the same pattern `routing/router.ts`'s `classifyComplexity` already uses
for the paid tier, one level down. The engine only applies this lock to
the `ollama` tier specifically — free_tier/gpt/claude are independent
remote calls with no such constraint, and terminal isn't a model at all.

Two things named explicitly rather than left implicit:
- This fully serializes EVERY ollama call, not just calls that need
  different models — more conservative than strictly necessary, since a
  real Ollama server can serve concurrent requests against one already-
  loaded model without contention. A "shared within one key, exclusive
  across different keys" lock would capture that, but is meaningfully more
  complex to get right, and nothing here currently needs the throughput.
  Flagged as the one place to revisit if that changes.
- Consequence worth being direct about: "parallel" execution mode now
  provides **no wall-clock speedup for ollama-tier nodes specifically**, by
  design. It still helps everywhere else — free_tier/gpt/claude calls hit
  independent remote capacity, and terminal commands run as independent OS
  processes.

While building this, extracted the FIFO-mutex pattern that was previously
a private method inside `CheckpointManager` (`withGitLock`) into
`engine/asyncMutex.ts`'s `AsyncMutex`, since `LocalModelLock` needed the
exact same "one global queue" shape. Pure refactor — `CheckpointManager`
now delegates to it instead of keeping its own copy; the existing git-race
regression test confirms no behavior changed.

Verified the same way as the git-lock fix: confirmed the new integration
test actually fails without the lock (logged the real overlap, then
reproduced it with the lock temporarily bypassed) before accepting it.

## Graph Builder — closing the Intent → Graph gap

The first pass built the Routing Engine and the learning loop (both named
L3 sub-components in `01_ARCHITECTURE.md`) but not the third one, Graph
Builder — the piece that turns a raw intent into a `TaskGraph`. Until this
addition, every `TaskGraph` in the demo/tests was hand-assembled in code;
nothing implemented the actual Intent → Graph step of the canonical
lifecycle.

`intelligence/graphBuilder.ts` closes that gap with the same real/fallback
split used everywhere else in this codebase:
- **Real**: asks Claude to decompose the intent into a JSON node list,
  informed by recent failures in the same project (queried from
  `execution_logs`/`task_history` via simple keyword overlap — not semantic
  search; that would need embeddings and is flagged as a known
  simplification, not a finished feature).
- **Fallback**: a small deterministic per-mode template
  (`staticFallbackNodes`), used whenever there's no API key, the call
  fails, or the AI's JSON doesn't pass validation (unknown node_type, a
  dependency referencing an id outside the batch, or a cycle — the last one
  caught for free by `TaskGraph`'s own constructor, not re-implemented
  here).

It reuses the four Wizard mode names from `02_WIZARD_SYSTEM.md`
(`build_feature` / `fix_issue` / `create_project` / `deploy`) purely as a
label for picking a fallback template — it does not implement the Wizard's
question flow, the "max 3 questions" rule, or any UI. That's still a later
phase.

Required a small schema addition: `execution_logs` previously only stored a
`success` boolean, with no record of *why* a node failed — which made
"informed by past failures" (11) impossible to implement honestly. Added an
`error TEXT` column. Pre-1.0 with no live data to preserve, so this was a
plain column addition rather than a real migration; a proper migration
system is listed below as a known gap once there's real data to protect.

## Diff-based patching — closing the "safe mutation" gap

`07_SAFETY_SYSTEM.md` lists "diff-based patching" as its own component,
parallel to checkpoint/rollback/validation. The first pass built the other
three but not this one — and the gap wasn't cosmetic: only the terminal
executor actually mutated files in the workspace. `00_SYSTEM_OVERVIEW.md`'s
core claim, "intent → task graph → multi-AI execution → **safe mutation** →
validated commit," wasn't actually true for AI-tier nodes, and most of the
checkpoint/rollback machinery only got exercised by terminal commands.

`safety/patch.ts` adds a `Patch` (a list of file writes/deletes) and
`applyPatch()`. A packet requests a file write via `context.targetFile` /
`targetFiles`; an executor that can satisfy it returns `ExecutionResult.patch`;
the engine applies that patch to `workDir` right before checkpointing — so
the same checkpoint/validate/commit-or-rollback flow that already existed
now genuinely governs AI-tier file mutations, not just shell commands.
Concretely: ollama/free_tier/gpt mocks write a small deterministic stand-in
file when a target is requested; the real Claude executor asks for `FILE:
path` blocks in its response and parses them — and if it doesn't produce
*all* requested files, that's reported as a failure (cost/tokens still
recorded, since a real call was made) rather than a silent partial success.

Patches are represented as full-file-write edits, not unified-diff hunks —
computing/applying hunk-based patches against an arbitrary base (line
offsets, conflict detection) is a substantially harder problem, and git is
already doing that computation for us. The actual *diff* artifact — what
`10_PRODUCTION_UPGRADE.md`'s multi-file diff support or a future advanced
view would show — is derived after the fact via `CheckpointManager.diff()`
(`git show <sha>`), not stored separately.

One consequence worth being explicit about: the pattern cache (06) had to
grow an `origin_patch` column. Caching only the text output and not the
patch would have made caching silently unsound for any file-writing node —
a cache hit would report success without actually reproducing the file the
original call wrote. Covered by a test that deletes the file between runs
and confirms the cache hit recreates it from the stored patch, not just
from whatever happened to still be on disk.

## What's real vs. mocked

- **Real**: SQLite storage (`node:sqlite`, not `better-sqlite3` — see note
  below), git checkpoints/rollback (`safety/checkpoint.ts` runs actual `git`
  commands), the terminal executor (`execFile`), the Claude executor (a real
  `fetch` to `api.anthropic.com/v1/messages`, including real file-write
  requests via `context.targetFile` — see "Diff-based patching" below).
- **Mocked**: ollama, free_tier, and gpt executors — each returns a
  deterministic-ish canned result with simulated latency, behind the same
  `Executor` interface a real integration would use, and each can also
  produce a mocked file-write patch when a target file is requested.
  Swapping any one of them for a real call is a self-contained change to
  that one file.

### Why `node:sqlite` instead of `better-sqlite3`
`better-sqlite3` needs a native build step that downloads Node headers from
`nodejs.org`, which this sandbox's network egress allowlist blocks (not in
the API/npm/PyPI domain list). Node 22+ ships `node:sqlite` built in, with no
native compile step. Functionally equivalent for our purposes (single
process, file-backed, synchronous API); flagged here because if a future
environment needs a different SQLite binding, this is the one place that
decision lives (`memory/db.ts`).

## Design decisions made while building (not pre-specified)

The 13 docs are thorough but a few real implementation questions weren't
settled on paper. Each is called out as a comment at its point of decision
in the code; the list here is so they're visible without spelunking:

- **Git checkpointing under real concurrency.** File-level locking (05)
  only guarantees two nodes don't race on the same *file content* — it does
  nothing to stop two nodes with zero path overlap from racing on the
  *git repository itself*, since every checkpoint commit touches the same
  HEAD ref no matter which files it wrote. This surfaced as a real
  `fatal: cannot lock ref 'HEAD'` failure while demoing two non-overlapping
  parallel nodes, not a hypothetical. Fixed with a second, separate lock
  inside `CheckpointManager` — a global FIFO queue around every git-mutating
  call — so the git operations are always serialized while the actual
  executor work for non-overlapping nodes still runs fully concurrently.
  Covered by a dedicated regression test (`concurrent checkpoints ... don't
  race on git's HEAD ref`), confirmed to actually fail against the
  unpatched code before being accepted. (`safety/checkpoint.ts`)
- **What "blocked" means for indirect dependents.** 04/07 say a failed
  node's *direct* dependents are blocked. A grandchild two hops downstream
  is never explicitly marked anything — it just never becomes `ready`
  because its own direct dependency never reaches `success`. It reads as
  `pending` forever, not `blocked`. (`taskGraph/graph.ts`)
- **What a checkpoint actually reverts.** "Reverts the failed node's
  checkpoint" is implemented as `git revert` of that one node's commit, not
  a hard reset to an earlier point in history — a hard reset would also
  undo any sibling commits made in between under parallel execution. This
  is only safe because of the file-locking invariant (a node's checkpoint
  commit's diff can never be touched by another node before it's
  reverted). (`safety/checkpoint.ts`)
- **Whether ollama can have a budget.** The ledger no longer hardcodes
  ollama as unconditionally allowed; it has no *default* ceiling (matching
  "no rate limit"), but the same generic budget mechanism every other
  provider uses can cap it if a deployment ever wants to model a
  constrained local instance. (`memory/ledger.ts`)
- **v1→v3 routing relationship.** v1's static node-type → complexity
  mapping decides a *preference* between gpt/claude; v3's learning loop
  only breaks ties between them via a stable sort, so an unseen pair
  resolves to the v1 preference and only drifts once real outcomes
  disagree — one code path, not two. (`routing/router.ts`)
- **All tiers exhausted.** Not specified in 03/06. Surfaced as a clean
  per-node failure (`executor: null`) rather than silently exceeding a
  budget. In practice this can't currently happen since ollama has no
  default ceiling, but the path exists and is tested.
- **Pattern cache on cache hit.** Skips the ledger (no real call = no
  quota spent), skips re-running `validate()`'s build/test step (the
  cached output already passed validation when first stored), and is
  excluded from the learning loop's outcome recording (crediting a
  provider for a call it didn't make would distort its success/cost/
  latency averages). Terminal nodes are never cached — replaying a shell
  command's old output instead of running it again would be wrong.
  (`engine/executionEngine.ts`)
- **Terminal command source.** A terminal node's shell command must come
  from `packet.context.command`, never from `intent` — `intent` is
  free-text meant for humans/AI, and treating it as executable would
  silently turn a description into code execution. (`executors/terminal.ts`)

## Known gaps / explicitly deferred

- **v2 routing** ("a small local model classifies task complexity") isn't
  built; `routing/router.ts`'s `classifyComplexity()` is the v1 static
  stand-in, written so swapping it for a real classifier later only
  touches that one function.
- **"optimized" execution mode** is currently an alias for "parallel."
  True cost/latency-aware scheduling (e.g., prioritizing cheap nodes under
  a shared budget) is real future work, not a renamed existing thing.
- **gpt/free_tier/ollama pricing and rate constants** are illustrative
  placeholders (commented at their definition), not verified current
  provider numbers — replace before using this for real budget decisions.
- Real ollama/free_tier HTTP integration, the wizard UI, and the Tauri
  shell are all the next phases, not attempted here.
- No real schema migration system — fine pre-1.0 with throwaway dev
  databases, not fine once there's real data to preserve across a schema
  change.
- "Past failures" matching is keyword overlap, not semantic search —
  works for the demo's deliberately-similar phrasing, won't generalize to
  failures described in very different words for the same root cause.
- The real Claude executor's file-write path can only WRITE files, not
  delete them — asking a model to express deletions in free text is an
  easy way to accidentally lose files for little gained capability; a real
  delete path would need a more deliberate, structured request mechanism.
- Patches are whole-file-content edits, not unified-diff hunks. Fine for
  generating new files or full rewrites; an executor that wants to make a
  small, surgical edit to a large existing file currently has to resend the
  entire file content to do it.
- `LocalModelLock` fully serializes ollama-tier calls rather than allowing
  same-model concurrency — a deliberate simplification, not a finished
  optimization (see "Local model lock" above).
- The ~10s swap delay and the two model names in `executors/ollama.ts` are
  sourced from one specific document describing one specific 16GB M1
  setup — calibrate against the actual target hardware before trusting
  the timing for anything real.
- No private/local web search or research capability — out of the 13
  specs' scope entirely, and a genuine open question on whether it should
  be in AI Forge's scope at all (vs. staying focused on code/dev tasks).
