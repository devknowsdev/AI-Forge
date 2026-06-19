import { appendFile, mkdir, readFile } from 'fs/promises';
import { dirname } from 'path';
import type { LedgerEntry } from '../types/contracts';

const LEDGER_PATH = 'data/ledger.jsonl';

export class LedgerStore {
  async append(entry: LedgerEntry): Promise<void> {
    await mkdir(dirname(LEDGER_PATH), { recursive: true });
    await appendFile(LEDGER_PATH, JSON.stringify(entry) + '\n', 'utf8');
  }

  async list(): Promise<LedgerEntry[]> {
    try {
      const raw = await readFile(LEDGER_PATH, 'utf8');
      const entries: LedgerEntry[] = [];
      for (const line of raw.split('\n').filter(Boolean)) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          continue;
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  async getById(id: string): Promise<LedgerEntry | undefined> {
    const entries = await this.list();
    return entries.find(entry => entry.id === id);
  }
}

export const ledgerStore = new LedgerStore();