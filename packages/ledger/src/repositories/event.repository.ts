import type { StoredEvent } from '../types';
import { EVENT_COLUMN_MAP, insertList, selectList } from './columns';
import type {
  EventRow,
  InsertableEvent,
  InsertedEventRow,
  Queryable,
  ReadAllQuery,
  StreamPage,
} from './repository.types';

const SELECT_COLUMNS = selectList(EVENT_COLUMN_MAP);

const INSERT_COLUMNS = insertList(EVENT_COLUMN_MAP, ['globalPosition', 'recordedAt']);
const PARAMS_PER_ROW = INSERT_COLUMNS.length;

const POSTGRES_MAX_BIND_PARAMS = 65_535;
export const MAX_EVENTS_PER_STATEMENT = Math.floor(POSTGRES_MAX_BIND_PARAMS / PARAMS_PER_ROW);

const toStoredEvent = (row: EventRow): StoredEvent => {
  const event: StoredEvent = {
    id: row.id,
    streamId: row.stream_id,
    streamType: row.stream_type,
    seq: row.seq,
    globalPosition: Number(row.global_position),
    type: row.type,
    payload: row.payload,
    actor: row.actor,
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    hash: row.hash,
  };
  if (row.source !== null) event.source = row.source;
  if (row.payload_version !== null) event.payloadVersion = row.payload_version;
  return event;
};

const bindValues = (event: InsertableEvent): unknown[] => [
  event.id,
  event.streamId,
  event.streamType,
  event.seq,
  event.type,
  JSON.stringify(event.payload),
  JSON.stringify(event.actor),
  event.source === undefined ? null : JSON.stringify(event.source),
  event.payloadVersion ?? null,
  event.occurredAt,
  event.hash,
];

export class EventRepository {
  private async insertChunk(
    db: Queryable,
    events: readonly InsertableEvent[],
  ): Promise<InsertedEventRow[]> {
    const values: unknown[] = [];
    const tuples = events.map((event, index) => {
      const base = index * PARAMS_PER_ROW;
      values.push(...bindValues(event));
      const placeholders = Array.from(
        { length: PARAMS_PER_ROW },
        (_, offset) => `$${base + offset + 1}`,
      );
      return `(${placeholders.join(', ')})`;
    });

    const result = await db.query<{
      global_position: string;
      seq: number;
      recorded_at: Date;
    }>(
      `INSERT INTO ledger_events (${INSERT_COLUMNS.join(', ')})
       VALUES ${tuples.join(', ')}
       RETURNING global_position, seq, recorded_at`,
      values,
    );

    return result.rows.map((row) => ({
      seq: row.seq,
      globalPosition: Number(row.global_position),
      recordedAt: row.recorded_at.toISOString(),
    }));
  }

  async insert(db: Queryable, events: readonly InsertableEvent[]): Promise<InsertedEventRow[]> {
    if (events.length <= MAX_EVENTS_PER_STATEMENT) {
      return this.insertChunk(db, events);
    }

    const inserted: InsertedEventRow[] = [];
    for (let offset = 0; offset < events.length; offset += MAX_EVENTS_PER_STATEMENT) {
      const chunk = events.slice(offset, offset + MAX_EVENTS_PER_STATEMENT);
      inserted.push(...(await this.insertChunk(db, chunk)));
    }
    return inserted;
  }

  async findByStream(
    db: Queryable,
    streamId: string,
    page: StreamPage = {},
  ): Promise<StoredEvent[]> {
    const conditions = ['stream_id = $1', 'seq > $2'];
    const values: unknown[] = [streamId, page.afterSeq ?? 0];
    if (page.limit !== undefined) {
      values.push(page.limit);
      return this.selectStream(db, conditions, values, `LIMIT $${values.length}`);
    }
    return this.selectStream(db, conditions, values, '');
  }

  private async selectStream(
    db: Queryable,
    conditions: string[],
    values: unknown[],
    tail: string,
  ): Promise<StoredEvent[]> {
    const result = await db.query<EventRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM ledger_events
        WHERE ${conditions.join(' AND ')}
        ORDER BY seq ASC
        ${tail}`,
      values,
    );
    return result.rows.map(toStoredEvent);
  }

  async maxGlobalPosition(db: Queryable, streamTypes: string[] | null = null): Promise<number> {
    const result = await db.query<{ head: string | null }>(
      `SELECT max(global_position)::text AS head
         FROM ledger_events
        WHERE ($1::text[] IS NULL OR stream_type = ANY($1::text[]))`,
      [streamTypes],
    );
    return Number(result.rows[0]?.head ?? 0);
  }

  async countPending(
    db: Queryable,
    afterGlobalPosition: number,
    streamTypes: string[] | null = null,
  ): Promise<number> {
    const result = await db.query<{ pending: string }>(
      `SELECT count(*)::text AS pending
         FROM ledger_events
        WHERE global_position > $1
          AND ($2::text[] IS NULL OR stream_type = ANY($2::text[]))`,
      [afterGlobalPosition, streamTypes],
    );
    return Number(result.rows[0]?.pending ?? 0);
  }

  async findStreamIds(
    db: Queryable,
    afterStreamId: string | null,
    limit: number,
  ): Promise<string[]> {
    const result = await db.query<{ stream_id: string }>(
      `SELECT DISTINCT stream_id
         FROM ledger_events
        WHERE ($1::text IS NULL OR stream_id > $1::text)
        ORDER BY stream_id ASC
        LIMIT $2`,
      [afterStreamId, limit],
    );
    return result.rows.map((row) => row.stream_id);
  }

  async findAll(db: Queryable, query: ReadAllQuery): Promise<StoredEvent[]> {
    const result = await db.query<EventRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM ledger_events
        WHERE global_position > $1
          AND ($2::text[] IS NULL OR stream_type = ANY($2::text[]))
        ORDER BY global_position ASC
        LIMIT $3`,
      [query.afterGlobalPosition, query.streamTypes, query.limit],
    );
    return result.rows.map(toStoredEvent);
  }

  async notify(db: Queryable, channel: string, payload: string): Promise<void> {
    await db.query('SELECT pg_notify($1, $2)', [channel, payload]);
  }
}
