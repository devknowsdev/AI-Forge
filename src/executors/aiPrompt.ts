// Shared prompt + file-target helpers for real AI executors.

import type { Patch, TaskPacket } from "../types.js";
import { parseFileBlocks } from "../safety/patch.js";

export function collectTargetFiles(packet: TaskPacket): string[] {
  const single = packet.context.targetFile;
  const many = packet.context.targetFiles;
  const targets: string[] = [];
  if (typeof single === "string") targets.push(single);
  if (Array.isArray(many)) targets.push(...many.filter((t): t is string => typeof t === "string"));
  return targets;
}

export function buildTaskPrompt(packet: TaskPacket, requestedFiles: string[]): string {
  const lines = [`Task type: ${packet.node_type}`, `Intent: ${packet.intent}`];
  if (packet.constraints.length) lines.push(`Constraints: ${packet.constraints.join("; ")}`);
  const context = { ...packet.context };
  delete context.targetFile;
  delete context.targetFiles;
  delete context.simulateFailure;
  delete context.cwd;
  delete context.command;
  delete context.validate;
  if (Object.keys(context).length) lines.push(`Context: ${JSON.stringify(context)}`);

  if (requestedFiles.length > 0) {
    lines.push(
      `Write the following file(s): ${requestedFiles.join(", ")}.`,
      "Respond with ONLY one block per file, exactly in this format, no other prose:",
      "FILE: <path>",
      "```",
      "<full file content>",
      "```"
    );
  } else {
    lines.push("Respond concisely with the result only.");
  }
  return lines.join("\n");
}

export function patchFromFileResponse(
  outputText: string,
  requestedFiles: string[]
): { patch?: Patch; missing: string[]; error?: string } {
  if (requestedFiles.length === 0) return { missing: [] };

  const edits = parseFileBlocks(outputText);
  const gotPaths = new Set(edits.map((e) => e.path));
  const missing = requestedFiles.filter((p) => !gotPaths.has(p));
  const patch = edits.length > 0 ? { edits } : undefined;

  if (missing.length > 0) {
    return {
      patch,
      missing,
      error: `did not produce requested file(s): ${missing.join(", ")}`,
    };
  }
  return { patch, missing: [] };
}
