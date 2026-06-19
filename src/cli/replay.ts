import { RunStore } from "../memory/runStore.js";

export async function replayCommand(runId: string) {
  const store = new RunStore(process.cwd());
  const logs = store.readAll().filter((l) => l.runId === runId);

  if (logs.length === 0) {
    console.log(JSON.stringify({ error: "runId not found" }, null, 2));
    return;
  }

  // Sort by timestamp to reconstruct execution order
  const ordered = logs.sort((a, b) => a.timestamp - b.timestamp);

  const simulation = ordered.map((l, idx) => ({
    step: idx + 1,
    nodeId: l.nodeId,
    status: l.status,
    provider: l.provider,
    cost: l.cost,
    latencyMs: l.latencyMs,
    cacheHit: l.cacheHit,
    timestamp: l.timestamp
  }));

  const summary = {
    runId,
    totalNodes: ordered.length,
    success: ordered.filter(l => l.status === "success").length,
    failed: ordered.filter(l => l.status === "failed").length,
    totalCost: ordered.reduce((s, l) => s + (l.cost || 0), 0),
    avgLatencyMs: ordered.length
      ? ordered.reduce((s, l) => s + (l.latencyMs || 0), 0) / ordered.length
      : 0
  };

  console.log(JSON.stringify({ summary, simulation }, null, 2));
}
