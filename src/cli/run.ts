import { ExecutionEngine } from "../engine/executionEngine.js";
import { TaskGraph } from "../taskGraph/graph.js";
import { GraphBuilder } from "../intelligence/graphBuilder.js";

export async function runCommand(intent: string) {
  // Bootstrap engine
  const engine = new ExecutionEngine({
    dbPath: "./forge.db",
    workDir: process.cwd(),
  });

  await engine.init();

  // Build graph from intent
  const builder = new GraphBuilder();
  const graph = builder.build(intent, {
    recentFailures: [],
    costBudget: { remaining: 100, tier: "local" },
    systemHints: { preferLocal: true },
  });

  // Execute
  const results = await engine.run(graph);

  // Output
  console.log(JSON.stringify(results, null, 2));

  engine.close();
}
