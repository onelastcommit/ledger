import type { Pool } from 'pg';
import { applyEvent } from '../domain/fsm';
import type { EntityDefinition } from '../domain/fsm.types';
import { StreamNotFoundError } from '../errors';
import type { EventRepository } from '../repositories/event.repository';
import type { StreamRepository } from '../repositories/stream.repository';
import type { RebuildReport, RebuiltStream } from './maintenance.types';
import type { StreamReaderService } from './stream-reader.service';

const STREAM_PAGE_SIZE = 500;

export interface MaintenanceServiceDeps {
  pool: Pool;
  events: EventRepository;
  streams: StreamRepository;
  reader: StreamReaderService;
  entities: ReadonlyMap<string, EntityDefinition>;
}

export class MaintenanceService {
  private readonly pool: Pool;
  private readonly events: EventRepository;
  private readonly streams: StreamRepository;
  private readonly reader: StreamReaderService;
  private readonly entities: ReadonlyMap<string, EntityDefinition>;

  constructor(deps: MaintenanceServiceDeps) {
    this.pool = deps.pool;
    this.events = deps.events;
    this.streams = deps.streams;
    this.reader = deps.reader;
    this.entities = deps.entities;
  }

  async rebuildStream(streamId: string): Promise<RebuiltStream> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      let streamType: string | undefined;
      let state: string | null = null;
      let lastSeq = 0;
      let lastHash = '';

      for await (const batch of this.reader.iterateStream(client, streamId, STREAM_PAGE_SIZE)) {
        for (const event of batch) {
          streamType ??= event.streamType;
          const definition = this.entities.get(event.streamType);
          if (definition !== undefined) {
            state = applyEvent(definition, state, event.type, streamId);
          }
          lastSeq = event.seq;
          lastHash = event.hash;
        }
      }

      if (streamType === undefined) {
        await client.query('ROLLBACK');
        throw new StreamNotFoundError(streamId);
      }

      const before = await this.streams.findHead(client, streamId);
      await this.streams.replaceHead(client, {
        streamId,
        streamType,
        lastSeq,
        state,
        lastHash,
      });
      await client.query('COMMIT');

      return {
        streamId,
        streamType,
        lastSeq,
        state,
        changed:
          before === undefined ||
          before.lastSeq !== lastSeq ||
          before.state !== state ||
          before.lastHash !== lastHash,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async rebuildAllStreams(): Promise<RebuildReport> {
    const rebuilt: RebuiltStream[] = [];
    let after: string | null = null;

    for (;;) {
      const ids: string[] = await this.events.findStreamIds(this.pool, after, STREAM_PAGE_SIZE);
      if (ids.length === 0) break;
      for (const streamId of ids) {
        rebuilt.push(await this.rebuildStream(streamId));
      }
      after = ids.at(-1) ?? null;
      if (ids.length < STREAM_PAGE_SIZE) break;
    }

    return {
      streams: rebuilt.length,
      changed: rebuilt.filter((stream) => stream.changed).length,
      details: rebuilt,
    };
  }
}
