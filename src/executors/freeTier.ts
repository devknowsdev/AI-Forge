// Real free-tier executor — Google Gemini (AI Studio free tier).
// Submitted prompts may be used for model training per 00's data-boundary disclosure.

import type { Executor, ExecutionResult, TaskPacket } from "../types.js";
import { buildTaskPrompt, collectTargetFiles, patchFromFileResponse } from "./aiPrompt.js";

const DEFAULT_MODEL = "gemini-2.0-flash";

export function geminiModel(): string {
  return process.env.GEMINI_MODEL ?? process.env.GOOGLE_GEMINI_MODEL ?? DEFAULT_MODEL;
}

export function geminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

export function probeFreeTier(): { available: boolean; reason?: string } {
  if (!geminiApiKey()?.trim()) {
    return { available: false, reason: "GEMINI_API_KEY (or GOOGLE_API_KEY) not set" };
  }
  return { available: true };
}

export class FreeTierExecutor implements Executor {
  readonly name = "free_tier" as const;

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const start = Date.now();
    const apiKey = geminiApiKey();
    const requestedFiles = collectTargetFiles(packet);

    if (!apiKey) {
      return fail(start, "GEMINI_API_KEY not set — cannot make a real free-tier call");
    }

    try {
      const prompt = buildTaskPrompt(packet, requestedFiles);
      const model = geminiModel();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
        signal: AbortSignal.timeout(300_000),
      });

      if (!response.ok) {
        const text = await response.text();
        return fail(start, `free_tier API error ${response.status}: ${text.slice(0, 300)}`);
      }

      const data = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const outputText =
        data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("\n") ?? "";
      const tokensIn = data.usageMetadata?.promptTokenCount ?? estimateTokens(prompt);
      const tokensOut = data.usageMetadata?.candidatesTokenCount ?? estimateTokens(outputText);

      if (requestedFiles.length === 0) {
        return {
          success: true,
          output: outputText,
          provider: "free_tier",
          tokensIn,
          tokensOut,
          cost: 0,
          latencyMs: Date.now() - start,
        };
      }

      const fileResult = patchFromFileResponse(outputText, requestedFiles);
      if (fileResult.error) {
        return {
          success: false,
          output: outputText,
          provider: "free_tier",
          tokensIn,
          tokensOut,
          cost: 0,
          latencyMs: Date.now() - start,
          error: `free_tier ${fileResult.error}`,
          patch: fileResult.patch,
        };
      }

      return {
        success: true,
        output: outputText,
        provider: "free_tier",
        tokensIn,
        tokensOut,
        cost: 0,
        latencyMs: Date.now() - start,
        patch: fileResult.patch,
      };
    } catch (err) {
      return fail(start, `free_tier call failed: ${(err as Error).message}`);
    }
  }
}

function fail(start: number, error: string): ExecutionResult {
  return {
    success: false,
    output: "",
    provider: "free_tier",
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
