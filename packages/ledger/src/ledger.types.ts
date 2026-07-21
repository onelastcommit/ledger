import type { ClientBase, Pool, PoolClient } from 'pg';
import type { EntityDefinition } from './domain/fsm.types';
import type { RebuildReport, RebuiltStream } from './services/maintenance.types';
import type { Projection } from './services/projection.types';
import type { Subscription, SubscriptionOptions } from './services/subscription.types';
import type {
  AppendParams,
  ReadAllOptions,
  ReadStreamOptions,
  StoredEvent,
  StreamState,
  VerificationResult,
} from './types';

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

export interface ReadOptions {
  client?: ClientBase;
}

export interface Ledger {
  migrate(): Promise<void>;
  withTransaction<T>(fn: (tx: LedgerTransaction) => Promise<T>): Promise<T>;
  append(client: ClientBase, params: AppendParams): Promise<StoredEvent[]>;
  readStream(streamId: string, options?: ReadStreamOptions & ReadOptions): Promise<StoredEvent[]>;
  readAll(options?: ReadAllOptions): Promise<StoredEvent[]>;
  getState(streamId: string, options?: ReadOptions): Promise<StreamState>;
  verifyStream(streamId: string): Promise<VerificationResult>;
  subscribe(options: SubscriptionOptions): Subscription;
  rebuildStream(streamId: string): Promise<RebuiltStream>;
  rebuildAllStreams(): Promise<RebuildReport>;
  close(): Promise<void>;
  readonly entities: ReadonlyMap<string, EntityDefinition>;
}
