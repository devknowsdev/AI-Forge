// src/demo.ts
//
// End-to-end walkthrough of the canonical lifecycle, run in sections so each
// documented behavior is independently visible in the output rather than
// buried inside one big graph:
//
//   1. Normal multi-node graph, sequential mode, dependency ordering.
//   2. Pattern cache hit — identical packet on a second graph skips routing
//      and execution entirely.
//   3. Partial failure — one node fails, its direct dependent is blocked,
//      an unrelated sibling branch still completes (04/07).
//   4. Ledger-driven tier fallback — capping ollama's budget mid-run forces
//      the next node onto free_tier (03/06), not because of a failure but
//      because of an exhausted quota.
//   5. Terminal node — a real shell command, bypassing AI routing.
//   6. Claude executor — a real API call attempt; succeeds if
//      ANTHROPIC_API_KEY is set, otherwise fails cleanly and demonstrates
//      the same fail path as any other executor error.
//   7. Parallel mode + file locking — two nodes declaring the same filePath
//      are observably serialized instead of racing.
//
// Each section uses a fresh ExecutionEngine instance pointed at the same
// on-disk DB/workspace so state (ledger, cache, history) persists across
// sections, the way it would across separate task-graph runs in the real app.

process.env.AI_FORGE_MOCK_EXECUTORS = "1";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionEngine } from "./engine/executionEngine.js";
import { TaskGraph } from "./taskGraph/graph.js";
import { GraphBuilder } from "./intelligence/graphBuilder.js";
import { Wizard } from "./wizard/wizard.js";
import type { TaskPacket } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = path.join(__dirname, "..", ".demo");
const DB_PATH = path.join(DEMO_ROOT, "forge.db");
const WORK_DIR = path.join(DEMO_ROOT, "workspace");

function packet(p: Partial<TaskPacket> & Pick<TaskPacket, "intent" | "node_type">): TaskPacket {
  return { context: {}, constraints: [], dependencies: [], ...p };
}

function section(title: string): void {
  console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
}

async function main() {
  fs.rmSync(DEMO_ROOT, { recursive: true, force: true });
  fs.mkdirSync(DEMO_ROOT, { recursive: true });

  const engine = new ExecutionEngine({ dbPath: DB_PATH, workDir: WORK_DIR, ollamaSwapDelayMs: 150 }); // realistic default is ~10s; scaled down for a watchable demo
  await engine.init();

  // ---------------------------------------------------------------------
  section("1. Normal graph — dependency order, sequential mode");
  // ---------------------------------------------------------------------
  const graph1 = new TaskGraph("graph-1", "demo-project", [
    { id: "docs", packet: packet({ intent: "Write README intro", node_type: "docs" }) },
    { id: "ui", packet: packet({ intent: "Build login form", node_type: "ui" }) },
    {
      id: "backend",
      packet: packet({
        intent: "Implement auth service",
        node_type: "backend",
        dependencies: ["ui"],
        constraints: ["must hash passwords", "must rate-limit login attempts"],
      }),
    },
    { id: "tests", packet: packet({ intent: "Write auth tests", node_type: "tests", dependencies: ["backend"] }) },
  ]);
  const logs1 = await engine.run(graph1, "sequential");
  for (const l of logs1) console.log(fmt(l));
  console.log("graph summary:", graph1.summary());

  // ---------------------------------------------------------------------
  section("2. Pattern cache — identical packet on a new graph skips execution");
  // ---------------------------------------------------------------------
  const graph2 = new TaskGraph("graph-2", "demo-project", [
    { id: "docs-again", packet: packet({ intent: "Write README intro", node_type: "docs" }) }, // identical signature to graph1's "docs" node
  ]);
  const logs2 = await engine.run(graph2, "sequential");
  for (const l of logs2) console.log(fmt(l));
  console.log(logs2[0].cacheHit ? "✓ cache hit confirmed — no executor was called" : "✗ expected a cache hit");

  // ---------------------------------------------------------------------
  section("3. Partial failure — direct dependent blocked, sibling unaffected");
  // ---------------------------------------------------------------------
  const graph3 = new TaskGraph("graph-3", "demo-project", [
    { id: "flaky", packet: packet({ intent: "Flaky migration step", node_type: "backend", context: { simulateFailure: "ollama" } }) },
    { id: "depends-on-flaky", packet: packet({ intent: "Run migrated queries", node_type: "backend", dependencies: ["flaky"] }) },
    { id: "unrelated-sibling", packet: packet({ intent: "Update changelog", node_type: "docs" }) },
  ]);
  const logs3 = await engine.run(graph3, "sequential");
  for (const l of logs3) console.log(fmt(l));
  console.log("graph summary:", graph3.summary());
  console.log(`"depends-on-flaky" status: ${graph3.get("depends-on-flaky").status} (expect blocked)`);
  console.log(`"unrelated-sibling" status: ${graph3.get("unrelated-sibling").status} (expect success — no dependency on the failed node)`);

  // ---------------------------------------------------------------------
  section("4. Ledger-driven tier fallback (budget exhaustion, not failure)");
  // ---------------------------------------------------------------------
  engine.ledger.setBudget("ollama", { rpmLimit: 1 }); // ollama's accrued usage from earlier sections already exceeds this, so it's over budget immediately
  const graph4 = new TaskGraph("graph-4", "demo-project", [
    { id: "n1", packet: packet({ intent: "Generate API client stub A", node_type: "ui" }) },
    { id: "n2", packet: packet({ intent: "Generate API client stub B", node_type: "ui" }) },
  ]);
  const logs4 = await engine.run(graph4, "sequential");
  for (const l of logs4) console.log(fmt(l));
  console.log("ledger snapshot (ollama/free_tier rows):");
  console.table(engine.ledger.snapshot().filter((r) => r.provider === "ollama" || r.provider === "free_tier"));
  engine.ledger.setBudget("ollama", { rpmLimit: null }); // restore unlimited for later sections

  // ---------------------------------------------------------------------
  section("5. Terminal node — real shell execution, bypasses AI routing");
  // ---------------------------------------------------------------------
  const graph5 = new TaskGraph("graph-5", "demo-project", [
    {
      id: "shell",
      packet: packet({
        intent: "Print workspace contents",
        node_type: "terminal",
        context: { command: "echo hello from a real shell && pwd" },
      }),
    },
  ]);
  const logs5 = await engine.run(graph5, "sequential");
  for (const l of logs5) console.log(fmt(l));
  console.log("terminal output:", JSON.stringify(graph5.get("shell").result?.output));

  // ---------------------------------------------------------------------
  section("6. Claude executor — real API call attempt");
  // ---------------------------------------------------------------------
  // Force the paid tier so this actually reaches the claude executor: cap
  // ollama and free_tier down to zero remaining budget for this one call.
  engine.ledger.setBudget("ollama", { rpmLimit: 0 });
  engine.ledger.setBudget("free_tier", { rpmLimit: 0 });
  const graph6 = new TaskGraph("graph-6", "demo-project", [
    {
      id: "reasoning-task",
      packet: packet({
        intent: "In one sentence, explain why dependency-ordered execution matters.",
        node_type: "backend", // high complexity -> prefers claude over gpt in the paid tier
      }),
    },
  ]);
  const logs6 = await engine.run(graph6, "sequential");
  for (const l of logs6) console.log(fmt(l));
  if (logs6[0].provider === "claude" && logs6[0].status === "success") {
    console.log("claude said:", graph6.get("reasoning-task").result?.output);
  } else {
    console.log("(no ANTHROPIC_API_KEY in this environment — executor failed cleanly, as designed)");
  }
  engine.ledger.setBudget("ollama", { rpmLimit: null });
  engine.ledger.setBudget("free_tier", { rpmLimit: 15 });

  // ---------------------------------------------------------------------
  section("7. Parallel mode + file-level locking");
  // ---------------------------------------------------------------------
  const sharedPath = "shared/config.json";
  const order: string[] = [];
  const origExecute = (engine as any).executors.ollama.execute.bind((engine as any).executors.ollama);
  (engine as any).executors.ollama.execute = async (p: TaskPacket) => {
    order.push(`start:${p.intent}`);
    const r = await origExecute(p);
    order.push(`end:${p.intent}`);
    return r;
  };
  const graph7 = new TaskGraph("graph-7", "demo-project", [
    { id: "writer-a", packet: packet({ intent: "writer-a", node_type: "ui", filePaths: [sharedPath] }) },
    { id: "writer-b", packet: packet({ intent: "writer-b", node_type: "ui", filePaths: [sharedPath] }) },
    // Same node_type (-> same ollama model) as the writers on purpose: this
    // section is isolating file-locking specifically. A docs-type node here
    // would also collide with the model lock added in section 8, which is a
    // different concept demonstrated separately below.
    { id: "independent", packet: packet({ intent: "independent", node_type: "ui" }) },
  ]);
  await engine.run(graph7, "parallel");
  console.log("execution order (writer-a/writer-b must not interleave; independent may run anywhere):");
  console.log(order);

  // ---------------------------------------------------------------------
  section("8. Local model lock — Local_AI_Developer_Stack.docx's 'golden rule'");
  // ---------------------------------------------------------------------
  // ui/backend/tests -> the coder model, docs -> the general model (see
  // executors/ollama.ts). These two nodes share NO file path, so
  // FileLockManager alone would let them run fully concurrently — exactly
  // the scenario the document says causes a real local Ollama instance to
  // thrash (one model spills to swap, both degrade 10x). The model lock is
  // what stops that.
  const modelOrder: string[] = [];
  const origExecuteForModelDemo = (engine as any).executors.ollama.execute.bind((engine as any).executors.ollama);
  (engine as any).executors.ollama.execute = async (p: TaskPacket) => {
    modelOrder.push(`start:${p.node_type}`);
    const r = await origExecuteForModelDemo(p);
    modelOrder.push(`end:${p.node_type}`);
    return r;
  };
  const graph7b = new TaskGraph("graph-7b", "demo-project", [
    { id: "code-task", packet: packet({ intent: "implement a function", node_type: "backend" }) },
    { id: "writing-task", packet: packet({ intent: "summarize research notes", node_type: "docs" }) },
  ]);
  const t0 = Date.now();
  await engine.run(graph7b, "parallel");
  console.log(`elapsed: ${Date.now() - t0}ms (includes a simulated ${150}ms model-swap penalty)`);
  console.log("execution order (must NOT interleave — different models, same single local instance):");
  console.log(modelOrder);
  (engine as any).executors.ollama.execute = origExecuteForModelDemo; // restore for later sections

  // ---------------------------------------------------------------------
  section("9. Diff-based patching — AI-tier nodes really write files now");
  // ---------------------------------------------------------------------
  const graph8a = new TaskGraph("graph-8a", "demo-project", [
    {
      id: "scaffold-settings",
      packet: packet({
        intent: "Scaffold a settings page component",
        node_type: "ui",
        context: { targetFile: "src/settings.ts" },
        filePaths: ["src/settings.ts"],
      }),
    },
  ]);
  const logs8a = await engine.run(graph8a, "sequential");
  for (const l of logs8a) console.log(fmt(l));
  console.log("file on disk:", fs.readFileSync(path.join(WORK_DIR, "src/settings.ts"), "utf-8").trim());
  console.log("--- diff for this checkpoint (git show) ---");
  console.log((await engine.checkpoints.diff("scaffold-settings")).split("\n").slice(0, 12).join("\n"));

  console.log("\nNow a node whose write fails post-hoc validation:");
  const graph8b = new TaskGraph("graph-8b", "demo-project", [
    {
      id: "bad-config",
      packet: packet({
        intent: "Write a config that fails review",
        node_type: "backend",
        context: { targetFile: "config.json", validate: { testCommand: "test -f config.json && exit 1" } },
        filePaths: ["config.json"],
      }),
    },
  ]);
  const logs8b = await engine.run(graph8b, "sequential");
  for (const l of logs8b) console.log(fmt(l));
  console.log(
    "config.json exists after rollback?",
    fs.existsSync(path.join(WORK_DIR, "config.json")),
    "(expect false — the patch-written file was reverted along with the checkpoint)"
  );

  // ---------------------------------------------------------------------
  section("10. Graph Builder — Intent -> Graph (the L3 piece nothing else closes)");
  // ---------------------------------------------------------------------
  // Reuses this same engine/DB so the "past failures" lookup has real
  // history from section 3's "flaky" node to find.
  const builder = new GraphBuilder(engine.memory, engine.taskHistory);
  const outcome = await builder.build({
    graphId: "graph-8",
    projectId: "demo-project",
    description: "Flaky migration step needs a retry mechanism", // deliberately echoes section 3's failed node
    mode: "fix_issue",
  });
  console.log(`source: ${outcome.source}${outcome.fallbackReason ? ` (reason: ${outcome.fallbackReason})` : ""}`);
  console.log("failure notes surfaced to the prompt:", outcome.failureNotesUsed);
  console.log(
    "generated nodes:",
    outcome.graph.all().map((n) => ({ id: n.id, type: n.packet.node_type, deps: n.packet.dependencies }))
  );
  const logs8 = await engine.run(outcome.graph, "sequential");
  for (const l of logs8) console.log(fmt(l));

  // ---------------------------------------------------------------------
  section("11. Wizard — question-flow, plan-before-execution, no code exposure");
  // ---------------------------------------------------------------------
  // This is the backend logic for what a future UI would drive: ask Q&A,
  // confirm a plain-language plan, then execute. All three spec rules from
  // 02_WIZARD_SYSTEM.md are enforced here in the backend, not left to the
  // UI to remember.
  const wizard = new Wizard("build_feature");
  let q = wizard.nextQuestion();
  let questionCount = 0;
  const simulatedAnswers: Record<string, string> = {
    description: "add a dark-mode toggle to the settings page",
    constraints: "must not break the existing light-mode tests",
    testing_focus: "", // skipping optional question
  };
  while (q) {
    console.log(`  Q${++questionCount}: ${q.prompt}`);
    const ans = simulatedAnswers[q.id] ?? "";
    console.log(`  A: ${ans || "(skipped — optional)"}`);
    wizard.answer(q.id, ans);
    q = wizard.nextQuestion();
  }
  console.log(`  (${questionCount} question(s) asked — ceiling is 3)`);

  const plan = await wizard.buildPlan(
    new GraphBuilder(engine.memory, engine.taskHistory),
    { graphId: "graph-wizard", projectId: "demo-project" }
  );
  console.log("\nPlan summary (plain language only — no code exposed):");
  console.log(" ", plan.summary);
  console.log("Steps:");
  for (const step of plan.steps) console.log(`  ${step.id.padEnd(12)} ${step.description}`);
  console.log("Plan confirmed?", plan.confirmed);

  const graph = plan.confirm();
  console.log("Plan confirmed?", plan.confirmed, "— graph now available, executing...");
  const logs9 = await engine.run(graph, "sequential");
  for (const l of logs9) console.log(fmt(l));

  console.log("\ndata boundary summary across this whole demo run ('demo-project'):");
  console.table(engine.taskHistory.dataBoundarySummary("demo-project"));

  engine.close();
  console.log("\nDemo complete. SQLite DB at:", DB_PATH, " git workspace at:", WORK_DIR);
}

function fmt(l: { nodeId: string; status: string; provider: string; cacheHit: boolean; cost: number; latencyMs: number; error?: string }): string {
  const bits = [`${l.nodeId.padEnd(20)} -> ${l.status.padEnd(7)} via ${l.provider}${l.cacheHit ? " (cache)" : ""}`];
  if (l.cost) bits.push(`$${l.cost.toFixed(5)}`);
  bits.push(`${l.latencyMs}ms`);
  if (l.error) bits.push(`ERROR: ${l.error}`);
  return bits.join("  ");
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
