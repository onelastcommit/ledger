import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_EVENTS_PER_STATEMENT } from '../../src/repositories/event.repository';
import type { DeadLetter } from '../../src/services/subscription.types';
import type { StoredEvent } from '../../src/types';
import {
  createHarness,
  customer,
  hasDatabase,
  order,
  uniqueStreamId,
  waitFor,
  type Harness,
} from './harness';

describe.skipIf(!hasDatabase)('resilience', () => {
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

  describe('large appends', () => {
    it('derives the chunk size from the bind-parameter limit', () => {
      expect(MAX_EVENTS_PER_STATEMENT).toBe(5957);
    });

    it('appends a batch larger than one statement can bind', async () => {
      const streamId = uniqueStreamId('bulk');
      const count = MAX_EVENTS_PER_STATEMENT + 250;
      const events = Array.from({ length: count }, (_, i) => ({
        type: 'Logged',
        payload: { i },
        actor: { kind: 'system' as const },
      }));

      const written = await h.ledger.withTransaction((tx) =>
        tx.append({ streamId, streamType: 'bulk', expectedSeq: 0, events }),
      );

      expect(written).toHaveLength(count);
      expect(written[0]?.seq).toBe(1);
      expect(written.at(-1)?.seq).toBe(count);

      const stored = await h.ledger.readStream(streamId);
      expect(stored).toHaveLength(count);
      expect(stored.map((event) => event.seq)).toEqual(
        Array.from({ length: count }, (_, i) => i + 1),
      );
      await expect(h.ledger.verifyStream(streamId)).resolves.toEqual({ valid: true });
    });

    it('rolls the whole oversized batch back when one event is invalid', async () => {
      const streamId = uniqueStreamId();
      const events = Array.from({ length: MAX_EVENTS_PER_STATEMENT + 10 }, () => placed);

      await expect(
        h.ledger.withTransaction((tx) =>
          tx.append({ streamId, streamType: 'order', expectedSeq: 0, events }),
        ),
      ).rejects.toThrow();

      expect(await h.ledger.readStream(streamId)).toEqual([]);
    });
  });

  describe('poison events', () => {
    it('retries with backoff, then dead-letters and moves on', async () => {
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId: uniqueStreamId(),
          streamType: 'order',
          expectedSeq: 0,
          events: [placed],
        }),
      );
      const goodStreamId = uniqueStreamId();
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId: goodStreamId,
          streamType: 'order',
          expectedSeq: 0,
          events: [placed],
        }),
      );

      const handled: string[] = [];
      const deadLettered: DeadLetter[] = [];
      let attempts = 0;

      const subscription = h.ledger.subscribe({
        name: 'poison-consumer',
        pollIntervalMs: 25,
        maxRetries: 2,
        retryBaseMs: 5,
        onEvent: (event) => {
          if (event.globalPosition === 1) {
            attempts += 1;
            throw new Error('always fails');
          }
          handled.push(event.streamId);
        },
        onError: () => undefined,
        onDeadLetter: (deadLetter) => deadLettered.push(deadLetter),
      });

      try {
        await waitFor(() => handled.length === 1);

        expect(attempts).toBe(3);
        expect(deadLettered).toHaveLength(1);
        expect(deadLettered[0]?.attempts).toBe(3);
        expect(handled).toEqual([goodStreamId]);

        const failures = await h.pool.query<{
          subscription_name: string;
          global_position: string;
          attempts: number;
          error: string;
        }>(
          'SELECT subscription_name, global_position, attempts, error FROM ledger_subscription_failures',
        );
        expect(failures.rows).toHaveLength(1);
        expect(failures.rows[0]).toMatchObject({
          subscription_name: 'poison-consumer',
          global_position: '1',
          attempts: 3,
        });
        expect(failures.rows[0]?.error).toContain('always fails');

        await waitFor(() => subscription.position() === 2);
      } finally {
        await subscription.stop();
      }
    });

    it('halts at the poison event under the stop policy', async () => {
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

      const handled: number[] = [];
      const subscription = h.ledger.subscribe({
        name: 'halting-consumer',
        pollIntervalMs: 25,
        maxRetries: 0,
        retryBaseMs: 5,
        deadLetterPolicy: 'stop',
        onEvent: (event) => {
          if (event.globalPosition === 2) throw new Error('poison');
          handled.push(event.globalPosition);
        },
        onError: () => undefined,
      });

      try {
        await waitFor(async () => {
          const row = await h.pool.query<{ position: string }>(
            'SELECT position FROM ledger_subscriptions WHERE name = $1',
            ['halting-consumer'],
          );
          return row.rows[0]?.position === '1';
        });

        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(handled).toEqual([1]);
      } finally {
        await subscription.stop();
      }
    });
  });

  describe('connection use', () => {
    it('shares one listener connection across many subscriptions', async () => {
      const before = h.pool.totalCount;

      const subscriptions = await Promise.all(
        Array.from({ length: 5 }, async (_, i) => {
          const subscription = h.ledger.subscribe({
            name: `sharer-${i}`,
            pollIntervalMs: 50,
            onEvent: () => undefined,
          });
          await subscription.caughtUp();
          return subscription;
        }),
      );

      try {
        const seen: StoredEvent[] = [];
        const watcher = h.ledger.subscribe({
          name: 'sharer-watcher',
          pollIntervalMs: 30_000,
          onEvent: (event) => {
            seen.push(event);
          },
        });
        await watcher.caughtUp();

        expect(h.pool.totalCount).toBeLessThan(before + 5);

        await h.ledger.withTransaction((tx) =>
          tx.append({
            streamId: uniqueStreamId(),
            streamType: 'order',
            expectedSeq: 0,
            events: [placed],
          }),
        );

        await waitFor(() => seen.length === 1, { timeoutMs: 10_000 });
        await watcher.stop();
      } finally {
        await Promise.all(subscriptions.map((subscription) => subscription.stop()));
      }
    });
  });

  describe('single runner', () => {
    it('lets only one of two runners with the same name be active', async () => {
      await h.ledger.withTransaction((tx) =>
        tx.append({
          streamId: uniqueStreamId(),
          streamType: 'order',
          expectedSeq: 0,
          events: [placed],
        }),
      );

      const other = await createHarness({ entities: [order] });
      const seenA: number[] = [];
      const seenB: number[] = [];

      const a = h.ledger.subscribe({
        name: 'exclusive',
        singleRunner: true,
        pollIntervalMs: 25,
        onEvent: (event) => {
          seenA.push(event.globalPosition);
        },
      });
      await a.caughtUp();

      const b = other.ledger.subscribe({
        name: 'exclusive',
        singleRunner: true,
        pollIntervalMs: 25,
        onEvent: (event) => {
          seenB.push(event.globalPosition);
        },
      });
      await b.caughtUp();

      try {
        expect(a.isActive()).toBe(true);
        expect(b.isActive()).toBe(false);
        expect(seenA).toEqual([1]);
        expect(seenB).toEqual([]);
      } finally {
        await a.stop();
        await b.stop();
        await other.ledger.close();
        await other.close();
      }
    });

    it('hands over once the holder stops', async () => {
      const other = await createHarness({ entities: [order] });
      const seenB: number[] = [];

      const a = h.ledger.subscribe({
        name: 'failover',
        singleRunner: true,
        pollIntervalMs: 25,
        onEvent: () => undefined,
      });
      await a.caughtUp();

      const b = other.ledger.subscribe({
        name: 'failover',
        singleRunner: true,
        pollIntervalMs: 25,
        onEvent: (event) => {
          seenB.push(event.globalPosition);
        },
      });
      await b.caughtUp();
      expect(b.isActive()).toBe(false);

      try {
        await a.stop();
        await h.ledger.withTransaction((tx) =>
          tx.append({
            streamId: uniqueStreamId(),
            streamType: 'order',
            expectedSeq: 0,
            events: [placed],
          }),
        );

        await waitFor(() => b.isActive() && seenB.length === 1, { timeoutMs: 10_000 });
      } finally {
        await b.stop();
        await other.ledger.close();
        await other.close();
      }
    });
  });
});
