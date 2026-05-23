import type { TransactionDataSource } from './types.js';

const sources = new Map<string, TransactionDataSource>();

export function registerDataSource(source: TransactionDataSource): void {
  sources.set(source.id, source);
}

export function getDataSource(id: string): TransactionDataSource | undefined {
  return sources.get(id);
}

export function listDataSources(): TransactionDataSource[] {
  return [...sources.values()];
}
