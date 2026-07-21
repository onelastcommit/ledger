import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoredEvent } from '../../src/types.js';
import {
  createHarness,
  customer,
  hasDatabase,
  order,
  uniqueStreamId,
  waitFor,
  type Harness,
} from './harness.js';

describe.skipIf(!hasDatabase)('catch-up subscriptions', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ entities: [order] });
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  const placed = { type: 'OrderPlaced', payload: { total: 10 }, actor: customer };
  const paid = { type: 'OrderPaid', payload: {}, actor: customer };

  async function seed(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const streamId = uniqueStreamId();
      ids.push(streamId);
      await h.ledger.withTransaction((tx) =>
        tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] }),
      );
    }
    return ids;
  }

  it('consumes a backlog and persists its cursor', async () => {
    await seed(5);
    const seen: StoredEvent[] = [];

    const subscription = h.ledger.subscribe({
      name: 'backlog-consumer',
      batchSize: 2,
      pollIntervalMs: 50,
      onEvent: (event) => {
        seen.push(event);
      },
    });

    try {
      await waitFor(() => seen.length === 5);
      expect(seen.map((event) => event.globalPosition)).toEqual([1, 2, 3, 4, 5]);

      await waitFor(async () => {
        const row = await h.pool.query<{ position: string }>(
          'SELECT position FROM ledger_subscriptions WHERE name = $1',
          ['backlog-consumer'],
        );
        return row.rows[0]?.position === '5';
      });
    } finally {
      await subscription.stop();
    }
  });

  it('resumes from its stored cursor after a restart', async () => {
    await seed(3);

    const first: StoredEvent[] = [];
    const one = h.ledger.subscribe({
      name: 'restarting-consumer',
      pollIntervalMs: 50,
      onEvent: (event) => {
        first.push(event);
      },
    });
    await waitFor(() => first.length === 3);
    await one.stop();

    await seed(2);

    const second: StoredEvent[] = [];
    const two = h.ledger.subscribe({
      name: 'restarting-consumer',
      pollIntervalMs: 50,
      onEvent: (event) => {
        second.push(event);
      },
    });
    try {
      await waitFor(() => second.length === 2);
      expect(second.map((event) => event.globalPosition)).toEqual([4, 5]);
    } finally {
      await two.stop();
    }
  });

  it('receives new events promptly, woken by NOTIFY', async () => {
    const seen: StoredEvent[] = [];
    const subscription = h.ledger.subscribe({
      name: 'live-consumer',
      pollIntervalMs: 30_000,
      onEvent: (event) => {
        seen.push(event);
      },
    });

    try {
      await subscription.caughtUp();
      expect(seen).toHaveLength(0);

      const streamId = uniqueStreamId();
      await h.ledger.withTransaction((tx) =>
        tx.append({ streamId, streamType: 'order', expectedSeq: 0, events: [placed] }),
      );

      await waitFor(() => seen.length === 1, { timeoutMs: 10_000 });
      expect(seen[0]?.streamId).toBe(streamId);
    } finally {
      await subscription.stop();
    }
  });

  it('filters by stream type', async () => {
    const orderId = uniqueStreamId();
    await h.ledger.withTransaction((tx) =>
      tx.append({ streamId: orderId, streamType: 'order', expectedSeq: 0, events: [placed] }),
    );
    await h.ledger.withTransaction((tx) =>
      tx.append({
        streamId: uniqueStreamId('audit'),
        streamType: 'audit',
        expectedSeq: 0,
        events: [{ type: 'Logged', payload: {}, actor: { kind: 'system' } }],
      }),
    );
    await h.ledger.withTransaction((tx) =>
      tx.append({ streamId: orderId, streamType: 'order', expectedSeq: 1, events: [paid] }),
    );

    const seen: StoredEvent[] = [];
    const subscription = h.ledger.subscribe({
      name: 'orders-only',
      streamTypes: ['order'],
      pollIntervalMs: 50,
      onEvent: (event) => {
        seen.push(event);
      },
    });

    try {
      await waitFor(() => seen.length === 2);
      expect(seen.map((event) => event.type)).toEqual(['OrderPlaced', 'OrderPaid']);
    } finally {
      await subscription.stop();
    }
  });

  it('retries a batch when a handler throws, delivering at least once', async () => {
    await seed(1);

    const attempts: string[] = [];
    const errors: unknown[] = [];
    let failuresLeft = 2;

    const subscription = h.ledger.subscribe({
      name: 'flaky-consumer',
      pollIntervalMs: 25,
      onEvent: (event) => {
        attempts.push(event.id);
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('transient');
        }
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    try {
      await waitFor(() => failuresLeft === 0 && attempts.length >= 3);
      expect(errors).toHaveLength(2);
      expect(new Set(attempts).size).toBe(1);

      await waitFor(async () => {
        const row = await h.pool.query<{ position: string }>(
          'SELECT position FROM ledger_subscriptions WHERE name = $1',
          ['flaky-consumer'],
        );
        return row.rows[0]?.position === '1';
      });
    } finally {
      await subscription.stop();
    }
  });

  it('can start from a given position instead of replaying everything', async () => {
    await seed(3);
    const seen: StoredEvent[] = [];

    const subscription = h.ledger.subscribe({
      name: 'late-joiner',
      startPosition: 2,
      pollIntervalMs: 50,
      onEvent: (event) => {
        seen.push(event);
      },
    });

    try {
      await waitFor(() => seen.length === 1);
      expect(seen[0]?.globalPosition).toBe(3);
    } finally {
      await subscription.stop();
    }
  });

  it('stop() is idempotent', async () => {
    const subscription = h.ledger.subscribe({
      name: 'stoppable',
      pollIntervalMs: 50,
      onEvent: () => undefined,
    });
    await subscription.caughtUp();
    await subscription.stop();
    await expect(subscription.stop()).resolves.toBeUndefined();
  });
});
