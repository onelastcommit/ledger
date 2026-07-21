import type { StoredEvent } from '../types';
import type {
  EventRow,
  InsertableEvent,
  InsertedEventRow,
  Queryable,
  ReadAllQuery,
} from './repository.types';

const COLUMNS = `global_position, id, stream_id, stream_type, seq, type, payload,
       actor, source, payload_version, occurred_at, recorded_at, hash`;

const COLUMNS_PER_ROW = 11;

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

export class EventRepository {
  async insert(db: Queryable, events: readonly InsertableEvent[]): Promise<InsertedEventRow[]> {
    const values: unknown[] = [];
    const tuples = events.map((event, index) => {
      const base = index * COLUMNS_PER_ROW;
      values.push(
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
      );
      const placeholders = Array.from(
        { length: COLUMNS_PER_ROW },
        (_, offset) => `$${base + offset + 1}`,
      );
      return `(${placeholders.join(', ')})`;
    });

    const result = await db.query<{
      global_position: string;
      seq: number;
      recorded_at: Date;
    }>(
      `INSERT INTO ledger_events
         (id, stream_id, stream_type, seq, type, payload, actor, source, payload_version, occurred_at, hash)
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

  async findByStream(db: Queryable, streamId: string): Promise<StoredEvent[]> {
    const result = await db.query<EventRow>(
      `SELECT ${COLUMNS} FROM ledger_events WHERE stream_id = $1 ORDER BY seq ASC`,
      [streamId],
    );
    return result.rows.map(toStoredEvent);
  }

  async findAll(db: Queryable, query: ReadAllQuery): Promise<StoredEvent[]> {
    const result = await db.query<EventRow>(
      `SELECT ${COLUMNS}
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
