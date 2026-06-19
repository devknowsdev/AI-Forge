// test/run.ts
//
// Lightweight assertion-based checks (no framework — `node:assert` is enough
// for this surface area). Each test gets its own fresh DB/workspace so they
// don't interfere with each other or with src/demo.ts's output.

process.env.AI_FORGE_MOCK_EXECUTORS = "1";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionEngine } from "../src/engine/executionEngine.js";
import { TaskGraph } from "../src/taskGraph/graph.js";
import { GraphBuilder, staticFallbackNodes, toNodeInputs } from "../src/intelligence/graphBuilder.js";
import { TaskHistory } from "../src/memory/taskHistory.js";
import { applyPatch } from "../src/safety/patch.js";
import { LocalModelLock } from "../src/engine/modelLock.js";
import { selectModel as selectOllamaModel } from "../src/executors/ollama.js";
import { dataBoundaryFor } from "../src/types.js";
import { Wizard, MAX_QUESTIONS } from "../src/wizard/wizard.js";
import type { TaskPacket } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", ".test-tmp");

function packet(p: Partial<TaskPacket> & Pick<TaskPacket, "intent" | "node_type">): TaskPacket {
  return { context: {}, constraints: [], dependencies: [], ...p };
}

async function freshEngine(name: string, opts: { ollamaSwapDelayMs?: number } = {}): Promise<ExecutionEngine> {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const engine = new ExecutionEngine({
    dbPath: path.join(dir, "forge.db"),
    workDir: path.join(dir, "workspace"),
    ollamaSwapDelayMs: opts.ollamaSwapDelayMs ?? 5,
    mockExecutors: true,
  });
  await engine.init();
  return engine;
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    console.error(`FAIL  - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });

  await test("sequential graph respects dependency order and all nodes succeed", async () => {
    const engine = await freshEngine("seq");
    const graph = new TaskGraph("g", "p", [
      { id: "a", packet: packet({ intent: "a", node_type: "docs" }) },
      { id: "b", packet: packet({ intent: "b", node_type: "ui", dependencies: ["a"] }) },
      { id: "c", packet: packet({ intent: "c", node_type: "backend", dependencies: ["b"] }) },
    ]);
    const logs = await engine.run(graph, "sequential");
    assert.equal(logs.length, 3);
    assert.deepEqual(logs.map((l) => l.nodeId), ["a", "b", "c"]); // dependency order, not insertion order
    assert.ok(logs.every((l) => l.status === "success"));
    engine.close();
  });

  await test("cycle in dependencies is rejected at graph construction", async () => {
    assert.throws(() => {
      new TaskGraph("g", "p", [
        { id: "a", packet: packet({ intent: "a", node_type: "docs", dependencies: ["b"] }) },
        { id: "b", packet: packet({ intent: "b", node_type: "docs", dependencies: ["a"] }) },
      ]);
    }, /Cycle detected/);
  });

  await test("pattern cache hit skips execution and reuses original output", async () => {
    const engine = await freshEngine("cache");
    const p = packet({ intent: "same intent", node_type: "docs" });
    const g1 = new TaskGraph("g1", "proj", [{ id: "x", packet: p }]);
    const [first] = await engine.run(g1, "sequential");
    assert.equal(first.cacheHit, false);

    const g2 = new TaskGraph("g2", "proj", [{ id: "y", packet: { ...p } }]);
    const [second] = await engine.run(g2, "sequential");
    assert.equal(second.cacheHit, true);
    assert.equal(g2.get("y").result?.output, g1.get("x").result?.output);
    assert.equal(second.cost, 0);
    engine.close();
  });

  await test("a failed node blocks only its direct dependent; unrelated sibling still succeeds", async () => {
    const engine = await freshEngine("partial-fail");
    const graph = new TaskGraph("g", "p", [
      { id: "flaky", packet: packet({ intent: "flaky", node_type: "backend", context: { simulateFailure: "ollama" } }) },
      { id: "child", packet: packet({ intent: "child", node_type: "backend", dependencies: ["flaky"] }) },
      { id: "grandchild", packet: packet({ intent: "grandchild", node_type: "backend", dependencies: ["child"] }) },
      { id: "sibling", packet: packet({ intent: "sibling", node_type: "docs" }) },
    ]);
    await engine.run(graph, "sequential");
    assert.equal(graph.get("flaky").status, "failed");
    assert.equal(graph.get("child").status, "blocked"); // direct dependent
    assert.equal(graph.get("grandchild").status, "pending"); // never reachable, but NOT explicitly 'blocked' — see graph.ts docblock
    assert.equal(graph.get("sibling").status, "success");
    engine.close();
  });

  await test("git checkpoint is reverted when a node fails (working tree shows no trace of the failed attempt)", async () => {
    const engine = await freshEngine("rollback-git");
    const graph = new TaskGraph("g", "p", [
      {
        id: "writer",
        packet: packet({
          intent: "write then fail",
          node_type: "terminal",
          context: { command: "echo should-not-survive > marker.txt; exit 1" },
        }),
      },
    ]);
    await engine.run(graph, "sequential");
    assert.equal(graph.get("writer").status, "failed");
    const workspaceFile = path.join(ROOT, "rollback-git", "workspace", "marker.txt");
    assert.equal(fs.existsSync(workspaceFile), false, "rollback should have reverted the file write");
    engine.close();
  });

  await test("ledger fallback: exhausting a tier's budget routes the next call to the next tier", async () => {
    const engine = await freshEngine("ledger");
    engine.ledger.setBudget("ollama", { rpmLimit: 0 }); // immediately exhausted
    const graph = new TaskGraph("g", "p", [{ id: "n", packet: packet({ intent: "n", node_type: "ui" }) }]);
    const [log] = await engine.run(graph, "sequential");
    assert.equal(log.provider, "free_tier");
    engine.close();
  });

  await test("terminal node requires an explicit command and never falls back to intent text", async () => {
    const engine = await freshEngine("terminal-guard");
    const graph = new TaskGraph("g", "p", [{ id: "n", packet: packet({ intent: "rm -rf /", node_type: "terminal" }) }]);
    const [log] = await engine.run(graph, "sequential");
    assert.equal(log.status, "failed");
    assert.match(log.error ?? "", /requires packet.context.command/);
    engine.close();
  });

  await test("file-level locking serializes nodes sharing a path; independent nodes are unaffected", async () => {
    const engine = await freshEngine("lock");
    const order: string[] = [];
    const ollama = (engine as any).executors.ollama;
    const orig = ollama.execute.bind(ollama);
    ollama.execute = async (p: TaskPacket) => {
      order.push(`start:${p.intent}`);
      await new Promise((r) => setTimeout(r, 30));
      const result = await orig(p);
      order.push(`end:${p.intent}`);
      return result;
    };
    const graph = new TaskGraph("g", "p", [
      { id: "a", packet: packet({ intent: "a", node_type: "ui", filePaths: ["shared.json"] }) },
      { id: "b", packet: packet({ intent: "b", node_type: "ui", filePaths: ["shared.json"] }) },
    ]);
    await engine.run(graph, "parallel");
    // "a" and "b" must not interleave: end:a must come before start:b, or vice versa.
    const aEnd = order.indexOf("end:a");
    const bStart = order.indexOf("start:b");
    const bEnd = order.indexOf("end:b");
    const aStart = order.indexOf("start:a");
    const noInterleave = (aEnd < bStart) || (bEnd < aStart);
    assert.ok(noInterleave, `expected no interleave, got: ${order.join(", ")}`);
    engine.close();
  });

  await test("static fallback templates are valid, acyclic node sets for every wizard mode", async () => {
    for (const mode of ["build_feature", "fix_issue", "create_project", "deploy"] as const) {
      const nodes = staticFallbackNodes("some task", mode);
      assert.ok(nodes.length > 0, `${mode} produced no nodes`);
      // Constructing a TaskGraph throws on cycles/unknown deps — this is the validation we care about.
      assert.doesNotThrow(() => {
        new TaskGraph(`g-${mode}`, "p", toNodeInputs(nodes));
      });
    }
  });

  await test("GraphBuilder.build() degrades to the fallback template when no API key is set", async () => {
    const engine = await freshEngine("graphbuilder-fallback");
    const builder = new GraphBuilder(engine.memory, engine.taskHistory);
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const outcome = await builder.build({ graphId: "g", projectId: "p", description: "add a settings page", mode: "build_feature" });
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;

    assert.equal(outcome.source, "fallback");
    assert.match(outcome.fallbackReason ?? "", /ANTHROPIC_API_KEY/);
    assert.ok(outcome.graph.all().length > 0);
    engine.close();
  });

  await test("GraphBuilder surfaces relevant past failures for a similar new task", async () => {
    const engine = await freshEngine("graphbuilder-failures");
    // Manufacture a failure in this project's history.
    const failGraph = new TaskGraph("g0", "proj-x", [
      { id: "n", packet: packet({ intent: "Sync payment gateway credentials", node_type: "backend", context: { simulateFailure: "ollama" } }) },
    ]);
    await engine.run(failGraph, "sequential");
    assert.equal(failGraph.get("n").status, "failed");

    const builder = new GraphBuilder(engine.memory, new TaskHistory(engine.memory));
    const outcome = await builder.build({ graphId: "g1", projectId: "proj-x", description: "Fix payment gateway credentials sync", mode: "fix_issue" });
    assert.ok(outcome.failureNotesUsed.length >= 1, "expected the prior failure to be surfaced via keyword overlap");
    assert.match(outcome.failureNotesUsed[0].intent, /payment gateway/i);
    engine.close();
  });

  await test("concurrent checkpoints for nodes with NO shared file paths don't race on git's HEAD ref", async () => {
    const engine = await freshEngine("git-race");
    // Many nodes, zero shared filePaths, all ready at once — maximizes the
    // chance of two `git commit` calls landing on the same instant if the
    // checkpoint manager isn't internally serializing git operations.
    const graph = new TaskGraph(
      "g",
      "p",
      Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, packet: packet({ intent: `task ${i}`, node_type: "docs" }) }))
    );
    const logs = await engine.run(graph, "parallel");
    assert.ok(logs.every((l) => l.status === "success"), `expected all to succeed, got: ${JSON.stringify(logs)}`);
    engine.close();
  });

  await test("applyPatch writes files (creating parent dirs), deletes files, and rejects paths escaping workDir", async () => {
    const dir = path.join(ROOT, "apply-patch");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    applyPatch(dir, { edits: [{ path: "nested/dir/file.txt", op: "write", content: "hello" }] });
    assert.equal(fs.readFileSync(path.join(dir, "nested/dir/file.txt"), "utf-8"), "hello");

    applyPatch(dir, { edits: [{ path: "nested/dir/file.txt", op: "delete" }] });
    assert.equal(fs.existsSync(path.join(dir, "nested/dir/file.txt")), false);

    assert.throws(() => applyPatch(dir, { edits: [{ path: "../../escape.txt", op: "write", content: "x" }] }), /escapes the workspace/);
  });

  await test("an AI-tier node (ollama mock) really writes a file via its patch, checkpointed by git", async () => {
    const engine = await freshEngine("patch-write");
    const graph = new TaskGraph("g", "p", [
      { id: "n", packet: packet({ intent: "scaffold a settings page", node_type: "ui", context: { targetFile: "src/settings.ts" }, filePaths: ["src/settings.ts"] }) },
    ]);
    const [log] = await engine.run(graph, "sequential");
    assert.equal(log.status, "success");
    const written = path.join(ROOT, "patch-write", "workspace", "src/settings.ts");
    assert.ok(fs.existsSync(written), "expected the AI-tier node's patch to actually create the file");
    assert.match(fs.readFileSync(written, "utf-8"), /generated by ollama/);
    engine.close();
  });

  await test("a validation failure rolls back a patch-written file, not just terminal-written ones", async () => {
    const engine = await freshEngine("patch-rollback");
    const graph = new TaskGraph("g", "p", [
      {
        id: "n",
        packet: packet({
          intent: "write a config that should fail review",
          node_type: "backend",
          context: {
            targetFile: "config.json",
            // No real build step exists for a mock — force the gate to fail
            // post-hoc the same way a real failing test suite would.
            validate: { testCommand: "test -f config.json && exit 1" },
          },
          filePaths: ["config.json"],
        }),
      },
    ]);
    const [log] = await engine.run(graph, "sequential");
    assert.equal(log.status, "failed");
    const file = path.join(ROOT, "patch-rollback", "workspace", "config.json");
    assert.equal(fs.existsSync(file), false, "rollback should have reverted the patch-written file");
    engine.close();
  });

  await test("a cache hit replays the original patch, not just the text output", async () => {
    const engine = await freshEngine("patch-cache");
    const p = packet({ intent: "generate a constants file", node_type: "docs", context: { targetFile: "constants.ts" }, filePaths: ["constants.ts"] });

    const g1 = new TaskGraph("g1", "proj", [{ id: "a", packet: p }]);
    const [first] = await engine.run(g1, "sequential");
    assert.equal(first.cacheHit, false);
    const file = path.join(ROOT, "patch-cache", "workspace", "constants.ts");
    const originalContent = fs.readFileSync(file, "utf-8");

    fs.rmSync(file); // simulate the file being gone before the cached node runs again
    const g2 = new TaskGraph("g2", "proj", [{ id: "b", packet: { ...p } }]);
    const [second] = await engine.run(g2, "sequential");
    assert.equal(second.cacheHit, true);
    assert.ok(fs.existsSync(file), "cache hit should have replayed the original patch, recreating the file");
    assert.equal(fs.readFileSync(file, "utf-8"), originalContent);
    engine.close();
  });

  await test("LocalModelLock: same-model calls incur no swap delay, a model switch does", async () => {
    const lock = new LocalModelLock(200); // exaggerated but still test-fast, to make the assertion unambiguous
    const t0 = Date.now();
    await lock.run("modelA", async () => {});
    const afterFirst = Date.now() - t0;
    assert.ok(afterFirst < 100, `first call (no prior model) should not delay, took ${afterFirst}ms`);

    const t1 = Date.now();
    await lock.run("modelA", async () => {}); // same model — no delay
    assert.ok(Date.now() - t1 < 100, "same-model call should not pay the swap delay");

    const t2 = Date.now();
    await lock.run("modelB", async () => {}); // different model — pays the delay
    assert.ok(Date.now() - t2 >= 190, "switching models should pay close to the configured swap delay");
    assert.equal(lock.loadedModel(), "modelB");
  });

  await test("selectModel routes coding node types to the coder model and others to the general model", async () => {
    const coder = selectOllamaModel(packet({ intent: "x", node_type: "backend" }));
    const general = selectOllamaModel(packet({ intent: "x", node_type: "docs" }));
    assert.notEqual(coder, general);
    assert.equal(selectOllamaModel(packet({ intent: "x", node_type: "ui" })), coder);
    assert.equal(selectOllamaModel(packet({ intent: "x", node_type: "tests" })), coder);
  });

  await test("two ollama nodes needing DIFFERENT models never run concurrently, even in 'parallel' mode", async () => {
    const engine = await freshEngine("model-lock-integration", { ollamaSwapDelayMs: 30 });
    const order: string[] = [];
    const ollama = (engine as any).executors.ollama;
    const orig = ollama.execute.bind(ollama);
    ollama.execute = async (p: TaskPacket) => {
      order.push(`start:${p.node_type}`);
      await new Promise((r) => setTimeout(r, 20));
      const result = await orig(p);
      order.push(`end:${p.node_type}`);
      return result;
    };
    // "ui" -> coder model, "docs" -> general model: a genuine switch, and the
    // two nodes share no file path, so FileLockManager alone would let them
    // run fully concurrently. The model lock is what has to stop that.
    const graph = new TaskGraph("g", "p", [
      { id: "a", packet: packet({ intent: "a", node_type: "ui" }) },
      { id: "b", packet: packet({ intent: "b", node_type: "docs" }) },
    ]);
    await engine.run(graph, "parallel");
    const aEnd = order.indexOf("end:ui");
    const bStart = order.indexOf("start:docs");
    const bEnd = order.indexOf("end:docs");
    const aStart = order.indexOf("start:ui");
    const noOverlap = (aEnd < bStart) || (bEnd < aStart);
    assert.ok(noOverlap, `expected no overlap between different-model ollama calls, got: ${order.join(", ")}`);
    engine.close();
  });

  await test("data boundary: local providers are 'local', free_tier is flagged as may-train, gpt/claude are not", async () => {
    assert.equal(dataBoundaryFor("ollama"), "local");
    assert.equal(dataBoundaryFor("terminal"), "local");
    assert.equal(dataBoundaryFor("free_tier"), "remote_may_train");
    assert.equal(dataBoundaryFor("gpt"), "remote_no_training");
    assert.equal(dataBoundaryFor("claude"), "remote_no_training");
  });

  await test("data boundary is actually persisted per call, not just computed transiently", async () => {
    const engine = await freshEngine("data-boundary");
    engine.ledger.setBudget("ollama", { rpmLimit: 0 }); // force free_tier
    const graph = new TaskGraph("g", "p", [{ id: "n", packet: packet({ intent: "n", node_type: "ui" }) }]);
    await engine.run(graph, "sequential");
    const summary = engine.taskHistory.dataBoundarySummary("p").map((row) => ({ ...row }));
    assert.deepEqual(summary, [{ dataBoundary: "remote_may_train", count: 1 }]);
    engine.close();
  });

  await test("Wizard never exceeds the 3-question ceiling, for any mode", async () => {
    for (const mode of ["build_feature", "fix_issue", "create_project", "deploy"] as const) {
      const wizard = new Wizard(mode);
      let count = 0;
      let q = wizard.nextQuestion();
      while (q && count <= MAX_QUESTIONS + 1) {
        wizard.answer(q.id, "answer");
        count++;
        q = wizard.nextQuestion();
      }
      assert.ok(count <= MAX_QUESTIONS, `${mode} asked ${count} questions, ceiling is ${MAX_QUESTIONS}`);
    }
  });

  await test("Wizard enforces answering in order and rejects skipping a required question", async () => {
    const wizard = new Wizard("build_feature");
    const first = wizard.nextQuestion()!;
    assert.equal(first.id, "description");
    assert.throws(() => wizard.answer("constraints", "x"), /answer in order/);
    assert.throws(() => wizard.answer("description", ""), /required and cannot be skipped/);
    wizard.answer("description", "a login page");
    assert.equal(wizard.nextQuestion()!.id, "constraints");
  });

  await test("Wizard.buildPlan() refuses to run before all required questions are answered", async () => {
    const engine = await freshEngine("wizard-refuse");
    const builder = new GraphBuilder(engine.memory, engine.taskHistory);
    const wizard = new Wizard("fix_issue");
    await assert.rejects(() => wizard.buildPlan(builder, { graphId: "g", projectId: "p" }), /Cannot build a plan/);
    engine.close();
  });

  await test("WizardPlan withholds the executable graph until confirm() — no code exposure in summary/steps", async () => {
    const engine = await freshEngine("wizard-plan");
    const builder = new GraphBuilder(engine.memory, engine.taskHistory);
    const wizard = new Wizard("build_feature");
    wizard.answer("description", "a password reset flow");
    wizard.answer("constraints", "");
    wizard.answer("testing_focus", "");
    const plan = await wizard.buildPlan(builder, { graphId: "g1", projectId: "p1" });

    assert.equal(plan.confirmed, false);
    assert.ok(plan.steps.length > 0);
    assert.ok(plan.summary.includes("password reset"));
    // The plan's public surface must never leak TaskPacket internals.
    const serialized = JSON.stringify(plan);
    assert.ok(!serialized.includes("node_type"), "plan serialization leaked node_type");
    assert.ok(!serialized.includes("dependencies"), "plan serialization leaked the dependency graph");

    const graph = plan.confirm();
    assert.ok(graph instanceof TaskGraph);
    assert.equal(plan.confirmed, true);

    const logs = await engine.run(graph, "sequential");
    assert.ok(logs.length > 0 && logs.every((l) => l.status === "success"));
    engine.close();
  });

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${passed} test(s) passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
