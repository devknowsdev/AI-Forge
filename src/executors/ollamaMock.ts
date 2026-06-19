// Mock Ollama executor — used in tests and when AI_FORGE_MOCK_EXECUTORS=1.

import type { Executor, ExecutionResult, TaskPacket } from "../types.js";
import { mockPatchFor } from "./mockPatch.js";
import { selectModel } from "./ollama.js";

export class OllamaMockExecutor implements Executor {
  readonly name = "ollama" as const;

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const start = Date.now();
    const model = selectModel(packet);
    await sleep(40 + Math.random() * 60);

    if (packet.context.simulateFailure === "ollama") {
      return {
        success: false,
        output: "",
        provider: "ollama",
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        latencyMs: Date.now() - start,
        error: "simulated local model failure",
      };
    }

    const output = `[ollama:mock:${model}] handled "${packet.intent}" (${packet.node_type})`;
    return {
      success: true,
      output,
      provider: "ollama",
      tokensIn: estimateTokens(packet.intent),
      tokensOut: estimateTokens(output),
      cost: 0,
      latencyMs: Date.now() - start,
      patch: mockPatchFor(packet, "ollama"),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
