import { StreamNotFoundError } from '../errors';
import type { EventRepository } from '../repositories/event.repository';
import type { Queryable } from '../repositories/repository.types';
import type { StreamRepository } from '../repositories/stream.repository';
import type { ReadAllOptions, StoredEvent, StreamState } from '../types';

const DEFAULT_READ_LIMIT = 1000;

export interface StreamReaderServiceDeps {
  events: EventRepository;
  streams: StreamRepository;
}

export class StreamReaderService {
  private readonly events: EventRepository;
  private readonly streams: StreamRepository;

  constructor(deps: StreamReaderServiceDeps) {
    this.events = deps.events;
    this.streams = deps.streams;
  }

  async readStream(db: Queryable, streamId: string): Promise<StoredEvent[]> {
    return this.events.findByStream(db, streamId);
  }

  async readAll(db: Queryable, options: ReadAllOptions = {}): Promise<StoredEvent[]> {
    return this.events.findAll(db, {
      afterGlobalPosition: options.afterGlobalPosition ?? 0,
      streamTypes: options.streamTypes ?? null,
      limit: options.limit ?? DEFAULT_READ_LIMIT,
    });
  }

  async getState(db: Queryable, streamId: string): Promise<StreamState> {
    const state = await this.streams.findState(db, streamId);
    if (state === undefined) throw new StreamNotFoundError(streamId);
    return state;
  }
}
