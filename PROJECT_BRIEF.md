# Personal AI Suite — Standing Project Brief

**Paste this whole file at the start of any new AI session (GPT, Claude, Cursor, anyone) before asking it to touch this repo.** It exists because this project is being built across many short-context sessions by different free-tier AIs, and the single biggest risk is not bad code — it's a new session inferring the wrong goal from whatever files happen to be in front of it. Read this before reading the code.

---

## 1. The actual goal (the part that's easy to lose)

Build a **personal, mostly-local AI suite and coordinator** that:

- Runs a **team of small, specialized local AI models** (not one general model) — separate models for coding, reasoning, audio processing, planning/classification, etc. The point is to get free, high-grade capability by routing each task to the local model best suited for it, instead of paying for one big model to do everything badly.
- **Switches tasks between local and online options** as needed — falling back to free online accounts, then paid APIs (GPT, Claude), only when local specialists genuinely can't handle something. Cost-ascending, not cost-blind.
- **Integrates with existing tools** — Cursor, and presumably other coding/IDE tools, as additional executors the coordinator can dispatch to, not as separate disconnected workflows.
- Delivers three concrete user-facing capabilities: **vibe coding** (describe what you want, AI plans + writes + validates the code), **file management**, and **audio processing**.
- Has a **core coordinator** that manages all of the above: takes an intent, breaks it into tasks, routes each task to the right specialist (local or online), tracks cost/budget, remembers what worked, and keeps changes safe (nothing permanent until validated).

If a session is asked to build or fix something and it isn't obviously serving one of those things, stop and ask rather than building it.

---

## 2. What already exists — two codebases, not one

A previous round of work produced **two separate, non-integrating codebases** living in the same repo, because different sessions built different halves of the goal without realizing the other half already existed. Do not treat them as one architecture in transition. They are:

### System A — "ai-forge-core" (the coordinator skeleton)
Files: `taskGraph/`, `memory/{db,ledger,patternCache,taskHistory}.ts`, `engine/`, `executors/{ollama,gpt,claude,freeTier,terminal}.ts`, `intelligence/{learningLoop,graphBuilder}.ts`, `wizard/`, `cli.ts`, `demo.ts`, `test/run.ts`, `HANDOVER.md`, `README.md`.

This is the **coordinator half**. It has:
- Five provider "tiers" (`ollama`, `free_tier`, `gpt`, `claude`, `terminal`) selected cost-ascending.
- A real SQLite-backed ledger that gates routing on RPM/RPD/$ budget — this is the "switch between local and online" mechanism.
- A learning loop that adjusts paid-provider preference (gpt vs claude) based on real success/cost/latency history.
- Git checkpoint-per-task-node + automated validate + rollback — this is the safety net "vibe coding" needs (nothing sticks until it's verified).
- A pattern cache (skip redundant work), a task graph (dependency-ordered task breakdown from one intent), and a Wizard/CLI front end.
- Per its own docs: 25 passing tests, demo verified across 5 runs. `claude` and `terminal` executors are real and tested against live infrastructure; `ollama`, `free_tier`, `gpt` are structured mocks (untested against live endpoints in the environment they were built in).

**What it's missing:** the "ollama" tier is one undifferentiated executor with one model. It has no concept of a *roster* of specialist local models.

### System B — the local specialist classifier (the roster half)
Files: `routing/{router,taskClassifier,types}.ts`, `runtime/*`, `events/*`, `memory/{ledgerStore,replay}.ts`, `executors/localExecutor.ts`, `providers/ollamaClient.ts`, `config/modelRegistry.ts`, `types/{contracts,taskTypes}.ts`.

This is the **specialist-roster half**. It has:
- A real `MODEL_REGISTRY`: phi3 (classifier), qwen (planner), llama (reasoner), mistral (fallback/retrieval/tooling), deepseek-coder (coder) — distinct local models for distinct jobs.
- A task classifier that routes by *task type*, including `audio.analysis` / `audio.transcription` / `audio.semantic` as first-class types alongside `code` / `reasoning` / `planning` / `retrieval` / `tooling`.
- An event bus + runtime registry for observability.
- A flat JSONL ledger (`ledgerStore.ts`) — a pure append-log, not a budget gate.

**What it's missing:** everything online. No free-tier/paid provider concept, no budget gating, no safety/checkpoint/rollback, no cross-tier fallback. It's local-only.

### The correct mental model going forward

**System B's classifier + model registry should become the internals of System A's `ollama` executor slot.** System A keeps owning: task graph, safety (checkpoint/validate/rollback), budget ledger, cross-tier fallback (local → free → paid), and the learning loop. System B's `taskClassifier`/`MODEL_REGISTRY` becomes the brains *inside* that local tier — when System A's router decides "try local first," it should hand off to System B's classifier to pick *which* local specialist, not just call one generic Ollama model.

Do not keep building these as two separate things. Do not delete either outright without reading this section first.

---

## 3. Known bug — FIX WRITTEN AND VERIFIED, needs to be applied to the real repo

`src/engine/executionEngine.ts` and `src/index.ts` both import a `Router` **class**, but `src/routing/router.ts` had been overwritten by System B's `routeTask()` function (no class, no `.route()` method) — most likely a later session saved System B's router over System A's at the one filename both systems share. This broke System A's compile.

**A replacement `src/routing/router.ts` has already been written and typechecked against the real `executionEngine.ts` from this repo's documented contents — see `router.ts` in this handoff.** It was verified by dropping it into a sandbox alongside faithful copies of `Ledger`, `LearningLoop`, `MemoryDB`, and the actual `executionEngine.ts`/`index.ts` call sites, and running `tsc` to confirm a clean compile (exit code 0). It restores the documented v1 (complexity preference) + v3 (learning-loop tiebreak) cost-ascending routing behavior from HANDOVER.md §4.2, and includes an explicit, clearly-commented stub (`localTierAvailable()`) marking exactly where System B's classifier/registry should plug into the local tier later — not wired in yet, since that integration design hasn't been decided (see §2/§5).

**Next session's job:** drop this file into the actual repo at `src/routing/router.ts`, then run the real `npm run typecheck` / `npm test`. The sandboxed verification used faithful reconstructions of dependencies from pasted file contents, not the live repo — confirm nothing has drifted since. If it passes, update this section to say so and remove the "needs to be applied" framing. If it doesn't, the diff between expected and actual is itself useful information — paste it back into the next brief.

---

## 4. What to ignore from earlier audit rounds

An earlier audit session was handed a governance document (ADR-005 through ADR-009, "ledger is canonical memory" / "federated authority model") that tried to reconcile System A and System B as if they were one architecture mid-migration. **They are not.** ADR-005–009 were written for and are already satisfied by System B's single JSONL ledger; they say nothing useful about System A's five-table memory model and don't need to be amended, superseded, or extended to cover it. Don't re-open that governance discussion — it was solving a problem that doesn't exist. If a future session starts proposing new ADRs about "federated vs. canonical," redirect it to this brief instead.

---

## 5. Open product decisions (need a human call, not an AI guess)

- **Cursor integration**: not yet designed in either system. Likely shape: another executor in System A's tier chain, or a System A `terminal`-style bridge that shells out to Cursor's CLI/API if one exists. Needs a decision on how Cursor fits the cost-tier ordering (is it "free" or "paid" for budget purposes?).
- **File management surface**: not yet built in either system. System A's `terminal` executor + checkpoint/rollback is the closest existing substrate — file-management actions could be modeled as task-graph nodes with `context.command` or `context.targetFile`, same as code-writing nodes are today.
- **Audio processing**: System B has the task-type taxonomy (`audio.analysis`/`transcription`/`semantic`) but no actual audio model wired in yet (no Whisper/CLAP/Essentia integration found in either codebase — `docs/ROADMAP_v1.md` lists these as "Epic 5: Audio Intelligence," not started).
- **free_tier / gpt executor verification**: these are real code but never tested against live endpoints (per System A's own HANDOVER.md — those domains weren't reachable in the sandbox they were built in). Before relying on "switch to online" working in practice, these need to be tested against actual live API calls.

---

## 6. Standing instructions for any session picking this up

1. Read this brief before reading code.
2. If you're about to build something, check section 1 first: which of (coordinator / local roster / vibe coding / file management / audio) does this serve?
3. If you're about to touch `routing/`, `memory/`, or `executors/`, check section 2 first — confirm which system (A or B) the file you're editing belongs to, and don't let System B's filenames silently overwrite System A's again.
4. If you find the Router bug (§3) already fixed, update this brief to say so and note what the fix looked like, so the next session doesn't re-discover it.
5. Update this brief, don't just fix code silently — the next session's biggest cost is re-deriving context, not writing code. A two-line addition to §2 or §5 here is worth more than a clean diff with no explanation.
