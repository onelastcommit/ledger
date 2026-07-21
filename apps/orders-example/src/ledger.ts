import pg from 'pg';
import { createLedger, defineEntity, type Projection } from '@ahmadalmezaal/ledger';

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

const orderSummary: Projection = {
  name: 'order-summary',
  handles: ['OrderPlaced', 'OrderPaid', 'OrderShipped', 'OrderCancelled'],
  async apply(tx, event) {
    await tx.client.query(
      `INSERT INTO order_summary (order_id, status, last_actor, updated_seq)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id) DO UPDATE
         SET status = EXCLUDED.status,
             last_actor = EXCLUDED.last_actor,
             updated_seq = EXCLUDED.updated_seq`,
      [event.streamId, event.type, JSON.stringify(event.actor), event.seq],
    );
  },
};

export const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });

export const ledger = createLedger({
  pool,
  entities: [order],
  projections: [orderSummary],
});

export const setupReadModel = async (): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_summary (
      order_id    TEXT PRIMARY KEY,
      status      TEXT NOT NULL,
      last_actor  JSONB NOT NULL,
      updated_seq INTEGER NOT NULL
    )`);
};
