// src/executors/terminal.ts
//
// REAL — actually runs a shell command. "terminal (direct shell execution —
// not AI-routed; a task-graph node of type 'terminal' goes straight here,
// bypassing tier selection)" — 03_ROUTING_ENGINE.md. The Router still
// returns 'terminal' for these nodes (see router.ts) purely as a uniform
// decision record for logging; no ledger check or tier chain applies.
//
// Safety note: the command must be supplied explicitly via
// packet.context.command. We deliberately do NOT fall back to treating
// `intent` (free text meant for humans/AI) as a shell command — that would
// silently turn a description into code execution.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Executor, ExecutionResult, TaskPacket } from "../types.js";

const execFileAsync = promisify(execFile);

export class TerminalExecutor implements Executor {
  readonly name = "terminal" as const;

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const start = Date.now();
    const command = packet.context.command as string | undefined;

    if (!command) {
      return {
        success: false,
        output: "",
        provider: "terminal",
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        latencyMs: Date.now() - start,
        error: "terminal node requires packet.context.command (string)",
      };
    }

    const cwd = (packet.context.cwd as string | undefined) ?? process.cwd();
    try {
      const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], {
        cwd,
        timeout: (packet.context.timeoutMs as number | undefined) ?? 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        success: true,
        output: stdout || stderr,
        provider: "terminal",
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false,
        output: err.stdout ?? "",
        provider: "terminal",
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        latencyMs: Date.now() - start,
        error: `command failed: ${err.message}`,
      };
    }
  }
}
