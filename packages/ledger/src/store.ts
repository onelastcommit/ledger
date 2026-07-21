import { readFile } from 'node:fs/promises';
import type { ClientBase, Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { LedgerError, StreamNotFoundError, VersionConflictError } from './errors.js';
import { applyEvent, buildEntityRegistry, type EntityDefinition } from './fsm.js';
import { hashEvent, verifyChain } from './hash.js';
import { runProjections, type Projection } from './projections.js';
import {
  startSubscription,
  type Subscription,
  type SubscriptionOptions,
} from './subscriptions.js';
import { ulid as nextId } from './ulid.js';
import type {
  Actor,
  AppendParams,
  ReadAllOptions,
  SourceRef,
  StoredEvent,
  StreamState,
  VerificationResult,
} from './types.js';

export const DEFAULT_NOTIFY_CHANNEL = 'ledger_events';

const DEFAULT_READ_LIMIT = 1000;
const UNIQUE_VIOLATION = '23505';
const MIGRATIONS = ['001_init.sql'] as const;
const MIGRATION_LOCK_KEY = 8_675_309_123;
const EVENT_COLUMNS = `global_position, id, stream_id, stream_type, seq, type, payload,
       actor, source, payload_version, occurred_at, recorded_at, hash`;

export interface LedgerConfig {
  pool: Pool;
  entities?: readonly EntityDefinition[];
  projections?: readonly Projection[];
  notifyChannel?: string;
}

export interface LedgerTransaction {
  readonly client: PoolClient;
  append(params: AppendParams): Promise<StoredEvent[]>;
  readStream(streamId: string): Promise<StoredEvent[]>;
  getState(streamId: string): Promise<StreamState>;
}

export interface Ledger {
  migrate(): Promise<void>;
  withTransaction<T>(fn: (tx: LedgerTransaction) => Promise<T>): Promise<T>;
  append(client: ClientBase, params: AppendParams): Promise<StoredEvent[]>;
  readStream(streamId: string, options?: { client?: ClientBase }): Promise<StoredEvent[]>;
  readAll(options?: ReadAllOptions): Promise<StoredEvent[]>;
  getState(streamId: string, options?: { client?: ClientBase }): Promise<StreamState>;
  verifyStream(streamId: string): Promise<VerificationResult>;
  subscribe(options: SubscriptionOptions): Subscription;
  readonly entities: ReadonlyMap<string, EntityDefinition>;
}

interface Queryable {
  query<R extends QueryResultRow>(queryText: string, values?: unknown[]): Promise<QueryResult<R>>;
}

interface EventRow {
  global_position: string;
  id: string;
  stream_id: string;
  stream_type: string;
  seq: number;
  type: string;
  payload: unknown;
  actor: Actor;
  source: SourceRef | null;
  payload_version: number | null;
  occurred_at: Date;
  recorded_at: Date;
  hash: string;
}

interface StreamRow {
  stream_type: string;
  last_seq: number;
  state: string | null;
  last_hash: string;
}

function mapEventRow(row: EventRow): StoredEvent {
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
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

function normaliseTimestamp(value: string | undefined, fallback: Date): string {
  if (value === undefined) return fallback.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new LedgerError(`occurredAt is not a valid ISO 8601 timestamp: "${value}"`);
  }
  return parsed.toISOString();
}

export function createLedger(config: LedgerConfig): Ledger {
  const { pool } = config;
  const entities = buildEntityRegistry(config.entities ?? []);
  const projections = config.projections ?? [];
  const notifyChannel = config.notifyChannel ?? DEFAULT_NOTIFY_CHANNEL;

  async function migrate(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ledger_migrations (
          name       TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const applied = await client.query<{ name: string }>('SELECT name FROM ledger_migrations');
      const done = new Set(applied.rows.map((row) => row.name));

      for (const name of MIGRATIONS) {
        if (done.has(name)) continue;
        const sql = await readFile(new URL(`./migrations/${name}`, import.meta.url), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO ledger_migrations (name) VALUES ($1)', [name]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function readStreamOn(client: Queryable, streamId: string): Promise<StoredEvent[]> {
    const result = await client.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM ledger_events WHERE stream_id = $1 ORDER BY seq ASC`,
      [streamId],
    );
    return result.rows.map(mapEventRow);
  }

  async function getStateOn(client: Queryable, streamId: string): Promise<StreamState> {
    const result = await client.query<{ state: string | null; last_seq: number }>(
      'SELECT state, last_seq FROM ledger_streams WHERE stream_id = $1',
      [streamId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new StreamNotFoundError(streamId);
    return { state: row.state, seq: row.last_seq };
  }

  async function append(client: ClientBase, params: AppendParams): Promise<StoredEvent[]> {
    const { streamId, streamType, expectedSeq, events } = params;

    if (events.length === 0) {
      throw new LedgerError('append requires at least one event.');
    }
    if (!Number.isInteger(expectedSeq) || expectedSeq < 0) {
      throw new LedgerError(`expectedSeq must be a non-negative integer, got ${expectedSeq}.`);
    }

    const headResult = await client.query<StreamRow>(
      'SELECT stream_type, last_seq, state, last_hash FROM ledger_streams WHERE stream_id = $1',
      [streamId],
    );
    const head = headResult.rows[0];

    if (head !== undefined && head.stream_type !== streamType) {
      throw new LedgerError(
        `Stream "${streamId}" already exists with stream type "${head.stream_type}"; refusing to append "${streamType}" events to it.`,
      );
    }

    const lastSeq = head?.last_seq ?? 0;
    if (lastSeq !== expectedSeq) {
      throw new VersionConflictError(streamId, expectedSeq, lastSeq);
    }

    const definition = entities.get(streamType);
    const now = new Date();

    let state: string | null = head?.state ?? null;
    let previousHash = head?.last_hash ?? '';
    let seq = lastSeq;

    const prepared: StoredEvent[] = [];
    for (const input of events) {
      seq += 1;
      if (definition !== undefined) {
        state = applyEvent(definition, state, input.type, streamId);
      }

      const id = nextId();
      const occurredAt = normaliseTimestamp(input.occurredAt, now);
      const hash = hashEvent(previousHash, {
        id,
        streamId,
        seq,
        type: input.type,
        payload: input.payload,
        actor: input.actor,
        source: input.source,
        occurredAt,
      });
      previousHash = hash;

      const event: StoredEvent = {
        id,
        streamId,
        streamType,
        seq,
        globalPosition: 0,
        type: input.type,
        payload: input.payload,
        actor: input.actor,
        occurredAt,
        recordedAt: now.toISOString(),
        hash,
      };
      if (input.source !== undefined) event.source = input.source;
      if (input.payloadVersion !== undefined) event.payloadVersion = input.payloadVersion;
      prepared.push(event);
    }

    const columnsPerRow = 11;
    const values: unknown[] = [];
    const tuples = prepared.map((event, index) => {
      const base = index * columnsPerRow;
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
      const placeholders = Array.from({ length: columnsPerRow }, (_, i) => `$${base + i + 1}`);
      return `(${placeholders.join(', ')})`;
    });

    let inserted;
    try {
      inserted = await client.query<{ global_position: string; seq: number; recorded_at: Date }>(
        `INSERT INTO ledger_events
           (id, stream_id, stream_type, seq, type, payload, actor, source, payload_version, occurred_at, hash)
         VALUES ${tuples.join(', ')}
         RETURNING global_position, seq, recorded_at`,
        values,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new VersionConflictError(streamId, expectedSeq, null);
      }
      throw error;
    }

    const assigned = new Map(inserted.rows.map((row) => [row.seq, row] as const));
    for (const event of prepared) {
      const row = assigned.get(event.seq);
      if (row === undefined) continue;
      event.globalPosition = Number(row.global_position);
      event.recordedAt = row.recorded_at.toISOString();
    }

    const upserted = await client.query(
      `INSERT INTO ledger_streams (stream_id, stream_type, last_seq, state, last_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stream_id) DO UPDATE
         SET last_seq   = EXCLUDED.last_seq,
             state      = EXCLUDED.state,
             last_hash  = EXCLUDED.last_hash,
             updated_at = now()
         WHERE ledger_streams.last_seq = $6`,
      [streamId, streamType, seq, state, previousHash, expectedSeq],
    );
    if (upserted.rowCount === 0) {
      throw new VersionConflictError(streamId, expectedSeq, null);
    }

    await runProjections(projections, { client }, prepared);

    await client.query('SELECT pg_notify($1, $2)', [
      notifyChannel,
      JSON.stringify({ streamId, streamType, lastPosition: prepared.at(-1)?.globalPosition ?? 0 }),
    ]);

    return prepared;
  }

  async function withTransaction<T>(fn: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        client,
        append: (params) => append(client, params),
        readStream: (streamId) => readStreamOn(client, streamId),
        getState: (streamId) => getStateOn(client, streamId),
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function readAll(options: ReadAllOptions = {}): Promise<StoredEvent[]> {
    const result = await pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM ledger_events
        WHERE global_position > $1
          AND ($2::text[] IS NULL OR stream_type = ANY($2::text[]))
        ORDER BY global_position ASC
        LIMIT $3`,
      [
        options.afterGlobalPosition ?? 0,
        options.streamTypes ?? null,
        options.limit ?? DEFAULT_READ_LIMIT,
      ],
    );
    return result.rows.map(mapEventRow);
  }

  async function verifyStream(streamId: string): Promise<VerificationResult> {
    const events = await readStreamOn(pool, streamId);
    if (events.length === 0) throw new StreamNotFoundError(streamId);
    return verifyChain(events);
  }

  return {
    entities,
    migrate,
    withTransaction,
    append,
    readStream: (streamId, options) => readStreamOn(options?.client ?? pool, streamId),
    readAll,
    getState: (streamId, options) => getStateOn(options?.client ?? pool, streamId),
    verifyStream,
    subscribe: (options) => startSubscription({ pool, notifyChannel, readAll }, options),
  };
}
