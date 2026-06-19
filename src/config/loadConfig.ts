// Loads ~/.ai-forge/config.json and optional project-local overrides.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecutionMode } from "../types.js";

export interface ForgeConfig {
  /** Directory where AI Forge runs git checkpoints and applies patches. */
  workDir?: string;
  /** SQLite database path for memory/ledger. */
  dbPath?: string;
  /** Logical project id for task history. */
  projectId?: string;
  /** sequential | parallel */
  executionMode?: ExecutionMode;
  /** When true, retry the next tier if an executor call fails (operational default). */
  fallbackOnFailure?: boolean;
  /** Force mock executors even outside tests. */
  mockExecutors?: boolean;
}

const DEFAULTS: Required<Pick<ForgeConfig, "executionMode" | "fallbackOnFailure" | "mockExecutors">> = {
  executionMode: "parallel",
  fallbackOnFailure: true,
  mockExecutors: false,
};

function readJsonIfExists(filePath: string): ForgeConfig {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ForgeConfig;
  } catch {
    return {};
  }
}

export function defaultForgePaths(cwd = process.cwd()): { workDir: string; dbPath: string; projectId: string } {
  const home = path.join(os.homedir(), ".ai-forge");
  return {
    workDir: cwd,
    dbPath: path.join(home, "forge.db"),
    projectId: path.basename(cwd),
  };
}

export function loadForgeConfig(cwd = process.cwd()): Required<ForgeConfig> & { workDir: string; dbPath: string; projectId: string } {
  const paths = defaultForgePaths(cwd);
  const globalPath = path.join(os.homedir(), ".ai-forge", "config.json");
  const localPath = path.join(cwd, ".ai-forge.json");

  const merged: ForgeConfig = {
    ...readJsonIfExists(globalPath),
    ...readJsonIfExists(localPath),
  };

  return {
    workDir: merged.workDir ?? paths.workDir,
    dbPath: merged.dbPath ?? paths.dbPath,
    projectId: merged.projectId ?? paths.projectId,
    executionMode: merged.executionMode ?? DEFAULTS.executionMode,
    fallbackOnFailure: merged.fallbackOnFailure ?? DEFAULTS.fallbackOnFailure,
    mockExecutors: merged.mockExecutors ?? DEFAULTS.mockExecutors,
  };
}

export function ensureForgeDirs(config: Pick<ForgeConfig, "workDir" | "dbPath">): void {
  if (config.workDir) fs.mkdirSync(config.workDir, { recursive: true });
  if (config.dbPath) fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
}

export function exampleConfigPath(): string {
  return path.join(os.homedir(), ".ai-forge", "config.json");
}
