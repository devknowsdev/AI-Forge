// Provider availability probing — used by the CLI at startup to skip dead tiers.

import type { ExecutorName } from "../types.js";
import { probeClaude } from "../executors/claude.js";
import { probeFreeTier } from "../executors/freeTier.js";
import { probeGpt } from "../executors/gpt.js";
import { probeOllama } from "../executors/ollama.js";

export interface ProviderStatus {
  provider: ExecutorName;
  available: boolean;
  reason?: string;
}

export async function probeAllProviders(): Promise<ProviderStatus[]> {
  const [ollama, freeTier, gpt, claude] = await Promise.all([
    probeOllama(),
    Promise.resolve(probeFreeTier()),
    Promise.resolve(probeGpt()),
    Promise.resolve(probeClaude()),
  ]);

  return [
    { provider: "ollama", ...ollama },
    { provider: "free_tier", ...freeTier },
    { provider: "gpt", ...gpt },
    { provider: "claude", ...claude },
    { provider: "terminal", available: true },
  ];
}

/** Mark unavailable AI tiers as budget-exhausted so routing skips them cleanly. */
export function applyProviderProbe(engine: { ledger: { setBudget: (p: ExecutorName, b: { rpmLimit: number }) => void } }, statuses: ProviderStatus[]): void {
  for (const status of statuses) {
    if (status.provider === "terminal") continue;
    if (!status.available) {
      engine.ledger.setBudget(status.provider, { rpmLimit: 0 });
    }
  }
}
