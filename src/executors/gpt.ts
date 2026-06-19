// Real GPT executor — OpenAI Chat Completions API.

import type { Executor, ExecutionResult, TaskPacket } from "../types.js";
import { buildTaskPrompt, collectTargetFiles, patchFromFileResponse } from "./aiPrompt.js";

const DEFAULT_MODEL = "gpt-4.1-mini";
const COST_PER_1K_INPUT = 0.0025;
const COST_PER_1K_OUTPUT = 0.015;

export function gptModel(): string {
  return process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
}

export function probeGpt(): { available: boolean; reason?: string } {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    return { available: false, reason: "OPENAI_API_KEY not set" };
  }
  return { available: true };
}

export class GptExecutor implements Executor {
  readonly name = "gpt" as const;

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const start = Date.now();
    const apiKey = process.env.OPENAI_API_KEY;
    const requestedFiles = collectTargetFiles(packet);

    if (!apiKey) {
      return fail(start, "OPENAI_API_KEY not set — cannot make a real gpt call");
    }

    try {
      const prompt = buildTaskPrompt(packet, requestedFiles);
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: gptModel(),
          messages: [{ role: "user", content: prompt }],
          max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(300_000),
      });

      if (!response.ok) {
        const text = await response.text();
        return fail(start, `gpt API error ${response.status}: ${text.slice(0, 300)}`);
      }

      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const outputText = data.choices?.[0]?.message?.content ?? "";
      const tokensIn = data.usage?.prompt_tokens ?? estimateTokens(prompt);
      const tokensOut = data.usage?.completion_tokens ?? estimateTokens(outputText);
      const cost = (tokensIn / 1000) * COST_PER_1K_INPUT + (tokensOut / 1000) * COST_PER_1K_OUTPUT;

      if (requestedFiles.length === 0) {
        return { success: true, output: outputText, provider: "gpt", tokensIn, tokensOut, cost, latencyMs: Date.now() - start };
      }

      const fileResult = patchFromFileResponse(outputText, requestedFiles);
      if (fileResult.error) {
        return {
          success: false,
          output: outputText,
          provider: "gpt",
          tokensIn,
          tokensOut,
          cost,
          latencyMs: Date.now() - start,
          error: `gpt ${fileResult.error}`,
          patch: fileResult.patch,
        };
      }

      return {
        success: true,
        output: outputText,
        provider: "gpt",
        tokensIn,
        tokensOut,
        cost,
        latencyMs: Date.now() - start,
        patch: fileResult.patch,
      };
    } catch (err) {
      return fail(start, `gpt call failed: ${(err as Error).message}`);
    }
  }
}

function fail(start: number, error: string): ExecutionResult {
  return {
    success: false,
    output: "",
    provider: "gpt",
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    latencyMs: Date.now() - start,
    error,
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
