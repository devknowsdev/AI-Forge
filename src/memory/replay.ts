import { ledgerStore } from './ledgerStore';
import type { LedgerEntry } from '../types/contracts';

export async function replayExecution(id: string): Promise<LedgerEntry | undefined> {
  return ledgerStore.getById(id);
}

export async function replayLatest(limit = 10): Promise<LedgerEntry[]> {
  const entries = await ledgerStore.list();
  return entries.slice(-limit);
}
