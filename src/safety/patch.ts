// src/safety/patch.ts
//
// "diff-based patching" — 07_SAFETY_SYSTEM.md, listed as its own component
// alongside checkpoint/rollback/validation. See the Patch/FileEdit
// docblock in types.ts for why this is full-file-write edits rather than
// unified-diff hunks.
//
// applyPatch() is intentionally dumb: it just writes files (creating parent
// directories as needed) or deletes them. All the actual safety — "is this
// allowed to stick" — comes from what happens AFTER this call in the
// Execution Engine: checkpoint, then validate, then commit-or-revert. This
// function has no opinion about whether the write should be kept; it just
// makes the proposed state real so the rest of the pipeline can judge it.

import fs from "node:fs";
import path from "node:path";
import type { FileEdit, Patch } from "../types.js";

export interface ApplyPatchResult {
  written: string[];
  deleted: string[];
}

/**
 * Parses blocks of the form:
 *   FILE: path/to/file.ts
 *   ```
 *   <content>
 *   ```
 * out of a model's free-text response. Used by the Claude executor (and any
 * future real executor) to turn "please write these files" into a Patch.
 * Write-only by design — asking a model to express deletions in free text
 * is a much easier way to accidentally lose files than to gain the
 * capability is worth right now; deletions would need a more deliberate,
 * structured mechanism if/when they're needed.
 */
export function parseFileBlocks(text: string): FileEdit[] {
  const edits: FileEdit[] = [];
  const pattern = /FILE:\s*(.+?)\r?\n```[a-zA-Z0-9]*\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    edits.push({ path: match[1].trim(), op: "write", content: match[2] });
  }
  return edits;
}

export function applyPatch(workDir: string, patch: Patch): ApplyPatchResult {
  const written: string[] = [];
  const deleted: string[] = [];

  for (const edit of patch.edits) {
    const absPath = resolveWithinWorkDir(workDir, edit.path);

    if (edit.op === "delete") {
      if (fs.existsSync(absPath)) fs.rmSync(absPath);
      deleted.push(edit.path);
      continue;
    }

    if (edit.content === undefined) {
      throw new Error(`FileEdit for "${edit.path}" has op "write" but no content`);
    }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, edit.content, "utf-8");
    written.push(edit.path);
  }

  return { written, deleted };
}

/** Reject any edit path that would escape workDir (e.g. "../../etc/passwd") —
 *  a patch's paths come from AI output, real or mocked, and shouldn't be
 *  trusted as already-safe. */
function resolveWithinWorkDir(workDir: string, relativePath: string): string {
  const resolved = path.resolve(workDir, relativePath);
  const normalizedWorkDir = path.resolve(workDir);
  if (!resolved.startsWith(normalizedWorkDir + path.sep) && resolved !== normalizedWorkDir) {
    throw new Error(`Patch path "${relativePath}" escapes the workspace directory`);
  }
  return resolved;
}
