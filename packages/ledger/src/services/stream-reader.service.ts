import { StreamNotFoundError } from '../errors';
import type { EventRepository } from '../repositories/event.repository';
import type { Queryable } from '../repositories/repository.types';
import type { StreamRepository } from '../repositories/stream.repository';
import type { ReadAllOptions, ReadStreamOptions, StoredEvent, StreamState } from '../types';

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

  async readStream(
    db: Queryable,
    streamId: string,
    options: ReadStreamOptions = {},
  ): Promise<StoredEvent[]> {
    const page: { afterSeq?: number; limit?: number } = {};
    if (options.afterSeq !== undefined) page.afterSeq = options.afterSeq;
    if (options.limit !== undefined) page.limit = options.limit;
    return this.events.findByStream(db, streamId, page);
  }

  async *iterateStream(
    db: Queryable,
    streamId: string,
    batchSize = DEFAULT_READ_LIMIT,
  ): AsyncGenerator<StoredEvent[]> {
    let afterSeq = 0;
    for (;;) {
      const batch = await this.events.findByStream(db, streamId, { afterSeq, limit: batchSize });
      if (batch.length === 0) return;
      yield batch;
      const last = batch.at(-1);
      if (last === undefined || batch.length < batchSize) return;
      afterSeq = last.seq;
    }
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
