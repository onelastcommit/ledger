export type Actor =
  | { kind: 'user'; id: string; role?: string }
  | { kind: 'service'; id: string }
  | { kind: 'ai'; model: string; version?: string }
  | { kind: 'system' };

export interface SourceRef {
  [key: string]: string | number;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface EventInput<P = unknown> {
  type: string;
  payload: P;
  actor: Actor;
  source?: SourceRef;
  occurredAt?: string;
  payloadVersion?: number;
}

export interface StoredEvent<P = unknown> {
  id: string;
  streamId: string;
  streamType: string;
  seq: number;
  globalPosition: number;
  type: string;
  payload: P;
  actor: Actor;
  source?: SourceRef;
  payloadVersion?: number;
  occurredAt: string;
  recordedAt: string;
  hash: string;
}

export interface AppendParams {
  streamId: string;
  streamType: string;
  expectedSeq: number;
  events: EventInput[];
}

export interface ReadStreamOptions {
  afterSeq?: number;
  limit?: number;
}

export interface IterateAllOptions {
  afterGlobalPosition?: number;
  streamTypes?: string[];
  batchSize?: number;
}

export interface IterateStreamOptions {
  batchSize?: number;
}

export interface ReadAllOptions {
  afterGlobalPosition?: number;
  streamTypes?: string[];
  limit?: number;
}

export interface StreamState {
  state: string | null;
  seq: number;
}

export interface VerificationResult {
  valid: boolean;
  firstBadSeq?: number;
}
