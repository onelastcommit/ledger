import type { ClientBase } from 'pg';
import type { EventRepository } from '../../src/repositories/event.repository';
import type {
  InsertableEvent,
  InsertedEventRow,
  StreamHead,
} from '../../src/repositories/repository.types';
import type { StreamRepository } from '../../src/repositories/stream.repository';

export interface FakeState {
  events: InsertableEvent[];
  heads: Map<string, StreamHead>;
  notifications: string[];
  nextGlobalPosition: number;
  failInsertWith?: Error;
}

export const createFakeState = (): FakeState => ({
  events: [],
  heads: new Map(),
  notifications: [],
  nextGlobalPosition: 1,
});

export const fakeEventRepository = (state: FakeState): EventRepository =>
  ({
    insert(_db: unknown, events: readonly InsertableEvent[]): Promise<InsertedEventRow[]> {
      if (state.failInsertWith) return Promise.reject(state.failInsertWith);
      const recordedAt = new Date(0).toISOString();
      return Promise.resolve(
        events.map((event) => {
          state.events.push(event);
          const globalPosition = state.nextGlobalPosition;
          state.nextGlobalPosition += 1;
          return { seq: event.seq, globalPosition, recordedAt };
        }),
      );
    },
    notify(_db: unknown, _channel: string, payload: string): Promise<void> {
      state.notifications.push(payload);
      return Promise.resolve();
    },
  }) as unknown as EventRepository;

export const fakeStreamRepository = (state: FakeState): StreamRepository =>
  ({
    findHead(_db: unknown, streamId: string): Promise<StreamHead | undefined> {
      return Promise.resolve(state.heads.get(streamId));
    },
    upsertHead(
      _db: unknown,
      head: {
        streamId: string;
        streamType: string;
        lastSeq: number;
        state: string | null;
        lastHash: string;
        expectedSeq: number;
      },
    ): Promise<boolean> {
      const existing = state.heads.get(head.streamId);
      if (existing !== undefined && existing.lastSeq !== head.expectedSeq) {
        return Promise.resolve(false);
      }
      state.heads.set(head.streamId, {
        streamType: head.streamType,
        lastSeq: head.lastSeq,
        state: head.state,
        lastHash: head.lastHash,
      });
      return Promise.resolve(true);
    },
  }) as unknown as StreamRepository;

export const fakeClient = (): ClientBase => ({}) as ClientBase;
