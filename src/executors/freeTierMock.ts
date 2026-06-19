// Mock free-tier executor — used in tests and when AI_FORGE_MOCK_EXECUTORS=1.

import type { Executor, ExecutionResult, TaskPacket } from "../types.js";
import { mockPatchFor } from "./mockPatch.js";

export class FreeTierMockExecutor implements Executor {
  readonly name = "free_tier" as const;

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const start = Date.now();
    await sleep(150 + Math.random() * 150);

    if (packet.context.simulateFailure === "free_tier") {
      return {
        success: false,
        output: "",
        provider: "free_tier",
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        latencyMs: Date.now() - start,
        error: "simulated free-tier failure",
      };
    }

    const output = `[free_tier:mock] handled "${packet.intent}" (${packet.node_type})`;
    return {
      success: true,
      output,
      provider: "free_tier",
      tokensIn: estimateTokens(packet.intent),
      tokensOut: estimateTokens(output),
      cost: 0,
      latencyMs: Date.now() - start,
      patch: mockPatchFor(packet, "free_tier"),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
