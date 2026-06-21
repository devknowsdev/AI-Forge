# Personal Systems Constitution

Dave Knowles — Local-First Tooling Ecosystem
Governs: AI-Forge, EPK, ADHDashboard, the music management layer, and any future
local-first system built on this laptop.

## 0. Purpose & Scope

This document exists so that systems built independently, in separate sessions,
by different AI assistants, stay complementary instead of drifting into
duplication or working against each other.

What this is **not**: a shared codebase, a framework, or a runtime. No system
is required to import another system's code. A system is "constitutional" if
it follows the principles below — not if it links to anything.

**Before starting any new system**, check §1. If an existing system already
owns the relevant data or workflow, extend that system's data file — don't
start a new one.

**When a design decision conflicts with this document**, record why in that
project's own README/ADR rather than silently drifting. That's how AI-Forge's
own ADR folder already works — this document follows the same convention.

---

## 1. System Registry

| System | Purpose | Stack | Status |
|---|---|---|---|
| AI-Forge | Local-first AI orchestration for coding, file, and audio tasks | TS/Node, `node:sqlite`, git-as-safety-trail | Active, stabilizing (Sprint 011) |
| EPK | Public-facing living press kit, audience-aware modes | Vanilla JS, Cloudflare Pages, GitHub-publish admin panel | Live |
| ADHDashboard | Personal productivity tool, widget-based | Vanilla HTML/JS/CSS, localStorage + IndexedDB | Active dev (v43+) |
| Music Management Layer | Gig/booking/social/business orchestration for music career | TBD — own engine, governed by §2 | Planning |

---

## 2. Core Principles

Inherited from AI-Forge's existing `SYSTEM_PRINCIPLES.md` and
`REFERENCE_ARCHITECTURE_LOCAL_AI.md`, generalized to cover every system —
plus patterns that already showed up independently across all three real
codebases, which is the actual evidence this constitution is built on:

1. **Local-first by default.** Nothing leaves the machine unless a task
   genuinely needs a remote model or API, and the data boundary is visible
   when it does (AI-Forge's `local` / `remote_no_training` / `remote_may_train`
   classification is the right shape for any system that calls out).

2. **Own your data.** Canonical state lives in JSON or SQLite, in a repo you
   control — never solely inside a vendor platform. Same rule, three
   expressions already in use: EPK's `epk.json`, the planned `gigs.json`,
   AI-Forge's "Ledger Is Canonical Memory" (ADR-005).

3. **Minimalism.** No framework, dependency, or abstraction layer unless it
   earns its place. Vanilla JS in EPK and ADHDashboard; AI-Forge runs via
   `tsx`/`tsc` directly, no bundler. A new system should default to the same
   restraint, not the heaviest tool available.

4. **Cost-aware, tiered AI usage.** Cheapest capable tier first — local
   Ollama, then free tier, then paid — gated by an explicit budget check,
   never assumed.

5. **A human approves before anything externally visible or irreversible
   happens** — posting, sending, publishing, deleting. Stated in AI-Forge's
   ADR-0011 *and* in the music plan's "AI never posts without approval."
   Worth being honest that this is currently **policy in both, not a
   code-enforced gate in either** — don't treat it as solved just because two
   plans agree on it.

6. **Explicit over implicit.** Mock vs. real behavior is always a visible
   flag (`AI_FORGE_MOCK_EXECUTORS=1`, not a hidden branch). Gaps are named in
   the README rather than papered over. Non-trivial decisions get a record —
   AI-Forge's ADR folder for systems complex enough to need it; a short
   "Decisions" section in the README for ones that aren't (see §6).

7. **Each system owns its own mutation/safety model.** Don't borrow a
   sibling system's safety mechanism wholesale. Code edits are
   git-checkpointable and revertible; a social post or a sent email is not.
   A system's safety model has to match the actual shape of what it mutates.

---

## 3. Shared Resource Map

The part that actually prevents systems from working against each other:
name the real shared constraints once, here, instead of each system silently
assuming it has the machine to itself.

| Resource | Shared by | Contention risk | Current rule |
|---|---|---|---|
| Local Ollama server (one instance, M1/16GB) | AI-Forge today; music layer if it goes local-model | **Real.** Concurrent calls needing different models thrash the machine — the documented reason `LocalModelLock` exists in AI-Forge. But that lock is an in-process `AsyncMutex` — it does **not** protect against a second OS process calling Ollama directly. | Don't run two systems' heavy local-model batches at once. Escalate per §5 only if this becomes a felt problem. |
| Claude/GPT API budget | Any system doing AI drafting | Low — visible per-provider in each system's own ledger or the Anthropic console | Keep separate per system for now. Combine into one ledger only if you actually want a single "total AI spend" number. |
| GitHub account + Cloudflare Pages | EPK (live), AI-Forge, future music layer | None — accounts and Pages projects are free to multiply | One repo per system. Don't merge repos "to save setup." |
| This laptop's RAM/CPU | Everything | Moderate, mostly during local-model inference | No daemon runs "always on and heavy" without a stated reason (Principle 3). |

---

## 4. What's Shared vs. What's Not

**Shared freely** (copy or reference across systems):
- This constitution and its principles
- The mock/real flag pattern — one explicit env var or config flag per system
- JSON-as-canonical-state-in-git
- The GitHub-PAT-publish-from-admin-page pattern (EPK's `admin.html` →
  directly reusable for any future "edit data, publish via GitHub API" admin UI)
- The "modes" pattern — one dataset, audience-tailored views via a query
  param (EPK's `?for=booker`) — directly applicable to a press/booker view
  of gig or release data later

**Not shared, on purpose:**
- Runtime code / cross-imports between systems
- AI-Forge's `NodeType` vocabulary, `TaskGraph`, or git checkpoint/rollback
  safety model — wrong shape for anything whose actions aren't revertible
  file writes
- A single "universal" router or complexity classifier — each domain's
  complexity signal is different; don't force one `classifyComplexity()` to
  serve two domains

---

## 5. Escalation Path

Default to **not** sharing code. Promote something from convention to actual
shared infrastructure only when a problem has occurred — not speculatively:

1. **First occurrence** of a problem → note it here, in §3, as a named risk.
2. **Second occurrence** (it actually bit you) → build the smallest
   standalone fix, isolated and single-purpose (e.g. a tiny local Ollama
   gateway daemon, if cross-process contention becomes real).
3. **Never extend an existing ACTIVE system's core vocabulary** to absorb a
   new domain. A new domain gets a new small system, governed by §2 — not a
   feature branch of an old one.

---

## 6. Folder & Naming Conventions

- `ALL_CAPS_WITH_UNDERSCORES.md` for governance docs — matches the existing
  AI-Forge convention (`README.md`, `HANDOVER.md`, this file).
- ADRs only once a system is complex enough to need them. AI-Forge: yes.
  EPK / ADHDashboard / an early-stage music layer: a short "Decisions"
  section in the README is enough until proven otherwise.
- Every system's README states, in its first paragraph: what it is, what it
  explicitly is not, and what's real vs. mocked/planned.

---

## 7. Review

This document changes by addition, not silent rewrite — the same convention
as AI-Forge's ADR folder (numbered, dated, never edited away). Revisit it
whenever starting a new system, or when §3's risk list needs an update.

*v1 — June 2026*
