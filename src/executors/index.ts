// src/executors/index.ts
import type { Executor, ExecutorName } from "../types.js";
import { OllamaExecutor } from "./ollama.js";
import { OllamaMockExecutor } from "./ollamaMock.js";
import { FreeTierExecutor } from "./freeTier.js";
import { FreeTierMockExecutor } from "./freeTierMock.js";
import { GptExecutor } from "./gpt.js";
import { GptMockExecutor } from "./gptMock.js";
import { ClaudeExecutor } from "./claude.js";
import { TerminalExecutor } from "./terminal.js";

export interface ExecutorRegistryOptions {
  /** Use deterministic mock executors (tests). Defaults to AI_FORGE_MOCK_EXECUTORS=1. */
  mock?: boolean;
}

export function shouldUseMockExecutors(opts?: ExecutorRegistryOptions): boolean {
  if (opts?.mock !== undefined) return opts.mock;
  return process.env.AI_FORGE_MOCK_EXECUTORS === "1";
}

export function buildExecutorRegistry(opts?: ExecutorRegistryOptions): Record<ExecutorName, Executor> {
  if (shouldUseMockExecutors(opts)) {
    return {
      ollama: new OllamaMockExecutor(),
      free_tier: new FreeTierMockExecutor(),
      gpt: new GptMockExecutor(),
      claude: new ClaudeExecutor(),
      terminal: new TerminalExecutor(),
    };
  }
  return {
    ollama: new OllamaExecutor(),
    free_tier: new FreeTierExecutor(),
    gpt: new GptExecutor(),
    claude: new ClaudeExecutor(),
    terminal: new TerminalExecutor(),
  };
}

export {
  OllamaExecutor,
  OllamaMockExecutor,
  FreeTierExecutor,
  FreeTierMockExecutor,
  GptExecutor,
  GptMockExecutor,
  ClaudeExecutor,
  TerminalExecutor,
};
