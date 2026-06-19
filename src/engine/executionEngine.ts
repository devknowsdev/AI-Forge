// src/engine/executionEngine.ts
//
// Canonical node lifecycle (01_ARCHITECTURE.md / 05_EXECUTION_ENGINE.md /
// 12_FINAL_SYSTEM_SPEC.md)

import type { ExecutionMode, ExecutionResult, ExecutorName, NodeOutcome, TaskPacket } from "../types.js";
import { dataBoundaryFor } from "../types.js";
import { MemoryDB } from "../memory/db.js";
import { Ledger } from "../memory/ledger.js";
import { PatternCache } from "../memory/patternCache.js";
import { TaskHistory } from "../memory/taskHistory.js";
import { LearningLoop } from "../intelligence/learningLoop.js";
import { Router } from "../routing/router.js";
import { buildExecutorRegistry } from "../executors/index.js";
import { TaskGraph } from "../taskGraph/graph.js";
import { CheckpointManager } from "../safety/checkpoint.js";
import { validate } from "../safety/validation.js";
import { applyPatch } from "../safety/patch.js";
import { FileLockManager } from "./fileLock.js";
import { LocalModelLock } from "./modelLock.js";
import { selectModel as selectOllamaModel } from "../executors/ollama.js";
import { ControlSurface } from "../core/ControlSurface.js";
import { TaskGraphContract } from "../taskGraph/graphContract.js";

export interface EngineOptions {
  dbPath: string;
  workDir: string;
  ollamaSwapDelayMs?: number;
  mockExecutors?: boolean;
  fallbackOnFailure?: boolean;
}

export interface NodeRunLog {
  nodeId: string;
  status: "success" | "failed";
  provider: ExecutorName;
  cacheHit: boolean;
  cost: number;
  latencyMs: number;
  error?: string;
  ledgerChainTried?: { provider: ExecutorName; allowed: boolean; reason?: string }[];
}

export class ExecutionEngine {
  readonly memory: MemoryDB;
  readonly ledger: Ledger;
  readonly patternCache: PatternCache;
  readonly taskHistory: TaskHistory;
  readonly learningLoop: LearningLoop;
  readonly router: Router;
  readonly checkpoints: CheckpointManager;
  readonly modelLock: LocalModelLock;

  private executors = buildExecutorRegistry();
  private fileLocks = new FileLockManager();
  private workDir: string;
  private fallbackOnFailure: boolean;
  private control: ControlSurface;
  private contract: TaskGraphContract;

  constructor(opts: EngineOptions) {
    this.workDir = opts.workDir;
    this.fallbackOnFailure = opts.fallbackOnFailure ?? false;

    this.memory = new MemoryDB(opts.dbPath);
    this.ledger = new Ledger(this.memory);
    this.patternCache = new PatternCache(this.memory);
    this.taskHistory = new TaskHistory(this.memory);
    this.learningLoop = new LearningLoop(this.memory);
    this.router = new Router(this.ledger, this.learningLoop);
    this.checkpoints = new CheckpointManager(this.workDir);
    this.modelLock = new LocalModelLock(opts.ollamaSwapDelayMs);
    this.executors = buildExecutorRegistry({ mock: opts.mockExecutors });

    this.control = new ControlSurface();
    this.contract = new TaskGraphContract();
  }

  async init(): Promise<void> {
    await this.checkpoints.init();
  }

  async run(graph: TaskGraph, mode: ExecutionMode = "sequential"): Promise<NodeRunLog[]> {
    const logs: NodeRunLog[] = [];

    this.control.validate(graph);
    this.contract.validate(graph);
    const frozenGraph = this.control.begin(graph);

    if (mode === "sequential") {
      while (!frozenGraph.isSettled()) {
        const ready = frozenGraph.readyNodeIds();
        if (ready.length === 0) break;
        logs.push(await this.runNode(frozenGraph, ready[0]));
      }
    } else {
      while (!frozenGraph.isSettled()) {
        const ready = frozenGraph.readyNodeIds();
        if (ready.length === 0) break;
        const batch = await Promise.all(ready.map((id) => this.runNode(frozenGraph, id)));
        logs.push(...batch);
      }
    }

    this.control.end();
    return logs;
  }

  private async runNode(graph: TaskGraph, nodeId: string): Promise<NodeRunLog> {
    const node = graph.get(nodeId);
    graph.setStatus(nodeId, "running");
    const packet = node.packet;

    const release = await this.fileLocks.acquire(packet.filePaths);
    try {
      let result: ExecutionResult;
      let chainTried: NodeRunLog["ledgerChainTried"];

      const cacheable = packet.node_type !== "terminal";
      const cacheLookup = cacheable ? this.patternCache.get(packet) : { hit: false as const };

      if (cacheLookup.hit) {
        result = {
          success: true,
          output: cacheLookup.output!,
          provider: cacheLookup.originProvider!,
          tokensIn: cacheLookup.originTokensIn ?? 0,
          tokensOut: cacheLookup.originTokensOut ?? 0,
          cost: 0,
          latencyMs: 0,
          cacheHit: true,
          patch: cacheLookup.originPatch,
        };
      } else {
        let decision = this.router.route(packet);
        chainTried = decision.chainTried;

        if (!decision.executor) {
          result = {
            success: false,
            output: "",
            provider: "ollama",
            tokensIn: 0,
            tokensOut: 0,
            cost: 0,
            latencyMs: 0,
            error: `no executor within budget; tried: ${JSON.stringify(decision.chainTried)}`,
          };
        } else {
          const tried: ExecutorName[] = [];
          result = await this.executeViaRoute(packet, decision.executor);

          while (!result.success && this.fallbackOnFailure && decision.executor) {
            tried.push(decision.executor);
            decision = this.router.route(packet, tried);
            chainTried = [...(chainTried ?? []), ...decision.chainTried];
            if (!decision.executor) break;
            const retry = await this.executeViaRoute(packet, decision.executor);
            result = {
              ...retry,
              error: result.error ? `${result.error}; then ${retry.error ?? "failed"}` : retry.error,
            };
          }

          this.ledger.recordUsage(result.provider, { cost: result.cost });
        }
      }

      if (result.patch) {
        try {
          applyPatch(this.workDir, result.patch);
        } catch (err) {
          result = { ...result, success: false, error: `patch application failed: ${(err as Error).message}` };
        }
      }

      await this.checkpoints.checkpoint(nodeId, result.patch?.edits.map((e) => e.path));
      const validation = result.cacheHit ? { passed: true } : await validate(packet, result, this.workDir);

      if (validation.passed) {
        graph.setStatus(nodeId, "success");
        node.result = result;

        if (!result.cacheHit) {
          this.patternCache.set(packet, result.output, result.provider, result.tokensIn, result.tokensOut, result.patch);
        }
      } else {
        await this.checkpoints.rollback(nodeId);
        result = { ...result, success: false, error: result.error ?? validation.reason };
        node.result = result;
        graph.markFailed(nodeId);
      }

      const outcome: NodeOutcome = {
        projectId: graph.projectId,
        graphId: graph.id,
        nodeId,
        nodeType: packet.node_type,
        intent: packet.intent,
        provider: result.provider,
        dataBoundary: dataBoundaryFor(result.provider),
        result,
      };

      this.taskHistory.recordOutcome(outcome);

      if (!result.cacheHit) {
        this.learningLoop.recordOutcome(outcome);
      }

      return {
        nodeId,
        status: result.success ? "success" : "failed",
        provider: result.provider,
        cacheHit: !!result.cacheHit,
        cost: result.cost,
        latencyMs: result.latencyMs,
        error: result.error,
        ledgerChainTried: chainTried,
      };
    } finally {
      release();
    }
  }

  close(): void {
    this.memory.close();
  }

  private async executeViaRoute(packet: TaskPacket, executor: ExecutorName): Promise<ExecutionResult> {
    const effectivePacket: TaskPacket =
      executor === "terminal"
        ? { ...packet, context: { ...packet.context, cwd: packet.context.cwd ?? this.workDir } }
        : packet;

    if (executor === "ollama") {
      return this.modelLock.run(selectOllamaModel(packet), () => this.executors.ollama.execute(effectivePacket));
    }
    return this.executors[executor].execute(effectivePacket);
  }
}
