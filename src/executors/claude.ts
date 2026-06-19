// src/executors/claude.ts
//
// REAL executor — calls api.anthropic.com directly.

import type { Executor, ExecutionResult, TaskPacket } from "../types.js";
import { buildTaskPrompt, collectTargetFiles, patchFromFileResponse } from "./aiPrompt.js";

const MODEL = "claude-sonnet-4-6";
const COST_PER_1K_INPUT = 0.003;
const COST_PER_1K_OUTPUT = 0.015;

export function probeClaude(): { available: boolean; reason?: string } {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    return { available: false, reason: "ANTHROPIC_API_KEY not set" };
  }
  return { available: true };
}

export class ClaudeExecutor implements Executor {
  readonly name = "claude" as const;

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const start = Date.now();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const requestedFiles = collectTargetFiles(packet);

    if (!apiKey) {
      return fail(start, "ANTHROPIC_API_KEY not set — cannot make a real claude call");
    }

    try {
      const prompt = buildTaskPrompt(packet, requestedFiles);
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(300_000),
      });

      if (!response.ok) {
        const text = await response.text();
        return fail(start, `claude API error ${response.status}: ${text.slice(0, 300)}`);
      }

      const data = (await response.json()) as {
        content: { type: string; text?: string }[];
        usage?: { input_tokens: number; output_tokens: number };
      };
      const outputText = data.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n");
      const tokensIn = data.usage?.input_tokens ?? 0;
      const tokensOut = data.usage?.output_tokens ?? 0;
      const cost = (tokensIn / 1000) * COST_PER_1K_INPUT + (tokensOut / 1000) * COST_PER_1K_OUTPUT;

      if (requestedFiles.length === 0) {
        return { success: true, output: outputText, provider: "claude", tokensIn, tokensOut, cost, latencyMs: Date.now() - start };
      }

      const fileResult = patchFromFileResponse(outputText, requestedFiles);
      if (fileResult.error) {
        return {
          success: false,
          output: outputText,
          provider: "claude",
          tokensIn,
          tokensOut,
          cost,
          latencyMs: Date.now() - start,
          error: `claude ${fileResult.error}`,
          patch: fileResult.patch,
        };
      }

      return {
        success: true,
        output: outputText,
        provider: "claude",
        tokensIn,
        tokensOut,
        cost,
        latencyMs: Date.now() - start,
        patch: fileResult.patch,
      };
    } catch (err) {
      return fail(start, `claude call failed: ${(err as Error).message}`);
    }
  }
}

function fail(start: number, error: string): ExecutionResult {
  return {
    success: false,
    output: "",
    provider: "claude",
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    latencyMs: Date.now() - start,
    error,
  };
}
