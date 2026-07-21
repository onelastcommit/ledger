import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoredEvent } from '../../src/types';
import { createHarness, customer, hasDatabase, order, uniqueStreamId, type Harness } from './harness';

describe.skipIf(!hasDatabase)('streaming iteration', () => {
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

  const seedLog = async (streamId: string, count: number, streamType = 'log'): Promise<void> => {
    const events = Array.from({ length: count }, (_, i) => ({
      type: 'Logged',
      payload: { i },
      actor: { kind: 'system' as const },
    }));
    await h.ledger.withTransaction((tx) =>
      tx.append({ streamId, streamType, expectedSeq: 0, events }),
    );
  };

  const drain = async (source: AsyncGenerator<StoredEvent[]>): Promise<StoredEvent[][]> => {
    const batches: StoredEvent[][] = [];
    for await (const batch of source) batches.push(batch);
    return batches;
  };

  describe('iterateAll', () => {
    it('walks the whole log in batches without repeating or dropping events', async () => {
      await seedLog(uniqueStreamId('log'), 250);

      const batches = await drain(h.ledger.iterateAll({ batchSize: 100 }));
      const positions = batches.flat().map((event) => event.globalPosition);

      expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
      expect(positions).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
      expect(new Set(positions).size).toBe(250);
    });

    it('terminates on an empty log', async () => {
      expect(await drain(h.ledger.iterateAll({ batchSize: 10 }))).toEqual([]);
    });

    it('stops cleanly when the total is an exact multiple of the batch size', async () => {
      await seedLog(uniqueStreamId('log'), 60);
      const batches = await drain(h.ledger.iterateAll({ batchSize: 20 }));
      expect(batches.map((batch) => batch.length)).toEqual([20, 20, 20]);
    });

    it('honours the starting position and the stream type filter', async () => {
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId: uniqueStreamId(),
          streamType: 'order',
          expectedSeq: 0,
          events: [placed],
        }),
      );
      await seedLog(uniqueStreamId('log'), 5);

      const fromSecond = await drain(h.ledger.iterateAll({ afterGlobalPosition: 1, batchSize: 2 }));
      expect(fromSecond.flat().map((event) => event.globalPosition)).toEqual([2, 3, 4, 5, 6]);

      const ordersOnly = await drain(h.ledger.iterateAll({ streamTypes: ['order'], batchSize: 2 }));
      expect(ordersOnly.flat().map((event) => event.type)).toEqual(['OrderPlaced']);
    });

    it('can be abandoned part way through', async () => {
      await seedLog(uniqueStreamId('log'), 100);

      const seen: StoredEvent[] = [];
      for await (const batch of h.ledger.iterateAll({ batchSize: 10 })) {
        seen.push(...batch);
        if (seen.length >= 20) break;
      }
      expect(seen).toHaveLength(20);
    });
  });

  describe('iterateStream', () => {
    it('walks one stream in batches', async () => {
      const streamId = uniqueStreamId('log');
      await seedLog(streamId, 45);

      const batches = await drain(h.ledger.iterateStream(streamId, { batchSize: 20 }));
      expect(batches.map((batch) => batch.length)).toEqual([20, 20, 5]);
      expect(batches.flat().map((event) => event.seq)).toEqual(
        Array.from({ length: 45 }, (_, i) => i + 1),
      );
    });

    it('yields nothing for an unknown stream', async () => {
      expect(await drain(h.ledger.iterateStream('log:nobody'))).toEqual([]);
    });

    it('covers only the requested stream', async () => {
      const wanted = uniqueStreamId('log');
      await seedLog(wanted, 10);
      await seedLog(uniqueStreamId('log'), 10);

      const events = (await drain(h.ledger.iterateStream(wanted, { batchSize: 4 }))).flat();
      expect(events).toHaveLength(10);
      expect(events.every((event) => event.streamId === wanted)).toBe(true);
    });
  });
});
