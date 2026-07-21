import type { QueryResult, QueryResultRow } from 'pg';
import type { Actor, SourceRef } from '../types';
import type { EVENT_COLUMN_MAP, SnakeRow, STREAM_COLUMN_MAP } from './columns';

export interface Queryable {
  query<R extends QueryResultRow>(queryText: string, values?: unknown[]): Promise<QueryResult<R>>;
}

interface EventFields {
  globalPosition: string;
  id: string;
  streamId: string;
  streamType: string;
  seq: number;
  type: string;
  payload: unknown;
  actor: Actor;
  source: SourceRef | null;
  payloadVersion: number | null;
  occurredAt: Date;
  recordedAt: Date;
  hash: string;
}

interface StreamFields {
  streamId: string;
  streamType: string;
  lastSeq: number;
  state: string | null;
  lastHash: string;
}

export type EventRow = SnakeRow<typeof EVENT_COLUMN_MAP, EventFields>;
export type StreamRow = SnakeRow<typeof STREAM_COLUMN_MAP, StreamFields>;

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

export interface DeadLetterRecord {
  subscriptionName: string;
  globalPosition: number;
  eventId: string;
  eventType: string;
  attempts: number;
  error: string;
}
