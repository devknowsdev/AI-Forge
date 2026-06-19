// Real Ollama executor — calls a local Ollama HTTP server.
// Falls back cleanly when the server is unreachable (router + CLI probe skip the tier).

import type { Executor, ExecutionResult, NodeType, TaskPacket } from "../types.js";
import { buildTaskPrompt, collectTargetFiles, patchFromFileResponse } from "./aiPrompt.js";

export const OLLAMA_CODER_MODEL = "qwen2.5-coder:7b";
export const OLLAMA_GENERAL_MODEL = "qwen3:9b";
export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

const CODING_NODE_TYPES: ReadonlySet<NodeType> = new Set(["ui", "backend", "tests"]);

export function selectModel(packet: TaskPacket, opts?: { coderModel?: string; generalModel?: string }): string {
  const coder = opts?.coderModel ?? process.env.OLLAMA_CODER_MODEL ?? OLLAMA_CODER_MODEL;
  const general = opts?.generalModel ?? process.env.OLLAMA_GENERAL_MODEL ?? OLLAMA_GENERAL_MODEL;
  return CODING_NODE_TYPES.has(packet.node_type) ? coder : general;
}

export function ollamaHost(): string {
  return (process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST).replace(/\/$/, "");
}

export async function probeOllama(host = ollamaHost()): Promise<{ available: boolean; reason?: string }> {
  try {
    const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { available: false, reason: `Ollama responded ${response.status}` };
    return { available: true };
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}

export class OllamaExecutor implements Executor {
  readonly name = "ollama" as const;

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const start = Date.now();
    const host = ollamaHost();
    const model = selectModel(packet);
    const requestedFiles = collectTargetFiles(packet);
    const prompt = buildTaskPrompt(packet, requestedFiles);

    try {
      const response = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
        }),
        signal: AbortSignal.timeout(300_000),
      });

      if (!response.ok) {
        const text = await response.text();
        return fail(start, `Ollama error ${response.status}: ${text.slice(0, 300)}`);
      }

      const data = (await response.json()) as {
        message?: { content?: string };
        eval_count?: number;
        prompt_eval_count?: number;
      };
      const outputText = data.message?.content ?? "";
      const tokensIn = data.prompt_eval_count ?? estimateTokens(prompt);
      const tokensOut = data.eval_count ?? estimateTokens(outputText);

      if (requestedFiles.length === 0) {
        return {
          success: true,
          output: outputText,
          provider: "ollama",
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
          provider: "ollama",
          tokensIn,
          tokensOut,
          cost: 0,
          latencyMs: Date.now() - start,
          error: `ollama ${fileResult.error}`,
          patch: fileResult.patch,
        };
      }

      return {
        success: true,
        output: outputText,
        provider: "ollama",
        tokensIn,
        tokensOut,
        cost: 0,
        latencyMs: Date.now() - start,
        patch: fileResult.patch,
      };
    } catch (err) {
      return fail(start, `Ollama call failed: ${(err as Error).message}`);
    }
  }
}

function fail(start: number, error: string): ExecutionResult {
  return {
    success: false,
    output: "",
    provider: "ollama",
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
