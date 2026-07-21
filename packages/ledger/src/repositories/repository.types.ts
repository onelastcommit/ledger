import type { QueryResult, QueryResultRow } from 'pg';
import type { Actor, SourceRef } from '../types';

export interface Queryable {
  query<R extends QueryResultRow>(queryText: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export interface EventRow {
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

export interface StreamHead {
  streamType: string;
  lastSeq: number;
  state: string | null;
  lastHash: string;
}

export interface InsertableEvent {
  id: string;
  streamId: string;
  streamType: string;
  seq: number;
  type: string;
  payload: unknown;
  actor: Actor;
  source: SourceRef | undefined;
  payloadVersion: number | undefined;
  occurredAt: string;
  hash: string;
}

export interface InsertedEventRow {
  seq: number;
  globalPosition: number;
  recordedAt: string;
}

export interface ReadAllQuery {
  afterGlobalPosition: number;
  streamTypes: string[] | null;
  limit: number;
}
