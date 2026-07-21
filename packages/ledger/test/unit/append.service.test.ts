import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEntityRegistry, defineEntity } from '../../src/domain/fsm';
import { hashEvent } from '../../src/domain/hash';
import { isUlid } from '../../src/domain/ulid';
import {
  InvalidTransitionError,
  LedgerError,
  ProjectionFailedError,
  UnknownEventTypeError,
  VersionConflictError,
} from '../../src/errors';
import { AppendService } from '../../src/services/append.service';
import { ProjectionService } from '../../src/services/projection.service';
import type { Projection } from '../../src/services/projection.types';
import type { Actor } from '../../src/types';
import {
  createFakeState,
  fakeClient,
  fakeEventRepository,
  fakeStreamRepository,
  type FakeState,
} from './fakes';

const order = defineEntity({
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

const actor: Actor = { kind: 'system' };
const placed = { type: 'OrderPlaced', payload: { total: 10 }, actor };
const paid = { type: 'OrderPaid', payload: {}, actor };

describe('AppendService (no database)', () => {
  let state: FakeState;

  const build = (projections: Projection[] = []): AppendService =>
    new AppendService({
      events: fakeEventRepository(state),
      streams: fakeStreamRepository(state),
      projections: new ProjectionService(projections),
      entities: buildEntityRegistry([order]),
      notifyChannel: 'ledger_events',
    });

  beforeEach(() => {
    state = createFakeState();
  });

  it('assigns ULIDs, consecutive seqs and global positions', async () => {
    const events = await build().append(fakeClient(), {
      streamId: 'order:1',
      streamType: 'order',
      expectedSeq: 0,
      events: [placed, paid],
    });

    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events.map((event) => event.globalPosition)).toEqual([1, 2]);
    expect(events.every((event) => isUlid(event.id))).toBe(true);
  });

  it('chains hashes across the batch, seeded from the empty string', async () => {
    const events = await build().append(fakeClient(), {
      streamId: 'order:1',
      streamType: 'order',
      expectedSeq: 0,
      events: [placed, paid],
    });

    const [first, second] = events;
    expect(first?.hash).toBe(
      hashEvent('', {
        id: first?.id ?? '',
        streamId: 'order:1',
        seq: 1,
        type: 'OrderPlaced',
        payload: { total: 10 },
        actor,
        occurredAt: first?.occurredAt ?? '',
      }),
    );
    expect(second?.hash).toBe(
      hashEvent(first?.hash ?? '', {
        id: second?.id ?? '',
        streamId: 'order:1',
        seq: 2,
        type: 'OrderPaid',
        payload: {},
        actor,
        occurredAt: second?.occurredAt ?? '',
      }),
    );
  });

  it('continues the chain from the stored head on a later append', async () => {
    const service = build();
    const [first] = await service.append(fakeClient(), {
      streamId: 'order:1',
      streamType: 'order',
      expectedSeq: 0,
      events: [placed],
    });
    const [second] = await service.append(fakeClient(), {
      streamId: 'order:1',
      streamType: 'order',
      expectedSeq: 1,
      events: [paid],
    });

    expect(second?.seq).toBe(2);
    expect(second?.hash).toBe(
      hashEvent(first?.hash ?? '', {
        id: second?.id ?? '',
        streamId: 'order:1',
        seq: 2,
        type: 'OrderPaid',
        payload: {},
        actor,
        occurredAt: second?.occurredAt ?? '',
      }),
    );
  });

  it('updates the cached head with the folded state', async () => {
    await build().append(fakeClient(), {
      streamId: 'order:1',
      streamType: 'order',
      expectedSeq: 0,
      events: [placed, paid],
    });

    expect(state.heads.get('order:1')).toMatchObject({
      streamType: 'order',
      lastSeq: 2,
      state: 'paid',
    });
  });

  it('leaves state null for stream types with no definition', async () => {
    await build().append(fakeClient(), {
      streamId: 'audit:1',
      streamType: 'audit',
      expectedSeq: 0,
      events: [{ type: 'Anything', payload: {}, actor }],
    });

    expect(state.heads.get('audit:1')?.state).toBeNull();
  });

  it('rejects a stale expectedSeq before writing anything', async () => {
    const service = build();
    await service.append(fakeClient(), {
      streamId: 'order:1',
      streamType: 'order',
      expectedSeq: 0,
      events: [placed],
    });

    await expect(
      service.append(fakeClient(), {
        streamId: 'order:1',
        streamType: 'order',
        expectedSeq: 0,
        events: [paid],
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    expect(state.events).toHaveLength(1);
  });

  it('translates a unique violation into a version conflict', async () => {
    state.failInsertWith = Object.assign(new Error('duplicate key'), { code: '23505' });

    await expect(
      build().append(fakeClient(), {
        streamId: 'order:1',
        streamType: 'order',
        expectedSeq: 0,
        events: [placed],
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('propagates non-conflict database errors unchanged', async () => {
    state.failInsertWith = Object.assign(new Error('disk on fire'), { code: '53100' });

    await expect(
      build().append(fakeClient(), {
        streamId: 'order:1',
        streamType: 'order',
        expectedSeq: 0,
        events: [placed],
      }),
    ).rejects.toThrow('disk on fire');
  });

  it('validates the batch in order and writes nothing when a step is illegal', async () => {
    await expect(
      build().append(fakeClient(), {
        streamId: 'order:1',
        streamType: 'order',
        expectedSeq: 0,
        events: [placed, paid, paid],
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    expect(state.events).toHaveLength(0);
    expect(state.heads.size).toBe(0);
  });

  it('rejects undeclared event types', async () => {
    await expect(
      build().append(fakeClient(), {
        streamId: 'order:1',
        streamType: 'order',
        expectedSeq: 0,
        events: [{ type: 'OrderTeleported', payload: {}, actor }],
      }),
    ).rejects.toBeInstanceOf(UnknownEventTypeError);
  });

  it.each([
    ['an empty batch', [] as const, 0],
    ['a negative expectedSeq', [placed] as const, -1],
    ['a fractional expectedSeq', [placed] as const, 1.5],
  ])('rejects %s', async (_label, events, expectedSeq) => {
    await expect(
      build().append(fakeClient(), {
        streamId: 'order:1',
        streamType: 'order',
        expectedSeq,
        events: [...events],
      }),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  it('refuses to mix stream types on one stream', async () => {
    const service = build();
    await service.append(fakeClient(), {
      streamId: 'order:1',
      streamType: 'order',
      expectedSeq: 0,
      events: [placed],
    });

    await expect(
      service.append(fakeClient(), {
        streamId: 'order:1',
        streamType: 'invoice',
        expectedSeq: 1,
        events: [{ type: 'Whatever', payload: {}, actor }],
      }),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  it('normalises occurredAt to millisecond ISO and rejects nonsense', async () => {
    const [event] = await build().append(fakeClient(), {
      streamId: 'order:1',
      streamType: 'order',
      expectedSeq: 0,
      events: [{ ...placed, occurredAt: '2026-03-01T12:00:00Z' }],
    });
    expect(event?.occurredAt).toBe('2026-03-01T12:00:00.000Z');

    await expect(
      build().append(fakeClient(), {
        streamId: 'order:2',
        streamType: 'order',
        expectedSeq: 0,
        events: [{ ...placed, occurredAt: 'not a date' }],
      }),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  it('runs projections after the write and notifies once per append', async () => {
    const applied: string[] = [];
    const projection: Projection = {
      name: 'spy',
      handles: ['*'],
      apply: (_tx, event) => {
        applied.push(`${event.type}#${event.seq}`);
      },
    };

    await build([projection]).append(fakeClient(), {
      streamId: 'order:1',
      streamType: 'order',
      expectedSeq: 0,
      events: [placed, paid],
    });

    expect(applied).toEqual(['OrderPlaced#1', 'OrderPaid#2']);
    expect(state.notifications).toHaveLength(1);
    expect(JSON.parse(state.notifications[0] ?? '{}')).toMatchObject({
      streamId: 'order:1',
      streamType: 'order',
      lastPosition: 2,
    });
  });

  it('surfaces a projection failure as ProjectionFailedError with the cause', async () => {
    const boom = new Error('read model is on fire');
    const projection: Projection = {
      name: 'explodes',
      handles: ['OrderPlaced'],
      apply: () => {
        throw boom;
      },
    };

    const attempt = build([projection]).append(fakeClient(), {
      streamId: 'order:1',
      streamType: 'order',
      expectedSeq: 0,
      events: [placed],
    });

    await expect(attempt).rejects.toBeInstanceOf(ProjectionFailedError);
    await expect(attempt).rejects.toMatchObject({ projectionName: 'explodes', cause: boom });
  });

  it('does not notify when a projection throws', async () => {
    const projection: Projection = {
      name: 'explodes',
      handles: ['*'],
      apply: () => {
        throw new Error('nope');
      },
    };

    await expect(
      build([projection]).append(fakeClient(), {
        streamId: 'order:1',
        streamType: 'order',
        expectedSeq: 0,
        events: [placed],
      }),
    ).rejects.toBeInstanceOf(ProjectionFailedError);

    expect(state.notifications).toHaveLength(0);
  });

  it('only invokes projections that declare the event type', async () => {
    const shipped = vi.fn();
    const projection: Projection = {
      name: 'shipping',
      handles: ['OrderShipped'],
      apply: shipped,
    };

    await build([projection]).append(fakeClient(), {
      streamId: 'order:1',
      streamType: 'order',
      expectedSeq: 0,
      events: [placed, paid],
    });

    expect(shipped).not.toHaveBeenCalled();
  });
});
