// src/memory/ledger.ts
//
// "Before each hop, the router checks the Memory cost/quota ledger (06). If a
// tier's RPM/RPD or $ budget is exhausted, skip to the next tier rather than
// failing the node." — 03_ROUTING_ENGINE.md
//
// Resets are lazy: we don't run a background timer, we just check whether
// now() is past the stored reset timestamp the next time the provider is
// consulted, and roll the window forward then. This is correct for a
// single-process engine and avoids a scheduler dependency.

import type { MemoryDB } from "./db.js";
import type { ExecutorName } from "../types.js";

export interface ProviderBudget {
  rpmLimit?: number;
  rpdLimit?: number;
  dollarBudget?: number;
}

/** Sensible MVP defaults. Override per-deployment via Ledger.configure(). */
const DEFAULT_BUDGETS: Record<ExecutorName, ProviderBudget> = {
  ollama: {}, // local — no rate/cost ceiling
  // Calibrated against Gemini API's Flash free tier (the most commonly-cited
  // concrete "free_tier" provider per 00/03), verified 2026-06-18: 15 RPM,
  // 1,500 RPD. Source: ai.google.dev/gemini-api/docs/rate-limits, corroborated
  // by multiple third-party trackers. Free-tier numbers genuinely vary by
  // provider and Google revises them without much notice (reported a
  // 50-80% cut in Dec 2025) — re-verify before this matters for a real
  // budget, and treat this as Gemini-shaped, not a guarantee for Groq/
  // OpenRouter if either ends up being the real provider wired in instead.
  free_tier: { rpmLimit: 15, rpdLimit: 1500 },
  gpt: { dollarBudget: 5 },
  claude: { dollarBudget: 5 },
  terminal: {}, // not AI-routed, no ledger entry needed
};

export interface LedgerCheck {
  allowed: boolean;
  reason?: string;
}

export class Ledger {
  constructor(private memory: MemoryDB) {
    this.ensureRows();
  }

  private ensureRows(): void {
    const now = new Date().toISOString();
    const insert = this.memory.db.prepare(`
      INSERT OR IGNORE INTO cost_quota_ledger
        (provider, rpm_limit, rpm_reset_at, rpd_limit, rpd_reset_at, dollar_budget, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [provider, budget] of Object.entries(DEFAULT_BUDGETS)) {
      insert.run(
        provider,
        budget.rpmLimit ?? null,
        nextMinuteBoundary(),
        budget.rpdLimit ?? null,
        nextDayBoundary(),
        budget.dollarBudget ?? null,
        now
      );
    }
  }

  /** Roll RPM/RPD windows forward if their reset time has passed. */
  private rollWindows(provider: ExecutorName): void {
    const row = this.memory.db
      .prepare(`SELECT * FROM cost_quota_ledger WHERE provider = ?`)
      .get(provider) as Record<string, any> | undefined;
    if (!row) return;
    const now = Date.now();
    const updates: string[] = [];
    const params: any[] = [];

    if (row.rpm_reset_at && new Date(row.rpm_reset_at).getTime() <= now) {
      updates.push("rpm_used = 0", "rpm_reset_at = ?");
      params.push(nextMinuteBoundary());
    }
    if (row.rpd_reset_at && new Date(row.rpd_reset_at).getTime() <= now) {
      updates.push("rpd_used = 0", "rpd_reset_at = ?");
      params.push(nextDayBoundary());
    }
    if (updates.length === 0) return;
    this.memory.db
      .prepare(`UPDATE cost_quota_ledger SET ${updates.join(", ")} WHERE provider = ?`)
      .run(...params, provider);
  }

  /** Can this provider take one more call right now, within budget? Providers
   *  with no configured limit (null columns) are always allowed — that's how
   *  ollama gets "no rate limit" by default, via data, not a special case. */
  check(provider: ExecutorName): LedgerCheck {
    if (provider === "terminal") return { allowed: true }; // not AI-routed, never consulted in practice
    this.rollWindows(provider);
    const row = this.memory.db
      .prepare(`SELECT * FROM cost_quota_ledger WHERE provider = ?`)
      .get(provider) as Record<string, any> | undefined;
    if (!row) return { allowed: true };

    if (row.rpm_limit != null && row.rpm_used >= row.rpm_limit) {
      return { allowed: false, reason: `${provider}: RPM budget exhausted (${row.rpm_used}/${row.rpm_limit})` };
    }
    if (row.rpd_limit != null && row.rpd_used >= row.rpd_limit) {
      return { allowed: false, reason: `${provider}: RPD budget exhausted (${row.rpd_used}/${row.rpd_limit})` };
    }
    if (row.dollar_budget != null && row.dollar_used >= row.dollar_budget) {
      return { allowed: false, reason: `${provider}: $ budget exhausted ($${row.dollar_used.toFixed(2)}/$${row.dollar_budget})` };
    }
    return { allowed: true };
  }

  /** Record actual usage after a call completes (success or failure — quota is still spent). */
  recordUsage(provider: ExecutorName, opts: { cost: number }): void {
    if (provider === "terminal") return;
    this.memory.db
      .prepare(`
        UPDATE cost_quota_ledger
        SET rpm_used = rpm_used + 1,
            rpd_used = rpd_used + 1,
            dollar_used = dollar_used + ?,
            updated_at = datetime('now')
        WHERE provider = ?
      `)
      .run(opts.cost, provider);
  }

  snapshot(): Record<string, any>[] {
    return this.memory.db.prepare(`SELECT * FROM cost_quota_ledger`).all() as Record<string, any>[];
  }

  /** Override a provider's budget at runtime (e.g. modeling a constrained local
   *  Ollama instance, or a deployment with different free-tier caps). Pass
   *  `null` to clear a ceiling (unlimited). Does not reset usage already accrued
   *  in the current window. */
  setBudget(provider: ExecutorName, budget: Partial<{ rpmLimit: number | null; rpdLimit: number | null; dollarBudget: number | null }>): void {
    const sets: string[] = [];
    const params: any[] = [];
    if ("rpmLimit" in budget) {
      sets.push("rpm_limit = ?");
      params.push(budget.rpmLimit);
    }
    if ("rpdLimit" in budget) {
      sets.push("rpd_limit = ?");
      params.push(budget.rpdLimit);
    }
    if ("dollarBudget" in budget) {
      sets.push("dollar_budget = ?");
      params.push(budget.dollarBudget);
    }
    if (sets.length === 0) return;
    this.memory.db
      .prepare(`UPDATE cost_quota_ledger SET ${sets.join(", ")}, updated_at = datetime('now') WHERE provider = ?`)
      .run(...params, provider);
  }
}

function nextMinuteBoundary(): string {
  return new Date(Date.now() + 60_000).toISOString();
}
function nextDayBoundary(): string {
  return new Date(Date.now() + 86_400_000).toISOString();
}
