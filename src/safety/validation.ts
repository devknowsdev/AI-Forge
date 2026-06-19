// src/safety/validation.ts
//
// "validation gates: automated only — build success + tests pass/fail. No
// human diff-review step by default, because the Wizard (02) shows no code
// to the user. Do not add a human-approval gate unless the Wizard's
// 'no code exposure' rule changes first." — 07_SAFETY_SYSTEM.md
//
// Two layers, both automated:
//   1. Did the executor itself report success? (ExecutionResult.success)
//   2. If the packet specifies a build/test command, does it actually pass?
// A node with no validate.buildCommand/testCommand is gated on (1) alone —
// that's the correct default for nodes with nothing to build/test (docs,
// pure analysis), not a loophole.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionResult, TaskPacket } from "../types.js";

const execFileAsync = promisify(execFile);

export interface ValidationOutcome {
  passed: boolean;
  reason?: string;
}

export interface ValidateSpec {
  buildCommand?: string;
  testCommand?: string;
}

export async function validate(packet: TaskPacket, result: ExecutionResult, workDir: string): Promise<ValidationOutcome> {
  if (!result.success) {
    return { passed: false, reason: result.error ?? "executor reported failure" };
  }

  const spec = packet.context.validate as ValidateSpec | undefined;
  if (!spec) return { passed: true };

  if (spec.buildCommand) {
    const buildOk = await runsClean(spec.buildCommand, workDir);
    if (!buildOk.passed) return { passed: false, reason: `build failed: ${buildOk.reason}` };
  }
  if (spec.testCommand) {
    const testOk = await runsClean(spec.testCommand, workDir);
    if (!testOk.passed) return { passed: false, reason: `tests failed: ${testOk.reason}` };
  }
  return { passed: true };
}

async function runsClean(command: string, cwd: string): Promise<ValidationOutcome> {
  try {
    await execFileAsync("/bin/sh", ["-c", command], { cwd, timeout: 60_000 });
    return { passed: true };
  } catch (err: any) {
    return { passed: false, reason: err.message };
  }
}
