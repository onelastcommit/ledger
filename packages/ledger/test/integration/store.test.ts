import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  LedgerError,
  StreamNotFoundError,
  UnknownEventTypeError,
  VersionConflictError,
} from '../../src/errors';
import { foldState } from '../../src/domain/fsm';
import {
  createHarness,
  customer,
  hasDatabase,
  order,
  uniqueStreamId,
  type Harness,
} from './harness';

describe.skipIf(!hasDatabase)('PostgresEventStore', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.pool.query('DROP TABLE IF EXISTS test_side_table');
    await h?.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  const placed = { type: 'OrderPlaced', payload: { total: 100 }, actor: customer };

  describe('migrate', () => {
    it('is idempotent', async () => {
      await h.ledger.migrate();
      await h.ledger.migrate();
      const applied = await h.pool.query<{ count: string }>(
        "SELECT count(*) FROM ledger_migrations WHERE name = '001_init.sql'",
      );
      expect(applied.rows[0]?.count).toBe('1');
    });
  });

  describe('append and readStream', () => {
    it('round-trips an event with its provenance intact', async () => {
      const streamId = uniqueStreamId();
      const occurredAt = '2026-03-01T12:30:00.000Z';

      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId,
          streamType: 'order',
          expectedSeq: 0,
          events: [
            {
              type: 'OrderPlaced',
              payload: { total: 100, currency: 'GBP', items: ['a', 'b'] },
              actor: { kind: 'ai', model: 'claude-opus-4-8', version: '2026-01' },
              source: { form: 'checkout', attempt: 2 },
              occurredAt,
              payloadVersion: 3,
            },
          ],
        }),
      );

      const [event] = await h.ledger.readStream(streamId);
      expect(event).toMatchObject({
        streamId,
        streamType: 'order',
        seq: 1,
        type: 'OrderPlaced',
        payload: { total: 100, currency: 'GBP', items: ['a', 'b'] },
        actor: { kind: 'ai', model: 'claude-opus-4-8', version: '2026-01' },
        source: { form: 'checkout', attempt: 2 },
        payloadVersion: 3,
        occurredAt,
      });
      expect(event?.id).toHaveLength(26);
      expect(event?.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(event?.globalPosition).toBeGreaterThan(0);
    });

    it('keeps occurredAt and recordedAt distinct', async () => {
      const streamId = uniqueStreamId();
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId,
          streamType: 'order',
          expectedSeq: 0,
          events: [{ ...placed, occurredAt: '2020-01-01T00:00:00.000Z' }],
        }),
      );
      const [event] = await h.ledger.readStream(streamId);
      expect(event?.occurredAt).toBe('2020-01-01T00:00:00.000Z');
      expect(Date.parse(event?.recordedAt ?? '')).toBeGreaterThan(Date.parse('2025-01-01'));
    });

    it('defaults occurredAt to append time', async () => {
      const streamId = uniqueStreamId();
      const before = Date.now();
      await h.ledger.withTransaction((tx) =>
        tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] }),
      );
      const [event] = await h.ledger.readStream(streamId);
      expect(Date.parse(event?.occurredAt ?? '')).toBeGreaterThanOrEqual(before - 1000);
    });

    it('gives a batch consecutive seqs and a linked hash chain', async () => {
      const streamId = uniqueStreamId();
      const events = await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId,
          streamType: 'order',
          expectedSeq: 0,
          events: [
            placed,
            { type: 'OrderPaid', payload: { method: 'card' }, actor: customer },
            { type: 'OrderShipped', payload: { carrier: 'royal-mail' }, actor: customer },
          ],
        }),
      );

      expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
      expect(events.map((event) => event.globalPosition)).toEqual([1, 2, 3]);

      const stored = await h.ledger.readStream(streamId);
      expect(stored.map((event) => event.type)).toEqual([
        'OrderPlaced',
        'OrderPaid',
        'OrderShipped',
      ]);
      await expect(h.ledger.verifyStream(streamId)).resolves.toEqual({ valid: true });
    });

    it('continues seqs across separate appends', async () => {
      const streamId = uniqueStreamId();
      await h.ledger.withTransaction((tx) =>
        tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] }),
      );
      const second = await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId,
          streamType: 'order',
          expectedSeq: 1,
          events: [{ type: 'OrderPaid', payload: {}, actor: customer }],
        }),
      );
      expect(second[0]?.seq).toBe(2);
      await expect(h.ledger.verifyStream(streamId)).resolves.toEqual({ valid: true });
    });

    it('returns an empty array for an unknown stream', async () => {
      await expect(h.ledger.readStream('order:nobody')).resolves.toEqual([]);
    });

    it('rejects an empty batch', async () => {
      await expect(
        h.ledger.withTransaction((tx) =>
          tx.append({
            streamId: uniqueStreamId(),
            streamType: 'order',
            expectedSeq: 0,
            events: [],
          }),
        ),
      ).rejects.toThrow(LedgerError);
    });

    it('refuses to mix stream types on one stream', async () => {
      const streamId = uniqueStreamId();
      await h.ledger.withTransaction((tx) =>
        tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] }),
      );
      await expect(
        h.ledger.withTransaction((tx) =>
          tx.append({
            streamId,
            streamType: 'invoice',
            expectedSeq: 1,
            events: [{ type: 'Whatever', payload: {}, actor: customer }],
          }),
        ),
      ).rejects.toThrow(LedgerError);
    });
  });

  describe('optimistic concurrency', () => {
    it('rejects a stale expectedSeq', async () => {
      const streamId = uniqueStreamId();
      await h.ledger.withTransaction((tx) =>
        tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] }),
      );

      const attempt = h.ledger.withTransaction((tx) =>
        tx.append({
          streamId,
          streamType: 'order',
          expectedSeq: 0,
          events: [{ type: 'OrderPaid', payload: {}, actor: customer }],
        }),
      );

      await expect(attempt).rejects.toBeInstanceOf(VersionConflictError);
      await expect(attempt).rejects.toMatchObject({ expectedSeq: 0, actualSeq: 1 });
    });

    it('lets exactly one of two genuinely concurrent appends win', async () => {
      const streamId = uniqueStreamId();
      await h.ledger.withTransaction((tx) =>
        tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] }),
      );

      const attempt = async (method: string) => {
        const client = await h.pool.connect();
        try {
          await client.query('BEGIN');
          const events = await h.ledger.append(client, {
            streamId,
            streamType: 'order',
            expectedSeq: 1,
            events: [{ type: 'OrderPaid', payload: { method }, actor: customer }],
          });
          await client.query('COMMIT');
          return events;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      };

      const results = await Promise.allSettled([attempt('card'), attempt('cash')]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError);

      const stored = await h.ledger.readStream(streamId);
      expect(stored).toHaveLength(2);
      expect(stored.map((event) => event.seq)).toEqual([1, 2]);
      await expect(h.ledger.verifyStream(streamId)).resolves.toEqual({ valid: true });
    });

    it('rejects a negative expectedSeq', async () => {
      await expect(
        h.ledger.withTransaction((tx) =>
          tx.append({
            streamId: uniqueStreamId(),
            streamType: 'order',
            expectedSeq: -1,
            events: [placed],
          }),
        ),
      ).rejects.toThrow(LedgerError);
    });
  });

  describe('state machines', () => {
    it('rolls back an illegal transition', async () => {
      const streamId = uniqueStreamId();
      await h.ledger.withTransaction((tx) =>
        tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] }),
      );

      await expect(
        h.ledger.withTransaction((tx) =>
          tx.append({
            streamId,
            streamType: 'order',
            expectedSeq: 1,
            events: [{ type: 'OrderShipped', payload: {}, actor: customer }],
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidTransitionError);

      expect(await h.ledger.readStream(streamId)).toHaveLength(1);
      await expect(h.ledger.getState(streamId)).resolves.toEqual({ state: 'placed', seq: 1 });
    });

    it('validates across a batch in order, rejecting the whole append', async () => {
      const streamId = uniqueStreamId();
      await expect(
        h.ledger.withTransaction((tx) =>
          tx.append({
            streamId,
            streamType: 'order',
            expectedSeq: 0,
            events: [
              placed,
              { type: 'OrderPaid', payload: {}, actor: customer },
              { type: 'OrderPaid', payload: {}, actor: customer },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidTransitionError);

      expect(await h.ledger.readStream(streamId)).toEqual([]);
    });

    it('refuses events after a terminal state', async () => {
      const streamId = uniqueStreamId();
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId,
          streamType: 'order',
          expectedSeq: 0,
          events: [placed, { type: 'OrderCancelled', payload: {}, actor: customer }],
        }),
      );
      await expect(
        h.ledger.withTransaction((tx) =>
          tx.append({
            streamId,
            streamType: 'order',
            expectedSeq: 2,
            events: [{ type: 'OrderPaid', payload: {}, actor: customer }],
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidTransitionError);
    });

    it('rejects an event the entity does not declare', async () => {
      await expect(
        h.ledger.withTransaction((tx) =>
          tx.append({
            streamId: uniqueStreamId(),
            streamType: 'order',
            expectedSeq: 0,
            events: [{ type: 'OrderTeleported', payload: {}, actor: customer }],
          }),
        ),
      ).rejects.toBeInstanceOf(UnknownEventTypeError);
    });

    it('accepts any event for a stream type with no definition', async () => {
      const streamId = uniqueStreamId('audit');
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId,
          streamType: 'audit',
          expectedSeq: 0,
          events: [
            { type: 'AnythingAtAll', payload: { a: 1 }, actor: { kind: 'system' } },
            { type: 'SomethingElse', payload: { b: 2 }, actor: { kind: 'system' } },
          ],
        }),
      );
      expect(await h.ledger.readStream(streamId)).toHaveLength(2);
      await expect(h.ledger.getState(streamId)).resolves.toEqual({ state: null, seq: 2 });
    });
  });

  describe('getState', () => {
    it('matches a manual fold of the stream', async () => {
      const streamId = uniqueStreamId();
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId,
          streamType: 'order',
          expectedSeq: 0,
          events: [placed, { type: 'OrderPaid', payload: {}, actor: customer }],
        }),
      );

      const events = await h.ledger.readStream(streamId);
      const folded = foldState(
        order,
        events.map((event) => event.type),
        streamId,
      );

      const state = await h.ledger.getState(streamId);
      expect(state).toEqual({ state: folded, seq: events.length });
      expect(state.state).toBe('paid');
    });

    it('throws for an unknown stream', async () => {
      await expect(h.ledger.getState('order:nobody')).rejects.toBeInstanceOf(StreamNotFoundError);
    });
  });

  describe('readAll', () => {
    it('pages by global position and filters by stream type', async () => {
      const orderId = uniqueStreamId();
      const auditId = uniqueStreamId('audit');

      await h.ledger.withTransaction((tx) =>
        tx.append({ streamId: orderId, streamType: 'order', expectedSeq: 0, events: [placed] }),
      );
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId: auditId,
          streamType: 'audit',
          expectedSeq: 0,
          events: [{ type: 'Logged', payload: {}, actor: { kind: 'system' } }],
        }),
      );
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId: orderId,
          streamType: 'order',
          expectedSeq: 1,
          events: [{ type: 'OrderPaid', payload: {}, actor: customer }],
        }),
      );

      const all = await h.ledger.readAll();
      expect(all.map((event) => event.type)).toEqual(['OrderPlaced', 'Logged', 'OrderPaid']);

      const firstPage = await h.ledger.readAll({ limit: 2 });
      expect(firstPage).toHaveLength(2);
      const secondPage = await h.ledger.readAll({
        afterGlobalPosition: firstPage[1]?.globalPosition,
      });
      expect(secondPage.map((event) => event.type)).toEqual(['OrderPaid']);

      const ordersOnly = await h.ledger.readAll({ streamTypes: ['order'] });
      expect(ordersOnly.map((event) => event.type)).toEqual(['OrderPlaced', 'OrderPaid']);

      expect(await h.ledger.readAll({ streamTypes: ['nothing'] })).toEqual([]);
    });
  });

  describe('verifyStream', () => {
    it('detects a row corrupted behind the library’s back', async () => {
      const streamId = uniqueStreamId();
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId,
          streamType: 'order',
          expectedSeq: 0,
          events: [
            placed,
            { type: 'OrderPaid', payload: { method: 'card' }, actor: customer },
            { type: 'OrderShipped', payload: {}, actor: customer },
          ],
        }),
      );

      await expect(h.ledger.verifyStream(streamId)).resolves.toEqual({ valid: true });

      await h.pool.query('UPDATE ledger_events SET payload = $1 WHERE stream_id = $2 AND seq = 2', [
        JSON.stringify({ method: 'stolen-card' }),
        streamId,
      ]);

      await expect(h.ledger.verifyStream(streamId)).resolves.toEqual({
        valid: false,
        firstBadSeq: 2,
      });
    });

    it('detects a deleted event', async () => {
      const streamId = uniqueStreamId();
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId,
          streamType: 'order',
          expectedSeq: 0,
          events: [placed, { type: 'OrderPaid', payload: {}, actor: customer }],
        }),
      );

      await h.pool.query('DELETE FROM ledger_events WHERE stream_id = $1 AND seq = 1', [streamId]);

      await expect(h.ledger.verifyStream(streamId)).resolves.toEqual({
        valid: false,
        firstBadSeq: 2,
      });
    });

    it('throws for an unknown stream', async () => {
      await expect(h.ledger.verifyStream('order:nobody')).rejects.toBeInstanceOf(
        StreamNotFoundError,
      );
    });
  });

  describe('withTransaction', () => {
    it('commits the caller’s own SQL alongside the append', async () => {
      const streamId = uniqueStreamId();
      await h.pool.query('CREATE TABLE IF NOT EXISTS test_side_table (stream_id TEXT PRIMARY KEY)');
      await h.pool.query('DELETE FROM test_side_table');

      await h.ledger.withTransaction(async (tx) => {
        await tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] });
        await tx.client.query('INSERT INTO test_side_table (stream_id) VALUES ($1)', [streamId]);
      });

      const side = await h.pool.query('SELECT stream_id FROM test_side_table');
      expect(side.rows).toEqual([{ stream_id: streamId }]);
    });

    it('rolls the append back when the caller’s own SQL fails', async () => {
      const streamId = uniqueStreamId();
      await expect(
        h.ledger.withTransaction(async (tx) => {
          await tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] });
          throw new Error('caller changed their mind');
        }),
      ).rejects.toThrow('caller changed their mind');

      expect(await h.ledger.readStream(streamId)).toEqual([]);
    });

    it('exposes reads inside the open transaction', async () => {
      const streamId = uniqueStreamId();
      const seen = await h.ledger.withTransaction(async (tx) => {
        await tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] });
        return { events: await tx.readStream(streamId), state: await tx.getState(streamId) };
      });
      expect(seen.events).toHaveLength(1);
      expect(seen.state).toEqual({ state: 'placed', seq: 1 });
    });
  });
});
