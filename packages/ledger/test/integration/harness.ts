import pg from 'pg';
import { inject } from 'vitest';
import { defineEntity } from '../../src/fsm.js';
import { createLedger, type Ledger, type LedgerConfig } from '../../src/store.js';
import type { Actor } from '../../src/types.js';

export const databaseUrl = inject('databaseUrl');
export const hasDatabase = databaseUrl !== null;

export const order = defineEntity({
  streamType: 'order',
  initial: 'placed',
  states: ['placed', 'paid', 'shipped', 'cancelled'],
  events: {
    OrderPlaced: { from: [null], to: 'placed' },
    OrderPaid: { from: ['placed'], to: 'paid' },
    OrderShipped: { from: ['paid'], to: 'shipped', terminal: true },
    OrderCancelled: { from: ['placed', 'paid'], to: 'cancelled', terminal: true },
  },
});

export const customer: Actor = { kind: 'user', id: 'customer-1', role: 'buyer' };

export interface Harness {
  pool: pg.Pool;
  ledger: Ledger;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createHarness(
  config: Omit<LedgerConfig, 'pool'> = { entities: [order] },
): Promise<Harness> {
  if (databaseUrl === null) throw new Error('No database available.');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const ledger = createLedger({ pool, ...config });
  await ledger.migrate();

  return {
    pool,
    ledger,
    async reset() {
      await pool.query(
        'TRUNCATE ledger_events, ledger_streams, ledger_subscriptions RESTART IDENTITY',
      );
    },
    async close() {
      await pool.end();
    },
  };
}

export function uniqueStreamId(prefix = 'order'): string {
  return `${prefix}:${Math.random().toString(36).slice(2, 10)}`;
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 25 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
