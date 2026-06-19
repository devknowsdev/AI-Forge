#!/usr/bin/env node
// AI Forge CLI — interactive Wizard driver for daily use.
// Runs the full Intent → Plan → Confirm → Execute lifecycle in the terminal.

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ExecutionEngine } from "./engine/executionEngine.js";
import { GraphBuilder, WIZARD_MODES, type WizardMode } from "./intelligence/graphBuilder.js";
import { Wizard } from "./wizard/wizard.js";
import { loadForgeConfig, ensureForgeDirs, exampleConfigPath } from "./config/loadConfig.js";
import { applyProviderProbe, probeAllProviders } from "./config/providerProbe.js";
import { dataBoundaryFor } from "./types.js";

const MODE_LABELS: Record<WizardMode, string> = {
  build_feature: "Build Feature",
  fix_issue: "Fix Issue",
  create_project: "Create Project",
  deploy: "Deploy",
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args.includes("--status")) {
    await printStatus();
    return;
  }

  const config = loadForgeConfig();
  ensureForgeDirs(config);

  console.log("\n  AI Forge — local-first build orchestrator\n");
  console.log(`  Project:  ${config.projectId}`);
  console.log(`  Work dir: ${config.workDir}`);
  console.log(`  Memory:   ${config.dbPath}\n`);

  const statuses = await probeAllProviders();
  printProviderTable(statuses);

  const availableAi = statuses.filter((s) => s.provider !== "terminal" && s.available);
  if (availableAi.length === 0) {
    console.error("\n  No AI providers available. Set at least one API key or install Ollama.");
    console.error(`  Run: ai-forge --status\n  Config: ${exampleConfigPath()}\n`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input, output });
  try {
    const mode = await pickMode(rl, args);
    const wizard = new Wizard(mode);

    const engine = new ExecutionEngine({
      dbPath: config.dbPath,
      workDir: config.workDir,
      mockExecutors: config.mockExecutors,
      fallbackOnFailure: config.fallbackOnFailure,
    });
    await engine.init();
    applyProviderProbe(engine, statuses);
    const graphBuilder = new GraphBuilder(engine.memory, engine.taskHistory);

    while (true) {
      const q = wizard.nextQuestion();
      if (!q) break;
      const answer = await rl.question(`  ${q.prompt}${q.optional ? " (optional)" : ""}\n  > `);
      wizard.answer(q.id, answer.trim());
    }

    console.log("\n  Building plan...\n");
    const plan = await wizard.buildPlan(graphBuilder, {
      graphId: `run-${Date.now()}`,
      projectId: config.projectId,
    });

    console.log(`  Plan: ${plan.summary}`);
    console.log(`  Source: ${plan.source === "ai" ? "AI decomposition" : "fallback template"}\n`);
    for (const step of plan.steps) {
      console.log(`    • ${step.description}`);
    }

    const confirm = await rl.question("\n  Run this plan? [y/N] ");
    if (!/^y(es)?$/i.test(confirm.trim())) {
      console.log("\n  Cancelled.\n");
      engine.close();
      return;
    }

    const graph = plan.confirm();
    console.log(`\n  Executing (${config.executionMode} mode)...\n`);

    const logs = await engine.run(graph, config.executionMode);
    printRunSummary(logs);

    engine.close();
    console.log("");
  } finally {
    rl.close();
  }
}

async function pickMode(rl: readline.Interface, args: string[]): Promise<WizardMode> {
  const flagIdx = args.findIndex((a) => a === "--mode" || a === "-m");
  if (flagIdx >= 0 && args[flagIdx + 1]) {
    const mode = args[flagIdx + 1] as WizardMode;
    if ((WIZARD_MODES as readonly string[]).includes(mode)) return mode;
    throw new Error(`Unknown mode "${mode}". Use: ${WIZARD_MODES.join(", ")}`);
  }

  console.log("  What would you like to do?\n");
  WIZARD_MODES.forEach((m, i) => console.log(`    ${i + 1}. ${MODE_LABELS[m]}`));
  const choice = await rl.question("\n  Choose 1–4: ");
  const idx = Number.parseInt(choice.trim(), 10) - 1;
  if (idx >= 0 && idx < WIZARD_MODES.length) return WIZARD_MODES[idx];
  throw new Error("Invalid mode selection");
}

function printProviderTable(statuses: Awaited<ReturnType<typeof probeAllProviders>>): void {
  console.log("  Providers:");
  for (const s of statuses) {
    if (s.provider === "terminal") continue;
    const mark = s.available ? "✓" : "✗";
    const boundary = dataBoundaryFor(s.provider);
    const note = s.available ? boundary : (s.reason ?? "unavailable");
    console.log(`    ${mark} ${s.provider.padEnd(10)} ${note}`);
  }
  console.log("");
}

async function printStatus(): Promise<void> {
  const statuses = await probeAllProviders();
  console.log("\nAI Forge provider status\n");
  printProviderTable(statuses);
  console.log(`Config file: ${exampleConfigPath()}`);
  console.log("\nEnvironment variables:");
  console.log("  OLLAMA_HOST, OLLAMA_CODER_MODEL, OLLAMA_GENERAL_MODEL");
  console.log("  GEMINI_API_KEY (or GOOGLE_API_KEY) — free tier");
  console.log("  OPENAI_API_KEY — GPT tier");
  console.log("  ANTHROPIC_API_KEY — Claude tier\n");
}

function printRunSummary(logs: Awaited<ReturnType<ExecutionEngine["run"]>>): void {
  const ok = logs.filter((l) => l.status === "success").length;
  const fail = logs.filter((l) => l.status === "failed").length;
  const cost = logs.reduce((sum, l) => sum + l.cost, 0);

  console.log(`  Done: ${ok} succeeded, ${fail} failed, $${cost.toFixed(4)} spent\n`);
  for (const log of logs) {
    const icon = log.status === "success" ? "✓" : "✗";
    const cache = log.cacheHit ? " (cached)" : "";
    const err = log.error ? ` — ${log.error}` : "";
    console.log(`    ${icon} ${log.nodeId} via ${log.provider}${cache}${err}`);
  }
}

function printHelp(): void {
  console.log(`
AI Forge — local-first AI orchestration CLI

Usage:
  npm run forge              Interactive wizard in current directory
  npm run forge -- --status  Show provider availability
  npm run forge -- --mode build_feature

Modes: ${WIZARD_MODES.join(", ")}

Config: ${exampleConfigPath()}
Project override: ./.ai-forge.json

Set API keys in your environment or shell profile.
Install Ollama for free local execution: https://ollama.com
`);
}

main().catch((err) => {
  console.error(`\n  Error: ${(err as Error).message}\n`);
  process.exit(1);
});
