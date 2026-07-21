import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectionFailedError } from '../../src/errors';
import type { Projection } from '../../src/services/projection.types';
import { createHarness, customer, hasDatabase, order, uniqueStreamId, type Harness } from './harness';

const ordersProjection: Projection = {
  name: 'orders',
  handles: ['OrderPlaced', 'OrderPaid', 'OrderShipped', 'OrderCancelled'],
  async apply(tx, event) {
    const total = (event.payload as { total?: number }).total ?? null;
    await tx.client.query(
      `INSERT INTO read_orders (stream_id, status, total, updated_seq)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (stream_id) DO UPDATE
         SET status = EXCLUDED.status,
             total = COALESCE(EXCLUDED.total, read_orders.total),
             updated_seq = EXCLUDED.updated_seq`,
      [event.streamId, event.type, total, event.seq],
    );
  },
};

const everythingCounter: Projection = {
  name: 'counter',
  handles: ['*'],
  async apply(tx) {
    await tx.client.query('UPDATE read_counter SET seen = seen + 1');
  },
};

const explodes: Projection = {
  name: 'explodes',
  handles: ['OrderPaid'],
  apply() {
    throw new Error('read model is on fire');
  },
};

describe.skipIf(!hasDatabase)('inline projections', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({
      entities: [order],
      projections: [ordersProjection, everythingCounter, explodes],
    });
    await h.pool.query(`
      CREATE TABLE IF NOT EXISTS read_orders (
        stream_id   TEXT PRIMARY KEY,
        status      TEXT NOT NULL,
        total       NUMERIC,
        updated_seq INTEGER NOT NULL
      )`);
    await h.pool.query('CREATE TABLE IF NOT EXISTS read_counter (seen INTEGER NOT NULL)');
  });

  afterAll(async () => {
    await h?.pool.query('DROP TABLE IF EXISTS read_orders, read_counter');
    await h?.close();
  });

  beforeEach(async () => {
    await h.reset();
    await h.pool.query('DELETE FROM read_orders');
    await h.pool.query('DELETE FROM read_counter');
    await h.pool.query('INSERT INTO read_counter (seen) VALUES (0)');
  });

  const placed = { type: 'OrderPlaced', payload: { total: 250 }, actor: customer };

  it('commits the read model atomically with the append', async () => {
    const streamId = uniqueStreamId();
    await h.ledger.withTransaction((tx) =>
      tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] }),
    );

    const rows = await h.pool.query('SELECT stream_id, status, total, updated_seq FROM read_orders');
    expect(rows.rows).toEqual([
      { stream_id: streamId, status: 'OrderPlaced', total: '250', updated_seq: 1 },
    ]);
  });

  it('applies a batch in event order', async () => {
    const streamId = uniqueStreamId();
    await h.ledger.withTransaction((tx) =>
      tx.append({
        streamId,
        streamType: 'order',
        expectedSeq: 0,
        events: [placed, { type: 'OrderCancelled', payload: {}, actor: customer }],
      }),
    );
    expect(await h.ledger.getState(streamId)).toEqual({ state: 'cancelled', seq: 2 });

    const rows = await h.pool.query('SELECT status, updated_seq FROM read_orders');
    expect(rows.rows).toEqual([{ status: 'OrderCancelled', updated_seq: 2 }]);
  });

  it('runs wildcard projections for every event type', async () => {
    await h.ledger.withTransaction((tx) =>
      tx.append({
        streamId: uniqueStreamId('audit'),
        streamType: 'audit',
        expectedSeq: 0,
        events: [
          { type: 'Logged', payload: {}, actor: { kind: 'system' } },
          { type: 'AlsoLogged', payload: {}, actor: { kind: 'system' } },
        ],
      }),
    );
    const counter = await h.pool.query<{ seen: number }>('SELECT seen FROM read_counter');
    expect(counter.rows[0]?.seen).toBe(2);
  });

  it('rolls the append back when a projection throws', async () => {
    const streamId = uniqueStreamId();
    await h.ledger.withTransaction((tx) =>
      tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] }),
    );

    const attempt = h.ledger.withTransaction((tx) =>
      tx.append({
        streamId,
        streamType: 'order',
        expectedSeq: 1,
        events: [{ type: 'OrderPaid', payload: {}, actor: customer }],
      }),
    );

    await expect(attempt).rejects.toBeInstanceOf(ProjectionFailedError);
    await expect(attempt).rejects.toMatchObject({
      projectionName: 'explodes',
      eventType: 'OrderPaid',
    });

    expect(await h.ledger.readStream(streamId)).toHaveLength(1);
    expect(await h.ledger.getState(streamId)).toEqual({ state: 'placed', seq: 1 });

    const rows = await h.pool.query<{ status: string }>('SELECT status FROM read_orders');
    expect(rows.rows[0]?.status).toBe('OrderPlaced');

    const counter = await h.pool.query<{ seen: number }>('SELECT seen FROM read_counter');
    expect(counter.rows[0]?.seen).toBe(1);
  });

  it('preserves the original error as the cause', async () => {
    const streamId = uniqueStreamId();
    await h.ledger.withTransaction((tx) =>
      tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] }),
    );

    await h.ledger
      .withTransaction((tx) =>
        tx.append({
          streamId,
          streamType: 'order',
          expectedSeq: 1,
          events: [{ type: 'OrderPaid', payload: {}, actor: customer }],
        }),
      )
      .catch((error: unknown) => {
        expect((error as ProjectionFailedError).cause).toMatchObject({
          message: 'read model is on fire',
        });
      });
  });
});
