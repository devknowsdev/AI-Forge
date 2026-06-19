import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface RunRecord {
  runId: string;
  intent?: string;
  startedAt: number;
  finishedAt?: number;
  logs: any[];
}

export class RunStore {
  private baseDir: string;

  constructor(baseDir = "./runs") {
    this.baseDir = baseDir;
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  }

  createRun(intent?: string): RunRecord {
    const runId = crypto.randomUUID();

    return {
      runId,
      intent,
      startedAt: Date.now(),
      logs: []
    };
  }

  append(run: RunRecord, log: any) {
    run.logs.push(log);
  }

  finish(run: RunRecord) {
    run.finishedAt = Date.now();
    const file = path.join(this.baseDir, `${run.runId}.json`);
    fs.writeFileSync(file, JSON.stringify(run, null, 2));
    return file;
  }
}
