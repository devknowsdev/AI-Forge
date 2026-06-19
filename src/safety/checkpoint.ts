// src/safety/checkpoint.ts
//
// "git checkpoint per node (not per whole task) — this granularity is what
// enables partial rollback." — 07_SAFETY_SYSTEM.md
//
// REAL git, not mocked: each node gets its own commit; rollback is
// `git revert <that commit's sha>`, not a hard reset to some earlier point
// in history. A hard reset would also undo any sibling commits made after
// this node's; a targeted revert only undoes this node's own diff.
//
// Two DIFFERENT concurrency concerns, easy to conflate, kept deliberately
// separate:
//   1. Content races — does node A's checkpoint ever revert over node B's
//      still-needed change? Prevented by the Execution Engine's file-level
//      locking (05): a node never runs concurrently with another node
//      touching the same paths, and never starts before its own
//      dependencies have already resolved to success. So a revert's target
//      commit can never have an unrelated sibling commit "underneath" it
//      that the revert would corrupt.
//   2. Mechanical races — two `git commit` calls hitting the same repo's
//      HEAD ref at the same instant. File-level locking does NOT prevent
//      this: two nodes with zero file-path overlap (e.g. one writing
//      config.json, one just generating docs with no filePaths at all) are
//      allowed to execute fully concurrently per 05, but they still share
//      one git repository with one HEAD ref. This was a real bug, not a
//      hypothetical: it surfaced as `fatal: cannot lock ref 'HEAD'` when
//      demoing two non-overlapping parallel nodes. Fixed below with an
//      internal FIFO queue (an `AsyncMutex`) so every git-mutating operation
//      this class performs — checkpoint, rollback — is serialized
//      regardless of file paths. This only serializes the (fast) git calls
//      themselves; the actual executor work for non-overlapping nodes still
//      runs fully concurrently, since the lock is acquired right before the
//      git commands and released right after.
//
// Per 04/07 (see taskGraph/graph.ts docblock): a failed node's direct
// dependents are marked 'blocked' but never executed, so they never get a
// checkpoint to revert in the first place. Rollback here is always exactly
// one commit.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { AsyncMutex } from "../engine/asyncMutex.js";

const execFileAsync = promisify(execFile);

export interface CheckpointResult {
  sha: string;
  hadChanges: boolean;
}

export class CheckpointManager {
  private shaByNode = new Map<string, string>();
  private gitLock = new AsyncMutex();

  constructor(private workDir: string) {}

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("git", args, { cwd: this.workDir, maxBuffer: 10 * 1024 * 1024 });
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.workDir)) fs.mkdirSync(this.workDir, { recursive: true });

    const resolved = path.resolve(this.workDir);
    const ownGit = fs.existsSync(path.join(resolved, ".git"));
    let isWorktreeRoot = false;
    if (!ownGit) {
      try {
        const { stdout } = await this.git(["rev-parse", "--show-toplevel"]);
        isWorktreeRoot = path.resolve(stdout.trim()) === resolved;
      } catch {
        isWorktreeRoot = false;
      }
    }

    if (!ownGit && !isWorktreeRoot) {
      await this.git(["init"]);
      await this.ensureLocalGitIdentity();
      await this.git(["commit", "--allow-empty", "-m", "init: ai-forge workspace"]);
      return;
    }

    await this.ensureLocalGitIdentity();
  }

  private async ensureLocalGitIdentity(): Promise<void> {
    try {
      await this.git(["config", "user.email"]);
    } catch {
      await this.git(["config", "user.email", "ai-forge@local"]);
      await this.git(["config", "user.name", "AI Forge Safety System"]);
    }
  }

  /** Commit the current working-tree state as this node's checkpoint.
   *  When `paths` is set, only those files are staged — avoids sweeping
   *  unrelated uncommitted work when operating inside an existing project repo.
   *  When omitted, stages whatever `git status` reports as changed (terminal
   *  side effects in an isolated workspace). When nothing changed, records a
   *  no-op checkpoint. */
  async checkpoint(nodeId: string, paths?: string[]): Promise<CheckpointResult> {
    return this.gitLock.run(async () => {
      let toStage = paths ?? [];
      if (toStage.length === 0) {
        toStage = await this.listChangedPaths();
      }
      if (toStage.length > 0) {
        for (const p of toStage) await this.git(["add", "--", p]);
      }
      const { stdout: status } = await this.git(["status", "--porcelain"]);
      const hadChanges = status.trim().length > 0;

      if (hadChanges) {
        await this.git(["commit", "-m", `checkpoint(node:${nodeId})`]);
      } else {
        // Still create a checkpoint marker so every node has a revertible sha,
        // even ones that didn't mutate files (e.g. a pure read/analysis node).
        await this.git(["commit", "--allow-empty", "-m", `checkpoint(node:${nodeId}) [no-op]`]);
      }
      const { stdout: sha } = await this.git(["rev-parse", "HEAD"]);
      const trimmedSha = sha.trim();
      this.shaByNode.set(nodeId, trimmedSha);
      return { sha: trimmedSha, hadChanges };
    });
  }

  getSha(nodeId: string): string | undefined {
    return this.shaByNode.get(nodeId);
  }

  /** Paths with unstaged or untracked changes relative to HEAD. */
  async listChangedPaths(): Promise<string[]> {
    const { stdout } = await this.git(["status", "--porcelain", "--untracked-files=all"]);
    return stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.slice(3).trim());
  }

  /** The actual unified diff for a node's checkpoint commit — what changed,
   *  in git's own format. This is the "diff" half of "diff-based patching":
   *  applyPatch() (safety/patch.ts) makes the change real, checkpoint()
   *  commits it, and this is how you inspect what that commit actually
   *  contains after the fact (audit trail / checkpoint history, 10). Not
   *  locked by the mutex — a read-only `git show` doesn't mutate HEAD and
   *  is safe to run concurrently with other nodes' checkpoint/rollback calls. */
  async diff(nodeId: string): Promise<string> {
    const sha = this.shaByNode.get(nodeId);
    if (!sha) throw new Error(`No checkpoint recorded for node "${nodeId}"`);
    const { stdout } = await this.git(["show", "--stat", "-p", sha]);
    return stdout;
  }

  /** Revert exactly this node's checkpoint commit. Content-safety comes from
   *  the file-locking invariant (point 1 above); mechanical safety from
   *  the gitLock mutex (point 2 above).
   *
   *  Implementation note: `git revert --allow-empty <sha>` is NOT a valid flag combination on
   *  git (revert has no --allow-empty option), and a plain `git revert <sha>` fails with
   *  "nothing to commit" when the original checkpoint was itself a no-op commit (e.g. a node
   *  that read but didn't mutate files). So we apply the revert unstaged first (--no-commit,
   *  which succeeds even when the resulting diff is empty) and then commit explicitly with
   *  --allow-empty — this works uniformly whether or not the checkpoint had real changes. */
  async rollback(nodeId: string): Promise<void> {
    const sha = this.shaByNode.get(nodeId);
    if (!sha) {
      throw new Error(`No checkpoint recorded for node "${nodeId}" — cannot roll back`);
    }
    await this.gitLock.run(async () => {
      try {
        await this.git(["revert", "--no-commit", sha]);
        await this.git(["commit", "--allow-empty", "-m", `rollback(node:${nodeId})`]);
      } catch (err: any) {
        // Abort cleanly rather than leaving the repo mid-revert with conflict markers.
        await this.git(["revert", "--abort"]).catch(() => {});
        throw new Error(
          `Rollback for node "${nodeId}" (${sha}) hit a conflict — this should not happen under the file-locking invariant; investigate before retrying. Original error: ${err.message}`
        );
      }
    });
  }
}
