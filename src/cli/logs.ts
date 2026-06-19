import { RunStore } from "../memory/runStore.js";

export async function logsCommand(runId?: string) {
  const store = new RunStore(process.cwd());
  const logs = store.readAll();

  if (!runId) {
    const grouped = logs.reduce<Record<string, any[]>>((acc, log) => {
      acc[log.runId] = acc[log.runId] || [];
      acc[log.runId].push(log);
      return acc;
    }, {});

    console.log(JSON.stringify(grouped, null, 2));
    return;
  }

  const filtered = logs.filter((l) => l.runId === runId);

  if (filtered.length === 0) {
    console.log(JSON.stringify({ error: "runId not found" }, null, 2));
    return;
  }

  console.log(
    JSON.stringify(
      {
        runId,
        nodes: filtered,
        summary: {
          total: filtered.length,
          success: filtered.filter((l) => l.status === "success").length,
          failed: filtered.filter((l) => l.status === "failed").length,
        },
      },
      null,
      2
    )
  );
}
