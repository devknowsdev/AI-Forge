# Systems Portfolio — Handover

**Date:** June 2026
**Covers:** AI-Forge, EPK, ADHDashboard, the planned Music Management Layer,
and the cross-system governance doc (`PERSONAL_SYSTEMS_CONSTITUTION.md`).
**Purpose:** Let any future session — yours or another assistant's — resume
this work cold, without re-deriving findings already confirmed here.

## 0. How to Resume

1. Paste this whole file back in first.
2. Paste `PERSONAL_SYSTEMS_CONSTITUTION.md` alongside it — it's the
   standing cross-project governance layer this handover assumes.
3. For AI-Forge work specifically, also paste `SESSION_HANDOVER.md` and
   `FIX_REPORT.md` (the provenance trail §3 below summarizes) — they're more
   authoritative than this summary if anything here conflicts.
4. Start at §7 (Open Decisions) — that's the actual to-do list. Everything
   above it is confirmed state, not pending work.
5. **Single most important thing to know before touching anything:** AI-Forge
   contains two competing architectures (Track A and Track B, §2). Don't
   "clean up" duplicate-looking code without checking which track it belongs
   to first — see §2 before deleting or merging anything.

---

## 1. System Registry

| System | Status | Stack | Notes |
|---|---|---|---|
| AI-Forge | Track A: fixed, mostly verified. Track B: inert, fate undecided. | TS/Node, `node:sqlite`, git-as-safety-trail | See §2–§3 |
| EPK | Live | Vanilla JS, Cloudflare Pages, GitHub-publish admin panel | See §5 |
| ADHDashboard | Active dev (v43+ per project history) | Vanilla HTML/JS/CSS, localStorage + IndexedDB | Not audited this session — status per prior context only |
| Music Management Layer | Planning only, no code written | TBD, own engine | See §4 |

---

## 2. AI-Forge — Two Architectures, Not One

The repo contains **two separate, historically competing implementations**
of "AI task orchestration." This explains most of the duplicate/incompatible
code found during the drift audit — it isn't random mess, it's fossils of
two systems that each, at different points, believed itself canonical.

### Track A — ACTIVE, currently the real system
`ExecutionEngine`, `TaskGraph`, `Router`, `Ledger`, `LearningLoop`,
`PatternCache`, `TaskHistory`, `CheckpointManager`, `GraphBuilder`, `Wizard`,
`executors/*`, canonical `types.ts`. Unit of work: a `TaskPacket` with a
closed `NodeType` (`ui | backend | tests | docs | terminal`). Safety model:
git-checkpoint-per-node, rollback via `git revert`. This is what
`src/cli.ts`, `src/demo.ts`, and `test/run.ts` actually exercise, and what
the recent fix session worked on (§3).

### Track B — EXPERIMENTAL, currently inert, fate undecided
`src/runtime/**`, `src/events/**`, `routing/taskClassifier.ts`,
`routing/types.ts`, `types/contracts.ts`, `types/taskTypes.ts`,
`config/modelRegistry.ts`, `providers/ollamaClient.ts`,
`executors/localExecutor.ts`, `memory/ledgerStore.ts`, `memory/replay.ts`.
Unit of work: a different `TaskType` enum (`audio.analysis`,
`audio.transcription`, `audio.semantic`, `code`, `planning`, `reasoning`,
`retrieval`, `tooling`). Currently excluded from typecheck
(`tsconfig.test.json`), all of it dead/unreachable from Track A's actual
execution path.

**Evidence this was a real architectural flip, not just sloppy duplication:**
`REPO_AUDIT.md` (Sprint 010, Track B's own audit) states outright: *"Current
repository is a lightweight deterministic execution pipeline... Sprint 010
was implemented against the current structure rather than the legacy
executionEngine architecture."* At that point Track B considered itself
current and Track A "legacy" — the exact inverse of how
`HANDOVER_NEXT_SESSION.md` and the recent fix session now classify them.

**Known landmines from this split (confirmed, currently inert, do not touch
speculatively):**
- Three incompatible `RouteDecision` interfaces (`routing/router.ts` —
  Track A, real; `routing/types.ts` and `types/contracts.ts` — Track B).
- Two incompatible `ExecutionResult` interfaces (canonical `types.ts` vs.
  `types/contracts.ts`).
- Two incompatible `RunStore` classes (`memory/runStore.ts` — Track A, in
  active use; `runtime/runStore.ts` — Track B, confirmed unused dead code).
- `routing/taskClassifier.ts` imports `zod`, also absent from
  `package.json` — harmless only because the file is excluded from
  typecheck.

**The one open question Track B raises that actually matters (§7.2):**
its unbuilt "Epic 5 — Audio Intelligence" (Whisper/CLAP/Essentia) is the one
piece of the *original* stated AI-Forge vision (`HANDOVER.md`: "audio
processing — Ableton/MIDI/RC-600") that Track A's purely code-shaped
`NodeType` doesn't cover at all. This is a real scope decision, not
housekeeping — don't let it stay dead by default just because the
duplicate-interface mess around it is inert.

A separate, third thing — **the Capability layer** (`src/capabilities/*`,
PROJECT_BRIEF.md's "Phase 3") — is neither Track A nor Track B. It's
scaffolding for a future generic plugin interface (`Capability` /
`CapabilityRegistry`), exported from `index.ts` but **never imported by
`executionEngine.ts`** — fully unwired. All three built-in capabilities
(`vibeCodingCapability`, `fileManagementCapability`,
`audioProcessingCapability`) just return `{success:false, error:'Not
implemented'}`. This is the extension point AI-Forge's own ADRs (0009,
0012) name for plugging in new domains — but there's no working precedent
to copy yet.

---

## 3. AI-Forge — Recent Fix Session Status

Full provenance: `SESSION_HANDOVER.md` (reconstruct + diagnose, nothing
fixed yet) → `FIX_REPORT.md` (fixes applied + claimed-verified) →
`ALL_CHANGES.diff` (the actual diff, cross-checked this session).

### Confirmed correct (verified two ways: diff matches the known-broken
original source, AND the fix targets the real Track A API shapes)

| File | Problem | Fix |
|---|---|---|
| `taskGraph/graphContract.ts` | Assumed `graph.nodes` array + `node.dependsOn`/`node.dependencies`; real `TaskGraph` has neither (private `Map`, deps at `node.packet.dependencies`) | Rewritten to use `graph.all()` and `node.packet.dependencies`, typed as `TaskGraph` not `any` |
| `core/ControlSurface.ts` | `begin(graph: any): any` caused an implicit-any cascade in `executionEngine.ts`; `validate()`'s truthiness check never actually caught the real bug | `begin<T>(graph: T): T` generic; `validate()` now checks `typeof graph.all !== "function"` |
| `memory/runStore.ts` | `append()` threw `ENOENT` if the file was missing | Self-heals — recreates the file if missing |
| `cli/plan.ts` + `cli/run.ts` | Called a `GraphBuilder` API that doesn't exist (zero-arg constructor, wrong `build()` signature); `run.ts` also passed an unresolved `Promise` into `engine.run()` | Both now use the real `(memory, taskHistory)` constructor and single `GraphBuilderInput` object; `run.ts` reuses the engine's own memory/taskHistory instead of a second `MemoryDB` |

This resolves the mechanically-confirmed root cause of 15/25 test failures
(`Error: Graph must contain nodes array`) and the one `noImplicitAny`
typecheck error.

### Claimed, NOT independently verified — re-check before trusting (§7.1)

`FIX_REPORT.md` also claims fixes to:
- `safety/checkpoint.ts` — excluding `.forge/` from checkpoint sweeps, and
  changing `hadChanges` from `git status --porcelain` to
  `git diff --cached --name-only` (with a self-described regression caught
  and fixed mid-session: 20/25 → 13/25 → 25/25).
- `package.json` — adding `commander` as a real dependency.

**Neither change appears in `ALL_CHANGES.diff`.** A file named
`ALL_CHANGES.diff` should contain every change the 25/25 result depends on
— it doesn't. This doesn't mean the fixes are fake (you can't get `tsc
--noEmit` to pass without `commander` resolving, and the regression
narrative is too specific to invent), but it means **this diff cannot
currently serve as the verification artifact it's named for.**

**Action before treating Track A as closed:** regenerate a real
`git diff`/`git status` covering `checkpoint.ts` and `package.json`
specifically, then re-run:

```
npx tsc --noEmit -p tsconfig.test.json
npm test
npx tsx src/demo.ts
```

---

## 4. Music Management Layer — Planning State

Source document: `dk_architecture.js` (a docx-generator script producing
*"Dave Knowles — AI-Orchestrated Music Career System"*). No code has been
written for this system yet.

**Five clusters defined:**
| Cluster | Verdict | Approach |
|---|---|---|
| A — Identity & Presence | Built | EPK (see §5) |
| B — Distribution & Catalogue | Use existing | DistroKid/Bandcamp/SAMRO — commodity, don't build |
| C — Booking & Gig Management | Build (lightweight) | `gigs.json` + admin page + AI-drafted replies + `rider.html` |
| D — Promotion & Socials | Orchestrate | Claude drafts, human approves, Buffer/Graph APIs dispatch |
| E — Business & Finance | Use existing | Wave, Google Docs templates, SAMRO |

Six-phase roadmap: Phase 1 (EPK) done; Phase 2 (local Ollama setup),
Phase 3 (gig tracker), Phase 4 (social orchestration), Phase 5
(automation/webhooks via n8n), Phase 6 (intelligence layer) — none started.

**Pluggability conclusion from this session (full reasoning in chat history,
not repeated here):** do **not** build this on AI-Forge's `TaskGraph`/
`NodeType`/git-checkpoint safety model. Music actions (post, send, invoice)
aren't git-revertible the way file writes are — forcing them through that
safety model is a category error. **Reusable by pattern, not import:**
`Ledger`'s cost/quota schema shape, `PatternCache`'s
`hash(type+intent+context)` key shape, and the cost-ascending
ollama→free→paid routing philosophy. Build the music layer as its own small
orchestrator with its own node-type vocabulary
(`gig_reply`/`social_post`/`press_release`/`invoice_draft`...), governed by
the same constitution (§6), not sharing runtime code with AI-Forge.

---

## 5. EPK — Current State

Live, working, JSON-driven (`public/data/epk.json` as single source of
truth), six audience "modes" via `?for=` query param, deployed to
Cloudflare Pages from `public/`. Admin panel (`admin.html`) edits content
and publishes via a GitHub PAT stored in `localStorage`, committing straight
to `epk.json` through the GitHub Contents API.

**Two patterns from this repo worth reusing elsewhere, not just admiring:**
- The GitHub-PAT-publish-from-admin-page pattern — directly reusable for
  any future "edit data, publish via GitHub API" admin UI (e.g. a gig
  tracker admin page).
- The "modes" pattern — one dataset, audience-tailored views via query
  param — directly applicable to a press/booker view of gig or release
  data later.

---

## 6. Cross-System Governance

`PERSONAL_SYSTEMS_CONSTITUTION.md` was written this session and delivered
as a separate file — treat it as the standing document, not a summary
here. Key points to remember without re-reading it in full:

- **Three kinds of "coherence,"** solved differently: resource (real,
  needs an answer), cost-visibility (optional, defer), convention (cheap,
  do first).
- **The one real, currently-unaddressed risk:** local Ollama contention.
  `LocalModelLock` (AI-Forge) is an in-process `AsyncMutex` — it does
  **not** protect against a second OS process (e.g. the music layer)
  calling Ollama directly. Not urgent today (nothing runs concurrently
  yet), but don't assume it's solved.
- **Escalation rule:** don't share runtime code speculatively. Promote a
  convention to shared infrastructure only after a problem has actually
  occurred twice.
- **Still open:** where this doc's canonical home should be (recommended:
  its own small repo, not nested inside AI-Forge, since it governs AI-Forge
  as one peer among several) — see §7.3.

---

## 7. Open Decisions — Do Not Resolve Unilaterally

Per this project's own standing pattern (`PROJECT_BRIEF.md` and repeated
across every AI-Forge session): report precisely, let Dave decide. In
priority order:

1. **Re-verify `checkpoint.ts` + `package.json`/`commander`** (§3). Cheapest,
   most urgent — closes the loop on whether Track A is actually done.
2. **Audio-intelligence scope** (§2). Does AI-Forge still need this? If yes,
   decide whether it's a new Track A `NodeType` or a deliberate revival of
   relevant Track B pieces. If no, formally declare Track B dead rather than
   leaving it as perpetually-excluded ambiguity.
3. **Where `PERSONAL_SYSTEMS_CONSTITUTION.md` lives** — new dedicated repo,
   or another home. Decide before more systems' READMEs need to point at it.
4. **When to start the music layer's Phase 3** (gig tracker) — the first
   concrete piece of code for that system, sized small per §4.
5. **Track B's formal status** — keep as documented EXPERIMENTAL
   indefinitely, or schedule a deliberate kill/integrate pass so the
   duplicate-interface landmines stop being a standing hazard for future
   sessions.

---

## 8. Quick File Index

| Looking for... | Check |
|---|---|
| Track A's real APIs | `src/types.ts`, `src/taskGraph/graph.ts`, `src/intelligence/graphBuilder.ts` |
| What's ACTIVE vs EXPERIMENTAL | `docs/architecture/HANDOVER_NEXT_SESSION.md` |
| The original drift story | `HANDOVER.md`, `ARCHITECTURE_DRIFT_REPORT.md`, `MIGRATION_PLAN.md` |
| Track B's own planning docs | `BUILD_SPEC_v1.md`, `ROADMAP_v1.md`, `AI-Forge_Architecture_Progress.md`, `RUNTIME_AUDIT.md`, `REPO_AUDIT.md` |
| Memory governance ADRs | `docs/adr/ADR-005` through `ADR-009`, `docs/SPRINT_011_DESIGN.md` |
| This session's AI-Forge fix work | `SESSION_HANDOVER.md`, `FIX_REPORT.md`, `ALL_CHANGES.diff` |
| Music layer plan | `dk_architecture.js` |
| Cross-system rules | `PERSONAL_SYSTEMS_CONSTITUTION.md` |

*v1 — June 2026*
