export const EVENT_COLUMN_MAP = {
  globalPosition: 'global_position',
  id: 'id',
  streamId: 'stream_id',
  streamType: 'stream_type',
  seq: 'seq',
  type: 'type',
  payload: 'payload',
  actor: 'actor',
  source: 'source',
  payloadVersion: 'payload_version',
  occurredAt: 'occurred_at',
  recordedAt: 'recorded_at',
  hash: 'hash',
} as const;

export const STREAM_COLUMN_MAP = {
  streamId: 'stream_id',
  streamType: 'stream_type',
  lastSeq: 'last_seq',
  state: 'state',
  lastHash: 'last_hash',
} as const;

export const SUBSCRIPTION_COLUMN_MAP = {
  name: 'name',
  position: 'position',
} as const;

export type ColumnMap = Readonly<Record<string, string>>;

export type SnakeRow<M extends ColumnMap, T extends Record<keyof M, unknown>> = {
  [K in keyof M as M[K] & string]: T[K & keyof T];
};

export const selectList = (map: ColumnMap): string => Object.values(map).join(', ');

export const insertList = (map: ColumnMap, omit: readonly string[] = []): string[] =>
  Object.entries(map)
    .filter(([key]) => !omit.includes(key))
    .map(([, column]) => column);
