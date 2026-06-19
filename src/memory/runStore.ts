import fs from "fs";
import path from "path";

export interface StoredRunLog {
  runId: string;
  timestamp: number;
  nodeId: string;
  status: string;
  provider: string;
  cacheHit: boolean;
  cost: number;
  latencyMs: number;
  error?: string;
}

export class RunStore {
  private filePath: string;

  constructor(workDir: string) {
    const dir = path.join(workDir, ".forge");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.filePath = path.join(dir, "runs.jsonl");

    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "");
    }
  }

  append(log: StoredRunLog) {
    fs.appendFileSync(this.filePath, JSON.stringify(log) + "\n");
  }

  readAll(): StoredRunLog[] {
    const raw = fs.readFileSync(this.filePath, "utf-8");
    if (!raw.trim()) return [];

    return raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  }
}
