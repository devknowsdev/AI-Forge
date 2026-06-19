// Mock GPT executor — used in tests and when AI_FORGE_MOCK_EXECUTORS=1.

import type { Executor, ExecutionResult, TaskPacket } from "../types.js";
import { mockPatchFor } from "./mockPatch.js";

const GPT_COST_PER_1K_INPUT = 0.0025;
const GPT_COST_PER_1K_OUTPUT = 0.015;

export class GptMockExecutor implements Executor {
  readonly name = "gpt" as const;

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const start = Date.now();
    await sleep(300 + Math.random() * 300);

    if (packet.context.simulateFailure === "gpt") {
      return {
        success: false,
        output: "",
        provider: "gpt",
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        latencyMs: Date.now() - start,
        error: "simulated gpt failure",
      };
    }

    const output = `[gpt:mock] handled "${packet.intent}" (${packet.node_type})`;
    const tokensIn = estimateTokens(packet.intent);
    const tokensOut = estimateTokens(output);
    return {
      success: true,
      output,
      provider: "gpt",
      tokensIn,
      tokensOut,
      cost: (tokensIn / 1000) * GPT_COST_PER_1K_INPUT + (tokensOut / 1000) * GPT_COST_PER_1K_OUTPUT,
      latencyMs: Date.now() - start,
      patch: mockPatchFor(packet, "gpt"),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
