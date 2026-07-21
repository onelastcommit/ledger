import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StreamNotFoundError } from '../../src/errors';
import {
  createHarness,
  customer,
  hasDatabase,
  order,
  uniqueStreamId,
  waitFor,
  type Harness,
} from './harness';

describe.skipIf(!hasDatabase)('maintenance and observability', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ entities: [order] });
  });
  afterAll(async () => {
    await h?.ledger.close();
    await h?.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  const placed = { type: 'OrderPlaced', payload: { total: 10 }, actor: customer };
  const paid = { type: 'OrderPaid', payload: {}, actor: customer };

  const seedOrder = async (streamId: string): Promise<void> => {
    await h.ledger.withTransaction((tx) =>
      tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed, paid] }),
    );
  };

  describe('readStream paging', () => {
    it('pages a stream by seq', async () => {
      const streamId = uniqueStreamId('log');
      const events = Array.from({ length: 25 }, (_, i) => ({
        type: 'Logged',
        payload: { i },
        actor: { kind: 'system' as const },
      }));
      await h.ledger.withTransaction((tx) =>
        tx.append({ streamId, streamType: 'log', expectedSeq: 0, events }),
      );

      const firstPage = await h.ledger.readStream(streamId, { limit: 10 });
      expect(firstPage.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      const secondPage = await h.ledger.readStream(streamId, { afterSeq: 10, limit: 10 });
      expect(secondPage.map((event) => event.seq)).toEqual([
        11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);

      const lastPage = await h.ledger.readStream(streamId, { afterSeq: 20, limit: 10 });
      expect(lastPage.map((event) => event.seq)).toEqual([21, 22, 23, 24, 25]);

      expect(await h.ledger.readStream(streamId, { afterSeq: 25 })).toEqual([]);
    });

    it('reads to the end when no limit is given', async () => {
      const streamId = uniqueStreamId();
      await seedOrder(streamId);
      expect(await h.ledger.readStream(streamId)).toHaveLength(2);
    });

    it('verifies a stream longer than one verification batch', async () => {
      const streamId = uniqueStreamId('log');
      const events = Array.from({ length: 2500 }, (_, i) => ({
        type: 'Logged',
        payload: { i },
        actor: { kind: 'system' as const },
      }));
      await h.ledger.withTransaction((tx) =>
        tx.append({ streamId, streamType: 'log', expectedSeq: 0, events }),
      );

      await expect(h.ledger.verifyStream(streamId)).resolves.toEqual({ valid: true });

      await h.pool.query(
        'UPDATE ledger_events SET payload = $1 WHERE stream_id = $2 AND seq = 1800',
        [JSON.stringify({ tampered: true }), streamId],
      );

      await expect(h.ledger.verifyStream(streamId)).resolves.toEqual({
        valid: false,
        firstBadSeq: 1800,
      });
    });
  });

  describe('rebuildStream', () => {
    it('is a no-op when the cache already agrees with the log', async () => {
      const streamId = uniqueStreamId();
      await seedOrder(streamId);

      const report = await h.ledger.rebuildStream(streamId);
      expect(report).toMatchObject({
        streamId,
        streamType: 'order',
        lastSeq: 2,
        state: 'paid',
        changed: false,
      });
    });

    it('repairs a corrupted cache row', async () => {
      const streamId = uniqueStreamId();
      await seedOrder(streamId);

      await h.pool.query(
        "UPDATE ledger_streams SET last_seq = 99, state = 'shipped', last_hash = 'wrong' WHERE stream_id = $1",
        [streamId],
      );
      expect(await h.ledger.getState(streamId)).toEqual({ state: 'shipped', seq: 99 });

      const report = await h.ledger.rebuildStream(streamId);
      expect(report.changed).toBe(true);
      expect(await h.ledger.getState(streamId)).toEqual({ state: 'paid', seq: 2 });
    });

    it('recreates a cache row deleted entirely, restoring appendability', async () => {
      const streamId = uniqueStreamId();
      await seedOrder(streamId);
      await h.pool.query('DELETE FROM ledger_streams WHERE stream_id = $1', [streamId]);

      await expect(h.ledger.getState(streamId)).rejects.toBeInstanceOf(StreamNotFoundError);

      await h.ledger.rebuildStream(streamId);
      expect(await h.ledger.getState(streamId)).toEqual({ state: 'paid', seq: 2 });

      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId,
          streamType: 'order',
          expectedSeq: 2,
          events: [{ type: 'OrderShipped', payload: {}, actor: customer }],
        }),
      );
      await expect(h.ledger.verifyStream(streamId)).resolves.toEqual({ valid: true });
    });

    it('throws for a stream with no events', async () => {
      await expect(h.ledger.rebuildStream('order:nobody')).rejects.toBeInstanceOf(
        StreamNotFoundError,
      );
    });

    it('rebuilds every stream and reports how many changed', async () => {
      const a = uniqueStreamId();
      const b = uniqueStreamId();
      await seedOrder(a);
      await seedOrder(b);
      await h.pool.query('UPDATE ledger_streams SET last_seq = 99 WHERE stream_id = $1', [a]);

      const report = await h.ledger.rebuildAllStreams();
      expect(report.streams).toBe(2);
      expect(report.changed).toBe(1);
      expect(await h.ledger.getState(a)).toEqual({ state: 'paid', seq: 2 });
    });
  });

  describe('subscription status', () => {
    it('reports lag against the head and clears once caught up', async () => {
      for (let i = 0; i < 3; i += 1) {
        await h.ledger.withTransaction((tx) =>
          tx.append({
            streamId: uniqueStreamId(),
            streamType: 'order',
            expectedSeq: 0,
            events: [placed],
          }),
        );
      }

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const subscription = h.ledger.subscribe({
        name: 'lagging',
        pollIntervalMs: 25,
        batchSize: 1,
        onEvent: async () => {
          await gate;
        },
      });

      try {
        await waitFor(async () => (await subscription.status()).headPosition === 3);
        const behind = await subscription.status();
        expect(behind.headPosition).toBe(3);
        expect(behind.position).toBe(0);
        expect(behind.lag).toBe(3);
        expect(behind.deadLettered).toBe(0);

        release();
        await waitFor(async () => (await subscription.status()).lag === 0);
        expect(await subscription.status()).toMatchObject({ position: 3, lag: 0, active: true });
      } finally {
        release();
        await subscription.stop();
      }
    });

    it('counts only matching stream types', async () => {
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId: uniqueStreamId(),
          streamType: 'order',
          expectedSeq: 0,
          events: [placed],
        }),
      );
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId: uniqueStreamId('audit'),
          streamType: 'audit',
          expectedSeq: 0,
          events: [{ type: 'Logged', payload: {}, actor: { kind: 'system' } }],
        }),
      );

      const subscription = h.ledger.subscribe({
        name: 'orders-lag',
        streamTypes: ['order'],
        pollIntervalMs: 30_000,
        startPosition: 0,
        onEvent: () => undefined,
      });

      try {
        const status = await subscription.status();
        expect(status.lag).toBeLessThanOrEqual(1);
        expect(status.headPosition).toBe(1);
      } finally {
        await subscription.stop();
      }
    });

    it('reports dead-lettered events', async () => {
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId: uniqueStreamId(),
          streamType: 'order',
          expectedSeq: 0,
          events: [placed],
        }),
      );

      const subscription = h.ledger.subscribe({
        name: 'always-fails',
        pollIntervalMs: 25,
        maxRetries: 0,
        retryBaseMs: 1,
        onEvent: () => {
          throw new Error('nope');
        },
        onError: () => undefined,
      });

      try {
        await waitFor(async () => (await subscription.status()).deadLettered === 1);
        expect(await subscription.status()).toMatchObject({ deadLettered: 1, lag: 0 });
      } finally {
        await subscription.stop();
      }
    });
  });
});
